// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IRoleAware} from "./IRoleAware.sol";

/// @title IConversionRouter
/// @notice Converts donations into a need's stablecoin on-chain, and refuses any swap whose output falls short of
///         the fair value implied by Chainlink prices by more than the route's slippage bound.
interface IConversionRouter is IRoleAware {
    /// @notice A token's USD price feed.
    struct PriceFeed {
        address feed;
        uint32 heartbeat; // maximum age of an answer, in seconds
        uint8 feedDecimals;
        uint8 tokenDecimals;
    }

    /// @notice A Uniswap v3 path and the most it may lose against the oracle fair value.
    struct Route {
        bytes path;
        uint16 maxSlippageBps;
    }

    event PriceFeedSet(address indexed token, address feed, uint32 heartbeat);
    event RouteSet(address indexed tokenIn, address indexed tokenOut, bytes path, uint16 maxSlippageBps);
    event SequencerFeedSet(address feed);
    /// @notice A configuration change that could affect money already waiting to be converted was requested; the
    ///         identical call executes it once `executableAt` has passed. `id` is the hash of that calldata.
    event ConfigChangeScheduled(bytes32 indexed id, bytes call, uint256 executableAt);
    event ConfigChangeCancelled(bytes32 indexed id);
    /// @param fairAmountOut What `amountIn` is worth in `tokenOut` at oracle prices; `fairAmountOut - amountOut`
    ///        is the conversion cost (pool fees, price impact, oracle drift).
    event Converted(
        address indexed tokenIn,
        address indexed tokenOut,
        address indexed recipient,
        uint256 amountIn,
        uint256 amountOut,
        uint256 fairAmountOut
    );

    /// @notice Pulls `amountIn` of `tokenIn` from the caller (or takes `msg.value` when `tokenIn` is `NATIVE`),
    ///         converts it and sends the result to `recipient`.
    /// @return amountOut What `recipient` received.
    /// @return fairAmountOut What the input was worth in `tokenOut` at oracle prices.
    function convert(address tokenIn, uint256 amountIn, address tokenOut, address recipient)
        external
        payable
        returns (uint256 amountOut, uint256 fairAmountOut);

    /// @notice What `amountIn` of `tokenIn` is worth in `tokenOut` at current, fresh oracle prices.
    function quote(address tokenIn, uint256 amountIn, address tokenOut) external view returns (uint256);

    /// @notice The smallest input that is guaranteed, if the conversion succeeds at all, to produce at least
    ///         `amountOut` of `tokenOut`: enough to cover the route's slippage bound and rounding.
    function maxInputFor(address tokenIn, address tokenOut, uint256 amountOut) external view returns (uint256);

    /// @notice The slippage bound of the route from `tokenIn` (`NATIVE` for ETH) to `tokenOut`.
    function maxSlippageBpsOf(address tokenIn, address tokenOut) external view returns (uint16);

    /// @notice Sentinel for native ETH (wrapped to WETH before swapping).
    function NATIVE() external view returns (address);
    function CONFIG_DELAY() external view returns (uint256);
    /// @notice Intermediate tokens a route may pass through, fixed at deployment.
    function isHub(address token) external view returns (bool);
    /// @notice When a scheduled change becomes executable; zero if none is scheduled under `id`.
    function scheduledAt(bytes32 id) external view returns (uint256);
    function priceFeedOf(address token) external view returns (PriceFeed memory);
    function routeOf(address tokenIn, address tokenOut) external view returns (Route memory);
}
