// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ConversionRouter} from "../../src/conversion/ConversionRouter.sol";
import {IV3SwapRouter} from "../../src/external/IV3SwapRouter.sol";
import {IWETH9} from "../../src/external/IWETH9.sol";
import {IConversionRouter} from "../../src/interfaces/IConversionRouter.sol";
import {IRoleRegistry} from "../../src/interfaces/IRoleRegistry.sol";
import {Errors} from "../../src/libraries/Errors.sol";
import {MockUSDC} from "../../src/mocks/MockUSDC.sol";
import {MockV3Aggregator} from "../../src/mocks/MockV3Aggregator.sol";
import {PoATest} from "../utils/PoATest.sol";

/// @notice The oracle bound on every conversion: fair value from Chainlink-shaped feeds, a swap that falls short of
///         it by more than the route's bound reverts, a stale or missing price never lets a swap through, and the
///         admin can neither route through arbitrary tokens nor change anything money is waiting on without a delay.
contract ConversionRouterTest is PoATest {
    address internal constant NATIVE = address(0);
    address internal donor = makeAddr("conversionDonor");

    function _fundUsdc(uint256 amount) internal {
        usdc.mint(donor, amount);
        vm.prank(donor);
        usdc.approve(address(router), amount);
    }

    // ─── quotes ────────────────────────────────────────────────────────────────

    function test_quote_usesOraclePricesAndDecimals() public view {
        // 1 EUR = 1.08 USD, 1 USDC = 1 USD: 1,080 USDC is worth 1,000 EURC
        assertEq(router.quote(address(usdc), 1080e6, address(token)), 1000e6);
        // 1 ETH (18 decimals) = 2,500 USD = 2,314.814814 EURC (6 decimals)
        assertEq(router.quote(NATIVE, 1 ether, address(token)), 2_314_814_814);
        assertEq(router.quote(address(weth), 1 ether, address(token)), 2_314_814_814, "WETH uses the ETH feed");
        assertEq(router.quote(address(token), 123, address(token)), 123);
    }

    function test_quote_rejectsBadPrices() public {
        vm.warp(block.timestamp + 3 days + 1);
        vm.expectRevert(Errors.StalePrice.selector);
        router.quote(address(usdc), 1e6, address(token));

        _refreshPrices();
        eurUsdFeed.updateAnswer(0);
        vm.expectRevert(Errors.InvalidPrice.selector);
        router.quote(address(usdc), 1e6, address(token));

        eurUsdFeed.updateRoundData(1.08e8, block.timestamp, block.timestamp + 1); // from the future
        vm.expectRevert(Errors.StalePrice.selector);
        router.quote(address(usdc), 1e6, address(token));

        vm.expectRevert(Errors.PriceFeedNotSet.selector);
        router.quote(makeAddr("unknownToken"), 1e6, address(token));
    }

    // ─── conversions ───────────────────────────────────────────────────────────

    function test_convert_returnsOutputAndFairValue() public {
        _fundUsdc(1080e6);
        vm.expectEmit(true, true, true, true, address(router));
        // the mock rate floors 1/1.08, so the pool pays 999.499999 (0.05% fee on a 999.999999 fill)
        emit IConversionRouter.Converted(address(usdc), address(token), donor, 1080e6, 999_499_999, 1000e6);
        vm.prank(donor);
        (uint256 amountOut, uint256 fair) = router.convert(address(usdc), 1080e6, address(token), donor);

        assertEq(fair, 1000e6);
        assertEq(amountOut, 999_499_999, "the mock pool keeps 0.05%");
        assertEq(token.balanceOf(donor), amountOut);
        assertEq(usdc.balanceOf(address(router)), 0, "the router keeps nothing");
        assertEq(token.balanceOf(address(router)), 0);
    }

    function test_convert_nativeEthIsWrappedAndRouted() public {
        vm.deal(donor, 1 ether);
        vm.prank(donor);
        (uint256 amountOut, uint256 fair) = router.convert{value: 1 ether}(NATIVE, 1 ether, address(token), donor);
        assertEq(fair, 2_314_814_814);
        assertGe(amountOut, (fair * (10_000 - MAX_SLIPPAGE_BPS)) / 10_000);
        assertEq(address(router).balance, 0);
        assertEq(weth.balanceOf(address(router)), 0);
    }

    function test_convert_revertsBeyondTheSlippageBound() public {
        swapRouter.setFeeBps(150); // a pool that is 1.5% worse than the oracle
        _fundUsdc(1080e6);
        vm.prank(donor);
        vm.expectRevert(bytes("Too little received"));
        router.convert(address(usdc), 1080e6, address(token), donor);
    }

    function test_convert_measuresWhatTheRecipientActuallyReceived() public {
        swapRouter.setShortPay(true); // reports a full swap, pays half
        _fundUsdc(1080e6);
        vm.prank(donor);
        vm.expectRevert(Errors.InsufficientOutput.selector);
        router.convert(address(usdc), 1080e6, address(token), donor);
    }

    function test_convert_sameTokenPassesThrough() public {
        token.mint(donor, 50e6);
        vm.startPrank(donor);
        token.approve(address(router), 50e6);
        (uint256 amountOut, uint256 fair) = router.convert(address(token), 50e6, address(token), donor);
        vm.stopPrank();
        assertEq(amountOut, 50e6);
        assertEq(fair, 50e6);
    }

    function test_convert_validatesInputs() public {
        _fundUsdc(10e6);
        vm.startPrank(donor);
        vm.expectRevert(Errors.ZeroAmount.selector);
        router.convert(address(usdc), 0, address(token), donor);
        vm.expectRevert(Errors.InvalidParameter.selector);
        router.convert(address(usdc), 10e6, address(token), address(0));
        vm.expectRevert(Errors.InvalidParameter.selector);
        router.convert(address(usdc), 10e6, NATIVE, donor);
        vm.stopPrank();

        vm.deal(donor, 1 ether);
        vm.prank(donor);
        vm.expectRevert(Errors.InvalidParameter.selector);
        router.convert{value: 0.5 ether}(NATIVE, 1 ether, address(token), donor);
        vm.prank(donor);
        vm.expectRevert(Errors.InvalidParameter.selector);
        router.convert{value: 1}(address(usdc), 10e6, address(token), donor);
    }

    function test_convert_blockedWhilePaused() public {
        _fundUsdc(10e6);
        vm.prank(admin);
        roles.pause();
        vm.prank(donor);
        vm.expectRevert(Errors.SystemPaused.selector);
        router.convert(address(usdc), 10e6, address(token), donor);
    }

    // ─── sequencer ─────────────────────────────────────────────────────────────

    function test_sequencer_downOrJustRestartedBlocksConversions() public {
        MockV3Aggregator sequencer = new MockV3Aggregator(0, 0, "L2 sequencer uptime");
        vm.prank(admin);
        router.setSequencerUptimeFeed(address(sequencer));

        vm.warp(block.timestamp + 2 hours);
        _refreshPrices();
        sequencer.updateRoundData(1, block.timestamp - 2 hours, block.timestamp); // down
        vm.expectRevert(Errors.SequencerDown.selector);
        router.quote(address(usdc), 1e6, address(token));

        sequencer.updateRoundData(0, block.timestamp - 30 minutes, block.timestamp); // up, inside the grace period
        vm.expectRevert(Errors.SequencerDown.selector);
        router.quote(address(usdc), 1e6, address(token));

        sequencer.updateRoundData(0, block.timestamp - 2 hours, block.timestamp); // up for longer than the grace
        assertEq(router.quote(address(usdc), 1080e6, address(token)), 1000e6);
    }

    // ─── configuration ─────────────────────────────────────────────────────────

    function test_admin_configuration() public {
        bytes memory path = abi.encodePacked(address(usdc), uint24(500), address(token));

        vm.startPrank(outsider);
        vm.expectRevert(Errors.Unauthorized.selector);
        router.setPriceFeed(address(usdc), address(usdcUsdFeed), 1 hours);
        vm.expectRevert(Errors.Unauthorized.selector);
        router.setRoute(address(usdc), address(token), path, 50);
        vm.expectRevert(Errors.Unauthorized.selector);
        router.setSequencerUptimeFeed(address(1));
        vm.expectRevert(Errors.Unauthorized.selector);
        router.cancelChange(bytes32(0));
        vm.stopPrank();

        address dai = address(new MockUSDC());
        bytes memory daiPath = abi.encodePacked(dai, uint24(100), address(token));
        vm.startPrank(admin);
        vm.expectRevert(Errors.SlippageTooHigh.selector);
        router.setRoute(dai, address(token), daiPath, 501); // MAX_SLIPPAGE_CAP_BPS + 1
        vm.expectRevert(Errors.InvalidParameter.selector);
        router.setPriceFeed(dai, address(0), 1 hours);
        vm.expectRevert(Errors.InvalidParameter.selector);
        router.setPriceFeed(dai, address(usdcUsdFeed), 0);

        // the path must start at tokenIn, end at tokenOut and be whole hops
        vm.expectRevert(Errors.InvalidParameter.selector);
        router.setRoute(address(token), dai, daiPath, 50);
        vm.expectRevert(Errors.InvalidParameter.selector);
        router.setRoute(dai, address(token), abi.encodePacked(dai, uint16(1), address(token)), 50);

        // first-time configuration of a token nobody could convert yet applies at once
        router.setPriceFeed(dai, address(usdcUsdFeed), 1 hours);
        router.setRoute(dai, address(token), daiPath, 50);
        vm.stopPrank();
        assertEq(router.routeOf(dai, address(token)).path, daiPath);
        assertEq(router.maxSlippageBpsOf(dai, address(token)), 50);
        assertEq(router.priceFeedOf(dai).feed, address(usdcUsdFeed));
        assertEq(router.maxSlippageBpsOf(NATIVE, address(token)), MAX_SLIPPAGE_BPS, "ETH reads the WETH route");
        vm.expectRevert(Errors.RouteNotSet.selector);
        router.maxSlippageBpsOf(address(token), address(usdc));
    }

    /// @notice Review finding 1: routes may only pass through the hubs fixed at deployment.
    function test_setRoute_middleHopsMustBeHubs() public {
        address squatToken = address(new MockUSDC());
        vm.startPrank(admin);
        vm.expectRevert(Errors.InvalidParameter.selector);
        router.setRoute(
            squatToken,
            address(token),
            abi.encodePacked(squatToken, uint24(100), makeAddr("attackerToken"), uint24(100), address(token)),
            100
        );
        router.setRoute(
            squatToken,
            address(token),
            abi.encodePacked(squatToken, uint24(100), address(usdc), uint24(100), address(token)),
            100
        );
        vm.stopPrank();
        assertTrue(router.isHub(address(usdc)) && router.isHub(address(weth)));
        assertFalse(router.isHub(address(token)));
    }

    /// @notice Review finding 1: replacing a feed that money may be waiting on is scheduled, not applied.
    function test_timelock_replacingAFeedWaitsForTheDelay() public {
        MockV3Aggregator evil = new MockV3Aggregator(8, 1e30, "EUR / USD");
        bytes memory call = abi.encodeCall(ConversionRouter.setPriceFeed, (address(token), address(evil), 1 days));
        uint256 executableAt = block.timestamp + router.CONFIG_DELAY();

        vm.expectEmit(true, false, false, true, address(router));
        emit IConversionRouter.ConfigChangeScheduled(keccak256(call), call, executableAt);
        vm.prank(admin);
        router.setPriceFeed(address(token), address(evil), 1 days);
        assertEq(router.priceFeedOf(address(token)).feed, address(eurUsdFeed), "nothing changed yet");
        assertEq(router.scheduledAt(keccak256(call)), executableAt);

        vm.warp(executableAt - 1);
        vm.prank(admin);
        vm.expectRevert(Errors.ChangeNotReady.selector);
        router.setPriceFeed(address(token), address(evil), 1 days);

        vm.warp(executableAt);
        vm.prank(admin);
        router.setPriceFeed(address(token), address(evil), 1 days);
        assertEq(router.priceFeedOf(address(token)).feed, address(evil));
        assertEq(router.scheduledAt(keccak256(call)), 0);
    }

    function test_timelock_lapsesAndCanBeCancelled() public {
        bytes memory path = abi.encodePacked(address(usdc), uint24(3000), address(token));
        bytes32 id = keccak256(abi.encodeCall(ConversionRouter.setRoute, (address(usdc), address(token), path, 100)));

        vm.prank(admin);
        router.setRoute(address(usdc), address(token), path, 100);
        // not executed inside the window: the next identical call schedules it afresh
        vm.warp(block.timestamp + router.CONFIG_DELAY() + router.EXECUTION_WINDOW() + 1);
        vm.prank(admin);
        router.setRoute(address(usdc), address(token), path, 100);
        assertEq(router.scheduledAt(id), block.timestamp + router.CONFIG_DELAY());
        assertEq(router.routeOf(address(usdc), address(token)).maxSlippageBps, MAX_SLIPPAGE_BPS);

        vm.expectEmit(true, false, false, false, address(router));
        emit IConversionRouter.ConfigChangeCancelled(id);
        vm.prank(admin);
        router.cancelChange(id);
        assertEq(router.scheduledAt(id), 0);
        vm.prank(admin);
        vm.expectRevert(Errors.InvalidParameter.selector);
        router.cancelChange(id);
    }

    function test_timelock_tighteningARouteAppliesAtOnce_looseningWaits() public {
        bytes memory path = router.routeOf(address(usdc), address(token)).path;
        vm.startPrank(admin);
        router.setRoute(address(usdc), address(token), path, 30);
        assertEq(router.maxSlippageBpsOf(address(usdc), address(token)), 30);
        router.setRoute(address(usdc), address(token), path, 400);
        vm.stopPrank();
        assertEq(router.maxSlippageBpsOf(address(usdc), address(token)), 30, "loosening is scheduled");
    }

    function test_timelock_sequencerFeed_firstSetAtOnce_removalWaits() public {
        vm.startPrank(admin);
        router.setSequencerUptimeFeed(address(1));
        assertEq(address(router.sequencerUptimeFeed()), address(1));
        router.setSequencerUptimeFeed(address(0));
        vm.stopPrank();
        assertEq(address(router.sequencerUptimeFeed()), address(1), "removing the check is scheduled");
    }

    // ─── how much input fills a need ───────────────────────────────────────────

    /// @notice Review finding 3: `maxInputFor` is enough to fill `amountOut` at the bound, for any price and size.
    function testFuzz_maxInputFor_coversTheBound(uint256 amountOut, int256 eurUsd, int256 ethUsd, bool eth) public {
        amountOut = bound(amountOut, 1, 10_000_000e6);
        eurUsdFeed.updateAnswer(bound(eurUsd, 0.5e8, 2e8));
        ethUsdFeed.updateAnswer(bound(ethUsd, 100e8, 20_000e8));
        address tokenIn = eth ? NATIVE : address(usdc);

        uint256 input = router.maxInputFor(tokenIn, address(token), amountOut);
        uint256 fair = router.quote(tokenIn, input, address(token));
        uint16 bps = router.maxSlippageBpsOf(tokenIn, address(token));
        assertGe((fair * (10_000 - bps)) / 10_000, amountOut, "the minimum output covers the target");
        // and it is not wasteful: the bound plus a few units of rounding
        assertLe(fair, (amountOut * 10_000) / (10_000 - bps) + 8);
    }

    function test_maxInputFor_sameTokenAndMissingRoute() public {
        assertEq(router.maxInputFor(address(token), address(token), 5e6), 5e6);
        vm.expectRevert(Errors.RouteNotSet.selector);
        router.maxInputFor(address(token), address(usdc), 5e6);
    }

    function test_constructor_validates() public {
        IRoleRegistry r = IRoleRegistry(address(roles));
        address[] memory hubs = new address[](1);
        vm.expectRevert(Errors.ZeroAddress.selector);
        new ConversionRouter(r, IV3SwapRouter(address(0)), IWETH9(address(weth)), hubs);
        vm.expectRevert(Errors.ZeroAddress.selector);
        new ConversionRouter(r, IV3SwapRouter(address(swapRouter)), IWETH9(address(0)), hubs);
        vm.expectRevert(Errors.ZeroAddress.selector); // a zero hub
        new ConversionRouter(r, IV3SwapRouter(address(swapRouter)), IWETH9(address(weth)), hubs);
    }

    function test_missingRouteReverts() public {
        vm.prank(admin);
        router.setPriceFeed(address(weth), address(ethUsdFeed), 1 hours);
        weth.deposit{value: 1 ether}();
        weth.approve(address(router), 1 ether);
        // WETH → USDC has no configured route
        vm.expectRevert(Errors.RouteNotSet.selector);
        router.convert(address(weth), 1 ether, address(usdc), address(this));
    }
}
