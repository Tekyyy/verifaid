// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IAidVaultFactory} from "../interfaces/IAidVaultFactory.sol";
import {INeedsRegistry} from "../interfaces/INeedsRegistry.sol";
import {IRoleRegistry} from "../interfaces/IRoleRegistry.sol";
import {ITrancheLedger} from "../interfaces/ITrancheLedger.sol";
import {Errors} from "../libraries/Errors.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";

/// @title TrancheLedger
/// @notice Funding and tranche bookkeeping for AidVault.
/// @dev Deployed as EIP-1167 clones whose only immutable argument is the need id, appended to the clone's code.
///      Everything else a ledger needs (registry, delivery manager, factory, token...) is an immutable of the
///      implementation, shared by every clone through `delegatecall`. A new ledger therefore writes no storage
///      at all until money arrives: there is no initializer to call, and so no initializer to front-run.
abstract contract TrancheLedger is ITrancheLedger, ReentrancyGuardTransient {
    uint16 internal constant BPS_DENOMINATOR = 10_000;

    IRoleRegistry public immutable roles;
    INeedsRegistry public immutable registry;
    address public immutable deliveryManager;
    IAidVaultFactory public immutable factory;
    /// @dev The implementation's own address; calls that reach it directly (not through a clone) are rejected.
    address private immutable _self;

    // slot: running totals
    uint128 internal _totalDonated;
    uint128 internal _totalReleased;
    // slot: flags (AidVault packs its refund total alongside)
    bool internal _fundingClosed;
    uint8 internal _trancheCount; // set when funding closes

    /// @dev Tranche state packed into one slot per tranche; the basis points live in the registry.
    struct TrancheState {
        uint128 amount;
        uint64 deliveryId;
        TrancheStatus status;
    }

    mapping(uint256 => TrancheState) internal _tranches;

    constructor(IRoleRegistry roles_, INeedsRegistry registry_, address deliveryManager_, IAidVaultFactory factory_) {
        if (
            address(roles_) == address(0) || address(registry_) == address(0) || deliveryManager_ == address(0)
                || address(factory_) == address(0)
        ) revert Errors.ZeroAddress();
        roles = roles_;
        registry = registry_;
        deliveryManager = deliveryManager_;
        factory = factory_;
        _self = address(this);
    }

    modifier onlyClone() {
        if (address(this) == _self) revert Errors.NotLedger();
        _;
    }

    // ─── funding ───────────────────────────────────────────────────────────────

    /// @inheritdoc ITrancheLedger
    function closeFunding() external nonReentrant onlyClone {
        _requireNotPaused();
        uint256 id = needId();
        (, uint256 target, uint16 minFundingBps, bool open) = registry.fundingTermsOf(id);
        // Whoever runs the need: its NGO, or the beneficiary who posted it.
        if (msg.sender != registry.ownerOf(id)) revert Errors.Unauthorized();
        if (_fundingClosed || !open) revert Errors.FundingNotOpen();
        uint256 raised = _totalDonated;
        if (raised == 0) revert Errors.NothingDonated();
        // Closing early must not sidestep the all-or-nothing / partial-execution terms donors were shown.
        if (raised * BPS_DENOMINATOR < target * minFundingBps) revert Errors.BelowMinimumFunding();
        _closeFunding(id);
    }

    /// @inheritdoc ITrancheLedger
    /// @dev The registry has already checked the deadline and the threshold.
    function closeFundingAtDeadline() external nonReentrant onlyClone {
        if (msg.sender != address(registry)) revert Errors.Unauthorized();
        if (_fundingClosed) revert Errors.FundingNotOpen();
        _closeFunding(needId());
    }

    // ─── tranches ──────────────────────────────────────────────────────────────

    /// @inheritdoc ITrancheLedger
    function markReleasable(uint256 index, uint256 deliveryId) external onlyClone {
        if (msg.sender != deliveryManager) revert Errors.Unauthorized();
        uint256 id = needId();
        if (index == 0 || index >= _trancheCount) revert Errors.InvalidTrancheIndex();
        if (registry.statusOf(id) != INeedsRegistry.NeedStatus.InDelivery) revert Errors.InvalidNeedStatus();
        TrancheState storage t = _tranches[index];
        if (t.status != TrancheStatus.Locked) revert Errors.InvalidTrancheStatus();
        if (_tranches[index - 1].status != TrancheStatus.Released) revert Errors.PreviousTrancheNotReleased();

        t.status = TrancheStatus.Releasable;
        t.deliveryId = uint64(deliveryId);
        emit TrancheReleasable(id, index, deliveryId);
    }

    // ─── views ─────────────────────────────────────────────────────────────────

    /// @inheritdoc ITrancheLedger
    /// @dev Read from the clone's code: `abi.encode(needId)` appended by the factory.
    function needId() public view returns (uint256) {
        return abi.decode(Clones.fetchCloneArgs(address(this)), (uint256));
    }

    /// @inheritdoc ITrancheLedger
    function totalDonated() external view returns (uint256) {
        return _totalDonated;
    }

    /// @inheritdoc ITrancheLedger
    function totalReleased() external view returns (uint256) {
        return _totalReleased;
    }

    /// @inheritdoc ITrancheLedger
    function fundingClosed() external view returns (bool) {
        return _fundingClosed;
    }

    /// @inheritdoc ITrancheLedger
    function trancheCount() public view returns (uint256) {
        return _fundingClosed ? _trancheCount : registry.trancheBpsOf(needId()).length;
    }

    /// @inheritdoc ITrancheLedger
    function trancheStatus(uint256 index) external view returns (TrancheStatus) {
        if (index >= trancheCount()) revert Errors.InvalidTrancheIndex();
        return _tranches[index].status;
    }

    /// @inheritdoc ITrancheLedger
    function getTranches() external view returns (Tranche[] memory tranches) {
        uint16[] memory bps = registry.trancheBpsOf(needId());
        tranches = new Tranche[](bps.length);
        for (uint256 i; i < bps.length; ++i) {
            TrancheState storage t = _tranches[i];
            tranches[i] = Tranche({bps: bps[i], amount: t.amount, status: t.status, deliveryId: t.deliveryId});
        }
    }

    /// @inheritdoc ITrancheLedger
    function hasReleasableTranche() external view returns (bool) {
        uint256 count = _trancheCount;
        for (uint256 i; i < count; ++i) {
            if (_tranches[i].status == TrancheStatus.Releasable) return true;
        }
        return false;
    }

    // ─── internal ──────────────────────────────────────────────────────────────

    /// @dev Splits what was actually raised by basis points (rounding dust goes to the last tranche), so a partially
    ///      funded need scales every tranche down proportionally, and unlocks tranche 0.
    function _closeFunding(uint256 id) internal {
        uint16[] memory bps = registry.trancheBpsOf(id);
        uint256 len = bps.length;
        uint256 raised = _totalDonated;
        uint256 allocated;
        for (uint256 i; i < len; ++i) {
            uint256 amount = i == len - 1 ? raised - allocated : (raised * bps[i]) / BPS_DENOMINATOR;
            _tranches[i].amount = uint128(amount);
            allocated += amount;
        }
        _tranches[0].status = TrancheStatus.Releasable;
        _fundingClosed = true;
        _trancheCount = uint8(len);

        emit FundingClosed(id, raised);
        registry.setStatus(id, INeedsRegistry.NeedStatus.Funded);
        emit TrancheReleasable(id, 0, 0);
    }

    /// @dev Book-keeping of a release. Returns what was released and the NGO's payout address.
    function _release(uint256 id, uint256 index) internal returns (uint256 amount, address payout) {
        if (index >= _trancheCount) revert Errors.InvalidTrancheIndex();
        TrancheState storage t = _tranches[index];
        if (t.status != TrancheStatus.Releasable) revert Errors.InvalidTrancheStatus();
        (address ngo,,, INeedsRegistry.NeedStatus s) = registry.coreOf(id);
        if (s != INeedsRegistry.NeedStatus.Funded && s != INeedsRegistry.NeedStatus.InDelivery) {
            revert Errors.InvalidNeedStatus();
        }
        if (!roles.isActiveNgo(ngo)) revert Errors.NgoInactive();
        payout = roles.payoutOf(ngo);

        amount = t.amount;
        t.status = TrancheStatus.Released;
        _totalReleased += uint128(amount);

        // Tranche 0 (pre-financing) starts the delivery phase; the final tranche completes the need.
        if (index == 0) registry.setStatus(id, INeedsRegistry.NeedStatus.InDelivery);
        if (index == _trancheCount - 1) _completeFinalRelease(id);
    }

    /// @dev Releasing the final tranche completes the need. A vault defers this until the tranche has actually
    ///      been paid out: money it could not hand to a payee is money the need still owes.
    function _completeFinalRelease(uint256 id) internal virtual {
        registry.setStatus(id, INeedsRegistry.NeedStatus.Completed);
    }

    /// @dev True once every tranche has been released (and there is at least one, i.e. funding closed).
    function _allTranchesReleased() internal view returns (bool) {
        uint256 count = _trancheCount;
        if (count == 0) return false;
        for (uint256 i; i < count; ++i) {
            if (_tranches[i].status != TrancheStatus.Released) return false;
        }
        return true;
    }

    /// @dev Checks a new contribution against the need's live funding terms and returns the target.
    function _checkFunding(uint256 id, uint256 amount) internal view returns (uint256 target) {
        if (amount == 0) revert Errors.ZeroAmount();
        (address ngo, uint256 target_,, bool open) = registry.fundingTermsOf(id);
        if (_fundingClosed || !open) revert Errors.FundingNotOpen();
        // A suspended NGO cannot receive a release, so accepting more money would only trap it.
        if (!roles.isActiveNgo(ngo)) revert Errors.NgoInactive();
        if (_totalDonated + amount > target_) revert Errors.ExceedsTarget();
        return target_;
    }

    function _requireNotPaused() internal view {
        if (roles.paused()) revert Errors.SystemPaused();
    }
}
