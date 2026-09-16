// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ISemaphore} from "@semaphore-protocol/contracts/interfaces/ISemaphore.sol";

/// @title IDeliveryManager
/// @notice Ties deliveries to tranches using field evidence, anonymous beneficiary confirmations and verifier sign-off.
interface IDeliveryManager {
    enum DeliveryStatus {
        Open,
        Challengeable,
        Disputed,
        Finalized,
        Rejected
    }

    struct Delivery {
        uint256 id;
        uint256 needId;
        uint256 trancheIndex; // tranche this delivery unlocks (>= 1)
        address fieldAgent;
        uint32 expectedRecipients;
        uint32 confirmations;
        bytes32 evidenceAttestationUID;
        bytes32 verifierAttestationUID;
        address verifier; // attester of the DeliveryVerified attestation
        uint64 challengeDeadline;
        DeliveryStatus status;
    }

    event DeliveryOpened(
        uint256 indexed deliveryId,
        uint256 indexed needId,
        uint256 trancheIndex,
        address indexed fieldAgent,
        uint32 expectedRecipients
    );
    event DeliveryEvidenceLinked(uint256 indexed deliveryId, bytes32 attestationUID);
    event ReceiptConfirmed(uint256 indexed deliveryId, uint256 nullifier, uint32 confirmations);
    event DeliveryVerifiedLinked(
        uint256 indexed deliveryId, bytes32 attestationUID, address indexed verifier, bool approved
    );
    event DeliveryChallengeable(uint256 indexed deliveryId, uint64 challengeDeadline);
    event DeliveryChallenged(uint256 indexed deliveryId, address indexed challenger, bytes32 reasonHash);
    event DisputeResolved(uint256 indexed deliveryId, bool upheld);
    event DeliveryCancelled(uint256 indexed deliveryId, address indexed by);
    event DeliveryFinalized(uint256 indexed deliveryId, uint256 indexed needId, uint256 trancheIndex);
    event DeliveryRejected(uint256 indexed deliveryId, uint256 indexed needId, uint256 trancheIndex);
    event Wired(address evidenceResolver, address verifiedResolver);

    /// @notice Opens a delivery for `trancheIndex` of `needId`. Caller must be a field agent of the need's NGO.
    function openDelivery(uint256 needId, uint256 trancheIndex, uint32 expectedRecipients) external returns (uint256);

    /// @notice Links a DeliveryEvidence attestation. DeliveryEvidenceResolver only.
    function onEvidenceAttested(uint256 deliveryId, bytes32 uid) external;

    /// @notice Anonymous receipt confirmation by a beneficiary; anyone may relay the proof.
    function confirmReceipt(uint256 deliveryId, ISemaphore.SemaphoreProof calldata proof) external;

    /// @notice Links a DeliveryVerified attestation. DeliveryVerifiedResolver only.
    function onDeliveryVerified(uint256 deliveryId, address verifier, bool approved, bytes32 uid) external;

    /// @notice Disputes a challengeable delivery before its deadline. Independent verifiers only.
    function challenge(uint256 deliveryId, bytes32 reasonHash) external;

    /// @notice Resolves a dispute. `uphold = true` rejects the delivery. Admin only.
    function resolveDispute(uint256 deliveryId, bool uphold) external;

    /// @notice Closes an abandoned delivery so its tranche can be attempted again. Admin only.
    function cancelDelivery(uint256 deliveryId) external;

    /// @notice Finalizes a delivery after its challenge period and unlocks the tranche. Callable by anyone.
    function finalize(uint256 deliveryId) external;

    function getDelivery(uint256 deliveryId) external view returns (Delivery memory);
    function deliveryCount() external view returns (uint256);
    function lastFinalizedDeliveryOf(uint256 needId) external view returns (uint256);
    function activeDeliveryOf(uint256 needId, uint256 trancheIndex) external view returns (uint256);
}
