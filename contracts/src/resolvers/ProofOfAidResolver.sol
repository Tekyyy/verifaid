// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IRoleRegistry} from "../interfaces/IRoleRegistry.sol";
import {Errors} from "../libraries/Errors.sol";
import {IEAS} from "@ethereum-attestation-service/eas-contracts/contracts/IEAS.sol";
import {Attestation} from "@ethereum-attestation-service/eas-contracts/contracts/IEAS.sol";
import {SchemaResolver} from "@ethereum-attestation-service/eas-contracts/contracts/resolver/SchemaResolver.sol";

/// @title ProofOfAidResolver
/// @notice Shared base for the five Proof of Aid schema resolvers.
/// @dev Each resolver derives the UID of the one schema it serves from its own address, exactly as the EAS
///      SchemaRegistry does (`keccak256(abi.encodePacked(schema, resolver, revocable))`). Attestations made under
///      any other schema that points at this resolver are rejected, so indexers can trust the five official UIDs.
abstract contract ProofOfAidResolver is SchemaResolver {
    /// @notice System role registry.
    IRoleRegistry public immutable roles;

    /// @notice UID of the only schema this resolver accepts.
    bytes32 public immutable SCHEMA_UID;

    constructor(IEAS eas, IRoleRegistry roles_, string memory schema, bool revocable) SchemaResolver(eas) {
        if (address(roles_) == address(0)) revert Errors.ZeroAddress();
        roles = roles_;
        SCHEMA_UID = keccak256(abi.encodePacked(schema, address(this), revocable));
    }

    /// @dev Common checks for new attestations: right schema, not expiring, system not paused.
    function _checkAttestation(Attestation calldata attestation) internal view {
        if (attestation.schema != SCHEMA_UID) revert Errors.WrongSchema();
        if (attestation.expirationTime != 0) revert Errors.ExpiringAttestation();
        if (roles.paused()) revert Errors.SystemPaused();
    }

    /// @dev Common checks for revocations (allowed while paused: revoking only makes the system safer).
    function _checkRevocation(Attestation calldata attestation) internal view {
        if (attestation.schema != SCHEMA_UID) revert Errors.WrongSchema();
    }
}
