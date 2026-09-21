// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IConversionRouter} from "../src/interfaces/IConversionRouter.sol";
import {MockEURC} from "../src/mocks/MockEURC.sol";
import {MockUSDC} from "../src/mocks/MockUSDC.sol";
import {DeploymentIO} from "./lib/DeploymentIO.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";

interface INonfungiblePositionManager {
    struct MintParams {
        address token0;
        address token1;
        uint24 fee;
        int24 tickLower;
        int24 tickUpper;
        uint256 amount0Desired;
        uint256 amount1Desired;
        uint256 amount0Min;
        uint256 amount1Min;
        address recipient;
        uint256 deadline;
    }

    function factory() external view returns (address);

    function createAndInitializePoolIfNecessary(address token0, address token1, uint24 fee, uint160 sqrtPriceX96)
        external
        payable
        returns (address pool);

    function mint(MintParams calldata params)
        external
        payable
        returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1);
}

interface IUniswapV3Factory {
    function feeAmountTickSpacing(uint24 fee) external view returns (int24);
}

interface IUniswapV3Pool {
    function slot0() external view returns (uint160 sqrtPriceX96, int24, uint16, uint16, uint16, uint8, bool);

    function liquidity() external view returns (uint128);
}

interface ISwapRouter02Single {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut);
}

