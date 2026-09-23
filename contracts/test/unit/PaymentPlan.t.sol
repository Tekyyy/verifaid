// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AidVault} from "../../src/funds/AidVault.sol";
import {IAidVault} from "../../src/interfaces/IAidVault.sol";
import {INeedsRegistry} from "../../src/interfaces/INeedsRegistry.sol";
import {IRoleRegistry} from "../../src/interfaces/IRoleRegistry.sol";
import {Errors} from "../../src/libraries/Errors.sol";
import {BlocklistEURC} from "../utils/BlocklistEURC.sol";
import {PoATest} from "../utils/PoATest.sol";

/// @notice The payment plan: an on-chain need names the registered suppliers its vault pays and each one's share
///         of every tranche; the NGO receives only its disclosed share (at most 25% of the need), and replacing a
///         supplier takes the same independent verification the need itself took.
contract PaymentPlanTest is PoATest {
    uint256 internal constant TARGET = 10_000e6;
    address internal supplierC = makeAddr("supplierC");
    uint256 internal programId;

    function setUp() public override {
        super.setUp();
        vm.prank(admin);
        roles.registerSupplier(supplierC, keccak256("supplierC-registration"), "ipfs://supplierC");
        programId = _createProgram(ngo, 10);
    }

    // ─── helpers ───────────────────────────────────────────────────────────────

    function _shares(uint16 a, uint16 b, uint16 c) internal pure returns (uint16[] memory s) {
        s = new uint16[](3);
        (s[0], s[1], s[2]) = (a, b, c);
    }

    /// @dev Food from supplier A, transport from supplier B, and 10% of the pre-financing for the NGO itself.
    function _splitPlan() internal view returns (INeedsRegistry.Payee[] memory plan) {
        plan = new INeedsRegistry.Payee[](3);
        plan[0] = _payee(supplierA, _shares(7000, 6000, 10_000));
        plan[1] = _payee(supplierB, _shares(2000, 4000, 0));
        plan[2] = _payee(address(0), _shares(1000, 0, 0));
    }

    function _params(INeedsRegistry.Payee[] memory plan)
        internal
        view
        returns (INeedsRegistry.CreateNeedParams memory p)
    {
        p = _needParams(programId, TARGET, 1, _threeTrancheBps());
        p.payees = plan;
    }

    function _expectCreateRevert(INeedsRegistry.CreateNeedParams memory p, bytes4 selector) internal {
        vm.prank(ngo);
        vm.expectRevert(selector);
        registry.createNeed(p);
    }

    function _fundedNeed(INeedsRegistry.Payee[] memory plan) internal returns (uint256 needId, AidVault vault) {
        needId = _verifiedNeedWith(_params(plan));
        vault = AidVault(registry.vaultOf(needId));
        _donate(donor1, needId, TARGET);
    }

    // ─── the plan's rules ──────────────────────────────────────────────────────

    function test_plan_isStoredAndReadable() public {
        uint256 needId = _verifiedNeedWith(_params(_splitPlan()));
        INeedsRegistry.PayeeShare[] memory plan = registry.payeesOf(needId);
        assertEq(plan.length, 3);
        assertEq(plan[0].account, supplierA);
        assertEq(plan[1].shareBps[1], 4000);
        assertEq(plan[2].account, address(0), "the NGO's own share");
        assertEq(plan[2].shareBps[0], 1000);

        (address[] memory accounts, uint16[] memory shares) = registry.trancheSplitOf(needId, 2);
        assertEq(accounts.length, 1, "zero shares are left out");
        assertEq(accounts[0], supplierA);
        assertEq(shares[0], 10_000);
        (accounts,) = registry.trancheSplitOf(needId, 0);
        assertEq(accounts[2], ngoPayout, "the NGO's share resolves to its payout Safe");
    }

    function test_plan_isRequired() public {
        _expectCreateRevert(_params(new INeedsRegistry.Payee[](0)), Errors.InvalidPaymentPlan.selector);
    }

    function test_plan_sharesMustCoverEveryTrancheExactly() public {
        INeedsRegistry.Payee[] memory plan = _splitPlan();
        plan[1].shareBps = _shares(2000, 3999, 0); // tranche 1 sums to 9,999
        _expectCreateRevert(_params(plan), Errors.InvalidPaymentPlan.selector);

        plan = _splitPlan();
        plan[0].shareBps = new uint16[](2); // not one share per tranche
        _expectCreateRevert(_params(plan), Errors.InvalidPaymentPlan.selector);

        plan = new INeedsRegistry.Payee[](2);
        plan[0] = _payee(supplierA, _shares(10_000, 10_000, 10_000));
        plan[1] = _payee(supplierB, _shares(0, 0, 0)); // listed but never paid
        _expectCreateRevert(_params(plan), Errors.InvalidPaymentPlan.selector);
    }

    function test_plan_onlyRegisteredDistinctSuppliers() public {
        INeedsRegistry.Payee[] memory plan = _splitPlan();
        plan[1].account = makeAddr("unvetted");
        _expectCreateRevert(_params(plan), Errors.SupplierNotRegistered.selector);

        plan = _splitPlan();
        plan[0].account = ngoPayout; // the NGO's own treasury cannot pose as a supplier
        _expectCreateRevert(_params(plan), Errors.SupplierNotRegistered.selector);

        plan = _splitPlan();
        plan[1].account = supplierA;
        _expectCreateRevert(_params(plan), Errors.InvalidPaymentPlan.selector);

        plan = _splitPlan();
        plan[1].account = address(0); // the NGO listed twice
        _expectCreateRevert(_params(plan), Errors.InvalidPaymentPlan.selector);

        plan = new INeedsRegistry.Payee[](6);
        _expectCreateRevert(_params(plan), Errors.InvalidPaymentPlan.selector);
    }

    function test_plan_ngoShareIsCappedAtAQuarterOfTheNeed() public {
        INeedsRegistry.Payee[] memory plan = new INeedsRegistry.Payee[](2);
        plan[0] = _payee(supplierA, _shares(7500, 7500, 7500));
        plan[1] = _payee(address(0), _shares(2500, 2500, 2500));
        vm.prank(ngo);
        registry.createNeed(_params(plan)); // exactly 25%

        plan[0].shareBps = _shares(7499, 7499, 7499);
        plan[1].shareBps = _shares(2501, 2501, 2501);
        _expectCreateRevert(_params(plan), Errors.NgoShareTooHigh.selector);

        // all of the 30% pre-financing is still more than a quarter of the need
        plan[0].shareBps = _shares(0, 10_000, 10_000);
        plan[1].shareBps = _shares(10_000, 0, 0);
        _expectCreateRevert(_params(plan), Errors.NgoShareTooHigh.selector);
    }

    // ─── paying the plan ───────────────────────────────────────────────────────

    function test_release_paysEveryPayeeDirectly() public {
        (uint256 needId, AidVault vault) = _fundedNeed(_splitPlan());

        vm.expectEmit(true, true, true, true, address(vault));
        emit IAidVault.PayeePaid(needId, 0, supplierA, 2100e6);
        vault.releaseTranche(0);
        assertEq(token.balanceOf(supplierA), 2100e6);
        assertEq(token.balanceOf(supplierB), 600e6);
        assertEq(token.balanceOf(ngoPayout), 300e6, "only the NGO's disclosed share");

        _runDelivery(needId, 1);
        vault.releaseTranche(1);
        _runDelivery(needId, 2);
        vault.releaseTranche(2);

        assertEq(token.balanceOf(supplierA), 2100e6 + 2400e6 + 3000e6);
        assertEq(token.balanceOf(supplierB), 600e6 + 1600e6);
        assertEq(token.balanceOf(ngoPayout), 300e6);
        assertEq(token.balanceOf(address(vault)), 0);
        assertEq(registry.statusOf(needId), INeedsRegistry.NeedStatus.Completed);
        assertVaultInvariant(vault);
    }

    function test_release_roundingDustGoesToTheLastPayee() public {
        INeedsRegistry.CreateNeedParams memory p = _needParams(programId, 100, 1, _singleTrancheBps());
        p.payees = new INeedsRegistry.Payee[](3);
        uint16[] memory third = new uint16[](1);
        third[0] = 3333;
        p.payees[0] = _payee(supplierA, third);
        p.payees[1] = _payee(supplierB, third);
        uint16[] memory rest = new uint16[](1);
        rest[0] = 3334;
        p.payees[2] = _payee(supplierC, rest);
        uint256 needId = _verifiedNeedWith(p);
        AidVault vault = AidVault(registry.vaultOf(needId));
        _donate(donor1, needId, 100);

        vault.releaseTranche(0);
        assertEq(token.balanceOf(supplierA), 33);
        assertEq(token.balanceOf(supplierB), 33);
        assertEq(token.balanceOf(supplierC), 34, "33.34 rounded, plus the dust");
        assertEq(token.balanceOf(address(vault)), 0);
    }

    function test_refund_returnsOnlyWhatWasNeverPaid() public {
        (uint256 needId, AidVault vault) = _fundedNeed(_splitPlan());
        vault.releaseTranche(0);

        vm.prank(admin);
        registry.cancelNeed(needId);
        vm.prank(donor1);
        assertEq(vault.claimRefund(), 7000e6, "the suppliers keep the 30% they were paid");
        assertVaultInvariant(vault);
    }

    // ─── suppliers that lose their registration ────────────────────────────────

    function test_release_waitsForAReplacementWhenASupplierIsRemoved() public {
        (uint256 needId,, AidVault vault) = _needInDelivery(TARGET); // default plan: supplier A takes everything
        assertEq(token.balanceOf(supplierA), 3000e6);
        _runDelivery(needId, 1);

        vm.prank(admin);
        roles.removeSupplier(supplierA);
        vm.expectRevert(Errors.SupplierInactive.selector);
        vault.releaseTranche(1);

        vm.prank(ngo);
        uint256 changeId = registry.proposePayeeChange(needId, 0, supplierB, keccak256("new quote"), "B");
        vm.prank(verifier1);
        registry.approvePayeeChange(needId, changeId);
        vm.expectEmit(true, true, false, true, address(registry));
        emit INeedsRegistry.PayeeChanged(needId, changeId, 0, supplierA, supplierB);
        vm.prank(verifier2);
        registry.approvePayeeChange(needId, changeId);

        vault.releaseTranche(1);
        assertEq(token.balanceOf(supplierB), 4000e6, "the replacement is paid from the next tranche on");
        assertEq(token.balanceOf(supplierA), 3000e6, "what was already paid stays paid");
    }

    // ─── replacing a supplier ──────────────────────────────────────────────────

    function test_change_onlyTheNgoProposesAndOnlyToARegisteredSupplier() public {
        uint256 needId = _verifiedNeedWith(_params(_splitPlan()));

        vm.prank(outsider);
        vm.expectRevert(Errors.Unauthorized.selector);
        registry.proposePayeeChange(needId, 0, supplierC, 0, "");

        vm.startPrank(ngo);
        vm.expectRevert(Errors.InvalidParameter.selector);
        registry.proposePayeeChange(needId, 2, supplierC, 0, ""); // the NGO's own share cannot move
        vm.expectRevert(Errors.InvalidParameter.selector);
        registry.proposePayeeChange(needId, 3, supplierC, 0, "");
        vm.expectRevert(Errors.SupplierNotRegistered.selector);
        registry.proposePayeeChange(needId, 0, makeAddr("unvetted"), 0, "");
        vm.expectRevert(Errors.InvalidPaymentPlan.selector);
        registry.proposePayeeChange(needId, 0, supplierB, 0, ""); // already in the plan

        uint256 changeId = registry.proposePayeeChange(needId, 0, supplierC, keccak256("q"), "C");
        vm.expectRevert(Errors.ChangePending.selector);
        registry.proposePayeeChange(needId, 1, supplierC, 0, "");
        vm.stopPrank();

        INeedsRegistry.PayeeChange memory pending = registry.pendingPayeeChangeOf(needId);
        assertEq(pending.id, changeId);
        assertEq(pending.account, supplierC);
    }

    function test_change_needsIndependentApprovals() public {
        uint256 needId = _verifiedNeedWith(_params(_splitPlan()));
        vm.prank(ngo);
        uint256 changeId = registry.proposePayeeChange(needId, 1, supplierC, 0, "C");

        vm.prank(outsider);
        vm.expectRevert(Errors.NotIndependent.selector);
        registry.approvePayeeChange(needId, changeId);
        vm.prank(ngo);
        vm.expectRevert(Errors.NotIndependent.selector);
        registry.approvePayeeChange(needId, changeId);
        vm.prank(verifier1);
        vm.expectRevert(Errors.NoPendingChange.selector);
        registry.approvePayeeChange(needId, changeId + 1);

        vm.prank(verifier1);
        registry.approvePayeeChange(needId, changeId);
        assertEq(registry.payeesOf(needId)[1].account, supplierB, "one approval is never enough to move money");
        vm.prank(verifier2);
        registry.approvePayeeChange(needId, changeId);
        assertEq(registry.payeesOf(needId)[1].account, supplierC);
        assertEq(registry.pendingPayeeChangeOf(needId).id, 0);
    }

    function test_change_highValueNeedsTakeTwoApprovals() public {
        INeedsRegistry.CreateNeedParams memory p =
            _needParams(programId, HIGH_VALUE_THRESHOLD + 1, 2, _threeTrancheBps());
        vm.prank(ngo);
        uint256 needId = registry.createNeed(p);
        vm.prank(ngo);
        uint256 changeId = registry.proposePayeeChange(needId, 0, supplierB, 0, "B");

        vm.prank(verifier1);
        registry.approvePayeeChange(needId, changeId);
        assertEq(registry.payeesOf(needId)[0].account, supplierA, "one of two approvals changes nothing");
        vm.prank(verifier1);
        vm.expectRevert(Errors.AlreadyApproved.selector);
        registry.approvePayeeChange(needId, changeId);

        vm.prank(verifier2);
        registry.approvePayeeChange(needId, changeId);
        assertEq(registry.payeesOf(needId)[0].account, supplierB);
    }

    function test_change_replacementMustStillBeRegisteredWhenApproved() public {
        uint256 needId = _verifiedNeedWith(_params(_splitPlan()));
        vm.prank(ngo);
        uint256 changeId = registry.proposePayeeChange(needId, 1, supplierC, 0, "C");
        vm.prank(verifier1);
        registry.approvePayeeChange(needId, changeId);

        // The check is at the approval that decides it, not only at the one that proposed it.
        vm.prank(admin);
        roles.removeSupplier(supplierC);
        vm.prank(verifier2);
        vm.expectRevert(Errors.SupplierNotRegistered.selector);
        registry.approvePayeeChange(needId, changeId);
    }

    function test_change_canBeCancelledAndApprovalsDoNotCarryOver() public {
        uint256 needId = _verifiedNeedWith(_params(_splitPlan()));
        vm.prank(ngo);
        uint256 first = registry.proposePayeeChange(needId, 1, supplierC, 0, "C");

        vm.prank(outsider);
        vm.expectRevert(Errors.Unauthorized.selector);
        registry.cancelPayeeChange(needId, first);
        vm.prank(ngo);
        registry.cancelPayeeChange(needId, first);
        vm.prank(ngo);
        vm.expectRevert(Errors.NoPendingChange.selector);
        registry.cancelPayeeChange(needId, first);

        vm.prank(ngo);
        uint256 second = registry.proposePayeeChange(needId, 1, supplierC, 0, "C");
        assertEq(second, first + 1);
        vm.prank(verifier1);
        vm.expectRevert(Errors.NoPendingChange.selector);
        registry.approvePayeeChange(needId, first);
    }

    function test_change_notOnceTheNeedHasEnded() public {
        uint256 needId = _verifiedNeedWith(_params(_splitPlan()));
        vm.prank(ngo);
        uint256 changeId = registry.proposePayeeChange(needId, 1, supplierC, 0, "C");
        vm.prank(admin);
        registry.cancelNeed(needId);

        vm.prank(verifier1);
        vm.expectRevert(Errors.InvalidNeedStatus.selector);
        registry.approvePayeeChange(needId, changeId);
        vm.prank(ngo);
        vm.expectRevert(Errors.InvalidNeedStatus.selector);
        registry.proposePayeeChange(needId, 0, supplierC, 0, "C");
    }

    // ─── the supplier registry ─────────────────────────────────────────────────

    function test_suppliers_areRegisteredByTheAdminAndHoldNoOtherRole() public {
        address supplier = makeAddr("newSupplier");
        vm.prank(outsider);
        vm.expectRevert();
        roles.registerSupplier(supplier, keccak256("c"), "");

        vm.startPrank(admin);
        vm.expectRevert(Errors.ZeroAddress.selector);
        roles.registerSupplier(address(0), keccak256("c"), "");
        vm.expectRevert(Errors.InvalidParameter.selector);
        roles.registerSupplier(supplier, bytes32(0), "");
        vm.expectRevert(Errors.RoleConflict.selector);
        roles.registerSupplier(ngoPayout, keccak256("c"), ""); // an NGO's treasury
        vm.expectRevert(Errors.RoleConflict.selector);
        roles.registerSupplier(verifier1, keccak256("c"), "");

        vm.expectEmit(true, false, false, true, address(roles));
        emit IRoleRegistry.SupplierRegistered(supplier, keccak256("c"), "ipfs://s");
        roles.registerSupplier(supplier, keccak256("c"), "ipfs://s");
        assertTrue(roles.isActiveSupplier(supplier));
        vm.expectRevert(Errors.AlreadyRegistered.selector);
        roles.registerSupplier(supplier, keccak256("c"), "");
        vm.expectRevert(Errors.RoleConflict.selector);
        roles.registerVerifier(supplier);
        vm.expectRevert(Errors.RoleConflict.selector);
        roles.registerNgo(makeAddr("anotherNgo"), supplier, keccak256("c"), ""); // nor an NGO's payout

        roles.removeSupplier(supplier);
        assertFalse(roles.isActiveSupplier(supplier));
        vm.expectRevert(Errors.InvalidParameter.selector);
        roles.removeSupplier(supplier);
        vm.stopPrank();
    }
}

