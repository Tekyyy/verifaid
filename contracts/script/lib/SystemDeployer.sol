// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {RoleRegistry} from "../../src/access/RoleRegistry.sol";
import {BeneficiaryRegistry} from "../../src/beneficiaries/BeneficiaryRegistry.sol";
import {CommunityProofs} from "../../src/community/CommunityProofs.sol";
import {ConversionRouter} from "../../src/conversion/ConversionRouter.sol";
import {DeliveryManager} from "../../src/delivery/DeliveryManager.sol";
import {ReleasePolicy} from "../../src/delivery/ReleasePolicy.sol";
import {IV3SwapRouter} from "../../src/external/IV3SwapRouter.sol";
import {IWETH9} from "../../src/external/IWETH9.sol";
import {AidVault} from "../../src/funds/AidVault.sol";
import {AidVaultFactory} from "../../src/funds/AidVaultFactory.sol";
import {DonationForwarder} from "../../src/funds/DonationForwarder.sol";
import {DonationForwarderFactory} from "../../src/funds/DonationForwarderFactory.sol";
import {DonationReceipt} from "../../src/funds/DonationReceipt.sol";
import {IAidVaultFactory} from "../../src/interfaces/IAidVaultFactory.sol";
import {IConversionRouter} from "../../src/interfaces/IConversionRouter.sol";
import {IDonationForwarderFactory} from "../../src/interfaces/IDonationForwarderFactory.sol";
import {IDonationReceipt} from "../../src/interfaces/IDonationReceipt.sol";
import {IFeeRecorder} from "../../src/interfaces/IFeeRecorder.sol";
import {INeedsRegistry} from "../../src/interfaces/INeedsRegistry.sol";
import {IProgramRegistry} from "../../src/interfaces/IProgramRegistry.sol";
import {IRoleRegistry} from "../../src/interfaces/IRoleRegistry.sol";
import {MockEURC} from "../../src/mocks/MockEURC.sol";
import {MockSwapRouter} from "../../src/mocks/MockSwapRouter.sol";
import {MockUSDC} from "../../src/mocks/MockUSDC.sol";
import {MockV3Aggregator} from "../../src/mocks/MockV3Aggregator.sol";
import {MockWETH9} from "../../src/mocks/MockWETH9.sol";
import {MockYieldVault} from "../../src/mocks/MockYieldVault.sol";
import {NeedsRegistry} from "../../src/needs/NeedsRegistry.sol";
import {ProgramRegistry} from "../../src/programs/ProgramRegistry.sol";
import {ProofOfAidResolver} from "../../src/resolvers/ProofOfAidResolver.sol";
import {IEAS} from "@ethereum-attestation-service/eas-contracts/contracts/IEAS.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
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
        address token; // the vault currency; zero → deploy a MockUSDC (a USD-denominated deployment)
        // ERC-4626 vault where a need may let committed money wait; zero → a mock one on a test chain, and
        // nothing at all on mainnet, where the address of a real curated vault has to be passed in deliberately.
        address yieldVenue;
        uint16 yieldCapBps; // share of a need's pot allowed there at once; zero → 8000
        address eas;
        uint256 highValueThreshold;
        uint16 donorApprovalBps; // share of the raised amount whose donors must approve a delivery; zero → 3000
        uint16 donorRejectionBps; // share whose donors must reject it; zero → 5000
        // Fresh starts an NGO gets on rejected or contested evidence before a rejection cancels the need; the
        // deployer passes it as-is, so 0 (no second chance) is a real choice. The scripts default to 1.
        uint8 rejectionRetries;
        uint32 minBeneficiariesServed; // k-anonymity floor for impact reports
        string dashboardBaseURI;
        ConversionParams conversion;
    }

    /// @notice External DeFi the conversion path uses; any zero address gets a local mock instead.
    struct ConversionParams {
        address swapRouter; // Uniswap SwapRouter02
        address weth;
        address usdc; // zero → the vault token itself when that is a mock USDC, otherwise a MockUSDC
        address eurc; // the euro stablecoin donors may give instead; zero → a mock on test chains, none on mainnet
        address eurUsdFeed; // prices EURC
        address usdcUsdFeed;
        address ethUsdFeed;
        address sequencerUptimeFeed; // zero → no sequencer check (test networks)
        uint16 maxSlippageBps; // oracle bound of the stablecoin route into the vault token
        uint16 ethMaxSlippageBps; // oracle bound of the ETH route, two hops through volatile pools (0 → 1.5%)
        uint24 usdcToTokenFee; // pool fee tier stablecoin → vault token (0 → 0.05%, the liquid EURC/USDC pool)
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
        AidVaultFactory factory;
        DonationReceipt receipt;
        ProgramRegistry programs;
        /// @notice Where a beneficiary an NGO certified posts a need of their own.
        BeneficiaryRegistry beneficiaries;
        /// @notice Proof of delivery from anyone, and the reward pots NGOs fund for it.
        CommunityProofs communityProofs;
        DeliveryManager deliveryManager;
        /// @notice The built-in release policies: donors decide (the default), a verifier checks, or both.
        ReleasePolicy donorPolicy;
        ReleasePolicy verifierPolicy;
        ReleasePolicy donorAndVerifierPolicy;
        ProofOfAidResolver resolver;
        ConversionRouter router;
        DonationForwarder forwarderImplementation;
        DonationForwarderFactory forwarderFactory;
        address token;
        address eas;
        /// @notice The ERC-4626 vault approved for idle capital, or zero where none is.
        address yieldVenue;
        Conversion conversion;
    }

    /// @notice The external (or mock) DeFi contracts the router was configured with.
    struct Conversion {
        address swapRouter;
        address weth;
        address usdc;
        address eurc;
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
        _requireRealDependencies(p);
        s.eas = p.eas;
        // A deployment holds one currency. USD by default: donors give USDC, which needs no conversion at all.
        s.token = p.token == address(0) ? address(new MockUSDC()) : p.token;
        IRoleRegistry roles = IRoleRegistry(address(s.roles = new RoleRegistry(p.admin)));

        s.registry = new NeedsRegistry(roles, p.highValueThreshold);
        s.programs = new ProgramRegistry(roles);
        s.beneficiaries =
            new BeneficiaryRegistry(roles, INeedsRegistry(address(s.registry)), IProgramRegistry(address(s.programs)));
        s.deliveryManager = new DeliveryManager(roles, INeedsRegistry(address(s.registry)));
        s.resolver =
            new ProofOfAidResolver(IEAS(p.eas), roles, INeedsRegistry(address(s.registry)), p.minBeneficiariesServed);
        s.factory = new AidVaultFactory(roles);
        s.receipt = new DonationReceipt(roles, IAidVaultFactory(address(s.factory)), p.dashboardBaseURI);

        _deployConversion(p, s);
        // After the donation factory, which splits and donates the reward credit people give away.
        s.communityProofs = new CommunityProofs(
            roles,
            INeedsRegistry(address(s.registry)),
            IERC20(s.token),
            IDonationForwarderFactory(address(s.forwarderFactory))
        );

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

        s.registry
            .wire(
                address(s.factory),
                address(s.programs),
                address(s.deliveryManager),
                address(s.resolver),
                address(s.beneficiaries)
            );
        _approveYieldVenue(s, p);
        _deployReleasePolicies(s, p);
        s.factory.wire(address(s.registry), s.token, address(s.vaultImplementation));
    }

    /// @dev The three built-in rules for releasing a tranche, all approved, donors-decide as the default. Donors
    ///      need more agreement to reject than to approve: approval releases one tranche, while rejections can end
    ///      the whole need.
    function _deployReleasePolicies(System memory s, Params memory p) internal {
        IRoleRegistry roles = IRoleRegistry(address(s.roles));
        INeedsRegistry registry = INeedsRegistry(address(s.registry));
        uint16 approval = p.donorApprovalBps == 0 ? 3000 : p.donorApprovalBps;
        uint16 rejection = p.donorRejectionBps == 0 ? 5000 : p.donorRejectionBps;
        uint8 retries = p.rejectionRetries;
        // Reward credit is donated in this contract's name and never votes, so no threshold counts it.
        address credit = address(s.communityProofs);
        s.donorPolicy = new ReleasePolicy(roles, registry, "Donors decide", approval, rejection, false, retries, credit);
        s.verifierPolicy = new ReleasePolicy(roles, registry, "A verifier checks", 0, 0, true, retries, credit);
        s.donorAndVerifierPolicy =
            new ReleasePolicy(roles, registry, "Donors and a verifier", approval, rejection, true, retries, credit);
        s.registry.setReleasePolicy(address(s.donorPolicy), true);
        s.registry.setReleasePolicy(address(s.verifierPolicy), true);
        s.registry.setReleasePolicy(address(s.donorAndVerifierPolicy), true);
        s.registry.setDefaultReleasePolicy(address(s.donorPolicy));
    }

    /// @dev The router, the forwarder implementation and its factory, configured with feeds and routes.
    function _deployConversion(Params memory p, System memory s) internal {
        ConversionParams memory c = p.conversion;
        Conversion memory out = s.conversion;
        out.mocks = c.swapRouter == address(0);
        out.weth = c.weth == address(0) ? address(new MockWETH9()) : c.weth;
        // The vault token is the chain's USDC unless the deployment was given a different currency to hold.
        out.usdc = c.usdc != address(0) ? c.usdc : (p.token == address(0) ? s.token : address(new MockUSDC()));
        // A vault currency that is not the chain's USDC is its euro stablecoin; otherwise EURC is the token donors
        // may give instead, mocked on test chains and optional on mainnet.
        out.eurc = c.eurc != address(0)
            ? c.eurc
            : (s.token != out.usdc ? s.token : (_mocksAllowed() ? address(new MockEURC()) : address(0)));
        out.eurUsdFeed = c.eurUsdFeed == address(0) ? _mockFeed(MOCK_EUR_USD, "EUR / USD") : c.eurUsdFeed;
        out.usdcUsdFeed = c.usdcUsdFeed == address(0) ? _mockFeed(MOCK_USDC_USD, "USDC / USD") : c.usdcUsdFeed;
        out.ethUsdFeed = c.ethUsdFeed == address(0) ? _mockFeed(MOCK_ETH_USD, "ETH / USD") : c.ethUsdFeed;
        out.sequencerUptimeFeed = c.sequencerUptimeFeed;
        out.swapRouter = out.mocks ? address(_mockSwapRouter(s.token, out)) : c.swapRouter;

        address[] memory hubs = new address[](2);
        (hubs[0], hubs[1]) = (out.usdc, out.weth);
        s.router = new ConversionRouter(
            IRoleRegistry(address(s.roles)), IV3SwapRouter(out.swapRouter), IWETH9(out.weth), hubs
        );
        s.router.setPriceFeed(out.usdc, out.usdcUsdFeed, c.usdcHeartbeat == 0 ? 1 days + 1 hours : c.usdcHeartbeat);
        // EUR/USD pauses over forex weekends, so its window must span one.
        if (out.eurc != address(0)) {
            s.router.setPriceFeed(out.eurc, out.eurUsdFeed, c.eurHeartbeat == 0 ? 3 days : c.eurHeartbeat);
        }
        require(s.token == out.usdc || s.token == out.eurc, "SystemDeployer: the vault currency needs a price feed");
        s.router.setPriceFeed(s.router.NATIVE(), out.ethUsdFeed, c.ethHeartbeat == 0 ? 1 hours : c.ethHeartbeat);
        if (out.sequencerUptimeFeed != address(0)) s.router.setSequencerUptimeFeed(out.sequencerUptimeFeed);

        uint24 usdcFee = c.usdcToTokenFee == 0 ? 500 : c.usdcToTokenFee;
        uint24 wethFee = c.wethToUsdcFee == 0 ? 500 : c.wethToUsdcFee;
        // The other stablecoin converts into the vault currency; the vault's own needs no route (it passes through).
        address other = s.token == out.usdc ? out.eurc : out.usdc;
        if (other != address(0)) {
            s.router.setRoute(other, s.token, abi.encodePacked(other, usdcFee, s.token), c.maxSlippageBps);
        }
        if (c.ethRoute || out.mocks) {
            bytes memory ethPath = s.token == out.usdc
                ? abi.encodePacked(out.weth, wethFee, s.token)
                : abi.encodePacked(out.weth, wethFee, out.usdc, usdcFee, s.token);
            s.router.setRoute(out.weth, s.token, ethPath, c.ethMaxSlippageBps == 0 ? 150 : c.ethMaxSlippageBps);
        }

        // The factory deploys the forwarder implementation itself, which is how every clone knows its factory.
        s.forwarderFactory = new DonationForwarderFactory(
            INeedsRegistry(address(s.registry)), IConversionRouter(address(s.router)), IERC20(s.token)
        );
        s.forwarderImplementation = DonationForwarder(payable(s.forwarderFactory.implementation()));
        s.conversion = out;
    }

    /// @dev Every unset dependency is replaced by a freely mintable or settable mock. That is the point on anvil and
    ///      on Base Sepolia (which lacks EUR/USD and liquid pools), and a catastrophe anywhere else.
    /// @dev Approves the one venue a need may let its idle escrow wait in. Nothing is opted in by this: an NGO
    ///      does that per need, before the need can take a donation. On mainnet a venue must be passed in — this
    ///      never invents one, because the address of a lending vault is not a thing to get from a default.
    function _approveYieldVenue(System memory s, Params memory p) internal {
        address venue = p.yieldVenue;
        if (venue == address(0)) {
            if (!_mocksAllowed()) return;
            venue = address(new MockYieldVault(IERC20(s.token)));
        }
        s.registry.setYieldVenue(venue, p.yieldCapBps == 0 ? 8000 : p.yieldCapBps);
        s.yieldVenue = venue;
    }

    function _mocksAllowed() internal view returns (bool) {
        return block.chainid == 31_337 || block.chainid == 84_532;
    }

    function _requireRealDependencies(Params memory p) internal view {
        if (_mocksAllowed()) return;
        ConversionParams memory c = p.conversion;
        require(
            p.token != address(0) && c.swapRouter != address(0) && c.weth != address(0) && c.usdc != address(0)
                && c.eurUsdFeed != address(0) && c.usdcUsdFeed != address(0) && c.ethUsdFeed != address(0)
                && c.sequencerUptimeFeed != address(0),
            "SystemDeployer: mocks are only deployed on anvil and Base Sepolia"
        );
    }

    function _mockFeed(int256 answer, string memory description) internal returns (address) {
        return address(new MockV3Aggregator(8, answer, description));
    }

    /// @dev A swap router that fills at the mock oracle rates minus 0.05%, stocked with demo tokens.
    function _mockSwapRouter(address token, Conversion memory c) internal returns (MockSwapRouter router) {
        router = new MockSwapRouter();
        // The vault currency's own USD price: what one unit of another token buys is its price divided by this.
        uint256 tokenUsd = uint256(token == c.usdc ? MOCK_USDC_USD : MOCK_EUR_USD);
        if (c.usdc != token) router.setRate(c.usdc, token, (uint256(MOCK_USDC_USD) * 1e18) / tokenUsd);
        if (c.eurc != address(0) && c.eurc != token) {
            router.setRate(c.eurc, token, (uint256(MOCK_EUR_USD) * 1e18) / tokenUsd);
        }
        router.setRate(c.weth, token, (uint256(MOCK_ETH_USD) * 1e18) / tokenUsd);
        MockUSDC(token).mint(address(router), 10_000_000e6);
    }

    /// @dev Deploys EAS + SchemaRegistry from the published artifacts (local chains only).
    function _deployLocalEAS() internal returns (address schemaRegistry, address eas) {
        schemaRegistry = vm.deployCode(SCHEMA_REGISTRY_ARTIFACT);
        eas = vm.deployCode(EAS_ARTIFACT, abi.encode(schemaRegistry));
    }
}
