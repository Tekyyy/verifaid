// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Errors} from "../../src/libraries/Errors.sol";
import {Roles} from "../../src/libraries/Roles.sol";
import {PoATest} from "../utils/PoATest.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";

/// @notice The handover Handover.s.sol performs: the admin role moves to a TimelockController whose only proposer
///         is the Safe, and a guardian keeps the power to pause. Every admin action then needs the Safe's
///         signatures *and* a public wait; the deployer keeps nothing.
/// @dev The Safe is stood in for by one address: its m-of-n signing is Safe's own, audited code. What is tested
///      here is what this system relies on — who can propose, the wait, who can execute and cancel.
contract GovernanceTest is PoATest {
    uint256 internal constant DELAY = 10 minutes;

    address internal safe = makeAddr("safe");
    address internal guardian = makeAddr("guardian");
    TimelockController internal timelock;

    function setUp() public override {
        super.setUp();
        address[] memory proposers = new address[](1);
        proposers[0] = safe;
        address[] memory executors = new address[](1);
        executors[0] = address(0); // anyone, once the wait is over
        timelock = new TimelockController(DELAY, proposers, executors, address(0));

        vm.startPrank(admin);
        roles.grantRole(Roles.GUARDIAN_ROLE, guardian);
        roles.grantRole(Roles.DEFAULT_ADMIN_ROLE, address(timelock));
        roles.renounceRole(Roles.DEFAULT_ADMIN_ROLE, admin);
        vm.stopPrank();
    }

    function _registerVerifierCall(address verifier) internal view returns (address, bytes memory) {
        return (address(roles), abi.encodeCall(roles.registerVerifier, (verifier)));
    }

    function test_handover_leavesTheDeployerWithNothing() public {
        assertFalse(roles.isAdmin(admin));
        assertTrue(roles.isAdmin(address(timelock)));
        assertFalse(roles.isAdmin(safe), "the Safe acts only through the timelock");

        vm.prank(admin);
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, admin, bytes32(0))
        );
        roles.registerVerifier(outsider);
    }

    function test_adminAction_waitsOutTheDelay_thenAnyoneExecutesIt() public {
        (address target, bytes memory data) = _registerVerifierCall(outsider);
        vm.prank(safe);
        timelock.schedule(target, 0, data, bytes32(0), bytes32(0), DELAY);
        bytes32 id = timelock.hashOperation(target, 0, data, bytes32(0), bytes32(0));
        assertTrue(timelock.isOperationPending(id));

        vm.warp(block.timestamp + DELAY - 1);
        vm.expectRevert();
        timelock.execute(target, 0, data, bytes32(0), bytes32(0));

        vm.warp(block.timestamp + 1);
        vm.prank(donor1); // anyone
        timelock.execute(target, 0, data, bytes32(0), bytes32(0));
        assertTrue(roles.hasRole(Roles.VERIFIER_ROLE, outsider));
    }

    function test_onlyTheSafeProposes_andItCannotSkipTheWait() public {
        (address target, bytes memory data) = _registerVerifierCall(outsider);
        vm.prank(admin);
        vm.expectRevert();
        timelock.schedule(target, 0, data, bytes32(0), bytes32(0), DELAY);

        vm.prank(safe);
        vm.expectRevert();
        timelock.schedule(target, 0, data, bytes32(0), bytes32(0), DELAY - 1);
    }

    function test_theSafeCanCancelAnActionBeforeItTakesEffect() public {
        (address target, bytes memory data) = _registerVerifierCall(outsider);
        vm.startPrank(safe);
        timelock.schedule(target, 0, data, bytes32(0), bytes32(0), DELAY);
        timelock.cancel(timelock.hashOperation(target, 0, data, bytes32(0), bytes32(0)));
        vm.stopPrank();

        vm.warp(block.timestamp + DELAY);
        vm.expectRevert();
        timelock.execute(target, 0, data, bytes32(0), bytes32(0));
        assertFalse(roles.hasRole(Roles.VERIFIER_ROLE, outsider));
    }

    /// @dev Stopping must not wait ten minutes, or two days on mainnet; starting again must.
    function test_guardianPausesAtOnce_unpausingGoesThroughTheTimelock() public {
        vm.prank(guardian);
        roles.pause();
        assertTrue(roles.paused());

        vm.prank(guardian);
        vm.expectRevert();
        roles.unpause();

        bytes memory data = abi.encodeCall(roles.unpause, ());
        vm.prank(safe);
        timelock.schedule(address(roles), 0, data, bytes32(0), bytes32(0), DELAY);
        vm.warp(block.timestamp + DELAY);
        timelock.execute(address(roles), 0, data, bytes32(0), bytes32(0));
        assertFalse(roles.paused());
    }

    /// @dev What the timelock guards: the admin powers that could redirect future donations.
    function test_timelockedAdmin_stillRunsEveryAdminPower() public {
        bytes memory data = abi.encodeCall(registry.setReleasePolicy, (address(verifierPolicy), false));
        vm.prank(safe);
        timelock.schedule(address(registry), 0, data, bytes32(0), bytes32(0), DELAY);
        vm.warp(block.timestamp + DELAY);
        timelock.execute(address(registry), 0, data, bytes32(0), bytes32(0));
        assertFalse(registry.isReleasePolicy(address(verifierPolicy)));

        vm.prank(admin);
        vm.expectRevert(Errors.Unauthorized.selector);
        registry.setReleasePolicy(address(verifierPolicy), true);
    }
}
