// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IReleasePolicy} from "./IReleasePolicy.sol";

/// @title IDeliveryManager
/// @notice Unlocks every tranche after the first once the NGO has accounted for the money it was already paid —
///         photos, receipts, bank statements, listed in a manifest committed on chain — and that account has been
///         approved under the need's release policy. Evidence can also be rejected: the NGO gets `retries` fresh
///         starts, and the rejection after that cancels the need, which opens refunds.
interface IDeliveryManager {
    enum DeliveryStatus {
        Open, // under review
        Approved, // its tranche became releasable
        Superseded, // the NGO replaced this evidence before it was decided
        Rejected // voted down; the NGO may file again unless this cancelled the need
    }

    struct Delivery {
        uint256 id;
        uint256 needId;
        uint256 trancheIndex; // tranche this evidence unlocks (>= 1); it accounts for tranche `trancheIndex - 1`
        address submitter;
        bytes32 evidenceHash; // keccak256 of the manifest, whose full text is in `DeliverySubmitted`
        uint256 approvedAmount; // donations of the donors who approved it
        uint256 rejectedAmount; // donations of the donors who rejected it
        uint8 verifierApprovals;
        uint8 verifierRejections;
        uint64 submittedAt;
        uint64 decidedAt; // when it was approved or rejected; zero while open or once superseded
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
    /// @param contested Whether the replaced evidence had already been rejected by someone, which costs a retry.
    /// @param strikes The need's rejections and contested replacements so far.
    event DeliverySuperseded(uint256 indexed deliveryId, uint256 indexed replacedBy, bool contested, uint8 strikes);
    event VoteCast(
        uint256 indexed deliveryId, address indexed voter, IReleasePolicy.Voice voice, bool approve, uint256 weight
    );
    event DeliveryApproved(uint256 indexed deliveryId, uint256 indexed needId, uint256 trancheIndex);
    /// @param needCancelled True when this rejection used up the need's retries and cancelled it.
    event DeliveryRejected(
        uint256 indexed deliveryId, uint256 indexed needId, uint256 trancheIndex, uint8 strikes, bool needCancelled
    );

    /// @notice The NGO files the evidence for its next locked tranche. Replaces any evidence still under review for
    ///         that tranche, and with it every vote cast so far: people voted on what they saw. Replacing evidence
    ///         somebody has already rejected costs one of the need's retries, so a contested account cannot be
    ///         wiped clean for free.
    function submitEvidence(uint256 needId, string calldata manifest) external returns (uint256 deliveryId);

    /// @notice Approves the evidence, with the weight the need's policy gives the caller.
    function approve(uint256 deliveryId) external;

    /// @notice Rejects the evidence, with the weight the need's policy gives the caller.
    function reject(uint256 deliveryId) external;

    /// @notice Casts `voter`'s vote from a signature (EIP-712 `Vote`), so a relayer can pay the gas. Accepts
    ///         signatures from plain accounts and from smart wallets (ERC-1271).
    function voteBySig(uint256 deliveryId, address voter, bool approve, uint256 deadline, bytes calldata signature)
        external;

    function getDelivery(uint256 deliveryId) external view returns (Delivery memory);

    /// @notice The release policy of the need, fixed when it was created.
    function policyOf(uint256 needId) external view returns (IReleasePolicy);

    /// @notice What it takes to decide the need's evidence (zeros before funding closes).
    function rulesOf(uint256 needId) external view returns (IReleasePolicy.Rules memory);

    /// @notice In which capacity, and with what weight, `voter` may vote on the need's evidence.
    function voiceOf(uint256 needId, address voter) external view returns (IReleasePolicy.Voice voice, uint256 weight);

    /// @notice EIP-712 digest a voter signs for `voteBySig`.
    function voteDigest(uint256 deliveryId, address voter, bool approve, uint256 deadline)
        external
        view
        returns (bytes32);

    function hasVoted(uint256 deliveryId, address voter) external view returns (bool);
    /// @notice Rejections and contested replacements the need has had; one more than the policy's retries cancels it.
    function strikesOf(uint256 needId) external view returns (uint8);
    function deliveryCount() external view returns (uint256);
    function activeDeliveryOf(uint256 needId, uint256 trancheIndex) external view returns (uint256);
    function lastApprovedDeliveryOf(uint256 needId) external view returns (uint256);
}
