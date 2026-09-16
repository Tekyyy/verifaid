// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {RoleAware} from "../access/RoleAware.sol";
import {IBeneficiaryGroups} from "../interfaces/IBeneficiaryGroups.sol";
import {IDeliveryManager} from "../interfaces/IDeliveryManager.sol";
import {INeedsRegistry} from "../interfaces/INeedsRegistry.sol";
import {IRoleRegistry} from "../interfaces/IRoleRegistry.sol";
import {ITrancheLedger} from "../interfaces/ITrancheLedger.sol";
import {Errors} from "../libraries/Errors.sol";
import {ISemaphore} from "@semaphore-protocol/contracts/interfaces/ISemaphore.sol";

/// @title DeliveryManager
/// @notice Unlocks tranches only after three independent signals agree:
///         (1) field evidence attested by the NGO's field agent,
///         (2) anonymous Semaphore receipt confirmations from enrolled beneficiaries,
///         (3) an approving attestation from a verifier independent of the NGO,
///         followed by a challenge window. Works identically for custodial and non-custodial needs.
contract DeliveryManager is IDeliveryManager, RoleAware {
    uint16 public constant BPS_DENOMINATOR = 10_000;

    /// @notice Hard floor under the configurable `minExpectedRecipients`, so no deployment can silently switch
    ///         off the protection that stops a confirmation count from identifying individuals (spec §8.2).
    uint32 public constant ABSOLUTE_MIN_RECIPIENTS = 5;

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

    address public resolver;
    bool public wired;

    /// @inheritdoc IDeliveryManager
    uint256 public deliveryCount;
    /// @inheritdoc IDeliveryManager
    mapping(uint256 => mapping(uint256 => uint256)) public activeDeliveryOf;
    /// @inheritdoc IDeliveryManager
    mapping(uint256 => uint256) public lastFinalizedDeliveryOf;
    /// @notice deliveryId => verifier => already challenged (one challenge per verifier per delivery).
    mapping(uint256 => mapping(address => bool)) public hasChallenged;

    /// @notice needId => trancheIndex => verifier => already rejected an attempt at this tranche.
    /// @dev Rejection is terminal for a delivery and needs no admin, so without this a single verifier could
    ///      reject every retry of a tranche forever — a cheaper veto than the rate-limited challenge path.
    mapping(uint256 => mapping(uint256 => mapping(address => bool))) public hasRejectedTranche;

    /// @dev Packed into five slots. `programId` is cached at open so confirmations never ask the registry for it.
    struct DeliveryRecord {
        // slot 0
        address fieldAgent;
        uint32 expectedRecipients;
        uint32 confirmations;
        uint8 trancheIndex;
        DeliveryStatus status;
        // slot 1
        address verifier;
        uint40 challengeDeadline;
        // slot 2
        uint128 needId;
        uint128 programId;
        // slots 3-4
        bytes32 evidenceAttestationUID;
        bytes32 verifierAttestationUID;
    }

    mapping(uint256 => DeliveryRecord) private _deliveries;

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
        if (minExpectedRecipients_ < ABSOLUTE_MIN_RECIPIENTS) revert Errors.InvalidParameter();
        if (challengePeriod_ > type(uint32).max) revert Errors.InvalidParameter();
        registry = registry_;
        beneficiaryGroups = beneficiaryGroups_;
        confirmationThresholdBps = confirmationThresholdBps_;
        challengePeriod = challengePeriod_;
        minExpectedRecipients = minExpectedRecipients_;
    }

    /// @notice One-time wiring of the attestation resolver. Admin only.
    function wire(address resolver_) external onlyAdmin {
        if (wired) revert Errors.AlreadyWired();
        if (resolver_ == address(0)) revert Errors.ZeroAddress();
        wired = true;
        resolver = resolver_;
        emit Wired(resolver_);
    }

    // ─── field agent ───────────────────────────────────────────────────────────

    /// @inheritdoc IDeliveryManager
    function openDelivery(uint256 needId, uint256 trancheIndex, uint32 expectedRecipients)
        external
        whenNotPaused
        returns (uint256 deliveryId)
    {
        if (!wired) revert Errors.NotWired();
        (address ngo, address vault, uint256 programId, INeedsRegistry.NeedStatus status) = registry.coreOf(needId);
        if (!roles.isFieldAgentOf(msg.sender, ngo)) revert Errors.Unauthorized();
        if (!roles.isActiveNgo(ngo)) revert Errors.NgoInactive();
        if (status != INeedsRegistry.NeedStatus.InDelivery) revert Errors.InvalidNeedStatus();

        ITrancheLedger ledger = ITrancheLedger(vault);
        if (trancheIndex == 0 || trancheIndex >= ledger.trancheCount()) revert Errors.InvalidTrancheIndex();
        if (ledger.trancheStatus(trancheIndex - 1) != ITrancheLedger.TrancheStatus.Released) {
            revert Errors.PreviousTrancheNotReleased();
        }
        if (ledger.trancheStatus(trancheIndex) != ITrancheLedger.TrancheStatus.Locked) {
            revert Errors.InvalidTrancheStatus();
        }

        uint256 current = activeDeliveryOf[needId][trancheIndex];
        if (current != 0 && _deliveries[current].status != DeliveryStatus.Rejected) {
            revert Errors.DeliveryAlreadyActive();
        }
        if (expectedRecipients < minExpectedRecipients) revert Errors.TooFewRecipients();
        if (expectedRecipients > beneficiaryGroups.memberCount(programId)) revert Errors.TooManyRecipients();

        deliveryId = ++deliveryCount;
        DeliveryRecord storage d = _deliveries[deliveryId];
        d.fieldAgent = msg.sender;
        d.expectedRecipients = expectedRecipients;
        d.trancheIndex = uint8(trancheIndex); // < MAX_TRANCHES
        d.needId = uint128(needId);
        d.programId = uint128(programId);
        // status is Open (the zero value)
        activeDeliveryOf[needId][trancheIndex] = deliveryId;

        emit DeliveryOpened(deliveryId, needId, trancheIndex, msg.sender, expectedRecipients);
    }

    /// @inheritdoc IDeliveryManager
    function onEvidenceAttested(uint256 deliveryId, bytes32 uid) external whenNotPaused {
        if (msg.sender != resolver || msg.sender == address(0)) revert Errors.Unauthorized();
        if (uid == bytes32(0)) revert Errors.InvalidParameter();
        DeliveryRecord storage d = _delivery(deliveryId);
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
        DeliveryRecord storage d = _confirmable(deliveryId, 1);
        uint32 count = ++d.confirmations; // effects before the proof check's external call
        _validate(deliveryId, d.programId, proof, count);
        _tryAdvance(deliveryId, d);
    }

    /// @inheritdoc IDeliveryManager
    function confirmReceiptBatch(uint256 deliveryId, ISemaphore.SemaphoreProof[] calldata proofs)
        external
        whenNotPaused
    {
        uint256 len = proofs.length;
        if (len == 0) revert Errors.InvalidParameter();
        DeliveryRecord storage d = _confirmable(deliveryId, len);
        uint256 programId = d.programId;
        uint32 count = d.confirmations;
        d.confirmations = count + uint32(len); // bounded by expectedRecipients in _confirmable
        for (uint256 i; i < len; ++i) {
            _validate(deliveryId, programId, proofs[i], ++count);
        }
        _tryAdvance(deliveryId, d);
    }

    // ─── verifiers ─────────────────────────────────────────────────────────────

    /// @inheritdoc IDeliveryManager
    function onDeliveryVerified(uint256 deliveryId, address verifier, bool approved, bytes32 uid)
        external
        whenNotPaused
    {
        if (msg.sender != resolver || msg.sender == address(0)) revert Errors.Unauthorized();
        if (uid == bytes32(0)) revert Errors.InvalidParameter();
        DeliveryRecord storage d = _delivery(deliveryId);
        if (d.status != DeliveryStatus.Open) revert Errors.InvalidDeliveryStatus();
        if (d.evidenceAttestationUID == bytes32(0)) revert Errors.EvidenceMissing();
        if (d.verifierAttestationUID != bytes32(0)) revert Errors.VerificationAlreadyLinked();
        address ngo = _requireInDelivery(d.needId);
        if (!roles.isIndependent(verifier, ngo)) revert Errors.NotIndependent();

        // One rejection per verifier per tranche: a rejection is immediate and terminal, so an unbounded veto
        // would let any independent verifier stall an NGO's tranche indefinitely by rejecting every retry.
        if (!approved) {
            if (hasRejectedTranche[d.needId][d.trancheIndex][verifier]) revert Errors.AlreadyRejected();
            hasRejectedTranche[d.needId][d.trancheIndex][verifier] = true;
        }

        d.verifierAttestationUID = uid;
        d.verifier = verifier;
        emit DeliveryVerifiedLinked(deliveryId, uid, verifier, approved);

        if (approved) _tryAdvance(deliveryId, d);
        else _reject(deliveryId, d);
    }

    /// @inheritdoc IDeliveryManager
    /// @dev Deliberately not pausable: challenging only ever makes the system safer.
    function challenge(uint256 deliveryId, bytes32 reasonHash) external {
        DeliveryRecord storage d = _delivery(deliveryId);
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
        DeliveryRecord storage d = _delivery(deliveryId);
        if (d.status != DeliveryStatus.Open) revert Errors.InvalidDeliveryStatus();
        emit DeliveryCancelled(deliveryId, msg.sender);
        _reject(deliveryId, d);
    }

    /// @inheritdoc IDeliveryManager
    function resolveDispute(uint256 deliveryId, bool uphold) external onlyAdmin {
        DeliveryRecord storage d = _delivery(deliveryId);
        if (d.status != DeliveryStatus.Disputed) revert Errors.InvalidDeliveryStatus();
        emit DisputeResolved(deliveryId, uphold);
        if (uphold) _reject(deliveryId, d);
        else _startChallengePeriod(deliveryId, d);
    }

    // ─── anyone ────────────────────────────────────────────────────────────────

    /// @inheritdoc IDeliveryManager
    function finalize(uint256 deliveryId) external whenNotPaused {
        DeliveryRecord storage d = _delivery(deliveryId);
        if (d.status != DeliveryStatus.Challengeable) revert Errors.InvalidDeliveryStatus();
        if (block.timestamp < d.challengeDeadline) revert Errors.ChallengePeriodActive();
        uint256 needId = d.needId;
        (, address vault,, INeedsRegistry.NeedStatus status) = registry.coreOf(needId);
        if (status != INeedsRegistry.NeedStatus.InDelivery) revert Errors.InvalidNeedStatus();

        d.status = DeliveryStatus.Finalized;
        lastFinalizedDeliveryOf[needId] = deliveryId;
        emit DeliveryFinalized(deliveryId, needId, d.trancheIndex);

        ITrancheLedger(vault).markReleasable(d.trancheIndex, deliveryId);
    }

    // ─── views ─────────────────────────────────────────────────────────────────

    /// @inheritdoc IDeliveryManager
    function getDelivery(uint256 deliveryId) external view returns (Delivery memory) {
        DeliveryRecord storage d = _delivery(deliveryId);
        return Delivery({
            id: deliveryId,
            needId: d.needId,
            trancheIndex: d.trancheIndex,
            fieldAgent: d.fieldAgent,
            expectedRecipients: d.expectedRecipients,
            confirmations: d.confirmations,
            evidenceAttestationUID: d.evidenceAttestationUID,
            verifierAttestationUID: d.verifierAttestationUID,
            verifier: d.verifier,
            challengeDeadline: d.challengeDeadline,
            status: d.status
        });
    }

    /// @notice Confirmations still needed before the delivery can become challengeable (0 when reached).
    function confirmationsNeeded(uint256 deliveryId) external view returns (uint256) {
        DeliveryRecord storage d = _delivery(deliveryId);
        uint256 required = _requiredConfirmations(d.expectedRecipients);
        return d.confirmations >= required ? 0 : required - d.confirmations;
    }

    // ─── internal ──────────────────────────────────────────────────────────────

    /// @dev Checks that `count` more confirmations may be submitted right now.
    function _confirmable(uint256 deliveryId, uint256 count) internal view returns (DeliveryRecord storage d) {
        d = _delivery(deliveryId);
        if (d.status != DeliveryStatus.Open) revert Errors.InvalidDeliveryStatus();
        if (d.evidenceAttestationUID == bytes32(0)) revert Errors.EvidenceMissing();
        if (uint256(d.confirmations) + count > d.expectedRecipients) revert Errors.TooManyConfirmations();
        _requireInDelivery(d.needId);
    }

    /// @dev Scope and message are checked here; Semaphore reverts on invalid proofs and reused nullifiers.
    function _validate(uint256 deliveryId, uint256 programId, ISemaphore.SemaphoreProof calldata proof, uint32 count)
        internal
    {
        if (proof.scope != deliveryId) revert Errors.InvalidScope();
        if (proof.message != AID_RECEIVED_MESSAGE) revert Errors.InvalidMessage();
        beneficiaryGroups.validateProof(programId, proof);
        emit ReceiptConfirmed(deliveryId, proof.nullifier, count);
    }

    /// @dev Moves an Open delivery to Challengeable once evidence, confirmations and an independent approval exist.
    function _tryAdvance(uint256 deliveryId, DeliveryRecord storage d) internal {
        if (d.status != DeliveryStatus.Open) return;
        if (d.evidenceAttestationUID == bytes32(0) || d.verifierAttestationUID == bytes32(0)) return;
        if (uint256(d.confirmations) * BPS_DENOMINATOR < uint256(d.expectedRecipients) * confirmationThresholdBps) {
            return;
        }
        if (!roles.isIndependent(d.verifier, registry.ngoOf(d.needId))) return;
        _startChallengePeriod(deliveryId, d);
    }

    function _startChallengePeriod(uint256 deliveryId, DeliveryRecord storage d) internal {
        d.status = DeliveryStatus.Challengeable;
        uint40 deadline = uint40(block.timestamp + challengePeriod);
        d.challengeDeadline = deadline;
        emit DeliveryChallengeable(deliveryId, deadline);
    }

    function _reject(uint256 deliveryId, DeliveryRecord storage d) internal {
        d.status = DeliveryStatus.Rejected;
        emit DeliveryRejected(deliveryId, d.needId, d.trancheIndex);
    }

    function _requiredConfirmations(uint32 expectedRecipients) internal view returns (uint256) {
        uint256 numerator = uint256(expectedRecipients) * confirmationThresholdBps;
        return (numerator + BPS_DENOMINATOR - 1) / BPS_DENOMINATOR; // ceil
    }

    /// @dev Reverts unless the need is in delivery; returns its NGO.
    function _requireInDelivery(uint256 needId) internal view returns (address ngo) {
        INeedsRegistry.NeedStatus status;
        (ngo,,, status) = registry.coreOf(needId);
        if (status != INeedsRegistry.NeedStatus.InDelivery) revert Errors.InvalidNeedStatus();
    }

    function _delivery(uint256 deliveryId) internal view returns (DeliveryRecord storage d) {
        d = _deliveries[deliveryId];
        if (d.fieldAgent == address(0)) revert Errors.DeliveryNotFound();
    }
}
