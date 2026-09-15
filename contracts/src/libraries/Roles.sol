// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title Roles
/// @notice Role identifiers used by the RoleRegistry and every contract that consults it.
library Roles {
    /// @dev Same value as OpenZeppelin AccessControl.DEFAULT_ADMIN_ROLE.
    bytes32 internal constant DEFAULT_ADMIN_ROLE = 0x00;
    bytes32 internal constant NGO_ROLE = keccak256("NGO_ROLE");
    bytes32 internal constant VERIFIER_ROLE = keccak256("VERIFIER_ROLE");
    bytes32 internal constant FIELD_AGENT_ROLE = keccak256("FIELD_AGENT_ROLE");
    bytes32 internal constant BANK_PARTNER_ROLE = keccak256("BANK_PARTNER_ROLE");
}
