// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IAidVault
/// @notice Per-need escrow that holds stablecoin donations and releases them in tranches.
interface IAidVault {
    enum TrancheStatus {
        Locked,
        Releasable,
        Released
    }

    struct Tranche {
        uint16 bps;
        uint256 amount;
        TrancheStatus status;
        uint256 deliveryId; // delivery that unlocked this tranche (0 for tranche 0 / pre-financing)
    }

    /// @notice On-chain record of a fiat donation deposited by a bank partner.
    struct FiatDonationRecord {
        address partner;
        bytes32 donorRefHash;
        uint256 amount;
        uint64 timestamp;
    }

    event Donated(uint256 indexed needId, address indexed donor, uint256 amount, uint256 receiptId);
    event DonatedOnBehalf(
        uint256 indexed needId, address indexed partner, uint256 amount, bytes32 donorRefHash, bytes32 paymentRefHash
    );
    event FundingClosed(uint256 indexed needId, uint256 totalDonated);
    event TrancheReleasable(uint256 indexed needId, uint256 indexed index, uint256 deliveryId);
    event TrancheReleased(uint256 indexed needId, uint256 indexed index, uint256 amount, address to);
    event Refunded(uint256 indexed needId, address indexed account, uint256 amount);
    event RefundedByRef(uint256 indexed needId, bytes32 indexed donorRefHash, address indexed to, uint256 amount);

    /// @notice One-time initializer called by the factory right after cloning.
    function initialize(uint256 needId, address token, address registry, address deliveryManager, address receipt)
        external;

    /// @notice Donates `amount` stablecoin (requires prior approval) and mints a soulbound receipt to the caller.
    function donate(uint256 amount) external returns (uint256 receiptId);

    /// @notice Deposits a fiat donation converted to stablecoin by a bank partner.
    function donateOnBehalf(uint256 amount, bytes32 donorRefHash, bytes32 paymentRefHash) external;

    /// @notice Closes funding early (NGO only); also triggered automatically when the target is reached.
    function closeFunding() external;

    /// @notice Marks tranche `index` releasable after its delivery was finalized. DeliveryManager only.
    function markReleasable(uint256 index, uint256 deliveryId) external;

    /// @notice Pays a releasable tranche to the NGO's registered payout address. Callable by anyone.
    function releaseTranche(uint256 index) external;

    /// @notice Pro-rata refund of the unreleased balance to a direct donor of a cancelled need.
    function claimRefund() external returns (uint256 amount);

    /// @notice Pro-rata refund for a fiat donor, executed by the bank partner that deposited it.
    function claimRefundByRef(bytes32 donorRefHash, address to) external returns (uint256 amount);

    function needId() external view returns (uint256);
    function totalDonated() external view returns (uint256);
    function totalReleased() external view returns (uint256);
    function totalRefunded() external view returns (uint256);
    function fundingClosed() external view returns (bool);
    function trancheCount() external view returns (uint256);
    function trancheStatus(uint256 index) external view returns (TrancheStatus);
    function getTranches() external view returns (Tranche[] memory);
    function fiatDonation(bytes32 paymentRefHash) external view returns (FiatDonationRecord memory);
}
