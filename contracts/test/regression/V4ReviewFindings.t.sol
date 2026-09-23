// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AidVault} from "../../src/funds/AidVault.sol";
import {IAidVault} from "../../src/interfaces/IAidVault.sol";
import {INeedsRegistry} from "../../src/interfaces/INeedsRegistry.sol";
import {Errors} from "../../src/libraries/Errors.sol";
import {BlocklistEURC} from "../utils/BlocklistEURC.sol";
import {PoATest} from "../utils/PoATest.sol";

/// @notice The adversarial review of the v4 payment plans, one test per finding, each asserting the fixed
///         behaviour with the reviewer's own exploit sequence. See docs/DECISIONS.md §15.
contract V4ReviewFindingsTest is PoATest {
    uint256 internal constant TARGET = 10_000e6;
    address internal supplierC = makeAddr("supplierC");
    uint256 internal programId;

    function setUp() public override {
        super.setUp();
        vm.prank(admin);
        roles.registerSupplier(supplierC, keccak256("supplierC-registration"), "ipfs://supplierC");
        programId = _createProgram(ngo);
    }

    function _approve(uint256 needId, uint256 changeId) internal {
        vm.prank(verifier1);
        registry.approvePayeeChange(needId, changeId);
        vm.prank(verifier2);
        registry.approvePayeeChange(needId, changeId);
    }

    /// @notice F-1: a tranche a supplier has already earned cannot be redirected to another supplier.
    /// @dev The reviewer's sequence: supplier A delivers, tranche 1 goes Releasable, and before anyone calls the
    ///      permissionless `releaseTranche` the NGO swaps payee 0 to supplier C and has it approved.
    function test_F1_anEarnedTrancheCannotBeRedirected() public {
        (uint256 needId,, AidVault vault) = _needInDelivery(TARGET); // supplier A takes every tranche
        _runDelivery(needId, 1); // A did the work: tranche 1 is now Releasable

        vm.prank(ngo);
        uint256 changeId = registry.proposePayeeChange(needId, 0, supplierC, 0, "C");
        vm.prank(verifier1);
        registry.approvePayeeChange(needId, changeId);
        vm.prank(verifier2);
        vm.expectRevert(Errors.ReleasePending.selector);
        registry.approvePayeeChange(needId, changeId);

        // Releasing is permissionless, so clearing the way costs anyone one transaction.
        vault.releaseTranche(1);
        assertEq(token.balanceOf(supplierA), 7000e6, "the supplier that delivered was paid");
        vm.prank(verifier2);
        registry.approvePayeeChange(needId, changeId);
        assertEq(registry.payeesOf(needId)[0].account, supplierC, "and only then does the change apply");
        assertEq(token.balanceOf(supplierC), 0);
        assertVaultInvariant(vault);
    }

    /// @notice F-1: a supplier that has lost its role is the exception — replacing it is the way to unblock a need.
    function test_F1_aRemovedSupplierIsStillReplaceableWithATrancheWaiting() public {
        (uint256 needId,, AidVault vault) = _needInDelivery(TARGET);
        _runDelivery(needId, 1);
        vm.prank(admin);
        roles.removeSupplier(supplierA);
        vm.expectRevert(Errors.SupplierInactive.selector);
        vault.releaseTranche(1);

        vm.prank(ngo);
        uint256 changeId = registry.proposePayeeChange(needId, 0, supplierB, 0, "B");
        _approve(needId, changeId);
        vault.releaseTranche(1);
        assertEq(token.balanceOf(supplierB), 4000e6);
        assertVaultInvariant(vault);
    }

    /// @notice D-1: one verifier anywhere in the system can no longer move an escrow on its own.
    function test_D1_aChangeAlwaysTakesTwoIndependentVerifiers() public {
        uint256 needId = _verifiedNeedWith(_planParams());
        assertEq(registry.payeeChangeApprovalsRequired(needId), 2, "even on a need one verifier could verify");

        vm.prank(ngo);
        uint256 changeId = registry.proposePayeeChange(needId, 0, supplierC, 0, "C");
        vm.prank(verifier1);
        registry.approvePayeeChange(needId, changeId);
        assertEq(registry.payeesOf(needId)[0].account, supplierA, "one approval decides nothing");
        vm.prank(verifier1);
        vm.expectRevert(Errors.AlreadyApproved.selector);
        registry.approvePayeeChange(needId, changeId);

        vm.prank(verifier2);
        registry.approvePayeeChange(needId, changeId);
        assertEq(registry.payeesOf(needId)[0].account, supplierC);
    }

    /// @notice F-2: "one address, one role" now holds for the address's whole history.
    /// @dev The reviewer's sequence used an NGO's own field agent, a role that no longer exists (§21); the rule it
    ///      prompted still applies to every role left. A verifier the admin removed — seen as a clean address —
    ///      must not come back as an "independent" supplier of the NGOs it used to check.
    function test_F2_aFormerVerifierCannotComeBackAsASupplier() public {
        address insider = makeAddr("formerVerifier");
        vm.startPrank(admin);
        roles.registerVerifier(insider);
        roles.removeVerifier(insider);
        vm.stopPrank();
        assertFalse(roles.hasRole(roles.VERIFIER_ROLE(), insider), "the live role is gone");
        assertEq(roles.everHeldRole(insider), roles.VERIFIER_ROLE(), "but the registry remembers");

        vm.prank(admin);
        vm.expectRevert(Errors.RoleConflict.selector);
        roles.registerSupplier(insider, keccak256("insider"), "ipfs://insider");

        // The same role may still be re-granted: removing a verifier by mistake is not a life sentence.
        vm.prank(admin);
        roles.registerVerifier(insider);
        assertTrue(roles.hasRole(roles.VERIFIER_ROLE(), insider));
    }

    /// @notice F-2: it holds in every direction — a removed supplier cannot become a verifier either.
    function test_F2_aFormerSupplierCannotBecomeAVerifier() public {
        vm.startPrank(admin);
        roles.removeSupplier(supplierC);
        vm.expectRevert(Errors.RoleConflict.selector);
        roles.registerVerifier(supplierC);
        vm.stopPrank();
    }

    /// @notice F-3: escrowed money always has a horizon, so a frozen plan can never trap it forever.
    /// @dev The reviewer's sequence needed a need with no execution deadline: `releaseTranche` reverted on the
    ///      removed supplier and `expire` reverted `DeadlineNotReached`, with no permissionless way out at all.
    function test_F3_anOnChainNeedCannotBeOpenEnded() public {
        INeedsRegistry.CreateNeedParams memory p = _planParams();
        p.executionDeadline = 0;
        vm.prank(ngo);
        vm.expectRevert(Errors.InvalidParameter.selector);
        registry.createNeed(p);
    }

    /// @notice F-3: with the horizon, a need whose supplier is gone always reaches refunds without an admin.
    function test_F3_aFrozenPlanEndsInRefundsAtTheDeadline() public {
        uint256 needId = _verifiedNeedWith(_planParams());
        AidVault vault = AidVault(registry.vaultOf(needId));
        _donate(donor1, needId, TARGET);
        vault.releaseTranche(0);
        _runDelivery(needId, 1);
        vm.prank(admin);
        roles.removeSupplier(supplierA);
        vm.expectRevert(Errors.SupplierInactive.selector);
        vault.releaseTranche(1);

        vm.warp(block.timestamp + DEFAULT_EXECUTION_WINDOW + registry.EXPIRY_GRACE_PERIOD() + 1);
        registry.expire(needId); // permissionless: no admin, no NGO, no verifier
        assertEq(uint8(registry.statusOf(needId)), uint8(INeedsRegistry.NeedStatus.Expired));
        vm.prank(donor1);
        assertEq(vault.claimRefund(), TARGET - 3000e6, "everything the plan never paid goes back");
        assertVaultInvariant(vault);
    }

    function _planParams() internal view returns (INeedsRegistry.CreateNeedParams memory p) {
        p = _needParams(programId, TARGET, 1, _threeTrancheBps());
    }
}

