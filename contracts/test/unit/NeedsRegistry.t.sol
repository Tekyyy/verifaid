// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AidVault} from "../../src/funds/AidVault.sol";
import {INeedsRegistry} from "../../src/interfaces/INeedsRegistry.sol";
import {Errors} from "../../src/libraries/Errors.sol";
import {NeedsRegistry} from "../../src/needs/NeedsRegistry.sol";
import {PoATest} from "../utils/PoATest.sol";

contract NeedsRegistryTest is PoATest {
    uint256 internal programId;

    function setUp() public override {
        super.setUp();
        programId = _createProgram(ngo, 10);
    }

    // ─── wiring ────────────────────────────────────────────────────────────────

    function test_wire_revertsWhenAlreadyWired() public {
        vm.prank(admin);
        vm.expectRevert(Errors.AlreadyWired.selector);
        registry.wire(address(factory), address(groups), address(deliveryManager), address(resolver));
    }

    function test_wire_revertsForNonAdminAndZeroAddress() public {
        NeedsRegistry fresh = new NeedsRegistry(roles, HIGH_VALUE_THRESHOLD);

        vm.prank(outsider);
        vm.expectRevert(Errors.Unauthorized.selector);
        fresh.wire(address(factory), address(groups), address(deliveryManager), address(resolver));

        vm.prank(admin);
        vm.expectRevert(Errors.ZeroAddress.selector);
        fresh.wire(address(0), address(groups), address(deliveryManager), address(resolver));

        vm.prank(admin);
        fresh.wire(address(factory), address(groups), address(deliveryManager), address(resolver));
        assertTrue(fresh.wired());
    }

    function test_createNeed_revertsWhenNotWired() public {
        NeedsRegistry fresh = new NeedsRegistry(roles, HIGH_VALUE_THRESHOLD);
        vm.prank(ngo);
        vm.expectRevert(Errors.NotWired.selector);
        fresh.createNeed(_needParams(programId, 1000e6, 1, _threeTrancheBps()));
    }

    // ─── createNeed ────────────────────────────────────────────────────────────

    function test_createNeed() public {
        uint16[] memory bps = _threeTrancheBps();
        vm.prank(ngo);
        uint256 needId = registry.createNeed(_needParams(programId, 5000e6, 1, bps));

        assertEq(needId, 1);
        assertEq(registry.needCount(), 1);
        INeedsRegistry.Need memory n = registry.getNeed(needId);
        assertEq(n.id, needId);
        assertEq(n.ngo, ngo);
        assertEq(n.programId, programId);
        assertEq(n.targetAmount, 5000e6);
        assertEq(n.regionCode, REGION);
        assertEq(n.dossierHash, DOSSIER_HASH);
        assertEq(n.verificationsRequired, 1);
        assertEq(n.verificationCount, 0);
        assertEq(n.trancheBps.length, 3);
        assertEq(n.trancheBps[1], 4000);
        assertEq(n.vault, address(0));
        assertEq(n.status, INeedsRegistry.NeedStatus.Pending);
        assertEq(uint8(n.custodyMode), uint8(INeedsRegistry.CustodyMode.OnChain));
        assertEq(n.fundingDeadline, 0);
        assertEq(n.executionDeadline, 0);
        assertEq(n.minFundingBps, 1);
        assertEq(n.thirdPartyCostBps, 0);

        // convenience views
        assertEq(registry.ngoOf(needId), ngo);
        assertEq(registry.programOf(needId), programId);
        assertEq(registry.targetAmountOf(needId), 5000e6);
        assertEq(registry.dossierHashOf(needId), DOSSIER_HASH);
        assertEq(registry.regionCodeOf(needId), REGION);
        assertEq(registry.trancheBpsOf(needId).length, 3);
        assertEq(registry.vaultOf(needId), address(0));
        assertEq(uint8(registry.custodyModeOf(needId)), uint8(INeedsRegistry.CustodyMode.OnChain));
        assertEq(registry.thirdPartyCostBpsOf(needId), 0);
        (address coreNgo, address coreVault, uint256 coreProgram, INeedsRegistry.NeedStatus coreStatus) =
            registry.coreOf(needId);
        assertEq(coreNgo, ngo);
        assertEq(coreVault, address(0));
        assertEq(coreProgram, programId);
        assertEq(coreStatus, INeedsRegistry.NeedStatus.Pending);
    }

    function test_createNeed_emitsEvent() public {
        uint16[] memory bps = _threeTrancheBps();
        vm.expectEmit(true, true, true, true, address(registry));
        // display-only commitments (category, metadata, expected outcome) live only in this event
        emit INeedsRegistry.NeedCreated(1, ngo, programId, _needParams(programId, 5000e6, 1, bps));
        vm.prank(ngo);
        registry.createNeed(_needParams(programId, 5000e6, 1, bps));
    }

    function test_createNeed_revertsForNonNgo() public {
        vm.prank(outsider);
        vm.expectRevert(Errors.Unauthorized.selector);
        registry.createNeed(_needParams(programId, 5000e6, 1, _threeTrancheBps()));
    }

    function test_createNeed_revertsForInactiveNgo() public {
        vm.prank(admin);
        roles.setNgoActive(ngo, false);
        vm.prank(ngo);
        vm.expectRevert(Errors.Unauthorized.selector);
        registry.createNeed(_needParams(programId, 5000e6, 1, _threeTrancheBps()));
    }

    function test_createNeed_revertsForForeignOrUnknownProgram() public {
        uint256 otherProgram = _createProgram(ngo2, 10);
        vm.prank(ngo);
        vm.expectRevert(Errors.ProgramMismatch.selector);
        registry.createNeed(_needParams(otherProgram, 5000e6, 1, _threeTrancheBps()));

        vm.prank(ngo);
        vm.expectRevert(Errors.ProgramMismatch.selector);
        registry.createNeed(_needParams(999, 5000e6, 1, _threeTrancheBps()));
    }

    function test_createNeed_revertsOnInvalidAmountsAndHashes() public {
        vm.startPrank(ngo);
        vm.expectRevert(Errors.ZeroAmount.selector);
        registry.createNeed(_needParams(programId, 0, 1, _threeTrancheBps()));

        INeedsRegistry.CreateNeedParams memory p = _needParams(programId, 5000e6, 1, _threeTrancheBps());
        p.category = bytes32(0);
        vm.expectRevert(Errors.InvalidParameter.selector);
        registry.createNeed(p);

        p = _needParams(programId, 5000e6, 1, _threeTrancheBps());
        p.regionCode = bytes32(0);
        vm.expectRevert(Errors.InvalidParameter.selector);
        registry.createNeed(p);

        p = _needParams(programId, 5000e6, 1, _threeTrancheBps());
        p.dossierHash = bytes32(0);
        vm.expectRevert(Errors.InvalidParameter.selector);
        registry.createNeed(p);
        vm.stopPrank();
    }

    function test_createNeed_revertsOnInvalidTrancheSplit() public {
        vm.startPrank(ngo);

        vm.expectRevert(Errors.InvalidTrancheSplit.selector);
        registry.createNeed(_needParams(programId, 5000e6, 1, new uint16[](0)));

        uint16[] memory tooMany = new uint16[](6);
        for (uint256 i; i < 6; ++i) {
            tooMany[i] = i == 5 ? 5000 : 1000;
        }
        vm.expectRevert(Errors.InvalidTrancheSplit.selector);
        registry.createNeed(_needParams(programId, 5000e6, 1, tooMany));

        uint16[] memory wrongSum = new uint16[](2);
        wrongSum[0] = 3000;
        wrongSum[1] = 3000;
        vm.expectRevert(Errors.InvalidTrancheSplit.selector);
        registry.createNeed(_needParams(programId, 5000e6, 1, wrongSum));

        uint16[] memory zeroPart = new uint16[](2);
        zeroPart[0] = 10_000;
        zeroPart[1] = 0;
        vm.expectRevert(Errors.InvalidTrancheSplit.selector);
        registry.createNeed(_needParams(programId, 5000e6, 1, zeroPart));

        vm.stopPrank();
    }

    function test_createNeed_enforcesVerificationRules() public {
        vm.startPrank(ngo);
        vm.expectRevert(Errors.InsufficientVerifications.selector);
        registry.createNeed(_needParams(programId, 5000e6, 0, _threeTrancheBps()));

        // above the high-value threshold a single verifier is not enough
        vm.expectRevert(Errors.InsufficientVerifications.selector);
        registry.createNeed(_needParams(programId, HIGH_VALUE_THRESHOLD + 1, 1, _threeTrancheBps()));

        uint256 needId = registry.createNeed(_needParams(programId, HIGH_VALUE_THRESHOLD + 1, 2, _threeTrancheBps()));
        assertEq(registry.getNeed(needId).verificationsRequired, 2);
        vm.stopPrank();
    }

    function test_createNeed_revertsWhenPaused() public {
        vm.prank(admin);
        roles.pause();
        vm.prank(ngo);
        vm.expectRevert(Errors.SystemPaused.selector);
        registry.createNeed(_needParams(programId, 5000e6, 1, _threeTrancheBps()));
    }

    // ─── verification ──────────────────────────────────────────────────────────

    function test_verification_singleApprovalOpensFunding() public {
        uint256 needId = _createNeed(ngo, programId, 5000e6, 1);

        vm.expectEmit(true, true, false, true, address(registry));
        emit INeedsRegistry.NeedStatusChanged(
            needId, INeedsRegistry.NeedStatus.Pending, INeedsRegistry.NeedStatus.Verified
        );
        bytes32 uid = _attestNeedVerified(verifier1, needId, true);

        INeedsRegistry.Need memory n = registry.getNeed(needId);
        assertEq(n.status, INeedsRegistry.NeedStatus.Funding);
        assertEq(n.verificationCount, 1);
        assertTrue(n.vault != address(0));
        assertTrue(factory.isVault(n.vault));
        assertTrue(registry.verifiedBy(needId, verifier1));
        assertEq(registry.verificationUID(needId, verifier1), uid);

        AidVault vault = AidVault(n.vault);
        assertEq(vault.needId(), needId);
        assertEq(vault.trancheCount(), 3);
        assertEq(address(vault.token()), address(token));
    }

    function test_verification_requiresTwoApprovalsForHighValue() public {
        vm.prank(ngo);
        uint256 needId = registry.createNeed(_needParams(programId, HIGH_VALUE_THRESHOLD + 1, 2, _threeTrancheBps()));

        _attestNeedVerified(verifier1, needId, true);
        assertEq(registry.statusOf(needId), INeedsRegistry.NeedStatus.Pending);
        assertEq(registry.getNeed(needId).verificationCount, 1);

        _attestNeedVerified(verifier2, needId, true);
        assertEq(registry.statusOf(needId), INeedsRegistry.NeedStatus.Funding);
    }

    function test_verification_rejectionCancelsNeed() public {
        uint256 needId = _createNeed(ngo, programId, 5000e6, 2);
        _attestNeedVerified(verifier1, needId, true);

        vm.expectEmit(true, true, false, false, address(registry));
        emit INeedsRegistry.NeedCancelled(needId, verifier2);
        _attestNeedVerified(verifier2, needId, false);

        assertEq(registry.statusOf(needId), INeedsRegistry.NeedStatus.Cancelled);
        assertEq(registry.vaultOf(needId), address(0));
    }

    function test_onVerificationAttested_onlyResolver() public {
        uint256 needId = _createNeed(ngo, programId, 5000e6, 1);
        vm.prank(verifier1);
        vm.expectRevert(Errors.Unauthorized.selector);
        registry.onVerificationAttested(needId, verifier1, true, keccak256("uid"));
    }

    function test_onVerificationAttested_rejectsDuplicateVerifier() public {
        uint256 needId = _createNeed(ngo, programId, 5000e6, 2);
        _attestNeedVerified(verifier1, needId, true);

        vm.prank(address(resolver));
        vm.expectRevert(Errors.AlreadyVerified.selector);
        registry.onVerificationAttested(needId, verifier1, true, keccak256("uid2"));
    }

    function test_onVerificationAttested_rejectsNonIndependentAndUnknownNeed() public {
        uint256 needId = _createNeed(ngo, programId, 5000e6, 1);

        vm.prank(address(resolver));
        vm.expectRevert(Errors.NotIndependent.selector);
        registry.onVerificationAttested(needId, ngo, true, keccak256("uid"));

        vm.prank(address(resolver));
        vm.expectRevert(Errors.NeedNotFound.selector);
        registry.onVerificationAttested(404, verifier1, true, keccak256("uid"));
    }

    function test_onVerificationAttested_rejectsWhenNotPending() public {
        uint256 needId = _createNeed(ngo, programId, 5000e6, 1);
        _attestNeedVerified(verifier1, needId, true);

        vm.prank(address(resolver));
        vm.expectRevert(Errors.InvalidNeedStatus.selector);
        registry.onVerificationAttested(needId, verifier2, true, keccak256("uid"));
    }

    function test_onVerificationAttested_revertsWhenPaused() public {
        uint256 needId = _createNeed(ngo, programId, 5000e6, 1);
        vm.prank(admin);
        roles.pause();
        vm.prank(address(resolver));
        vm.expectRevert(Errors.SystemPaused.selector);
        registry.onVerificationAttested(needId, verifier1, true, keccak256("uid"));
    }

    // ─── revocation ────────────────────────────────────────────────────────────

    function test_revocation_whilePendingFreesTheVerifier() public {
        uint256 needId = _createNeed(ngo, programId, 5000e6, 2);
        bytes32 uid = _attestNeedVerified(verifier1, needId, true);
        assertEq(registry.getNeed(needId).verificationCount, 1);

        vm.expectEmit(true, true, false, true, address(registry));
        emit INeedsRegistry.NeedVerificationRevoked(needId, verifier1, uid, 0);
        _revoke(needVerifiedSchema, verifier1, uid);

        assertEq(registry.getNeed(needId).verificationCount, 0);
        assertFalse(registry.verifiedBy(needId, verifier1));
        assertEq(registry.statusOf(needId), INeedsRegistry.NeedStatus.Pending);

        // the same verifier may attest again
        _attestNeedVerified(verifier1, needId, true);
        assertEq(registry.getNeed(needId).verificationCount, 1);
    }

    function test_revocation_whileFundingWithoutDonationsReopensPending() public {
        uint256 needId = _createNeed(ngo, programId, 5000e6, 1);
        bytes32 uid = _attestNeedVerified(verifier1, needId, true);
        address vault = registry.vaultOf(needId);
        assertEq(registry.statusOf(needId), INeedsRegistry.NeedStatus.Funding);

        _revoke(needVerifiedSchema, verifier1, uid);
        assertEq(registry.statusOf(needId), INeedsRegistry.NeedStatus.Pending);
        assertEq(registry.getNeed(needId).verificationCount, 0);

        // re-verification reuses the vault that was already deployed
        _attestNeedVerified(verifier2, needId, true);
        assertEq(registry.statusOf(needId), INeedsRegistry.NeedStatus.Funding);
        assertEq(registry.vaultOf(needId), vault);
    }

    function test_revocation_afterDonationsIsLoggedOnly() public {
        uint256 needId = _createNeed(ngo, programId, 5000e6, 1);
        bytes32 uid = _attestNeedVerified(verifier1, needId, true);
        _donate(donor1, needId, 100e6);

        vm.expectEmit(true, true, false, true, address(registry));
        emit INeedsRegistry.VerificationRevokedAfterFunding(needId, verifier1, uid);
        _revoke(needVerifiedSchema, verifier1, uid);

        assertEq(registry.statusOf(needId), INeedsRegistry.NeedStatus.Funding);
        assertEq(registry.getNeed(needId).verificationCount, 1);
        assertTrue(registry.verifiedBy(needId, verifier1));
    }

    function test_onVerificationRevoked_onlyResolverAndKnownUid() public {
        uint256 needId = _createNeed(ngo, programId, 5000e6, 1);
        _attestNeedVerified(verifier1, needId, true);

        vm.prank(outsider);
        vm.expectRevert(Errors.Unauthorized.selector);
        registry.onVerificationRevoked(needId, verifier1, keccak256("uid"));

        vm.prank(address(resolver));
        vm.expectRevert(Errors.UnknownVerification.selector);
        registry.onVerificationRevoked(needId, verifier1, keccak256("other-uid"));
    }

    // ─── setStatus ─────────────────────────────────────────────────────────────

    function test_setStatus_onlyVaultOrDeliveryManager() public {
        (uint256 needId,,) = _verifiedNeed(1000e6);
        vm.prank(outsider);
        vm.expectRevert(Errors.Unauthorized.selector);
        registry.setStatus(needId, INeedsRegistry.NeedStatus.Funded);
    }

    function test_setStatus_enforcesTransitions() public {
        (uint256 needId,, AidVault vault) = _verifiedNeed(1000e6);

        vm.startPrank(address(vault));
        vm.expectRevert(Errors.InvalidTransition.selector);
        registry.setStatus(needId, INeedsRegistry.NeedStatus.Completed);
        vm.expectRevert(Errors.InvalidTransition.selector);
        registry.setStatus(needId, INeedsRegistry.NeedStatus.Cancelled);

        registry.setStatus(needId, INeedsRegistry.NeedStatus.Funded);
        registry.setStatus(needId, INeedsRegistry.NeedStatus.InDelivery);
        registry.setStatus(needId, INeedsRegistry.NeedStatus.Completed);
        vm.expectRevert(Errors.InvalidTransition.selector);
        registry.setStatus(needId, INeedsRegistry.NeedStatus.Completed);
        vm.stopPrank();

        assertEq(registry.statusOf(needId), INeedsRegistry.NeedStatus.Completed);
    }

    /// @dev The DeliveryManager never calls setStatus, and holding that authority would let it walk a Funded
    ///      need to Completed without releasing tranche 0 — locking the escrow with no refund path.
    function test_setStatus_rejectsTheDeliveryManager() public {
        (uint256 needId,,) = _verifiedNeed(1000e6);
        vm.prank(address(deliveryManager));
        vm.expectRevert(Errors.Unauthorized.selector);
        registry.setStatus(needId, INeedsRegistry.NeedStatus.Funded);
        assertEq(registry.statusOf(needId), INeedsRegistry.NeedStatus.Funding);
    }

    // ─── cancellation ──────────────────────────────────────────────────────────

    function test_cancelNeed_byNgoWhilePending() public {
        uint256 needId = _createNeed(ngo, programId, 5000e6, 1);
        vm.prank(ngo);
        registry.cancelNeed(needId);
        assertEq(registry.statusOf(needId), INeedsRegistry.NeedStatus.Cancelled);
    }

    function test_cancelNeed_byNgoWhileFunding() public {
        (uint256 needId,,) = _verifiedNeed(5000e6);
        vm.prank(ngo);
        registry.cancelNeed(needId);
        assertEq(registry.statusOf(needId), INeedsRegistry.NeedStatus.Cancelled);
    }

    function test_cancelNeed_ngoCannotCancelAfterFunded() public {
        (uint256 needId,, AidVault vault) = _verifiedNeed(1000e6);
        _donate(donor1, needId, 1000e6); // reaching the target closes funding
        assertEq(registry.statusOf(needId), INeedsRegistry.NeedStatus.Funded);
        assertTrue(vault.fundingClosed());

        vm.prank(ngo);
        vm.expectRevert(Errors.InvalidNeedStatus.selector);
        registry.cancelNeed(needId);

        // the admin still can, e.g. as the outcome of a dispute
        vm.prank(admin);
        registry.cancelNeed(needId);
        assertEq(registry.statusOf(needId), INeedsRegistry.NeedStatus.Cancelled);
    }

    function test_cancelNeed_revertsForOutsiderAndTerminalStates() public {
        uint256 needId = _createNeed(ngo, programId, 5000e6, 1);
        vm.prank(outsider);
        vm.expectRevert(Errors.Unauthorized.selector);
        registry.cancelNeed(needId);

        vm.prank(ngo);
        registry.cancelNeed(needId);
        vm.prank(admin);
        vm.expectRevert(Errors.InvalidNeedStatus.selector);
        registry.cancelNeed(needId);
    }

    function test_cancelNeed_worksWhilePaused() public {
        uint256 needId = _createNeed(ngo, programId, 5000e6, 1);
        vm.prank(admin);
        roles.pause();
        vm.prank(ngo);
        registry.cancelNeed(needId);
        assertEq(registry.statusOf(needId), INeedsRegistry.NeedStatus.Cancelled);
    }

    // ─── views ─────────────────────────────────────────────────────────────────

    function test_views_revertForUnknownNeed() public {
        vm.expectRevert(Errors.NeedNotFound.selector);
        registry.getNeed(1);
        vm.expectRevert(Errors.NeedNotFound.selector);
        registry.statusOf(0);
        vm.expectRevert(Errors.NeedNotFound.selector);
        registry.ngoOf(42);
        vm.expectRevert(Errors.NeedNotFound.selector);
        registry.vaultOf(42);
        vm.expectRevert(Errors.NeedNotFound.selector);
        registry.programOf(42);
        vm.expectRevert(Errors.NeedNotFound.selector);
        registry.targetAmountOf(42);
        vm.expectRevert(Errors.NeedNotFound.selector);
        registry.dossierHashOf(42);
        vm.expectRevert(Errors.NeedNotFound.selector);
        registry.regionCodeOf(42);
        vm.expectRevert(Errors.NeedNotFound.selector);
        registry.trancheBpsOf(42);
    }

    function test_constants() public view {
        assertEq(registry.HIGH_VALUE_THRESHOLD(), HIGH_VALUE_THRESHOLD);
        assertEq(registry.BPS_DENOMINATOR(), 10_000);
        assertEq(registry.MAX_TRANCHES(), 5);
        assertEq(address(registry.roles()), address(roles));
    }
}
