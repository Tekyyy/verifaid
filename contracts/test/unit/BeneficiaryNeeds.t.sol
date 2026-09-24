// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AidVault} from "../../src/funds/AidVault.sol";
import {IBeneficiaryRegistry} from "../../src/interfaces/IBeneficiaryRegistry.sol";
import {IDeliveryManager} from "../../src/interfaces/IDeliveryManager.sol";
import {INeedsRegistry} from "../../src/interfaces/INeedsRegistry.sol";
import {IReleasePolicy} from "../../src/interfaces/IReleasePolicy.sol";
import {ITrancheLedger} from "../../src/interfaces/ITrancheLedger.sol";
import {Errors} from "../../src/libraries/Errors.sol";
import {PoATest} from "../utils/PoATest.sol";
import {
    AttestationRequest,
    AttestationRequestData
} from "@ethereum-attestation-service/eas-contracts/contracts/IEAS.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// @dev An NGO whose account is a smart wallet (ERC-1271) with one owner key, like a Safe with one signer.
contract MockNgoWallet {
    address public immutable owner;

    constructor(address owner_) {
        owner = owner_;
    }

    function isValidSignature(bytes32 hash, bytes calldata signature) external view returns (bytes4) {
        return ECDSA.recover(hash, signature) == owner ? bytes4(0x1626ba7e) : bytes4(0xffffffff);
    }
}

