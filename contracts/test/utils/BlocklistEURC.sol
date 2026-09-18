// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {MockEURC} from "../../src/mocks/MockEURC.sol";

/// @notice MockEURC with Circle's freeze power: transfers to a blocked address revert, as they do for real EURC.
contract BlocklistEURC is MockEURC {
    mapping(address => bool) public blocked;

    function setBlocked(address account, bool isBlocked) external {
        blocked[account] = isBlocked;
    }

    function _update(address from, address to, uint256 value) internal override {
        require(!blocked[to], "blocked");
        super._update(from, to, value);
    }
}
