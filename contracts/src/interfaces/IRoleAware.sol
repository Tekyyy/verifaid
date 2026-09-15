// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IRoleRegistry} from "./IRoleRegistry.sol";

/// @title IRoleAware
/// @notice Exposes the role registry a contract delegates authorization to.
interface IRoleAware {
    /// @notice System role registry.
    function roles() external view returns (IRoleRegistry);
}
