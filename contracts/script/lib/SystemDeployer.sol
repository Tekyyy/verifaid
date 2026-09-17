// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {RoleRegistry} from "../../src/access/RoleRegistry.sol";
import {ConversionRouter} from "../../src/conversion/ConversionRouter.sol";
import {DeliveryManager} from "../../src/delivery/DeliveryManager.sol";
import {IV3SwapRouter} from "../../src/external/IV3SwapRouter.sol";
import {IWETH9} from "../../src/external/IWETH9.sol";
import {AidVault} from "../../src/funds/AidVault.sol";
import {AidVaultFactory} from "../../src/funds/AidVaultFactory.sol";
import {DonationForwarder} from "../../src/funds/DonationForwarder.sol";
import {DonationForwarderFactory} from "../../src/funds/DonationForwarderFactory.sol";
import {DonationReceipt} from "../../src/funds/DonationReceipt.sol";
import {NonCustodialLedger} from "../../src/funds/NonCustodialLedger.sol";
import {BeneficiaryGroups} from "../../src/identity/BeneficiaryGroups.sol";
import {IAidVaultFactory} from "../../src/interfaces/IAidVaultFactory.sol";
import {IConversionRouter} from "../../src/interfaces/IConversionRouter.sol";
import {IDonationForwarderFactory} from "../../src/interfaces/IDonationForwarderFactory.sol";
import {IDonationReceipt} from "../../src/interfaces/IDonationReceipt.sol";
import {IFeeRecorder} from "../../src/interfaces/IFeeRecorder.sol";
import {INeedsRegistry} from "../../src/interfaces/INeedsRegistry.sol";
import {IRoleRegistry} from "../../src/interfaces/IRoleRegistry.sol";
import {MockEURC} from "../../src/mocks/MockEURC.sol";
import {MockSwapRouter} from "../../src/mocks/MockSwapRouter.sol";
import {MockUSDC} from "../../src/mocks/MockUSDC.sol";
import {MockV3Aggregator} from "../../src/mocks/MockV3Aggregator.sol";
import {MockWETH9} from "../../src/mocks/MockWETH9.sol";
import {NeedsRegistry} from "../../src/needs/NeedsRegistry.sol";
import {ProofOfAidResolver} from "../../src/resolvers/ProofOfAidResolver.sol";
import {IEAS} from "@ethereum-attestation-service/eas-contracts/contracts/IEAS.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ISemaphore} from "@semaphore-protocol/contracts/interfaces/ISemaphore.sol";
import {CommonBase} from "forge-std/Base.sol";

