// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @title IAidVaultFactory
/// @notice Deploys one minimal-proxy AidVault per verified need.
interface IAidVaultFactory {
    event VaultCreated(uint256 indexed needId, address vault);
    event PaymentRefConsumed(bytes32 indexed paymentRefHash, address indexed vault);
    event Wired(address registry, address deliveryManager, address token, address receipt);

    /// @notice Clones and initializes the vault for `needId`. NeedsRegistry only.
    function createVault(uint256 needId) external returns (address vault);

    /// @notice Marks a fiat payment reference as used system-wide, so one bank transfer cannot fund two needs.
    ///         Callable only by vaults created by this factory.
    function consumePaymentRef(bytes32 paymentRefHash) external;

    function isVault(address account) external view returns (bool);
    function vaultOf(uint256 needId) external view returns (address);
    function token() external view returns (IERC20);
    function implementation() external view returns (address);
}
