// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {DeliveryEvidenceResolver} from "../src/resolvers/DeliveryEvidenceResolver.sol";
import {DeliveryVerifiedResolver} from "../src/resolvers/DeliveryVerifiedResolver.sol";
import {FiatDonationResolver} from "../src/resolvers/FiatDonationResolver.sol";
import {ImpactReportResolver} from "../src/resolvers/ImpactReportResolver.sol";
import {NeedVerifiedResolver} from "../src/resolvers/NeedVerifiedResolver.sol";
import {DeploymentIO} from "./lib/DeploymentIO.sol";
import {ISchemaRegistry} from "@ethereum-attestation-service/eas-contracts/contracts/ISchemaRegistry.sol";
import {ISchemaResolver} from "@ethereum-attestation-service/eas-contracts/contracts/resolver/ISchemaResolver.sol";
import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";

/// @title RegisterSchemas
/// @notice Registers the five Proof of Aid schemas with their resolvers and records the UIDs in
///         `deployments/<network>.json`.
/// @dev Idempotent: a schema that already exists (same string + resolver + revocable flag) is skipped, because
///      its UID is a pure function of those three values — the same reason each resolver can derive the UID it
///      accepts without being told.
///
///      forge script script/RegisterSchemas.s.sol --rpc-url base_sepolia --broadcast
contract RegisterSchemas is Script, DeploymentIO {
    function run() external {
        string memory deployment = _readDeployment();
        ISchemaRegistry registry = ISchemaRegistry(_readAddress(deployment, ".external.SchemaRegistry"));

        NeedVerifiedResolver needVerified =
            NeedVerifiedResolver(payable(_readAddress(deployment, ".contracts.NeedVerifiedResolver")));
        DeliveryEvidenceResolver evidence =
            DeliveryEvidenceResolver(payable(_readAddress(deployment, ".contracts.DeliveryEvidenceResolver")));
        DeliveryVerifiedResolver verified =
            DeliveryVerifiedResolver(payable(_readAddress(deployment, ".contracts.DeliveryVerifiedResolver")));
        FiatDonationResolver fiat =
            FiatDonationResolver(payable(_readAddress(deployment, ".contracts.FiatDonationResolver")));
        ImpactReportResolver impact =
            ImpactReportResolver(payable(_readAddress(deployment, ".contracts.ImpactReportResolver")));

        uint256 deployerKey = vm.envOr("DEPLOYER_PRIVATE_KEY", uint256(0));
        if (deployerKey != 0) vm.startBroadcast(deployerKey);
        else vm.startBroadcast();

        bytes32 needVerifiedUID =
            _register(registry, needVerified.SCHEMA(), address(needVerified), needVerified.REVOCABLE());
        bytes32 evidenceUID = _register(registry, evidence.SCHEMA(), address(evidence), evidence.REVOCABLE());
        bytes32 verifiedUID = _register(registry, verified.SCHEMA(), address(verified), verified.REVOCABLE());
        bytes32 fiatUID = _register(registry, fiat.SCHEMA(), address(fiat), fiat.REVOCABLE());
        bytes32 impactUID = _register(registry, impact.SCHEMA(), address(impact), impact.REVOCABLE());

        vm.stopBroadcast();

        // Each resolver only accepts attestations under the UID it derived from its own address.
        require(needVerifiedUID == needVerified.SCHEMA_UID(), "NeedVerified UID mismatch");
        require(evidenceUID == evidence.SCHEMA_UID(), "DeliveryEvidence UID mismatch");
        require(verifiedUID == verified.SCHEMA_UID(), "DeliveryVerified UID mismatch");
        require(fiatUID == fiat.SCHEMA_UID(), "FiatDonation UID mismatch");
        require(impactUID == impact.SCHEMA_UID(), "ImpactReport UID mismatch");

        string memory path = _deploymentPath();
        vm.writeJson(vm.toString(needVerifiedUID), path, ".schemas.NeedVerified");
        vm.writeJson(vm.toString(evidenceUID), path, ".schemas.DeliveryEvidence");
        vm.writeJson(vm.toString(verifiedUID), path, ".schemas.DeliveryVerified");
        vm.writeJson(vm.toString(fiatUID), path, ".schemas.FiatDonation");
        vm.writeJson(vm.toString(impactUID), path, ".schemas.ImpactReport");

        console2.log("");
        console2.log("Schemas registered and written to", path);
        _logSchema("NeedVerified", needVerifiedUID);
        _logSchema("DeliveryEvidence", evidenceUID);
        _logSchema("DeliveryVerified", verifiedUID);
        _logSchema("FiatDonation", fiatUID);
        _logSchema("ImpactReport", impactUID);
    }

    function _register(ISchemaRegistry registry, string memory schema, address resolver, bool revocable)
        internal
        returns (bytes32 uid)
    {
        uid = keccak256(abi.encodePacked(schema, resolver, revocable));
        if (registry.getSchema(uid).uid == uid) {
            console2.log("already registered, skipping:", schema);
            return uid;
        }
        uid = registry.register(schema, ISchemaResolver(resolver), revocable);
    }

    function _logSchema(string memory name, bytes32 uid) internal pure {
        console2.log(string.concat("  ", name), vm.toString(uid));
    }
}
