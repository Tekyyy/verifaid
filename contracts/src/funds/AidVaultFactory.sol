// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {RoleAware} from "../access/RoleAware.sol";
import {IAidVaultFactory} from "../interfaces/IAidVaultFactory.sol";
import {INeedsRegistry} from "../interfaces/INeedsRegistry.sol";
import {IRoleRegistry} from "../interfaces/IRoleRegistry.sol";
import {Errors} from "../libraries/Errors.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @title AidVaultFactory
/// @notice Deploys an EIP-1167 minimal-proxy ledger for every verified need: an AidVault for on-chain custody or a
///         NonCustodialLedger for needs funded through a payment provider.
/// @dev The need id is appended to each clone's code, so a clone is fully configured the moment it exists.
contract AidVaultFactory is IAidVaultFactory, RoleAware {
    enum Kind {
        None,
        Vault,
        Ledger
    }

    address public registry;
    /// @inheritdoc IAidVaultFactory
    IERC20 public token;
    /// @inheritdoc IAidVaultFactory
    address public implementation;
    /// @inheritdoc IAidVaultFactory
    address public ledgerImplementation;
    bool public wired;

    /// @notice What a factory-created address is (one slot per ledger instead of one per flag).
    mapping(address => Kind) public kindOf;
    /// @notice Payment references already used by any ledger.
    mapping(bytes32 => bool) public paymentRefConsumed;

    /// @param roles_ System role registry.
    constructor(IRoleRegistry roles_) RoleAware(roles_) {}

    /// @notice One-time wiring. Admin only. The implementations are deployed after this factory because their
    ///         immutables include its address.
    function wire(address registry_, address token_, address vaultImplementation_, address ledgerImplementation_)
        external
        onlyAdmin
    {
        if (wired) revert Errors.AlreadyWired();
        if (
            registry_ == address(0) || token_ == address(0) || vaultImplementation_ == address(0)
                || ledgerImplementation_ == address(0)
        ) revert Errors.ZeroAddress();
        wired = true;
        registry = registry_;
        token = IERC20(token_);
        implementation = vaultImplementation_;
        ledgerImplementation = ledgerImplementation_;
        emit Wired(registry_, token_, vaultImplementation_, ledgerImplementation_);
    }

    /// @inheritdoc IAidVaultFactory
    function createVault(uint256 needId, INeedsRegistry.CustodyMode custodyMode) external returns (address vault) {
        if (msg.sender != registry || msg.sender == address(0)) revert Errors.Unauthorized();
        bool onChain = custodyMode == INeedsRegistry.CustodyMode.OnChain;
        vault = Clones.cloneWithImmutableArgs(onChain ? implementation : ledgerImplementation, abi.encode(needId));
        kindOf[vault] = onChain ? Kind.Vault : Kind.Ledger;
        emit VaultCreated(needId, vault, custodyMode);
    }

    /// @inheritdoc IAidVaultFactory
    function consumePaymentRef(bytes32 paymentRefHash) external {
        if (kindOf[msg.sender] == Kind.None) revert Errors.NotLedger();
        if (paymentRefConsumed[paymentRefHash]) revert Errors.PaymentRefAlreadyUsed();
        paymentRefConsumed[paymentRefHash] = true;
        emit PaymentRefConsumed(paymentRefHash, msg.sender);
    }

    /// @inheritdoc IAidVaultFactory
    function isVault(address account) external view returns (bool) {
        return kindOf[account] == Kind.Vault;
    }

    /// @inheritdoc IAidVaultFactory
    function isLedger(address account) external view returns (bool) {
        return kindOf[account] != Kind.None;
    }
}
