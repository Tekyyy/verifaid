// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @title MockYieldVault
/// @notice An ERC-4626 vault for tests, with the two knobs a real curated vault has and a happy path never
///         shows: its share price can fall, and it can be unable to return money it still owes.
/// @dev A MetaMorpho vault lends its assets into Morpho markets, so what a depositor can take out today is
///      bounded by what is not currently borrowed. `setLiquidityCap` models exactly that and nothing more.
///      Both `max*` overrides work from the base `maxRedeem` rather than from each other: OpenZeppelin's
///      `maxWithdraw` is written as `previewRedeem(maxRedeem(owner))`, so overriding both and having them call
///      one another recurses forever.
contract MockYieldVault is ERC4626 {
    /// @notice Ceiling on what any depositor can take out right now; `type(uint256).max` means fully liquid.
    uint256 public liquidityCap = type(uint256).max;

    constructor(IERC20 asset_) ERC4626(asset_) ERC20("Mock Yield Vault", "mYLD") {}

    /// @notice Interest arriving: assets appear without shares being minted, so every share is worth more.
    function accrue(uint256 amount) external {
        IERC20(asset()).transferFrom(msg.sender, address(this), amount);
    }

    /// @notice Bad debt: assets leave without shares being burned, so every share is worth less.
    function lose(uint256 amount) external {
        IERC20(asset()).transfer(address(0xdead), amount);
    }

    function setLiquidityCap(uint256 cap) external {
        liquidityCap = cap;
    }

    function maxWithdraw(address owner) public view override returns (uint256) {
        uint256 owed = previewRedeem(super.maxRedeem(owner));
        uint256 liquid = _liquid();
        return owed < liquid ? owed : liquid;
    }

    function maxRedeem(address owner) public view override returns (uint256) {
        uint256 held = super.maxRedeem(owner);
        uint256 liquid = _liquid();
        // Converting back and forth loses a unit to rounding, so only convert when the cap actually bites.
        if (previewRedeem(held) <= liquid) return held;
        return _convertToShares(liquid, Math.Rounding.Floor);
    }

    /// @dev What the vault could actually hand over: what it holds, and never more than the cap under test.
    function _liquid() internal view returns (uint256) {
        uint256 onHand = IERC20(asset()).balanceOf(address(this));
        uint256 cap = liquidityCap;
        return onHand < cap ? onHand : cap;
    }
}
