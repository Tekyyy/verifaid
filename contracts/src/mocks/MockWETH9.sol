// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title MockWETH9
/// @notice TEST CONTRACT ONLY — minimal wrapped ether for local chains without the canonical WETH9 predeploy.
contract MockWETH9 is ERC20 {
    constructor() ERC20("Mock Wrapped Ether (TEST ONLY)", "mWETH") {}

    function deposit() external payable {
        _mint(msg.sender, msg.value);
    }

    function withdraw(uint256 amount) external {
        _burn(msg.sender, amount);
        (bool ok,) = msg.sender.call{value: amount}("");
        require(ok, "withdraw failed");
    }
}
