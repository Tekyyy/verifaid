// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IDeliveryManager} from "../interfaces/IDeliveryManager.sol";
import {INeedsRegistry} from "../interfaces/INeedsRegistry.sol";
import {IRoleRegistry} from "../interfaces/IRoleRegistry.sol";
import {Errors} from "../libraries/Errors.sol";
import {ProofOfAidResolver} from "./ProofOfAidResolver.sol";
import {Attestation, IEAS} from "@ethereum-attestation-service/eas-contracts/contracts/IEAS.sol";

/// @title DeliveryEvidenceResolver
/// @notice Resolver for `DeliveryEvidence` attestations (encrypted evidence CID + ciphertext hash) by field agents.
contract DeliveryEvidenceResolver is ProofOfAidResolver {
    string public constant SCHEMA =
        "uint256 deliveryId,bytes32 evidenceHash,string evidenceCID,uint32 itemsDelivered,bytes32 regionCode";
    bool public constant REVOCABLE = false;

    IDeliveryManager public immutable deliveryManager;
    INeedsRegistry public immutable registry;

    constructor(IEAS eas, IRoleRegistry roles_, IDeliveryManager deliveryManager_, INeedsRegistry registry_)
        ProofOfAidResolver(eas, roles_, SCHEMA, REVOCABLE)
    {
        if (address(deliveryManager_) == address(0) || address(registry_) == address(0)) {
            revert Errors.ZeroAddress();
        }
        deliveryManager = deliveryManager_;
        registry = registry_;
    }

    /// @dev attester must be the delivery's field agent (still bound to the NGO), the delivery must be Open without
    ///      evidence, and the coarse region must match the need's region.
    function onAttest(Attestation calldata attestation, uint256) internal override returns (bool) {
        _checkAttestation(attestation);
        (
            uint256 deliveryId,
            bytes32 evidenceHash,
            string memory evidenceCID,
            uint32 itemsDelivered,
            bytes32 regionCode
        ) = abi.decode(attestation.data, (uint256, bytes32, string, uint32, bytes32));

        if (attestation.recipient != address(deliveryManager)) revert Errors.InvalidRecipient();
        if (evidenceHash == bytes32(0) || bytes(evidenceCID).length == 0 || itemsDelivered == 0) {
            revert Errors.InvalidParameter();
        }

        IDeliveryManager.Delivery memory d = deliveryManager.getDelivery(deliveryId);
        if (d.fieldAgent != attestation.attester) revert Errors.Unauthorized();
        if (!roles.isFieldAgentOf(attestation.attester, registry.ngoOf(d.needId))) revert Errors.Unauthorized();
        if (d.status != IDeliveryManager.DeliveryStatus.Open) revert Errors.InvalidDeliveryStatus();
        if (d.evidenceAttestationUID != bytes32(0)) revert Errors.EvidenceAlreadyLinked();
        if (regionCode != registry.regionCodeOf(d.needId)) revert Errors.RegionMismatch();

        deliveryManager.onEvidenceAttested(deliveryId, attestation.uid);
        return true;
    }

    /// @dev Evidence attestations are irrevocable.
    function onRevoke(Attestation calldata, uint256) internal pure override returns (bool) {
        revert Errors.NotRevocable();
    }
}
