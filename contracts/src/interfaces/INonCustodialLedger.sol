// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ITrancheLedger} from "./ITrancheLedger.sol";

/// @title INonCustodialLedger
/// @notice Non-custodial ledger (`CustodyMode.OffChain`, the proposal's Model A). No tokens ever touch it: a
///         registered payment provider holds the money, and its attestations move the need through the same
///         funding and tranche rules the AidVault enforces with real balances.
interface INonCustodialLedger is ITrancheLedger {
    event FundingRecorded(
        uint256 indexed needId,
        address indexed provider,
        uint256 gross,
        uint256 fee,
        uint256 net,
        bytes32 currency,
        bytes32 paymentRefHash,
        bytes32 donorRefHash
    );

    /// @notice Counts a payment the provider received toward the need. Resolver only (from `FundingRecorded`).
    function recordFunding(
        address provider,
        uint256 gross,
        uint256 fee,
        uint256 net,
        bytes32 currency,
        bytes32 paymentRefHash,
        bytes32 donorRefHash
    ) external;

    /// @notice Records that the provider paid out a releasable tranche. Resolver only (from `Settlement`).
    /// @return amount The tranche amount.
    function recordRelease(uint256 index, address provider) external returns (uint256 amount);

    /// @notice Net amount a provider has recorded for this need (only such providers may settle tranches).
    function recordedBy(address provider) external view returns (uint256);
}
