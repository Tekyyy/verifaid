// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title MockUSDC
/// @notice TEST TOKEN ONLY — worthless stand-in for what a card on-ramp delivers: 6 decimals, public mint.
contract MockUSDC is ERC20 {
    constructor() ERC20("Mock USDC (TEST ONLY)", "mUSDC") {}

    /// @notice Mints `amount` test tokens to `to`. Anyone can call this — never use outside demos and tests.
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    /// @inheritdoc ERC20
    function decimals() public pure override returns (uint8) {
        return 6;
    }
}
