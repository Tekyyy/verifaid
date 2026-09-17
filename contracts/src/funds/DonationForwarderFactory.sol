// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {RoleAware} from "../access/RoleAware.sol";
import {IConversionRouter} from "../interfaces/IConversionRouter.sol";
import {IDonationForwarder} from "../interfaces/IDonationForwarder.sol";
import {IDonationForwarderFactory} from "../interfaces/IDonationForwarderFactory.sol";
import {INeedsRegistry} from "../interfaces/INeedsRegistry.sol";
import {IRoleRegistry} from "../interfaces/IRoleRegistry.sol";
import {Errors} from "../libraries/Errors.sol";
import {DonationConversion} from "./DonationConversion.sol";
import {DonationForwarder} from "./DonationForwarder.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";

/// @dev The registry's role registry, read before the factory's own constructor runs (a zero registry has none).
function rolesOf(INeedsRegistry registry) view returns (IRoleRegistry) {
    if (address(registry) == address(0)) revert Errors.ZeroAddress();
    return registry.roles();
}

/// @title DonationForwarderFactory
/// @notice Two ways to give in a token the vault does not hold (USDC bought with a card, ETH, …):
///         - `donate`: a wallet converts and donates in one transaction and gets the receipt.
///         - deposit addresses: DonationForwarders at CREATE2 addresses derived from their intents, for money sent
///           from somewhere that cannot call a contract (an exchange withdrawal). Anyone can deploy one, and doing
///           so only ever fixes the intent its address committed to; the donor or a keeper sweeps it.
///         The vaults trust this factory and the forwarders it deployed, and nothing else, to call `donateVia`.
contract DonationForwarderFactory is IDonationForwarderFactory, RoleAware, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    address public constant NATIVE = address(0);

    INeedsRegistry public immutable registry;
    IConversionRouter public immutable router;
    /// @notice The stablecoin every vault holds.
    IERC20 public immutable token;
    /// @inheritdoc IDonationForwarderFactory
    address public immutable implementation;

    /// @inheritdoc IDonationForwarderFactory
    mapping(address => bool) public isForwarder;
    /// @inheritdoc IDonationForwarderFactory
    mapping(address => bool) public isKeeper;

    constructor(INeedsRegistry registry_, IConversionRouter router_, IERC20 token_) RoleAware(rolesOf(registry_)) {
        if (address(router_) == address(0) || address(token_) == address(0)) revert Errors.ZeroAddress();
        registry = registry_;
        router = router_;
        token = token_;
        implementation = address(new DonationForwarder(registry_, router_, token_));
    }

    /// @inheritdoc IDonationForwarderFactory
    function setKeeper(address keeper, bool active) external onlyAdmin {
        if (keeper == address(0)) revert Errors.ZeroAddress();
        isKeeper[keeper] = active;
        emit KeeperSet(keeper, active);
    }

    /// @inheritdoc IDonationForwarderFactory
    function forwarderAddress(IDonationForwarder.Intent calldata intent) external view returns (address) {
        _validate(intent);
        return _predict(intent);
    }

    /// @inheritdoc IDonationForwarderFactory
    function deploy(IDonationForwarder.Intent calldata intent) external returns (address forwarder) {
        return _deploy(intent);
    }

    /// @inheritdoc IDonationForwarderFactory
    function sweep(IDonationForwarder.Intent calldata intent, address tokenIn)
        external
        returns (address forwarder, uint256 deposited)
    {
        if (msg.sender != intent.receiptTo && msg.sender != intent.refundTo && !isKeeper[msg.sender]) {
            revert Errors.Unauthorized();
        }
        forwarder = _deploy(intent);
        deposited = IDonationForwarder(forwarder).sweep(tokenIn);
    }

    /// @inheritdoc IDonationForwarderFactory
    function donate(uint256 needId, address tokenIn, uint256 amountIn)
        external
        payable
        nonReentrant
        returns (uint256 deposited, uint256 receiptId)
    {
        if (amountIn == 0) revert Errors.ZeroAmount();
        if (tokenIn == NATIVE) {
            if (msg.value != amountIn) revert Errors.InvalidParameter();
        } else {
            if (msg.value != 0) revert Errors.InvalidParameter();
            IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);
        }

        // Reverts, returning the tokens with the rest of the transaction, if the need is not accepting.
        DonationConversion.Result memory r =
            DonationConversion.convertAndDonate(registry, router, token, needId, tokenIn, amountIn, msg.sender);
        (deposited, receiptId) = (r.deposited, r.receiptId);
        emit DonatedWithConversion(needId, msg.sender, tokenIn, r.amountIn, r.received, r.fairValue, r.deposited);

        // The need filled up: what was not needed goes straight back, unconverted where it was never converted.
        if (amountIn > r.amountIn) {
            if (tokenIn == NATIVE) Address.sendValue(payable(msg.sender), amountIn - r.amountIn);
            else IERC20(tokenIn).safeTransfer(msg.sender, amountIn - r.amountIn);
        }
        if (r.received > r.deposited) token.safeTransfer(msg.sender, r.received - r.deposited);
    }

    // ─── internal ──────────────────────────────────────────────────────────────

    function _deploy(IDonationForwarder.Intent memory intent) internal returns (address forwarder) {
        forwarder = _predict(intent);
        if (forwarder.code.length > 0) return forwarder;
        _validate(intent);

        Clones.cloneDeterministicWithImmutableArgs(implementation, abi.encode(intent), bytes32(0));
        isForwarder[forwarder] = true;
        emit ForwarderDeployed(
            forwarder, intent.needId, intent.receiptTo, intent.refundTo, intent.refundSigner, intent.salt
        );
    }

    /// @dev An intent that fails these checks could never be deployed, so its address must never be handed out.
    function _validate(IDonationForwarder.Intent memory intent) internal view {
        if (intent.needId == 0 || intent.needId > registry.needCount()) revert Errors.NeedNotFound();
        // Something must always be able to take undonated money back out.
        if (intent.refundTo == address(0) && intent.refundSigner == address(0)) revert Errors.InvalidParameter();
    }

    function _predict(IDonationForwarder.Intent memory intent) internal view returns (address) {
        return Clones.predictDeterministicAddressWithImmutableArgs(implementation, abi.encode(intent), bytes32(0));
    }
}
