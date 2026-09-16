// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IDeliveryManager} from "../interfaces/IDeliveryManager.sol";
import {INeedsRegistry} from "../interfaces/INeedsRegistry.sol";
import {IRoleRegistry} from "../interfaces/IRoleRegistry.sol";
import {Errors} from "../libraries/Errors.sol";
import {ProofOfAidResolver} from "./ProofOfAidResolver.sol";
import {Attestation, IEAS} from "@ethereum-attestation-service/eas-contracts/contracts/IEAS.sol";

/// @title ImpactReportResolver
/// @notice Resolver for `ImpactReport` attestations published by the NGO once a need is completed.
/// @dev `refUID` must equal the DeliveryVerified UID of the need's last finalized delivery (or be empty if the need
///      had a single tranche and therefore no deliveries). One live report per need; revoke to publish a correction.
contract ImpactReportResolver is ProofOfAidResolver {
    string public constant SCHEMA = "uint256 needId,uint32 beneficiariesServed,bytes32 kpiHash,string reportCID";
    bool public constant REVOCABLE = true;

    INeedsRegistry public immutable registry;
    IDeliveryManager public immutable deliveryManager;

    /// @notice needId => UID of the live (non-revoked) impact report.
    mapping(uint256 => bytes32) public activeReportOf;

    event ImpactReportLinked(uint256 indexed needId, bytes32 attestationUID, uint32 beneficiariesServed);
    event ImpactReportRevoked(uint256 indexed needId, bytes32 attestationUID);

    constructor(IEAS eas, IRoleRegistry roles_, INeedsRegistry registry_, IDeliveryManager deliveryManager_)
        ProofOfAidResolver(eas, roles_, SCHEMA, REVOCABLE)
    {
        if (address(registry_) == address(0) || address(deliveryManager_) == address(0)) {
            revert Errors.ZeroAddress();
        }
        registry = registry_;
        deliveryManager = deliveryManager_;
    }

    function onAttest(Attestation calldata attestation, uint256) internal override returns (bool) {
        _checkAttestation(attestation);
        (uint256 needId, uint32 beneficiariesServed, bytes32 kpiHash, string memory reportCID) =
            abi.decode(attestation.data, (uint256, uint32, bytes32, string));

        if (attestation.attester != registry.ngoOf(needId)) revert Errors.Unauthorized();
        if (registry.statusOf(needId) != INeedsRegistry.NeedStatus.Completed) revert Errors.InvalidNeedStatus();
        if (attestation.recipient != registry.vaultOf(needId)) revert Errors.InvalidRecipient();
        if (kpiHash == bytes32(0) || bytes(reportCID).length == 0) revert Errors.InvalidParameter();
        // The same k-anonymity floor that `openDelivery` enforces: publishing "2 beneficiaries served" for a
        // known category and region is a small-count disclosure about identifiable people.
        if (beneficiariesServed < deliveryManager.minExpectedRecipients()) revert Errors.TooFewRecipients();
        if (attestation.refUID != _expectedRefUID(needId)) revert Errors.InvalidRefUID();
        if (activeReportOf[needId] != bytes32(0)) revert Errors.ReportAlreadyActive();

        activeReportOf[needId] = attestation.uid;
        emit ImpactReportLinked(needId, attestation.uid, beneficiariesServed);
        return true;
    }

    function onRevoke(Attestation calldata attestation, uint256) internal override returns (bool) {
        _checkRevocation(attestation);
        (uint256 needId,,,) = abi.decode(attestation.data, (uint256, uint32, bytes32, string));
        if (activeReportOf[needId] == attestation.uid) {
            delete activeReportOf[needId];
            emit ImpactReportRevoked(needId, attestation.uid);
        }
        return true;
    }

    function _expectedRefUID(uint256 needId) internal view returns (bytes32) {
        uint256 lastDelivery = deliveryManager.lastFinalizedDeliveryOf(needId);
        return lastDelivery == 0 ? bytes32(0) : deliveryManager.getDelivery(lastDelivery).verifierAttestationUID;
    }
}
