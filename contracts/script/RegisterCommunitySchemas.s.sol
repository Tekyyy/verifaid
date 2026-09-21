// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {DeploymentIO} from "./lib/DeploymentIO.sol";
import {ISchemaRegistry} from "@ethereum-attestation-service/eas-contracts/contracts/ISchemaRegistry.sol";
import {ISchemaResolver} from "@ethereum-attestation-service/eas-contracts/contracts/resolver/ISchemaResolver.sol";
import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";

/// @title RegisterCommunitySchemas
/// @notice Registers the schemas that have **no resolver**: an NGO publishing photos of the work it did, and a
///         supplier asking to be registered. Nothing on-chain reads them and nobody's money depends on them, so
///         they are deliberately open — anyone can attest one, and the indexer decides what counts (a photo
///         attestation is kept only when the need's own NGO signed it; an application is only ever a request).
/// @dev Idempotent, like RegisterSchemas: the UID is keccak256(schema, resolver, revocable).
///
///      forge script script/RegisterCommunitySchemas.s.sol --rpc-url base_sepolia --broadcast
contract RegisterCommunitySchemas is Script, DeploymentIO {
    string[5] internal NAMES =
        ["WorkPhotos", "SupplierApplication", "NeedPresentation", "OrgTaxStatus", "DonationAcknowledged"];
    string[5] internal SCHEMAS = [
        "uint256 needId,string[] photos,string note",
        "address supplier,string name,string services,string uri,bytes32 credentialHash",
        "uint256 needId,string coverImage,string[] gallery,string summary,string[] tags",
        "address org,string jurisdiction,string taxId,string legalName,string source",
        "uint256 receiptId,uint256 needId,bytes32 documentHash,string statement"
    ];

    function run() external {
        string memory deployment = _readDeployment();
        ISchemaRegistry registry = ISchemaRegistry(_readAddress(deployment, ".external.SchemaRegistry"));

        uint256 deployerKey = vm.envOr("DEPLOYER_PRIVATE_KEY", uint256(0));
        if (deployerKey != 0) vm.startBroadcast(deployerKey);
        else vm.startBroadcast();

        bytes32[5] memory uids;
        for (uint256 i; i < NAMES.length; ++i) {
            uids[i] = _register(registry, SCHEMAS[i]);
        }

        vm.stopBroadcast();

        string memory path = _deploymentPath();
        console2.log("");
        console2.log("Community schemas registered and written to", path);
        for (uint256 i; i < NAMES.length; ++i) {
            vm.writeJson(vm.toString(uids[i]), path, string.concat(".communitySchemas.", NAMES[i]));
            console2.log(string.concat("  ", NAMES[i]), vm.toString(uids[i]));
        }
    }

    function _register(ISchemaRegistry registry, string memory schema) internal returns (bytes32 uid) {
        uid = keccak256(abi.encodePacked(schema, address(0), true));
        if (registry.getSchema(uid).uid == uid) {
            console2.log("already registered, skipping:", schema);
            return uid;
        }
        uid = registry.register(schema, ISchemaResolver(address(0)), true);
    }
}
