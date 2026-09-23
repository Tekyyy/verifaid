// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ConversionRouter} from "../../src/conversion/ConversionRouter.sol";
import {AidVault} from "../../src/funds/AidVault.sol";
import {DonationForwarder} from "../../src/funds/DonationForwarder.sol";
import {DonationForwarderFactory} from "../../src/funds/DonationForwarderFactory.sol";
import {IDonationForwarder} from "../../src/interfaces/IDonationForwarder.sol";
import {INeedsRegistry} from "../../src/interfaces/INeedsRegistry.sol";
import {Errors} from "../../src/libraries/Errors.sol";
import {MockUSDC} from "../../src/mocks/MockUSDC.sol";
import {MockV3Aggregator} from "../../src/mocks/MockV3Aggregator.sol";
import {PoATest} from "../utils/PoATest.sol";

/// @dev The reviewer's sandwich, as a contract: front-run, sweep someone else's deposit address, back-run.
contract Sandwicher {
    function attack(DonationForwarderFactory factory, IDonationForwarder.Intent calldata intent, address tokenIn)
        external
    {
        // (the two swaps around this call are irrelevant: the sweep in the middle is what no longer goes through)
        factory.sweep(intent, tokenIn);
    }
}

/// @notice The adversarial review of the v3 conversion contracts, one test per finding, each replaying the
///         reviewer's sequence against the fixed contracts. See docs/DECISIONS.md §14.
contract V3ReviewFindingsTest is PoATest {
    uint256 internal programId;
    address internal donor = makeAddr("depositDonor");

    function setUp() public override {
        super.setUp();
        programId = _createProgram(ngo, 10);
    }

    function _need(uint256 target, uint16 capBps) internal returns (uint256 needId) {
        INeedsRegistry.CreateNeedParams memory p = _needParams(programId, target, 1, _threeTrancheBps());
        p.thirdPartyCostBps = capBps;
        p.costDisclosureHash = capBps == 0 ? bytes32(0) : COST_DISCLOSURE_HASH;
        needId = _verifiedNeedWith(p);
    }

    function _intent(uint256 needId, bytes32 salt) internal view returns (IDonationForwarder.Intent memory) {
        return IDonationForwarder.Intent({
            needId: needId, receiptTo: address(0), refundTo: donor, refundSigner: address(0), salt: salt
        });
    }

    // ─── 1: the admin could reprice or reroute every pending conversion at once ─

    function test_F1_theAdminCannotRepriceOrRerouteMoneyAlreadyWaiting() public {
        uint256 needId = _need(9000e6, 200);
        IDonationForwarder.Intent memory it = _intent(needId, "f1");
        address depositAddress = forwarderFactory.forwarderAddress(it);
        usdc.mint(depositAddress, 5000e6);

        vm.startPrank(admin);
        // a fake EUR/USD price that would push the fair value, and so the minimum output, to zero: only scheduled
        router.setPriceFeed(address(token), address(new MockV3Aggregator(8, 1e30, "EUR / USD")), 1 days);
        // a route through a token the admin controls: refused outright
        address evil = address(new MockUSDC());
        vm.expectRevert(Errors.InvalidParameter.selector);
        router.setRoute(
            address(usdc),
            address(token),
            abi.encodePacked(address(usdc), uint24(100), evil, uint24(100), address(token)),
            100
        );
        vm.stopPrank();

        // during the delay the pending conversion still happens at the real price
        uint256 fair = router.quote(address(usdc), 5000e6, address(token));
        vm.prank(keeper);
        (, uint256 deposited) = forwarderFactory.sweep(it, address(usdc));
        assertGe(deposited, (fair * (10_000 - MAX_SLIPPAGE_BPS)) / 10_000);
        assertGt(resolver.fundingFeesOf(needId), 0, "the real conversion cost is recorded");
    }

    function test_F1_donorsCanLeaveDuringTheDelay() public {
        uint256 needId = _need(9000e6, 200);
        IDonationForwarder.Intent memory it = _intent(needId, "f1-exit");
        address depositAddress = forwarderFactory.forwarderAddress(it);
        usdc.mint(depositAddress, 5000e6);
        forwarderFactory.deploy(it);

        MockV3Aggregator fake = new MockV3Aggregator(8, 1e30, "EUR / USD");
        vm.prank(admin);
        router.setPriceFeed(address(token), address(fake), 1 days);
        vm.prank(donor);
        IDonationForwarder(depositAddress).refund(address(usdc));
        assertEq(usdc.balanceOf(donor), 5000e6);
    }

    // ─── 2: anyone could sandwich a sweep inside one transaction ───────────────

    function test_F2_aStrangerCannotSweep() public {
        uint256 needId = _need(9000e6, 200);
        IDonationForwarder.Intent memory it = _intent(needId, "f2");
        usdc.mint(forwarderFactory.forwarderAddress(it), 5000e6);

        Sandwicher bot = new Sandwicher();
        vm.expectRevert(Errors.Unauthorized.selector);
        bot.attack(forwarderFactory, it, address(usdc));

        address forwarder = forwarderFactory.deploy(it);
        vm.prank(outsider);
        vm.expectRevert(Errors.Unauthorized.selector);
        IDonationForwarder(forwarder).sweep(address(usdc));
    }

    // ─── 3: a nearly full need converted the whole balance, and its cost rounded to zero ─

    function test_F3_aNearlyFullCostlessNeedRefusesTheConversionInsteadOfHidingItsCost() public {
        uint256 needId = _need(9000e6, 0);
        _donate(donor1, needId, 9000e6 - 1);
        IDonationForwarder.Intent memory it = _intent(needId, "f3");
        usdc.mint(forwarderFactory.forwarderAddress(it), 5000e6);

        // only a few units of USDC would be converted, and even their cost rounds up to one unit: the cap says zero
        vm.prank(keeper);
        vm.expectRevert(Errors.FeeExceedsDisclosure.selector);
        forwarderFactory.sweep(it, address(usdc));
        assertEq(usdc.balanceOf(forwarderFactory.forwarderAddress(it)), 5000e6, "nothing was converted");
    }

    function test_F3_aNearlyFullNeedReturnsTheUnneededBalanceUnconverted() public {
        uint256 needId = _need(9000e6, 200);
        _donate(donor1, needId, 8000e6);
        IDonationForwarder.Intent memory it = _intent(needId, "f3-rest");
        usdc.mint(forwarderFactory.forwarderAddress(it), 5000e6);

        uint256 needed = router.maxInputFor(address(usdc), address(token), 1000e6);
        vm.prank(keeper);
        (, uint256 deposited) = forwarderFactory.sweep(it, address(usdc));
        assertEq(deposited, 1000e6);
        assertEq(usdc.balanceOf(donor), 5000e6 - needed, "the rest goes home in the token it came in");
        assertLt(needed, 1100e6);
        assertVaultInvariant(AidVault(registry.vaultOf(needId)));
    }

    // ─── 4: the default USDC route pointed at the empty 0.01% pool ─────────────

    function test_F4_theUsdcRouteDefaultsToTheLiquidFeeTier() public view {
        bytes memory path = router.routeOf(address(usdc), address(token)).path;
        assertEq(uint24(bytes3(this.slice(path, 20, 23))), 500);
    }

    function slice(bytes calldata data, uint256 start, uint256 end) external pure returns (bytes memory) {
        return data[start:end];
    }

    // ─── 5: refund signatures could be replayed on later deposits ──────────────

    function test_F5_aRefundSignatureWorksOnce() public {
        uint256 signerKey = 0xB0B;
        uint256 needId = _need(9000e6, 200);
        IDonationForwarder.Intent memory it = IDonationForwarder.Intent({
            needId: needId, receiptTo: address(0), refundTo: address(0), refundSigner: vm.addr(signerKey), salt: "f5"
        });
        DonationForwarder f = DonationForwarder(payable(forwarderFactory.deploy(it)));
        address oldTo = makeAddr("oneTimeOffRamp");
        uint256 deadline = block.timestamp + 30 days;
        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                f.domainSeparator(),
                keccak256(abi.encode(f.REFUND_TYPEHASH(), address(usdc), oldTo, f.nonce(), deadline))
            )
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerKey, digest);
        bytes memory sig = abi.encodePacked(r, s, v);

        usdc.mint(address(f), 100e6); // a mistaken deposit, retracted
        f.refundWithSignature(address(usdc), oldTo, deadline, sig);

        vm.warp(block.timestamp + 7 days);
        _refreshPrices();
        usdc.mint(address(f), 1000e6); // the real donation
        vm.prank(outsider);
        vm.expectRevert(Errors.InvalidSignature.selector);
        f.refundWithSignature(address(usdc), oldTo, deadline, sig);
        assertEq(usdc.balanceOf(oldTo), 100e6);
    }

    // ─── 6: a forwarder could take over a reference a provider already owned ───
    // Structurally gone since §20: no payment provider writes donor references any more, and a forwarder's
    // reference is its own address, so no other party can claim one first. `donateVia` still refuses a key it
    // does not own, as a guard for any future writer.

    // ─── 7: addresses were handed out for intents that could never be deployed ─

    function test_F7_noAddressForAnUndeployableIntent() public {
        IDonationForwarder.Intent memory it = _intent(_need(1000e6, 200), "f7");
        it.refundTo = address(0);
        vm.expectRevert(Errors.InvalidParameter.selector);
        forwarderFactory.forwarderAddress(it);
    }

    // ─── design: mocks must never stand in for real dependencies on mainnet ────

    function test_mocksAreRefusedOutsideLocalAndTestNetworks() public {
        vm.chainId(8453);
        vm.expectRevert(bytes("SystemDeployer: mocks are only deployed on anvil and Base Sepolia"));
        this.deployWithMocks();
    }

    function deployWithMocks() external {
        _deploySystem(
            Params({
                admin: admin,
                token: address(0),
                eas: address(eas),
                semaphore: address(semaphore),
                highValueThreshold: HIGH_VALUE_THRESHOLD,
                confirmationThresholdBps: CONFIRMATION_THRESHOLD_BPS,
                challengePeriod: CHALLENGE_PERIOD,
                minExpectedRecipients: MIN_EXPECTED_RECIPIENTS,
                dashboardBaseURI: DASHBOARD_BASE_URI,
                yieldVenue: address(0),
                yieldCapBps: 0,
                conversion: _conversionParams()
            })
        );
    }
}