/// @title SeedLiquidity
/// @notice Gives the testnet conversion path a real Uniswap v3 market: a mock EURC / vault-token pool on Uniswap's
///         own Base Sepolia deployment, priced at the Chainlink-derived fair rate the ConversionRouter enforces.
///         The public Base Sepolia pools are thin and mispriced, so every donation would fail the oracle bound.
///         A deployment that holds the chain's own USDC needs no pool at all: those donations never swap.
///
///         Re-runnable as a keeper: it creates and funds the pool once, then only swaps the price back to fair
///         value when it has drifted (anyone can mint the mock tokens and push it around).
/// @dev Skipped on deployments that use the mock swap router (anvil). Both tokens must be the mintable mocks.
///
///      forge script script/SeedLiquidity.s.sol --rpc-url base_sepolia --broadcast --slow
contract SeedLiquidity is Script, DeploymentIO {
    /// @dev Uniswap v3 NonfungiblePositionManager on Base Sepolia (docs.uniswap.org, v3 deployments).
    address internal constant BASE_SEPOLIA_POSITION_MANAGER = 0x27F971cb582BF9E50F397e4d29a5C7A34f11faA2;

    int24 internal constant MAX_TICK = 887_272;

    /// @dev Deep enough that a 100k donation moves the price about 0.01%: the tokens are free test mocks.
    uint256 internal constant LIQUIDITY_PER_SIDE = 1_000_000_000e6;
    /// @dev Below this much in-range liquidity the pool is (re)funded.
    uint128 internal constant MIN_LIQUIDITY = 1e14;
    /// @dev Price drift tolerated before rebalancing, in basis points of the fair price.
    uint256 internal constant REBALANCE_THRESHOLD_BPS = 5;

    struct Market {
        IConversionRouter router;
        INonfungiblePositionManager positions;
        address swapRouter;
        address token;
        address alt; // the convertible stablecoin (mock EURC on test networks)
        address token0;
        address token1;
        uint24 fee;
        int24 maxTick;
        uint160 fair;
        address pool;
    }

    function run() external {
        string memory deployment = _readDeployment();
        if (vm.parseJsonBool(deployment, ".params.mockSwapRouter")) {
            console2.log("SeedLiquidity: this deployment uses the mock swap router, nothing to seed");
            return;
        }
        if (!_convertsAnything(deployment)) return;
        Market memory m = _market(deployment);

        uint256 key = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address operator = vm.addr(key);
        vm.startBroadcast(key);
        m.pool = m.positions.createAndInitializePoolIfNecessary(m.token0, m.token1, m.fee, m.fair);
        if (IUniswapV3Pool(m.pool).liquidity() < MIN_LIQUIDITY) _addLiquidity(m, operator);
        _rebalance(m, operator);
        vm.stopBroadcast();

        (uint160 sqrtPrice,,,,,,) = IUniswapV3Pool(m.pool).slot0();
        console2.log("");
        console2.log("Conversion market ready");
        console2.log("  pool              ", m.pool);
        console2.log("  fee tier          ", uint256(m.fee));
        console2.log("  fair sqrtPriceX96 ", uint256(m.fair));
        console2.log("  pool sqrtPriceX96 ", uint256(sqrtPrice));
        console2.log("  1 EURC is worth   ", m.router.quote(m.alt, 1e6, m.token), "vault token units");
    }

    /// @dev A deployment whose vault currency is the chain's own USDC never swaps a stablecoin, so it needs no pool.
    function _convertsAnything(string memory deployment) internal view returns (bool) {
        if (!vm.keyExistsJson(deployment, ".external.EURC")) {
            console2.log("SeedLiquidity: this deployment holds one currency and converts nothing");
            return false;
        }
        address alt = _readAddress(deployment, ".external.EURC");
        if (alt == address(0) || alt == _readAddress(deployment, ".external.Token")) {
            console2.log("SeedLiquidity: the vault currency is the chain's own stablecoin, donations pass through");
            return false;
        }
        return true;
    }

    function _market(string memory deployment) internal view returns (Market memory m) {
        m.router = IConversionRouter(_readAddress(deployment, ".contracts.ConversionRouter"));
        m.token = _readAddress(deployment, ".external.Token");
        m.alt = _readAddress(deployment, ".external.EURC");
        m.swapRouter = _readAddress(deployment, ".external.SwapRouter");
        m.positions = INonfungiblePositionManager(vm.envOr("UNISWAP_POSITION_MANAGER", BASE_SEPOLIA_POSITION_MANAGER));
        m.fee = uint24(vm.parseJsonUint(deployment, ".params.usdcPoolFee"));
        (m.token0, m.token1) = m.alt < m.token ? (m.alt, m.token) : (m.token, m.alt);
        // Full range, rounded inward to the fee tier's tick spacing.
        int24 spacing = IUniswapV3Factory(m.positions.factory()).feeAmountTickSpacing(m.fee);
        require(spacing > 0, "SeedLiquidity: fee tier not enabled");
        m.maxTick = (MAX_TICK / spacing) * spacing;
        m.fair = _fairSqrtPrice(m.router, m.alt, m.token, m.token0);
    }

    function _addLiquidity(Market memory m, address operator) internal {
        MockEURC(m.alt).mint(operator, LIQUIDITY_PER_SIDE);
        MockUSDC(m.token).mint(operator, LIQUIDITY_PER_SIDE);
        IERC20(m.token0).approve(address(m.positions), LIQUIDITY_PER_SIDE);
        IERC20(m.token1).approve(address(m.positions), LIQUIDITY_PER_SIDE);
        (, uint128 liquidity, uint256 amount0, uint256 amount1) = m.positions
            .mint(
                INonfungiblePositionManager.MintParams({
                    token0: m.token0,
                    token1: m.token1,
                    fee: m.fee,
                    tickLower: -m.maxTick,
                    tickUpper: m.maxTick,
                    amount0Desired: LIQUIDITY_PER_SIDE,
                    amount1Desired: LIQUIDITY_PER_SIDE,
                    amount0Min: 0,
                    amount1Min: 0,
                    recipient: operator,
                    deadline: block.timestamp + 1 hours
                })
            );
        console2.log("  liquidity added   ", uint256(liquidity));
        console2.log("  token0 / token1   ", amount0, amount1);
    }

    /// @dev sqrt(token1 per token0) in Q64.96, from the router's own oracle quote so the pool and the bound agree.
    function _fairSqrtPrice(IConversionRouter router, address alt, address token, address token0)
        internal
        view
        returns (uint160)
    {
        uint256 tokenPerAlt = router.quote(alt, 1e6, token); // both stablecoins have 6 decimals
        (uint256 amount0, uint256 amount1) = token0 == alt ? (uint256(1e6), tokenPerAlt) : (tokenPerAlt, 1e6);
        return uint160(Math.sqrt(Math.mulDiv(amount1, 1 << 192, amount0)));
    }

    /// @dev Swaps with a price limit at the fair price: the swap stops exactly there, whatever the input size.
    function _rebalance(Market memory m, address operator) internal {
        (uint160 current,,,,,,) = IUniswapV3Pool(m.pool).slot0();
        // The price is the square of sqrtPrice, so relative sqrt drift is half the relative price drift.
        uint256 drift = current > m.fair ? current - m.fair : m.fair - current;
        if (drift * 20_000 <= uint256(m.fair) * REBALANCE_THRESHOLD_BPS) {
            console2.log("  pool price within tolerance of the oracle, no rebalance");
            return;
        }
        // Selling token0 lowers the price (token1 per token0); selling token1 raises it.
        bool zeroForOne = current > m.fair;
        (address tokenIn, address tokenOut) = zeroForOne ? (m.token0, m.token1) : (m.token1, m.token0);
        uint256 budget = LIQUIDITY_PER_SIDE / 10;
        MockUSDC(tokenIn).mint(operator, budget); // both mocks share the same permissionless mint
        IERC20(tokenIn).approve(m.swapRouter, budget);
        uint256 out = ISwapRouter02Single(m.swapRouter)
            .exactInputSingle(
                ISwapRouter02Single.ExactInputSingleParams({
                    tokenIn: tokenIn,
                    tokenOut: tokenOut,
                    fee: m.fee,
                    recipient: operator,
                    amountIn: budget,
                    amountOutMinimum: 0,
                    sqrtPriceLimitX96: m.fair
                })
            );
        IERC20(tokenIn).approve(m.swapRouter, 0);
        console2.log("  rebalanced, received", out);
    }
}
