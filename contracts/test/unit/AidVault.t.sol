// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AidVault} from "../../src/funds/AidVault.sol";
import {IAidVault} from "../../src/interfaces/IAidVault.sol";
import {IAidVaultFactory} from "../../src/interfaces/IAidVaultFactory.sol";
import {IDonationReceipt} from "../../src/interfaces/IDonationReceipt.sol";
import {INeedsRegistry} from "../../src/interfaces/INeedsRegistry.sol";
import {ITrancheLedger} from "../../src/interfaces/ITrancheLedger.sol";
import {Errors} from "../../src/libraries/Errors.sol";
import {PoATest} from "../utils/PoATest.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract AidVaultTest is PoATest {
    uint256 internal constant TARGET = 10_000e6;

    uint256 internal needId;
    uint256 internal programId;
    AidVault internal vault;

    bytes32 internal constant DONOR_REF = keccak256("salted-donor-ref");
    bytes32 internal constant PAYMENT_REF = keccak256("salted-payment-ref");

    function setUp() public override {
        super.setUp();
        (needId, programId, vault) = _verifiedNeed(TARGET);
    }

    // ─── clone configuration ───────────────────────────────────────────────────

    function test_clone_isConfiguredWithoutAnInitializer() public view {
        assertEq(vault.needId(), needId, "need id read from the clone's code");
        assertEq(address(vault.registry()), address(registry));
        assertEq(address(vault.token()), address(token));
        assertEq(address(vault.receipt()), address(receipt));
        assertEq(address(vault.roles()), address(roles));
        assertEq(address(vault.factory()), address(factory));
        assertEq(vault.deliveryManager(), address(deliveryManager));
        assertEq(vault.trancheCount(), 3);
        assertTrue(factory.isVault(address(vault)));
        assertTrue(factory.isLedger(address(vault)));

        ITrancheLedger.Tranche[] memory tranches = vault.getTranches();
        assertEq(tranches[0].bps, 3000);
        assertEq(tranches[1].bps, 4000);
        assertEq(tranches[2].bps, 3000);
        for (uint256 i; i < tranches.length; ++i) {
            assertEq(tranches[i].amount, 0);
            assertEq(tranches[i].status, ITrancheLedger.TrancheStatus.Locked);
        }
    }

    /// @dev The implementation is shared code, not a vault: nothing may be deposited into it or closed on it.
    function test_implementation_rejectsDirectUse() public {
        AidVault implementation = AidVault(factory.implementation());
        vm.expectRevert(Errors.NotLedger.selector);
        implementation.donate(1);
        vm.expectRevert(Errors.NotLedger.selector);
        implementation.closeFunding();
        vm.expectRevert(Errors.NotLedger.selector);
        implementation.releaseTranche(0);
        vm.expectRevert(Errors.NotLedger.selector);
        implementation.claimRefund();
    }

    function test_constructor_revertsOnZeroAddresses() public {
        IAidVaultFactory f = IAidVaultFactory(address(factory));
        IDonationReceipt r = IDonationReceipt(address(receipt));
        vm.expectRevert(Errors.ZeroAddress.selector);
        new AidVault(roles, registry, address(deliveryManager), f, IERC20(address(0)), r);
        vm.expectRevert(Errors.ZeroAddress.selector);
        new AidVault(roles, registry, address(deliveryManager), f, IERC20(address(token)), IDonationReceipt(address(0)));
        vm.expectRevert(Errors.ZeroAddress.selector);
        new AidVault(roles, INeedsRegistry(address(0)), address(deliveryManager), f, IERC20(address(token)), r);
        vm.expectRevert(Errors.ZeroAddress.selector);
        new AidVault(roles, registry, address(0), f, IERC20(address(token)), r);
    }

    // ─── direct donations ──────────────────────────────────────────────────────

    function test_donate() public {
        _fundDonor(donor1, needId, 1000e6);
        vm.expectEmit(true, true, false, true, address(vault));
        emit IAidVault.Donated(needId, donor1, 1000e6, 1);
        vm.prank(donor1);
        uint256 receiptId = vault.donate(1000e6);

        assertEq(receiptId, 1);
        assertEq(vault.totalDonated(), 1000e6);
        assertEq(vault.donatedBy(donor1), 1000e6);
        assertEq(token.balanceOf(address(vault)), 1000e6);
        assertEq(receipt.ownerOf(receiptId), donor1);
        assertEq(receipt.receiptOf(receiptId).needId, needId);
        assertEq(receipt.receiptOf(receiptId).amount, 1000e6);
        assertVaultInvariant(vault);
    }

    function test_donate_accumulatesPerDonor() public {
        _donate(donor1, needId, 1000e6);
        _donate(donor1, needId, 500e6);
        _donate(donor2, needId, 250e6);
        assertEq(vault.donatedBy(donor1), 1500e6);
        assertEq(vault.donatedBy(donor2), 250e6);
        assertEq(vault.totalDonated(), 1750e6);
        assertVaultInvariant(vault);
    }

    function test_donate_revertsOnZeroAmount() public {
        vm.prank(donor1);
        vm.expectRevert(Errors.ZeroAmount.selector);
        vault.donate(0);
    }

    function test_donate_revertsAboveTarget() public {
        token.mint(donor1, TARGET + 1);
        vm.startPrank(donor1);
        token.approve(address(vault), TARGET + 1);
        vm.expectRevert(Errors.ExceedsTarget.selector);
        vault.donate(TARGET + 1);
        vm.stopPrank();
    }

    function test_donate_revertsWhenNotFunding() public {
        uint256 pendingNeed = _createNeed(ngo, programId, 5000e6, 1);
        assertEq(registry.statusOf(pendingNeed), INeedsRegistry.NeedStatus.Pending);

        // cancel this need, then donating must fail on a closed vault too
        _donate(donor1, needId, TARGET); // closes funding at target
        token.mint(donor2, 1e6);
        vm.startPrank(donor2);
        token.approve(address(vault), 1e6);
        vm.expectRevert(Errors.FundingNotOpen.selector);
        vault.donate(1e6);
        vm.stopPrank();
    }

    function test_donate_revertsWhenPaused() public {
        token.mint(donor1, 1e6);
        vm.prank(donor1);
        token.approve(address(vault), 1e6);
        vm.prank(admin);
        roles.pause();
        vm.prank(donor1);
        vm.expectRevert(Errors.SystemPaused.selector);
        vault.donate(1e6);
    }

    function test_donate_reachingTargetClosesFunding() public {
        _donate(donor1, needId, TARGET - 1e6);
        assertFalse(vault.fundingClosed());

        _fundDonor(donor2, needId, 1e6);
        vm.expectEmit(true, false, false, true, address(vault));
        emit ITrancheLedger.FundingClosed(needId, TARGET);
        vm.prank(donor2);
        vault.donate(1e6);

        assertTrue(vault.fundingClosed());
        assertEq(registry.statusOf(needId), INeedsRegistry.NeedStatus.Funded);
        assertEq(vault.trancheStatus(0), ITrancheLedger.TrancheStatus.Releasable);
    }

    // ─── fiat donations ────────────────────────────────────────────────────────

    function test_donateOnBehalf() public {
        _fundDonor(bankPartner, needId, 2000e6);
        vm.expectEmit(true, true, false, true, address(vault));
        emit IAidVault.DonatedOnBehalf(needId, bankPartner, 2000e6, DONOR_REF, PAYMENT_REF);
        vm.prank(bankPartner);
        vault.donateOnBehalf(2000e6, DONOR_REF, PAYMENT_REF);

        assertEq(vault.totalDonated(), 2000e6);
        assertEq(vault.donatedByRef(DONOR_REF), 2000e6);
        assertEq(vault.refPartner(DONOR_REF), bankPartner);
        assertTrue(factory.paymentRefConsumed(PAYMENT_REF));

        // one digest per deposit is all the resolver needs to check a FundingRecorded attestation
        assertTrue(vault.fiatDepositMatches(PAYMENT_REF, bankPartner, DONOR_REF, 2000e6));
        assertFalse(vault.fiatDepositMatches(PAYMENT_REF, bankPartner, DONOR_REF, 1999e6));
        assertFalse(vault.fiatDepositMatches(PAYMENT_REF, outsider, DONOR_REF, 2000e6));
        assertFalse(vault.fiatDepositMatches(keccak256("unknown"), bankPartner, DONOR_REF, 2000e6));

        // no NFT receipt is minted for fiat donors
        assertEq(receipt.totalMinted(), 0);
        assertVaultInvariant(vault);
    }

    function test_donateOnBehalf_revertsForNonPartner() public {
        token.mint(donor1, 100e6);
        vm.startPrank(donor1);
        token.approve(address(vault), 100e6);
        vm.expectRevert(Errors.Unauthorized.selector);
        vault.donateOnBehalf(100e6, DONOR_REF, PAYMENT_REF);
        vm.stopPrank();
    }

    function test_donateOnBehalf_revertsOnZeroRefs() public {
        token.mint(bankPartner, 100e6);
        vm.startPrank(bankPartner);
        token.approve(address(vault), 100e6);
        vm.expectRevert(Errors.InvalidParameter.selector);
        vault.donateOnBehalf(100e6, bytes32(0), PAYMENT_REF);
        vm.expectRevert(Errors.InvalidParameter.selector);
        vault.donateOnBehalf(100e6, DONOR_REF, bytes32(0));
        vm.stopPrank();
    }

    function test_donateOnBehalf_rejectsReusedPaymentReference() public {
        _donateOnBehalf(needId, 1000e6, DONOR_REF, PAYMENT_REF);
        token.mint(bankPartner, 1000e6);
        vm.startPrank(bankPartner);
        token.approve(address(vault), 1000e6);
        vm.expectRevert(Errors.PaymentRefAlreadyUsed.selector);
        vault.donateOnBehalf(1000e6, DONOR_REF, PAYMENT_REF);
        vm.stopPrank();
    }

    function test_donateOnBehalf_rejectsPaymentReferenceReusedOnAnotherNeed() public {
        _donateOnBehalf(needId, 1000e6, DONOR_REF, PAYMENT_REF);

        uint256 otherNeed = _createNeed(ngo, programId, 5000e6, 1);
        _attestNeedVerified(verifier1, otherNeed, true);
        address otherVault = registry.vaultOf(otherNeed);

        token.mint(bankPartner, 1000e6);
        vm.startPrank(bankPartner);
        token.approve(otherVault, 1000e6);
        vm.expectRevert(Errors.PaymentRefAlreadyUsed.selector);
        IAidVault(otherVault).donateOnBehalf(1000e6, DONOR_REF, PAYMENT_REF);
        vm.stopPrank();
    }

    function test_donateOnBehalf_rejectsForeignPartnerForSameDonorRef() public {
        _donateOnBehalf(needId, 1000e6, DONOR_REF, PAYMENT_REF);

        address partner2 = makeAddr("partner2");
        vm.prank(admin);
        roles.registerBankPartner(partner2);
        token.mint(partner2, 1000e6);
        vm.startPrank(partner2);
        token.approve(address(vault), 1000e6);
        vm.expectRevert(Errors.DonorRefPartnerMismatch.selector);
        vault.donateOnBehalf(1000e6, DONOR_REF, keccak256("other-payment-ref"));
        vm.stopPrank();
    }

    // ─── closing funding ───────────────────────────────────────────────────────

    function test_closeFunding_splitsTranchesAndAssignsDustToLast() public {
        _donate(donor1, needId, 1001e6 + 1); // 1_001_000_001 base units

        vm.prank(ngo);
        vault.closeFunding();

        uint256 total = vault.totalDonated();
        ITrancheLedger.Tranche[] memory tranches = vault.getTranches();
        assertEq(tranches[0].amount, (total * 3000) / 10_000);
        assertEq(tranches[1].amount, (total * 4000) / 10_000);
        assertEq(tranches[2].amount, total - tranches[0].amount - tranches[1].amount);
        assertEq(tranches[0].amount + tranches[1].amount + tranches[2].amount, total);
        assertEq(tranches[0].status, ITrancheLedger.TrancheStatus.Releasable);
        assertEq(tranches[1].status, ITrancheLedger.TrancheStatus.Locked);
        assertEq(registry.statusOf(needId), INeedsRegistry.NeedStatus.Funded);
    }

    function test_closeFunding_revertsForNonNgo() public {
        _donate(donor1, needId, 100e6);
        vm.prank(outsider);
        vm.expectRevert(Errors.Unauthorized.selector);
        vault.closeFunding();
    }

    function test_closeFunding_revertsWithoutDonationsOrTwice() public {
        vm.prank(ngo);
        vm.expectRevert(Errors.NothingDonated.selector);
        vault.closeFunding();

        _donate(donor1, needId, 100e6);
        vm.prank(ngo);
        vault.closeFunding();
        vm.prank(ngo);
        vm.expectRevert(Errors.FundingNotOpen.selector);
        vault.closeFunding();
    }

    function test_closeFunding_revertsWhenPaused() public {
        _donate(donor1, needId, 100e6);
        vm.prank(admin);
        roles.pause();
        vm.prank(ngo);
        vm.expectRevert(Errors.SystemPaused.selector);
        vault.closeFunding();
    }

    // ─── tranche releases ──────────────────────────────────────────────────────

    function _fundAndClose(uint256 amount) internal {
        _donate(donor1, needId, amount);
        vm.prank(ngo);
        vault.closeFunding();
    }

    function test_releaseTranche_zeroStartsDelivery() public {
        _fundAndClose(1000e6);
        uint256 expected = vault.getTranches()[0].amount;

        vm.expectEmit(true, true, false, true, address(vault));
        emit ITrancheLedger.TrancheReleased(needId, 0, expected, ngoPayout);
        vault.releaseTranche(0);

        assertEq(token.balanceOf(ngoPayout), expected);
        assertEq(vault.totalReleased(), expected);
        assertEq(vault.trancheStatus(0), ITrancheLedger.TrancheStatus.Released);
        assertEq(registry.statusOf(needId), INeedsRegistry.NeedStatus.InDelivery);
        assertVaultInvariant(vault);
    }

    function test_releaseTranche_revertsOnInvalidIndexOrStatus() public {
        _fundAndClose(1000e6);
        vm.expectRevert(Errors.InvalidTrancheIndex.selector);
        vault.releaseTranche(3);
        vm.expectRevert(Errors.InvalidTrancheStatus.selector);
        vault.releaseTranche(1);

        vault.releaseTranche(0);
        vm.expectRevert(Errors.InvalidTrancheStatus.selector);
        vault.releaseTranche(0);
    }

    function test_releaseTranche_revertsWhenNgoInactiveOrPaused() public {
        _fundAndClose(1000e6);

        vm.prank(admin);
        roles.setNgoActive(ngo, false);
        vm.expectRevert(Errors.NgoInactive.selector);
        vault.releaseTranche(0);
        vm.prank(admin);
        roles.setNgoActive(ngo, true);

        vm.prank(admin);
        roles.pause();
        vm.expectRevert(Errors.SystemPaused.selector);
        vault.releaseTranche(0);
    }

    function test_releaseTranche_revertsAfterCancellation() public {
        _fundAndClose(1000e6);
        vm.prank(admin);
        registry.cancelNeed(needId);
        vm.expectRevert(Errors.InvalidNeedStatus.selector);
        vault.releaseTranche(0);
    }

    function test_singleTrancheNeedCompletesOnFirstRelease() public {
        vm.prank(ngo);
        uint256 single = registry.createNeed(_needParams(programId, 1000e6, 1, _singleTrancheBps()));
        _attestNeedVerified(verifier1, single, true);
        AidVault singleVault = AidVault(registry.vaultOf(single));

        _donate(donor1, single, 1000e6);
        singleVault.releaseTranche(0);

        assertEq(registry.statusOf(single), INeedsRegistry.NeedStatus.Completed);
        assertEq(token.balanceOf(ngoPayout), 1000e6);
        assertVaultInvariant(singleVault);
    }

    // ─── markReleasable ────────────────────────────────────────────────────────

    function test_markReleasable_onlyDeliveryManager() public {
        _fundAndClose(1000e6);
        vault.releaseTranche(0);
        vm.prank(outsider);
        vm.expectRevert(Errors.Unauthorized.selector);
        vault.markReleasable(1, 1);
    }

    function test_markReleasable_validatesIndexAndOrder() public {
        _fundAndClose(1000e6);
        vm.startPrank(address(deliveryManager));

        vm.expectRevert(Errors.InvalidNeedStatus.selector);
        vault.markReleasable(1, 1); // need is only Funded, tranche 0 not released yet
        vm.stopPrank();

        vault.releaseTranche(0);

        vm.startPrank(address(deliveryManager));
        vm.expectRevert(Errors.InvalidTrancheIndex.selector);
        vault.markReleasable(0, 1);
        vm.expectRevert(Errors.InvalidTrancheIndex.selector);
        vault.markReleasable(3, 1);
        vm.expectRevert(Errors.PreviousTrancheNotReleased.selector);
        vault.markReleasable(2, 1);

        vault.markReleasable(1, 7);
        assertEq(vault.trancheStatus(1), ITrancheLedger.TrancheStatus.Releasable);
        assertEq(vault.getTranches()[1].deliveryId, 7);

        vm.expectRevert(Errors.InvalidTrancheStatus.selector);
        vault.markReleasable(1, 8);
        vm.stopPrank();
    }

    function test_fullReleaseSequenceCompletesNeed() public {
        _fundAndClose(1000e6);
        vault.releaseTranche(0);
        vm.prank(address(deliveryManager));
        vault.markReleasable(1, 1);
        vault.releaseTranche(1);
        assertEq(registry.statusOf(needId), INeedsRegistry.NeedStatus.InDelivery);

        vm.prank(address(deliveryManager));
        vault.markReleasable(2, 2);
        vault.releaseTranche(2);

        assertEq(registry.statusOf(needId), INeedsRegistry.NeedStatus.Completed);
        assertEq(token.balanceOf(ngoPayout), 1000e6);
        assertEq(token.balanceOf(address(vault)), 0);
        assertVaultInvariant(vault);
    }

    // ─── refunds ───────────────────────────────────────────────────────────────

    function test_claimRefund_fullWhenNothingReleased() public {
        _donate(donor1, needId, 600e6);
        _donate(donor2, needId, 400e6);
        vm.prank(ngo);
        registry.cancelNeed(needId);

        assertEq(vault.refundableAmount(donor1), 600e6);
        vm.prank(donor1);
        uint256 refunded = vault.claimRefund();
        assertEq(refunded, 600e6);
        assertEq(token.balanceOf(donor1), 600e6);
        assertEq(vault.refundableAmount(donor1), 0);

        vm.prank(donor2);
        vault.claimRefund();
        assertEq(token.balanceOf(donor2), 400e6);
        assertEq(token.balanceOf(address(vault)), 0);
        assertVaultInvariant(vault);
    }

    function test_claimRefund_proRataAfterPartialRelease() public {
        _donate(donor1, needId, 600e6);
        _donate(donor2, needId, 400e6);
        vm.prank(ngo);
        vault.closeFunding();
        vault.releaseTranche(0); // 30% released
        vm.prank(admin);
        registry.cancelNeed(needId);

        uint256 unreleased = vault.totalDonated() - vault.totalReleased();
        vm.prank(donor1);
        uint256 r1 = vault.claimRefund();
        vm.prank(donor2);
        uint256 r2 = vault.claimRefund();

        assertEq(r1, (600e6 * unreleased) / 1000e6);
        assertEq(r2, (400e6 * unreleased) / 1000e6);
        assertEq(r1 + r2, unreleased);
        assertVaultInvariant(vault);
    }

    function test_claimRefund_reverts() public {
        _donate(donor1, needId, 100e6);

        vm.prank(donor1);
        vm.expectRevert(Errors.NotRefundable.selector);
        vault.claimRefund();

        vm.prank(ngo);
        registry.cancelNeed(needId);

        vm.prank(outsider);
        vm.expectRevert(Errors.NothingToRefund.selector);
        vault.claimRefund();

        vm.prank(donor1);
        vault.claimRefund();
        vm.prank(donor1);
        vm.expectRevert(Errors.NothingToRefund.selector);
        vault.claimRefund();
    }

    function test_claimRefund_revertsWhenPaused() public {
        _donate(donor1, needId, 100e6);
        vm.prank(ngo);
        registry.cancelNeed(needId);
        vm.prank(admin);
        roles.pause();
        vm.prank(donor1);
        vm.expectRevert(Errors.SystemPaused.selector);
        vault.claimRefund();
    }

    function test_claimRefundByRef() public {
        _donateOnBehalf(needId, 1000e6, DONOR_REF, PAYMENT_REF);
        vm.prank(ngo);
        registry.cancelNeed(needId);

        address fiatDonorAccount = makeAddr("fiatDonorAccount");
        vm.expectEmit(true, true, true, true, address(vault));
        emit IAidVault.RefundedByRef(needId, DONOR_REF, fiatDonorAccount, 1000e6);
        vm.prank(bankPartner);
        uint256 refunded = vault.claimRefundByRef(DONOR_REF, fiatDonorAccount);

        assertEq(refunded, 1000e6);
        assertEq(token.balanceOf(fiatDonorAccount), 1000e6);
        assertVaultInvariant(vault);
    }

    function test_claimRefundByRef_reverts() public {
        _donateOnBehalf(needId, 1000e6, DONOR_REF, PAYMENT_REF);

        vm.prank(outsider);
        vm.expectRevert(Errors.Unauthorized.selector);
        vault.claimRefundByRef(DONOR_REF, outsider);

        address partner2 = makeAddr("partner2");
        vm.prank(admin);
        roles.registerBankPartner(partner2);
        vm.prank(partner2);
        vm.expectRevert(Errors.Unauthorized.selector);
        vault.claimRefundByRef(DONOR_REF, partner2);

        vm.prank(bankPartner);
        vm.expectRevert(Errors.ZeroAddress.selector);
        vault.claimRefundByRef(DONOR_REF, address(0));

        vm.prank(bankPartner);
        vm.expectRevert(Errors.NotRefundable.selector);
        vault.claimRefundByRef(DONOR_REF, bankPartner);

        vm.prank(ngo);
        registry.cancelNeed(needId);

        // an unknown donor reference is indistinguishable from someone else's reference
        vm.prank(bankPartner);
        vm.expectRevert(Errors.Unauthorized.selector);
        vault.claimRefundByRef(keccak256("unknown"), bankPartner);

        vm.prank(bankPartner);
        vault.claimRefundByRef(DONOR_REF, bankPartner);
        vm.prank(bankPartner);
        vm.expectRevert(Errors.NothingToRefund.selector);
        vault.claimRefundByRef(DONOR_REF, bankPartner);
    }

    /// @dev Revoking a partner's role must not strand the refunds of the donors it deposited for: authorization
    ///      is ownership of the reference, not a live role.
    function test_claimRefundByRef_survivesPartnerDeregistration() public {
        _donateOnBehalf(needId, 1000e6, DONOR_REF, PAYMENT_REF);
        vm.prank(ngo);
        registry.cancelNeed(needId);

        vm.prank(admin);
        roles.removeBankPartner(bankPartner);

        address fiatDonorAccount = makeAddr("fiatDonorAccount");
        vm.prank(bankPartner);
        uint256 refunded = vault.claimRefundByRef(DONOR_REF, fiatDonorAccount);
        assertEq(refunded, 1000e6);
        assertEq(token.balanceOf(fiatDonorAccount), 1000e6);
        assertVaultInvariant(vault);
    }

    /// @dev Refunding into the vault would inflate totalRefunded without moving tokens, breaking the invariant.
    function test_claimRefundByRef_rejectsTheVaultAsRecipient() public {
        _donateOnBehalf(needId, 1000e6, DONOR_REF, PAYMENT_REF);
        vm.prank(ngo);
        registry.cancelNeed(needId);

        vm.prank(bankPartner);
        vm.expectRevert(Errors.ZeroAddress.selector);
        vault.claimRefundByRef(DONOR_REF, address(vault));
        assertVaultInvariant(vault);
    }

    /// @dev A suspended NGO cannot be paid, so taking more money would only trap it in escrow.
    function test_donationsAreRefusedWhileTheNgoIsSuspended() public {
        _fundDonor(donor1, needId, 100e6);
        vm.prank(admin);
        roles.setNgoActive(ngo, false);

        vm.prank(donor1);
        vm.expectRevert(Errors.NgoInactive.selector);
        vault.donate(100e6);

        token.mint(bankPartner, 100e6);
        vm.startPrank(bankPartner);
        token.approve(address(vault), 100e6);
        vm.expectRevert(Errors.NgoInactive.selector);
        vault.donateOnBehalf(100e6, DONOR_REF, PAYMENT_REF);
        vm.stopPrank();

        vm.prank(admin);
        roles.setNgoActive(ngo, true);
        vm.prank(donor1);
        vault.donate(100e6);
        assertEq(vault.totalDonated(), 100e6);
    }

    function test_mixedDonorsRefundPoolIsShared() public {
        _donate(donor1, needId, 500e6);
        _donateOnBehalf(needId, 500e6, DONOR_REF, PAYMENT_REF);
        vm.prank(ngo);
        vault.closeFunding();
        vault.releaseTranche(0);
        vm.prank(admin);
        registry.cancelNeed(needId);

        vm.prank(donor1);
        uint256 direct = vault.claimRefund();
        vm.prank(bankPartner);
        uint256 fiat = vault.claimRefundByRef(DONOR_REF, bankPartner);

        assertEq(direct, fiat);
        assertEq(direct + fiat, vault.totalDonated() - vault.totalReleased());
        assertVaultInvariant(vault);
    }

    // ─── views ─────────────────────────────────────────────────────────────────

    function test_trancheStatus_revertsOnUnknownIndex() public {
        vm.expectRevert(Errors.InvalidTrancheIndex.selector);
        vault.trancheStatus(5);
    }

    function test_refundableAmount_zeroWhileActive() public {
        _donate(donor1, needId, 100e6);
        assertEq(vault.refundableAmount(donor1), 0);
        assertEq(vault.refundableAmount(outsider), 0);
    }
}
