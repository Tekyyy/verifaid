// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {DeploymentIO} from "./lib/DeploymentIO.sol";
import {SemaphoreDeployer} from "./lib/SemaphoreDeployer.sol";
import {SystemDeployer} from "./lib/SystemDeployer.sol";
import {Script} from "forge-std/Script.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {console2} from "forge-std/console2.sol";

/// @title Deploy
/// @notice Deploys and wires the whole Proof of Aid system, reusing the external contracts that already exist on
///         the target chain (EAS, SchemaRegistry, Semaphore v4, a stablecoin) and deploying local stand-ins for
///         whichever of them is missing — which is what makes the same script work on anvil and on Base Sepolia.
/// @dev Writes `deployments/<network>.json`. Run `RegisterSchemas.s.sol` next to fill in the schema UIDs.
///
///      forge script script/Deploy.s.sol --rpc-url base_sepolia --broadcast --verify
contract Deploy is Script, SystemDeployer, SemaphoreDeployer, DeploymentIO {
    using stdJson for string;

    function run() external {
        uint256 deployerKey = vm.envOr("DEPLOYER_PRIVATE_KEY", uint256(0));
        address deployer = deployerKey != 0 ? vm.addr(deployerKey) : msg.sender;

        Params memory params = Params({
            admin: deployer,
            token: vm.envOr("STABLECOIN_ADDRESS", address(0)),
            eas: vm.envOr("EAS_ADDRESS", address(0)),
            semaphore: vm.envOr("SEMAPHORE_ADDRESS", address(0)),
            highValueThreshold: vm.envOr("HIGH_VALUE_THRESHOLD", uint256(10_000e6)),
            confirmationThresholdBps: uint16(vm.envOr("CONFIRMATION_THRESHOLD_BPS", uint256(7000))),
            challengePeriod: uint64(vm.envOr("CHALLENGE_PERIOD_SECONDS", uint256(600))),
            minExpectedRecipients: uint32(vm.envOr("MIN_EXPECTED_RECIPIENTS", uint256(5))),
            dashboardBaseURI: vm.envOr("DASHBOARD_BASE_URI", string("http://localhost:3000/needs/"))
        });

        address schemaRegistry = vm.envOr("SCHEMA_REGISTRY_ADDRESS", address(0));
        address semaphoreVerifier;
        uint256 startBlock = block.number;

        if (deployerKey != 0) vm.startBroadcast(deployerKey);
        else vm.startBroadcast();

        // ── external dependencies: reuse what exists, deploy what does not ──
        if (params.eas.code.length == 0 || schemaRegistry.code.length == 0) {
            console2.log("EAS not found on this chain, deploying a local instance");
            (schemaRegistry, params.eas) = _deployLocalEAS();
        }
        if (params.semaphore.code.length == 0) {
            console2.log("Semaphore not found on this chain, deploying a local instance");
            (params.semaphore, semaphoreVerifier) = _deployLocalSemaphore();
        }

        System memory s = _deploySystem(params);

        vm.stopBroadcast();

        _log(s, params, schemaRegistry, deployer);
        _write(s, params, schemaRegistry, semaphoreVerifier, deployer, startBlock);
    }

    function _log(System memory s, Params memory params, address schemaRegistry, address deployer) internal pure {
        console2.log("");
        console2.log("Proof of Aid deployed");
        console2.log("  deployer / admin     ", deployer);
        console2.log("  RoleRegistry         ", address(s.roles));
        console2.log("  NeedsRegistry        ", address(s.registry));
        console2.log("  AidVaultFactory      ", address(s.factory));
        console2.log("  DonationReceipt      ", address(s.receipt));
        console2.log("  BeneficiaryGroups    ", address(s.groups));
        console2.log("  DeliveryManager      ", address(s.deliveryManager));
        console2.log("  token                ", s.token);
        console2.log("  EAS / SchemaRegistry ", params.eas, schemaRegistry);
        console2.log("  Semaphore            ", params.semaphore);
    }

    function _write(
        System memory s,
        Params memory params,
        address schemaRegistry,
        address semaphoreVerifier,
        address deployer,
        uint256 startBlock
    ) internal {
        string memory contracts = "contracts";
        contracts.serialize("RoleRegistry", address(s.roles));
        contracts.serialize("NeedsRegistry", address(s.registry));
        contracts.serialize("AidVaultImplementation", address(s.vaultImplementation));
        contracts.serialize("AidVaultFactory", address(s.factory));
        contracts.serialize("DonationReceipt", address(s.receipt));
        contracts.serialize("BeneficiaryGroups", address(s.groups));
        contracts.serialize("DeliveryManager", address(s.deliveryManager));
        contracts.serialize("NeedVerifiedResolver", address(s.needVerifiedResolver));
        contracts.serialize("DeliveryEvidenceResolver", address(s.evidenceResolver));
        contracts.serialize("DeliveryVerifiedResolver", address(s.deliveryVerifiedResolver));
        contracts.serialize("FiatDonationResolver", address(s.fiatDonationResolver));
        string memory contractsJson = contracts.serialize("ImpactReportResolver", address(s.impactReportResolver));

        string memory external_ = "external";
        external_.serialize("EAS", params.eas);
        external_.serialize("SchemaRegistry", schemaRegistry);
        external_.serialize("Semaphore", params.semaphore);
        external_.serialize("SemaphoreVerifier", semaphoreVerifier);
        string memory externalJson = external_.serialize("Token", s.token);

        string memory protocolParams = "params";
        protocolParams.serialize("confirmationThresholdBps", uint256(params.confirmationThresholdBps));
        protocolParams.serialize("challengePeriodSeconds", uint256(params.challengePeriod));
        protocolParams.serialize("highValueThreshold", params.highValueThreshold);
        protocolParams.serialize("minExpectedRecipients", uint256(params.minExpectedRecipients));
        string memory paramsJson = protocolParams.serialize("dashboardBaseURI", params.dashboardBaseURI);

        // Placeholders; RegisterSchemas.s.sol fills these in.
        string memory schemas = "schemas";
        schemas.serialize("NeedVerified", bytes32(0));
        schemas.serialize("DeliveryEvidence", bytes32(0));
        schemas.serialize("DeliveryVerified", bytes32(0));
        schemas.serialize("FiatDonation", bytes32(0));
        string memory schemasJson = schemas.serialize("ImpactReport", bytes32(0));

        string memory root = "deployment";
        root.serialize("network", _networkName(block.chainid));
        root.serialize("chainId", block.chainid);
        root.serialize("startBlock", startBlock);
        root.serialize("deployer", deployer);
        root.serialize("admin", params.admin);
        root.serialize("contracts", contractsJson);
        root.serialize("external", externalJson);
        root.serialize("params", paramsJson);
        string memory json = root.serialize("schemas", schemasJson);

        vm.writeJson(json, _deploymentPath());
        console2.log("");
        console2.log("Wrote", _deploymentPath());
    }
}
