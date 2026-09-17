// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IV3SwapRouter
/// @notice The subset of Uniswap's SwapRouter02 (`IV3SwapRouter`) this project calls. Unlike the original v3
///         SwapRouter, SwapRouter02's structs have no `deadline` field.
interface IV3SwapRouter {
    /// @param path `tokenIn ‖ uint24 fee ‖ token ‖ uint24 fee ‖ … ‖ tokenOut`, packed.
    struct ExactInputParams {
        bytes path;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
    }

    function exactInput(ExactInputParams calldata params) external payable returns (uint256 amountOut);
}
