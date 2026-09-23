// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {DeliveryManager} from "../../src/delivery/DeliveryManager.sol";
import {AidVault} from "../../src/funds/AidVault.sol";
import {IDeliveryManager} from "../../src/interfaces/IDeliveryManager.sol";
import {INeedsRegistry} from "../../src/interfaces/INeedsRegistry.sol";
import {IRoleRegistry} from "../../src/interfaces/IRoleRegistry.sol";
import {ITrancheLedger} from "../../src/interfaces/ITrancheLedger.sol";
import {Errors} from "../../src/libraries/Errors.sol";
import {PoATest} from "../utils/PoATest.sol";

/// @notice Donor-approved deliveries: the NGO accounts for the money it was paid, and donors who gave at least 30%
///         of the raised amount unlock the next tranche.
contract DeliveryManagerTest is PoATest {
    uint256 internal constant TARGET = 1000e6;
    // 25% + 15% + 60% of the target; donor1 alone is short of 30%, donor1 and donor2 together are not.
    uint256 internal constant GIFT_1 = 250e6;
    uint256 internal constant GIFT_2 = 150e6;
    uint256 internal constant GIFT_3 = 600e6;

    uint256 internal needId;
    AidVault internal vault;

    function setUp() public override {
        super.setUp();
        (needId,, vault) = _verifiedNeed(TARGET);
        _donate(donor1, needId, GIFT_1);
        _donate(donor2, needId, GIFT_2);
        _donate(outsider, needId, GIFT_3); // reaching the target closes funding
        vault.releaseTranche(0); // pre-financing paid out → InDelivery
    }

    function _approve(address donor, uint256 deliveryId) internal {
        vm.prank(donor);
        deliveryManager.approve(deliveryId);
    }

    function _status(uint256 deliveryId) internal view returns (IDeliveryManager.DeliveryStatus) {
        return deliveryManager.getDelivery(deliveryId).status;
    }

    // ─── configuration ─────────────────────────────────────────────────────────

    function test_constructor_rejectsAThresholdOfZeroOrAboveEverything() public {
        vm.expectRevert(Errors.InvalidParameter.selector);
        new DeliveryManager(IRoleRegistry(address(roles)), INeedsRegistry(address(registry)), 0);
        vm.expectRevert(Errors.InvalidParameter.selector);
        new DeliveryManager(IRoleRegistry(address(roles)), INeedsRegistry(address(registry)), 10_001);
    }

    function test_threshold_isThirtyPercentOfWhatWasRaised() public view {
        assertEq(deliveryManager.approvalThresholdBps(), DONOR_APPROVAL_BPS);
        assertEq(deliveryManager.requiredApproval(needId), 300e6);
    }

    function test_requiredApproval_isZeroBeforeFundingCloses() public {
        (uint256 open,,) = _verifiedNeed(TARGET);
        assertEq(deliveryManager.requiredApproval(open), 0);
    }

    // ─── submitting evidence ───────────────────────────────────────────────────

    function test_submit_commitsTheManifestForTheNextLockedTranche() public {
        vm.expectEmit(true, true, true, true, address(deliveryManager));
        emit IDeliveryManager.DeliverySubmitted(1, needId, 1, ngo, keccak256(bytes(MANIFEST)), MANIFEST);
        uint256 deliveryId = _submitEvidence(needId);

        IDeliveryManager.Delivery memory d = deliveryManager.getDelivery(deliveryId);
        assertEq(d.needId, needId);
        assertEq(d.trancheIndex, 1);
        assertEq(d.submitter, ngo);
        assertEq(d.evidenceHash, keccak256(bytes(MANIFEST)));
        assertEq(d.approvedAmount, 0);
        assertEq(d.submittedAt, block.timestamp);
        assertEq(d.status, IDeliveryManager.DeliveryStatus.Open);
        assertEq(deliveryManager.activeDeliveryOf(needId, 1), deliveryId);
    }

    function test_submit_onlyTheNeedsNgo() public {
        address[4] memory others = [ngo2, outsider, donor1, verifier1];
        for (uint256 i; i < others.length; ++i) {
            vm.prank(others[i]);
            vm.expectRevert(Errors.Unauthorized.selector);
            deliveryManager.submitEvidence(needId, MANIFEST);
        }
    }

    function test_submit_rejectsAnEmptyOrOversizedManifest() public {
        // Read before expectRevert, which would otherwise be spent on this call.
        string memory oversized = string(new bytes(deliveryManager.MAX_MANIFEST_BYTES() + 1));
        vm.startPrank(ngo);
        vm.expectRevert(Errors.InvalidParameter.selector);
        deliveryManager.submitEvidence(needId, "");
        vm.expectRevert(Errors.InvalidParameter.selector);
        deliveryManager.submitEvidence(needId, oversized);
        vm.stopPrank();
    }

    function test_submit_needsTheNeedInDelivery() public {
        (uint256 funding,,) = _verifiedNeed(TARGET);
        vm.prank(ngo);
        vm.expectRevert(Errors.InvalidNeedStatus.selector);
        deliveryManager.submitEvidence(funding, MANIFEST);
    }

    function test_submit_waitsUntilTheApprovedTrancheIsReleased() public {
        _runDelivery(needId, 1); // tranche 1 releasable, not yet paid
        vm.prank(ngo);
        vm.expectRevert(Errors.PreviousTrancheNotReleased.selector);
        deliveryManager.submitEvidence(needId, MANIFEST);

        vault.releaseTranche(1);
        assertEq(deliveryManager.getDelivery(_submitEvidence(needId)).trancheIndex, 2);
    }

    function test_submit_isRefusedWhileTheNgoIsInactive() public {
        vm.prank(admin);
        roles.setNgoActive(ngo, false);
        vm.prank(ngo);
        vm.expectRevert(Errors.NgoInactive.selector);
        deliveryManager.submitEvidence(needId, MANIFEST);
    }

    // ─── replacing evidence ────────────────────────────────────────────────────

    function test_resubmit_supersedesTheOpenEvidenceAndItsApprovals() public {
        uint256 first = _submitEvidence(needId);
        _approve(donor1, first);

        vm.expectEmit(true, true, false, false, address(deliveryManager));
        emit IDeliveryManager.DeliverySuperseded(first, first + 1);
        uint256 second = _submitEvidence(needId);

        assertEq(_status(first), IDeliveryManager.DeliveryStatus.Superseded);
        assertEq(deliveryManager.getDelivery(second).approvedAmount, 0, "approvals start over");
        assertEq(deliveryManager.activeDeliveryOf(needId, 1), second);

        vm.prank(donor2);
        vm.expectRevert(Errors.InvalidDeliveryStatus.selector);
        deliveryManager.approve(first);

        // donor1's earlier approval was for other evidence; it may approve this one.
        _approve(donor1, second);
        assertEq(deliveryManager.getDelivery(second).approvedAmount, GIFT_1);
    }

    // ─── approving ─────────────────────────────────────────────────────────────

    function test_approve_weighsWhatEachDonorGave_andUnlocksAtThirtyPercent() public {
        uint256 deliveryId = _submitEvidence(needId);

        vm.expectEmit(true, true, false, true, address(deliveryManager));
        emit IDeliveryManager.DeliveryApprovalAdded(deliveryId, donor1, GIFT_1, GIFT_1, 300e6);
        _approve(donor1, deliveryId);
        assertEq(_status(deliveryId), IDeliveryManager.DeliveryStatus.Open, "25% is not enough");
        assertEq(uint8(vault.trancheStatus(1)), uint8(ITrancheLedger.TrancheStatus.Locked));

        vm.expectEmit(true, true, false, true, address(deliveryManager));
        emit IDeliveryManager.DeliveryApproved(deliveryId, needId, 1);
        _approve(donor2, deliveryId);

        IDeliveryManager.Delivery memory d = deliveryManager.getDelivery(deliveryId);
        assertEq(d.status, IDeliveryManager.DeliveryStatus.Approved);
        assertEq(d.approvedAmount, GIFT_1 + GIFT_2);
        assertEq(d.approvedAt, block.timestamp);
        assertEq(deliveryManager.lastApprovedDeliveryOf(needId), deliveryId);
        assertEq(uint8(vault.trancheStatus(1)), uint8(ITrancheLedger.TrancheStatus.Releasable));
    }

    function test_approve_oneLargeDonorIsEnoughOnItsOwn() public {
        uint256 deliveryId = _submitEvidence(needId);
        _approve(outsider, deliveryId); // 60%
        assertEq(_status(deliveryId), IDeliveryManager.DeliveryStatus.Approved);
    }

    function test_approve_thresholdRoundsUp() public {
        // 1,000,001 base units raised: 30% is 300,000.3, so 300,000 is short and 300,001 reaches it.
        (uint256 odd,, AidVault oddVault) = _verifiedNeed(1_000_001);
        _donate(donor1, odd, 300_000);
        _donate(donor2, odd, 1);
        _donate(outsider, odd, 700_000);
        oddVault.releaseTranche(0);
        assertEq(deliveryManager.requiredApproval(odd), 300_001);

        uint256 deliveryId = _submitEvidence(odd);
        _approve(donor1, deliveryId);
        assertEq(_status(deliveryId), IDeliveryManager.DeliveryStatus.Open);
        _approve(donor2, deliveryId);
        assertEq(_status(deliveryId), IDeliveryManager.DeliveryStatus.Approved);
    }

    function test_approve_onceEach() public {
        uint256 deliveryId = _submitEvidence(needId);
        _approve(donor1, deliveryId);
        vm.prank(donor1);
        vm.expectRevert(Errors.AlreadyApproved.selector);
        deliveryManager.approve(deliveryId);
    }

    function test_approve_refusesSomeoneWhoDidNotGive() public {
        uint256 deliveryId = _submitEvidence(needId);
        vm.prank(verifier1);
        vm.expectRevert(Errors.NotADonor.selector);
        deliveryManager.approve(deliveryId);
    }

    /// @dev The NGO, its payout address and the payees could otherwise approve their own accounts by donating.
    function test_approve_theNgoItsPayoutAndItsPayeesHaveNoSay() public {
        (uint256 other,, AidVault otherVault) = _verifiedNeed(TARGET);
        _donate(ngo, other, 100e6);
        _donate(ngoPayout, other, 100e6);
        _donate(supplierA, other, 500e6); // the default plan pays every tranche to supplierA
        _donate(donor1, other, 300e6);
        otherVault.releaseTranche(0);

        assertEq(deliveryManager.approvalWeight(other, ngo), 0);
        assertEq(deliveryManager.approvalWeight(other, ngoPayout), 0);
        assertEq(deliveryManager.approvalWeight(other, supplierA), 0);
        assertEq(deliveryManager.approvalWeight(other, donor1), 300e6);

        uint256 deliveryId = _submitEvidence(other);
        address[3] memory interested = [ngo, ngoPayout, supplierA];
        for (uint256 i; i < interested.length; ++i) {
            vm.prank(interested[i]);
            vm.expectRevert(Errors.NotADonor.selector);
            deliveryManager.approve(deliveryId);
        }
        _approve(donor1, deliveryId); // exactly 30% of 1,000
        assertEq(_status(deliveryId), IDeliveryManager.DeliveryStatus.Approved);
    }

    function test_approve_notAfterItWasApproved() public {
        uint256 deliveryId = _submitEvidence(needId);
        _approve(outsider, deliveryId);
        vm.prank(donor1);
        vm.expectRevert(Errors.InvalidDeliveryStatus.selector);
        deliveryManager.approve(deliveryId);
    }

    function test_approve_unknownDelivery() public {
        vm.prank(donor1);
        vm.expectRevert(Errors.DeliveryNotFound.selector);
        deliveryManager.approve(99);
    }

    // ─── lifecycle ─────────────────────────────────────────────────────────────

    function test_everyTrancheAfterTheFirst_completesTheNeed() public {
        _runDelivery(needId, 1);
        vault.releaseTranche(1);
        _runDelivery(needId, 2);
        vault.releaseTranche(2);

        assertEq(registry.statusOf(needId), INeedsRegistry.NeedStatus.Completed);
        assertEq(vault.totalReleased(), TARGET);

        vm.prank(ngo);
        vm.expectRevert(Errors.InvalidNeedStatus.selector);
        deliveryManager.submitEvidence(needId, MANIFEST);
    }

    // ─── pause ─────────────────────────────────────────────────────────────────

    function test_pause_stopsSubmittingAndApproving() public {
        uint256 deliveryId = _submitEvidence(needId);
        vm.prank(admin);
        roles.pause();

        vm.prank(ngo);
        vm.expectRevert(Errors.SystemPaused.selector);
        deliveryManager.submitEvidence(needId, MANIFEST);
        vm.prank(donor1);
        vm.expectRevert(Errors.SystemPaused.selector);
        deliveryManager.approve(deliveryId);
    }
}
