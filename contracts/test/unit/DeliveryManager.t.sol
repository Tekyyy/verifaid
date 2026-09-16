// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {DeliveryManager} from "../../src/delivery/DeliveryManager.sol";
import {AidVault} from "../../src/funds/AidVault.sol";
import {IAidVault} from "../../src/interfaces/IAidVault.sol";
import {IBeneficiaryGroups} from "../../src/interfaces/IBeneficiaryGroups.sol";
import {IDeliveryManager} from "../../src/interfaces/IDeliveryManager.sol";
import {INeedsRegistry} from "../../src/interfaces/INeedsRegistry.sol";
import {IRoleRegistry} from "../../src/interfaces/IRoleRegistry.sol";
import {ITrancheLedger} from "../../src/interfaces/ITrancheLedger.sol";
import {Errors} from "../../src/libraries/Errors.sol";
import {PoATest} from "../utils/PoATest.sol";
import {
    AttestationRequest,
    AttestationRequestData
} from "@ethereum-attestation-service/eas-contracts/contracts/IEAS.sol";
import {ISemaphore} from "@semaphore-protocol/contracts/interfaces/ISemaphore.sol";

contract DeliveryManagerTest is PoATest {
    uint256 internal constant TARGET = 10_000e6;
    uint32 internal constant EXPECTED = 10;

    uint256 internal needId;
    uint256 internal programId;
    AidVault internal vault;

    function setUp() public override {
        super.setUp();
        (needId, programId, vault) = _needInDelivery(TARGET);
    }

    function _open() internal returns (uint256 deliveryId) {
        vm.prank(fieldAgent);
        deliveryId = deliveryManager.openDelivery(needId, 1, EXPECTED);
    }

    // ─── configuration ─────────────────────────────────────────────────────────

    function test_constants() public view {
        assertEq(deliveryManager.AID_RECEIVED_MESSAGE(), AID_RECEIVED_MESSAGE, "test constant matches contract");
        assertEq(deliveryManager.confirmationThresholdBps(), CONFIRMATION_THRESHOLD_BPS);
        assertEq(deliveryManager.challengePeriod(), CHALLENGE_PERIOD);
        assertEq(deliveryManager.minExpectedRecipients(), MIN_EXPECTED_RECIPIENTS);
        assertEq(address(deliveryManager.registry()), address(registry));
        assertEq(address(deliveryManager.beneficiaryGroups()), address(groups));
    }

    function test_constructor_validatesParameters() public {
        vm.expectRevert(Errors.ZeroAddress.selector);
        new DeliveryManager(roles, INeedsRegistry(address(0)), groups, 7000, 600, 5);

        vm.expectRevert(Errors.ZeroAddress.selector);
        new DeliveryManager(roles, registry, IBeneficiaryGroups(address(0)), 7000, 600, 5);

        vm.expectRevert(Errors.InvalidParameter.selector);
        new DeliveryManager(roles, registry, groups, 0, 600, 5);

        vm.expectRevert(Errors.InvalidParameter.selector);
        new DeliveryManager(roles, registry, groups, 10_001, 600, 5);

        vm.expectRevert(Errors.InvalidParameter.selector);
        new DeliveryManager(roles, registry, groups, 7000, 600, 0);
    }

    function test_wire() public {
        DeliveryManager fresh = new DeliveryManager(roles, registry, groups, 7000, 600, 5);

        vm.prank(outsider);
        vm.expectRevert(Errors.Unauthorized.selector);
        fresh.wire(address(resolver));

        vm.prank(admin);
        vm.expectRevert(Errors.ZeroAddress.selector);
        fresh.wire(address(0));

        vm.prank(fieldAgent);
        vm.expectRevert(Errors.NotWired.selector);
        fresh.openDelivery(needId, 1, EXPECTED);

        vm.prank(admin);
        fresh.wire(address(resolver));
        vm.prank(admin);
        vm.expectRevert(Errors.AlreadyWired.selector);
        fresh.wire(address(resolver));
    }

    // ─── openDelivery ──────────────────────────────────────────────────────────

    function test_openDelivery() public {
        vm.expectEmit(true, true, true, true, address(deliveryManager));
        emit IDeliveryManager.DeliveryOpened(1, needId, 1, fieldAgent, EXPECTED);
        uint256 deliveryId = _open();

        IDeliveryManager.Delivery memory d = deliveryManager.getDelivery(deliveryId);
        assertEq(d.id, 1);
        assertEq(d.needId, needId);
        assertEq(d.trancheIndex, 1);
        assertEq(d.fieldAgent, fieldAgent);
        assertEq(d.expectedRecipients, EXPECTED);
        assertEq(d.confirmations, 0);
        assertEq(d.evidenceAttestationUID, bytes32(0));
        assertEq(d.status, IDeliveryManager.DeliveryStatus.Open);
        assertEq(deliveryManager.deliveryCount(), 1);
        assertEq(deliveryManager.activeDeliveryOf(needId, 1), deliveryId);
        assertEq(deliveryManager.confirmationsNeeded(deliveryId), 7); // ceil(10 * 70%)
    }

    function test_openDelivery_revertsForWrongCaller() public {
        vm.prank(outsider);
        vm.expectRevert(Errors.Unauthorized.selector);
        deliveryManager.openDelivery(needId, 1, EXPECTED);

        // a field agent of a different NGO
        vm.prank(fieldAgent2);
        vm.expectRevert(Errors.Unauthorized.selector);
        deliveryManager.openDelivery(needId, 1, EXPECTED);

        // the NGO itself is not a field agent
        vm.prank(ngo);
        vm.expectRevert(Errors.Unauthorized.selector);
        deliveryManager.openDelivery(needId, 1, EXPECTED);
    }

    function test_openDelivery_revertsWhenNgoInactive() public {
        vm.prank(admin);
        roles.setNgoActive(ngo, false);
        vm.prank(fieldAgent);
        vm.expectRevert(Errors.NgoInactive.selector);
        deliveryManager.openDelivery(needId, 1, EXPECTED);
    }

    function test_openDelivery_requiresNeedInDelivery() public {
        (uint256 fundingNeed,,) = _verifiedNeed(1000e6);
        vm.prank(fieldAgent);
        vm.expectRevert(Errors.InvalidNeedStatus.selector);
        deliveryManager.openDelivery(fundingNeed, 1, EXPECTED);
    }

    function test_openDelivery_validatesTrancheIndex() public {
        vm.startPrank(fieldAgent);
        vm.expectRevert(Errors.InvalidTrancheIndex.selector);
        deliveryManager.openDelivery(needId, 0, EXPECTED);
        vm.expectRevert(Errors.InvalidTrancheIndex.selector);
        deliveryManager.openDelivery(needId, 3, EXPECTED);
        // tranche 1 has not been released yet, so tranche 2 cannot start
        vm.expectRevert(Errors.PreviousTrancheNotReleased.selector);
        deliveryManager.openDelivery(needId, 2, EXPECTED);
        vm.stopPrank();
    }

    function test_openDelivery_rejectsSecondActiveDeliveryForTranche() public {
        _open();
        vm.prank(fieldAgent);
        vm.expectRevert(Errors.DeliveryAlreadyActive.selector);
        deliveryManager.openDelivery(needId, 1, EXPECTED);
    }

    function test_openDelivery_enforcesRecipientBounds() public {
        vm.prank(fieldAgent);
        vm.expectRevert(Errors.TooFewRecipients.selector);
        deliveryManager.openDelivery(needId, 1, MIN_EXPECTED_RECIPIENTS - 1);

        // the program has 10 enrolled members
        vm.prank(fieldAgent);
        vm.expectRevert(Errors.TooManyRecipients.selector);
        deliveryManager.openDelivery(needId, 1, 11);
    }

    function test_openDelivery_revertsWhenPaused() public {
        vm.prank(admin);
        roles.pause();
        vm.prank(fieldAgent);
        vm.expectRevert(Errors.SystemPaused.selector);
        deliveryManager.openDelivery(needId, 1, EXPECTED);
    }

    // ─── evidence ──────────────────────────────────────────────────────────────

    function test_onEvidenceAttested_onlyResolver() public {
        uint256 deliveryId = _open();
        vm.prank(fieldAgent);
        vm.expectRevert(Errors.Unauthorized.selector);
        deliveryManager.onEvidenceAttested(deliveryId, keccak256("uid"));
    }

    function test_onEvidenceAttested_validates() public {
        uint256 deliveryId = _open();
        vm.startPrank(address(resolver));

        vm.expectRevert(Errors.InvalidParameter.selector);
        deliveryManager.onEvidenceAttested(deliveryId, bytes32(0));

        vm.expectRevert(Errors.DeliveryNotFound.selector);
        deliveryManager.onEvidenceAttested(99, keccak256("uid"));

        deliveryManager.onEvidenceAttested(deliveryId, keccak256("uid"));
        vm.expectRevert(Errors.EvidenceAlreadyLinked.selector);
        deliveryManager.onEvidenceAttested(deliveryId, keccak256("uid2"));
        vm.stopPrank();

        assertEq(deliveryManager.getDelivery(deliveryId).evidenceAttestationUID, keccak256("uid"));
    }

    // ─── confirmations ─────────────────────────────────────────────────────────

    function test_confirmReceipt() public {
        uint256 deliveryId = _open();
        _attestEvidence(fieldAgent, deliveryId);

        ISemaphore.SemaphoreProof memory proof = _proof(deliveryId, 0);
        vm.expectEmit(true, false, false, true, address(deliveryManager));
        emit IDeliveryManager.ReceiptConfirmed(deliveryId, proof.nullifier, 1);
        vm.prank(relayer);
        deliveryManager.confirmReceipt(deliveryId, proof);

        assertEq(deliveryManager.getDelivery(deliveryId).confirmations, 1);
        assertEq(deliveryManager.confirmationsNeeded(deliveryId), 6);
    }

    function test_confirmReceipt_requiresEvidenceFirst() public {
        uint256 deliveryId = _open();
        vm.prank(relayer);
        vm.expectRevert(Errors.EvidenceMissing.selector);
        deliveryManager.confirmReceipt(deliveryId, _proof(deliveryId, 0));
    }

    function test_confirmReceipt_rejectsWrongScopeOrMessage() public {
        uint256 deliveryId = _open();
        _attestEvidence(fieldAgent, deliveryId);

        ISemaphore.SemaphoreProof memory wrongScope = _proof(deliveryId, 0);
        wrongScope.scope = deliveryId + 1;
        vm.prank(relayer);
        vm.expectRevert(Errors.InvalidScope.selector);
        deliveryManager.confirmReceipt(deliveryId, wrongScope);

        ISemaphore.SemaphoreProof memory wrongMessage = _proof(deliveryId, 0);
        wrongMessage.message = uint256(keccak256("SOMETHING_ELSE"));
        vm.prank(relayer);
        vm.expectRevert(Errors.InvalidMessage.selector);
        deliveryManager.confirmReceipt(deliveryId, wrongMessage);
    }

    function test_confirmReceipt_rejectsReusedNullifier() public {
        uint256 deliveryId = _open();
        _attestEvidence(fieldAgent, deliveryId);
        ISemaphore.SemaphoreProof memory proof = _proof(deliveryId, 0);

        vm.prank(relayer);
        deliveryManager.confirmReceipt(deliveryId, proof);

        vm.prank(relayer);
        vm.expectRevert(ISemaphore.Semaphore__YouAreUsingTheSameNullifierTwice.selector);
        deliveryManager.confirmReceipt(deliveryId, proof);

        assertEq(deliveryManager.getDelivery(deliveryId).confirmations, 1, "replay does not count");
    }

    function test_confirmReceipt_rejectsInvalidProof() public {
        uint256 deliveryId = _open();
        _attestEvidence(fieldAgent, deliveryId);
        ISemaphore.SemaphoreProof memory proof = _proof(deliveryId, 0);
        proof.points[0] = 0;

        vm.prank(relayer);
        vm.expectRevert(ISemaphore.Semaphore__InvalidProof.selector);
        deliveryManager.confirmReceipt(deliveryId, proof);
    }

    function test_confirmReceipt_capsAtExpectedRecipients() public {
        uint256 deliveryId = _open();
        _attestEvidence(fieldAgent, deliveryId);
        _confirm(deliveryId, EXPECTED);

        vm.prank(relayer);
        vm.expectRevert(Errors.TooManyConfirmations.selector);
        deliveryManager.confirmReceipt(deliveryId, _proof(deliveryId, 999));
    }

    function test_confirmReceipt_revertsWhenPaused() public {
        uint256 deliveryId = _open();
        _attestEvidence(fieldAgent, deliveryId);
        vm.prank(admin);
        roles.pause();
        vm.prank(relayer);
        vm.expectRevert(Errors.SystemPaused.selector);
        deliveryManager.confirmReceipt(deliveryId, _proof(deliveryId, 0));
    }

    // ─── batched confirmations ─────────────────────────────────────────────────

    function _proofs(uint256 deliveryId, uint256 from, uint256 count)
        internal
        pure
        returns (ISemaphore.SemaphoreProof[] memory proofs)
    {
        proofs = new ISemaphore.SemaphoreProof[](count);
        for (uint256 i; i < count; ++i) {
            proofs[i] = _proof(deliveryId, from + i);
        }
    }

    function test_confirmReceiptBatch_countsEveryProofAndAdvances() public {
        uint256 deliveryId = _open();
        _attestEvidence(fieldAgent, deliveryId);
        _attestDeliveryVerified(verifier2, deliveryId, true);

        ISemaphore.SemaphoreProof[] memory proofs = _proofs(deliveryId, 0, 7);
        vm.expectEmit(true, false, false, true, address(deliveryManager));
        emit IDeliveryManager.ReceiptConfirmed(deliveryId, proofs[6].nullifier, 7);
        vm.prank(relayer);
        deliveryManager.confirmReceiptBatch(deliveryId, proofs);

        IDeliveryManager.Delivery memory d = deliveryManager.getDelivery(deliveryId);
        assertEq(d.confirmations, 7);
        assertEq(d.status, IDeliveryManager.DeliveryStatus.Challengeable, "threshold reached in one transaction");
    }

    function test_confirmReceiptBatch_isAllOrNothing() public {
        uint256 deliveryId = _open();
        _attestEvidence(fieldAgent, deliveryId);

        ISemaphore.SemaphoreProof[] memory proofs = _proofs(deliveryId, 0, 3);
        proofs[2].scope = deliveryId + 1;
        vm.prank(relayer);
        vm.expectRevert(Errors.InvalidScope.selector);
        deliveryManager.confirmReceiptBatch(deliveryId, proofs);

        // a nullifier repeated inside the batch is caught by Semaphore
        proofs = _proofs(deliveryId, 0, 2);
        proofs[1] = proofs[0];
        vm.prank(relayer);
        vm.expectRevert(ISemaphore.Semaphore__YouAreUsingTheSameNullifierTwice.selector);
        deliveryManager.confirmReceiptBatch(deliveryId, proofs);

        assertEq(deliveryManager.getDelivery(deliveryId).confirmations, 0, "nothing counted");
    }

    function test_confirmReceiptBatch_validatesSizeAndState() public {
        uint256 deliveryId = _open();

        vm.prank(relayer);
        vm.expectRevert(Errors.EvidenceMissing.selector);
        deliveryManager.confirmReceiptBatch(deliveryId, _proofs(deliveryId, 0, 1));

        _attestEvidence(fieldAgent, deliveryId);

        vm.prank(relayer);
        vm.expectRevert(Errors.InvalidParameter.selector);
        deliveryManager.confirmReceiptBatch(deliveryId, new ISemaphore.SemaphoreProof[](0));

        vm.prank(relayer);
        vm.expectRevert(Errors.TooManyConfirmations.selector);
        deliveryManager.confirmReceiptBatch(deliveryId, _proofs(deliveryId, 0, EXPECTED + 1));

        _confirm(deliveryId, 8);
        vm.prank(relayer);
        vm.expectRevert(Errors.TooManyConfirmations.selector);
        deliveryManager.confirmReceiptBatch(deliveryId, _proofs(deliveryId, 100, 3));

        vm.prank(admin);
        roles.pause();
        vm.prank(relayer);
        vm.expectRevert(Errors.SystemPaused.selector);
        deliveryManager.confirmReceiptBatch(deliveryId, _proofs(deliveryId, 100, 1));
    }

    // ─── verifier sign-off and advancement ─────────────────────────────────────

    function test_deliveryBecomesChallengeableWhenAllThreeSignalsAgree() public {
        uint256 deliveryId = _open();
        _attestEvidence(fieldAgent, deliveryId);
        _confirm(deliveryId, 7);
        assertEq(deliveryManager.getDelivery(deliveryId).status, IDeliveryManager.DeliveryStatus.Open);

        vm.expectEmit(true, false, false, true, address(deliveryManager));
        emit IDeliveryManager.DeliveryChallengeable(deliveryId, uint64(block.timestamp) + CHALLENGE_PERIOD);
        _attestDeliveryVerified(verifier2, deliveryId, true);

        IDeliveryManager.Delivery memory d = deliveryManager.getDelivery(deliveryId);
        assertEq(d.status, IDeliveryManager.DeliveryStatus.Challengeable);
        assertEq(d.verifier, verifier2);
        assertEq(d.challengeDeadline, uint64(block.timestamp) + CHALLENGE_PERIOD);
    }

    function test_verifierFirstThenConfirmationsAlsoAdvances() public {
        uint256 deliveryId = _open();
        _attestEvidence(fieldAgent, deliveryId);
        _attestDeliveryVerified(verifier2, deliveryId, true);
        assertEq(deliveryManager.getDelivery(deliveryId).status, IDeliveryManager.DeliveryStatus.Open);

        _confirm(deliveryId, 6);
        assertEq(deliveryManager.getDelivery(deliveryId).status, IDeliveryManager.DeliveryStatus.Open, "6 < 70%");
        _confirm(deliveryId, 1);
        assertEq(deliveryManager.getDelivery(deliveryId).status, IDeliveryManager.DeliveryStatus.Challengeable);
    }

    function test_onDeliveryVerified_rejectionRejectsDelivery() public {
        uint256 deliveryId = _open();
        _attestEvidence(fieldAgent, deliveryId);
        _confirm(deliveryId, 7);

        vm.expectEmit(true, true, false, true, address(deliveryManager));
        emit IDeliveryManager.DeliveryRejected(deliveryId, needId, 1);
        _attestDeliveryVerified(verifier2, deliveryId, false);

        assertEq(deliveryManager.getDelivery(deliveryId).status, IDeliveryManager.DeliveryStatus.Rejected);
    }

    /// @dev Rejection is immediate and terminal, so an unbounded veto would let one verifier stall a tranche
    ///      forever by rejecting every retry — a cheaper attack than the rate-limited challenge path.
    function test_verifierCannotRejectEveryRetryOfTheSameTranche() public {
        uint256 first = _open();
        _attestEvidence(fieldAgent, first);
        _attestDeliveryVerified(verifier3, first, false);
        assertEq(deliveryManager.getDelivery(first).status, IDeliveryManager.DeliveryStatus.Rejected);
        assertTrue(deliveryManager.hasRejectedTranche(needId, 1, verifier3));

        // the field agent retries; the same verifier is out of vetoes for this tranche
        vm.prank(fieldAgent);
        uint256 second = deliveryManager.openDelivery(needId, 1, EXPECTED);
        bytes32 evidenceUID = _attestEvidence(fieldAgent, second);

        vm.prank(verifier3);
        vm.expectRevert(Errors.AlreadyRejected.selector);
        eas.attest(
            AttestationRequest({
                schema: deliveryVerifiedSchema,
                data: AttestationRequestData({
                    recipient: address(deliveryManager),
                    expirationTime: 0,
                    revocable: false,
                    refUID: evidenceUID,
                    data: abi.encode(second, false, REPORT_HASH),
                    value: 0
                })
            })
        );

        // another verifier can still reject it, and the same verifier can still challenge later
        _attestDeliveryVerified(verifier1, second, false);
        assertEq(deliveryManager.getDelivery(second).status, IDeliveryManager.DeliveryStatus.Rejected);
    }

    function test_verifierMayRejectEachTrancheOnce() public {
        uint256 first = _open();
        _attestEvidence(fieldAgent, first);
        _attestDeliveryVerified(verifier3, first, false);

        // a rejection on tranche 1 does not consume the verifier's say on tranche 2
        uint256 redone = _runDelivery(needId, 1, EXPECTED);
        assertEq(deliveryManager.getDelivery(redone).status, IDeliveryManager.DeliveryStatus.Finalized);
        vault.releaseTranche(1);

        vm.prank(fieldAgent);
        uint256 nextTranche = deliveryManager.openDelivery(needId, 2, EXPECTED);
        _attestEvidence(fieldAgent, nextTranche);
        _attestDeliveryVerified(verifier3, nextTranche, false);
        assertEq(deliveryManager.getDelivery(nextTranche).status, IDeliveryManager.DeliveryStatus.Rejected);
    }

    function test_constructor_enforcesTheAbsoluteRecipientFloor() public {
        vm.expectRevert(Errors.InvalidParameter.selector);
        new DeliveryManager(roles, registry, groups, 7000, 600, 4);
        assertEq(deliveryManager.ABSOLUTE_MIN_RECIPIENTS(), 5);
    }

    function test_rejectedDeliveryFreesTheTrancheSlot() public {
        uint256 deliveryId = _open();
        _attestEvidence(fieldAgent, deliveryId);
        _attestDeliveryVerified(verifier2, deliveryId, false);

        vm.prank(fieldAgent);
        uint256 second = deliveryManager.openDelivery(needId, 1, EXPECTED);
        assertEq(second, deliveryId + 1);
        assertEq(deliveryManager.activeDeliveryOf(needId, 1), second);
    }

    function test_onDeliveryVerified_validates() public {
        uint256 deliveryId = _open();

        vm.prank(verifier2);
        vm.expectRevert(Errors.Unauthorized.selector);
        deliveryManager.onDeliveryVerified(deliveryId, verifier2, true, keccak256("uid"));

        vm.startPrank(address(resolver));
        vm.expectRevert(Errors.InvalidParameter.selector);
        deliveryManager.onDeliveryVerified(deliveryId, verifier2, true, bytes32(0));

        vm.expectRevert(Errors.EvidenceMissing.selector);
        deliveryManager.onDeliveryVerified(deliveryId, verifier2, true, keccak256("uid"));
        vm.stopPrank();

        _attestEvidence(fieldAgent, deliveryId);

        vm.startPrank(address(resolver));
        vm.expectRevert(Errors.NotIndependent.selector);
        deliveryManager.onDeliveryVerified(deliveryId, ngo, true, keccak256("uid"));

        deliveryManager.onDeliveryVerified(deliveryId, verifier2, true, keccak256("uid"));
        vm.expectRevert(Errors.VerificationAlreadyLinked.selector);
        deliveryManager.onDeliveryVerified(deliveryId, verifier3, true, keccak256("uid2"));
        vm.stopPrank();
    }

    /// @dev A verifier that becomes related to the NGO after signing off must not push the delivery forward.
    function test_advanceIsBlockedIfVerifierLosesIndependence() public {
        uint256 deliveryId = _open();
        _attestEvidence(fieldAgent, deliveryId);
        _attestDeliveryVerified(verifier2, deliveryId, true);

        vm.prank(admin);
        roles.removeVerifier(verifier2);

        _confirm(deliveryId, 7);
        assertEq(deliveryManager.getDelivery(deliveryId).status, IDeliveryManager.DeliveryStatus.Open);
    }

    // ─── challenge / dispute ───────────────────────────────────────────────────

    function _challengeable() internal returns (uint256 deliveryId) {
        deliveryId = _open();
        _attestEvidence(fieldAgent, deliveryId);
        _confirm(deliveryId, 7);
        _attestDeliveryVerified(verifier2, deliveryId, true);
    }

    function test_challenge() public {
        uint256 deliveryId = _challengeable();

        vm.expectEmit(true, true, false, true, address(deliveryManager));
        emit IDeliveryManager.DeliveryChallenged(deliveryId, verifier3, keccak256("reason"));
        vm.prank(verifier3);
        deliveryManager.challenge(deliveryId, keccak256("reason"));

        assertEq(deliveryManager.getDelivery(deliveryId).status, IDeliveryManager.DeliveryStatus.Disputed);
        assertTrue(deliveryManager.hasChallenged(deliveryId, verifier3));
    }

    function test_challenge_reverts() public {
        uint256 deliveryId = _challengeable();

        vm.prank(outsider);
        vm.expectRevert(Errors.NotIndependent.selector);
        deliveryManager.challenge(deliveryId, keccak256("reason"));

        vm.prank(ngo);
        vm.expectRevert(Errors.NotIndependent.selector);
        deliveryManager.challenge(deliveryId, keccak256("reason"));

        vm.prank(verifier3);
        vm.expectRevert(Errors.InvalidParameter.selector);
        deliveryManager.challenge(deliveryId, bytes32(0));

        vm.warp(block.timestamp + CHALLENGE_PERIOD);
        vm.prank(verifier3);
        vm.expectRevert(Errors.ChallengePeriodOver.selector);
        deliveryManager.challenge(deliveryId, keccak256("reason"));
    }

    function test_challenge_onlyOncePerVerifier() public {
        uint256 deliveryId = _challengeable();
        vm.prank(verifier3);
        deliveryManager.challenge(deliveryId, keccak256("reason"));

        vm.prank(admin);
        deliveryManager.resolveDispute(deliveryId, false); // dismissed, back to Challengeable

        vm.prank(verifier3);
        vm.expectRevert(Errors.AlreadyChallenged.selector);
        deliveryManager.challenge(deliveryId, keccak256("reason-again"));

        // a different verifier still can
        vm.prank(verifier1);
        deliveryManager.challenge(deliveryId, keccak256("another-reason"));
        assertEq(deliveryManager.getDelivery(deliveryId).status, IDeliveryManager.DeliveryStatus.Disputed);
    }

    function test_resolveDispute_upheldRejectsDelivery() public {
        uint256 deliveryId = _challengeable();
        vm.prank(verifier3);
        deliveryManager.challenge(deliveryId, keccak256("reason"));

        vm.prank(outsider);
        vm.expectRevert(Errors.Unauthorized.selector);
        deliveryManager.resolveDispute(deliveryId, true);

        vm.expectEmit(true, false, false, true, address(deliveryManager));
        emit IDeliveryManager.DisputeResolved(deliveryId, true);
        vm.prank(admin);
        deliveryManager.resolveDispute(deliveryId, true);

        assertEq(deliveryManager.getDelivery(deliveryId).status, IDeliveryManager.DeliveryStatus.Rejected);
        assertEq(vault.trancheStatus(1), ITrancheLedger.TrancheStatus.Locked);
    }

    /// @dev Review finding F2: dismissing a challenge resumes the window that was left, instead of granting a fresh
    ///      one that a frivolous challenge near a deadline could use to push an earned tranche past it.
    function test_resolveDispute_dismissedResumesTheRemainingWindow() public {
        uint256 deliveryId = _challengeable();
        uint64 firstDeadline = deliveryManager.getDelivery(deliveryId).challengeDeadline;

        vm.warp(block.timestamp + 4 minutes); // 6 of 10 minutes left
        vm.prank(verifier3);
        deliveryManager.challenge(deliveryId, keccak256("reason"));
        vm.warp(block.timestamp + 2 days); // the dispute takes a while

        vm.prank(admin);
        deliveryManager.resolveDispute(deliveryId, false);

        IDeliveryManager.Delivery memory d = deliveryManager.getDelivery(deliveryId);
        assertEq(d.status, IDeliveryManager.DeliveryStatus.Challengeable);
        assertEq(d.challengeDeadline, block.timestamp + 6 minutes, "remaining window resumed");
        assertGt(d.challengeDeadline, firstDeadline);
        assertTrue(deliveryManager.hasDeliveryInFlight(needId));

        vm.warp(d.challengeDeadline);
        deliveryManager.finalize(deliveryId);
        assertFalse(deliveryManager.hasDeliveryInFlight(needId));
    }

    function test_hasDeliveryInFlight_onlyForVerifiedDeliveriesAwaitingFinalization() public {
        assertFalse(deliveryManager.hasDeliveryInFlight(needId));
        uint256 deliveryId = _open();
        _attestEvidence(fieldAgent, deliveryId);
        assertFalse(deliveryManager.hasDeliveryInFlight(needId), "an open delivery is not in flight");
        _confirm(deliveryId, 7);
        _attestDeliveryVerified(verifier2, deliveryId, true);
        assertTrue(deliveryManager.hasDeliveryInFlight(needId), "challengeable");
        vm.prank(verifier3);
        deliveryManager.challenge(deliveryId, keccak256("reason"));
        assertTrue(deliveryManager.hasDeliveryInFlight(needId), "disputed");
        vm.prank(admin);
        deliveryManager.resolveDispute(deliveryId, true);
        assertFalse(deliveryManager.hasDeliveryInFlight(needId), "rejected");
    }

    /// @dev A delivery whose field agent never files evidence cannot be rejected by a verifier (there is nothing
    ///      to review), so without this escape hatch its tranche would be locked forever.
    function test_cancelDelivery_unblocksAnAbandonedDelivery() public {
        uint256 deliveryId = _open();

        vm.prank(ngo);
        vm.expectRevert(Errors.Unauthorized.selector);
        deliveryManager.cancelDelivery(deliveryId);

        // the tranche is blocked: a second delivery cannot be opened while this one is active
        vm.prank(fieldAgent);
        vm.expectRevert(Errors.DeliveryAlreadyActive.selector);
        deliveryManager.openDelivery(needId, 1, EXPECTED);

        vm.expectEmit(true, true, false, false, address(deliveryManager));
        emit IDeliveryManager.DeliveryCancelled(deliveryId, admin);
        vm.prank(admin);
        deliveryManager.cancelDelivery(deliveryId);
        assertEq(deliveryManager.getDelivery(deliveryId).status, IDeliveryManager.DeliveryStatus.Rejected);

        // the field agent can now start over, and the tranche can still be earned
        uint256 redone = _runDelivery(needId, 1, EXPECTED);
        assertEq(deliveryManager.getDelivery(redone).status, IDeliveryManager.DeliveryStatus.Finalized);
        assertEq(vault.trancheStatus(1), ITrancheLedger.TrancheStatus.Releasable);
    }

    function test_cancelDelivery_onlyWhileOpen() public {
        uint256 deliveryId = _challengeable();
        vm.prank(admin);
        vm.expectRevert(Errors.InvalidDeliveryStatus.selector);
        deliveryManager.cancelDelivery(deliveryId);
    }

    function test_resolveDispute_revertsWhenNotDisputed() public {
        uint256 deliveryId = _challengeable();
        vm.prank(admin);
        vm.expectRevert(Errors.InvalidDeliveryStatus.selector);
        deliveryManager.resolveDispute(deliveryId, true);
    }

    // ─── finalize ──────────────────────────────────────────────────────────────

    function test_finalize() public {
        uint256 deliveryId = _challengeable();

        vm.expectRevert(Errors.ChallengePeriodActive.selector);
        deliveryManager.finalize(deliveryId);

        vm.warp(block.timestamp + CHALLENGE_PERIOD);
        vm.expectEmit(true, true, false, true, address(deliveryManager));
        emit IDeliveryManager.DeliveryFinalized(deliveryId, needId, 1);
        deliveryManager.finalize(deliveryId); // callable by anyone

        assertEq(deliveryManager.getDelivery(deliveryId).status, IDeliveryManager.DeliveryStatus.Finalized);
        assertEq(deliveryManager.lastFinalizedDeliveryOf(needId), deliveryId);
        assertEq(vault.trancheStatus(1), ITrancheLedger.TrancheStatus.Releasable);
        assertEq(vault.getTranches()[1].deliveryId, deliveryId);
    }

    function test_finalize_revertsWhenNotChallengeable() public {
        uint256 deliveryId = _open();
        vm.expectRevert(Errors.InvalidDeliveryStatus.selector);
        deliveryManager.finalize(deliveryId);
    }

    function test_finalize_revertsAfterNeedCancelled() public {
        uint256 deliveryId = _challengeable();
        vm.warp(block.timestamp + CHALLENGE_PERIOD);
        vm.prank(admin);
        registry.cancelNeed(needId);

        vm.expectRevert(Errors.InvalidNeedStatus.selector);
        deliveryManager.finalize(deliveryId);
    }

    function test_finalize_revertsWhenPaused() public {
        uint256 deliveryId = _challengeable();
        vm.warp(block.timestamp + CHALLENGE_PERIOD);
        vm.prank(admin);
        roles.pause();
        vm.expectRevert(Errors.SystemPaused.selector);
        deliveryManager.finalize(deliveryId);
    }

    // ─── views ─────────────────────────────────────────────────────────────────

    function test_getDelivery_revertsForUnknownId() public {
        vm.expectRevert(Errors.DeliveryNotFound.selector);
        deliveryManager.getDelivery(1);
        vm.expectRevert(Errors.DeliveryNotFound.selector);
        deliveryManager.confirmationsNeeded(1);
    }
}
