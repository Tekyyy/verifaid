// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title MockEURC
/// @notice TEST TOKEN ONLY — worthless demo stablecoin with 6 decimals and a public, permissionless mint.
contract MockEURC is ERC20 {
    constructor() ERC20("Mock EURC (TEST ONLY)", "mEURC") {}

    /// @notice Mints `amount` test tokens to `to`. Anyone can call this — never use outside demos and tests.
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    /// @inheritdoc ERC20
    function decimals() public pure override returns (uint8) {
        return 6;
    }
}
