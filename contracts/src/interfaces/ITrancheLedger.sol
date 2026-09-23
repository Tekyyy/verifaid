// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title ITrancheLedger
/// @notice Funding and tranche bookkeeping. DeliveryManager only ever talks to this interface, so deliveries work the same way
///         whether the money sits in escrow on-chain or with a payment provider off-chain.
interface ITrancheLedger {
    enum TrancheStatus {
        Locked,
        Releasable,
        Released
    }

    struct Tranche {
        uint16 bps;
        uint128 amount; // set when funding closes
        TrancheStatus status;
        uint64 deliveryId; // delivery that unlocked this tranche (0 for tranche 0 / pre-financing)
    }

    event FundingClosed(uint256 indexed needId, uint256 totalDonated);
    event TrancheReleasable(uint256 indexed needId, uint256 indexed index, uint256 deliveryId);
    /// @param to Always zero: a vault pays the payment plan's payees, recorded in the `PayeePaid` events that follow
    ///        (see `IAidVault.PayeePaid`).
    event TrancheReleased(uint256 indexed needId, uint256 indexed index, uint256 amount, address to);

    /// @notice Closes funding early once the minimum threshold is met (NGO only, before the funding deadline).
    ///         Funding also closes automatically when the target is reached.
    function closeFunding() external;

    /// @notice Closes funding on what was raised when the deadline passed above the threshold. Registry only.
    function closeFundingAtDeadline() external;

    /// @notice Marks tranche `index` releasable after its delivery was finalized. DeliveryManager only.
    function markReleasable(uint256 index, uint256 deliveryId) external;

    function needId() external view returns (uint256);
    function totalDonated() external view returns (uint256);
    function totalReleased() external view returns (uint256);
    function fundingClosed() external view returns (bool);
    function trancheCount() external view returns (uint256);
    function trancheStatus(uint256 index) external view returns (TrancheStatus);
    function getTranches() external view returns (Tranche[] memory);

    /// @notice True if a tranche is waiting to be released (which blocks expiry until someone releases it).
    function hasReleasableTranche() external view returns (bool);
}