/// @title SystemDeployer
/// @notice Single source of truth for deploying and wiring the whole Proof of Aid system.
/// @dev Shared by `Deploy.s.sol` and the Foundry test fixtures so tests exercise the deployed topology.
///      The caller must be the admin (broadcaster or pranked account) because `wire` and the router configuration
///      are admin-gated.
abstract contract SystemDeployer is CommonBase {
    /// @dev Published EAS artifacts; EAS pins solc 0.8.29 so its bytecode is deployed rather than recompiled.
    string internal constant EAS_ARTIFACT =
        "node_modules/@ethereum-attestation-service/eas-contracts/artifacts/contracts/EAS.sol/EAS.json";
    string internal constant SCHEMA_REGISTRY_ARTIFACT =
        "node_modules/@ethereum-attestation-service/eas-contracts/artifacts/contracts/SchemaRegistry.sol/SchemaRegistry.json";

    /// @dev Demo prices for the mock feeds: 1 EUR = 1.08 USD, 1 USDC = 1 USD, 1 ETH = 2,500 USD (8 decimals).
    int256 internal constant MOCK_EUR_USD = 1.08e8;
    int256 internal constant MOCK_USDC_USD = 1e8;
    int256 internal constant MOCK_ETH_USD = 2500e8;

    struct Params {
        address admin;
        address token; // zero → deploy MockEURC
        address eas;
        address semaphore;
        uint256 highValueThreshold;
        uint16 confirmationThresholdBps;
        uint64 challengePeriod;
        uint32 minExpectedRecipients;
        string dashboardBaseURI;
        ConversionParams conversion;
    }

    /// @notice External DeFi the conversion path uses; any zero address gets a local mock instead.
    struct ConversionParams {
        address swapRouter; // Uniswap SwapRouter02
        address weth;
        address usdc;
        address eurUsdFeed; // prices the vault token (EURC ≈ EUR)
        address usdcUsdFeed;
        address ethUsdFeed;
        address sequencerUptimeFeed; // zero → no sequencer check (test networks)
        uint16 maxSlippageBps;
        uint24 usdcToTokenFee; // pool fee tier USDC → vault token (0 → 0.01%)
        uint24 wethToUsdcFee; // pool fee tier WETH → USDC (0 → 0.05%)
        bool ethRoute; // configure ETH donations (needs WETH liquidity on the target chain)
        // Maximum answer age per feed. EUR/USD pauses over forex weekends, so its window must span one.
        uint32 eurHeartbeat;
        uint32 usdcHeartbeat;
        uint32 ethHeartbeat;
    }

    struct System {
        RoleRegistry roles;
        NeedsRegistry registry;
        AidVault vaultImplementation;
        NonCustodialLedger ledgerImplementation;
        AidVaultFactory factory;
        DonationReceipt receipt;
        BeneficiaryGroups groups;
        DeliveryManager deliveryManager;
        ProofOfAidResolver resolver;
        ConversionRouter router;
        DonationForwarder forwarderImplementation;
        DonationForwarderFactory forwarderFactory;
        address token;
        address eas;
        address semaphore;
        Conversion conversion;
    }

    /// @notice The external (or mock) DeFi contracts the router was configured with.
    struct Conversion {
        address swapRouter;
        address weth;
        address usdc;
        address eurUsdFeed;
        address usdcUsdFeed;
        address ethUsdFeed;
        address sequencerUptimeFeed;
        bool mocks;
    }

    /// @dev Deploys every contract and wires them together. Must be called by `p.admin`.
    ///      Order matters: the ledger implementations take the factory, receipt, resolver and forwarder factory as
    ///      immutables, so those exist first and the vault factory learns the implementations through `wire`.
    function _deploySystem(Params memory p) internal returns (System memory s) {
        s.eas = p.eas;
        s.semaphore = p.semaphore;
        s.token = p.token == address(0) ? address(new MockEURC()) : p.token;
        IRoleRegistry roles = IRoleRegistry(address(s.roles = new RoleRegistry(p.admin)));

        s.registry = new NeedsRegistry(roles, p.highValueThreshold);
        s.groups = new BeneficiaryGroups(roles, ISemaphore(p.semaphore));
        s.deliveryManager = new DeliveryManager(
            roles,
            INeedsRegistry(address(s.registry)),
            s.groups,
            p.confirmationThresholdBps,
            p.challengePeriod,
            p.minExpectedRecipients
        );
        s.resolver = new ProofOfAidResolver(IEAS(p.eas), roles, INeedsRegistry(address(s.registry)), s.deliveryManager);
        s.factory = new AidVaultFactory(roles);
        s.receipt = new DonationReceipt(roles, IAidVaultFactory(address(s.factory)), p.dashboardBaseURI);

        _deployConversion(p, s);

        s.vaultImplementation = new AidVault(
            roles,
            INeedsRegistry(address(s.registry)),
            address(s.deliveryManager),
            IAidVaultFactory(address(s.factory)),
            IERC20(s.token),
            IDonationReceipt(address(s.receipt)),
            IDonationForwarderFactory(address(s.forwarderFactory)),
            IFeeRecorder(address(s.resolver))
        );
        s.ledgerImplementation = new NonCustodialLedger(
            roles,
            INeedsRegistry(address(s.registry)),
            address(s.deliveryManager),
            IAidVaultFactory(address(s.factory)),
            address(s.resolver)
        );

        s.registry.wire(address(s.factory), address(s.groups), address(s.deliveryManager), address(s.resolver));
        s.factory.wire(address(s.registry), s.token, address(s.vaultImplementation), address(s.ledgerImplementation));
        s.groups.wire(address(s.deliveryManager));
        s.deliveryManager.wire(address(s.resolver));
    }

    /// @dev The router, the forwarder implementation and its factory, configured with feeds and routes.
    function _deployConversion(Params memory p, System memory s) internal {
        ConversionParams memory c = p.conversion;
        Conversion memory out = s.conversion;
        out.mocks = c.swapRouter == address(0);
        out.weth = c.weth == address(0) ? address(new MockWETH9()) : c.weth;
        out.usdc = c.usdc == address(0) ? address(new MockUSDC()) : c.usdc;
        out.eurUsdFeed = c.eurUsdFeed == address(0) ? _mockFeed(MOCK_EUR_USD, "EUR / USD") : c.eurUsdFeed;
        out.usdcUsdFeed = c.usdcUsdFeed == address(0) ? _mockFeed(MOCK_USDC_USD, "USDC / USD") : c.usdcUsdFeed;
        out.ethUsdFeed = c.ethUsdFeed == address(0) ? _mockFeed(MOCK_ETH_USD, "ETH / USD") : c.ethUsdFeed;
        out.sequencerUptimeFeed = c.sequencerUptimeFeed;
        out.swapRouter = out.mocks ? address(_mockSwapRouter(s.token, out)) : c.swapRouter;

        s.router = new ConversionRouter(
            IRoleRegistry(address(s.roles)), IV3SwapRouter(out.swapRouter), IWETH9(out.weth), c.maxSlippageBps
        );
        s.router.setPriceFeed(s.token, out.eurUsdFeed, c.eurHeartbeat == 0 ? 3 days : c.eurHeartbeat);
        s.router.setPriceFeed(out.usdc, out.usdcUsdFeed, c.usdcHeartbeat == 0 ? 1 days + 1 hours : c.usdcHeartbeat);
        s.router.setPriceFeed(s.router.NATIVE(), out.ethUsdFeed, c.ethHeartbeat == 0 ? 1 hours : c.ethHeartbeat);
        if (out.sequencerUptimeFeed != address(0)) s.router.setSequencerUptimeFeed(out.sequencerUptimeFeed);

        uint24 usdcFee = c.usdcToTokenFee == 0 ? 100 : c.usdcToTokenFee;
        uint24 wethFee = c.wethToUsdcFee == 0 ? 500 : c.wethToUsdcFee;
        s.router.setRoute(out.usdc, s.token, abi.encodePacked(out.usdc, usdcFee, s.token));
        if (c.ethRoute || out.mocks) {
            s.router.setRoute(out.weth, s.token, abi.encodePacked(out.weth, wethFee, out.usdc, usdcFee, s.token));
        }

        s.forwarderImplementation = new DonationForwarder(
            INeedsRegistry(address(s.registry)), IConversionRouter(address(s.router)), IERC20(s.token)
        );
        s.forwarderFactory = new DonationForwarderFactory(
            INeedsRegistry(address(s.registry)),
            IConversionRouter(address(s.router)),
            IERC20(s.token),
            address(s.forwarderImplementation)
        );
        s.conversion = out;
    }

    function _mockFeed(int256 answer, string memory description) internal returns (address) {
        return address(new MockV3Aggregator(8, answer, description));
    }

    /// @dev A swap router that fills at the mock oracle rates minus 0.05%, stocked with demo tokens.
    function _mockSwapRouter(address token, Conversion memory c) internal returns (MockSwapRouter router) {
        router = new MockSwapRouter();
        uint256 usdcToEur = (uint256(MOCK_USDC_USD) * 1e18) / uint256(MOCK_EUR_USD);
        router.setRate(c.usdc, token, usdcToEur);
        router.setRate(c.weth, token, (uint256(MOCK_ETH_USD) * 1e18) / uint256(MOCK_EUR_USD));
        MockEURC(token).mint(address(router), 10_000_000e6);
    }

    /// @dev Deploys EAS + SchemaRegistry from the published artifacts (local chains only).
    function _deployLocalEAS() internal returns (address schemaRegistry, address eas) {
        schemaRegistry = vm.deployCode(SCHEMA_REGISTRY_ARTIFACT);
        eas = vm.deployCode(EAS_ARTIFACT, abi.encode(schemaRegistry));
    }
}
