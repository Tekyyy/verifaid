// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IProgramRegistry} from "../../src/interfaces/IProgramRegistry.sol";
import {Errors} from "../../src/libraries/Errors.sol";
import {PoATest} from "../utils/PoATest.sol";

/// @notice Programmes: an NGO's label and published eligibility rules, which its needs point to. Nobody is enrolled
///         on chain.
contract ProgramRegistryTest is PoATest {
    function test_createProgram_recordsTheNgoAndItsRules() public {
        vm.expectEmit(true, true, false, true, address(programs));
        emit IProgramRegistry.ProgramCreated(1, ngo, ELIGIBILITY_HASH, "ipfs://program");
        uint256 programId = _createProgram(ngo);

        assertEq(programId, 1);
        assertEq(programs.programCount(), 1);
        IProgramRegistry.Program memory p = programs.getProgram(programId);
        assertEq(p.ngo, ngo);
        assertTrue(p.active);
        assertEq(p.eligibilityHash, ELIGIBILITY_HASH);
        assertEq(p.metadataURI, "ipfs://program");
        assertEq(programs.programNgo(programId), ngo);
        assertTrue(programs.isProgramActive(programId));
    }

    function test_createProgram_onlyAnActiveNgo_withPublishedRules() public {
        vm.prank(outsider);
        vm.expectRevert(Errors.Unauthorized.selector);
        programs.createProgram(ELIGIBILITY_HASH, "ipfs://program");

        vm.prank(ngo);
        vm.expectRevert(Errors.InvalidParameter.selector);
        programs.createProgram(bytes32(0), "ipfs://program");

        vm.prank(admin);
        roles.setNgoActive(ngo, false);
        vm.prank(ngo);
        vm.expectRevert(Errors.Unauthorized.selector);
        programs.createProgram(ELIGIBILITY_HASH, "ipfs://program");
    }

    function test_setProgramActive_onlyItsNgo() public {
        uint256 programId = _createProgram(ngo);
        vm.prank(ngo2);
        vm.expectRevert(Errors.Unauthorized.selector);
        programs.setProgramActive(programId, false);

        vm.expectEmit(true, false, false, true, address(programs));
        emit IProgramRegistry.ProgramStatusChanged(programId, false);
        vm.prank(ngo);
        programs.setProgramActive(programId, false);
        assertFalse(programs.isProgramActive(programId));
    }

    function test_unknownProgram() public {
        assertEq(programs.programNgo(7), address(0));
        assertFalse(programs.isProgramActive(7));
        vm.expectRevert(Errors.ProgramNotFound.selector);
        programs.getProgram(7);
        vm.prank(ngo);
        vm.expectRevert(Errors.ProgramNotFound.selector);
        programs.setProgramActive(7, true);
    }

    function test_createProgram_isPausable() public {
        vm.prank(admin);
        roles.pause();
        vm.prank(ngo);
        vm.expectRevert(Errors.SystemPaused.selector);
        programs.createProgram(ELIGIBILITY_HASH, "ipfs://program");
    }
}
