// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {RoleAware} from "../access/RoleAware.sol";
import {IAidVault} from "../interfaces/IAidVault.sol";
import {IBeneficiaryGroups} from "../interfaces/IBeneficiaryGroups.sol";
import {IDeliveryManager} from "../interfaces/IDeliveryManager.sol";
import {INeedsRegistry} from "../interfaces/INeedsRegistry.sol";
import {IRoleRegistry} from "../interfaces/IRoleRegistry.sol";
import {Errors} from "../libraries/Errors.sol";
import {ISemaphore} from "@semaphore-protocol/contracts/interfaces/ISemaphore.sol";

/// @title DeliveryManager
/// @notice Unlocks tranches only after three independent signals agree:
///         (1) field evidence attested by the NGO's field agent,
///         (2) anonymous Semaphore receipt confirmations from enrolled beneficiaries,
///         (3) an approving attestation from a verifier independent of the NGO,
///         followed by a challenge window.
contract DeliveryManager is IDeliveryManager, RoleAware {
    uint16 public constant BPS_DENOMINATOR = 10_000;

    /// @notice Semaphore message every beneficiary signs: "I received this aid".
    uint256 public constant AID_RECEIVED_MESSAGE = uint256(keccak256("AID_RECEIVED"));

    INeedsRegistry public immutable registry;
    IBeneficiaryGroups public immutable beneficiaryGroups;

    /// @notice Share of expected recipients that must confirm, in basis points (e.g. 7000 = 70%).
    uint16 public immutable confirmationThresholdBps;
    /// @notice Seconds verifiers have to challenge before a delivery can be finalized.
    uint64 public immutable challengePeriod;
    /// @notice Minimum `expectedRecipients` per delivery, so small counts cannot de-anonymize beneficiaries.
    uint32 public immutable minExpectedRecipients;

    address public evidenceResolver;
    address public verifiedResolver;
    bool public wired;

    /// @inheritdoc IDeliveryManager
    uint256 public deliveryCount;
    /// @inheritdoc IDeliveryManager
    mapping(uint256 => mapping(uint256 => uint256)) public activeDeliveryOf;
    /// @inheritdoc IDeliveryManager
    mapping(uint256 => uint256) public lastFinalizedDeliveryOf;
    /// @notice deliveryId => verifier => already challenged (one challenge per verifier per delivery).
    mapping(uint256 => mapping(address => bool)) public hasChallenged;

    mapping(uint256 => Delivery) private _deliveries;

    constructor(
        IRoleRegistry roles_,
        INeedsRegistry registry_,
        IBeneficiaryGroups beneficiaryGroups_,
        uint16 confirmationThresholdBps_,
        uint64 challengePeriod_,
        uint32 minExpectedRecipients_
    ) RoleAware(roles_) {
        if (address(registry_) == address(0) || address(beneficiaryGroups_) == address(0)) {
            revert Errors.ZeroAddress();
        }
        if (confirmationThresholdBps_ == 0 || confirmationThresholdBps_ > BPS_DENOMINATOR) {
            revert Errors.InvalidParameter();
        }
        if (minExpectedRecipients_ == 0) revert Errors.InvalidParameter();
        registry = registry_;
        beneficiaryGroups = beneficiaryGroups_;
        confirmationThresholdBps = confirmationThresholdBps_;
        challengePeriod = challengePeriod_;
        minExpectedRecipients = minExpectedRecipients_;
    }

    /// @notice One-time wiring of the attestation resolvers. Admin only.
    function wire(address evidenceResolver_, address verifiedResolver_) external onlyAdmin {
        if (wired) revert Errors.AlreadyWired();
        if (evidenceResolver_ == address(0) || verifiedResolver_ == address(0)) revert Errors.ZeroAddress();
        wired = true;
        evidenceResolver = evidenceResolver_;
        verifiedResolver = verifiedResolver_;
        emit Wired(evidenceResolver_, verifiedResolver_);
    }

    // ─── field agent ───────────────────────────────────────────────────────────

    /// @inheritdoc IDeliveryManager
    function openDelivery(uint256 needId, uint256 trancheIndex, uint32 expectedRecipients)
        external
        whenNotPaused
        returns (uint256 deliveryId)
    {
        if (!wired) revert Errors.NotWired();
        address ngo = registry.ngoOf(needId);
        if (!roles.isFieldAgentOf(msg.sender, ngo)) revert Errors.Unauthorized();
        if (!roles.isActiveNgo(ngo)) revert Errors.NgoInactive();
        _requireInDelivery(needId);

        IAidVault vault = IAidVault(registry.vaultOf(needId));
        if (trancheIndex == 0 || trancheIndex >= vault.trancheCount()) revert Errors.InvalidTrancheIndex();
        if (vault.trancheStatus(trancheIndex - 1) != IAidVault.TrancheStatus.Released) {
            revert Errors.PreviousTrancheNotReleased();
        }
        if (vault.trancheStatus(trancheIndex) != IAidVault.TrancheStatus.Locked) revert Errors.InvalidTrancheStatus();

        uint256 current = activeDeliveryOf[needId][trancheIndex];
        if (current != 0 && _deliveries[current].status != DeliveryStatus.Rejected) {
            revert Errors.DeliveryAlreadyActive();
        }
        if (expectedRecipients < minExpectedRecipients) revert Errors.TooFewRecipients();
        if (expectedRecipients > beneficiaryGroups.memberCount(registry.programOf(needId))) {
            revert Errors.TooManyRecipients();
        }

        deliveryId = ++deliveryCount;
        Delivery storage d = _deliveries[deliveryId];
        d.id = deliveryId;
        d.needId = needId;
        d.trancheIndex = trancheIndex;
        d.fieldAgent = msg.sender;
        d.expectedRecipients = expectedRecipients;
        d.status = DeliveryStatus.Open;
        activeDeliveryOf[needId][trancheIndex] = deliveryId;

        emit DeliveryOpened(deliveryId, needId, trancheIndex, msg.sender, expectedRecipients);
    }

    /// @inheritdoc IDeliveryManager
    function onEvidenceAttested(uint256 deliveryId, bytes32 uid) external whenNotPaused {
        if (msg.sender != evidenceResolver || msg.sender == address(0)) revert Errors.Unauthorized();
        if (uid == bytes32(0)) revert Errors.InvalidParameter();
        Delivery storage d = _delivery(deliveryId);
        if (d.status != DeliveryStatus.Open) revert Errors.InvalidDeliveryStatus();
        if (d.evidenceAttestationUID != bytes32(0)) revert Errors.EvidenceAlreadyLinked();
        _requireInDelivery(d.needId);

        d.evidenceAttestationUID = uid;
        emit DeliveryEvidenceLinked(deliveryId, uid);
    }

    // ─── beneficiaries ─────────────────────────────────────────────────────────

    /// @inheritdoc IDeliveryManager
    /// @dev Stores and emits only the nullifier and the running count — never anything identifying the member.
    function confirmReceipt(uint256 deliveryId, ISemaphore.SemaphoreProof calldata proof) external whenNotPaused {
        Delivery storage d = _delivery(deliveryId);
        if (d.status != DeliveryStatus.Open) revert Errors.InvalidDeliveryStatus();
        if (d.evidenceAttestationUID == bytes32(0)) revert Errors.EvidenceMissing();
        if (proof.scope != deliveryId) revert Errors.InvalidScope();
        if (proof.message != AID_RECEIVED_MESSAGE) revert Errors.InvalidMessage();
        if (d.confirmations >= d.expectedRecipients) revert Errors.TooManyConfirmations();
        _requireInDelivery(d.needId);

        uint32 count = ++d.confirmations;
        // Semaphore reverts on invalid proofs and on nullifiers already used in this group.
        beneficiaryGroups.validateProof(registry.programOf(d.needId), proof);
        emit ReceiptConfirmed(deliveryId, proof.nullifier, count);

        _tryAdvance(d);
    }

    // ─── verifiers ─────────────────────────────────────────────────────────────

    /// @inheritdoc IDeliveryManager
    function onDeliveryVerified(uint256 deliveryId, address verifier, bool approved, bytes32 uid)
        external
        whenNotPaused
    {
        if (msg.sender != verifiedResolver || msg.sender == address(0)) revert Errors.Unauthorized();
        if (uid == bytes32(0)) revert Errors.InvalidParameter();
        Delivery storage d = _delivery(deliveryId);
        if (d.status != DeliveryStatus.Open) revert Errors.InvalidDeliveryStatus();
        if (d.evidenceAttestationUID == bytes32(0)) revert Errors.EvidenceMissing();
        if (d.verifierAttestationUID != bytes32(0)) revert Errors.VerificationAlreadyLinked();
        _requireInDelivery(d.needId);
        if (!roles.isIndependent(verifier, registry.ngoOf(d.needId))) revert Errors.NotIndependent();

        d.verifierAttestationUID = uid;
        d.verifier = verifier;
        emit DeliveryVerifiedLinked(deliveryId, uid, verifier, approved);

        if (approved) _tryAdvance(d);
        else _reject(d);
    }

    /// @inheritdoc IDeliveryManager
    /// @dev Deliberately not pausable: challenging only ever makes the system safer.
    function challenge(uint256 deliveryId, bytes32 reasonHash) external {
        Delivery storage d = _delivery(deliveryId);
        if (!roles.isIndependent(msg.sender, registry.ngoOf(d.needId))) revert Errors.NotIndependent();
        if (d.status != DeliveryStatus.Challengeable) revert Errors.InvalidDeliveryStatus();
        if (block.timestamp >= d.challengeDeadline) revert Errors.ChallengePeriodOver();
        if (reasonHash == bytes32(0)) revert Errors.InvalidParameter();
        if (hasChallenged[deliveryId][msg.sender]) revert Errors.AlreadyChallenged();

        hasChallenged[deliveryId][msg.sender] = true;
        d.status = DeliveryStatus.Disputed;
        emit DeliveryChallenged(deliveryId, msg.sender, reasonHash);
    }

    // ─── admin ─────────────────────────────────────────────────────────────────

    /// @inheritdoc IDeliveryManager
    /// @dev Escape hatch for a delivery that can never progress — typically one whose field agent disappeared
    ///      before filing evidence, which would otherwise block its tranche forever (a verifier cannot reject a
    ///      delivery that has no evidence to review). Restricted to the admin and to deliveries that are still
    ///      `Open`: an NGO could otherwise cancel deliveries whose confirmations are lagging and reopen them
    ///      with a smaller `expectedRecipients` to game the threshold.
    function cancelDelivery(uint256 deliveryId) external onlyAdmin {
        Delivery storage d = _delivery(deliveryId);
        if (d.status != DeliveryStatus.Open) revert Errors.InvalidDeliveryStatus();
        emit DeliveryCancelled(deliveryId, msg.sender);
        _reject(d);
    }

    /// @inheritdoc IDeliveryManager
    function resolveDispute(uint256 deliveryId, bool uphold) external onlyAdmin {
        Delivery storage d = _delivery(deliveryId);
        if (d.status != DeliveryStatus.Disputed) revert Errors.InvalidDeliveryStatus();
        emit DisputeResolved(deliveryId, uphold);
        if (uphold) _reject(d);
        else _startChallengePeriod(d);
    }

    // ─── anyone ────────────────────────────────────────────────────────────────

    /// @inheritdoc IDeliveryManager
    function finalize(uint256 deliveryId) external whenNotPaused {
        Delivery storage d = _delivery(deliveryId);
        if (d.status != DeliveryStatus.Challengeable) revert Errors.InvalidDeliveryStatus();
        if (block.timestamp < d.challengeDeadline) revert Errors.ChallengePeriodActive();
        _requireInDelivery(d.needId);

        d.status = DeliveryStatus.Finalized;
        lastFinalizedDeliveryOf[d.needId] = deliveryId;
        emit DeliveryFinalized(deliveryId, d.needId, d.trancheIndex);

        IAidVault(registry.vaultOf(d.needId)).markReleasable(d.trancheIndex, deliveryId);
    }

    // ─── views ─────────────────────────────────────────────────────────────────

    /// @inheritdoc IDeliveryManager
    function getDelivery(uint256 deliveryId) external view returns (Delivery memory) {
        return _delivery(deliveryId);
    }

    /// @notice Confirmations still needed before the delivery can become challengeable (0 when reached).
    function confirmationsNeeded(uint256 deliveryId) external view returns (uint256) {
        Delivery storage d = _delivery(deliveryId);
        uint256 required = _requiredConfirmations(d.expectedRecipients);
        return d.confirmations >= required ? 0 : required - d.confirmations;
    }

    // ─── internal ──────────────────────────────────────────────────────────────

    /// @dev Moves an Open delivery to Challengeable once evidence, confirmations and an independent approval exist.
    function _tryAdvance(Delivery storage d) internal {
        if (d.status != DeliveryStatus.Open) return;
        if (d.evidenceAttestationUID == bytes32(0) || d.verifierAttestationUID == bytes32(0)) return;
        if (uint256(d.confirmations) * BPS_DENOMINATOR < uint256(d.expectedRecipients) * confirmationThresholdBps) {
            return;
        }
        if (!roles.isIndependent(d.verifier, registry.ngoOf(d.needId))) return;
        _startChallengePeriod(d);
    }

    function _startChallengePeriod(Delivery storage d) internal {
        d.status = DeliveryStatus.Challengeable;
        d.challengeDeadline = uint64(block.timestamp) + challengePeriod;
        emit DeliveryChallengeable(d.id, d.challengeDeadline);
    }

    function _reject(Delivery storage d) internal {
        d.status = DeliveryStatus.Rejected;
        emit DeliveryRejected(d.id, d.needId, d.trancheIndex);
    }

    function _requiredConfirmations(uint32 expectedRecipients) internal view returns (uint256) {
        uint256 numerator = uint256(expectedRecipients) * confirmationThresholdBps;
        return (numerator + BPS_DENOMINATOR - 1) / BPS_DENOMINATOR; // ceil
    }

    function _requireInDelivery(uint256 needId) internal view {
        if (registry.statusOf(needId) != INeedsRegistry.NeedStatus.InDelivery) revert Errors.InvalidNeedStatus();
    }

    function _delivery(uint256 deliveryId) internal view returns (Delivery storage d) {
        d = _deliveries[deliveryId];
        if (d.id == 0) revert Errors.DeliveryNotFound();
    }
}
