// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title ICommunityProofs
/// @notice Proof of delivery from anyone, and the small rewards an NGO can offer for it.
interface ICommunityProofs {
    /// @notice One proof: photos (and a note) someone who does not run the need filed about it.
    struct Proof {
        uint128 needId;
        uint64 submittedAt;
        bool rewarded;
        address submitter;
        bytes32 manifestHash;
    }

    /// @notice A reward pot an NGO funded for proofs about one of its needs.
    struct Bounty {
        uint128 needId;
        uint64 deadline;
        uint32 maxRewards;
        uint32 rewardsPaid;
        address ngo;
        bool closed;
        uint128 reward;
        uint128 balance;
    }

    /// @notice `manifest` is the evidence manifest as filed (files by hash, a note); its keccak256 is `manifestHash`.
    event ProofSubmitted(
        uint256 indexed proofId,
        uint256 indexed needId,
        address indexed submitter,
        bytes32 manifestHash,
        string manifest
    );
    event BountyOpened(
        uint256 indexed bountyId,
        uint256 indexed needId,
        address indexed ngo,
        uint256 reward,
        uint256 maxRewards,
        uint64 deadline
    );
    event ProofRewarded(
        uint256 indexed proofId, uint256 indexed bountyId, uint256 indexed needId, address submitter, uint256 amount
    );
    event BountyClosed(uint256 indexed bountyId, uint256 indexed needId, uint256 refunded);

    /// @notice Files proof about a need whose money has started to move (funded, in delivery or completed). Anyone
    ///         may, except the need's NGO, its payout address and whoever runs the need: they account for it through
    ///         the delivery evidence instead.
    function submitProof(uint256 needId, string calldata manifest) external returns (uint256 proofId);

    /// @notice The need's NGO sets aside `reward × maxRewards` of the token, from its own wallet, for proofs filed
    ///         until `deadline`. One pot per need at a time.
    function openBounty(uint256 needId, uint256 reward, uint32 maxRewards, uint64 deadline)
        external
        returns (uint256 bountyId);

    /// @notice The NGO pays one reward from the need's open pot to the wallet that filed `proofId`. A wallet is paid
    ///         at most once per need.
    function rewardProof(uint256 proofId) external;

    /// @notice Closes a pot and returns what is left to the NGO. The NGO may close it at any time; anyone may once
    ///         its deadline has passed, so nothing stays locked.
    function closeBounty(uint256 bountyId) external;

    function proofOf(uint256 proofId) external view returns (Proof memory);
    function bountyOf(uint256 bountyId) external view returns (Bounty memory);
    /// @notice The pot currently open on a need, or 0.
    function openBountyOf(uint256 needId) external view returns (uint256);
    /// @notice Whether `wallet` has already been paid for proof about `needId`.
    function rewardedOn(uint256 needId, address wallet) external view returns (bool);
}
