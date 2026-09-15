// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {RoleAware} from "../access/RoleAware.sol";
import {IAidVault} from "../interfaces/IAidVault.sol";
import {IAidVaultFactory} from "../interfaces/IAidVaultFactory.sol";
import {IRoleRegistry} from "../interfaces/IRoleRegistry.sol";
import {Errors} from "../libraries/Errors.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @title AidVaultFactory
/// @notice Deploys an EIP-1167 minimal-proxy clone of `AidVault` for every verified need.
contract AidVaultFactory is IAidVaultFactory, RoleAware {
    /// @inheritdoc IAidVaultFactory
    address public immutable implementation;

    address public registry;
    address public deliveryManager;
    /// @inheritdoc IAidVaultFactory
    IERC20 public token;
    address public receipt;
    bool public wired;

    /// @inheritdoc IAidVaultFactory
    mapping(address => bool) public isVault;
    /// @inheritdoc IAidVaultFactory
    mapping(uint256 => address) public vaultOf;
    /// @notice Fiat payment references already used by any vault.
    mapping(bytes32 => bool) public paymentRefConsumed;

    /// @param roles_ System role registry.
    /// @param implementation_ Deployed AidVault implementation (its initializer is locked).
    constructor(IRoleRegistry roles_, address implementation_) RoleAware(roles_) {
        if (implementation_ == address(0)) revert Errors.ZeroAddress();
        implementation = implementation_;
    }

    /// @notice One-time wiring. Admin only.
    function wire(address registry_, address deliveryManager_, address token_, address receipt_) external onlyAdmin {
        if (wired) revert Errors.AlreadyWired();
        if (registry_ == address(0) || deliveryManager_ == address(0) || token_ == address(0) || receipt_ == address(0))
        {
            revert Errors.ZeroAddress();
        }
        wired = true;
        registry = registry_;
        deliveryManager = deliveryManager_;
        token = IERC20(token_);
        receipt = receipt_;
        emit Wired(registry_, deliveryManager_, token_, receipt_);
    }

    /// @inheritdoc IAidVaultFactory
    function createVault(uint256 needId) external returns (address vault) {
        if (msg.sender != registry || msg.sender == address(0)) revert Errors.Unauthorized();
        if (vaultOf[needId] != address(0)) revert Errors.VaultAlreadyExists();

        vault = Clones.clone(implementation);
        isVault[vault] = true;
        vaultOf[needId] = vault;
        emit VaultCreated(needId, vault);

        IAidVault(vault).initialize(needId, address(token), registry, deliveryManager, receipt);
    }

    /// @inheritdoc IAidVaultFactory
    function consumePaymentRef(bytes32 paymentRefHash) external {
        if (!isVault[msg.sender]) revert Errors.NotVault();
        if (paymentRefConsumed[paymentRefHash]) revert Errors.PaymentRefAlreadyUsed();
        paymentRefConsumed[paymentRefHash] = true;
        emit PaymentRefConsumed(paymentRefHash, msg.sender);
    }
}
