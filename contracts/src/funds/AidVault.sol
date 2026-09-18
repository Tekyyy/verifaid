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
import {Roles} from "../libraries/Roles.sol";
import {TrancheLedger} from "./TrancheLedger.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title AidVault
/// @notice Escrow for a single need (`CustodyMode.OnChain`). Holds stablecoin until tranches are unlocked by
///         verified deliveries, then pays each tranche straight to the suppliers of the need's payment plan.
/// @dev There is intentionally no admin withdrawal path: funds leave only as tranche payments to the payees the
///      plan names (the NGO only for its disclosed share) or as pro-rata refunds.
///      Invariant: token.balanceOf(vault) + totalReleased + totalRefunded == totalDonated + totalHeld.
contract AidVault is TrancheLedger, IAidVault {
    using SafeERC20 for IERC20;

    IERC20 public immutable token;
    IDonationReceipt public immutable receipt;
    /// @notice The only source of `donateVia` callers.
    IDonationForwarderFactory public immutable forwarderFactory;
    /// @notice Where conversion costs are counted against the need's cost cap.
    IFeeRecorder public immutable feeRecorder;

    uint128 private _totalRefunded;
    /// @inheritdoc IAidVault
    uint256 public totalHeld;
    /// @inheritdoc IAidVault
    mapping(address => uint256) public heldPaymentOf;

    /// @notice Unrefunded direct donations per donor address (cleared when the refund is paid).
    mapping(address => uint256) public donatedBy;
    /// @notice Unrefunded fiat donations per salted donor reference hash (cleared when the refund is paid).
    mapping(bytes32 => uint256) public donatedByRef;
    /// @notice Payment provider that owns a donor reference (only it may claim refunds for that reference).
    mapping(bytes32 => address) public refPartner;
    /// @notice keccak256(partner, paymentRefHash) => keccak256(donorRefHash, amount): one slot per deposit, enough
    ///         for the resolver to check a `FundingRecorded` attestation against what was actually deposited.
    mapping(bytes32 => bytes32) public fiatDepositDigest;

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
    /// @dev No receipt NFT is minted for fiat donations: the donor is represented only by `donorRefHash`.
    function donateOnBehalf(uint256 amount, bytes32 donorRefHash, bytes32 paymentRefHash)
        external
        nonReentrant
        onlyClone
    {
        _requireNotPaused();
        if (!roles.hasRole(Roles.BANK_PARTNER_ROLE, msg.sender)) revert Errors.Unauthorized();
        if (donorRefHash == bytes32(0) || paymentRefHash == bytes32(0)) revert Errors.InvalidParameter();
        address owner = refPartner[donorRefHash];
        if (owner != address(0) && owner != msg.sender) revert Errors.DonorRefPartnerMismatch();
        uint256 id = needId();
        uint256 target = _checkFunding(id, amount);

        _totalDonated += uint128(amount);
        donatedByRef[donorRefHash] += amount;
        if (owner == address(0)) refPartner[donorRefHash] = msg.sender;
        fiatDepositDigest[_depositKey(msg.sender, paymentRefHash)] = _digest(donorRefHash, amount);

        factory.consumePaymentRef(msg.sender, paymentRefHash); // reverts if this provider already used it anywhere
        token.safeTransferFrom(msg.sender, address(this), amount);
        emit DonatedOnBehalf(id, msg.sender, amount, donorRefHash, paymentRefHash);

        if (_totalDonated == target) _closeFunding(id);
    }

    /// @inheritdoc IAidVault
    /// @dev A forwarder-credited donation is keyed by the forwarder's own address in `donatedByRef`, with the
    ///      forwarder as its `refPartner`, so refunds reuse `claimRefundByRef`. Like `donateOnBehalf`, a key already
    ///      owned by another depositor is refused rather than taken over.
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

    // ─── tranches ──────────────────────────────────────────────────────────────

    /// @inheritdoc IAidVault
    function releaseTranche(uint256 index) external nonReentrant onlyClone {
        _requireNotPaused();
        uint256 id = needId();
        (uint256 amount,) = _release(id, index);
        // The payment plan decides who is paid; it reverts while a supplier in this tranche has lost its role.
        (address[] memory payees, uint16[] memory shares) = registry.trancheSplitOf(id, index);
        emit TrancheReleased(id, index, amount, address(0));
        _payPlan(id, index, amount, payees, shares);
    }

    /// @inheritdoc IAidVault
    function claimHeldPayment(address payee) external nonReentrant onlyClone returns (uint256 amount) {
        _requireNotPaused();
        amount = heldPaymentOf[payee];
        if (amount == 0) revert Errors.NothingToClaim();
        delete heldPaymentOf[payee];
        totalHeld -= amount;
        token.safeTransfer(payee, amount);
        emit HeldPaymentClaimed(needId(), payee, amount);
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

        token.safeTransfer(msg.sender, amount);
        emit Refunded(id, msg.sender, amount);
    }

    /// @inheritdoc IAidVault
    /// @dev Authorization is ownership of the reference, deliberately *not* a live BANK_PARTNER_ROLE check:
    ///      the partner that deposited the money must still be able to return it to its donor after the admin
    ///      de-registers it, otherwise revoking a partner's role would strand its donors' refunds forever.
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

        token.safeTransfer(to, amount);
        emit RefundedByRef(id, donorRefHash, to, amount);
    }

    // ─── views ─────────────────────────────────────────────────────────────────

    /// @inheritdoc IAidVault
    function totalRefunded() external view returns (uint256) {
        return _totalRefunded;
    }

    /// @inheritdoc IAidVault
    function fiatDepositMatches(bytes32 paymentRefHash, address partner, bytes32 donorRefHash, uint256 amount)
        external
        view
        returns (bool)
    {
        bytes32 digest = fiatDepositDigest[_depositKey(partner, paymentRefHash)];
        return digest != bytes32(0) && digest == _digest(donorRefHash, amount);
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
            if (token.trySafeTransfer(payee, share)) {
                emit PayeePaid(id, index, payee, share);
            } else {
                heldPaymentOf[payee] += share;
                totalHeld += share;
                emit PaymentHeld(id, index, payee, share);
            }
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

    function _depositKey(address partner, bytes32 paymentRefHash) internal pure returns (bytes32) {
        return keccak256(abi.encode(partner, paymentRefHash));
    }

    function _digest(bytes32 donorRefHash, uint256 amount) internal pure returns (bytes32) {
        return keccak256(abi.encode(donorRefHash, amount));
    }
}
