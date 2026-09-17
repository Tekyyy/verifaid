// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IV3SwapRouter} from "../external/IV3SwapRouter.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";

/// @title MockSwapRouter
/// @notice TEST CONTRACT ONLY — speaks SwapRouter02's `exactInput`, but prices every pair from a rate anyone can set
///         and pays out of its own inventory. Used on local chains and test networks without real liquidity for the
///         demo tokens, and to make tests misbehave (bad prices, short payouts).
contract MockSwapRouter is IV3SwapRouter {
    /// @notice tokenIn => tokenOut => units of tokenOut per whole tokenIn, 18-decimal fixed point.
    mapping(address => mapping(address => uint256)) public rate;
    /// @notice Fee kept on every swap, in basis points (like a pool fee tier).
    uint16 public feeBps = 5;
    /// @notice When set, pays out less than it reports, to prove callers measure what they received.
    bool public shortPay;

    function setRate(address tokenIn, address tokenOut, uint256 wadRate) external {
        rate[tokenIn][tokenOut] = wadRate;
    }

    function setFeeBps(uint16 feeBps_) external {
        feeBps = feeBps_;
    }

    function setShortPay(bool shortPay_) external {
        shortPay = shortPay_;
    }

    function exactInput(ExactInputParams calldata params) external payable returns (uint256 amountOut) {
        address tokenIn = address(bytes20(params.path[:20]));
        address tokenOut = address(bytes20(params.path[params.path.length - 20:]));
        uint256 wadRate = rate[tokenIn][tokenOut];
        require(wadRate != 0, "no rate");

        IERC20(tokenIn).transferFrom(msg.sender, address(this), params.amountIn);
        uint256 decIn = IERC20Metadata(tokenIn).decimals();
        uint256 decOut = IERC20Metadata(tokenOut).decimals();
        amountOut = (params.amountIn * wadRate * 10 ** decOut) / (10 ** decIn * 1e18);
        amountOut = (amountOut * (10_000 - feeBps)) / 10_000;
        require(amountOut >= params.amountOutMinimum, "Too little received");

        IERC20(tokenOut).transfer(params.recipient, shortPay ? amountOut / 2 : amountOut);
    }
}
