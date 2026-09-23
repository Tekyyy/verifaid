// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {RoleAware} from "../access/RoleAware.sol";
import {IAidVaultFactory} from "../interfaces/IAidVaultFactory.sol";
import {IRoleRegistry} from "../interfaces/IRoleRegistry.sol";
import {Errors} from "../libraries/Errors.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @title AidVaultFactory
/// @notice Deploys an EIP-1167 minimal-proxy AidVault for every verified need. Every need's money is escrowed on
///         chain: there is no other kind of ledger to choose.
/// @dev The need id is appended to each clone's code, so a clone is fully configured the moment it exists.
contract AidVaultFactory is IAidVaultFactory, RoleAware {
    address public registry;
    /// @inheritdoc IAidVaultFactory
    IERC20 public token;
    /// @inheritdoc IAidVaultFactory
    address public implementation;
    bool public wired;

    /// @inheritdoc IAidVaultFactory
    mapping(address => bool) public isVault;

    /// @param roles_ System role registry.
    constructor(IRoleRegistry roles_) RoleAware(roles_) {}

    /// @notice One-time wiring. Admin only. The implementation is deployed after this factory because its
    ///         immutables include its address.
    function wire(address registry_, address token_, address vaultImplementation_) external onlyAdmin {
        if (wired) revert Errors.AlreadyWired();
        if (registry_ == address(0) || token_ == address(0) || vaultImplementation_ == address(0)) {
            revert Errors.ZeroAddress();
        }
        wired = true;
        registry = registry_;
        token = IERC20(token_);
        implementation = vaultImplementation_;
        emit Wired(registry_, token_, vaultImplementation_);
    }

    /// @inheritdoc IAidVaultFactory
    function createVault(uint256 needId) external returns (address vault) {
        if (msg.sender != registry || msg.sender == address(0)) revert Errors.Unauthorized();
        vault = Clones.cloneWithImmutableArgs(implementation, abi.encode(needId));
        isVault[vault] = true;
        emit VaultCreated(needId, vault);
    }
}
