// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IRoleAware} from "../interfaces/IRoleAware.sol";
import {IRoleRegistry} from "../interfaces/IRoleRegistry.sol";
import {Errors} from "../libraries/Errors.sol";

/// @title RoleAware
/// @notice Base for contracts that delegate authorization and the global pause to the RoleRegistry.
abstract contract RoleAware is IRoleAware {
    /// @inheritdoc IRoleAware
    IRoleRegistry public immutable roles;

    constructor(IRoleRegistry roles_) {
        if (address(roles_) == address(0)) revert Errors.ZeroAddress();
        roles = roles_;
    }

    modifier onlyAdmin() {
        if (!roles.isAdmin(msg.sender)) revert Errors.Unauthorized();
        _;
    }

    modifier whenNotPaused() {
        if (roles.paused()) revert Errors.SystemPaused();
        _;
    }
}
