// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IDeliveryManager} from "../interfaces/IDeliveryManager.sol";
import {INeedsRegistry} from "../interfaces/INeedsRegistry.sol";
import {IRoleRegistry} from "../interfaces/IRoleRegistry.sol";
import {Errors} from "../libraries/Errors.sol";
import {ProofOfAidResolver} from "./ProofOfAidResolver.sol";
import {Attestation, IEAS} from "@ethereum-attestation-service/eas-contracts/contracts/IEAS.sol";

/// @title DeliveryVerifiedResolver
/// @notice Resolver for `DeliveryVerified` sign-offs by independent verifiers.
/// @dev `refUID` must point at the delivery's `DeliveryEvidence` attestation, building a traversable evidence chain.
contract DeliveryVerifiedResolver is ProofOfAidResolver {
    string public constant SCHEMA = "uint256 deliveryId,bool approved,bytes32 reportHash";
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

    function onAttest(Attestation calldata attestation, uint256) internal override returns (bool) {
        _checkAttestation(attestation);
        (uint256 deliveryId, bool approved,) = abi.decode(attestation.data, (uint256, bool, bytes32));

        if (attestation.recipient != address(deliveryManager)) revert Errors.InvalidRecipient();
        IDeliveryManager.Delivery memory d = deliveryManager.getDelivery(deliveryId);
        if (d.evidenceAttestationUID == bytes32(0)) revert Errors.EvidenceMissing();
        if (attestation.refUID != d.evidenceAttestationUID) revert Errors.InvalidRefUID();
        if (d.status != IDeliveryManager.DeliveryStatus.Open) revert Errors.InvalidDeliveryStatus();
        if (!roles.isIndependent(attestation.attester, registry.ngoOf(d.needId))) revert Errors.NotIndependent();

        deliveryManager.onDeliveryVerified(deliveryId, attestation.attester, approved, attestation.uid);
        return true;
    }

    /// @dev Delivery sign-offs are irrevocable; disagreement goes through `DeliveryManager.challenge`.
    function onRevoke(Attestation calldata, uint256) internal pure override returns (bool) {
        revert Errors.NotRevocable();
    }
}
