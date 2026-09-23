// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AidVault} from "../../src/funds/AidVault.sol";
import {IDeliveryManager} from "../../src/interfaces/IDeliveryManager.sol";
import {INeedsRegistry} from "../../src/interfaces/INeedsRegistry.sol";
import {ITrancheLedger} from "../../src/interfaces/ITrancheLedger.sol";
import {Errors} from "../../src/libraries/Errors.sol";
import {PoATest} from "../utils/PoATest.sol";
import {
    AttestationRequest,
    AttestationRequestData
} from "@ethereum-attestation-service/eas-contracts/contracts/IEAS.sol";

/// @notice The whole lifecycle end to end, for a three-tranche need:
///         registration → verification → funding → pre-financing → the NGO accounts for each tranche it was paid
///         and the donors approve it → next tranche released → impact report.
contract LifecycleTest is PoATest {
    uint256 internal constant TARGET = 30_000e6; // above the high-value threshold → 2 verifiers required

    /// @dev Paid by card: the Coinbase on-ramp bought USDC into this wallet, which then donated it.
    address internal cardDonor = makeAddr("cardDonor");

    function test_fullLifecycle_threeTranches() public {
        // ── NGO creates a program and the need, with a 30/40/30 tranche plan ──
        uint256 programId = _createProgram(ngo);
        vm.prank(ngo);
        uint256 needId = registry.createNeed(_needParams(programId, TARGET, 2, _threeTrancheBps()));
        assertEq(registry.statusOf(needId), INeedsRegistry.NeedStatus.Pending);

        // ── Two independent verifiers attest → vault deployed, funding opens ──
        _attestNeedVerified(verifier1, needId, true);
        assertEq(registry.statusOf(needId), INeedsRegistry.NeedStatus.Pending, "one of two");
        _attestNeedVerified(verifier2, needId, true);
        assertEq(registry.statusOf(needId), INeedsRegistry.NeedStatus.Funding);
        AidVault vault = AidVault(registry.vaultOf(needId));

        // ── Donations: two wallet donors and one who paid by card through the on-ramp ──
        uint256 receipt1 = _donate(donor1, needId, 12_000e6); // 40%
        _donate(donor2, needId, 8000e6); // 26.7%
        uint256 receipt3 = _donate(cardDonor, needId, 10_000e6); // 33.3%
        assertEq(receipt.ownerOf(receipt1), donor1);
        assertEq(receipt.ownerOf(receipt3), cardDonor, "a card donor holds a receipt like anyone else");

        // ── Target reached → funding closed → tranche 0 (pre-financing) released ──
        assertTrue(vault.fundingClosed());
        assertEq(registry.statusOf(needId), INeedsRegistry.NeedStatus.Funded);
        vault.releaseTranche(0);
        assertEq(token.balanceOf(supplierA), 9000e6, "30% pre-financing");
        assertEq(registry.statusOf(needId), INeedsRegistry.NeedStatus.InDelivery);
        assertVaultInvariant(vault);

        // ── Tranche 1: the NGO accounts for the pre-financing; donor2 alone (26.7%) is not enough ──
        uint256 delivery1 = _submitEvidence(needId);
        vm.prank(donor2);
        deliveryManager.approve(delivery1);
        assertEq(deliveryManager.getDelivery(delivery1).status, IDeliveryManager.DeliveryStatus.Open);
        assertEq(vault.trancheStatus(1), ITrancheLedger.TrancheStatus.Locked);
        vm.prank(cardDonor);
        deliveryManager.approve(delivery1); // 60%
        assertEq(deliveryManager.getDelivery(delivery1).status, IDeliveryManager.DeliveryStatus.Approved);

        vault.releaseTranche(1);
        assertEq(token.balanceOf(supplierA), 21_000e6, "30% + 40%");
        assertEq(registry.statusOf(needId), INeedsRegistry.NeedStatus.InDelivery);

        // ── Tranche 2: donor1 (40%) is enough on its own ──
        uint256 delivery2 = _submitEvidence(needId);
        assertEq(deliveryManager.getDelivery(delivery2).trancheIndex, 2);
        vm.prank(donor1);
        deliveryManager.approve(delivery2);
        vault.releaseTranche(2);
        assertEq(token.balanceOf(supplierA), TARGET, "all tranches paid");

        // ── Last release completes the need ──
        assertEq(registry.statusOf(needId), INeedsRegistry.NeedStatus.Completed);
        assertEq(token.balanceOf(address(vault)), 0);
        assertEq(deliveryManager.lastApprovedDeliveryOf(needId), delivery2);
        assertVaultInvariant(vault);

        // ── NGO publishes the impact report ──
        bytes32 reportUID = _attestImpactReport(ngo, needId, 480);
        assertEq(resolver.activeReportOf(needId), reportUID);
    }

    // ─── failure paths ─────────────────────────────────────────────────────────

    function test_nonIndependentVerifierCannotVerifyANeed() public {
        uint256 programId = _createProgram(ngo);
        uint256 needId = _createNeed(ngo, programId, 5000e6, 1);

        // The NGO cannot verify its own need…
        vm.prank(ngo);
        vm.expectRevert(Errors.NotIndependent.selector);
        eas.attest(
            AttestationRequest({
                schema: needVerifiedSchema,
                data: AttestationRequestData({
                    recipient: address(registry),
                    expirationTime: 0,
                    revocable: true,
                    refUID: bytes32(0),
                    data: abi.encode(needId, DOSSIER_HASH, true, REPORT_HASH),
                    value: 0
                })
            })
        );

        // …nor can its payout Safe, even if it were registered as a verifier.
        assertFalse(roles.isIndependent(ngoPayout, ngo));
    }

    /// @dev Donors who are not convinced simply do not approve. The tranche stays locked, and once the delivery
    ///      deadline has passed anyone can expire the need and every donor takes back their share of what is left.
    function test_evidenceDonorsDoNotApprove_expiresAndRefunds() public {
        (uint256 needId,, AidVault vault) = _verifiedNeed(10_000e6);
        _donate(donor1, needId, 2000e6); // 20%: not enough on its own
        _donate(donor2, needId, 8000e6);
        vault.releaseTranche(0); // 3,000 pre-financing

        uint256 deliveryId = _submitEvidence(needId);
        vm.prank(donor1);
        deliveryManager.approve(deliveryId);
        assertEq(vault.trancheStatus(1), ITrancheLedger.TrancheStatus.Locked);

        vm.warp(registry.getNeed(needId).executionDeadline + 1);
        registry.expire(needId);
        assertEq(registry.statusOf(needId), INeedsRegistry.NeedStatus.Expired);

        vm.prank(donor1);
        uint256 r1 = vault.claimRefund();
        vm.prank(donor2);
        uint256 r2 = vault.claimRefund();
        assertEq(r1, 1400e6, "20% of the 7,000 left");
        assertEq(r2, 5600e6);
        assertVaultInvariant(vault);

        // an expired need can no longer be approved
        vm.prank(donor2);
        vm.expectRevert(Errors.InvalidNeedStatus.selector);
        deliveryManager.approve(deliveryId);
    }

    function test_cancellationRefundsEveryDonorProRata() public {
        uint256 programId = _createProgram(ngo);
        vm.prank(ngo);
        uint256 needId = registry.createNeed(_needParams(programId, 20_000e6, 2, _threeTrancheBps()));
        _attestNeedVerified(verifier1, needId, true);
        _attestNeedVerified(verifier2, needId, true);
        AidVault vault = AidVault(registry.vaultOf(needId));

        _donate(donor1, needId, 6000e6);
        _donate(donor2, needId, 4000e6);
        _donate(cardDonor, needId, 10_000e6);
        vault.releaseTranche(0); // 30% = 6000 paid out as pre-financing

        // the NGO files evidence nobody approves, and the admin cancels the need
        uint256 deliveryId = _submitEvidence(needId);
        vm.prank(admin);
        registry.cancelNeed(needId);
        assertEq(registry.statusOf(needId), INeedsRegistry.NeedStatus.Cancelled);

        uint256 unreleased = vault.totalDonated() - vault.totalReleased(); // 14_000e6
        vm.prank(donor1);
        uint256 r1 = vault.claimRefund();
        vm.prank(donor2);
        uint256 r2 = vault.claimRefund();
        vm.prank(cardDonor);
        uint256 r3 = vault.claimRefund();

        assertEq(r1, (6000e6 * unreleased) / 20_000e6, "30% of the remaining pool");
        assertEq(r2, (4000e6 * unreleased) / 20_000e6);
        assertEq(r3, (10_000e6 * unreleased) / 20_000e6);
        assertEq(r1 + r2 + r3, unreleased);
        assertEq(token.balanceOf(address(vault)), 0);
        assertVaultInvariant(vault);

        // nothing more can be released or unlocked on a cancelled need
        vm.expectRevert(Errors.InvalidTrancheStatus.selector);
        vault.releaseTranche(1);
        vm.prank(address(deliveryManager));
        vm.expectRevert(Errors.InvalidNeedStatus.selector);
        vault.markReleasable(1, deliveryId);
    }

    function test_pauseStopsTheMoneyButNotTheSafetyValves() public {
        (uint256 needId,, AidVault vault) = _needInDelivery(10_000e6);
        vm.prank(admin);
        roles.pause();

        vm.prank(ngo);
        vm.expectRevert(Errors.SystemPaused.selector);
        deliveryManager.submitEvidence(needId, MANIFEST);

        // cancelling and refunding after unpausing still works
        vm.prank(admin);
        registry.cancelNeed(needId);
        assertEq(registry.statusOf(needId), INeedsRegistry.NeedStatus.Cancelled);

        vm.prank(admin);
        roles.unpause();
        vm.prank(donor1);
        vault.claimRefund();
        assertVaultInvariant(vault);
    }
}
