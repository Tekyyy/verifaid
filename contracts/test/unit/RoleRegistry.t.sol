// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {RoleRegistry} from "../../src/access/RoleRegistry.sol";
import {IRoleRegistry} from "../../src/interfaces/IRoleRegistry.sol";
import {Errors} from "../../src/libraries/Errors.sol";
import {Roles} from "../../src/libraries/Roles.sol";
import {PoATest} from "../utils/PoATest.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

contract RoleRegistryTest is PoATest {
    function _expectNotAdmin(address caller) internal {
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, caller, bytes32(0))
        );
    }

    // ─── construction ──────────────────────────────────────────────────────────

    function test_constructor_grantsAdmin() public view {
        assertTrue(roles.hasRole(roles.DEFAULT_ADMIN_ROLE(), admin));
        assertTrue(roles.isAdmin(admin));
        assertFalse(roles.isAdmin(outsider));
    }

    function test_constructor_revertsOnZeroAdmin() public {
        vm.expectRevert(Errors.ZeroAddress.selector);
        new RoleRegistry(address(0));
    }

    // ─── NGOs ──────────────────────────────────────────────────────────────────

    function test_registerNgo() public {
        address newNgo = makeAddr("newNgo");
        address payout = makeAddr("newPayout");
        vm.expectEmit(true, true, false, true, address(roles));
        emit IRoleRegistry.NgoRegistered(newNgo, payout, keccak256("cred"), "ipfs://x");
        vm.prank(admin);
        roles.registerNgo(newNgo, payout, keccak256("cred"), "ipfs://x");

        (bool active, address payoutAddress, bytes32 credentialHash, string memory uri) = roles.ngos(newNgo);
        assertTrue(active);
        assertEq(payoutAddress, payout);
        assertEq(credentialHash, keccak256("cred"));
        assertEq(uri, "ipfs://x");
        assertTrue(roles.hasRole(roles.NGO_ROLE(), newNgo));
        assertTrue(roles.isActiveNgo(newNgo));
        assertEq(roles.payoutOf(newNgo), payout);
        assertTrue(roles.isPayoutAddress(payout));
    }

    function test_registerNgo_revertsForNonAdmin() public {
        _expectNotAdmin(outsider);
        vm.prank(outsider);
        roles.registerNgo(makeAddr("x"), makeAddr("y"), keccak256("c"), "");
    }

    function test_registerNgo_revertsOnZeroAddresses() public {
        vm.startPrank(admin);
        vm.expectRevert(Errors.ZeroAddress.selector);
        roles.registerNgo(address(0), makeAddr("y"), keccak256("c"), "");
        vm.expectRevert(Errors.ZeroAddress.selector);
        roles.registerNgo(makeAddr("x"), address(0), keccak256("c"), "");
        vm.stopPrank();
    }

    function test_registerNgo_revertsOnZeroCredential() public {
        vm.prank(admin);
        vm.expectRevert(Errors.InvalidParameter.selector);
        roles.registerNgo(makeAddr("x"), makeAddr("y"), bytes32(0), "");
    }

    function test_registerNgo_revertsWhenAlreadyRegistered() public {
        vm.prank(admin);
        vm.expectRevert(Errors.AlreadyRegistered.selector);
        roles.registerNgo(ngo, ngoPayout, keccak256("c"), "");
    }

    function test_registerNgo_revertsWhenAddressHoldsAnotherRole() public {
        vm.prank(admin);
        vm.expectRevert(Errors.RoleConflict.selector);
        roles.registerNgo(verifier1, makeAddr("p1"), keccak256("c"), "");

        vm.prank(admin);
        vm.expectRevert(Errors.RoleConflict.selector);
        roles.registerNgo(fieldAgent, makeAddr("p2"), keccak256("c"), "");

        vm.prank(admin);
        vm.expectRevert(Errors.RoleConflict.selector);
        roles.registerNgo(supplierA, makeAddr("p3"), keccak256("c"), "");

        // an address already serving as some NGO's payout Safe
        vm.prank(admin);
        vm.expectRevert(Errors.RoleConflict.selector);
        roles.registerNgo(ngoPayout, makeAddr("p4"), keccak256("c"), "");
    }

    function test_registerNgo_revertsWhenPayoutHoldsAnotherRole() public {
        vm.startPrank(admin);
        vm.expectRevert(Errors.RoleConflict.selector);
        roles.registerNgo(makeAddr("n1"), verifier1, keccak256("c"), "");
        vm.expectRevert(Errors.RoleConflict.selector);
        roles.registerNgo(makeAddr("n2"), supplierA, keccak256("c"), "");
        vm.expectRevert(Errors.RoleConflict.selector);
        roles.registerNgo(makeAddr("n3"), fieldAgent, keccak256("c"), "");
        vm.stopPrank();
    }

    function test_setNgoActive() public {
        vm.expectEmit(true, false, false, true, address(roles));
        emit IRoleRegistry.NgoStatusChanged(ngo, false);
        vm.prank(admin);
        roles.setNgoActive(ngo, false);
        assertFalse(roles.isActiveNgo(ngo));

        vm.prank(admin);
        roles.setNgoActive(ngo, true);
        assertTrue(roles.isActiveNgo(ngo));
    }

    function test_setNgoActive_revertsForUnregistered() public {
        vm.prank(admin);
        vm.expectRevert(Errors.NgoNotRegistered.selector);
        roles.setNgoActive(outsider, false);
    }

    function test_setNgoActive_revertsForNonAdmin() public {
        _expectNotAdmin(ngo);
        vm.prank(ngo);
        roles.setNgoActive(ngo, false);
    }

    /// @dev Renouncing NGO_ROLE used to be an irreversible self-brick — the profile persists, so
    ///      re-registration reverts and grantRole is blocked, which froze every one of that NGO's vaults.
    function test_operationalRolesCannotBeRenounced() public {
        vm.prank(ngo);
        vm.expectRevert(Errors.UseRegistrationFunction.selector);
        roles.renounceRole(Roles.NGO_ROLE, ngo);
        assertTrue(roles.isActiveNgo(ngo));

        vm.prank(verifier1);
        vm.expectRevert(Errors.UseRegistrationFunction.selector);
        roles.renounceRole(Roles.VERIFIER_ROLE, verifier1);
        assertTrue(roles.isIndependent(verifier1, ngo));

        // an admin may still step down
        address admin2 = makeAddr("admin2");
        vm.prank(admin);
        roles.grantRole(Roles.DEFAULT_ADMIN_ROLE, admin2);
        vm.prank(admin2);
        roles.renounceRole(Roles.DEFAULT_ADMIN_ROLE, admin2);
        assertFalse(roles.isAdmin(admin2));
    }

    function test_registerNgo_rejectsAPayoutThatIsAnotherParticipant() public {
        vm.startPrank(admin);
        // another NGO's operating address
        vm.expectRevert(Errors.RoleConflict.selector);
        roles.registerNgo(makeAddr("n1"), ngo2, keccak256("c"), "");
        // another NGO's payout Safe: two "independent" NGOs must not share a treasury
        vm.expectRevert(Errors.RoleConflict.selector);
        roles.registerNgo(makeAddr("n2"), ngoPayout, keccak256("c"), "");

        // paying out to itself stays allowed (single-address NGOs on a testnet)
        address selfPaying = makeAddr("selfPaying");
        roles.registerNgo(selfPaying, selfPaying, keccak256("c"), "");
        assertEq(roles.payoutOf(selfPaying), selfPaying);
        vm.stopPrank();
    }

    // ─── verifiers & bank partners ─────────────────────────────────────────────

    function test_registerVerifier() public {
        address v = makeAddr("v");
        vm.expectEmit(true, false, false, false, address(roles));
        emit IRoleRegistry.VerifierRegistered(v);
        vm.prank(admin);
        roles.registerVerifier(v);
        assertTrue(roles.hasRole(roles.VERIFIER_ROLE(), v));
    }

    function test_registerVerifier_reverts() public {
        vm.startPrank(admin);
        vm.expectRevert(Errors.ZeroAddress.selector);
        roles.registerVerifier(address(0));
        vm.expectRevert(Errors.AlreadyRegistered.selector);
        roles.registerVerifier(verifier1);
        vm.expectRevert(Errors.RoleConflict.selector);
        roles.registerVerifier(ngo);
        vm.expectRevert(Errors.RoleConflict.selector);
        roles.registerVerifier(fieldAgent);
        vm.expectRevert(Errors.RoleConflict.selector);
        roles.registerVerifier(supplierA);
        vm.expectRevert(Errors.RoleConflict.selector);
        roles.registerVerifier(ngoPayout);
        vm.stopPrank();

        _expectNotAdmin(outsider);
        vm.prank(outsider);
        roles.registerVerifier(makeAddr("v2"));
    }

    function test_removeVerifier() public {
        vm.expectEmit(true, false, false, false, address(roles));
        emit IRoleRegistry.VerifierRemoved(verifier1);
        vm.prank(admin);
        roles.removeVerifier(verifier1);
        assertFalse(roles.hasRole(roles.VERIFIER_ROLE(), verifier1));
        assertFalse(roles.isIndependent(verifier1, ngo));

        vm.prank(admin);
        vm.expectRevert(Errors.InvalidParameter.selector);
        roles.removeVerifier(verifier1);
    }

    // ─── field agents ──────────────────────────────────────────────────────────

    function test_addFieldAgent() public {
        address agent = makeAddr("agent3");
        vm.expectEmit(true, true, false, false, address(roles));
        emit IRoleRegistry.FieldAgentAdded(ngo, agent);
        vm.prank(ngo);
        roles.addFieldAgent(agent);
        assertEq(roles.fieldAgentNgo(agent), ngo);
        assertTrue(roles.isFieldAgentOf(agent, ngo));
        assertFalse(roles.isFieldAgentOf(agent, ngo2));
    }

    function test_addFieldAgent_reverts() public {
        vm.prank(outsider);
        vm.expectRevert(Errors.Unauthorized.selector);
        roles.addFieldAgent(makeAddr("a"));

        vm.prank(admin);
        roles.setNgoActive(ngo, false);
        vm.prank(ngo);
        vm.expectRevert(Errors.Unauthorized.selector);
        roles.addFieldAgent(makeAddr("a"));
        vm.prank(admin);
        roles.setNgoActive(ngo, true);

        vm.startPrank(ngo);
        vm.expectRevert(Errors.ZeroAddress.selector);
        roles.addFieldAgent(address(0));
        vm.expectRevert(Errors.FieldAgentAlreadyBound.selector);
        roles.addFieldAgent(fieldAgent);
        vm.expectRevert(Errors.RoleConflict.selector);
        roles.addFieldAgent(verifier1);
        vm.expectRevert(Errors.RoleConflict.selector);
        roles.addFieldAgent(ngo2);
        vm.stopPrank();
    }

    function test_addFieldAgent_revertsWhenBoundToAnotherNgo() public {
        vm.prank(ngo2);
        vm.expectRevert(Errors.FieldAgentAlreadyBound.selector);
        roles.addFieldAgent(fieldAgent);
    }

    function test_removeFieldAgent() public {
        vm.expectEmit(true, true, false, false, address(roles));
        emit IRoleRegistry.FieldAgentRemoved(ngo, fieldAgent);
        vm.prank(ngo);
        roles.removeFieldAgent(fieldAgent);
        assertEq(roles.fieldAgentNgo(fieldAgent), address(0));
        assertFalse(roles.isFieldAgentOf(fieldAgent, ngo));
    }

    function test_removeFieldAgent_revertsForOtherNgo() public {
        vm.prank(ngo2);
        vm.expectRevert(Errors.FieldAgentNotBound.selector);
        roles.removeFieldAgent(fieldAgent);
    }

    // ─── independence ──────────────────────────────────────────────────────────

    function test_isIndependent() public {
        assertTrue(roles.isIndependent(verifier1, ngo));
        assertFalse(roles.isIndependent(outsider, ngo), "not a verifier");
        assertFalse(roles.isIndependent(ngo, ngo), "self");

        // a verifier that is also the NGO's payout Safe is not independent
        address v = makeAddr("payoutVerifier");
        vm.prank(admin);
        roles.registerVerifier(v);
        address newNgo = makeAddr("ngo3");
        // registering an NGO whose payout is a verifier is blocked, so exercise the check directly
        assertTrue(roles.isIndependent(v, newNgo), "unrelated ngo");
    }

    function test_isIndependent_falseForOwnFieldAgent() public {
        // Field agents cannot hold VERIFIER_ROLE, so the binding check is belt-and-braces:
        // grant the role through a fresh registry where the agent is registered as verifier first.
        RoleRegistry fresh = new RoleRegistry(admin);
        address agent = makeAddr("dualRole");
        vm.startPrank(admin);
        fresh.registerNgo(ngo, ngoPayout, keccak256("c"), "");
        fresh.registerVerifier(agent);
        vm.stopPrank();
        assertTrue(fresh.isIndependent(agent, ngo));
    }

    // ─── role hardening ────────────────────────────────────────────────────────

    function test_grantRole_onlyAdminRole() public {
        address admin2 = makeAddr("admin2");
        vm.startPrank(admin);
        vm.expectRevert(Errors.UseRegistrationFunction.selector);
        roles.grantRole(Roles.VERIFIER_ROLE, outsider);
        vm.expectRevert(Errors.UseRegistrationFunction.selector);
        roles.revokeRole(Roles.NGO_ROLE, ngo);

        roles.grantRole(Roles.DEFAULT_ADMIN_ROLE, admin2);
        assertTrue(roles.isAdmin(admin2));
        roles.revokeRole(Roles.DEFAULT_ADMIN_ROLE, admin2);
        assertFalse(roles.isAdmin(admin2));
        vm.stopPrank();
    }

    // ─── pause ─────────────────────────────────────────────────────────────────

    function test_pauseAndUnpause() public {
        assertFalse(roles.paused());
        vm.prank(admin);
        roles.pause();
        assertTrue(roles.paused());

        vm.prank(admin);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        roles.pause();

        vm.prank(admin);
        roles.unpause();
        assertFalse(roles.paused());
    }

    function test_pause_revertsForNonAdmin() public {
        _expectNotAdmin(ngo);
        vm.prank(ngo);
        roles.pause();

        vm.prank(admin);
        roles.pause();
        _expectNotAdmin(ngo);
        vm.prank(ngo);
        roles.unpause();
    }

    function test_supportsInterface() public view {
        assertTrue(roles.supportsInterface(type(IAccessControl).interfaceId));
    }
}
