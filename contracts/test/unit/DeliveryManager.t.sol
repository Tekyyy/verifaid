// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ReleasePolicy} from "../../src/delivery/ReleasePolicy.sol";
import {AidVault} from "../../src/funds/AidVault.sol";
import {IAidVault} from "../../src/interfaces/IAidVault.sol";
import {IDeliveryManager} from "../../src/interfaces/IDeliveryManager.sol";
import {INeedsRegistry} from "../../src/interfaces/INeedsRegistry.sol";
import {IReleasePolicy} from "../../src/interfaces/IReleasePolicy.sol";
import {IRoleRegistry} from "../../src/interfaces/IRoleRegistry.sol";
import {ITrancheLedger} from "../../src/interfaces/ITrancheLedger.sol";
import {Errors} from "../../src/libraries/Errors.sol";
import {PoATest} from "../utils/PoATest.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// @dev A minimal ERC-1271 smart wallet with one owner key, like a passkey or Coinbase Smart Wallet.
contract MockSmartWallet {
    address public immutable owner;

    constructor(address owner_) {
        owner = owner_;
    }

    function isValidSignature(bytes32 hash, bytes calldata signature) external view returns (bytes4) {
        return ECDSA.recover(hash, signature) == owner ? bytes4(0x1626ba7e) : bytes4(0xffffffff);
    }

    function donate(IAidVault vault, IERC20 token, uint256 amount) external {
        token.approve(address(vault), amount);
        vault.donate(amount);
    }
}

