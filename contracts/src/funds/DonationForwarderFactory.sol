// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {RoleAware} from "../access/RoleAware.sol";
import {IAidVault} from "../interfaces/IAidVault.sol";
import {IConversionRouter} from "../interfaces/IConversionRouter.sol";
import {IDonationForwarder} from "../interfaces/IDonationForwarder.sol";
import {IDonationForwarderFactory} from "../interfaces/IDonationForwarderFactory.sol";
import {INeedsRegistry} from "../interfaces/INeedsRegistry.sol";
import {IRoleRegistry} from "../interfaces/IRoleRegistry.sol";
import {ITrancheLedger} from "../interfaces/ITrancheLedger.sol";
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
/// @notice Three ways to give that a vault's own `donate` does not cover:
///         - `donate`: a wallet converts a token the vault does not hold (USDC bought with a card, ETH, …) and
///           donates in one transaction and gets the receipt.
///         - `donateEqually`: a wallet gives to a basket of needs — every open water need, say — and the factory splits
///           the gift equally between them, each part a donation in the giver's name.
///         - deposit addresses: DonationForwarders at CREATE2 addresses derived from their intents, for money sent
///           from somewhere that cannot call a contract (an exchange withdrawal). Anyone can deploy one, and doing
///           so only ever fixes the intent its address committed to; the donor or a keeper sweeps it.
///         The vaults trust this factory and the forwarders it deployed, and nothing else, to call `donateVia`.
contract DonationForwarderFactory is IDonationForwarderFactory, RoleAware, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    address public constant NATIVE = address(0);
    /// @notice The most needs one basket gift may be split between.
    uint256 public constant MAX_BASKET_NEEDS = 25;

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

    /// @inheritdoc IDonationForwarderFactory
    /// @dev The split is the factory's, not the caller's, so "equally" is a property of the contract: the needs
    ///      with the least room are served first, each part is what is left divided by the needs still waiting,
    ///      and rounding dust goes to the need with the most room. The basket's membership is the caller's choice
    ///      and is public in the event: a category's open needs is what the app offers.
    function donateEqually(bytes32 basket, uint256[] calldata needIds, uint256 total)
        external
        nonReentrant
        returns (uint256[] memory amounts, uint256 returned)
    {
        uint256 count = needIds.length;
        if (total == 0) revert Errors.ZeroAmount();
        if (count == 0 || count > MAX_BASKET_NEEDS) revert Errors.InvalidParameter();
        for (uint256 i = 1; i < count; ++i) {
            if (needIds[i] <= needIds[i - 1]) revert Errors.InvalidParameter();
        }

        uint256[] memory room = new uint256[](count);
        uint256 open;
        for (uint256 i; i < count; ++i) {
            room[i] = _room(needIds[i]);
            if (room[i] != 0) ++open;
        }
        if (open == 0) revert Errors.NotAccepting();

        token.safeTransferFrom(msg.sender, address(this), total);
        amounts = _equalShares(total, room, open);
        uint256 given;
        for (uint256 i; i < count; ++i) {
            uint256 part = amounts[i];
            if (part == 0) continue;
            address vault = registry.vaultOf(needIds[i]);
            token.forceApprove(vault, part);
            IAidVault(vault).donateVia(part, 0, msg.sender);
            given += part;
        }
        returned = total - given;
        if (returned != 0) token.safeTransfer(msg.sender, returned);
        emit BasketDonated(msg.sender, basket, needIds, amounts, returned);
    }

    // ─── internal ──────────────────────────────────────────────────────────────

    /// @dev What a need can still take right now: zero unless it is raising, before its deadlines, below its target
    ///      and run by an active NGO (the vault refuses money for a suspended NGO, which would sink the whole gift).
    function _room(uint256 needId) internal view returns (uint256) {
        (address ngo, uint256 target,, bool open) = registry.fundingTermsOf(needId);
        if (!open || !roles.isActiveNgo(ngo)) return 0;
        uint256 donated = ITrancheLedger(registry.vaultOf(needId)).totalDonated();
        return donated < target ? target - donated : 0;
    }

    /// @dev Equal parts, capped by each need's room ("water-filling"): serve the need with the least room first,
    ///      give it the lesser of its room and an equal part of what is left, and repeat with one need fewer. At
    ///      most 25 needs, so the quadratic pick of the next-smallest is cheap.
    function _equalShares(uint256 total, uint256[] memory room, uint256 open)
        internal
        pure
        returns (uint256[] memory shares)
    {
        uint256 count = room.length;
        shares = new uint256[](count);
        bool[] memory served = new bool[](count);
        uint256 remaining = total;
        for (uint256 left = open; left > 0; --left) {
            uint256 next = type(uint256).max;
            for (uint256 i; i < count; ++i) {
                if (served[i] || room[i] == 0) continue;
                if (next == type(uint256).max || room[i] < room[next]) next = i;
            }
            served[next] = true;
            uint256 part = remaining / left;
            if (part > room[next]) part = room[next];
            shares[next] = part;
            remaining -= part;
        }
    }

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
