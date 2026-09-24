// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ICommunityProofs} from "../../src/interfaces/ICommunityProofs.sol";
import {Errors} from "../../src/libraries/Errors.sol";
import {PoATest} from "../utils/PoATest.sol";

/// @notice Proof of delivery from anyone, and the reward pots an NGO funds for it.
contract CommunityProofsTest is PoATest {
    uint256 internal constant TARGET = 3000e6;
    uint256 internal constant REWARD = 5e6;

    address internal walker = makeAddr("walker");
    address internal neighbour = makeAddr("neighbour");

    // â”€â”€â”€ helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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

    // â”€â”€â”€ filing proof â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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

    // â”€â”€â”€ reward pots â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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
        assertEq(token.balanceOf(walker), REWARD);
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

    // â”€â”€â”€ paying rewards â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

    function test_rewardProof_paysTheWalletThatFiledIt() public {
        (uint256 needId,,) = _needInDelivery(TARGET);
        uint256 bountyId = _open(ngo, needId, 2);
        uint256 proofId = _submit(walker, needId);

        vm.expectEmit(true, true, true, true, address(communityProofs));
        emit ICommunityProofs.ProofRewarded(proofId, bountyId, needId, walker, REWARD);
        _reward(proofId);

        assertEq(token.balanceOf(walker), REWARD);
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

    // â”€â”€â”€ closing â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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

    // â”€â”€â”€ pause â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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
