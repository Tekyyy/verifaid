// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AidVault} from "../../src/funds/AidVault.sol";
import {IDonationForwarder} from "../../src/interfaces/IDonationForwarder.sol";
import {INeedsRegistry} from "../../src/interfaces/INeedsRegistry.sol";
import {Errors} from "../../src/libraries/Errors.sol";
import {PoATest} from "../utils/PoATest.sol";

/// @notice The default deployment holds USD: the vault currency is the chain's USDC, so a donation in USDC (from a
///         wallet, a card on-ramp or an exchange) needs no swap at all, while euros and ETH still convert into it
///         under the Chainlink bound.
contract UsdcVaultTest is PoATest {
    address internal constant NATIVE = address(0);
    uint256 internal constant TARGET = 5000e6;
    address internal donor = makeAddr("usdcDonor");
    uint256 internal programId;

    /// @dev No vault token passed to the deployer: it deploys a mock USDC and holds that.
    function _beforeDeploy() internal override {}

    function _tokenAddress() internal pure override returns (address) {
        return address(0);
    }

    function setUp() public override {
        super.setUp();
        programId = _createProgram(ngo, 10);
    }

    function _need(uint16 capBps) internal returns (uint256 needId, AidVault vault) {
        INeedsRegistry.CreateNeedParams memory p = _needParams(programId, TARGET, 1, _threeTrancheBps());
        p.thirdPartyCostBps = capBps;
        p.costDisclosureHash = capBps == 0 ? bytes32(0) : COST_DISCLOSURE_HASH;
        needId = _verifiedNeedWith(p);
        vault = AidVault(registry.vaultOf(needId));
    }

    function test_theVaultCurrencyIsTheChainsUsdc() public {
        assertEq(address(token), address(usdc), "the vault holds USDC itself");
        assertTrue(address(eurc) != address(token), "euros are a separate, convertible token");
        // Nothing to swap, so there is no route for the vault's own currency.
        vm.expectRevert(Errors.RouteNotSet.selector);
        router.maxSlippageBpsOf(address(usdc), address(token));
        assertEq(router.quote(address(usdc), 1234e6, address(token)), 1234e6, "one for one");
    }

    function test_usdcDonationsCostNothingEvenWithoutACostCap() public {
        (uint256 needId, AidVault vault) = _need(0); // a need that allows no intermediary costs at all
        usdc.mint(donor, 1000e6);

        vm.startPrank(donor);
        usdc.approve(address(forwarderFactory), 1000e6);
        (uint256 deposited, uint256 receiptId) = forwarderFactory.donate(needId, address(usdc), 1000e6);
        vm.stopPrank();

        assertEq(deposited, 1000e6, "every unit reaches the need");
        assertEq(resolver.fundingFeesOf(needId), 0, "nothing was converted, so nothing was lost");
        assertEq(receipt.ownerOf(receiptId), donor);
        assertEq(vault.totalDonated(), 1000e6);
        assertVaultInvariant(vault);
    }

    function test_eurosStillConvertIntoTheVaultCurrency() public {
        (uint256 needId, AidVault vault) = _need(200);
        assertEq(router.quote(address(eurc), 1000e6, address(token)), 1080e6, "1 EUR = 1.08 USD");
        eurc.mint(donor, 1000e6);

        vm.startPrank(donor);
        eurc.approve(address(forwarderFactory), 1000e6);
        (uint256 deposited,) = forwarderFactory.donate(needId, address(eurc), 1000e6);
        vm.stopPrank();

        assertEq(deposited, 1_079_460_000, "1,080 USDC minus the mock pool's 0.05%");
        assertEq(resolver.fundingFeesOf(needId), 540_000);
        assertVaultInvariant(vault);
    }

    function test_ethConvertsInOneHop() public {
        (uint256 needId, AidVault vault) = _need(200);
        assertEq(router.quote(NATIVE, 1 ether, address(token)), 2500e6, "ETH at 2,500 USD");
        vm.deal(donor, 1 ether);

        vm.prank(donor);
        (uint256 deposited,) = forwarderFactory.donate{value: 1 ether}(needId, NATIVE, 1 ether);
        uint256 fair = 2500e6;
        assertGe(deposited, (fair * (10_000 - MAX_SLIPPAGE_BPS)) / 10_000);
        assertVaultInvariant(vault);
    }

    function test_anExchangeWithdrawalInUsdcIsSweptWithoutASwap() public {
        (uint256 needId, AidVault vault) = _need(0);
        IDonationForwarder.Intent memory intent = IDonationForwarder.Intent({
            needId: needId,
            receiptTo: address(0),
            refundTo: donor,
            refundSigner: address(0),
            salt: keccak256("usdc-deposit")
        });
        address depositAddress = forwarderFactory.forwarderAddress(intent);
        usdc.mint(depositAddress, 2000e6);

        vm.prank(keeper);
        (, uint256 deposited) = forwarderFactory.sweep(intent, address(usdc));
        assertEq(deposited, 2000e6, "a pass-through: no pool, no price, no cost");
        assertEq(resolver.fundingFeesOf(needId), 0);
        assertVaultInvariant(vault);
    }
}