/// @notice Deliveries judged under each need's release policy: the NGO accounts for the money it was paid; donors
///         (by what they gave), verifiers, or both approve or reject; rejections send the NGO back once and then
///         cancel the need.
contract DeliveryManagerTest is PoATest {
    uint256 internal constant TARGET = 1000e6;
    // 25% + 15% + 60% of the target: donor1 alone is short of 30%, donor1 and donor2 together reach 40%.
    uint256 internal constant GIFT_1 = 250e6;
    uint256 internal constant GIFT_2 = 150e6;
    uint256 internal constant GIFT_3 = 600e6;

    uint256 internal needId;
    AidVault internal vault;

    function setUp() public override {
        super.setUp();
        (needId,, vault) = _verifiedNeed(TARGET);
        _fund(needId, vault);
    }

    // ─── helpers ───────────────────────────────────────────────────────────────

    /// @dev donor1, donor2 and outsider give 25/15/60% and tranche 0 is paid: the need is in delivery.
    function _fund(uint256 id, AidVault v) internal {
        _donate(donor1, id, GIFT_1);
        _donate(donor2, id, GIFT_2);
        _donate(outsider, id, GIFT_3); // reaching the target closes funding
        v.releaseTranche(0); // pre-financing paid out → InDelivery
    }

    /// @dev A funded need in delivery judged by `policy`. Above the high-value threshold it takes two verifiers.
    function _needWithPolicy(address policy, uint256 target) internal returns (uint256 id, AidVault v) {
        uint8 verifications = target > HIGH_VALUE_THRESHOLD ? 2 : 1;
        INeedsRegistry.CreateNeedParams memory p =
            _needParams(_createProgram(ngo), target, verifications, _threeTrancheBps());
        p.releasePolicy = policy;
        vm.prank(ngo);
        id = registry.createNeed(p);
        _attestNeedVerified(verifier1, id, true);
        if (verifications > 1) _attestNeedVerified(verifier2, id, true);
        v = AidVault(registry.vaultOf(id));
    }

    function _approve(address voter, uint256 deliveryId) internal {
        vm.prank(voter);
        deliveryManager.approve(deliveryId);
    }

    function _reject(address voter, uint256 deliveryId) internal {
        vm.prank(voter);
        deliveryManager.reject(deliveryId);
    }

    function _status(uint256 deliveryId) internal view returns (IDeliveryManager.DeliveryStatus) {
        return deliveryManager.getDelivery(deliveryId).status;
    }

    function _sign(uint256 key, uint256 deliveryId, address voter, bool approve, uint256 deadline)
        internal
        view
        returns (bytes memory)
    {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, deliveryManager.voteDigest(deliveryId, voter, approve, deadline));
        return abi.encodePacked(r, s, v);
    }

    // ─── rules ─────────────────────────────────────────────────────────────────

    function test_rules_byDefaultDonorsDecide_thirtyPercentApproves_halfRejects() public view {
        assertEq(address(deliveryManager.policyOf(needId)), address(donorPolicy));
        IReleasePolicy.Rules memory r = deliveryManager.rulesOf(needId);
        assertEq(r.donorApproval, 300e6);
        assertEq(r.donorRejection, 500e6);
        assertEq(r.verifierApproval, 0, "verifiers have no say");
        assertEq(r.verifierRejection, 0);
        assertEq(r.retries, REJECTION_RETRIES);
        assertEq(donorPolicy.name(), "Donors decide");
    }

    /// @dev The NGO has no say on its own evidence, so what it gave counts for no threshold either: 710 of 1,000 here.
    function test_rules_moneyFromThoseWithNoSayCountsForNoThreshold() public {
        (uint256 id,, AidVault vault) = _verifiedNeed(1000e6);
        _donate(ngo, id, 710e6);
        _donate(donor1, id, 290e6);
        vault.releaseTranche(0);

        assertEq(deliveryManager.rulesOf(id).donorApproval, 87e6, "30% of the 290 that can vote");
        assertEq(deliveryManager.rulesOf(id).donorRejection, 145e6, "50% of it to reject");
        uint256 deliveryId = _submitEvidence(id);
        vm.prank(donor1);
        deliveryManager.approve(deliveryId);
        assertEq(uint8(deliveryManager.getDelivery(deliveryId).status), uint8(IDeliveryManager.DeliveryStatus.Approved));
    }

    function test_rules_areZeroBeforeFundingCloses() public {
        (uint256 open,,) = _verifiedNeed(TARGET);
        IReleasePolicy.Rules memory r = deliveryManager.rulesOf(open);
        assertEq(r.donorApproval, 0);
        assertEq(r.donorRejection, 0);
    }

    function test_policy_constructorRefusesRulesNobodyCanMeet() public {
        IRoleRegistry r = IRoleRegistry(address(roles));
        INeedsRegistry n = INeedsRegistry(address(registry));
        vm.expectRevert(Errors.InvalidParameter.selector);
        new ReleasePolicy(r, n, "nobody", 0, 0, false, 1, address(0)); // no voice at all
        vm.expectRevert(Errors.InvalidParameter.selector);
        new ReleasePolicy(r, n, "half", 3000, 0, false, 1, address(0)); // donors could approve but never reject
        vm.expectRevert(Errors.InvalidParameter.selector);
        new ReleasePolicy(r, n, "over", 10_001, 5000, false, 1, address(0));
        vm.expectRevert(Errors.InvalidParameter.selector);
        new ReleasePolicy(r, n, "", 3000, 5000, false, 1, address(0));
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
        assertEq(d.rejectedAmount, 0);
        assertEq(d.submittedAt, block.timestamp);
        assertEq(d.decidedAt, 0);
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

    function test_resubmit_supersedesTheOpenEvidenceAndItsVotes_forFreeWhileNobodyRejected() public {
        uint256 first = _submitEvidence(needId);
        _approve(donor1, first);

        vm.expectEmit(true, true, false, true, address(deliveryManager));
        emit IDeliveryManager.DeliverySuperseded(first, first + 1, false, 0);
        uint256 second = _submitEvidence(needId);

        assertEq(_status(first), IDeliveryManager.DeliveryStatus.Superseded);
        assertEq(deliveryManager.getDelivery(second).approvedAmount, 0, "votes start over");
        assertEq(deliveryManager.activeDeliveryOf(needId, 1), second);
        assertEq(deliveryManager.strikesOf(needId), 0, "correcting uncontested evidence is free");

        vm.prank(donor2);
        vm.expectRevert(Errors.InvalidDeliveryStatus.selector);
        deliveryManager.approve(first);

        // donor1's earlier approval was for other evidence; it may approve this one.
        _approve(donor1, second);
        assertEq(deliveryManager.getDelivery(second).approvedAmount, GIFT_1);
    }

    /// @dev Otherwise an NGO could withdraw an account the moment rejections started piling up, and never be
    ///      rejected at all.
    function test_resubmit_replacingContestedEvidenceCostsTheRetry() public {
        uint256 first = _submitEvidence(needId);
        _reject(donor1, first); // 25%: contested, not yet rejected

        vm.expectEmit(true, true, false, true, address(deliveryManager));
        emit IDeliveryManager.DeliverySuperseded(first, first + 1, true, 1);
        uint256 second = _submitEvidence(needId);
        assertEq(deliveryManager.strikesOf(needId), 1);

        // The retry is spent: the next rejection cancels the need...
        _reject(outsider, second);
        assertEq(registry.statusOf(needId), INeedsRegistry.NeedStatus.Cancelled);
    }

    function test_resubmit_contestedEvidenceStandsOnceTheRetryIsSpent() public {
        _reject(outsider, _submitEvidence(needId)); // rejected: strike 1
        uint256 second = _submitEvidence(needId);
        _reject(donor1, second); // contested

        vm.prank(ngo);
        vm.expectRevert(Errors.EvidenceContested.selector);
        deliveryManager.submitEvidence(needId, MANIFEST);

        // It is decided by the votes instead.
        _approve(donor2, second);
        _approve(outsider, second);
        assertEq(_status(second), IDeliveryManager.DeliveryStatus.Approved);
    }

    // ─── approving ─────────────────────────────────────────────────────────────

    function test_approve_weighsWhatEachDonorGave_andUnlocksAtThirtyPercent() public {
        uint256 deliveryId = _submitEvidence(needId);

        vm.expectEmit(true, true, false, true, address(deliveryManager));
        emit IDeliveryManager.VoteCast(deliveryId, donor1, IReleasePolicy.Voice.Donor, true, GIFT_1);
        _approve(donor1, deliveryId);
        assertEq(_status(deliveryId), IDeliveryManager.DeliveryStatus.Open, "25% is not enough");
        assertEq(uint8(vault.trancheStatus(1)), uint8(ITrancheLedger.TrancheStatus.Locked));

        vm.expectEmit(true, true, false, true, address(deliveryManager));
        emit IDeliveryManager.DeliveryApproved(deliveryId, needId, 1);
        _approve(donor2, deliveryId);

        IDeliveryManager.Delivery memory d = deliveryManager.getDelivery(deliveryId);
        assertEq(d.status, IDeliveryManager.DeliveryStatus.Approved);
        assertEq(d.approvedAmount, GIFT_1 + GIFT_2);
        assertEq(d.decidedAt, block.timestamp);
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
        assertEq(deliveryManager.rulesOf(odd).donorApproval, 300_001);

        uint256 deliveryId = _submitEvidence(odd);
        _approve(donor1, deliveryId);
        assertEq(_status(deliveryId), IDeliveryManager.DeliveryStatus.Open);
        _approve(donor2, deliveryId);
        assertEq(_status(deliveryId), IDeliveryManager.DeliveryStatus.Approved);
    }

    function test_vote_onceEach_eitherWay() public {
        uint256 deliveryId = _submitEvidence(needId);
        _approve(donor1, deliveryId);
        vm.startPrank(donor1);
        vm.expectRevert(Errors.AlreadyVoted.selector);
        deliveryManager.approve(deliveryId);
        vm.expectRevert(Errors.AlreadyVoted.selector);
        deliveryManager.reject(deliveryId);
        vm.stopPrank();
    }

    function test_vote_refusesSomeoneWhoDidNotGive() public {
        uint256 deliveryId = _submitEvidence(needId);
        vm.prank(verifier1);
        vm.expectRevert(Errors.NoSay.selector);
        deliveryManager.approve(deliveryId);
        vm.prank(verifier1);
        vm.expectRevert(Errors.NoSay.selector);
        deliveryManager.reject(deliveryId);
    }

    /// @dev The NGO, its payout address and the payees could otherwise approve their own accounts by donating.
    function test_vote_theNgoItsPayoutAndItsPayeesHaveNoSay() public {
        (uint256 other,, AidVault otherVault) = _verifiedNeed(TARGET);
        _donate(ngo, other, 100e6);
        _donate(ngoPayout, other, 100e6);
        _donate(supplierA, other, 500e6); // the default plan pays every tranche to supplierA
        _donate(donor1, other, 300e6);
        otherVault.releaseTranche(0);

        address[3] memory interested = [ngo, ngoPayout, supplierA];
        for (uint256 i; i < interested.length; ++i) {
            (IReleasePolicy.Voice voice, uint256 weight) = deliveryManager.voiceOf(other, interested[i]);
            assertEq(uint8(voice), uint8(IReleasePolicy.Voice.None));
            assertEq(weight, 0);
        }
        (, uint256 donorWeight) = deliveryManager.voiceOf(other, donor1);
        assertEq(donorWeight, 300e6);

        uint256 deliveryId = _submitEvidence(other);
        for (uint256 i; i < interested.length; ++i) {
            vm.prank(interested[i]);
            vm.expectRevert(Errors.NoSay.selector);
            deliveryManager.approve(deliveryId);
        }
        _approve(donor1, deliveryId); // exactly 30% of 1,000
        assertEq(_status(deliveryId), IDeliveryManager.DeliveryStatus.Approved);
    }

    function test_vote_notAfterItWasDecided() public {
        uint256 deliveryId = _submitEvidence(needId);
        _approve(outsider, deliveryId);
        vm.prank(donor1);
        vm.expectRevert(Errors.InvalidDeliveryStatus.selector);
        deliveryManager.reject(deliveryId);
    }

    function test_vote_unknownDelivery() public {
        vm.prank(donor1);
        vm.expectRevert(Errors.DeliveryNotFound.selector);
        deliveryManager.approve(99);
    }

    // ─── rejecting ─────────────────────────────────────────────────────────────

    function test_reject_atHalfTheMoney_sendsTheNgoBackToTryAgain() public {
        uint256 deliveryId = _submitEvidence(needId);
        _reject(donor1, deliveryId);
        _reject(donor2, deliveryId);
        assertEq(_status(deliveryId), IDeliveryManager.DeliveryStatus.Open, "40% is not enough to reject");
        assertEq(deliveryManager.getDelivery(deliveryId).rejectedAmount, GIFT_1 + GIFT_2);

        vm.expectEmit(true, true, false, true, address(deliveryManager));
        emit IDeliveryManager.DeliveryRejected(deliveryId, needId, 1, 1, false);
        _reject(outsider, deliveryId);

        assertEq(_status(deliveryId), IDeliveryManager.DeliveryStatus.Rejected);
        assertEq(deliveryManager.getDelivery(deliveryId).decidedAt, block.timestamp);
        assertEq(deliveryManager.strikesOf(needId), 1);
        assertEq(registry.statusOf(needId), INeedsRegistry.NeedStatus.InDelivery, "one retry left");
        assertEq(uint8(vault.trancheStatus(1)), uint8(ITrancheLedger.TrancheStatus.Locked));

        // The NGO files new evidence for the same tranche, and it can still be approved.
        uint256 retry = _submitEvidence(needId);
        assertEq(deliveryManager.getDelivery(retry).trancheIndex, 1);
        _approve(outsider, retry);
        assertEq(uint8(vault.trancheStatus(1)), uint8(ITrancheLedger.TrancheStatus.Releasable));
    }

    function test_reject_secondRejectionCancelsTheNeed_andDonorsGetTheRestBack() public {
        _reject(outsider, _submitEvidence(needId));
        uint256 second = _submitEvidence(needId);

        vm.expectEmit(true, true, false, true, address(deliveryManager));
        emit IDeliveryManager.DeliveryRejected(second, needId, 1, 2, true);
        _reject(outsider, second);

        assertEq(registry.statusOf(needId), INeedsRegistry.NeedStatus.Cancelled);
        vm.prank(ngo);
        vm.expectRevert(Errors.InvalidNeedStatus.selector);
        deliveryManager.submitEvidence(needId, MANIFEST);

        // Tranche 0 (30%) was paid; every donor gets back their share of the other 70%.
        uint256 before = token.balanceOf(donor1);
        vm.prank(donor1);
        vault.claimRefund();
        assertEq(token.balanceOf(donor1) - before, (GIFT_1 * 70) / 100);
        assertVaultInvariant(vault);
    }

    function test_reject_theRejectionsOfEarlierTranchesCount() public {
        _reject(outsider, _submitEvidence(needId)); // tranche 1: strike 1
        _approve(outsider, _submitEvidence(needId)); // tranche 1 approved on the retry
        vault.releaseTranche(1);

        _reject(outsider, _submitEvidence(needId)); // tranche 2: strike 2 → cancelled
        assertEq(registry.statusOf(needId), INeedsRegistry.NeedStatus.Cancelled);
    }

    // ─── signed votes ──────────────────────────────────────────────────────────

    function test_voteBySig_anyoneCanRelayTheSignersVote() public {
        (address signer, uint256 key) = makeAddrAndKey("signingDonor");
        (uint256 id, AidVault v) = _needWithPolicy(address(0), TARGET);
        _donate(signer, id, 400e6);
        _donate(donor1, id, 600e6);
        v.releaseTranche(0);
        uint256 deliveryId = _submitEvidence(id);

        uint256 deadline = block.timestamp + 1 hours;
        bytes memory signature = _sign(key, deliveryId, signer, true, deadline);
        vm.expectEmit(true, true, false, true, address(deliveryManager));
        emit IDeliveryManager.VoteCast(deliveryId, signer, IReleasePolicy.Voice.Donor, true, 400e6);
        vm.prank(relayer);
        deliveryManager.voteBySig(deliveryId, signer, true, deadline, signature);

        assertTrue(deliveryManager.hasVoted(deliveryId, signer));
        assertEq(_status(deliveryId), IDeliveryManager.DeliveryStatus.Approved);
    }

    function test_voteBySig_refusesExpiredForgedTamperedAndReplayedSignatures() public {
        (address signer, uint256 key) = makeAddrAndKey("signingDonor");
        (uint256 id, AidVault v) = _needWithPolicy(address(0), TARGET);
        _donate(signer, id, 100e6);
        _donate(donor1, id, 900e6);
        v.releaseTranche(0);
        uint256 deliveryId = _submitEvidence(id);
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory approval = _sign(key, deliveryId, signer, true, deadline);

        vm.expectRevert(Errors.InvalidSignature.selector);
        deliveryManager.voteBySig(deliveryId, signer, false, deadline, approval); // the vote was flipped
        vm.expectRevert(Errors.InvalidSignature.selector);
        deliveryManager.voteBySig(deliveryId, donor1, true, deadline, approval); // someone else's name

        (, uint256 otherKey) = makeAddrAndKey("impostor");
        bytes memory forged = _sign(otherKey, deliveryId, signer, true, deadline);
        vm.expectRevert(Errors.InvalidSignature.selector);
        deliveryManager.voteBySig(deliveryId, signer, true, deadline, forged);

        vm.warp(deadline + 1);
        vm.expectRevert(Errors.SignatureExpired.selector);
        deliveryManager.voteBySig(deliveryId, signer, true, deadline, approval);

        vm.warp(deadline);
        deliveryManager.voteBySig(deliveryId, signer, true, deadline, approval);
        vm.expectRevert(Errors.AlreadyVoted.selector);
        deliveryManager.voteBySig(deliveryId, signer, true, deadline, approval);
    }

    /// @dev Since EIP-7702 an ordinary wallet can carry code, delegated to a contract that may not implement ERC-1271
    ///      (on Base mainnet, anvil's well-known keys are all delegated to one that does not). Its own key still signs.
    function test_voteBySig_acceptsTheKeyOfAWalletThatDelegatedItsCode() public {
        (address signer, uint256 key) = makeAddrAndKey("delegatedDonor");
        (uint256 id, AidVault v) = _needWithPolicy(address(0), TARGET);
        _donate(signer, id, 400e6);
        _donate(donor1, id, 600e6);
        v.releaseTranche(0);
        uint256 deliveryId = _submitEvidence(id);
        // An EIP-7702 delegation designator: 0xef0100 followed by the delegate, here one with no ERC-1271 at all.
        vm.etch(signer, abi.encodePacked(hex"ef0100", address(token)));
        assertGt(signer.code.length, 0);

        uint256 deadline = block.timestamp + 1 hours;
        // A signature by another key is still refused, delegated code or not.
        (, uint256 otherKey) = makeAddrAndKey("impostor");
        bytes memory forged = _sign(otherKey, deliveryId, signer, true, deadline);
        vm.expectRevert(Errors.InvalidSignature.selector);
        deliveryManager.voteBySig(deliveryId, signer, true, deadline, forged);

        bytes memory signature = _sign(key, deliveryId, signer, true, deadline);
        vm.prank(relayer);
        deliveryManager.voteBySig(deliveryId, signer, true, deadline, signature);
        assertEq(_status(deliveryId), IDeliveryManager.DeliveryStatus.Approved);
    }

    /// @dev Card donors hold a passkey smart wallet, which signs through ERC-1271 rather than with a raw key.
    function test_voteBySig_acceptsASmartWalletSignature() public {
        (address owner, uint256 key) = makeAddrAndKey("walletOwner");
        MockSmartWallet wallet = new MockSmartWallet(owner);
        (uint256 id, AidVault v) = _needWithPolicy(address(0), TARGET);
        token.mint(address(wallet), 500e6);
        wallet.donate(IAidVault(address(v)), IERC20(address(token)), 500e6);
        _donate(donor1, id, 500e6);
        v.releaseTranche(0);
        uint256 deliveryId = _submitEvidence(id);

        uint256 deadline = block.timestamp + 1 hours;
        deliveryManager.voteBySig(
            deliveryId, address(wallet), false, deadline, _sign(key, deliveryId, address(wallet), false, deadline)
        );
        assertEq(_status(deliveryId), IDeliveryManager.DeliveryStatus.Rejected, "the wallet gave half");
    }

    // ─── other policies ────────────────────────────────────────────────────────

    function test_verifierPolicy_anIndependentVerifierDecides_donorsHaveNoSay() public {
        (uint256 id, AidVault v) = _needWithPolicy(address(verifierPolicy), TARGET);
        _fund(id, v);
        IReleasePolicy.Rules memory r = deliveryManager.rulesOf(id);
        assertEq(r.donorApproval, 0);
        assertEq(r.verifierApproval, 1);

        uint256 deliveryId = _submitEvidence(id);
        vm.prank(outsider);
        vm.expectRevert(Errors.NoSay.selector);
        deliveryManager.approve(deliveryId);

        vm.expectEmit(true, true, false, true, address(deliveryManager));
        emit IDeliveryManager.VoteCast(deliveryId, verifier3, IReleasePolicy.Voice.Verifier, true, 1);
        _approve(verifier3, deliveryId);
        assertEq(_status(deliveryId), IDeliveryManager.DeliveryStatus.Approved);
        assertEq(deliveryManager.getDelivery(deliveryId).verifierApprovals, 1);
    }

    function test_verifierPolicy_aVerifierCanReject() public {
        (uint256 id, AidVault v) = _needWithPolicy(address(verifierPolicy), TARGET);
        _fund(id, v);
        uint256 deliveryId = _submitEvidence(id);
        _reject(verifier2, deliveryId);
        assertEq(_status(deliveryId), IDeliveryManager.DeliveryStatus.Rejected);
    }

    function test_verifierPolicy_aHighValueNeedTakesTwoVerifiers() public {
        uint256 target = HIGH_VALUE_THRESHOLD + 1000e6;
        (uint256 id, AidVault v) = _needWithPolicy(address(verifierPolicy), target);
        _donate(donor1, id, target);
        v.releaseTranche(0);
        uint256 deliveryId = _submitEvidence(id);

        _approve(verifier1, deliveryId);
        assertEq(_status(deliveryId), IDeliveryManager.DeliveryStatus.Open, "one of two");
        _approve(verifier3, deliveryId);
        assertEq(_status(deliveryId), IDeliveryManager.DeliveryStatus.Approved);
    }

    function test_bothPolicy_needsTheDonorsAndAVerifier_inEitherOrder() public {
        (uint256 id, AidVault v) = _needWithPolicy(address(bothPolicy), TARGET);
        _fund(id, v);

        uint256 first = _submitEvidence(id);
        _approve(outsider, first); // 60% of the money
        assertEq(_status(first), IDeliveryManager.DeliveryStatus.Open, "the verifier has not approved");
        _approve(verifier1, first);
        assertEq(_status(first), IDeliveryManager.DeliveryStatus.Approved);
        v.releaseTranche(1);

        uint256 second = _submitEvidence(id);
        _approve(verifier1, second);
        assertEq(_status(second), IDeliveryManager.DeliveryStatus.Open, "the donors have not approved");
        _approve(donor1, second);
        _approve(donor2, second);
        assertEq(_status(second), IDeliveryManager.DeliveryStatus.Approved);
    }

    function test_bothPolicy_eitherSideCanReject() public {
        (uint256 id, AidVault v) = _needWithPolicy(address(bothPolicy), TARGET);
        _fund(id, v);
        uint256 first = _submitEvidence(id);
        _approve(outsider, first);
        _reject(verifier1, first);
        assertEq(_status(first), IDeliveryManager.DeliveryStatus.Rejected, "donor approval does not overrule");

        uint256 second = _submitEvidence(id);
        _approve(verifier1, second);
        _reject(outsider, second);
        assertEq(registry.statusOf(id), INeedsRegistry.NeedStatus.Cancelled);
    }

    /// @dev A verifier that also donated votes once, as a verifier; its donation adds no donor weight.
    function test_bothPolicy_aVerifierWhoGaveCountsOnlyAsAVerifier() public {
        (uint256 id, AidVault v) = _needWithPolicy(address(bothPolicy), TARGET);
        _donate(verifier3, id, 500e6);
        _donate(donor1, id, 500e6);
        v.releaseTranche(0);
        (IReleasePolicy.Voice voice, uint256 weight) = deliveryManager.voiceOf(id, verifier3);
        assertEq(uint8(voice), uint8(IReleasePolicy.Voice.Verifier));
        assertEq(weight, 1);

        uint256 deliveryId = _submitEvidence(id);
        _approve(verifier3, deliveryId);
        IDeliveryManager.Delivery memory d = deliveryManager.getDelivery(deliveryId);
        assertEq(d.approvedAmount, 0);
        assertEq(d.status, IDeliveryManager.DeliveryStatus.Open);
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

    function test_pause_stopsSubmittingAndVoting() public {
        uint256 deliveryId = _submitEvidence(needId);
        vm.prank(admin);
        roles.pause();

        vm.prank(ngo);
        vm.expectRevert(Errors.SystemPaused.selector);
        deliveryManager.submitEvidence(needId, MANIFEST);
        vm.startPrank(donor1);
        vm.expectRevert(Errors.SystemPaused.selector);
        deliveryManager.approve(deliveryId);
        vm.expectRevert(Errors.SystemPaused.selector);
        deliveryManager.reject(deliveryId);
        vm.expectRevert(Errors.SystemPaused.selector);
        deliveryManager.voteBySig(deliveryId, donor1, true, block.timestamp, "");
        vm.stopPrank();
    }
}
