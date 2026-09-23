// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {RoleAware} from "../access/RoleAware.sol";
import {IAidVault} from "../interfaces/IAidVault.sol";
import {IDeliveryManager} from "../interfaces/IDeliveryManager.sol";
import {INeedsRegistry} from "../interfaces/INeedsRegistry.sol";
import {IRoleRegistry} from "../interfaces/IRoleRegistry.sol";
import {ITrancheLedger} from "../interfaces/ITrancheLedger.sol";
import {Errors} from "../libraries/Errors.sol";

/// @title DeliveryManager
/// @notice Unlocks tranches after the first on the say-so of the people who paid for them.
///
///         Tranche 0 pre-finances the work and is releasable the moment funding closes. For every later tranche
///         the NGO first accounts for the money it was already paid: a manifest listing photos, receipts and bank
///         statements (each by content hash, so a file cannot be swapped afterwards) and a note. Donors to the need
///         read it and approve it; once donors who gave `approvalThresholdBps` of the raised amount have approved,
///         the tranche becomes releasable in the same transaction.
///
///         A donor's say weighs what they gave, so it cannot be inflated by splitting one gift across many wallets.
///         The NGO, its payout address and the need's payees are not donors for this purpose, however much they
///         gave: they cannot approve their own accounts.
contract DeliveryManager is IDeliveryManager, RoleAware {
    uint16 public constant BPS_DENOMINATOR = 10_000;

    /// @notice Upper bound on a manifest, so the event carrying it stays cheap to emit and to index.
    uint256 public constant MAX_MANIFEST_BYTES = 8192;

    INeedsRegistry public immutable registry;

    /// @inheritdoc IDeliveryManager
    uint16 public immutable approvalThresholdBps;

    /// @inheritdoc IDeliveryManager
    uint256 public deliveryCount;
    /// @inheritdoc IDeliveryManager
    mapping(uint256 => mapping(uint256 => uint256)) public activeDeliveryOf;
    /// @inheritdoc IDeliveryManager
    mapping(uint256 => uint256) public lastApprovedDeliveryOf;
    /// @inheritdoc IDeliveryManager
    mapping(uint256 => mapping(address => bool)) public hasApproved;

    /// @dev Four slots.
    struct DeliveryRecord {
        // slot 0
        address submitter;
        uint64 submittedAt;
        uint8 trancheIndex;
        DeliveryStatus status;
        // slot 1
        uint128 needId;
        uint64 approvedAt;
        // slots 2-3
        bytes32 evidenceHash;
        uint256 approvedAmount;
    }

    mapping(uint256 => DeliveryRecord) private _deliveries;

    constructor(IRoleRegistry roles_, INeedsRegistry registry_, uint16 approvalThresholdBps_) RoleAware(roles_) {
        if (address(registry_) == address(0)) revert Errors.ZeroAddress();
        if (approvalThresholdBps_ == 0 || approvalThresholdBps_ > BPS_DENOMINATOR) revert Errors.InvalidParameter();
        registry = registry_;
        approvalThresholdBps = approvalThresholdBps_;
    }

    // ─── NGO ───────────────────────────────────────────────────────────────────

    /// @inheritdoc IDeliveryManager
    function submitEvidence(uint256 needId, string calldata manifest)
        external
        whenNotPaused
        returns (uint256 deliveryId)
    {
        if (bytes(manifest).length == 0 || bytes(manifest).length > MAX_MANIFEST_BYTES) {
            revert Errors.InvalidParameter();
        }
        uint256 trancheIndex = _trancheForSubmitter(needId);
        bytes32 evidenceHash = keccak256(bytes(manifest));
        deliveryId = _record(needId, trancheIndex, evidenceHash);
        emit DeliverySubmitted(deliveryId, needId, trancheIndex, msg.sender, evidenceHash, manifest);
    }

    // ─── donors ────────────────────────────────────────────────────────────────

    /// @inheritdoc IDeliveryManager
    function approve(uint256 deliveryId) external whenNotPaused {
        DeliveryRecord storage d = _delivery(deliveryId);
        if (d.status != DeliveryStatus.Open) revert Errors.InvalidDeliveryStatus();
        uint256 needId = d.needId;
        (address ngo, address vault,, INeedsRegistry.NeedStatus status) = registry.coreOf(needId);
        if (status != INeedsRegistry.NeedStatus.InDelivery) revert Errors.InvalidNeedStatus();
        if (hasApproved[deliveryId][msg.sender]) revert Errors.AlreadyApproved();

        uint256 weight = _weight(needId, ngo, vault, msg.sender);
        if (weight == 0) revert Errors.NotADonor();

        hasApproved[deliveryId][msg.sender] = true;
        uint256 approved = d.approvedAmount + weight;
        d.approvedAmount = approved;
        uint256 required = _required(vault);
        emit DeliveryApprovalAdded(deliveryId, msg.sender, weight, approved, required);

        if (approved >= required) {
            d.status = DeliveryStatus.Approved;
            d.approvedAt = uint64(block.timestamp);
            lastApprovedDeliveryOf[needId] = deliveryId;
            emit DeliveryApproved(deliveryId, needId, d.trancheIndex);
            ITrancheLedger(vault).markReleasable(d.trancheIndex, deliveryId);
        }
    }

    // ─── views ─────────────────────────────────────────────────────────────────

    /// @inheritdoc IDeliveryManager
    function getDelivery(uint256 deliveryId) external view returns (Delivery memory) {
        DeliveryRecord storage d = _delivery(deliveryId);
        return Delivery({
            id: deliveryId,
            needId: d.needId,
            trancheIndex: d.trancheIndex,
            submitter: d.submitter,
            evidenceHash: d.evidenceHash,
            approvedAmount: d.approvedAmount,
            submittedAt: d.submittedAt,
            approvedAt: d.approvedAt,
            status: d.status
        });
    }

    /// @inheritdoc IDeliveryManager
    function requiredApproval(uint256 needId) external view returns (uint256) {
        (, address vault,,) = registry.coreOf(needId);
        if (vault == address(0) || !ITrancheLedger(vault).fundingClosed()) return 0;
        return _required(vault);
    }

    /// @inheritdoc IDeliveryManager
    function approvalWeight(uint256 needId, address donor) external view returns (uint256) {
        (address ngo, address vault,,) = registry.coreOf(needId);
        if (vault == address(0)) return 0;
        return _weight(needId, ngo, vault, donor);
    }

    // ─── internal ──────────────────────────────────────────────────────────────

    /// @dev Reverts unless the caller is the need's active NGO and the need is in delivery; returns the tranche.
    function _trancheForSubmitter(uint256 needId) internal view returns (uint256) {
        (address ngo, address vault,, INeedsRegistry.NeedStatus status) = registry.coreOf(needId);
        if (msg.sender != ngo) revert Errors.Unauthorized();
        if (!roles.isActiveNgo(ngo)) revert Errors.NgoInactive();
        if (status != INeedsRegistry.NeedStatus.InDelivery) revert Errors.InvalidNeedStatus();
        return _nextToUnlock(ITrancheLedger(vault));
    }

    /// @dev Stores a new Open delivery and retires the one it replaces: donors approved what they saw, so new
    ///      evidence starts from nothing.
    function _record(uint256 needId, uint256 trancheIndex, bytes32 evidenceHash) internal returns (uint256 deliveryId) {
        deliveryId = ++deliveryCount;
        DeliveryRecord storage d = _deliveries[deliveryId];
        d.submitter = msg.sender;
        d.submittedAt = uint64(block.timestamp);
        d.trancheIndex = uint8(trancheIndex); // < MAX_TRANCHES
        d.needId = uint128(needId);
        d.evidenceHash = evidenceHash;
        // status is Open (the zero value)

        uint256 previous = activeDeliveryOf[needId][trancheIndex];
        activeDeliveryOf[needId][trancheIndex] = deliveryId;
        if (previous != 0 && _deliveries[previous].status == DeliveryStatus.Open) {
            _deliveries[previous].status = DeliveryStatus.Superseded;
            emit DeliverySuperseded(previous, deliveryId);
        }
    }

    /// @dev The first locked tranche, provided the one before it has been paid: evidence accounts for money the
    ///      NGO already received, so a tranche still waiting to be released has nothing to account for yet.
    function _nextToUnlock(ITrancheLedger ledger) internal view returns (uint256) {
        uint256 count = ledger.trancheCount();
        for (uint256 index = 1; index < count; ++index) {
            if (ledger.trancheStatus(index) != ITrancheLedger.TrancheStatus.Locked) continue;
            if (ledger.trancheStatus(index - 1) != ITrancheLedger.TrancheStatus.Released) {
                revert Errors.PreviousTrancheNotReleased();
            }
            return index;
        }
        revert Errors.InvalidTrancheStatus();
    }

    /// @dev Rounded up, so "30%" never means a hair less than 30%.
    function _required(address vault) internal view returns (uint256) {
        uint256 raised = ITrancheLedger(vault).totalDonated();
        return (raised * approvalThresholdBps + BPS_DENOMINATOR - 1) / BPS_DENOMINATOR;
    }

    /// @dev Zero for anyone who would be approving their own accounts: the NGO, its payout address, and the need's
    ///      payees (a payee's account is where the money went).
    function _weight(uint256 needId, address ngo, address vault, address donor) internal view returns (uint256) {
        if (donor == address(0) || donor == ngo || donor == roles.payoutOf(ngo)) return 0;
        INeedsRegistry.PayeeShare[] memory payees = registry.payeesOf(needId);
        for (uint256 i; i < payees.length; ++i) {
            if (payees[i].account == donor) return 0;
        }
        return IAidVault(vault).donatedBy(donor);
    }

    function _delivery(uint256 deliveryId) internal view returns (DeliveryRecord storage d) {
        d = _deliveries[deliveryId];
        if (d.submitter == address(0)) revert Errors.DeliveryNotFound();
    }
}
