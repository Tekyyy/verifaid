// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {RoleAware} from "../access/RoleAware.sol";
import {IDeliveryManager} from "../interfaces/IDeliveryManager.sol";
import {INeedsRegistry} from "../interfaces/INeedsRegistry.sol";
import {IReleasePolicy} from "../interfaces/IReleasePolicy.sol";
import {IRoleRegistry} from "../interfaces/IRoleRegistry.sol";
import {ITrancheLedger} from "../interfaces/ITrancheLedger.sol";
import {Errors} from "../libraries/Errors.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";

/// @title DeliveryManager
/// @notice Unlocks tranches after the first once the NGO has accounted for the money it was already paid, and that
///         account has been judged under the need's release policy.
///
///         Tranche 0 pre-finances the work and is releasable the moment funding closes. For every later tranche
///         the NGO files a manifest listing photos, receipts and bank statements (each by content hash, so a file
///         cannot be swapped afterwards) and a note. The people the need's policy gives a say — its donors, weighted
///         by what they gave, independent verifiers, or both — approve or reject it here:
///         - enough approval makes the tranche releasable in the same transaction;
///         - enough rejection sends the NGO back to try again, `retries` times; the rejection after that cancels
///           the need, and donors can claim back everything that was not yet released.
///
///         This contract is the ballot box and the evidence log; the rule itself lives in the policy, which the
///         need chose when it was created and cannot change.
contract DeliveryManager is IDeliveryManager, RoleAware, EIP712 {
    /// @notice Upper bound on a manifest, so the event carrying it stays cheap to emit and to index.
    uint256 public constant MAX_MANIFEST_BYTES = 8192;

    bytes32 public constant VOTE_TYPEHASH =
        keccak256("Vote(address voter,uint256 deliveryId,bool approve,uint256 deadline)");

    INeedsRegistry public immutable registry;

    /// @inheritdoc IDeliveryManager
    uint256 public deliveryCount;
    /// @inheritdoc IDeliveryManager
    mapping(uint256 => mapping(uint256 => uint256)) public activeDeliveryOf;
    /// @inheritdoc IDeliveryManager
    mapping(uint256 => uint256) public lastApprovedDeliveryOf;
    /// @inheritdoc IDeliveryManager
    mapping(uint256 => mapping(address => bool)) public hasVoted;
    /// @inheritdoc IDeliveryManager
    mapping(uint256 => uint8) public strikesOf;

    /// @dev Four slots.
    struct DeliveryRecord {
        // slot 0
        address submitter;
        uint64 submittedAt;
        uint8 trancheIndex;
        DeliveryStatus status;
        uint8 verifierApprovals;
        uint8 verifierRejections;
        // slot 1
        uint128 needId;
        uint64 decidedAt;
        // slot 2
        bytes32 evidenceHash;
        // slot 3 — sums of donations, each at most the need's uint128 total
        uint128 approvedAmount;
        uint128 rejectedAmount;
    }

    mapping(uint256 => DeliveryRecord) private _deliveries;

    constructor(IRoleRegistry roles_, INeedsRegistry registry_) RoleAware(roles_) EIP712("VerifAid Deliveries", "1") {
        if (address(registry_) == address(0)) revert Errors.ZeroAddress();
        registry = registry_;
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

    // ─── voters ────────────────────────────────────────────────────────────────

    /// @inheritdoc IDeliveryManager
    function approve(uint256 deliveryId) external whenNotPaused {
        _vote(deliveryId, msg.sender, true);
    }

    /// @inheritdoc IDeliveryManager
    function reject(uint256 deliveryId) external whenNotPaused {
        _vote(deliveryId, msg.sender, false);
    }

    /// @inheritdoc IDeliveryManager
    /// @dev No nonce: a voter votes once per delivery, so a signature can only ever be used once, and the deadline
    ///      keeps a signature collected long ago from being played in later.
    function voteBySig(uint256 deliveryId, address voter, bool approve_, uint256 deadline, bytes calldata signature)
        external
        whenNotPaused
    {
        if (block.timestamp > deadline) revert Errors.SignatureExpired();
        bytes32 digest = voteDigest(deliveryId, voter, approve_, deadline);
        if (!SignatureChecker.isValidSignatureNow(voter, digest, signature)) revert Errors.InvalidSignature();
        _vote(deliveryId, voter, approve_);
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
            rejectedAmount: d.rejectedAmount,
            verifierApprovals: d.verifierApprovals,
            verifierRejections: d.verifierRejections,
            submittedAt: d.submittedAt,
            decidedAt: d.decidedAt,
            status: d.status
        });
    }

    /// @inheritdoc IDeliveryManager
    function policyOf(uint256 needId) public view returns (IReleasePolicy) {
        return IReleasePolicy(registry.releasePolicyOf(needId));
    }

    /// @inheritdoc IDeliveryManager
    function rulesOf(uint256 needId) external view returns (IReleasePolicy.Rules memory rules) {
        address vault = registry.vaultOf(needId);
        if (vault == address(0) || !ITrancheLedger(vault).fundingClosed()) return rules;
        return policyOf(needId).rulesOf(needId);
    }

    /// @inheritdoc IDeliveryManager
    function voiceOf(uint256 needId, address voter) external view returns (IReleasePolicy.Voice, uint256) {
        return policyOf(needId).voiceOf(needId, voter);
    }

    /// @inheritdoc IDeliveryManager
    function voteDigest(uint256 deliveryId, address voter, bool approve_, uint256 deadline)
        public
        view
        returns (bytes32)
    {
        return _hashTypedDataV4(keccak256(abi.encode(VOTE_TYPEHASH, voter, deliveryId, approve_, deadline)));
    }

    /// @notice The EIP-712 domain separator votes are signed under.
    // forge-lint: disable-next-line(mixed-case-function)
    function DOMAIN_SEPARATOR() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    // ─── internal: voting ──────────────────────────────────────────────────────

    function _vote(uint256 deliveryId, address voter, bool approve_) internal {
        DeliveryRecord storage d = _delivery(deliveryId);
        if (d.status != DeliveryStatus.Open) revert Errors.InvalidDeliveryStatus();
        uint256 needId = d.needId;
        if (registry.statusOf(needId) != INeedsRegistry.NeedStatus.InDelivery) revert Errors.InvalidNeedStatus();
        if (hasVoted[deliveryId][voter]) revert Errors.AlreadyVoted();

        IReleasePolicy policy = policyOf(needId);
        (IReleasePolicy.Voice voice, uint256 weight) = policy.voiceOf(needId, voter);
        if (voice == IReleasePolicy.Voice.None || weight == 0) revert Errors.NoSay();

        hasVoted[deliveryId][voter] = true;
        _tally(d, voice, approve_, weight);
        emit VoteCast(deliveryId, voter, voice, approve_, weight);

        IReleasePolicy.Rules memory rules = policy.rulesOf(needId);
        if (approve_) {
            if (_isApproved(d, rules)) _approveDelivery(deliveryId, d);
        } else if (_isRejected(d, rules)) {
            _rejectDelivery(deliveryId, d, rules.retries);
        }
    }

    function _tally(DeliveryRecord storage d, IReleasePolicy.Voice voice, bool approve_, uint256 weight) internal {
        if (voice == IReleasePolicy.Voice.Verifier) {
            if (approve_) ++d.verifierApprovals;
            else ++d.verifierRejections;
        } else if (approve_) {
            d.approvedAmount += uint128(weight);
        } else {
            d.rejectedAmount += uint128(weight);
        }
    }

    /// @dev Every voice the policy gives a say must have approved, and at least one voice must exist.
    function _isApproved(DeliveryRecord storage d, IReleasePolicy.Rules memory r) internal view returns (bool) {
        if (r.donorApproval == 0 && r.verifierApproval == 0) revert Errors.InvalidReleasePolicy();
        if (r.donorApproval != 0 && d.approvedAmount < r.donorApproval) return false;
        if (r.verifierApproval != 0 && d.verifierApprovals < r.verifierApproval) return false;
        return true;
    }

    /// @dev Any voice the policy gives a say can reject on its own.
    function _isRejected(DeliveryRecord storage d, IReleasePolicy.Rules memory r) internal view returns (bool) {
        return (r.donorRejection != 0 && d.rejectedAmount >= r.donorRejection)
            || (r.verifierRejection != 0 && d.verifierRejections >= r.verifierRejection);
    }

    function _approveDelivery(uint256 deliveryId, DeliveryRecord storage d) internal {
        uint256 needId = d.needId;
        d.status = DeliveryStatus.Approved;
        d.decidedAt = uint64(block.timestamp);
        lastApprovedDeliveryOf[needId] = deliveryId;
        emit DeliveryApproved(deliveryId, needId, d.trancheIndex);
        ITrancheLedger(registry.vaultOf(needId)).markReleasable(d.trancheIndex, deliveryId);
    }

    /// @dev The NGO may try again while it has retries left; past them, the need is cancelled and donors can claim
    ///      back what was not released. Nothing is releasable at this point — evidence is only filed once the
    ///      previous tranche has been paid — so cancelling strands no payee.
    function _rejectDelivery(uint256 deliveryId, DeliveryRecord storage d, uint8 retries) internal {
        uint256 needId = d.needId;
        d.status = DeliveryStatus.Rejected;
        d.decidedAt = uint64(block.timestamp);
        uint8 strikes = ++strikesOf[needId];
        bool cancel = strikes > retries;
        emit DeliveryRejected(deliveryId, needId, d.trancheIndex, strikes, cancel);
        if (cancel) registry.onEvidenceRejected(needId);
    }

    // ─── internal: evidence ────────────────────────────────────────────────────

    /// @dev Reverts unless the caller runs the need (its NGO, or the beneficiary who posted it), the need's NGO is
    ///      active and the need is in delivery; returns the tranche.
    function _trancheForSubmitter(uint256 needId) internal view returns (uint256) {
        (address ngo, address vault,, INeedsRegistry.NeedStatus status) = registry.coreOf(needId);
        if (msg.sender != registry.ownerOf(needId)) revert Errors.Unauthorized();
        if (!roles.isActiveNgo(ngo)) revert Errors.NgoInactive();
        if (status != INeedsRegistry.NeedStatus.InDelivery) revert Errors.InvalidNeedStatus();
        return _nextToUnlock(ITrancheLedger(vault));
    }

    /// @dev Stores a new Open delivery and retires the one it replaces: people voted on what they saw, so new
    ///      evidence starts from nothing. Replacing evidence someone already rejected is a strike, like a
    ///      rejection, and is refused once the need has no retries left — otherwise withdrawing a losing account
    ///      just before the rejection lands would be a way to never be rejected at all.
    function _record(uint256 needId, uint256 trancheIndex, bytes32 evidenceHash) internal returns (uint256 deliveryId) {
        uint256 previous = activeDeliveryOf[needId][trancheIndex];
        deliveryId = ++deliveryCount;

        if (previous != 0 && _deliveries[previous].status == DeliveryStatus.Open) {
            DeliveryRecord storage old = _deliveries[previous];
            bool contested = old.rejectedAmount != 0 || old.verifierRejections != 0;
            uint8 strikes = strikesOf[needId];
            if (contested) {
                if (strikes >= policyOf(needId).rulesOf(needId).retries) revert Errors.EvidenceContested();
                strikesOf[needId] = ++strikes;
            }
            old.status = DeliveryStatus.Superseded;
            emit DeliverySuperseded(previous, deliveryId, contested, strikes);
        }

        DeliveryRecord storage d = _deliveries[deliveryId];
        d.submitter = msg.sender;
        d.submittedAt = uint64(block.timestamp);
        d.trancheIndex = uint8(trancheIndex); // < MAX_TRANCHES
        d.needId = uint128(needId);
        d.evidenceHash = evidenceHash;
        // status is Open (the zero value)
        activeDeliveryOf[needId][trancheIndex] = deliveryId;
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

    function _delivery(uint256 deliveryId) internal view returns (DeliveryRecord storage d) {
        d = _deliveries[deliveryId];
        if (d.submitter == address(0)) revert Errors.DeliveryNotFound();
    }
}