/// @notice A beneficiary an NGO certified posts a need of their own and runs it: the certificate's rules, who may
///         do what on such a need, and the whole life of one, tranche by tranche, into the beneficiary's wallet.
contract BeneficiaryNeedsTest is PoATest {
    uint256 internal constant TARGET = 3000e6;

    uint256 internal programId;

    function setUp() public override {
        super.setUp();
        programId = _createProgram(ngo);
    }

    // ─── helpers ───────────────────────────────────────────────────────────────

    function _post(
        address caller,
        INeedsRegistry.CreateNeedParams memory p,
        IBeneficiaryRegistry.Certification memory c,
        bytes memory signature
    ) internal returns (uint256 needId) {
        vm.prank(caller);
        needId = beneficiaries.createNeed(p, c, signature);
    }

    /// @dev Expects `beneficiary`'s post of a need on certificate `c`, signed with `key`, to revert with `selector`.
    function _expectRefused(IBeneficiaryRegistry.Certification memory c, uint256 key, bytes4 selector) internal {
        bytes memory signature = _signCertification(c, key);
        assertFalse(beneficiaries.isCertified(c, signature), "the view must agree with the transaction");
        vm.expectRevert(selector);
        _post(c.beneficiary, _beneficiaryNeedParams(c.programId, TARGET), c, signature);
    }

    function _certified() internal view returns (IBeneficiaryRegistry.Certification memory) {
        return _certification(beneficiary, ngo, programId);
    }

    // ─── posting a need ────────────────────────────────────────────────────────

    function test_createNeed_postsANeedTheBeneficiaryRuns() public {
        IBeneficiaryRegistry.Certification memory c = _certified();
        bytes memory signature = _signCertification(c, _keyOf(ngo));
        assertTrue(beneficiaries.isCertified(c, signature));

        vm.expectEmit(true, true, true, true, address(beneficiaries));
        emit IBeneficiaryRegistry.BeneficiaryNeedPosted(1, beneficiary, ngo, programId, c.issuedAt);
        uint256 needId = _post(beneficiary, _beneficiaryNeedParams(programId, TARGET), c, signature);

        assertEq(registry.statusOf(needId), INeedsRegistry.NeedStatus.Pending);
        assertEq(registry.ngoOf(needId), ngo, "the certifying NGO stays the need's NGO");
        assertEq(registry.beneficiaryOf(needId), beneficiary);
        assertEq(registry.ownerOf(needId), beneficiary, "the beneficiary runs it");
        assertEq(registry.ownPayoutOf(needId), beneficiary, "its own share is paid to the beneficiary");
        assertEq(registry.programOf(needId), programId);
        assertEq(beneficiaries.lastNeedOf(beneficiary), needId);
    }

    function test_needsAnNgoCreates_keepTheirOwnerAndPayout() public {
        uint256 needId = _createNeed(ngo, programId, TARGET, 1);
        assertEq(registry.beneficiaryOf(needId), address(0));
        assertEq(registry.ownerOf(needId), ngo);
        assertEq(registry.ownPayoutOf(needId), ngoPayout);
    }

    function test_createNeed_onlyTheCertifiedWalletCanUseItsCertificate() public {
        IBeneficiaryRegistry.Certification memory c = _certified();
        bytes memory signature = _signCertification(c, _keyOf(ngo));
        vm.expectRevert(Errors.Unauthorized.selector);
        _post(outsider, _beneficiaryNeedParams(programId, TARGET), c, signature);
    }

    function test_createBeneficiaryNeed_onlyThroughTheBeneficiaryRegistry() public {
        INeedsRegistry.CreateNeedParams memory p = _beneficiaryNeedParams(programId, TARGET);
        vm.prank(beneficiary);
        vm.expectRevert(Errors.Unauthorized.selector);
        registry.createBeneficiaryNeed(p, ngo, beneficiary);
        vm.prank(ngo);
        vm.expectRevert(Errors.Unauthorized.selector);
        registry.createBeneficiaryNeed(p, ngo, beneficiary);
    }

    function test_createNeed_theNeedBelongsToTheCertificatesProgramme() public {
        uint256 other = _createProgram(ngo);
        IBeneficiaryRegistry.Certification memory c = _certified();
        bytes memory signature = _signCertification(c, _keyOf(ngo));
        vm.expectRevert(Errors.ProgramMismatch.selector);
        _post(beneficiary, _beneficiaryNeedParams(other, TARGET), c, signature);
    }

    function test_createNeed_anNgoCertifiesOnlyIntoItsOwnProgrammes() public {
        uint256 theirs = _createProgram(ngo2);
        _expectRefused(_certification(beneficiary, ngo, theirs), _keyOf(ngo), Errors.ProgramMismatch.selector);
    }

    function test_createNeed_refusesAClosedProgramme() public {
        vm.prank(ngo);
        programs.setProgramActive(programId, false);
        _expectRefused(_certified(), _keyOf(ngo), Errors.ProgramInactive.selector);
    }

    function test_createNeed_refusesASignatureFromAnyoneButTheNgo() public {
        _expectRefused(_certified(), _keyOf(ngo2), Errors.InvalidSignature.selector);
    }

    function test_createNeed_refusesACertificateChangedAfterSigning() public {
        IBeneficiaryRegistry.Certification memory c = _certified();
        bytes memory signature = _signCertification(c, _keyOf(ngo));
        c.expiresAt += 365 days;
        assertFalse(beneficiaries.isCertified(c, signature));
        vm.expectRevert(Errors.InvalidSignature.selector);
        _post(beneficiary, _beneficiaryNeedParams(programId, TARGET), c, signature);
    }

    function test_createNeed_refusesAnExpiredCertificate() public {
        IBeneficiaryRegistry.Certification memory c = _certified();
        bytes memory signature = _signCertification(c, _keyOf(ngo));
        vm.warp(c.expiresAt);
        assertFalse(beneficiaries.isCertified(c, signature));
        vm.expectRevert(Errors.CertificationExpired.selector);
        _post(beneficiary, _beneficiaryNeedParams(programId, TARGET), c, signature);
    }

    function test_createNeed_refusesACertificateNotValidYet() public {
        IBeneficiaryRegistry.Certification memory c = _certified();
        c.issuedAt += 1 days;
        _expectRefused(c, _keyOf(ngo), Errors.CertificationExpired.selector);
    }

    function test_createNeed_refusesACertificateThatEndsBeforeItStarts() public {
        IBeneficiaryRegistry.Certification memory c = _certified();
        c.expiresAt = c.issuedAt;
        _expectRefused(c, _keyOf(ngo), Errors.InvalidParameter.selector);
    }

    function test_createNeed_refusesASuspendedNgosCertificate() public {
        vm.prank(admin);
        roles.setNgoActive(ngo, false);
        _expectRefused(_certified(), _keyOf(ngo), Errors.NgoInactive.selector);
    }

    function test_createNeed_refusesAnyoneWithAnOperationalRole() public {
        address[6] memory participants = [ngo, ngo2, ngoPayout, verifier1, supplierA, ngo2Payout];
        for (uint256 i; i < participants.length; ++i) {
            _expectRefused(_certification(participants[i], ngo, programId), _keyOf(ngo), Errors.RoleConflict.selector);
        }
    }

    function test_createNeed_refusesAFormerVerifier() public {
        vm.startPrank(admin);
        roles.registerVerifier(beneficiary);
        roles.removeVerifier(beneficiary);
        vm.stopPrank();
        _expectRefused(_certified(), _keyOf(ngo), Errors.RoleConflict.selector);
    }

    function test_createNeed_refusedWhilePaused() public {
        IBeneficiaryRegistry.Certification memory c = _certified();
        bytes memory signature = _signCertification(c, _keyOf(ngo));
        vm.prank(admin);
        roles.pause();
        vm.expectRevert(Errors.SystemPaused.selector);
        _post(beneficiary, _beneficiaryNeedParams(programId, TARGET), c, signature);
    }

    function test_createNeed_acceptsAnNgoThatSignsAsASmartWallet() public {
        (address signer, uint256 signerKey) = makeAddrAndKey("ngoWalletOwner");
        address wallet = address(new MockNgoWallet(signer));
        vm.prank(admin);
        roles.registerNgo(wallet, wallet, keccak256("wallet-ngo"), "ipfs://wallet-ngo");
        uint256 walletProgram = _createProgram(wallet);

        IBeneficiaryRegistry.Certification memory c = _certification(beneficiary, wallet, walletProgram);
        uint256 needId =
            _post(beneficiary, _beneficiaryNeedParams(walletProgram, TARGET), c, _signCertification(c, signerKey));
        assertEq(registry.ngoOf(needId), wallet);
    }

    // ─── withdrawing a certification ───────────────────────────────────────────

    function test_revoke_voidsEveryCertificateIssuedUntilThen() public {
        IBeneficiaryRegistry.Certification memory c = _certified();
        vm.expectEmit(true, true, true, true, address(beneficiaries));
        emit IBeneficiaryRegistry.CertificationRevoked(ngo, beneficiary);
        vm.prank(ngo);
        beneficiaries.revoke(beneficiary);
        assertEq(beneficiaries.revokedAt(ngo, beneficiary), block.timestamp);

        _expectRefused(c, _keyOf(ngo), Errors.CertificationRevoked.selector);

        // A certificate issued later is the NGO's new word on it.
        vm.warp(block.timestamp + 1);
        IBeneficiaryRegistry.Certification memory renewed = _certified();
        _post(beneficiary, _beneficiaryNeedParams(programId, TARGET), renewed, _signCertification(renewed, _keyOf(ngo)));
    }

    function test_revoke_onlyVoidsTheRevokingNgosCertificates() public {
        uint256 theirs = _createProgram(ngo2);
        vm.prank(ngo);
        beneficiaries.revoke(beneficiary);
        IBeneficiaryRegistry.Certification memory c = _certification(beneficiary, ngo2, theirs);
        _post(beneficiary, _beneficiaryNeedParams(theirs, TARGET), c, _signCertification(c, _keyOf(ngo2)));
    }

    function test_revoke_onlyByARegisteredNgo_evenASuspendedOne() public {
        vm.prank(outsider);
        vm.expectRevert(Errors.NgoNotRegistered.selector);
        beneficiaries.revoke(beneficiary);

        vm.prank(admin);
        roles.setNgoActive(ngo, false);
        vm.prank(ngo);
        beneficiaries.revoke(beneficiary);
        assertEq(beneficiaries.revokedAt(ngo, beneficiary), block.timestamp);
    }

    function test_revoke_leavesAPostedNeedAlone() public {
        uint256 needId = _postBeneficiaryNeed(beneficiary, programId, TARGET);
        vm.prank(ngo);
        beneficiaries.revoke(beneficiary);
        assertEq(registry.statusOf(needId), INeedsRegistry.NeedStatus.Pending);
        assertEq(registry.beneficiaryOf(needId), beneficiary);
    }

    // ─── one open need at a time ───────────────────────────────────────────────

    function test_createNeed_oneOpenNeedAtATime() public {
        uint256 first = _postBeneficiaryNeed(beneficiary, programId, TARGET);
        IBeneficiaryRegistry.Certification memory c = _certified();
        bytes memory signature = _signCertification(c, _keyOf(ngo));
        vm.expectRevert(Errors.OpenNeedExists.selector);
        _post(beneficiary, _beneficiaryNeedParams(programId, TARGET), c, signature);

        // Once the first is over, the next can be posted on the same certificate.
        vm.prank(beneficiary);
        registry.cancelNeed(first);
        uint256 second = _post(beneficiary, _beneficiaryNeedParams(programId, TARGET), c, signature);
        assertEq(beneficiaries.lastNeedOf(beneficiary), second);
    }

    function test_createNeed_otherBeneficiariesAreNotHeldBack() public {
        _postBeneficiaryNeed(beneficiary, programId, TARGET);
        _postBeneficiaryNeed(beneficiary2, programId, TARGET);
    }

    // ─── payment plan ──────────────────────────────────────────────────────────

    function test_paymentPlan_aBeneficiaryMayReceiveTheWholeNeed() public {
        INeedsRegistry.CreateNeedParams memory p = _beneficiaryNeedParams(programId, TARGET);
        vm.prank(ngo);
        vm.expectRevert(Errors.NgoShareTooHigh.selector);
        registry.createNeed(p); // an NGO keeps at most a quarter

        uint256 needId = _postBeneficiaryNeed(beneficiary, programId, TARGET);
        INeedsRegistry.PayeeShare[] memory plan = registry.payeesOf(needId);
        assertEq(plan.length, 1);
        assertEq(plan[0].account, address(0), "the owner's own share");
    }

    function test_paymentPlan_aBeneficiaryCannotTakeTheWholeNeedBeforeEvidence() public {
        IBeneficiaryRegistry.Certification memory c = _certified();
        bytes memory signature = _signCertification(c, _keyOf(ngo));
        INeedsRegistry.CreateNeedParams memory p = _beneficiaryNeedParams(programId, TARGET);

        // One tranche would pay everything into their wallet before any evidence.
        uint16[] memory single = new uint16[](1);
        single[0] = 10_000;
        p.trancheBps = single;
        p.payees = _singlePayee(address(0), 1);
        vm.expectRevert(Errors.BeneficiaryPrefinancingTooLarge.selector);
        _post(beneficiary, p, c, signature);

        // Two tranches, but more than half up front.
        uint16[] memory frontLoaded = new uint16[](2);
        frontLoaded[0] = 5001;
        frontLoaded[1] = 4999;
        p.trancheBps = frontLoaded;
        p.payees = _singlePayee(address(0), 2);
        vm.expectRevert(Errors.BeneficiaryPrefinancingTooLarge.selector);
        _post(beneficiary, p, c, signature);

        // Half up front, half after evidence: allowed, and the same certificate still works.
        frontLoaded[0] = 5000;
        frontLoaded[1] = 5000;
        uint256 needId = _post(beneficiary, p, c, signature);
        assertEq(registry.statusOf(needId), INeedsRegistry.NeedStatus.Pending);
        assertEq(registry.MAX_BENEFICIARY_FIRST_TRANCHE_BPS(), 5000);
    }

    function test_paymentPlan_theCapIsABeneficiarys_anNgoMayPrefinanceItsSuppliersInFull() public {
        // An NGO's single tranche goes to the vetted suppliers in its plan, not to itself.
        uint16[] memory single = new uint16[](1);
        single[0] = 10_000;
        vm.prank(ngo);
        uint256 needId = registry.createNeed(_needParams(programId, TARGET, 1, single));
        assertEq(registry.statusOf(needId), INeedsRegistry.NeedStatus.Pending);
    }

    function test_paymentPlan_aBeneficiaryMayStillPaySuppliersDirectly() public {
        INeedsRegistry.CreateNeedParams memory p = _beneficiaryNeedParams(programId, TARGET);
        p.payees = new INeedsRegistry.Payee[](2);
        p.payees[0] = _payee(address(0), _uniformShares(3, 6000));
        p.payees[1] = _payee(supplierA, _uniformShares(3, 4000));
        IBeneficiaryRegistry.Certification memory c = _certified();
        uint256 needId = _post(beneficiary, p, c, _signCertification(c, _keyOf(ngo)));
        _attestNeedVerified(verifier1, needId, true);
        AidVault vault = AidVault(registry.vaultOf(needId));
        _donate(donor1, needId, TARGET);

        vault.releaseTranche(0); // 30% of 3,000
        assertEq(token.balanceOf(beneficiary), 540e6, "60% of the tranche to the beneficiary");
        assertEq(token.balanceOf(supplierA), 360e6, "40% straight to the supplier");
        assertEq(token.balanceOf(ngoPayout), 0, "the NGO takes nothing from its beneficiary's need");
    }

    // ─── who may do what ───────────────────────────────────────────────────────

    function test_verification_neverByTheBeneficiary() public {
        uint256 needId = _postBeneficiaryNeed(beneficiary, programId, TARGET);
        // The registry cannot stop the admin from registering the wallet as a verifier afterwards...
        vm.prank(admin);
        roles.registerVerifier(beneficiary);
        // ...but it never counts as independent of its own need.
        vm.expectRevert(Errors.NotIndependent.selector);
        _attestNeedVerified(beneficiary, needId, true);
        _attestNeedVerified(verifier1, needId, true);
        assertEq(registry.statusOf(needId), INeedsRegistry.NeedStatus.Funding);
    }

    function test_closeFunding_byTheBeneficiaryNotTheNgo() public {
        uint256 needId = _postBeneficiaryNeed(beneficiary, programId, TARGET);
        _attestNeedVerified(verifier1, needId, true);
        AidVault vault = AidVault(registry.vaultOf(needId));
        _donate(donor1, needId, 1000e6);

        vm.prank(ngo);
        vm.expectRevert(Errors.Unauthorized.selector);
        vault.closeFunding();
        vm.prank(beneficiary);
        vault.closeFunding();
        assertEq(registry.statusOf(needId), INeedsRegistry.NeedStatus.Funded);
    }

    function test_submitEvidence_onlyByTheBeneficiary() public {
        (uint256 needId,,) = _beneficiaryNeedInDelivery(TARGET);
        address[2] memory others = [ngo, outsider];
        for (uint256 i; i < others.length; ++i) {
            vm.prank(others[i]);
            vm.expectRevert(Errors.Unauthorized.selector);
            deliveryManager.submitEvidence(needId, MANIFEST);
        }
        vm.prank(beneficiary);
        deliveryManager.submitEvidence(needId, MANIFEST);
    }

    function test_voting_neitherTheBeneficiaryNorItsNgoHasASay() public {
        uint256 needId = _postBeneficiaryNeed(beneficiary, programId, TARGET);
        _attestNeedVerified(verifier1, needId, true);
        // Both give to the need; neither may judge its evidence.
        _donate(beneficiary, needId, 500e6);
        _donate(ngo, needId, 500e6);
        _donate(donor1, needId, 2000e6);

        (IReleasePolicy.Voice voice,) = deliveryManager.voiceOf(needId, beneficiary);
        assertEq(uint8(voice), uint8(IReleasePolicy.Voice.None), "the beneficiary judges nothing of its own");
        (voice,) = deliveryManager.voiceOf(needId, ngo);
        assertEq(uint8(voice), uint8(IReleasePolicy.Voice.None), "the certifying NGO neither");
        (voice,) = deliveryManager.voiceOf(needId, donor1);
        assertEq(uint8(voice), uint8(IReleasePolicy.Voice.Donor));
    }

    function test_voting_aBeneficiaryWhoBecameAVerifierStillHasNoSay() public {
        INeedsRegistry.CreateNeedParams memory p = _beneficiaryNeedParams(programId, TARGET);
        p.releasePolicy = address(verifierPolicy);
        IBeneficiaryRegistry.Certification memory c = _certified();
        uint256 needId = _post(beneficiary, p, c, _signCertification(c, _keyOf(ngo)));
        vm.prank(admin);
        roles.registerVerifier(beneficiary);

        (IReleasePolicy.Voice voice,) = deliveryManager.voiceOf(needId, beneficiary);
        assertEq(uint8(voice), uint8(IReleasePolicy.Voice.None));
    }

    function test_cancelNeed_byTheBeneficiaryOrTheCertifyingNgo_beforeFundingCloses() public {
        uint256 first = _postBeneficiaryNeed(beneficiary, programId, TARGET);
        vm.prank(outsider);
        vm.expectRevert(Errors.Unauthorized.selector);
        registry.cancelNeed(first);
        vm.prank(ngo2);
        vm.expectRevert(Errors.Unauthorized.selector);
        registry.cancelNeed(first);

        vm.prank(ngo);
        registry.cancelNeed(first);
        assertEq(registry.statusOf(first), INeedsRegistry.NeedStatus.Cancelled);

        uint256 second = _postBeneficiaryNeed(beneficiary, programId, TARGET);
        vm.prank(beneficiary);
        registry.cancelNeed(second);
        assertEq(registry.statusOf(second), INeedsRegistry.NeedStatus.Cancelled);
    }

    function test_cancelNeed_notByTheBeneficiaryOnceFunded() public {
        (uint256 needId,,) = _beneficiaryNeedInDelivery(TARGET);
        vm.prank(beneficiary);
        vm.expectRevert(Errors.InvalidNeedStatus.selector);
        registry.cancelNeed(needId);
    }

    function test_enableYield_byTheBeneficiaryNotTheNgo() public {
        uint256 needId = _postBeneficiaryNeed(beneficiary, programId, TARGET);
        vm.prank(ngo);
        vm.expectRevert(Errors.Unauthorized.selector);
        registry.enableYield(needId);
        vm.prank(beneficiary);
        registry.enableYield(needId);
        assertTrue(registry.yieldEnabled(needId));
    }

    function test_payeeChange_proposedByTheBeneficiaryNotTheNgo() public {
        INeedsRegistry.CreateNeedParams memory p = _beneficiaryNeedParams(programId, TARGET);
        p.payees = new INeedsRegistry.Payee[](2);
        p.payees[0] = _payee(address(0), _uniformShares(3, 5000));
        p.payees[1] = _payee(supplierA, _uniformShares(3, 5000));
        IBeneficiaryRegistry.Certification memory c = _certified();
        uint256 needId = _post(beneficiary, p, c, _signCertification(c, _keyOf(ngo)));

        vm.prank(ngo);
        vm.expectRevert(Errors.Unauthorized.selector);
        registry.proposePayeeChange(needId, 1, supplierB, SUPPLIER_QUOTE, "supplier B");

        vm.prank(beneficiary);
        uint256 changeId = registry.proposePayeeChange(needId, 1, supplierB, SUPPLIER_QUOTE, "supplier B");
        vm.prank(verifier1);
        registry.approvePayeeChange(needId, changeId);
        vm.prank(verifier2);
        registry.approvePayeeChange(needId, changeId);
        assertEq(registry.payeesOf(needId)[1].account, supplierB);
    }

    function test_settlement_attestedByTheBeneficiaryNotTheNgo() public {
        (uint256 needId,, AidVault vault) = _beneficiaryNeedInDelivery(TARGET);
        uint256 tranche0 = vault.getTranches()[0].amount;
        bytes memory data = abi.encode(needId, 0, tranche0, 0, tranche0, SUPPLIER_REF, FX_REF);
        vm.expectRevert(Errors.Unauthorized.selector);
        _attest(settlementSchema, ngo, address(vault), bytes32(0), false, data);
        _attest(settlementSchema, beneficiary, address(vault), bytes32(0), false, data);
        assertTrue(resolver.settlementOf(needId, 0) != bytes32(0));
    }

    function test_aSuspendedNgoFreezesItsBeneficiariesNeeds() public {
        (uint256 needId,, AidVault vault) = _beneficiaryNeedInDelivery(TARGET);
        uint256 deliveryId = _submitEvidence(needId);
        _approveByDonors(deliveryId);

        vm.prank(admin);
        roles.setNgoActive(ngo, false);
        vm.expectRevert(Errors.NgoInactive.selector);
        vault.releaseTranche(1);
    }

    // ─── the whole life of a beneficiary's need ────────────────────────────────

    function test_lifecycle_everyTrancheReachesTheBeneficiaryAgainstEvidence() public {
        (uint256 needId,, AidVault vault) = _beneficiaryNeedInDelivery(TARGET);
        assertEq(token.balanceOf(beneficiary), 900e6, "30% pre-financing to the beneficiary");
        assertEq(registry.statusOf(needId), INeedsRegistry.NeedStatus.InDelivery);

        // Tranche 1 waits for the beneficiary's account of tranche 0, approved by the donors.
        vm.expectRevert(Errors.InvalidTrancheStatus.selector);
        vault.releaseTranche(1);
        uint256 deliveryId = _runDelivery(needId, 1);
        assertEq(deliveryManager.getDelivery(deliveryId).submitter, beneficiary);
        vault.releaseTranche(1);
        assertEq(token.balanceOf(beneficiary), 2100e6, "+40%");

        _runDelivery(needId, 2);
        vault.releaseTranche(2);
        assertEq(token.balanceOf(beneficiary), TARGET, "all of it, a tranche at a time");
        assertEq(registry.statusOf(needId), INeedsRegistry.NeedStatus.Completed);
        assertEq(token.balanceOf(ngoPayout), 0);
        assertVaultInvariant(vault);

        // No impact report closes it: it served one household, and the donors approved every tranche's receipts.
        bytes memory report = abi.encode(needId, uint32(10), KPI_HASH, REPORT_CID);
        vm.prank(ngo);
        vm.expectRevert(Errors.ImpactReportNotApplicable.selector);
        eas.attest(
            AttestationRequest({
                schema: impactReportSchema,
                data: AttestationRequestData({
                    recipient: address(vault),
                    expirationTime: 0,
                    revocable: true,
                    refUID: bytes32(0),
                    data: report,
                    value: 0
                })
            })
        );

        // Over, so the beneficiary may post their next need.
        _postBeneficiaryNeed(beneficiary, programId, TARGET);
    }

    function test_lifecycle_rejectedTwiceTheNeedIsCancelledAndDonorsRefunded() public {
        (uint256 needId,, AidVault vault) = _beneficiaryNeedInDelivery(TARGET);
        _rejectByDonors(_submitEvidence(needId));
        assertEq(registry.statusOf(needId), INeedsRegistry.NeedStatus.InDelivery, "one second chance");
        _rejectByDonors(_submitEvidence(needId));
        assertEq(registry.statusOf(needId), INeedsRegistry.NeedStatus.Cancelled);

        vm.prank(donor1);
        uint256 refunded = vault.claimRefund();
        assertEq(refunded, 2100e6, "everything the beneficiary was not yet paid");
        assertEq(uint8(vault.trancheStatus(1)), uint8(ITrancheLedger.TrancheStatus.Locked));
        assertVaultInvariant(vault);
        assertEq(
            uint8(deliveryManager.getDelivery(deliveryManager.deliveryCount()).status),
            uint8(IDeliveryManager.DeliveryStatus.Rejected)
        );
    }

    /// @dev Bigger than what one verifier may attest is the NGO's own need to post, with vetted suppliers and the
    ///      25% cap on its own share; a person's need is refused above it.
    function test_createNeed_aPersonsNeedRaisesAtMostTheHighValueThreshold() public {
        IBeneficiaryRegistry.Certification memory c = _certification(beneficiary, ngo, programId);
        bytes memory signature = _signCertification(c, _keyOf(ngo));
        INeedsRegistry.CreateNeedParams memory tooBig = _beneficiaryNeedParams(programId, HIGH_VALUE_THRESHOLD + 1);
        vm.prank(beneficiary);
        vm.expectRevert(Errors.BeneficiaryNeedTooLarge.selector);
        beneficiaries.createNeed(tooBig, c, signature);

        uint256 needId = _postBeneficiaryNeed(beneficiary, programId, HIGH_VALUE_THRESHOLD);
        _attestNeedVerified(verifier1, needId, true);
        assertEq(registry.statusOf(needId), INeedsRegistry.NeedStatus.Funding, "at the threshold, one verifier");
    }

    /// @dev One NGO's certificates have at most MAX_OPEN_NEEDS_PER_NGO needs open: an NGO certifying wallets it
    ///      controls cannot open an unbounded number of needs paid in full to them. A need that ends frees its slot.
    function test_createNeed_oneNgosCertificatesOpenOnlySoManyNeedsAtOnce() public {
        uint256 limit = beneficiaries.MAX_OPEN_NEEDS_PER_NGO();
        uint256 first;
        for (uint256 i; i < limit; ++i) {
            uint256 id = _postBeneficiaryNeed(makeAddr(string.concat("person", vm.toString(i))), programId, TARGET);
            if (i == 0) first = id;
        }
        assertEq(beneficiaries.openNeedsOf(ngo), limit);

        address late = makeAddr("latecomer");
        IBeneficiaryRegistry.Certification memory c = _certification(late, ngo, programId);
        bytes memory signature = _signCertification(c, _keyOf(ngo));
        assertFalse(beneficiaries.isCertified(c, signature), "the app is told before the form is filled in");
        INeedsRegistry.CreateNeedParams memory p = _beneficiaryNeedParams(programId, TARGET);
        vm.prank(late);
        vm.expectRevert(Errors.TooManyOpenNeeds.selector);
        beneficiaries.createNeed(p, c, signature);

        vm.prank(ngo);
        registry.cancelNeed(first);
        assertEq(beneficiaries.openNeedsOf(ngo), limit - 1);
        _postBeneficiaryNeed(late, programId, TARGET);
        assertEq(beneficiaries.openNeedsOf(ngo), limit);
    }
}
