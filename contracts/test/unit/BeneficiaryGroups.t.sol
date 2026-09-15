// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BeneficiaryGroups} from "../../src/identity/BeneficiaryGroups.sol";
import {IBeneficiaryGroups} from "../../src/interfaces/IBeneficiaryGroups.sol";
import {Errors} from "../../src/libraries/Errors.sol";
import {MockSemaphore} from "../../src/mocks/MockSemaphore.sol";
import {PoATest} from "../utils/PoATest.sol";
import {ISemaphore} from "@semaphore-protocol/contracts/interfaces/ISemaphore.sol";

contract BeneficiaryGroupsTest is PoATest {
    function _commitments(uint256 n, uint256 salt) internal pure returns (uint256[] memory out) {
        out = new uint256[](n);
        for (uint256 i; i < n; ++i) {
            out[i] = uint256(keccak256(abi.encode(salt, i)));
        }
    }

    // ─── wiring ────────────────────────────────────────────────────────────────

    function test_wire() public {
        BeneficiaryGroups fresh = new BeneficiaryGroups(roles, ISemaphore(address(semaphore)));

        vm.prank(outsider);
        vm.expectRevert(Errors.Unauthorized.selector);
        fresh.wire(address(deliveryManager));

        vm.prank(admin);
        vm.expectRevert(Errors.ZeroAddress.selector);
        fresh.wire(address(0));

        vm.prank(admin);
        fresh.wire(address(deliveryManager));
        assertTrue(fresh.wired());

        vm.prank(admin);
        vm.expectRevert(Errors.AlreadyWired.selector);
        fresh.wire(address(deliveryManager));
    }

    function test_constructor_revertsOnZeroSemaphore() public {
        vm.expectRevert(Errors.ZeroAddress.selector);
        new BeneficiaryGroups(roles, ISemaphore(address(0)));
    }

    // ─── programs ──────────────────────────────────────────────────────────────

    function test_createProgram() public {
        vm.expectEmit(true, true, false, true, address(groups));
        emit IBeneficiaryGroups.ProgramCreated(1, ngo, 0, POLICY_HASH, "ipfs://program");
        vm.prank(ngo);
        uint256 programId = groups.createProgram(POLICY_HASH, "ipfs://program");

        assertEq(programId, 1);
        assertEq(groups.programCount(), 1);
        IBeneficiaryGroups.Program memory p = groups.getProgram(programId);
        assertEq(p.ngo, ngo);
        assertEq(p.enrollmentPolicyHash, POLICY_HASH);
        assertEq(p.metadataURI, "ipfs://program");
        assertTrue(p.active);
        assertEq(groups.getGroupId(programId), 0);
        assertEq(groups.programNgo(programId), ngo);
        assertEq(groups.memberCount(programId), 0);
    }

    function test_createProgram_reverts() public {
        vm.prank(outsider);
        vm.expectRevert(Errors.Unauthorized.selector);
        groups.createProgram(POLICY_HASH, "");

        vm.prank(ngo);
        vm.expectRevert(Errors.InvalidParameter.selector);
        groups.createProgram(bytes32(0), "");

        vm.prank(admin);
        roles.setNgoActive(ngo, false);
        vm.prank(ngo);
        vm.expectRevert(Errors.Unauthorized.selector);
        groups.createProgram(POLICY_HASH, "");
    }

    function test_createProgram_revertsWhenPaused() public {
        vm.prank(admin);
        roles.pause();
        vm.prank(ngo);
        vm.expectRevert(Errors.SystemPaused.selector);
        groups.createProgram(POLICY_HASH, "");
    }

    function test_setProgramActive() public {
        uint256 programId = _createProgram(ngo, 0);

        vm.prank(outsider);
        vm.expectRevert(Errors.Unauthorized.selector);
        groups.setProgramActive(programId, false);

        vm.expectEmit(true, false, false, true, address(groups));
        emit IBeneficiaryGroups.ProgramStatusChanged(programId, false);
        vm.prank(ngo);
        groups.setProgramActive(programId, false);
        assertFalse(groups.getProgram(programId).active);

        uint256[] memory members = _commitments(3, 1);
        vm.prank(ngo);
        vm.expectRevert(Errors.ProgramInactive.selector);
        groups.addMembers(programId, members);
    }

    // ─── members ───────────────────────────────────────────────────────────────

    function test_addMembers() public {
        uint256 programId = _createProgram(ngo, 0);
        uint256[] memory members = _commitments(4, 7);

        vm.expectEmit(true, false, false, true, address(groups));
        emit IBeneficiaryGroups.MembersAdded(programId, 4);
        vm.prank(ngo);
        groups.addMembers(programId, members);

        assertEq(groups.memberCount(programId), 4);
        for (uint256 i; i < members.length; ++i) {
            assertTrue(semaphore.hasMember(groups.getGroupId(programId), members[i]));
        }

        vm.prank(ngo);
        groups.addMembers(programId, _commitments(2, 99));
        assertEq(groups.memberCount(programId), 6);
    }

    function test_addMembers_reverts() public {
        uint256 programId = _createProgram(ngo, 0);
        uint256[] memory members = _commitments(2, 1);

        vm.prank(ngo2);
        vm.expectRevert(Errors.Unauthorized.selector);
        groups.addMembers(programId, members);

        vm.prank(ngo);
        vm.expectRevert(Errors.EmptyMembers.selector);
        groups.addMembers(programId, new uint256[](0));

        vm.prank(ngo);
        vm.expectRevert(Errors.ProgramNotFound.selector);
        groups.addMembers(404, members);

        vm.prank(admin);
        roles.setNgoActive(ngo, false);
        vm.prank(ngo);
        vm.expectRevert(Errors.NgoInactive.selector);
        groups.addMembers(programId, members);
    }

    function test_addMembers_revertsWhenPaused() public {
        uint256 programId = _createProgram(ngo, 0);
        vm.prank(admin);
        roles.pause();
        vm.prank(ngo);
        vm.expectRevert(Errors.SystemPaused.selector);
        groups.addMembers(programId, _commitments(1, 1));
    }

    function test_removeMember() public {
        uint256 programId = _createProgram(ngo, 5);
        uint256 commitment = uint256(keccak256(abi.encode(ngo, programId, uint256(0))));

        vm.prank(outsider);
        vm.expectRevert(Errors.Unauthorized.selector);
        groups.removeMember(programId, commitment, new uint256[](0));

        vm.expectEmit(true, false, false, false, address(groups));
        emit IBeneficiaryGroups.MemberRemoved(programId);
        vm.prank(ngo);
        groups.removeMember(programId, commitment, new uint256[](0));

        assertEq(groups.memberCount(programId), 4);
        assertFalse(semaphore.hasMember(groups.getGroupId(programId), commitment));
    }

    /// @dev Erasure requests must work even during an emergency pause.
    function test_removeMember_worksWhilePaused() public {
        uint256 programId = _createProgram(ngo, 5);
        uint256 commitment = uint256(keccak256(abi.encode(ngo, programId, uint256(1))));
        vm.prank(admin);
        roles.pause();
        vm.prank(ngo);
        groups.removeMember(programId, commitment, new uint256[](0));
        assertEq(groups.memberCount(programId), 4);
    }

    // ─── proofs ────────────────────────────────────────────────────────────────

    function test_validateProof_onlyDeliveryManager() public {
        uint256 programId = _createProgram(ngo, 5);
        vm.prank(outsider);
        vm.expectRevert(Errors.Unauthorized.selector);
        groups.validateProof(programId, _proof(1, 0));
    }

    function test_validateProof_forwardsToSemaphore() public {
        uint256 programId = _createProgram(ngo, 5);
        ISemaphore.SemaphoreProof memory proof = _proof(1, 0);

        vm.prank(address(deliveryManager));
        groups.validateProof(programId, proof);

        // the mock tracks nullifiers per group, so a replay reverts
        vm.prank(address(deliveryManager));
        vm.expectRevert(ISemaphore.Semaphore__YouAreUsingTheSameNullifierTwice.selector);
        groups.validateProof(programId, proof);
    }

    function test_validateProof_rejectsInvalidProof() public {
        uint256 programId = _createProgram(ngo, 5);
        ISemaphore.SemaphoreProof memory proof = _proof(1, 0);
        proof.points[0] = 0; // the mock treats points[0] == 1 as "valid"

        vm.prank(address(deliveryManager));
        vm.expectRevert(ISemaphore.Semaphore__InvalidProof.selector);
        groups.validateProof(programId, proof);
    }

    // ─── views ─────────────────────────────────────────────────────────────────

    function test_views_revertForUnknownProgram() public {
        vm.expectRevert(Errors.ProgramNotFound.selector);
        groups.getProgram(1);
        vm.expectRevert(Errors.ProgramNotFound.selector);
        groups.getGroupId(1);
        assertEq(groups.programNgo(1), address(0));
    }

    function test_groupsAreIndependentPerProgram() public {
        uint256 first = _createProgram(ngo, 3);
        uint256 second = _createProgram(ngo2, 3);
        assertTrue(groups.getGroupId(first) != groups.getGroupId(second));
        assertEq(groups.programNgo(second), ngo2);
    }
}
