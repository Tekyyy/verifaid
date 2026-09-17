// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IDonationForwarder} from "./IDonationForwarder.sol";

/// @title IDonationForwarderFactory
/// @notice Deterministic deposit addresses for donations that need converting: known before any money arrives, so a
///         card on-ramp can be told where to send the stablecoin it buys.
interface IDonationForwarderFactory {
    event ForwarderDeployed(
        address indexed forwarder,
        uint256 indexed needId,
        address receiptTo,
        address refundTo,
        address refundSigner,
        bytes32 salt
    );

    event DonatedWithConversion(
        uint256 indexed needId,
        address indexed donor,
        address indexed tokenIn,
        uint256 amountIn,
        uint256 converted,
        uint256 fairValue,
        uint256 deposited
    );

    /// @notice The deposit address of `intent`, whether or not it has been deployed yet.
    function forwarderAddress(IDonationForwarder.Intent calldata intent) external view returns (address);

    /// @notice Deploys the forwarder for `intent` (no-op if it exists). Anyone can call this.
    function deploy(IDonationForwarder.Intent calldata intent) external returns (address forwarder);

    /// @notice Deploys the forwarder if needed and sweeps its `tokenIn` balance into the need. Anyone can call this.
    function sweep(IDonationForwarder.Intent calldata intent, address tokenIn)
        external
        returns (address forwarder, uint256 deposited);

    /// @notice A wallet donation in any supported token (`address(0)` for ETH): converted, donated, and receipted
    ///         to the caller in one transaction. Anything above what the need still needs is returned, converted.
    ///         Reverts if the need is not accepting donations.
    function donate(uint256 needId, address tokenIn, uint256 amountIn)
        external
        payable
        returns (uint256 deposited, uint256 receiptId);

    /// @notice True for forwarders deployed by this factory (with the factory itself, the only `donateVia` callers).
    function isForwarder(address account) external view returns (bool);

    function implementation() external view returns (address);
}
