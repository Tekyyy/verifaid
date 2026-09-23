// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AidVault} from "../../src/funds/AidVault.sol";
import {DonationForwarder} from "../../src/funds/DonationForwarder.sol";
import {IAidVault} from "../../src/interfaces/IAidVault.sol";
import {IDonationForwarder} from "../../src/interfaces/IDonationForwarder.sol";
import {IDonationForwarderFactory} from "../../src/interfaces/IDonationForwarderFactory.sol";
import {INeedsRegistry} from "../../src/interfaces/INeedsRegistry.sol";
import {Errors} from "../../src/libraries/Errors.sol";
import {PoATest} from "../utils/PoATest.sol";

/// @notice Donations that need converting: a wallet giving USDC or ETH in one transaction, and deposit addresses
///         that receive money from somewhere that cannot call a contract, then get swept by the donor or a keeper.
contract DonationForwarderTest is PoATest {
    address internal constant NATIVE = address(0);
    uint256 internal constant TARGET = 5000e6;
    uint16 internal constant COST_CAP_BPS = 200; // 2%

    uint256 internal needId;
    AidVault internal vault;
    uint256 internal programId;

    address internal donor = makeAddr("walletDonor");
    uint256 internal refundKey = 0xA11CE;
    address internal refundSigner;

    function setUp() public override {
        super.setUp();
        refundSigner = vm.addr(refundKey);
        programId = _createProgram(ngo, 10);
        needId = _verifiedNeedWith(_costedNeed(TARGET, COST_CAP_BPS));
        vault = AidVault(registry.vaultOf(needId));
    }

    function _costedNeed(uint256 target, uint16 capBps)
        internal
        view
        returns (INeedsRegistry.CreateNeedParams memory p)
    {
        p = _needParams(programId, target, 1, _threeTrancheBps());
        p.thirdPartyCostBps = capBps;
        p.costDisclosureHash = capBps == 0 ? bytes32(0) : COST_DISCLOSURE_HASH;
    }

    function _giveUsdc(address from, uint256 amount) internal returns (uint256 deposited, uint256 receiptId) {
        usdc.mint(from, amount);
        vm.startPrank(from);
        usdc.approve(address(forwarderFactory), amount);
        (deposited, receiptId) = forwarderFactory.donate(needId, address(usdc), amount);
        vm.stopPrank();
    }

    function _intent(address receiptTo, address refundTo, address signer, bytes32 salt)
        internal
        view
        returns (IDonationForwarder.Intent memory)
    {
        return IDonationForwarder.Intent({
            needId: needId, receiptTo: receiptTo, refundTo: refundTo, refundSigner: signer, salt: salt
        });
    }

    function _sign(address forwarder, bytes32 structHash) internal view returns (bytes memory) {
        bytes32 digest = keccak256(
            abi.encodePacked("\x19\x01", DonationForwarder(payable(forwarder)).domainSeparator(), structHash)
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(refundKey, digest);
        return abi.encodePacked(r, s, v);
    }

    // ─── wallet donations ──────────────────────────────────────────────────────

    function test_donate_usdcIsConvertedDonatedAndReceipted() public {
        (uint256 deposited, uint256 receiptId) = _giveUsdc(donor, 1080e6);

        assertEq(deposited, 999_499_999);
        assertEq(vault.totalDonated(), deposited);
        assertEq(vault.donatedBy(donor), deposited, "credited to the wallet, which can claim its own refund");
        assertEq(receipt.ownerOf(receiptId), donor);
        // fair value 1,000 EURC minus 999.499999 received: counted against the 2% cap, not attested by anyone
        assertEq(resolver.fundingFeesOf(needId), 500_001);
        assertEq(usdc.balanceOf(address(forwarderFactory)), 0);
        assertEq(token.balanceOf(address(forwarderFactory)), 0);
        assertVaultInvariant(vault);
    }

    function test_donate_ethIsConverted() public {
        vm.deal(donor, 1 ether);
        vm.prank(donor);
        (uint256 deposited, uint256 receiptId) = forwarderFactory.donate{value: 1 ether}(needId, NATIVE, 1 ether);
        assertGt(deposited, 2300e6);
        assertEq(receipt.ownerOf(receiptId), donor);
        assertEq(address(forwarderFactory).balance, 0);
    }

    function test_donate_aboveTheTargetConvertsOnlyWhatFillsTheNeed() public {
        uint256 needed = router.maxInputFor(address(usdc), address(token), TARGET);
        assertLt(needed, 5460e6, "5,000 EURC at 1.08 within a 1% bound, plus rounding");
        (uint256 deposited,) = _giveUsdc(donor, 6000e6); // worth ~5,555 EURC against a 5,000 target
        assertEq(deposited, TARGET);
        assertTrue(vault.fundingClosed());
        assertEq(usdc.balanceOf(donor), 6000e6 - needed, "the USDC the need did not need was never converted");
        // the swap beat the bound: that surplus was converted, and comes back in the vault's token
        assertEq(token.balanceOf(donor), 47_979_801);
        assertEq(usdc.balanceOf(address(forwarderFactory)), 0);
        assertEq(token.balanceOf(address(forwarderFactory)), 0);
        assertVaultInvariant(vault);
    }

    function test_donate_ethAboveTheTargetReturnsTheUnusedEth() public {
        uint256 needed = router.maxInputFor(NATIVE, address(token), TARGET);
        vm.deal(donor, 5 ether); // worth ~11,574 EURC
        vm.prank(donor);
        (uint256 deposited,) = forwarderFactory.donate{value: 5 ether}(needId, NATIVE, 5 ether);
        assertEq(deposited, TARGET);
        assertEq(donor.balance, 5 ether - needed);
        assertEq(address(forwarderFactory).balance, 0);
    }

    function test_donate_conversionCostsCountAgainstTheDisclosedCap() public {
        // a need that promised zero intermediary costs cannot take a donation whose swap cost anything
        vm.prank(ngo);
        uint256 costless = registry.createNeed(_costedNeed(TARGET, 0));
        _attestNeedVerified(verifier1, costless, true);

        usdc.mint(donor, 108e6);
        vm.startPrank(donor);
        usdc.approve(address(forwarderFactory), 108e6);
        vm.expectRevert(Errors.FeeExceedsDisclosure.selector);
        forwarderFactory.donate(costless, address(usdc), 108e6);
        vm.stopPrank();

        // the need's own stablecoin needs no conversion, so it costs nothing
        token.mint(donor, 100e6);
        vm.startPrank(donor);
        token.approve(address(forwarderFactory), 100e6);
        (uint256 deposited,) = forwarderFactory.donate(costless, address(token), 100e6);
        vm.stopPrank();
        assertEq(deposited, 100e6);
    }

    function test_donate_refusesNeedsThatAreNotAccepting() public {
        vm.prank(ngo);
        uint256 pending = registry.createNeed(_costedNeed(TARGET, COST_CAP_BPS));

        usdc.mint(donor, 100e6);
        vm.deal(donor, 1); // so the value-mismatch call below fails in the factory, not for lack of ETH
        vm.startPrank(donor);
        usdc.approve(address(forwarderFactory), 100e6);
        vm.expectRevert(Errors.NotAccepting.selector);
        forwarderFactory.donate(pending, address(usdc), 100e6);
        vm.expectRevert(Errors.ZeroAmount.selector);
        forwarderFactory.donate(needId, address(usdc), 0);
        vm.expectRevert(Errors.InvalidParameter.selector);
        forwarderFactory.donate{value: 1}(needId, address(usdc), 100e6);
        vm.stopPrank();
        assertEq(usdc.balanceOf(donor), 100e6, "nothing left the wallet");
    }

    // ─── deposit addresses ─────────────────────────────────────────────────────

    function test_depositAddress_isKnownBeforeDeploymentAndSweptByAKeeper() public {
        IDonationForwarder.Intent memory it = _intent(address(0), address(0), refundSigner, keccak256("card-1"));
        address depositAddress = forwarderFactory.forwarderAddress(it);
        assertEq(depositAddress.code.length, 0);

        // an exchange withdrawal lands on the address before anything exists there
        usdc.mint(depositAddress, 1080e6);

        vm.expectEmit(true, true, false, false, address(forwarderFactory));
        emit IDonationForwarderFactory.ForwarderDeployed(
            depositAddress, needId, address(0), address(0), refundSigner, 0
        );
        vm.prank(keeper);
        (address forwarder, uint256 deposited) = forwarderFactory.sweep(it, address(usdc));

        assertEq(forwarder, depositAddress);
        assertTrue(forwarderFactory.isForwarder(forwarder));
        assertEq(deposited, 999_499_999);
        bytes32 key = bytes32(uint256(uint160(forwarder)));
        assertEq(vault.donatedByRef(key), deposited, "credited to the deposit address itself");
        assertEq(vault.refPartner(key), forwarder);
        assertEq(IDonationForwarder(forwarder).intent().refundSigner, refundSigner);

        // more money later adds up under the same tracking reference
        usdc.mint(forwarder, 108e6);
        vm.prank(keeper);
        IDonationForwarder(forwarder).sweep(address(usdc));
        assertEq(vault.donatedByRef(key), deposited + 99_949_999);
        assertVaultInvariant(vault);
    }

    function test_depositAddress_differentIntentsNeverShareAnAddress() public view {
        IDonationForwarder.Intent memory it = _intent(address(0), donor, address(0), keccak256("s"));
        IDonationForwarder.Intent memory squat = _intent(address(0), outsider, address(0), keccak256("s"));
        assertTrue(forwarderFactory.forwarderAddress(it) != forwarderFactory.forwarderAddress(squat));
    }

    function test_depositAddress_validatesIntents() public {
        IDonationForwarder.Intent memory noRefund = _intent(address(0), address(0), address(0), keccak256("x"));
        vm.expectRevert(Errors.InvalidParameter.selector);
        forwarderFactory.deploy(noRefund);
        // an address that could never be deployed is never handed out (review finding 7)
        vm.expectRevert(Errors.InvalidParameter.selector);
        forwarderFactory.forwarderAddress(noRefund);

        IDonationForwarder.Intent memory unknownNeed = _intent(address(0), donor, address(0), keccak256("x"));
        unknownNeed.needId = 999;
        vm.expectRevert(Errors.NeedNotFound.selector);
        forwarderFactory.deploy(unknownNeed);
        vm.expectRevert(Errors.NeedNotFound.selector);
        forwarderFactory.forwarderAddress(unknownNeed);

        IDonationForwarder.Intent memory it = _intent(address(0), donor, address(0), keccak256("x"));
        address first = forwarderFactory.deploy(it);
        assertEq(forwarderFactory.deploy(it), first, "deploying again is a no-op");

        vm.prank(donor);
        vm.expectRevert(Errors.NothingToSweep.selector);
        IDonationForwarder(first).sweep(address(usdc));
    }

    /// @notice Review finding 2: only the intent's own wallets or a keeper can sweep, so nobody can wrap a sweep
    ///         between two swaps of their own in one transaction.
    function test_sweep_onlyTheDonorOrAKeeper() public {
        IDonationForwarder.Intent memory it = _intent(donor, makeAddr("refunds"), address(0), keccak256("auth"));
        address depositAddress = forwarderFactory.forwarderAddress(it);
        usdc.mint(depositAddress, 216e6);

        vm.prank(outsider);
        vm.expectRevert(Errors.Unauthorized.selector);
        forwarderFactory.sweep(it, address(usdc));

        vm.prank(it.refundTo);
        forwarderFactory.sweep(it, address(usdc));
        usdc.mint(depositAddress, 108e6);
        vm.prank(outsider);
        vm.expectRevert(Errors.Unauthorized.selector);
        IDonationForwarder(depositAddress).sweep(address(usdc));
        vm.prank(donor); // receiptTo
        IDonationForwarder(depositAddress).sweep(address(usdc));

        vm.prank(outsider);
        vm.expectRevert(Errors.Unauthorized.selector);
        forwarderFactory.setKeeper(outsider, true);
        vm.expectEmit(true, false, false, true, address(forwarderFactory));
        emit IDonationForwarderFactory.KeeperSet(keeper, false);
        vm.prank(admin);
        forwarderFactory.setKeeper(keeper, false);
        assertFalse(forwarderFactory.isKeeper(keeper));
        assertEq(IDonationForwarder(depositAddress).factory(), address(forwarderFactory));
    }

    function test_depositAddress_leftoverAboveTheTargetGoesToRefundTo() public {
        IDonationForwarder.Intent memory it = _intent(address(0), donor, address(0), keccak256("big"));
        address depositAddress = forwarderFactory.forwarderAddress(it);
        usdc.mint(depositAddress, 6000e6);
        uint256 needed = router.maxInputFor(address(usdc), address(token), TARGET);
        vm.prank(keeper);
        forwarderFactory.sweep(it, address(usdc));
        assertEq(vault.totalDonated(), TARGET);
        assertEq(usdc.balanceOf(donor), 6000e6 - needed, "unconverted USDC goes home as USDC");
        assertEq(token.balanceOf(donor), 47_979_801, "the swap's surplus above the target, in the vault token");
        assertEq(token.balanceOf(depositAddress), 0);
        assertEq(usdc.balanceOf(depositAddress), 0);
    }

    // ─── refunds from a deposit address ────────────────────────────────────────

    function test_refund_donorMayRetractBeforeTheSweep_othersOnlyOnceTheNeedStopsAccepting() public {
        IDonationForwarder.Intent memory it = _intent(address(0), donor, address(0), keccak256("r"));
        address forwarder = forwarderFactory.deploy(it);
        usdc.mint(forwarder, 50e6);

        vm.prank(outsider);
        vm.expectRevert(Errors.Unauthorized.selector);
        IDonationForwarder(forwarder).refund(address(usdc));

        vm.prank(donor);
        IDonationForwarder(forwarder).refund(address(usdc));
        assertEq(usdc.balanceOf(donor), 50e6);

        // funds that arrive after the need was cancelled can be sent home by anyone
        usdc.mint(forwarder, 20e6);
        vm.prank(ngo);
        registry.cancelNeed(needId);
        assertFalse(IDonationForwarder(forwarder).accepting());
        vm.prank(donor);
        vm.expectRevert(Errors.NotAccepting.selector);
        IDonationForwarder(forwarder).sweep(address(usdc));
        vm.prank(outsider);
        IDonationForwarder(forwarder).refund(address(usdc));
        assertEq(usdc.balanceOf(donor), 70e6);
    }

    function test_refundWithSignature_lets_aCardDonorWithoutAWalletRecoverFunds() public {
        IDonationForwarder.Intent memory it = _intent(address(0), address(0), refundSigner, keccak256("card"));
        address forwarder = forwarderFactory.deploy(it);
        vm.deal(forwarder, 0.5 ether);
        address to = makeAddr("newWallet");
        uint256 deadline = block.timestamp + 1 hours;
        DonationForwarder f = DonationForwarder(payable(forwarder));

        bytes memory sig = _sign(forwarder, keccak256(abi.encode(f.REFUND_TYPEHASH(), NATIVE, to, 0, deadline)));

        // a signature for another recipient does not verify
        vm.expectRevert(Errors.InvalidSignature.selector);
        f.refundWithSignature(NATIVE, outsider, deadline, sig);

        f.refundWithSignature(NATIVE, to, deadline, sig);
        assertEq(to.balance, 0.5 ether);
        assertEq(f.nonce(), 1);

        // money that arrives later cannot be pulled with the old signature (review finding 5)
        vm.deal(forwarder, 1 ether);
        vm.expectRevert(Errors.InvalidSignature.selector);
        f.refundWithSignature(NATIVE, to, deadline, sig);

        bytes memory next = _sign(forwarder, keccak256(abi.encode(f.REFUND_TYPEHASH(), NATIVE, to, 1, deadline)));
        vm.warp(deadline + 1);
        vm.expectRevert(Errors.SignatureExpired.selector);
        f.refundWithSignature(NATIVE, to, deadline, next);

        // no refundTo on this intent, so the unsigned path is closed
        vm.expectRevert(Errors.Unauthorized.selector);
        f.refund(NATIVE);
    }

    function test_claimVaultRefund_returnsAForwarderCreditedDonation() public {
        IDonationForwarder.Intent memory it = _intent(address(0), donor, address(0), keccak256("v"));
        address depositAddress = forwarderFactory.forwarderAddress(it);
        usdc.mint(depositAddress, 1080e6);
        vm.prank(keeper);
        (, uint256 deposited) = forwarderFactory.sweep(it, address(usdc));

        vm.prank(ngo);
        registry.cancelNeed(needId);
        vm.prank(outsider); // anyone can trigger it; it only ever pays refundTo
        uint256 amount = IDonationForwarder(depositAddress).claimVaultRefund();
        assertEq(amount, deposited);
        assertEq(token.balanceOf(donor), deposited);
        assertVaultInvariant(vault);
    }

    function test_claimVaultRefundWithSignature_andReceiptHoldersClaimDirectly() public {
        IDonationForwarder.Intent memory card = _intent(address(0), address(0), refundSigner, keccak256("c"));
        address cardAddress = forwarderFactory.forwarderAddress(card);
        usdc.mint(cardAddress, 1080e6);
        vm.prank(keeper);
        forwarderFactory.sweep(card, address(usdc));

        IDonationForwarder.Intent memory withWallet = _intent(donor, donor, address(0), keccak256("w"));
        address walletAddress = forwarderFactory.forwarderAddress(withWallet);
        usdc.mint(walletAddress, 108e6);
        vm.prank(donor);
        forwarderFactory.sweep(withWallet, address(usdc));

        vm.prank(ngo);
        registry.cancelNeed(needId);

        address to = makeAddr("recovered");
        uint256 deadline = block.timestamp + 1 hours;
        DonationForwarder f = DonationForwarder(payable(cardAddress));
        bytes memory sig = _sign(cardAddress, keccak256(abi.encode(f.VAULT_REFUND_TYPEHASH(), to, 0, deadline)));
        assertEq(f.claimVaultRefundWithSignature(to, deadline, sig), 999_499_999);
        assertEq(token.balanceOf(to), 999_499_999);

        // a donation credited to a wallet is that wallet's to claim, not the forwarder's
        vm.expectRevert(Errors.Unauthorized.selector);
        IDonationForwarder(walletAddress).claimVaultRefund();
        vm.prank(donor);
        assertEq(vault.claimRefund(), 99_949_999);
        assertVaultInvariant(vault);
    }

    // ─── authorization ─────────────────────────────────────────────────────────

    function test_donateVia_onlyFromTheFactoryOrItsForwarders() public {
        token.mint(outsider, 10e6);
        vm.startPrank(outsider);
        token.approve(address(vault), 10e6);
        vm.expectRevert(Errors.Unauthorized.selector);
        vault.donateVia(10e6, 0, outsider);
        vm.stopPrank();

        // the factory itself must always credit a wallet
        vm.prank(address(forwarderFactory));
        vm.expectRevert(Errors.Unauthorized.selector);
        vault.donateVia(10e6, 0, address(0));

        // the forwarder implementation is not a forwarder
        DonationForwarder implementation = DonationForwarder(payable(forwarderFactory.implementation()));
        vm.expectRevert(Errors.NotLedger.selector);
        implementation.sweep(address(usdc));
    }

    function test_recordConversionFee_onlyFromTheNeedsOwnVault() public {
        vm.expectRevert(Errors.Unauthorized.selector);
        resolver.recordConversionFee(needId, 1);
    }

    function test_donatedVia_emitsTheConversionDetails() public {
        usdc.mint(donor, 1080e6);
        vm.startPrank(donor);
        usdc.approve(address(forwarderFactory), 1080e6);
        vm.expectEmit(true, true, true, true, address(vault));
        emit IAidVault.DonatedVia(needId, address(forwarderFactory), donor, 999_499_999, 500_001, 1);
        forwarderFactory.donate(needId, address(usdc), 1080e6);
        vm.stopPrank();
    }
}
