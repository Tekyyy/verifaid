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
            dashboardBaseURI: vm.envOr("DASHBOARD_BASE_URI", string("http://localhost:3000/needs/")),
            conversion: _conversionParams()
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

    /// @dev External DeFi for the conversion path. On anvil every address is unset, so mocks are deployed; on Base
    ///      Sepolia the real Uniswap v3 SwapRouter02, WETH and Chainlink feeds are passed in and only what does not
    ///      exist there (EUR/USD) is mocked. See scripts/deploy-sepolia.mjs.
    function _conversionParams() internal view returns (ConversionParams memory) {
        return ConversionParams({
            swapRouter: vm.envOr("SWAP_ROUTER_ADDRESS", address(0)),
            weth: vm.envOr("WETH_ADDRESS", address(0)),
            usdc: vm.envOr("USDC_ADDRESS", address(0)),
            eurUsdFeed: vm.envOr("EUR_USD_FEED", address(0)),
            usdcUsdFeed: vm.envOr("USDC_USD_FEED", address(0)),
            ethUsdFeed: vm.envOr("ETH_USD_FEED", address(0)),
            sequencerUptimeFeed: vm.envOr("SEQUENCER_UPTIME_FEED", address(0)),
            maxSlippageBps: uint16(vm.envOr("MAX_SLIPPAGE_BPS", uint256(100))),
            usdcToTokenFee: uint24(vm.envOr("USDC_POOL_FEE", uint256(100))),
            wethToUsdcFee: uint24(vm.envOr("WETH_POOL_FEE", uint256(500))),
            ethRoute: vm.envOr("ETH_ROUTE", false),
            eurHeartbeat: uint32(vm.envOr("EUR_USD_HEARTBEAT", uint256(0))),
            usdcHeartbeat: uint32(vm.envOr("USDC_USD_HEARTBEAT", uint256(0))),
            ethHeartbeat: uint32(vm.envOr("ETH_USD_HEARTBEAT", uint256(0)))
        });
    }

    function _log(System memory s, Params memory params, address schemaRegistry, address deployer) internal pure {
        console2.log("");
        console2.log("Proof of Aid deployed");
        console2.log("  deployer / admin     ", deployer);
        console2.log("  RoleRegistry         ", address(s.roles));
        console2.log("  NeedsRegistry        ", address(s.registry));
        console2.log("  AidVaultFactory      ", address(s.factory));
        console2.log("  ProofOfAidResolver   ", address(s.resolver));
        console2.log("  ConversionRouter     ", address(s.router));
        console2.log("  ForwarderFactory     ", address(s.forwarderFactory));
        console2.log("  swap router (mock?)  ", s.conversion.swapRouter, s.conversion.mocks);
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
        contracts.serialize("NonCustodialLedgerImplementation", address(s.ledgerImplementation));
        contracts.serialize("AidVaultFactory", address(s.factory));
        contracts.serialize("DonationReceipt", address(s.receipt));
        contracts.serialize("BeneficiaryGroups", address(s.groups));
        contracts.serialize("DeliveryManager", address(s.deliveryManager));
        contracts.serialize("ConversionRouter", address(s.router));
        contracts.serialize("DonationForwarderImplementation", address(s.forwarderImplementation));
        contracts.serialize("DonationForwarderFactory", address(s.forwarderFactory));
        string memory contractsJson = contracts.serialize("ProofOfAidResolver", address(s.resolver));

        string memory external_ = "external";
        external_.serialize("EAS", params.eas);
        external_.serialize("SchemaRegistry", schemaRegistry);
        external_.serialize("Semaphore", params.semaphore);
        external_.serialize("SemaphoreVerifier", semaphoreVerifier);
        external_.serialize("SwapRouter", s.conversion.swapRouter);
        external_.serialize("WETH", s.conversion.weth);
        external_.serialize("USDC", s.conversion.usdc);
        external_.serialize("EurUsdFeed", s.conversion.eurUsdFeed);
        external_.serialize("UsdcUsdFeed", s.conversion.usdcUsdFeed);
        external_.serialize("EthUsdFeed", s.conversion.ethUsdFeed);
        external_.serialize("SequencerUptimeFeed", s.conversion.sequencerUptimeFeed);
        string memory externalJson = external_.serialize("Token", s.token);

        string memory protocolParams = "params";
        protocolParams.serialize("confirmationThresholdBps", uint256(params.confirmationThresholdBps));
        protocolParams.serialize("challengePeriodSeconds", uint256(params.challengePeriod));
        protocolParams.serialize("highValueThreshold", params.highValueThreshold);
        protocolParams.serialize("minExpectedRecipients", uint256(params.minExpectedRecipients));
        protocolParams.serialize("maxSlippageBps", uint256(params.conversion.maxSlippageBps));
        protocolParams.serialize("mockSwapRouter", s.conversion.mocks);
        protocolParams.serialize("ethDonations", params.conversion.ethRoute || s.conversion.mocks);
        string memory paramsJson = protocolParams.serialize("dashboardBaseURI", params.dashboardBaseURI);

        // Placeholders; RegisterSchemas.s.sol fills these in.
        string memory schemas = "schemas";
        schemas.serialize("NeedVerified", bytes32(0));
        schemas.serialize("FundingRecorded", bytes32(0));
        schemas.serialize("DeliveryEvidence", bytes32(0));
        schemas.serialize("DeliveryVerified", bytes32(0));
        schemas.serialize("Settlement", bytes32(0));
        string memory schemasJson = schemas.serialize("ImpactReport", bytes32(0));

        string memory root = "deployment";
        root.serialize("network", _networkName(block.chainid));
        root.serialize("version", uint256(3));
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