/// @notice F-4: a payment the token refuses on the final tranche is money the need still owes, so the need is not
///         Completed — Completed is terminal, and reporting it would close every path to that money.
contract V4HeldPaymentTest is PoATest {
    uint256 internal constant TARGET = 1000e6;
    BlocklistEURC internal blocklist;
    uint256 internal needId;
    AidVault internal vault;

    function _beforeDeploy() internal override {
        blocklist = new BlocklistEURC();
    }

    function _tokenAddress() internal view override returns (address) {
        return address(blocklist);
    }

    function setUp() public override {
        super.setUp();
        uint256 programId = _createProgram(ngo);
        INeedsRegistry.CreateNeedParams memory p = _needParams(programId, TARGET, 1, _threeTrancheBps());
        p.payees = new INeedsRegistry.Payee[](2);
        p.payees[0] = _payee(supplierA, _uniformShares(3, 7000));
        p.payees[1] = _payee(supplierB, _uniformShares(3, 3000));
        needId = _verifiedNeedWith(p);
        vault = AidVault(registry.vaultOf(needId));
        _donate(donor1, needId, TARGET);
    }

    /// @dev Releases every tranche with supplier B frozen from the last one on.
    function _releaseAllWithBFrozen() internal {
        vault.releaseTranche(0);
        _runDelivery(needId, 1);
        vault.releaseTranche(1);
        _runDelivery(needId, 2);
        blocklist.setBlocked(supplierB, true);
        vault.releaseTranche(2);
    }

    function test_F4_aNeedThatStillOwesMoneyIsNotCompleted() public {
        _releaseAllWithBFrozen();
        assertEq(vault.totalHeld(), 90e6, "supplier B's share of the final tranche");
        assertEq(
            uint8(registry.statusOf(needId)),
            uint8(INeedsRegistry.NeedStatus.InDelivery),
            "not Completed while it still owes"
        );

        // And it completes by itself the moment the payee can be paid.
        blocklist.setBlocked(supplierB, false);
        vault.claimHeldPayment(supplierB);
        assertEq(uint8(registry.statusOf(needId)), uint8(INeedsRegistry.NeedStatus.Completed));
        assertEq(vault.totalHeld(), 0);
        assertVaultInvariant(vault);
    }

    /// @notice F-4: held money is not stranded either — verifiers can move it to the replacement supplier.
    function test_F4_heldMoneyFollowsAnApprovedReplacement() public {
        _releaseAllWithBFrozen();
        address supplierC = makeAddr("supplierC");
        vm.prank(admin);
        roles.registerSupplier(supplierC, keccak256("supplierC-registration"), "ipfs://supplierC");

        vm.prank(ngo);
        uint256 changeId = registry.proposePayeeChange(needId, 1, supplierC, 0, "C");
        vm.prank(verifier1);
        registry.approvePayeeChange(needId, changeId);
        vm.expectEmit(true, true, true, true, address(vault));
        emit IAidVault.HeldPaymentReassigned(needId, supplierB, supplierC, 90e6);
        vm.prank(verifier2);
        registry.approvePayeeChange(needId, changeId);

        assertEq(vault.heldPaymentOf(supplierB), 0);
        assertEq(vault.heldPaymentOf(supplierC), 90e6);
        vault.claimHeldPayment(supplierC);
        assertEq(blocklist.balanceOf(supplierC), 90e6);
        assertEq(uint8(registry.statusOf(needId)), uint8(INeedsRegistry.NeedStatus.Completed));
        assertVaultInvariant(vault);
    }
}
