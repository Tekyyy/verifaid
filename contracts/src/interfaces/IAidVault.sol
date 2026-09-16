// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ITrancheLedger} from "./ITrancheLedger.sol";

/// @title IAidVault
/// @notice Custodial ledger (`CustodyMode.OnChain`): per-need escrow that holds stablecoin donations and releases
///         them in tranches.
interface IAidVault is ITrancheLedger {
    event Donated(uint256 indexed needId, address indexed donor, uint256 amount, uint256 receiptId);
    event DonatedOnBehalf(
        uint256 indexed needId, address indexed partner, uint256 amount, bytes32 donorRefHash, bytes32 paymentRefHash
    );
    event Refunded(uint256 indexed needId, address indexed account, uint256 amount);
    event RefundedByRef(uint256 indexed needId, bytes32 indexed donorRefHash, address indexed to, uint256 amount);

    /// @notice Donates `amount` stablecoin (requires prior approval) and mints a soulbound receipt to the caller.
    function donate(uint256 amount) external returns (uint256 receiptId);

    /// @notice Deposits a fiat donation converted to stablecoin by a payment provider (BANK_PARTNER_ROLE).
    function donateOnBehalf(uint256 amount, bytes32 donorRefHash, bytes32 paymentRefHash) external;

    /// @notice Pays a releasable tranche to the NGO's registered payout address. Callable by anyone.
    function releaseTranche(uint256 index) external;

    /// @notice Pro-rata refund of the unreleased balance to a direct donor of a cancelled or expired need.
    function claimRefund() external returns (uint256 amount);

    /// @notice Pro-rata refund for a fiat donor, executed by the provider that deposited it.
    function claimRefundByRef(bytes32 donorRefHash, address to) external returns (uint256 amount);

    function totalRefunded() external view returns (uint256);

    /// @notice True if `paymentRefHash` was deposited by `partner` for `donorRefHash` with exactly `amount`.
    function fiatDepositMatches(bytes32 paymentRefHash, address partner, bytes32 donorRefHash, uint256 amount)
        external
        view
        returns (bool);
}
