// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AidVault} from "../../src/funds/AidVault.sol";
import {ICommunityProofs} from "../../src/interfaces/ICommunityProofs.sol";
import {IDeliveryManager} from "../../src/interfaces/IDeliveryManager.sol";
import {INeedsRegistry} from "../../src/interfaces/INeedsRegistry.sol";
import {IReleasePolicy} from "../../src/interfaces/IReleasePolicy.sol";
import {Errors} from "../../src/libraries/Errors.sol";
import {PoATest} from "../utils/PoATest.sol";

/// @notice Proof of delivery from anyone, and the reward pots an NGO funds for it. Rewards are credit its holder can
///         only give away — to a need or a basket — never cash.
contract CommunityProofsTest is PoATest {
    uint256 internal constant TARGET = 3000e6;
    uint256 internal constant REWARD = 5e6;

    address internal walker = makeAddr("walker");
    address internal neighbour = makeAddr("neighbour");

    // ─── helpers ───────────────────────────────────────────────────────────────

    function _submit(address who, uint256 needId) internal returns (uint256 proofId) {
        vm.prank(who);
        proofId = communityProofs.submitProof(needId, MANIFEST);
    }

    /// @dev The NGO funds and opens a pot of `count` rewards on `needId`, open for 30 days.
    function _open(address by, uint256 needId, uint32 count) internal returns (uint256 bountyId) {
        uint256 total = REWARD * count;
        token.mint(by, total);
        vm.startPrank(by);
        token.approve(address(communityProofs), total);
        bountyId = communityProofs.openBounty(needId, REWARD, count, uint64(block.timestamp + 30 days));
        vm.stopPrank();
    }

    function _reward(uint256 proofId) internal {
        vm.prank(ngo);
        communityProofs.rewardProof(proofId);
    }

    // ─── filing proof ──────────────────────────────────────────────────────────

    function test_submitProof_anyoneCanFileProofOnceTheMoneyMoves() public {
        (uint256 needId,,) = _needInDelivery(TARGET);

        vm.expectEmit(true, true, true, true, address(communityProofs));
        emit ICommunityProofs.ProofSubmitted(1, needId, walker, keccak256(bytes(MANIFEST)), MANIFEST);
        uint256 proofId = _submit(walker, needId);

        ICommunityProofs.Proof memory proof = communityProofs.proofOf(proofId);
        assertEq(proof.needId, needId);
        assertEq(proof.submitter, walker);
        assertEq(proof.manifestHash, keccak256(bytes(MANIFEST)));
        assertFalse(proof.rewarded);
        // Donors may file too: they are not the ones accounting for the need.
        _submit(donor1, needId);
    }

    function test_submitProof_notBeforeTheMoneyMoves() public {
        (uint256 needId,,) = _verifiedNeed(TARGET); // raising, nothing spent yet
        vm.expectRevert(Errors.InvalidNeedStatus.selector);
        _submit(walker, needId);
    }

    function test_submitProof_notByThoseWhoAccountForTheNeed() public {
        (uint256 needId,,) = _needInDelivery(TARGET);
        vm.expectRevert(Errors.NotIndependent.selector);
        _submit(ngo, needId);
        vm.expectRevert(Errors.NotIndependent.selector);
        _submit(ngoPayout, needId);

        (uint256 theirs,,) = _beneficiaryNeedInDelivery(1200e6);
        vm.expectRevert(Errors.NotIndependent.selector);
        _submit(beneficiary, theirs);
        vm.expectRevert(Errors.NotIndependent.selector);
        _submit(ngo, theirs); // the certifying NGO still answers for it
    }

    /// @dev A few proofs per wallet per need, enough to follow a delivery; flooding a page takes a wallet per three.
    function test_submitProof_aFewPerWalletPerNeed() public {
        (uint256 needId,,) = _needInDelivery(TARGET);
        uint256 limit = communityProofs.MAX_PROOFS_PER_WALLET();
        for (uint256 i; i < limit; ++i) {
            _submit(walker, needId);
        }
        assertEq(communityProofs.proofsFiled(needId, walker), limit);
        vm.prank(walker);
        vm.expectRevert(Errors.ProofLimitReached.selector);
        communityProofs.submitProof(needId, MANIFEST);

        _submit(neighbour, needId); // another wallet still can
        (uint256 other,,) = _needInDelivery(TARGET);
        _submit(walker, other); // and so can this one, about another need
    }

    function test_submitProof_needsAManifestOfSaneSize() public {
        (uint256 needId,,) = _needInDelivery(TARGET);
        vm.prank(walker);
        vm.expectRevert(Errors.InvalidParameter.selector);
        communityProofs.submitProof(needId, "");

        bytes memory tooLong = new bytes(communityProofs.MAX_MANIFEST_BYTES() + 1);
        vm.prank(walker);
        vm.expectRevert(Errors.InvalidParameter.selector);
        communityProofs.submitProof(needId, string(tooLong));
    }

    // ─── reward pots ───────────────────────────────────────────────────────────

    function test_openBounty_theNgoLocksTheRewardsFromItsOwnWallet() public {
        (uint256 needId,,) = _needInDelivery(TARGET);
        uint256 vaultBalance = token.balanceOf(registry.vaultOf(needId));

        uint256 bountyId = _open(ngo, needId, 10);

        ICommunityProofs.Bounty memory bounty = communityProofs.bountyOf(bountyId);
        assertEq(bounty.ngo, ngo);
        assertEq(bounty.reward, REWARD);
        assertEq(bounty.maxRewards, 10);
        assertEq(bounty.balance, 10 * REWARD);
        assertEq(token.balanceOf(address(communityProofs)), 10 * REWARD);
        assertEq(communityProofs.openBountyOf(needId), bountyId);
        assertEq(token.balanceOf(registry.vaultOf(needId)), vaultBalance, "donors' money is not touched");
    }

    function test_openBounty_onlyByTheNeedsNgo_oneAtATime() public {
        (uint256 needId,,) = _needInDelivery(TARGET);
        token.mint(outsider, REWARD);
        vm.startPrank(outsider);
        token.approve(address(communityProofs), REWARD);
        vm.expectRevert(Errors.Unauthorized.selector);
        communityProofs.openBounty(needId, REWARD, 1, uint64(block.timestamp + 30 days));
        vm.stopPrank();

        _open(ngo, needId, 1);
        token.mint(ngo, REWARD);
        vm.startPrank(ngo);
        token.approve(address(communityProofs), REWARD);
        vm.expectRevert(Errors.BountyAlreadyOpen.selector);
        communityProofs.openBounty(needId, REWARD, 1, uint64(block.timestamp + 30 days));
        vm.stopPrank();
    }

    function test_openBounty_theCertifyingNgoFundsProofOfItsBeneficiarysNeed() public {
        (uint256 needId,,) = _beneficiaryNeedInDelivery(1200e6);
        uint256 bountyId = _open(ngo, needId, 3);
        uint256 proofId = _submit(walker, needId);
        _reward(proofId);
        assertEq(communityProofs.creditOf(walker), REWARD);
        assertEq(communityProofs.bountyOf(bountyId).rewardsPaid, 1);
    }

    function test_openBounty_refusesNonsense() public {
        (uint256 needId,,) = _needInDelivery(TARGET);
        vm.startPrank(ngo);
        vm.expectRevert(Errors.ZeroAmount.selector);
        communityProofs.openBounty(needId, 0, 1, uint64(block.timestamp + 30 days));
        vm.expectRevert(Errors.InvalidParameter.selector);
        communityProofs.openBounty(needId, REWARD, 0, uint64(block.timestamp + 30 days));
        vm.expectRevert(Errors.InvalidParameter.selector);
        communityProofs.openBounty(needId, REWARD, 1, uint64(block.timestamp + 1 hours));
        vm.expectRevert(Errors.InvalidParameter.selector);
        communityProofs.openBounty(needId, REWARD, 1, uint64(block.timestamp + 400 days));
        vm.stopPrank();
    }

    // ─── paying rewards ────────────────────────────────────────────────────────

    function test_rewardProof_creditsTheWalletThatFiledIt_neverInCash() public {
        (uint256 needId,,) = _needInDelivery(TARGET);
        uint256 bountyId = _open(ngo, needId, 2);
        uint256 proofId = _submit(walker, needId);

        vm.expectEmit(true, true, true, true, address(communityProofs));
        emit ICommunityProofs.ProofRewarded(proofId, bountyId, needId, walker, REWARD);
        _reward(proofId);

        assertEq(token.balanceOf(walker), 0, "a reward is not cash");
        assertEq(communityProofs.creditOf(walker), REWARD);
        assertEq(token.balanceOf(address(communityProofs)), 2 * REWARD, "it stays here until it is given");
        assertTrue(communityProofs.proofOf(proofId).rewarded);
        assertTrue(communityProofs.rewardedOn(needId, walker));
        assertEq(communityProofs.bountyOf(bountyId).balance, REWARD);
    }

    function test_rewardProof_oncePerWalletPerNeed() public {
        (uint256 needId,,) = _needInDelivery(TARGET);
        _open(ngo, needId, 5);
        uint256 first = _submit(walker, needId);
        uint256 second = _submit(walker, needId);
        _reward(first);
        vm.expectRevert(Errors.AlreadyRewarded.selector);
        _reward(second);
        vm.expectRevert(Errors.AlreadyRewarded.selector);
        _reward(first);
    }

    function test_rewardProof_onlyByTheNgoThatFundedIt() public {
        (uint256 needId,,) = _needInDelivery(TARGET);
        _open(ngo, needId, 1);
        uint256 proofId = _submit(walker, needId);
        vm.prank(outsider);
        vm.expectRevert(Errors.Unauthorized.selector);
        communityProofs.rewardProof(proofId);
    }

    function test_rewardProof_needsAnOpenPot_andStopsWhenItIsEmpty() public {
        (uint256 needId,,) = _needInDelivery(TARGET);
        uint256 early = _submit(walker, needId);
        vm.expectRevert(Errors.NoOpenBounty.selector);
        _reward(early);

        _open(ngo, needId, 1);
        _reward(early);
        uint256 late = _submit(neighbour, needId);
        vm.expectRevert(Errors.NothingToClaim.selector);
        _reward(late);
    }

    function test_rewardProof_notForProofFiledAfterTheDeadline() public {
        (uint256 needId,,) = _needInDelivery(TARGET);
        uint256 bountyId = _open(ngo, needId, 2);
        vm.warp(communityProofs.bountyOf(bountyId).deadline + 1);
        uint256 proofId = _submit(walker, needId);
        vm.expectRevert(Errors.ProofAfterDeadline.selector);
        _reward(proofId);
    }

    // ─── closing ───────────────────────────────────────────────────────────────

    function test_closeBounty_returnsWhatIsLeftToTheNgo() public {
        (uint256 needId,,) = _needInDelivery(TARGET);
        uint256 bountyId = _open(ngo, needId, 4);
        _reward(_submit(walker, needId));
        uint256 before = token.balanceOf(ngo);

        vm.expectEmit(true, true, false, true, address(communityProofs));
        emit ICommunityProofs.BountyClosed(bountyId, needId, 3 * REWARD);
        vm.prank(ngo);
        communityProofs.closeBounty(bountyId);

        assertEq(token.balanceOf(ngo) - before, 3 * REWARD);
        assertEq(communityProofs.openBountyOf(needId), 0);
        vm.prank(ngo);
        vm.expectRevert(Errors.NoOpenBounty.selector);
        communityProofs.closeBounty(bountyId);

        // A new pot can open; a wallet already paid on this need still is.
        _open(ngo, needId, 2);
        vm.expectRevert(Errors.AlreadyRewarded.selector);
        _reward(1);
    }

    function test_closeBounty_byAnyoneOnceTheDeadlineHasPassed() public {
        (uint256 needId,,) = _needInDelivery(TARGET);
        uint256 bountyId = _open(ngo, needId, 2);
        vm.prank(outsider);
        vm.expectRevert(Errors.Unauthorized.selector);
        communityProofs.closeBounty(bountyId);

        vm.warp(communityProofs.bountyOf(bountyId).deadline + 1);
        uint256 before = token.balanceOf(ngo);
        vm.prank(outsider);
        communityProofs.closeBounty(bountyId);
        assertEq(token.balanceOf(ngo) - before, 2 * REWARD, "the refund goes to the NGO, not the closer");
        assertEq(token.balanceOf(outsider), 0);
    }

    // ─── giving credit ─────────────────────────────────────────────────────────

    /// @dev `who` files proof on a need of its own and is rewarded: REWARD of credit.
    function _earn(address who) internal {
        (uint256 needId,,) = _needInDelivery(TARGET);
        _open(ngo, needId, 1);
        _reward(_submit(who, needId));
    }

    function test_giveCredit_donatesInThisContractsName_soItCarriesNoSay() public {
        _earn(walker);
        (uint256 raising,, AidVault vault) = _verifiedNeed(TARGET);
        uint256[] memory one = new uint256[](1);
        one[0] = raising;

        vm.prank(walker);
        communityProofs.giveCredit(bytes32(0), one, REWARD);

        assertEq(communityProofs.creditOf(walker), 0);
        assertEq(vault.donatedBy(address(communityProofs)), REWARD);
        assertEq(vault.donatedBy(walker), 0, "the validator is not a donor of record");
        assertEq(vault.totalDonated(), REWARD);
        assertEq(communityProofs.creditGivenTo(raising, walker), REWARD);
        assertEq(token.balanceOf(walker), 0);
        (IReleasePolicy.Voice voice,) = deliveryManager.voiceOf(raising, walker);
        assertEq(uint8(voice), uint8(IReleasePolicy.Voice.None), "an NGO's reward buys no vote");
    }

    function test_giveCredit_toABasket_splitsItEqually() public {
        _earn(walker);
        (uint256 a,, AidVault va) = _verifiedNeed(TARGET);
        (uint256 b,, AidVault vb) = _verifiedNeed(TARGET);
        uint256[] memory basket = new uint256[](2);
        (basket[0], basket[1]) = (a, b);

        uint256[] memory expected = new uint256[](2);
        (expected[0], expected[1]) = (REWARD / 2, REWARD / 2);
        vm.expectEmit(true, true, false, true, address(communityProofs));
        emit ICommunityProofs.CreditGiven(walker, keccak256("WATER"), basket, expected);
        vm.prank(walker);
        communityProofs.giveCredit(keccak256("WATER"), basket, REWARD);

        assertEq(va.donatedBy(address(communityProofs)), REWARD / 2);
        assertEq(vb.donatedBy(address(communityProofs)), REWARD / 2);
        assertEq(communityProofs.creditOf(walker), 0);
    }

    function test_giveCredit_whatNoNeedCouldTakeIsStillCredit() public {
        _earn(walker);
        (uint256 almostFull,,) = _verifiedNeed(1000e6);
        _donate(donor1, almostFull, 1000e6 - 2e6); // room for 2 more
        uint256[] memory one = new uint256[](1);
        one[0] = almostFull;

        vm.prank(walker);
        communityProofs.giveCredit(bytes32(0), one, REWARD);

        assertEq(communityProofs.creditGivenTo(almostFull, walker), 2e6);
        assertEq(communityProofs.creditOf(walker), REWARD - 2e6);
        assertEq(registry.statusOf(almostFull), INeedsRegistry.NeedStatus.Funded, "the gift filled it");
    }

    function test_giveCredit_onlyWhatTheWalletHolds() public {
        _earn(walker);
        (uint256 raising,,) = _verifiedNeed(TARGET);
        uint256[] memory one = new uint256[](1);
        one[0] = raising;
        vm.startPrank(walker);
        vm.expectRevert(Errors.InsufficientCredit.selector);
        communityProofs.giveCredit(bytes32(0), one, REWARD + 1);
        vm.expectRevert(Errors.ZeroAmount.selector);
        communityProofs.giveCredit(bytes32(0), one, 0);
        vm.stopPrank();
        vm.prank(neighbour); // never rewarded
        vm.expectRevert(Errors.InsufficientCredit.selector);
        communityProofs.giveCredit(bytes32(0), one, 1);
    }

    /// @dev Reward credit has no voice, and no threshold counts it. Here it is 5 of the 7 raised: counted, "30%
    ///      approve" would need 2.1 from the one donor who can vote, who gave 2 — and the need could never move.
    function test_rewardCreditCountsForNoThreshold_soTheDonorsWhoCanVoteStillDecide() public {
        _earn(walker);
        (uint256 needId,, AidVault vault) = _verifiedNeed(7e6);
        uint256[] memory one = new uint256[](1);
        one[0] = needId;
        vm.prank(walker);
        communityProofs.giveCredit(bytes32(0), one, REWARD);
        _donate(donor2, needId, 2e6); // reaches the target: funding closes
        vault.releaseTranche(0);

        assertEq(deliveryManager.rulesOf(needId).donorApproval, 600_000, "30% of the 2 that can vote");
        uint256 deliveryId = _submitEvidence(needId);
        vm.prank(donor2);
        deliveryManager.approve(deliveryId);
        assertEq(uint8(deliveryManager.getDelivery(deliveryId).status), uint8(IDeliveryManager.DeliveryStatus.Approved));
    }

    /// @dev A need the credit went to fails: the refund comes back as credit, shared by what each gave to it.
    function test_reclaimCredit_aFailedNeedsRefundComesBackAsCredit_proRata() public {
        _earn(walker);
        _earn(neighbour);
        (uint256 doomed,,) = _verifiedNeed(TARGET);
        uint256[] memory one = new uint256[](1);
        one[0] = doomed;
        vm.prank(walker);
        communityProofs.giveCredit(bytes32(0), one, 4e6);
        vm.prank(neighbour);
        communityProofs.giveCredit(bytes32(0), one, 1e6);

        vm.prank(walker);
        vm.expectRevert(Errors.NotRefundable.selector);
        communityProofs.reclaimCredit(doomed); // still raising

        vm.prank(ngo);
        registry.cancelNeed(doomed);

        vm.expectEmit(true, true, false, true, address(communityProofs));
        emit ICommunityProofs.CreditRefunded(walker, doomed, 4e6);
        vm.prank(walker);
        communityProofs.reclaimCredit(doomed);
        vm.prank(neighbour);
        communityProofs.reclaimCredit(doomed);

        assertEq(communityProofs.creditOf(walker), REWARD, "4 given, 4 back, 1 never given");
        assertEq(communityProofs.creditOf(neighbour), REWARD);
        assertEq(token.balanceOf(walker), 0, "it came back as credit, not cash");
        assertEq(token.balanceOf(neighbour), 0);

        vm.prank(walker);
        vm.expectRevert(Errors.NothingToRefund.selector);
        communityProofs.reclaimCredit(doomed);
    }

    // ─── pause ─────────────────────────────────────────────────────────────────

    function test_pause_stopsFilingAndPaying_butNotTheRefund() public {
        (uint256 needId,,) = _needInDelivery(TARGET);
        uint256 bountyId = _open(ngo, needId, 1);
        uint256 proofId = _submit(walker, needId);

        vm.prank(admin);
        roles.pause();
        vm.expectRevert(Errors.SystemPaused.selector);
        _submit(neighbour, needId);
        vm.expectRevert(Errors.SystemPaused.selector);
        _reward(proofId);

        vm.prank(ngo);
        communityProofs.closeBounty(bountyId);
        assertEq(token.balanceOf(address(communityProofs)), 0);
    }
}
