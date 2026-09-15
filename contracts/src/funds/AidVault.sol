// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IAidVault} from "../interfaces/IAidVault.sol";
import {IAidVaultFactory} from "../interfaces/IAidVaultFactory.sol";
import {IDonationReceipt} from "../interfaces/IDonationReceipt.sol";
import {INeedsRegistry} from "../interfaces/INeedsRegistry.sol";
import {IRoleRegistry} from "../interfaces/IRoleRegistry.sol";
import {Errors} from "../libraries/Errors.sol";
import {Roles} from "../libraries/Roles.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title AidVault
/// @notice Escrow for a single need. Holds stablecoin until tranches are unlocked by verified deliveries.
/// @dev Deployed as minimal-proxy clones by AidVaultFactory. There is intentionally no admin withdrawal path:
///      funds leave only as tranche releases to the NGO's registered payout address or as pro-rata refunds.
///      Invariant: token.balanceOf(vault) + totalReleased + totalRefunded == totalDonated.
contract AidVault is IAidVault, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint16 private constant BPS_DENOMINATOR = 10_000;

    IERC20 public token;
    /// @inheritdoc IAidVault
    uint256 public needId;
    INeedsRegistry public registry;
    address public deliveryManager;
    IDonationReceipt public receipt;
    IRoleRegistry public roles;
    IAidVaultFactory public factory;

    /// @inheritdoc IAidVault
    uint256 public totalDonated;
    /// @inheritdoc IAidVault
    uint256 public totalReleased;
    /// @inheritdoc IAidVault
    uint256 public totalRefunded;
    /// @inheritdoc IAidVault
    bool public fundingClosed;

    /// @notice Tranche plan copied from the need at initialization; amounts are set when funding closes.
    Tranche[] public tranches;

    /// @notice Direct donations per donor address.
    mapping(address => uint256) public donatedBy;
    /// @notice Fiat donations per salted donor reference hash.
    mapping(bytes32 => uint256) public donatedByRef;
    /// @notice Fiat payment references already deposited into this vault.
    mapping(bytes32 => bool) public paymentRefUsed;
    /// @notice Bank partner that owns a donor reference (only it may claim refunds for that reference).
    mapping(bytes32 => address) public refPartner;
    mapping(address => bool) public refundClaimed;
    mapping(bytes32 => bool) public refundClaimedByRef;

    mapping(bytes32 => FiatDonationRecord) private _fiatDonations;
    bool private _initialized;

    /// @dev Locks the implementation contract; clones are initialized by the factory.
    constructor() {
        _initialized = true;
    }

    /// @inheritdoc IAidVault
    function initialize(uint256 needId_, address token_, address registry_, address deliveryManager_, address receipt_)
        external
    {
        if (_initialized) revert Errors.AlreadyInitialized();
        if (token_ == address(0) || registry_ == address(0) || deliveryManager_ == address(0) || receipt_ == address(0))
        {
            revert Errors.ZeroAddress();
        }
        _initialized = true;

        needId = needId_;
        token = IERC20(token_);
        registry = INeedsRegistry(registry_);
        deliveryManager = deliveryManager_;
        receipt = IDonationReceipt(receipt_);
        factory = IAidVaultFactory(msg.sender);
        roles = registry.roles();

        uint16[] memory bps = registry.trancheBpsOf(needId_);
        for (uint256 i; i < bps.length; ++i) {
            tranches.push(Tranche({bps: bps[i], amount: 0, status: TrancheStatus.Locked, deliveryId: 0}));
        }
    }

    // ─── donations ─────────────────────────────────────────────────────────────

    /// @inheritdoc IAidVault
    function donate(uint256 amount) external nonReentrant returns (uint256 receiptId) {
        _requireNotPaused();
        uint256 target = _checkDonation(amount);

        totalDonated += amount;
        donatedBy[msg.sender] += amount;

        token.safeTransferFrom(msg.sender, address(this), amount);
        receiptId = receipt.mint(msg.sender, needId, amount);
        emit Donated(needId, msg.sender, amount, receiptId);

        if (totalDonated == target) _closeFunding();
    }

    /// @inheritdoc IAidVault
    /// @dev No receipt NFT is minted for fiat donations: the donor is represented only by `donorRefHash`.
    function donateOnBehalf(uint256 amount, bytes32 donorRefHash, bytes32 paymentRefHash) external nonReentrant {
        _requireNotPaused();
        if (!roles.hasRole(Roles.BANK_PARTNER_ROLE, msg.sender)) revert Errors.Unauthorized();
        if (donorRefHash == bytes32(0) || paymentRefHash == bytes32(0)) revert Errors.InvalidParameter();
        if (paymentRefUsed[paymentRefHash]) revert Errors.PaymentRefAlreadyUsed();
        address owner = refPartner[donorRefHash];
        if (owner != address(0) && owner != msg.sender) revert Errors.DonorRefPartnerMismatch();
        uint256 target = _checkDonation(amount);

        totalDonated += amount;
        donatedByRef[donorRefHash] += amount;
        paymentRefUsed[paymentRefHash] = true;
        refPartner[donorRefHash] = msg.sender;
        _fiatDonations[paymentRefHash] = FiatDonationRecord({
            partner: msg.sender, donorRefHash: donorRefHash, amount: amount, timestamp: uint64(block.timestamp)
        });

        factory.consumePaymentRef(paymentRefHash);
        token.safeTransferFrom(msg.sender, address(this), amount);
        emit DonatedOnBehalf(needId, msg.sender, amount, donorRefHash, paymentRefHash);

        if (totalDonated == target) _closeFunding();
    }

    /// @inheritdoc IAidVault
    function closeFunding() external nonReentrant {
        _requireNotPaused();
        if (msg.sender != registry.ngoOf(needId)) revert Errors.Unauthorized();
        if (fundingClosed || registry.statusOf(needId) != INeedsRegistry.NeedStatus.Funding) {
            revert Errors.FundingNotOpen();
        }
        if (totalDonated == 0) revert Errors.NothingDonated();
        _closeFunding();
    }

    // ─── tranches ──────────────────────────────────────────────────────────────

    /// @inheritdoc IAidVault
    function markReleasable(uint256 index, uint256 deliveryId) external {
        if (msg.sender != deliveryManager) revert Errors.Unauthorized();
        if (index == 0 || index >= tranches.length) revert Errors.InvalidTrancheIndex();
        if (registry.statusOf(needId) != INeedsRegistry.NeedStatus.InDelivery) revert Errors.InvalidNeedStatus();
        Tranche storage t = tranches[index];
        if (t.status != TrancheStatus.Locked) revert Errors.InvalidTrancheStatus();
        if (tranches[index - 1].status != TrancheStatus.Released) revert Errors.PreviousTrancheNotReleased();

        t.status = TrancheStatus.Releasable;
        t.deliveryId = deliveryId;
        emit TrancheReleasable(needId, index, deliveryId);
    }

    /// @inheritdoc IAidVault
    function releaseTranche(uint256 index) external nonReentrant {
        _requireNotPaused();
        if (index >= tranches.length) revert Errors.InvalidTrancheIndex();
        Tranche storage t = tranches[index];
        if (t.status != TrancheStatus.Releasable) revert Errors.InvalidTrancheStatus();
        INeedsRegistry.NeedStatus s = registry.statusOf(needId);
        if (s != INeedsRegistry.NeedStatus.Funded && s != INeedsRegistry.NeedStatus.InDelivery) {
            revert Errors.InvalidNeedStatus();
        }
        address ngo = registry.ngoOf(needId);
        if (!roles.isActiveNgo(ngo)) revert Errors.NgoInactive();
        address payout = roles.payoutOf(ngo);

        uint256 amount = t.amount;
        t.status = TrancheStatus.Released;
        totalReleased += amount;

        // Tranche 0 (pre-financing) starts the delivery phase; the final tranche completes the need.
        if (index == 0) registry.setStatus(needId, INeedsRegistry.NeedStatus.InDelivery);
        if (index == tranches.length - 1) registry.setStatus(needId, INeedsRegistry.NeedStatus.Completed);

        token.safeTransfer(payout, amount);
        emit TrancheReleased(needId, index, amount, payout);
    }

    // ─── refunds ───────────────────────────────────────────────────────────────

    /// @inheritdoc IAidVault
    function claimRefund() external nonReentrant returns (uint256 amount) {
        _requireNotPaused();
        _requireCancelled();
        uint256 donated = donatedBy[msg.sender];
        if (donated == 0) revert Errors.NothingToRefund();
        if (refundClaimed[msg.sender]) revert Errors.RefundAlreadyClaimed();

        amount = _refundAmount(donated);
        refundClaimed[msg.sender] = true;
        totalRefunded += amount;

        token.safeTransfer(msg.sender, amount);
        emit Refunded(needId, msg.sender, amount);
    }

    /// @inheritdoc IAidVault
    function claimRefundByRef(bytes32 donorRefHash, address to) external nonReentrant returns (uint256 amount) {
        _requireNotPaused();
        if (!roles.hasRole(Roles.BANK_PARTNER_ROLE, msg.sender) || refPartner[donorRefHash] != msg.sender) {
            revert Errors.Unauthorized();
        }
        if (to == address(0)) revert Errors.ZeroAddress();
        _requireCancelled();
        uint256 donated = donatedByRef[donorRefHash];
        if (donated == 0) revert Errors.NothingToRefund();
        if (refundClaimedByRef[donorRefHash]) revert Errors.RefundAlreadyClaimed();

        amount = _refundAmount(donated);
        refundClaimedByRef[donorRefHash] = true;
        totalRefunded += amount;

        token.safeTransfer(to, amount);
        emit RefundedByRef(needId, donorRefHash, to, amount);
    }

    // ─── views ─────────────────────────────────────────────────────────────────

    /// @inheritdoc IAidVault
    function trancheCount() external view returns (uint256) {
        return tranches.length;
    }

    /// @inheritdoc IAidVault
    function trancheStatus(uint256 index) external view returns (TrancheStatus) {
        if (index >= tranches.length) revert Errors.InvalidTrancheIndex();
        return tranches[index].status;
    }

    /// @inheritdoc IAidVault
    function getTranches() external view returns (Tranche[] memory) {
        return tranches;
    }

    /// @inheritdoc IAidVault
    function fiatDonation(bytes32 paymentRefHash) external view returns (FiatDonationRecord memory) {
        return _fiatDonations[paymentRefHash];
    }

    /// @notice Refund a direct donor could claim right now (0 unless the need is cancelled and unclaimed).
    function refundableAmount(address donor) external view returns (uint256) {
        if (registry.statusOf(needId) != INeedsRegistry.NeedStatus.Cancelled || refundClaimed[donor]) return 0;
        uint256 donated = donatedBy[donor];
        return donated == 0 ? 0 : _refundAmount(donated);
    }

    // ─── internal ──────────────────────────────────────────────────────────────

    function _checkDonation(uint256 amount) internal view returns (uint256 target) {
        if (amount == 0) revert Errors.ZeroAmount();
        if (fundingClosed || registry.statusOf(needId) != INeedsRegistry.NeedStatus.Funding) {
            revert Errors.FundingNotOpen();
        }
        target = registry.targetAmountOf(needId);
        if (totalDonated + amount > target) revert Errors.ExceedsTarget();
    }

    /// @dev Splits `totalDonated` by basis points (rounding dust goes to the last tranche) and unlocks tranche 0.
    function _closeFunding() internal {
        fundingClosed = true;
        uint256 len = tranches.length;
        uint256 allocated;
        for (uint256 i; i < len; ++i) {
            Tranche storage t = tranches[i];
            uint256 amount = i == len - 1 ? totalDonated - allocated : (totalDonated * t.bps) / BPS_DENOMINATOR;
            t.amount = amount;
            allocated += amount;
        }
        tranches[0].status = TrancheStatus.Releasable;

        emit FundingClosed(needId, totalDonated);
        registry.setStatus(needId, INeedsRegistry.NeedStatus.Funded);
        emit TrancheReleasable(needId, 0, 0);
    }

    function _refundAmount(uint256 donated) internal view returns (uint256) {
        // totalDonated and totalReleased are frozen once a need is cancelled, so the pro-rata shares sum to at
        // most the unreleased balance (floor rounding leaves at most a few base units of dust in the vault).
        return (donated * (totalDonated - totalReleased)) / totalDonated;
    }

    function _requireCancelled() internal view {
        if (registry.statusOf(needId) != INeedsRegistry.NeedStatus.Cancelled) revert Errors.NotCancelled();
    }

    function _requireNotPaused() internal view {
        if (roles.paused()) revert Errors.SystemPaused();
    }
}
