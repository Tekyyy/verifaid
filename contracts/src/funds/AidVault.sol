// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IAidVault} from "../interfaces/IAidVault.sol";
import {IAidVaultFactory} from "../interfaces/IAidVaultFactory.sol";
import {IDonationForwarderFactory} from "../interfaces/IDonationForwarderFactory.sol";
import {IDonationReceipt} from "../interfaces/IDonationReceipt.sol";
import {IFeeRecorder} from "../interfaces/IFeeRecorder.sol";
import {INeedsRegistry} from "../interfaces/INeedsRegistry.sol";
import {IRoleRegistry} from "../interfaces/IRoleRegistry.sol";
import {Errors} from "../libraries/Errors.sol";
import {TrancheLedger} from "./TrancheLedger.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title AidVault
/// @notice Escrow for a single need. Holds stablecoin until tranches are unlocked by
///         verified deliveries, then pays each tranche straight to the suppliers of the need's payment plan.
/// @dev There is intentionally no admin withdrawal path: funds leave only as tranche payments to the payees the
///      plan names (the NGO only for its disclosed share) or as pro-rata refunds.
///      Invariant, with the idle capital a need may let wait in an ERC-4626 venue:
///        balance + deployedPrincipal + totalReleased + totalRefunded + lossRealised
///          == totalDonated + totalHeld + yieldRealised - yieldPaid
///      With no sleeve in use the four new terms are zero and it is the original identity.
contract AidVault is TrancheLedger, IAidVault {
    using SafeERC20 for IERC20;

    IERC20 public immutable token;
    IDonationReceipt public immutable receipt;
    /// @notice The only source of `donateVia` callers.
    IDonationForwarderFactory public immutable forwarderFactory;
    /// @notice Where conversion costs are counted against the need's cost cap.
    IFeeRecorder public immutable feeRecorder;

    /// @notice A donation can be taken back until this long before the funding deadline.
    uint256 public constant WITHDRAW_LOCK_PERIOD = 2 days;

    /// @notice The ERC-4626 venue this vault's idle capital is waiting in, or 0 while it holds none.
    /// @dev Read from the registry on the first deployment and then fixed until the position is fully closed, so
    ///      an admin changing the approved venue can never strand money in a vault nobody is looking at.
    IERC4626 public sleeve;
    /// @notice What the vault put in, at cost. Never `convertToAssets`: donors gave assets, not a share price.
    uint256 public deployedPrincipal;
    /// @notice Gains brought back into this vault, and the part already handed on.
    uint256 public yieldRealised;
    uint256 public yieldPaid;
    /// @notice Principal the venue did not return. Recorded so the identity still closes after a loss.
    uint256 public lossRealised;

    uint128 private _totalRefunded;
    /// @inheritdoc IAidVault
    uint256 public totalHeld;
    /// @inheritdoc IAidVault
    mapping(address => uint256) public heldPaymentOf;

    /// @notice Unrefunded direct donations per donor address (cleared when the refund is paid).
    mapping(address => uint256) public donatedBy;
    /// @notice Unrefunded donations a deposit address holds the claim to, keyed by the forwarder's own address
    ///         (cleared when the refund is paid). A deposit address that credits a wallet uses `donatedBy` instead.
    mapping(bytes32 => uint256) public donatedByRef;
    /// @notice The forwarder that owns a reference: only it may claim that reference's refund.
    mapping(bytes32 => address) public refPartner;

    constructor(
        IRoleRegistry roles_,
        INeedsRegistry registry_,
        address deliveryManager_,
        IAidVaultFactory factory_,
        IERC20 token_,
        IDonationReceipt receipt_,
        IDonationForwarderFactory forwarderFactory_,
        IFeeRecorder feeRecorder_
    ) TrancheLedger(roles_, registry_, deliveryManager_, factory_) {
        if (
            address(token_) == address(0) || address(receipt_) == address(0) || address(forwarderFactory_) == address(0)
                || address(feeRecorder_) == address(0)
        ) {
            revert Errors.ZeroAddress();
        }
        token = token_;
        receipt = receipt_;
        forwarderFactory = forwarderFactory_;
        feeRecorder = feeRecorder_;
    }

    // ─── donations ─────────────────────────────────────────────────────────────

    /// @inheritdoc IAidVault
    function donate(uint256 amount) external nonReentrant onlyClone returns (uint256 receiptId) {
        _requireNotPaused();
        uint256 id = needId();
        uint256 target = _checkFunding(id, amount);

        _totalDonated += uint128(amount);
        donatedBy[msg.sender] += amount;

        token.safeTransferFrom(msg.sender, address(this), amount);
        receiptId = receipt.mint(msg.sender, id, amount);
        emit Donated(id, msg.sender, amount, receiptId);

        if (_totalDonated == target) _closeFunding(id);
    }

    /// @inheritdoc IAidVault
    /// @dev A forwarder-credited donation is keyed by the forwarder's own address in `donatedByRef`, with the
    ///      forwarder as its `refPartner`, so refunds go through `claimRefundByRef`. A key already owned by
    ///      another depositor is refused rather than taken over.
    function donateVia(uint256 amount, uint256 conversionFee, address receiptTo)
        external
        nonReentrant
        onlyClone
        returns (uint256 receiptId)
    {
        _requireNotPaused();
        // The factory's direct wallet path always credits a wallet; forwarders may credit themselves.
        bool fromFactory = msg.sender == address(forwarderFactory);
        if (fromFactory ? receiptTo == address(0) : !forwarderFactory.isForwarder(msg.sender)) {
            revert Errors.Unauthorized();
        }
        uint256 id = needId();
        uint256 target = _checkFunding(id, amount);

        _totalDonated += uint128(amount);
        if (receiptTo != address(0)) {
            donatedBy[receiptTo] += amount;
        } else {
            bytes32 key = bytes32(uint256(uint160(msg.sender)));
            address owner = refPartner[key];
            if (owner != address(0) && owner != msg.sender) revert Errors.DonorRefPartnerMismatch();
            donatedByRef[key] += amount;
            refPartner[key] = msg.sender;
        }

        token.safeTransferFrom(msg.sender, address(this), amount);
        if (receiptTo != address(0)) receiptId = receipt.mint(receiptTo, id, amount);
        // After the donation is counted, so the cap is checked against what donors have now paid in total.
        if (conversionFee > 0) feeRecorder.recordConversionFee(id, conversionFee);
        emit DonatedVia(id, msg.sender, receiptTo, amount, conversionFee, receiptId);

        if (_totalDonated == target) _closeFunding(id);
    }

    /// @inheritdoc IAidVault
    function withdrawDonation(uint256 receiptId, uint256 amount) external nonReentrant onlyClone {
        _requireNotPaused();
        if (amount == 0) revert Errors.ZeroAmount();
        uint256 id = needId();

        // Only while the need is still raising. Once funding closes the tranches are fixed and the plan's
        // suppliers are entitled to them; from there money comes back as a refund, not as a withdrawal.
        if (_fundingClosed || registry.statusOf(id) != INeedsRegistry.NeedStatus.Funding) {
            revert Errors.FundingNotOpen();
        }
        // ...and not at the last moment: the NGO commits to suppliers on the strength of the raise, so the
        // final stretch before the deadline is settled.
        uint64 deadline = registry.fundingDeadlineOf(id);
        if (deadline != 0 && block.timestamp + WITHDRAW_LOCK_PERIOD > deadline) revert Errors.WithdrawalLocked();

        IDonationReceipt.Receipt memory record = receipt.receiptOf(receiptId);
        if (record.needId != id) revert Errors.InvalidParameter();
        if (amount > record.amount || amount > donatedBy[msg.sender]) revert Errors.InvalidParameter();

        // What donors paid shrinks, so a cost already recorded must still fit the cap the NGO disclosed: a
        // withdrawal must not retroactively break a published promise. Mirrors ProofOfAidResolver._checkCostCap,
        // against what donors would have paid without this donation. Settlement fees cannot exist yet, because
        // nothing is released while funding is open.
        uint256 fees = feeRecorder.fundingFeesOf(id);
        if (fees != 0) {
            uint256 paidByDonors = uint256(_totalDonated) - amount + fees;
            if (fees * BPS_DENOMINATOR > paidByDonors * registry.thirdPartyCostBpsOf(id)) {
                revert Errors.FeeExceedsDisclosure();
            }
        }

        donatedBy[msg.sender] -= amount;
        _totalDonated -= uint128(amount);
        // Reverts unless msg.sender owns the receipt, so this is also the authorization check.
        receipt.reduce(receiptId, msg.sender, uint256(record.amount) - amount);
        token.safeTransfer(msg.sender, amount);
        emit DonationWithdrawn(id, msg.sender, receiptId, amount);
    }

    // ─── tranches ──────────────────────────────────────────────────────────────

    /// @inheritdoc IAidVault
    function releaseTranche(uint256 index) external nonReentrant onlyClone {
        _requireNotPaused();
        uint256 id = needId();
        (uint256 amount,) = _release(id, index);
        // Waiting money comes home first: a tranche must not be held for a payee just because it was earning.
        _ensureLiquid(amount);
        // The payment plan decides who is paid; it reverts while a supplier in this tranche has lost its role.
        (address[] memory payees, uint16[] memory shares) = registry.trancheSplitOf(id, index);
        emit TrancheReleased(id, index, amount, address(0));
        _payPlan(id, index, amount, payees, shares);
        _completeIfSettled(id);
    }

    /// @inheritdoc IAidVault
    function claimHeldPayment(address payee) external nonReentrant onlyClone returns (uint256 amount) {
        _requireNotPaused();
        amount = heldPaymentOf[payee];
        if (amount == 0) revert Errors.NothingToClaim();
        delete heldPaymentOf[payee];
        totalHeld -= amount;
        _ensureLiquid(amount);
        token.safeTransfer(payee, amount);
        uint256 id = needId();
        emit HeldPaymentClaimed(id, payee, amount);
        // The last thing the need owed: it is only finished now.
        _completeIfSettled(id);
    }

    /// @inheritdoc IAidVault
    /// @dev Called by the registry when independent verifiers approve a replacement for a payee. Money this vault
    ///      could not hand to the old payee is owed to the new one, otherwise a frozen or blocklisted supplier
    ///      would strand its share here with nobody able to claim it.
    function onPayeeChanged(address from, address to) external onlyClone {
        if (msg.sender != address(registry)) revert Errors.Unauthorized();
        uint256 amount = heldPaymentOf[from];
        if (amount == 0) return;
        delete heldPaymentOf[from];
        heldPaymentOf[to] += amount;
        emit HeldPaymentReassigned(needId(), from, to, amount);
    }

    // ─── idle capital ──────────────────────────────────────────────────────────

    /// @notice Sends idle escrow to the need's approved venue to earn while it waits for the next delivery.
    /// @dev Only once funding has closed. While it is open a donor can still take their money back, and money
    ///      that can be recalled at any moment has no business in a lending vault. Permissionless on purpose:
    ///      anyone may call it, the rules decide the amount, and a keeper needs no privilege to do its job.
    function deployIdle(uint256 assets) external nonReentrant onlyClone returns (uint256 shares) {
        _requireNotPaused();
        uint256 id = needId();
        INeedsRegistry.NeedStatus s = registry.statusOf(id);
        if (s != INeedsRegistry.NeedStatus.Funded && s != INeedsRegistry.NeedStatus.InDelivery) {
            revert Errors.InvalidNeedStatus();
        }
        (address venue, uint16 capBps) = registry.yieldVenueOf(id);
        if (venue == address(0)) revert Errors.YieldNotEnabled();
        address current = address(sleeve);
        if (current == address(0)) sleeve = IERC4626(venue);
        else if (current != venue) revert Errors.YieldVenueChanged();
        if (assets == 0 || assets > _deployable(capBps)) revert Errors.InvalidParameter();

        deployedPrincipal += assets;
        token.forceApprove(venue, assets);
        shares = IERC4626(venue).deposit(assets, address(this));
        emit IdleDeployed(id, venue, assets, shares);
    }

    /// @notice Brings escrow home from the venue. A large enough amount closes the position entirely.
    /// @dev Deliberately callable while the platform is paused and by anyone: returning money to the escrow it
    ///      belongs in is never the unsafe direction, and a pause that trapped funds in a third party would be
    ///      the opposite of a safety measure.
    function unwind(uint256 assets) external nonReentrant onlyClone returns (uint256 received) {
        if (assets == 0) revert Errors.ZeroAmount();
        received = _unwind(assets);
        if (received == 0) revert Errors.SleeveIlliquid();
    }

    /// @notice Realises the gain without touching the principal, so the dashboard can show a curve.
    function harvest() external nonReentrant onlyClone returns (uint256 amount) {
        IERC4626 venue = sleeve;
        if (address(venue) == address(0)) revert Errors.NothingToClaim();
        uint256 value = venue.previewRedeem(venue.balanceOf(address(this)));
        uint256 principal = deployedPrincipal;
        if (value <= principal) revert Errors.NothingToClaim();
        uint256 available = venue.maxWithdraw(address(this));
        uint256 surplus = value - principal;
        amount = surplus < available ? surplus : available;
        if (amount == 0) revert Errors.SleeveIlliquid();
        venue.withdraw(amount, address(this), address(this));
        yieldRealised += amount;
        emit YieldHarvested(needId(), address(venue), amount);
    }

    /// @notice Hands the earnings to the NGO once the need is over and the position is closed.
    /// @dev Donors are repaid principal and nothing else, whatever happened in the venue — a refund is worked out
    ///      from what was donated and released, never from this vault's balance. What the money earned while it
    ///      waited belongs to the need, and a loss is charged against those earnings before anything is paid.
    function payYield() external nonReentrant onlyClone returns (uint256 amount) {
        uint256 id = needId();
        INeedsRegistry.NeedStatus s = registry.statusOf(id);
        if (s != INeedsRegistry.NeedStatus.Completed && !_isRefundable(s)) revert Errors.InvalidNeedStatus();
        if (address(sleeve) != address(0) || deployedPrincipal != 0) revert Errors.SleeveNotClosed();
        uint256 charged = yieldPaid + lossRealised;
        if (yieldRealised <= charged) revert Errors.NothingToClaim();
        amount = yieldRealised - charged;
        yieldPaid += amount;
        (address ngo,,,) = registry.coreOf(id);
        address to = roles.payoutOf(ngo);
        token.safeTransfer(to, amount);
        emit YieldPaid(id, to, amount);
    }

    /// @notice What this vault could send to the venue right now.
    function deployableAmount() external view returns (uint256) {
        (address venue, uint16 capBps) = registry.yieldVenueOf(needId());
        if (venue == address(0)) return 0;
        address current = address(sleeve);
        if (current != address(0) && current != venue) return 0;
        return _deployable(capBps);
    }

    /// @notice What the position is worth today, and the part of it that is not principal.
    function sleeveValue() external view returns (uint256 value, uint256 unrealisedYield) {
        IERC4626 venue = sleeve;
        if (address(venue) == address(0)) return (0, 0);
        value = venue.previewRedeem(venue.balanceOf(address(this)));
        unrealisedYield = value > deployedPrincipal ? value - deployedPrincipal : 0;
    }

    // ─── refunds ───────────────────────────────────────────────────────────────

    /// @inheritdoc IAidVault
    function claimRefund() external nonReentrant onlyClone returns (uint256 amount) {
        _requireNotPaused();
        uint256 id = needId();
        _requireRefundable(id);
        uint256 donated = donatedBy[msg.sender];
        if (donated == 0) revert Errors.NothingToRefund();

        amount = _refundAmount(donated);
        delete donatedBy[msg.sender];
        _totalRefunded += uint128(amount);

        _ensureLiquid(amount);
        token.safeTransfer(msg.sender, amount);
        emit Refunded(id, msg.sender, amount);
    }

    /// @inheritdoc IAidVault
    /// @dev Authorization is ownership of the reference: only the deposit address that credited itself can
    ///      claim, and it pays out only to the refund destination it committed to when it was created.
    function claimRefundByRef(bytes32 donorRefHash, address to)
        external
        nonReentrant
        onlyClone
        returns (uint256 amount)
    {
        _requireNotPaused();
        if (refPartner[donorRefHash] != msg.sender) revert Errors.Unauthorized();
        // Refunding into the vault itself would inflate totalRefunded without moving tokens, breaking the
        // balance + released + refunded == donated identity and stranding the amount.
        if (to == address(0) || to == address(this)) revert Errors.ZeroAddress();
        uint256 id = needId();
        _requireRefundable(id);
        uint256 donated = donatedByRef[donorRefHash];
        if (donated == 0) revert Errors.NothingToRefund();

        amount = _refundAmount(donated);
        delete donatedByRef[donorRefHash];
        _totalRefunded += uint128(amount);

        _ensureLiquid(amount);
        token.safeTransfer(to, amount);
        emit RefundedByRef(id, donorRefHash, to, amount);
    }

    // ─── views ─────────────────────────────────────────────────────────────────

    /// @inheritdoc IAidVault
    function totalRefunded() external view returns (uint256) {
        return _totalRefunded;
    }

    /// @notice Refund a direct donor could claim right now (0 unless the need is cancelled or expired).
    function refundableAmount(address donor) external view returns (uint256) {
        if (!_isRefundable(registry.statusOf(needId()))) return 0;
        uint256 donated = donatedBy[donor];
        return donated == 0 ? 0 : _refundAmount(donated);
    }

    // ─── internal ──────────────────────────────────────────────────────────────

    /// @dev Splits a released tranche by the plan's basis points, rounding dust to the last payee so the tranche is
    ///      paid out exactly. A transfer the token refuses is held for that payee instead of blocking the others.
    function _payPlan(uint256 id, uint256 index, uint256 amount, address[] memory payees, uint16[] memory shares)
        internal
    {
        uint256 count = payees.length;
        if (count == 0) revert Errors.InvalidPaymentPlan();
        uint256 allocated;
        for (uint256 i; i < count; ++i) {
            uint256 share = i == count - 1 ? amount - allocated : (amount * shares[i]) / BPS_DENOMINATOR;
            allocated += share;
            if (share == 0) continue;
            address payee = payees[i];
            // Paying the vault itself would raise totalReleased without moving anything: unreachable today (a
            // vault address is not known when its plan is fixed), refused anyway because the identity depends on it.
            if (payee == address(this)) revert Errors.InvalidPaymentPlan();
            if (token.trySafeTransfer(payee, share)) {
                emit PayeePaid(id, index, payee, share);
            } else {
                heldPaymentOf[payee] += share;
                totalHeld += share;
                emit PaymentHeld(id, index, payee, share);
            }
        }
    }

    /// @dev A vault completes its need only once every tranche is released *and* nothing is still held for a
    ///      payee. A need that still owes money is not finished, and Completed is terminal: reporting it would
    ///      close the refund, expiry and payee-change paths on money that never left.
    // forge-lint: disable-next-line(empty-block)
    function _completeFinalRelease(uint256) internal override {}

    function _completeIfSettled(uint256 id) internal {
        if (totalHeld != 0 || !_allTranchesReleased()) return;
        if (registry.statusOf(id) != INeedsRegistry.NeedStatus.InDelivery) return;
        registry.setStatus(id, INeedsRegistry.NeedStatus.Completed);
    }

    /// @dev Pulls back from the venue whatever this vault is short of, and refuses to go on if it cannot. A
    ///      supplier being paid late is a problem; a supplier being paid a part while the rest is "held" because
    ///      the money was quietly somewhere else is a worse one.
    function _ensureLiquid(uint256 amount) internal {
        uint256 balance = token.balanceOf(address(this));
        if (balance >= amount) return;
        _unwind(amount - balance);
        // Still short while money is still lent out: the venue is the problem, and paying part of a tranche
        // while the rest sits in a lending market is worse than saying so plainly. Short with nothing lent is
        // a loss the need has already taken, and that is not this function's to hide.
        if (token.balanceOf(address(this)) < amount && address(sleeve) != address(0)) {
            revert Errors.SleeveIlliquid();
        }
    }

    /// @dev Withdrawals count against principal first; what the venue returns beyond it is yield, and principal
    ///      still standing when the last share is gone is a loss. Both settle in the one place.
    function _unwind(uint256 assets) internal returns (uint256 received) {
        IERC4626 venue = sleeve;
        if (address(venue) == address(0) || assets == 0) return 0;
        uint256 available = venue.maxWithdraw(address(this));
        if (assets >= available) {
            uint256 shares = venue.maxRedeem(address(this));
            if (shares == 0) return 0;
            received = venue.redeem(shares, address(this), address(this));
        } else {
            venue.withdraw(assets, address(this), address(this));
            received = assets;
        }
        uint256 principal = deployedPrincipal;
        if (received >= principal) {
            deployedPrincipal = 0;
            yieldRealised += received - principal;
        } else {
            deployedPrincipal = principal - received;
        }
        emit IdleUnwound(needId(), address(venue), received);
        // Closed is a question about value, not about share count: redeeming everything a venue will part with
        // routinely leaves a share or two behind, worth nothing, and a position that can never be called closed
        // is one whose loss is never recognised and whose earnings can never be handed on.
        // forge-lint: disable-next-line(incorrect-strict-equality)
        if (venue.previewRedeem(venue.balanceOf(address(this))) == 0) {
            uint256 shortfall = deployedPrincipal;
            if (shortfall != 0) {
                deployedPrincipal = 0;
                lossRealised += shortfall;
                emit SleeveLoss(needId(), address(venue), shortfall);
            }
            sleeve = IERC4626(address(0));
        }
    }

    /// @dev What may go to the venue: never money a payee could claim this instant, and never past the cap.
    function _deployable(uint16 capBps) internal view returns (uint256) {
        uint256 balance = token.balanceOf(address(this));
        uint256 reserved = totalHeld + _releasableAmount();
        if (balance <= reserved) return 0;
        uint256 free = balance - reserved;
        // The cap is on the whole pot, so repeated deployments cannot creep past it one call at a time.
        uint256 ceiling = ((balance + deployedPrincipal) * capBps) / BPS_DENOMINATOR;
        if (deployedPrincipal >= ceiling) return 0;
        uint256 headroom = ceiling - deployedPrincipal;
        return free < headroom ? free : headroom;
    }

    /// @dev Tranches a verified delivery has already unlocked: payable now, so they stay liquid now.
    function _releasableAmount() internal view returns (uint256 total) {
        uint256 count = _trancheCount;
        for (uint256 i; i < count; ++i) {
            if (_tranches[i].status == TrancheStatus.Releasable) total += _tranches[i].amount;
        }
    }

    function _refundAmount(uint256 donated) internal view returns (uint256) {
        // totalDonated and totalReleased are frozen once a need is cancelled or expired, so the pro-rata shares sum
        // to at most the unreleased balance (floor rounding leaves at most a few base units of dust in the vault).
        return (donated * (uint256(_totalDonated) - _totalReleased)) / _totalDonated;
    }

    function _requireRefundable(uint256 id) internal view {
        if (!_isRefundable(registry.statusOf(id))) revert Errors.NotRefundable();
    }

    function _isRefundable(INeedsRegistry.NeedStatus s) internal pure returns (bool) {
        return s == INeedsRegistry.NeedStatus.Cancelled || s == INeedsRegistry.NeedStatus.Expired;
    }
}