/// @notice A payee the token refuses (Circle can freeze an address) must not block everyone else's payment.
contract HeldPaymentTest is PoATest {
    BlocklistEURC internal blocklist;

    function _beforeDeploy() internal override {
        blocklist = new BlocklistEURC();
    }

    function _tokenAddress() internal view override returns (address) {
        return address(blocklist);
    }

    function test_aFrozenPayeeIsHeldAndClaimsLater() public {
        uint256 programId = _createProgram(ngo, 10);
        INeedsRegistry.CreateNeedParams memory p = _needParams(programId, 1000e6, 1, _threeTrancheBps());
        p.payees = new INeedsRegistry.Payee[](2);
        p.payees[0] = _payee(supplierA, _uniformShares(3, 5000));
        p.payees[1] = _payee(supplierB, _uniformShares(3, 5000));
        uint256 needId = _verifiedNeedWith(p);
        AidVault vault = AidVault(registry.vaultOf(needId));
        _donate(donor1, needId, 1000e6);

        blocklist.setBlocked(supplierB, true);
        vm.expectEmit(true, true, true, true, address(vault));
        emit IAidVault.PaymentHeld(needId, 0, supplierB, 150e6);
        vault.releaseTranche(0);
        assertEq(token.balanceOf(supplierA), 150e6, "the other supplier is paid");
        assertEq(vault.heldPaymentOf(supplierB), 150e6);
        assertEq(vault.totalHeld(), 150e6);
        assertVaultInvariant(vault);

        vm.expectRevert("blocked");
        vault.claimHeldPayment(supplierB);
        vm.expectRevert(Errors.NothingToClaim.selector);
        vault.claimHeldPayment(supplierA);

        // Held money was released: a refund after cancellation does not give it to donors.
        vm.prank(admin);
        registry.cancelNeed(needId);
        vm.prank(donor1);
        assertEq(vault.claimRefund(), 700e6);

        blocklist.setBlocked(supplierB, false);
        vm.prank(outsider); // anyone can deliver it; it only ever goes to the payee
        assertEq(vault.claimHeldPayment(supplierB), 150e6);
        assertEq(token.balanceOf(supplierB), 150e6);
        assertEq(vault.totalHeld(), 0);
        assertVaultInvariant(vault);
    }
}
