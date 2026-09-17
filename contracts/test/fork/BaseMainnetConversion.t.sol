// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AidVault} from "../../src/funds/AidVault.sol";
import {INeedsRegistry} from "../../src/interfaces/INeedsRegistry.sol";
import {PoATest} from "../utils/PoATest.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {console2} from "forge-std/console2.sol";

/// @notice The conversion path against Base mainnet as it really is: Circle's USDC and EURC, Uniswap v3's
///         SwapRouter02 and pools, Chainlink's EUR/USD, USDC/USD and ETH/USD feeds and the L2 sequencer uptime
///         feed. Proves the oracle bound, the routes and the fee accounting hold with real liquidity.
/// @dev Runs only when BASE_MAINNET_RPC_URL is set (e.g. https://mainnet.base.org); skipped otherwise so CI does
///      not depend on a public RPC. Addresses: developers.uniswap.org v3 Base deployments, developers.circle.com,
///      Chainlink data feeds directory (verified 2026-09-17).
contract BaseMainnetConversionTest is PoATest {
    address internal constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address internal constant EURC = 0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42;
    address internal constant SWAP_ROUTER02 = 0x2626664c2603336E57B271c5C0b26F421741e481;
    address internal constant WETH = 0x4200000000000000000000000000000000000006;
    address internal constant EUR_USD = 0xc91D87E81faB8f93699ECf7Ee9B44D11e1D53F0F;
    address internal constant USDC_USD = 0x7e860098F58bBFC8648a4311b374B1D669a2bc6B;
    address internal constant ETH_USD = 0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70;
    address internal constant SEQUENCER_UPTIME = 0xBCF85224fc0756B9Fa45aA7892530B47e10b6433;

    bool internal forked;
    uint256 internal needId;
    AidVault internal vault;
    address internal donor = makeAddr("mainnetDonor");

    function _beforeDeploy() internal override {
        string memory rpc = vm.envOr("BASE_MAINNET_RPC_URL", string(""));
        if (bytes(rpc).length == 0) return;
        vm.createSelectFork(rpc);
        forked = true;
    }

    function _tokenAddress() internal view override returns (address) {
        return forked ? EURC : address(0);
    }

    function _conversionParams() internal view override returns (ConversionParams memory) {
        if (!forked) return super._conversionParams();
        return ConversionParams({
            swapRouter: SWAP_ROUTER02,
            weth: WETH,
            usdc: USDC,
            eurUsdFeed: EUR_USD,
            usdcUsdFeed: USDC_USD,
            ethUsdFeed: ETH_USD,
            sequencerUptimeFeed: SEQUENCER_UPTIME,
            maxSlippageBps: MAX_SLIPPAGE_BPS,
            ethMaxSlippageBps: 150,
            usdcToTokenFee: 500, // the EURC/USDC 0.05% pool
            wethToUsdcFee: 500,
            ethRoute: true,
            eurHeartbeat: 3 days, // EUR/USD pauses over forex weekends
            usdcHeartbeat: 1 days + 1 hours,
            ethHeartbeat: 1 hours
        });
    }

    function setUp() public override {
        super.setUp();
        if (!forked) return;
        uint256 programId = _createProgram(ngo, 10);
        INeedsRegistry.CreateNeedParams memory p = _needParams(programId, 10_000e6, 1, _threeTrancheBps());
        p.thirdPartyCostBps = 200;
        p.costDisclosureHash = COST_DISCLOSURE_HASH;
        needId = _verifiedNeedWith(p);
        vault = AidVault(registry.vaultOf(needId));
    }

    function test_fork_usdcDonationConvertsWithinTheOracleBound() public {
        if (!forked) vm.skip(true);
        deal(USDC, donor, 500e6);
        uint256 fair = router.quote(USDC, 500e6, EURC);

        vm.startPrank(donor);
        IERC20(USDC).approve(address(forwarderFactory), 500e6);
        (uint256 deposited, uint256 receiptId) = forwarderFactory.donate(needId, USDC, 500e6);
        vm.stopPrank();

        console2.log("fair EURC for 500 USDC ", fair);
        console2.log("deposited EURC         ", deposited);
        console2.log("conversion fee (EURC)  ", resolver.fundingFeesOf(needId));
        assertGe(deposited, (fair * (10_000 - MAX_SLIPPAGE_BPS)) / 10_000, "within the oracle bound");
        assertEq(IERC20(EURC).balanceOf(address(vault)), deposited, "real EURC in the vault");
        assertEq(receipt.ownerOf(receiptId), donor);
        assertEq(resolver.fundingFeesOf(needId), fair > deposited ? fair - deposited : 0);
        assertEq(IERC20(USDC).balanceOf(address(router)), 0);
    }

    function test_fork_ethDonationRoutesThroughUsdc() public {
        if (!forked) vm.skip(true);
        vm.deal(donor, 0.05 ether);
        uint256 fair = router.quote(address(0), 0.05 ether, EURC);

        vm.prank(donor);
        (uint256 deposited,) = forwarderFactory.donate{value: 0.05 ether}(needId, address(0), 0.05 ether);

        console2.log("fair EURC for 0.05 ETH ", fair);
        console2.log("deposited EURC         ", deposited);
        assertGe(deposited, (fair * (10_000 - MAX_SLIPPAGE_BPS)) / 10_000, "within the oracle bound");
        assertEq(IERC20(EURC).balanceOf(address(vault)), deposited);
    }
}
