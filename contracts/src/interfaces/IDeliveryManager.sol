// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IDeliveryManager
/// @notice Unlocks every tranche after the first on the need's donors' say-so. The NGO shows how the money it was
///         already paid was spent — photos, receipts, bank statements, listed in a manifest committed on chain — and
///         once donors who gave a set share of what was raised approve it, the next tranche becomes releasable.
interface IDeliveryManager {
    enum DeliveryStatus {
        Open, // under review by the donors
        Approved, // enough of the raised amount approved it; its tranche became releasable
        Superseded // the NGO replaced this evidence before it was approved
    }

    struct Delivery {
        uint256 id;
        uint256 needId;
        uint256 trancheIndex; // tranche this evidence unlocks (>= 1); it accounts for tranche `trancheIndex - 1`
        address submitter;
        bytes32 evidenceHash; // keccak256 of the manifest, whose full text is in `DeliverySubmitted`
        uint256 approvedAmount; // sum of the donations of the donors who approved it
        uint64 submittedAt;
        uint64 approvedAt;
        DeliveryStatus status;
    }

    event DeliverySubmitted(
        uint256 indexed deliveryId,
        uint256 indexed needId,
        uint256 trancheIndex,
        address indexed submitter,
        bytes32 evidenceHash,
        string manifest
    );
    event DeliverySuperseded(uint256 indexed deliveryId, uint256 indexed replacedBy);
    event DeliveryApprovalAdded(
        uint256 indexed deliveryId,
        address indexed donor,
        uint256 weight,
        uint256 approvedAmount,
        uint256 requiredAmount
    );
    event DeliveryApproved(uint256 indexed deliveryId, uint256 indexed needId, uint256 trancheIndex);

    /// @notice The NGO files the evidence for its next locked tranche. Replaces any evidence still under review for
    ///         that tranche, and with it every approval given so far: donors approved what they saw.
    function submitEvidence(uint256 needId, string calldata manifest) external returns (uint256 deliveryId);

    /// @notice A donor to the need approves the evidence, with the weight of what they gave. Reaching the threshold
    ///         makes the tranche releasable in the same transaction.
    function approve(uint256 deliveryId) external;

    function getDelivery(uint256 deliveryId) external view returns (Delivery memory);

    /// @notice Share of the raised amount that must approve, in basis points.
    function approvalThresholdBps() external view returns (uint16);

    /// @notice Amount of donations whose donors must approve a delivery of this need (0 before funding closes).
    function requiredApproval(uint256 needId) external view returns (uint256);

    /// @notice What `donor`'s approval of this need weighs: their donations, or 0 for the NGO, its payout address,
    ///         the need's payees and anyone who did not give.
    function approvalWeight(uint256 needId, address donor) external view returns (uint256);

    function hasApproved(uint256 deliveryId, address donor) external view returns (bool);
    function deliveryCount() external view returns (uint256);
    function activeDeliveryOf(uint256 needId, uint256 trancheIndex) external view returns (uint256);
    function lastApprovedDeliveryOf(uint256 needId) external view returns (uint256);
}
