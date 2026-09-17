// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ConversionRouter} from "../../src/conversion/ConversionRouter.sol";
import {IV3SwapRouter} from "../../src/external/IV3SwapRouter.sol";
import {IWETH9} from "../../src/external/IWETH9.sol";
import {IConversionRouter} from "../../src/interfaces/IConversionRouter.sol";
import {IRoleRegistry} from "../../src/interfaces/IRoleRegistry.sol";
import {Errors} from "../../src/libraries/Errors.sol";
import {MockV3Aggregator} from "../../src/mocks/MockV3Aggregator.sol";
import {PoATest} from "../utils/PoATest.sol";

/// @notice The oracle bound on every conversion: fair value from Chainlink-shaped feeds, a swap that falls short of
///         it by more than `maxSlippageBps` reverts, and a stale or missing price never lets a swap through.
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
        router.setRoute(address(usdc), address(token), path);
        vm.expectRevert(Errors.Unauthorized.selector);
        router.setMaxSlippageBps(50);
        vm.expectRevert(Errors.Unauthorized.selector);
        router.setSequencerUptimeFeed(address(1));
        vm.stopPrank();

        vm.startPrank(admin);
        vm.expectRevert(Errors.SlippageTooHigh.selector);
        router.setMaxSlippageBps(501); // MAX_SLIPPAGE_CAP_BPS + 1 (a view call here would consume expectRevert)
        router.setMaxSlippageBps(50);
        assertEq(router.maxSlippageBps(), 50);

        vm.expectRevert(Errors.InvalidParameter.selector);
        router.setPriceFeed(address(usdc), address(0), 1 hours);
        vm.expectRevert(Errors.InvalidParameter.selector);
        router.setPriceFeed(address(usdc), address(usdcUsdFeed), 0);

        // the path must start at tokenIn, end at tokenOut and be whole hops
        vm.expectRevert(Errors.InvalidParameter.selector);
        router.setRoute(address(token), address(usdc), path);
        vm.expectRevert(Errors.InvalidParameter.selector);
        router.setRoute(address(usdc), address(token), abi.encodePacked(address(usdc), uint16(1), address(token)));
        router.setRoute(address(usdc), address(token), path);
        assertEq(router.routeOf(address(usdc), address(token)), path);
        assertEq(router.priceFeedOf(address(usdc)).feed, address(usdcUsdFeed));
        vm.stopPrank();
    }

    function test_constructor_validates() public {
        IRoleRegistry r = IRoleRegistry(address(roles));
        vm.expectRevert(Errors.ZeroAddress.selector);
        new ConversionRouter(r, IV3SwapRouter(address(0)), IWETH9(address(weth)), 100);
        vm.expectRevert(Errors.ZeroAddress.selector);
        new ConversionRouter(r, IV3SwapRouter(address(swapRouter)), IWETH9(address(0)), 100);
        vm.expectRevert(Errors.SlippageTooHigh.selector);
        new ConversionRouter(r, IV3SwapRouter(address(swapRouter)), IWETH9(address(weth)), 501);
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
