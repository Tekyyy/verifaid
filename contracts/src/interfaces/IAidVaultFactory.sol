// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @title IAidVaultFactory
/// @notice Deploys one minimal-proxy AidVault per verified need.
interface IAidVaultFactory {
    event VaultCreated(uint256 indexed needId, address vault);
    event Wired(address registry, address token, address vaultImplementation);

    /// @notice Clones the vault for `needId`, with the need id baked into the clone's code. NeedsRegistry only.
    function createVault(uint256 needId) external returns (address vault);

    /// @notice True for AidVaults created by this factory (the only contracts that may mint receipts).
    function isVault(address account) external view returns (bool);

    function token() external view returns (IERC20);
    function implementation() external view returns (address);
}
