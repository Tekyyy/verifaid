// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {INeedsRegistry} from "../interfaces/INeedsRegistry.sol";
import {IRoleRegistry} from "../interfaces/IRoleRegistry.sol";
import {Errors} from "../libraries/Errors.sol";
import {ProofOfAidResolver} from "./ProofOfAidResolver.sol";
import {Attestation, IEAS} from "@ethereum-attestation-service/eas-contracts/contracts/IEAS.sol";

/// @title NeedVerifiedResolver
/// @notice Resolver for `NeedVerified` attestations made by independent verifiers.
contract NeedVerifiedResolver is ProofOfAidResolver {
    string public constant SCHEMA = "uint256 needId,bytes32 dossierHash,bool approved,bytes32 reportHash";
    bool public constant REVOCABLE = true;

    INeedsRegistry public immutable registry;

    constructor(IEAS eas, IRoleRegistry roles_, INeedsRegistry registry_)
        ProofOfAidResolver(eas, roles_, SCHEMA, REVOCABLE)
    {
        if (address(registry_) == address(0)) revert Errors.ZeroAddress();
        registry = registry_;
    }

    /// @dev attester must be independent of the need's NGO, dossier hash must match, need must be Pending,
    ///      and the attestation recipient must be the NeedsRegistry (never a person).
    function onAttest(Attestation calldata attestation, uint256) internal override returns (bool) {
        _checkAttestation(attestation);
        (uint256 needId, bytes32 dossierHash, bool approved,) =
            abi.decode(attestation.data, (uint256, bytes32, bool, bytes32));

        if (attestation.recipient != address(registry)) revert Errors.InvalidRecipient();
        if (registry.statusOf(needId) != INeedsRegistry.NeedStatus.Pending) revert Errors.InvalidNeedStatus();
        if (registry.dossierHashOf(needId) != dossierHash) revert Errors.DossierMismatch();
        if (!roles.isIndependent(attestation.attester, registry.ngoOf(needId))) revert Errors.NotIndependent();

        registry.onVerificationAttested(needId, attestation.attester, approved, attestation.uid);
        return true;
    }

    /// @dev Forwards to the registry, which decides whether the revocation changes state.
    function onRevoke(Attestation calldata attestation, uint256) internal override returns (bool) {
        _checkRevocation(attestation);
        (uint256 needId,,,) = abi.decode(attestation.data, (uint256, bytes32, bool, bytes32));
        registry.onVerificationRevoked(needId, attestation.attester, attestation.uid);
        return true;
    }
}
