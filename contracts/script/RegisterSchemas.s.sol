// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ProofOfAidResolver} from "../src/resolvers/ProofOfAidResolver.sol";
import {DeploymentIO} from "./lib/DeploymentIO.sol";
import {ISchemaRegistry} from "@ethereum-attestation-service/eas-contracts/contracts/ISchemaRegistry.sol";
import {ISchemaResolver} from "@ethereum-attestation-service/eas-contracts/contracts/resolver/ISchemaResolver.sol";
import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";

/// @title RegisterSchemas
/// @notice Registers the six Proof of Aid schemas against the single resolver and records the UIDs in
///         `deployments/<network>.json`.
/// @dev Idempotent: a schema that already exists (same string + resolver + revocable flag) is skipped, because
///      its UID is a pure function of those three values — the same reason the resolver can derive the UIDs it
///      accepts without being told.
///
///      forge script script/RegisterSchemas.s.sol --rpc-url base_sepolia --broadcast
contract RegisterSchemas is Script, DeploymentIO {
    /// @dev Deployment-file keys, in `ProofOfAidResolver.schemaAt` order.
    string[6] internal NAMES =
        ["NeedVerified", "FundingRecorded", "DeliveryEvidence", "DeliveryVerified", "Settlement", "ImpactReport"];

    function run() external {
        string memory deployment = _readDeployment();
        ISchemaRegistry registry = ISchemaRegistry(_readAddress(deployment, ".external.SchemaRegistry"));
        ProofOfAidResolver resolver =
            ProofOfAidResolver(payable(_readAddress(deployment, ".contracts.ProofOfAidResolver")));

        uint256 deployerKey = vm.envOr("DEPLOYER_PRIVATE_KEY", uint256(0));
        if (deployerKey != 0) vm.startBroadcast(deployerKey);
        else vm.startBroadcast();

        bytes32[6] memory uids;
        for (uint256 i; i < NAMES.length; ++i) {
            (string memory schema, bool revocable, bytes32 expected) = resolver.schemaAt(i);
            uids[i] = _register(registry, schema, address(resolver), revocable);
            // The resolver only accepts attestations under the UIDs it derived from its own address.
            require(uids[i] == expected, string.concat(NAMES[i], " UID mismatch"));
        }

        vm.stopBroadcast();

        string memory path = _deploymentPath();
        console2.log("");
        console2.log("Schemas registered and written to", path);
        for (uint256 i; i < NAMES.length; ++i) {
            vm.writeJson(vm.toString(uids[i]), path, string.concat(".schemas.", NAMES[i]));
            console2.log(string.concat("  ", NAMES[i]), vm.toString(uids[i]));
        }
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
}
