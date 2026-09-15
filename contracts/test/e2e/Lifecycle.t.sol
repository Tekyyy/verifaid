// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AidVault} from "../../src/funds/AidVault.sol";
import {IAidVault} from "../../src/interfaces/IAidVault.sol";
import {IDeliveryManager} from "../../src/interfaces/IDeliveryManager.sol";
import {INeedsRegistry} from "../../src/interfaces/INeedsRegistry.sol";
import {Errors} from "../../src/libraries/Errors.sol";
import {PoATest} from "../utils/PoATest.sol";
import {
    AttestationRequest,
    AttestationRequestData
} from "@ethereum-attestation-service/eas-contracts/contracts/IEAS.sol";
import {ISemaphore} from "@semaphore-protocol/contracts/interfaces/ISemaphore.sol";

/// @notice The whole lifecycle of §7 of the spec, end to end, for a three-tranche need:
///         registration → verification → funding (crypto + fiat) → pre-financing → delivery with anonymous
///         confirmations → verifier sign-off → challenge window → tranche release → impact report.
contract LifecycleTest is PoATest {
    uint256 internal constant TARGET = 30_000e6; // above the high-value threshold → 2 verifiers required
    uint32 internal constant EXPECTED_RECIPIENTS = 10;

    bytes32 internal constant DONOR_REF = keccak256(abi.encode("salt", "donor-jane"));
    bytes32 internal constant PAYMENT_REF = keccak256(abi.encode("salt", "SEPA-E2E-0001"));

    function test_fullLifecycle_threeTranches() public {
        // ── 2. NGO creates a program and enrols beneficiary identity commitments ──
        uint256 programId = _createProgram(ngo, EXPECTED_RECIPIENTS);
        assertEq(groups.memberCount(programId), EXPECTED_RECIPIENTS);

        // ── 3. NGO creates the need with a 30/40/30 tranche plan ──
        vm.prank(ngo);
        uint256 needId = registry.createNeed(_needParams(programId, TARGET, 2, _threeTrancheBps()));
        assertEq(registry.statusOf(needId), INeedsRegistry.NeedStatus.Pending);

        // ── 4. Two independent verifiers attest → vault deployed, funding opens ──
        _attestNeedVerified(verifier1, needId, true);
        assertEq(registry.statusOf(needId), INeedsRegistry.NeedStatus.Pending, "one of two");
        _attestNeedVerified(verifier2, needId, true);
        assertEq(registry.statusOf(needId), INeedsRegistry.NeedStatus.Funding);

        AidVault vault = AidVault(registry.vaultOf(needId));
        assertTrue(address(vault) != address(0));

        // ── 5. Donations: two crypto donors and one fiat donor via the bank partner ──
        uint256 receipt1 = _donate(donor1, needId, 12_000e6);
        uint256 receipt2 = _donate(donor2, needId, 8000e6);
        assertEq(receipt.ownerOf(receipt1), donor1);
        assertEq(receipt.ownerOf(receipt2), donor2);
        assertEq(receipt.receiptOf(receipt1).amount, 12_000e6);

        _donateOnBehalf(needId, 10_000e6, DONOR_REF, PAYMENT_REF);
        bytes32 fiatUID = _attestFiatDonation(bankPartner, needId, 10_000e6, PAYMENT_REF, DONOR_REF);
        assertEq(fiatDonationResolver.attestationOf(PAYMENT_REF), fiatUID);

        // ── 6. Target reached → funding closed → tranche 0 (pre-financing) released ──
        assertEq(vault.totalDonated(), TARGET);
        assertTrue(vault.fundingClosed());
        assertEq(registry.statusOf(needId), INeedsRegistry.NeedStatus.Funded);

        vault.releaseTranche(0);
        assertEq(token.balanceOf(ngoPayout), 9000e6, "30% pre-financing");
        assertEq(registry.statusOf(needId), INeedsRegistry.NeedStatus.InDelivery);
        assertVaultInvariant(vault);

        // ── 7-10. One delivery per remaining tranche ──
        uint256 delivery1 = _deliverTranche(needId, 1);
        vault.releaseTranche(1);
        assertEq(token.balanceOf(ngoPayout), 21_000e6, "30% + 40%");
        assertEq(registry.statusOf(needId), INeedsRegistry.NeedStatus.InDelivery);

        uint256 delivery2 = _deliverTranche(needId, 2);
        vault.releaseTranche(2);
        assertEq(token.balanceOf(ngoPayout), TARGET, "all tranches paid");

        // ── 11. Last release completes the need ──
        assertEq(registry.statusOf(needId), INeedsRegistry.NeedStatus.Completed);
        assertEq(token.balanceOf(address(vault)), 0);
        assertVaultInvariant(vault);

        // ── 12. NGO publishes the impact report, chained to the last verifier sign-off ──
        bytes32 reportUID = _attestImpactReport(ngo, needId, 480);
        assertEq(impactReportResolver.activeReportOf(needId), reportUID);

        // the evidence chain is traversable in EAS: report → DeliveryVerified → DeliveryEvidence
        IDeliveryManager.Delivery memory last = deliveryManager.getDelivery(delivery2);
        assertEq(eas.getAttestation(reportUID).refUID, last.verifierAttestationUID, "report refs sign-off");
        assertEq(
            eas.getAttestation(last.verifierAttestationUID).refUID,
            last.evidenceAttestationUID,
            "sign-off refs evidence"
        );
        assertEq(deliveryManager.lastFinalizedDeliveryOf(needId), delivery2);
        assertEq(deliveryManager.getDelivery(delivery1).status, IDeliveryManager.DeliveryStatus.Finalized);

        // nothing on-chain identifies a beneficiary: confirmations are counts and nullifiers only
        assertEq(deliveryManager.getDelivery(delivery1).confirmations, 7);
        assertEq(deliveryManager.getDelivery(delivery2).confirmations, 7);
    }

    /// @dev Evidence → anonymous confirmations → independent sign-off → challenge window → finalize.
    function _deliverTranche(uint256 needId, uint256 trancheIndex) internal returns (uint256 deliveryId) {
        vm.prank(fieldAgent);
        deliveryId = deliveryManager.openDelivery(needId, trancheIndex, EXPECTED_RECIPIENTS);
        _attestEvidence(fieldAgent, deliveryId);
        _confirm(deliveryId, 7); // 70% of 10
        _attestDeliveryVerified(verifier3, deliveryId, true);
        assertEq(deliveryManager.getDelivery(deliveryId).status, IDeliveryManager.DeliveryStatus.Challengeable);

        vm.warp(block.timestamp + CHALLENGE_PERIOD);
        deliveryManager.finalize(deliveryId);
        assertEq(deliveryManager.getDelivery(deliveryId).status, IDeliveryManager.DeliveryStatus.Finalized);
    }

    // ─── failure paths the spec asks for ───────────────────────────────────────

    function test_nonIndependentVerifierCannotVerifyNeedOrDelivery() public {
        uint256 programId = _createProgram(ngo, EXPECTED_RECIPIENTS);
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

        _attestNeedVerified(verifier1, needId, true);
        AidVault vault = AidVault(registry.vaultOf(needId));
        _donate(donor1, needId, 5000e6);
        vault.releaseTranche(0);

        vm.prank(fieldAgent);
        uint256 deliveryId = deliveryManager.openDelivery(needId, 1, EXPECTED_RECIPIENTS);
        bytes32 evidenceUID = _attestEvidence(fieldAgent, deliveryId);
        _confirm(deliveryId, 7);

        // the NGO's own field agent cannot sign off on the delivery either
        vm.prank(fieldAgent);
        vm.expectRevert(Errors.NotIndependent.selector);
        eas.attest(
            AttestationRequest({
                schema: deliveryVerifiedSchema,
                data: AttestationRequestData({
                    recipient: address(deliveryManager),
                    expirationTime: 0,
                    revocable: false,
                    refUID: evidenceUID,
                    data: abi.encode(deliveryId, true, REPORT_HASH),
                    value: 0
                })
            })
        );
        assertEq(deliveryManager.getDelivery(deliveryId).status, IDeliveryManager.DeliveryStatus.Open);
    }

    function test_beneficiaryCannotConfirmTwice() public {
        (uint256 needId,,) = _needInDelivery(10_000e6);
        vm.prank(fieldAgent);
        uint256 deliveryId = deliveryManager.openDelivery(needId, 1, EXPECTED_RECIPIENTS);
        _attestEvidence(fieldAgent, deliveryId);

        ISemaphore.SemaphoreProof memory proof = _proof(deliveryId, 0);
        vm.prank(relayer);
        deliveryManager.confirmReceipt(deliveryId, proof);

        vm.prank(relayer);
        vm.expectRevert(ISemaphore.Semaphore__YouAreUsingTheSameNullifierTwice.selector);
        deliveryManager.confirmReceipt(deliveryId, proof);

        // …but the same beneficiary may confirm a *different* delivery, because the scope changes the nullifier
        assertEq(deliveryManager.getDelivery(deliveryId).confirmations, 1);
    }

    function test_challengedDeliveryIsRejectedAndRedone() public {
        (uint256 needId,, AidVault vault) = _needInDelivery(10_000e6);

        vm.prank(fieldAgent);
        uint256 deliveryId = deliveryManager.openDelivery(needId, 1, EXPECTED_RECIPIENTS);
        _attestEvidence(fieldAgent, deliveryId);
        _confirm(deliveryId, 7);
        _attestDeliveryVerified(verifier2, deliveryId, true);

        // an independent verifier challenges before the deadline
        vm.prank(verifier3);
        deliveryManager.challenge(deliveryId, keccak256("beneficiary list does not match the manifest"));
        assertEq(deliveryManager.getDelivery(deliveryId).status, IDeliveryManager.DeliveryStatus.Disputed);

        // the challenge window can no longer be waited out while disputed
        vm.warp(block.timestamp + CHALLENGE_PERIOD);
        vm.expectRevert(Errors.InvalidDeliveryStatus.selector);
        deliveryManager.finalize(deliveryId);

        // the admin upholds it: the delivery is rejected and the tranche stays locked
        vm.prank(admin);
        deliveryManager.resolveDispute(deliveryId, true);
        assertEq(deliveryManager.getDelivery(deliveryId).status, IDeliveryManager.DeliveryStatus.Rejected);
        assertEq(vault.trancheStatus(1), IAidVault.TrancheStatus.Locked);
        assertEq(token.balanceOf(ngoPayout), 3000e6, "only the pre-financing was paid");

        // the field agent redoes the delivery properly and it goes through
        uint256 redone = _deliverTranche(needId, 1);
        vault.releaseTranche(1);
        assertEq(deliveryManager.getDelivery(redone).status, IDeliveryManager.DeliveryStatus.Finalized);
        assertEq(token.balanceOf(ngoPayout), 7000e6);
        assertVaultInvariant(vault);
    }

    function test_dismissedChallengeLetsTheDeliveryProceed() public {
        (uint256 needId,, AidVault vault) = _needInDelivery(10_000e6);
        vm.prank(fieldAgent);
        uint256 deliveryId = deliveryManager.openDelivery(needId, 1, EXPECTED_RECIPIENTS);
        _attestEvidence(fieldAgent, deliveryId);
        _confirm(deliveryId, 7);
        _attestDeliveryVerified(verifier2, deliveryId, true);

        vm.prank(verifier3);
        deliveryManager.challenge(deliveryId, keccak256("looks off"));
        vm.prank(admin);
        deliveryManager.resolveDispute(deliveryId, false);

        vm.warp(block.timestamp + CHALLENGE_PERIOD);
        deliveryManager.finalize(deliveryId);
        vault.releaseTranche(1);
        assertEq(token.balanceOf(ngoPayout), 7000e6);
    }

    function test_cancellationRefundsEveryDonorProRata() public {
        uint256 programId = _createProgram(ngo, EXPECTED_RECIPIENTS);
        vm.prank(ngo);
        uint256 needId = registry.createNeed(_needParams(programId, 20_000e6, 2, _threeTrancheBps()));
        _attestNeedVerified(verifier1, needId, true);
        _attestNeedVerified(verifier2, needId, true);
        AidVault vault = AidVault(registry.vaultOf(needId));

        _donate(donor1, needId, 6000e6);
        _donate(donor2, needId, 4000e6);
        _donateOnBehalf(needId, 10_000e6, DONOR_REF, PAYMENT_REF);
        vault.releaseTranche(0); // 30% = 6000 paid out as pre-financing

        // a delivery goes wrong and the admin cancels the need
        vm.prank(fieldAgent);
        uint256 deliveryId = deliveryManager.openDelivery(needId, 1, EXPECTED_RECIPIENTS);
        _attestEvidence(fieldAgent, deliveryId);
        _attestDeliveryVerified(verifier3, deliveryId, false); // verifier rejects the delivery
        assertEq(deliveryManager.getDelivery(deliveryId).status, IDeliveryManager.DeliveryStatus.Rejected);

        vm.prank(admin);
        registry.cancelNeed(needId);
        assertEq(registry.statusOf(needId), INeedsRegistry.NeedStatus.Cancelled);

        uint256 unreleased = vault.totalDonated() - vault.totalReleased(); // 14_000e6
        vm.prank(donor1);
        uint256 r1 = vault.claimRefund();
        vm.prank(donor2);
        uint256 r2 = vault.claimRefund();
        vm.prank(bankPartner);
        uint256 r3 = vault.claimRefundByRef(DONOR_REF, bankPartner);

        assertEq(r1, (6000e6 * unreleased) / 20_000e6, "30% of the remaining pool");
        assertEq(r2, (4000e6 * unreleased) / 20_000e6);
        assertEq(r3, (10_000e6 * unreleased) / 20_000e6);
        assertEq(r1 + r2 + r3, unreleased);
        assertEq(token.balanceOf(address(vault)), 0);
        assertVaultInvariant(vault);

        // nothing more can be released: the rejected delivery never unlocked tranche 1, and a cancelled need
        // cannot unlock anything either
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

        vm.prank(fieldAgent);
        vm.expectRevert(Errors.SystemPaused.selector);
        deliveryManager.openDelivery(needId, 1, EXPECTED_RECIPIENTS);

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
