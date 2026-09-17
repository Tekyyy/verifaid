// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {RoleAware} from "../access/RoleAware.sol";
import {IAggregatorV3} from "../external/IAggregatorV3.sol";
import {IV3SwapRouter} from "../external/IV3SwapRouter.sol";
import {IWETH9} from "../external/IWETH9.sol";
import {IConversionRouter} from "../interfaces/IConversionRouter.sol";
import {IRoleRegistry} from "../interfaces/IRoleRegistry.sol";
import {Errors} from "../libraries/Errors.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @title ConversionRouter
/// @notice Turns a donation in one token (USDC from a card on-ramp, ETH from a wallet) into the need's stablecoin
///         through Uniswap v3, bounded by Chainlink: a swap that returns less than the oracle fair value minus the
///         route's `maxSlippageBps` reverts. The fair value is returned alongside the output, so the conversion cost
///         is a number the contracts compute, not one anybody reports.
/// @dev Holds no funds between calls. The admin configures feeds and routes, but cannot direct where converted funds
///      go (the caller chooses the recipient), and routes may only pass through the hub tokens fixed at deployment.
///      Anything that could affect money already waiting to be converted (replacing a feed or a route, loosening a
///      bound, removing the sequencer check) only takes effect `CONFIG_DELAY` after it was requested, which leaves
///      donors time to take their money back first. Initial configuration applies at once.
contract ConversionRouter is IConversionRouter, RoleAware, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    uint16 public constant BPS_DENOMINATOR = 10_000;
    /// @notice Upper bound for any route's slippage, so a misconfiguration cannot turn the oracle bound off.
    uint16 public constant MAX_SLIPPAGE_CAP_BPS = 500;
    /// @notice After the L2 sequencer comes back up, prices are not trusted for this long.
    uint256 public constant SEQUENCER_GRACE_PERIOD = 1 hours;
    /// @inheritdoc IConversionRouter
    uint256 public constant CONFIG_DELAY = 2 days;
    /// @notice A scheduled change that is not executed within this window after becoming executable lapses.
    uint256 public constant EXECUTION_WINDOW = 7 days;
    /// @inheritdoc IConversionRouter
    address public constant NATIVE = address(0);

    IV3SwapRouter public immutable swapRouter;
    IWETH9 public immutable weth;

    /// @notice Chainlink L2 sequencer uptime feed; zero on chains without one (local and test networks).
    IAggregatorV3 public sequencerUptimeFeed;
    /// @inheritdoc IConversionRouter
    mapping(address => bool) public isHub;
    /// @inheritdoc IConversionRouter
    mapping(bytes32 => uint256) public scheduledAt;

    mapping(address => PriceFeed) private _feeds;
    mapping(address => mapping(address => Route)) private _routes;

    constructor(IRoleRegistry roles_, IV3SwapRouter swapRouter_, IWETH9 weth_, address[] memory hubs)
        RoleAware(roles_)
    {
        if (address(swapRouter_) == address(0) || address(weth_) == address(0)) {
            revert Errors.ZeroAddress();
        }
        swapRouter = swapRouter_;
        weth = weth_;
        for (uint256 i; i < hubs.length; ++i) {
            if (hubs[i] == address(0)) revert Errors.ZeroAddress();
            isHub[hubs[i]] = true;
        }
    }

    // ─── admin configuration ───────────────────────────────────────────────────

    /// @notice Sets `token`'s USD price feed (`NATIVE` and WETH share ETH/USD). Admin only; replacing a feed is
    ///         delayed.
    function setPriceFeed(address token, address feed, uint32 heartbeat) external onlyAdmin {
        if (feed == address(0) || heartbeat == 0) revert Errors.InvalidParameter();
        if (!_mayApply(_feeds[token].feed == address(0))) return;
        uint8 tokenDecimals = token == NATIVE ? 18 : IERC20Metadata(token).decimals();
        _feeds[token] = PriceFeed({
            feed: feed, heartbeat: heartbeat, feedDecimals: IAggregatorV3(feed).decimals(), tokenDecimals: tokenDecimals
        });
        emit PriceFeedSet(token, feed, heartbeat);
    }

    /// @notice Sets the Uniswap v3 path from `tokenIn` to `tokenOut` (use WETH for native ETH) and its slippage bound.
    ///         Admin only. Replacing a route is delayed, except tightening the bound of the same path.
    function setRoute(address tokenIn, address tokenOut, bytes calldata path, uint16 maxSlippageBps)
        external
        onlyAdmin
    {
        // tokenIn (20) ‖ fee (3) ‖ tokenOut (20), plus 23 bytes per extra hop
        if (path.length < 43 || (path.length - 20) % 23 != 0) revert Errors.InvalidParameter();
        if (address(bytes20(path[:20])) != tokenIn || address(bytes20(path[path.length - 20:])) != tokenOut) {
            revert Errors.InvalidParameter();
        }
        // Middle tokens are limited to the hubs fixed at deployment, so no route can pass through a pool of a token
        // someone created to capture the swap.
        for (uint256 offset = 23; offset < path.length - 20; offset += 23) {
            if (!isHub[address(bytes20(path[offset:offset + 20]))]) revert Errors.InvalidParameter();
        }
        if (maxSlippageBps > MAX_SLIPPAGE_CAP_BPS) revert Errors.SlippageTooHigh();

        Route storage current = _routes[tokenIn][tokenOut];
        bool tightening = keccak256(current.path) == keccak256(path) && maxSlippageBps <= current.maxSlippageBps;
        if (!_mayApply(current.path.length == 0 || tightening)) return;
        _routes[tokenIn][tokenOut] = Route({path: path, maxSlippageBps: maxSlippageBps});
        emit RouteSet(tokenIn, tokenOut, path, maxSlippageBps);
    }

    /// @notice Sets the L2 sequencer uptime feed (zero disables the check). Admin only; changing or removing an
    ///         existing feed is delayed.
    function setSequencerUptimeFeed(address feed) external onlyAdmin {
        if (!_mayApply(address(sequencerUptimeFeed) == address(0) && feed != address(0))) return;
        sequencerUptimeFeed = IAggregatorV3(feed);
        emit SequencerFeedSet(feed);
    }

    /// @notice Cancels a scheduled change. Admin only.
    function cancelChange(bytes32 id) external onlyAdmin {
        if (scheduledAt[id] == 0) revert Errors.InvalidParameter();
        delete scheduledAt[id];
        emit ConfigChangeCancelled(id);
    }

    // ─── conversion ────────────────────────────────────────────────────────────

    /// @inheritdoc IConversionRouter
    function convert(address tokenIn, uint256 amountIn, address tokenOut, address recipient)
        external
        payable
        nonReentrant
        whenNotPaused
        returns (uint256 amountOut, uint256 fairAmountOut)
    {
        if (amountIn == 0) revert Errors.ZeroAmount();
        if (recipient == address(0) || tokenOut == NATIVE) revert Errors.InvalidParameter();

        if (tokenIn == NATIVE) {
            if (msg.value != amountIn) revert Errors.InvalidParameter();
        } else {
            if (msg.value != 0) revert Errors.InvalidParameter();
            IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);
        }

        if (tokenIn == tokenOut) {
            IERC20(tokenOut).safeTransfer(recipient, amountIn);
            emit Converted(tokenIn, tokenOut, recipient, amountIn, amountIn, amountIn);
            return (amountIn, amountIn);
        }

        address swapIn = tokenIn == NATIVE ? address(weth) : tokenIn;
        Route memory route = _routes[swapIn][tokenOut];
        if (route.path.length == 0) revert Errors.RouteNotSet();
        fairAmountOut = quote(tokenIn, amountIn, tokenOut);
        uint256 minOut = _minOut(fairAmountOut, route.maxSlippageBps);

        if (tokenIn == NATIVE) weth.deposit{value: amountIn}();
        IERC20(swapIn).forceApprove(address(swapRouter), amountIn);
        uint256 before = IERC20(tokenOut).balanceOf(recipient);
        swapRouter.exactInput(
            IV3SwapRouter.ExactInputParams({
                path: route.path, recipient: recipient, amountIn: amountIn, amountOutMinimum: minOut
            })
        );
        IERC20(swapIn).forceApprove(address(swapRouter), 0);

        // Measured, not taken from the swap router's return value: the bound holds even if the router misreports.
        amountOut = IERC20(tokenOut).balanceOf(recipient) - before;
        if (amountOut < minOut) revert Errors.InsufficientOutput();
        emit Converted(tokenIn, tokenOut, recipient, amountIn, amountOut, fairAmountOut);
    }

    // ─── views ─────────────────────────────────────────────────────────────────

    /// @inheritdoc IConversionRouter
    function quote(address tokenIn, uint256 amountIn, address tokenOut) public view returns (uint256) {
        if (tokenIn == tokenOut) return amountIn;
        _checkSequencer();
        PriceFeed memory feedIn = _feedFor(tokenIn);
        PriceFeed memory feedOut = _feedFor(tokenOut);
        uint256 priceIn = _price(feedIn);
        uint256 priceOut = _price(feedOut);

        // USD value = amountIn / 10^decIn × priceIn / 10^feedDecIn; amountOut = value × 10^decOut × 10^feedDecOut / priceOut
        return Math.mulDiv(
            amountIn,
            priceIn * 10 ** (uint256(feedOut.tokenDecimals) + feedOut.feedDecimals),
            priceOut * 10 ** (uint256(feedIn.tokenDecimals) + feedIn.feedDecimals)
        );
    }

    /// @inheritdoc IConversionRouter
    /// @dev Both quotes round down, so the margin adds one unit of `tokenOut` (in either direction) on top of the
    ///      slippage bound: `_minOut(quote(tokenIn, result, tokenOut), bps) > amountOut` for any price.
    function maxInputFor(address tokenIn, address tokenOut, uint256 amountOut) external view returns (uint256) {
        if (tokenIn == tokenOut) return amountOut;
        uint16 bps = maxSlippageBpsOf(tokenIn, tokenOut);
        uint256 oneOutInIn = quote(tokenOut, 1, tokenIn) + 1;
        uint256 oneInInOut = quote(tokenIn, 1, tokenOut) + 1;
        uint256 fairIn = quote(tokenOut, amountOut + oneInInOut + 1, tokenIn);
        return Math.mulDiv(fairIn, BPS_DENOMINATOR, BPS_DENOMINATOR - bps, Math.Rounding.Ceil) + oneOutInIn;
    }

    /// @inheritdoc IConversionRouter
    function maxSlippageBpsOf(address tokenIn, address tokenOut) public view returns (uint16) {
        Route storage route = _routes[tokenIn == NATIVE ? address(weth) : tokenIn][tokenOut];
        if (route.path.length == 0) revert Errors.RouteNotSet();
        return route.maxSlippageBps;
    }

    /// @inheritdoc IConversionRouter
    function priceFeedOf(address token) external view returns (PriceFeed memory) {
        return _feeds[token];
    }

    /// @inheritdoc IConversionRouter
    function routeOf(address tokenIn, address tokenOut) external view returns (Route memory) {
        return _routes[tokenIn][tokenOut];
    }

    // ─── internal ──────────────────────────────────────────────────────────────

    /// @dev True when the calling setter may apply now. Otherwise the first identical call schedules it and returns
    ///      false, and a later identical call inside the execution window applies it.
    function _mayApply(bool immediately) internal returns (bool) {
        if (immediately) return true;
        bytes32 id = keccak256(msg.data);
        uint256 executableAt = scheduledAt[id];
        if (executableAt == 0 || block.timestamp > executableAt + EXECUTION_WINDOW) {
            executableAt = block.timestamp + CONFIG_DELAY;
            scheduledAt[id] = executableAt;
            emit ConfigChangeScheduled(id, msg.data, executableAt);
            return false;
        }
        if (block.timestamp < executableAt) revert Errors.ChangeNotReady();
        delete scheduledAt[id];
        return true;
    }

    function _minOut(uint256 fair, uint16 maxSlippageBps) internal pure returns (uint256) {
        return (fair * (BPS_DENOMINATOR - maxSlippageBps)) / BPS_DENOMINATOR;
    }

    /// @dev WETH falls back to the native ETH feed, so one ETH/USD configuration covers both.
    function _feedFor(address token) internal view returns (PriceFeed memory config) {
        config = _feeds[token];
        if (config.feed == address(0) && token == address(weth)) config = _feeds[NATIVE];
    }

    function _price(PriceFeed memory config) internal view returns (uint256) {
        if (config.feed == address(0)) revert Errors.PriceFeedNotSet();
        (, int256 answer,, uint256 updatedAt,) = IAggregatorV3(config.feed).latestRoundData();
        if (answer <= 0) revert Errors.InvalidPrice();
        if (updatedAt == 0 || updatedAt > block.timestamp || block.timestamp - updatedAt > config.heartbeat) {
            revert Errors.StalePrice();
        }
        return uint256(answer);
    }

    /// @dev Chainlink's L2 guidance: answer 0 means the sequencer is up; prices are only trusted once it has been
    ///      up for longer than the grace period, because feeds may not have caught up yet.
    function _checkSequencer() internal view {
        if (address(sequencerUptimeFeed) == address(0)) return;
        (, int256 answer, uint256 startedAt,,) = sequencerUptimeFeed.latestRoundData();
        if (answer != 0 || startedAt == 0 || block.timestamp - startedAt <= SEQUENCER_GRACE_PERIOD) {
            revert Errors.SequencerDown();
        }
    }
}
