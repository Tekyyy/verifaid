// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {RoleAware} from "../access/RoleAware.sol";
import {IProgramRegistry} from "../interfaces/IProgramRegistry.sol";
import {IRoleRegistry} from "../interfaces/IRoleRegistry.sol";
import {Errors} from "../libraries/Errors.sol";

/// @title ProgramRegistry
/// @notice The programmes NGOs run. A programme is a label and a commitment — who it serves, by which published
///         eligibility rules — that needs point to, so donors can see what a need is part of.
/// @dev Programmes used to be Semaphore groups whose members confirmed deliveries anonymously. Since donors approve
///      deliveries themselves, nothing reads membership any more, and a beneficiary is safest nowhere on chain at
///      all: enrolment lives only in the NGO's encrypted records.
contract ProgramRegistry is IProgramRegistry, RoleAware {
    /// @inheritdoc IProgramRegistry
    uint256 public programCount;

    mapping(uint256 => Program) private _programs;

    constructor(IRoleRegistry roles_) RoleAware(roles_) {}

    /// @inheritdoc IProgramRegistry
    function createProgram(bytes32 eligibilityHash, string calldata uri)
        external
        whenNotPaused
        returns (uint256 programId)
    {
        if (!roles.isActiveNgo(msg.sender)) revert Errors.Unauthorized();
        if (eligibilityHash == bytes32(0)) revert Errors.InvalidParameter();

        programId = ++programCount;
        _programs[programId] =
            Program({ngo: msg.sender, active: true, eligibilityHash: eligibilityHash, metadataURI: uri});
        emit ProgramCreated(programId, msg.sender, eligibilityHash, uri);
    }

    /// @inheritdoc IProgramRegistry
    function setProgramActive(uint256 programId, bool active) external {
        Program storage p = _program(programId);
        if (msg.sender != p.ngo) revert Errors.Unauthorized();
        p.active = active;
        emit ProgramStatusChanged(programId, active);
    }

    /// @inheritdoc IProgramRegistry
    function getProgram(uint256 programId) external view returns (Program memory) {
        return _program(programId);
    }

    /// @inheritdoc IProgramRegistry
    function programNgo(uint256 programId) external view returns (address) {
        return _programs[programId].ngo;
    }

    /// @inheritdoc IProgramRegistry
    function isProgramActive(uint256 programId) external view returns (bool) {
        return _programs[programId].active;
    }

    function _program(uint256 programId) internal view returns (Program storage p) {
        p = _programs[programId];
        if (p.ngo == address(0)) revert Errors.ProgramNotFound();
    }
}
