// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AidVault} from "../../src/funds/AidVault.sol";
import {INeedsRegistry} from "../../src/interfaces/INeedsRegistry.sol";
import {ITrancheLedger} from "../../src/interfaces/ITrancheLedger.sol";
import {Errors} from "../../src/libraries/Errors.sol";
import {PoATest} from "../utils/PoATest.sol";

/// @notice The v2 NeedClaim terms: funding and execution deadlines, the minimum funding threshold (partial
///         execution), third-party cost disclosure, and the permissionless `expire`.
contract NeedTermsTest is PoATest {
    uint256 internal constant TARGET = 10_000e6;
    uint64 internal constant FUNDING_WINDOW = 30 days;
    uint64 internal constant EXECUTION_WINDOW = 120 days;

    uint256 internal programId;

    function setUp() public override {
        super.setUp();
        programId = _createProgram(ngo, 10);
    }

    function _terms(uint16 minFundingBps) internal view returns (INeedsRegistry.CreateNeedParams memory p) {
        p = _needParams(programId, TARGET, 1, _threeTrancheBps());
        p.fundingDeadline = uint64(block.timestamp) + FUNDING_WINDOW;
        p.executionDeadline = uint64(block.timestamp) + EXECUTION_WINDOW;
        p.minFundingBps = minFundingBps;
    }

    function _create(INeedsRegistry.CreateNeedParams memory p) internal returns (uint256 needId) {
        vm.prank(ngo);
        needId = registry.createNeed(p);
    }

    function _expectCreateRevert(INeedsRegistry.CreateNeedParams memory p, bytes4 selector) internal {
        vm.prank(ngo);
        vm.expectRevert(selector);
        registry.createNeed(p);
    }

    // ─── creation ──────────────────────────────────────────────────────────────

    function test_createNeed_storesTheTerms() public {
        INeedsRegistry.CreateNeedParams memory p = _terms(6000);
        _asOffChain(p, bankPartner);
        p.thirdPartyCostBps = 150;
        p.costDisclosureHash = COST_DISCLOSURE_HASH;

        vm.expectEmit(true, true, true, true, address(registry));
        emit INeedsRegistry.NeedCreated(1, ngo, programId, p);
        uint256 needId = _create(p);

        INeedsRegistry.Need memory n = registry.getNeed(needId);
        assertEq(uint8(n.custodyMode), uint8(INeedsRegistry.CustodyMode.OffChain));
        assertEq(n.fundingDeadline, p.fundingDeadline);
        assertEq(n.executionDeadline, p.executionDeadline);
        assertEq(n.minFundingBps, 6000);
        assertEq(n.thirdPartyCostBps, 150);
    }

    function test_createNeed_packsFiveTranches() public {
        INeedsRegistry.CreateNeedParams memory p = _terms(10_000);
        uint16[] memory bps = new uint16[](5);
        (bps[0], bps[1], bps[2], bps[3], bps[4]) = (1, 9996, 1, 1, 1);
        p.trancheBps = bps;
        p.payees = _singlePayee(supplierA, 5);
        uint256 needId = _create(p);

        uint16[] memory stored = registry.trancheBpsOf(needId);
        assertEq(stored.length, 5);
        for (uint256 i; i < 5; ++i) {
            assertEq(stored[i], bps[i]);
        }
    }

    function test_createNeed_validatesTerms() public {
        INeedsRegistry.CreateNeedParams memory p = _terms(6000);
        p.expectedOutcomeHash = bytes32(0);
        _expectCreateRevert(p, Errors.InvalidParameter.selector);

        p = _terms(0);
        _expectCreateRevert(p, Errors.InvalidParameter.selector);
        p = _terms(10_001);
        _expectCreateRevert(p, Errors.InvalidParameter.selector);

        // costs above the hard cap
        p = _terms(6000);
        p.thirdPartyCostBps = registry.MAX_THIRD_PARTY_COST_BPS() + 1;
        p.costDisclosureHash = COST_DISCLOSURE_HASH;
        _expectCreateRevert(p, Errors.InvalidParameter.selector);

        // costs without a disclosure, and a disclosure without costs
        p = _terms(6000);
        p.thirdPartyCostBps = 100;
        _expectCreateRevert(p, Errors.InvalidParameter.selector);
        p = _terms(6000);
        p.costDisclosureHash = COST_DISCLOSURE_HASH;
        _expectCreateRevert(p, Errors.InvalidParameter.selector);

        // deadlines in the past, or delivery due before funding ends
        p = _terms(6000);
        p.fundingDeadline = uint64(block.timestamp);
        _expectCreateRevert(p, Errors.InvalidParameter.selector);
        p = _terms(6000);
        p.executionDeadline = p.fundingDeadline;
        _expectCreateRevert(p, Errors.InvalidParameter.selector);

        // bounds of the packed layout
        p = _terms(6000);
        p.fundingDeadline = uint64(type(uint40).max) + 1;
        p.executionDeadline = 0;
        _expectCreateRevert(p, Errors.InvalidParameter.selector);
    }

    function test_createNeed_rejectsTargetsBeyondThePackedWidth() public {
        INeedsRegistry.CreateNeedParams memory p = _terms(6000);
        p.targetAmount = uint256(type(uint96).max) + 1;
        p.verificationsRequired = 2;
        _expectCreateRevert(p, Errors.InvalidParameter.selector);
    }

    // ─── funding deadline ──────────────────────────────────────────────────────

    function test_verificationAfterTheFundingDeadlineIsRejected() public {
        uint256 needId = _create(_terms(6000));
        vm.warp(block.timestamp + FUNDING_WINDOW);
        vm.expectRevert(Errors.DeadlinePassed.selector);
        this.attestNeedVerifiedExternal(needId);
    }

    /// @dev External wrapper so `expectRevert` applies to the whole EAS call chain.
    function attestNeedVerifiedExternal(uint256 needId) external {
        _attestNeedVerified(verifier1, needId, true);
    }

    function test_expire_pendingNeedAfterItsDeadline() public {
        uint256 needId = _create(_terms(6000));

        vm.expectRevert(Errors.DeadlineNotReached.selector);
        registry.expire(needId);

        vm.warp(block.timestamp + FUNDING_WINDOW);
        vm.expectEmit(true, false, false, true, address(registry));
        emit INeedsRegistry.NeedExpired(needId, INeedsRegistry.NeedStatus.Pending, 0);
        vm.prank(outsider); // permissionless
        registry.expire(needId);
        assertEq(registry.statusOf(needId), INeedsRegistry.NeedStatus.Expired);

        // terminal: neither cancellable nor expirable again
        vm.prank(admin);
        vm.expectRevert(Errors.InvalidNeedStatus.selector);
        registry.cancelNeed(needId);
        vm.expectRevert(Errors.InvalidNeedStatus.selector);
        registry.expire(needId);
    }

    function test_expire_needsADeadline() public {
        uint256 needId = _createNeed(ngo, programId, TARGET, 1);
        vm.expectRevert(Errors.DeadlineNotReached.selector);
        registry.expire(needId);
    }

    /// @dev Money escrowed on-chain always has a horizon, so `expire` can always give it back eventually.
    function test_createNeed_onChainCustodyMustNameADeliveryHorizon() public {
        INeedsRegistry.CreateNeedParams memory p = _needParams(programId, TARGET, 1, _threeTrancheBps());
        p.executionDeadline = 0;
        vm.prank(ngo);
        vm.expectRevert(Errors.InvalidParameter.selector);
        registry.createNeed(p);

        // Off-chain money is held by a named custodian, not by this system, so it may stay open-ended.
        _asOffChain(p, bankPartner);
        vm.prank(ngo);
        registry.createNeed(p);
    }

    function test_donationsStopAtTheFundingDeadline() public {
        uint256 needId = _verifiedNeedWith(_terms(6000));
        AidVault vault = AidVault(registry.vaultOf(needId));
        _donate(donor1, needId, 1000e6);

        vm.warp(block.timestamp + FUNDING_WINDOW);
        _fundDonor(donor2, needId, 1000e6);
        vm.prank(donor2);
        vm.expectRevert(Errors.FundingNotOpen.selector);
        vault.donate(1000e6);

        // and the NGO can no longer close early: the deadline rules apply now
        vm.prank(ngo);
        vm.expectRevert(Errors.FundingNotOpen.selector);
        vault.closeFunding();
    }

    function test_expire_belowTheThresholdOpensRefunds() public {
        uint256 needId = _verifiedNeedWith(_terms(6000));
        AidVault vault = AidVault(registry.vaultOf(needId));
        _donate(donor1, needId, 3000e6);
        _donate(donor2, needId, 2000e6); // 50% < 60%

        vm.warp(block.timestamp + FUNDING_WINDOW);
        vm.expectEmit(true, false, false, true, address(registry));
        emit INeedsRegistry.NeedExpired(needId, INeedsRegistry.NeedStatus.Funding, 5000e6);
        registry.expire(needId);
        assertEq(registry.statusOf(needId), INeedsRegistry.NeedStatus.Expired);
        assertEq(vault.refundableAmount(donor1), 3000e6);

        vm.prank(donor1);
        assertEq(vault.claimRefund(), 3000e6);
        vm.prank(donor2);
        assertEq(vault.claimRefund(), 2000e6);
        assertEq(token.balanceOf(address(vault)), 0);
        assertVaultInvariant(vault);
    }

    function test_expire_withNothingRaisedExpires() public {
        uint256 needId = _verifiedNeedWith(_terms(1));
        vm.warp(block.timestamp + FUNDING_WINDOW);
        registry.expire(needId);
        assertEq(registry.statusOf(needId), INeedsRegistry.NeedStatus.Expired);
    }

    function test_expire_atOrAboveTheThresholdExecutesPartially() public {
        uint256 needId = _verifiedNeedWith(_terms(6000));
        AidVault vault = AidVault(registry.vaultOf(needId));
        _donate(donor1, needId, 6000e6); // exactly 60%

        vm.warp(block.timestamp + FUNDING_WINDOW);
        vm.expectEmit(true, false, false, true, address(registry));
        emit INeedsRegistry.PartialFundingAccepted(needId, 6000e6, TARGET);
        registry.expire(needId);

        assertEq(registry.statusOf(needId), INeedsRegistry.NeedStatus.Funded);
        assertTrue(vault.fundingClosed());
        // every tranche scales down to what was actually raised
        ITrancheLedger.Tranche[] memory tranches = vault.getTranches();
        assertEq(tranches[0].amount, 1800e6);
        assertEq(tranches[1].amount, 2400e6);
        assertEq(tranches[2].amount, 1800e6);
        assertEq(tranches[0].status, ITrancheLedger.TrancheStatus.Releasable);

        vault.releaseTranche(0);
        assertEq(token.balanceOf(supplierA), 1800e6);
        assertVaultInvariant(vault);
    }

    function test_allOrNothingNeedExpiresOneUnitShort() public {
        uint256 needId = _verifiedNeedWith(_terms(10_000));
        AidVault vault = AidVault(registry.vaultOf(needId));
        _donate(donor1, needId, TARGET - 1);

        vm.prank(ngo);
        vm.expectRevert(Errors.BelowMinimumFunding.selector);
        vault.closeFunding();

        vm.warp(block.timestamp + FUNDING_WINDOW);
        registry.expire(needId);
        assertEq(registry.statusOf(needId), INeedsRegistry.NeedStatus.Expired);
    }

    function test_closeFunding_requiresTheMinimum() public {
        uint256 needId = _verifiedNeedWith(_terms(6000));
        AidVault vault = AidVault(registry.vaultOf(needId));
        _donate(donor1, needId, 5999e6);

        vm.prank(ngo);
        vm.expectRevert(Errors.BelowMinimumFunding.selector);
        vault.closeFunding();

        _donate(donor1, needId, 1e6);
        vm.prank(ngo);
        vault.closeFunding();
        assertEq(registry.statusOf(needId), INeedsRegistry.NeedStatus.Funded);
    }

    function test_closeFundingAtDeadline_onlyRegistry() public {
        uint256 needId = _verifiedNeedWith(_terms(6000));
        AidVault vault = AidVault(registry.vaultOf(needId));
        vm.prank(ngo);
        vm.expectRevert(Errors.Unauthorized.selector);
        vault.closeFundingAtDeadline();
    }

    function test_expire_isPausable() public {
        uint256 needId = _create(_terms(6000));
        vm.warp(block.timestamp + FUNDING_WINDOW);
        vm.prank(admin);
        roles.pause();
        vm.expectRevert(Errors.SystemPaused.selector);
        registry.expire(needId);
    }

    // ─── execution deadline ────────────────────────────────────────────────────

    function _inDelivery() internal returns (uint256 needId, AidVault vault) {
        needId = _verifiedNeedWith(_terms(6000));
        vault = AidVault(registry.vaultOf(needId));
        _donate(donor1, needId, 6000e6);
        _donate(donor2, needId, 4000e6); // target reached → Funded
        vault.releaseTranche(0); // → InDelivery, 3000 paid out
    }

    function test_expire_afterTheExecutionDeadlineRefundsTheUnreleasedBalance() public {
        (uint256 needId, AidVault vault) = _inDelivery();

        vm.warp(block.timestamp + FUNDING_WINDOW + 1 days);
        vm.expectRevert(Errors.DeadlineNotReached.selector);
        registry.expire(needId);

        vm.warp(block.timestamp + EXECUTION_WINDOW);
        registry.expire(needId);
        assertEq(registry.statusOf(needId), INeedsRegistry.NeedStatus.Expired);

        // 7000 was never released: 60% of it to donor1, 40% to donor2
        vm.prank(donor1);
        assertEq(vault.claimRefund(), 4200e6);
        vm.prank(donor2);
        assertEq(vault.claimRefund(), 2800e6);
        assertVaultInvariant(vault);

        // no more deliveries once expired
        vm.prank(fieldAgent);
        vm.expectRevert(Errors.InvalidNeedStatus.selector);
        deliveryManager.openDelivery(needId, 1, 10);
    }

    function test_expire_waitsForAnEarnedTrancheToBePaid() public {
        (uint256 needId, AidVault vault) = _inDelivery();
        _runDelivery(needId, 1, 10); // tranche 1 becomes releasable

        vm.warp(block.timestamp + EXECUTION_WINDOW);
        vm.expectRevert(Errors.ReleasePending.selector);
        registry.expire(needId);

        vault.releaseTranche(1); // anyone can pay what was earned
        registry.expire(needId);
        assertEq(registry.statusOf(needId), INeedsRegistry.NeedStatus.Expired);
        assertEq(vault.totalReleased(), 7000e6);
        assertVaultInvariant(vault);
    }

    function test_expire_notForCompletedOrCancelledNeeds() public {
        uint256 needId = _create(_terms(6000));
        vm.prank(ngo);
        registry.cancelNeed(needId);
        vm.warp(block.timestamp + FUNDING_WINDOW);
        vm.expectRevert(Errors.InvalidNeedStatus.selector);
        registry.expire(needId);
    }
}
