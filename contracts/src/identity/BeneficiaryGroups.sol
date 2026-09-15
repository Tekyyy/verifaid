// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {RoleAware} from "../access/RoleAware.sol";
import {IBeneficiaryGroups} from "../interfaces/IBeneficiaryGroups.sol";
import {IRoleRegistry} from "../interfaces/IRoleRegistry.sol";
import {Errors} from "../libraries/Errors.sol";
import {ISemaphore} from "@semaphore-protocol/contracts/interfaces/ISemaphore.sol";

/// @title BeneficiaryGroups
/// @notice Wraps Semaphore: one group per NGO program. This contract is the admin of every group it creates.
/// @dev Enrollment is a human process run by the NGO and audited by verifiers off-chain; `enrollmentPolicyHash`
///      commits to the published eligibility rules. Individual commitments are never emitted by this contract
///      (Semaphore emits them itself, which is acceptable because commitments are unlinkable).
contract BeneficiaryGroups is IBeneficiaryGroups, RoleAware {
    ISemaphore public immutable semaphore;

    address public deliveryManager;
    bool public wired;

    /// @inheritdoc IBeneficiaryGroups
    uint256 public programCount;
    /// @inheritdoc IBeneficiaryGroups
    mapping(uint256 => uint256) public memberCount;

    mapping(uint256 => Program) private _programs;

    /// @param roles_ System role registry.
    /// @param semaphore_ Semaphore v4 contract.
    constructor(IRoleRegistry roles_, ISemaphore semaphore_) RoleAware(roles_) {
        if (address(semaphore_) == address(0)) revert Errors.ZeroAddress();
        semaphore = semaphore_;
    }

    /// @notice One-time wiring of the DeliveryManager (the only caller allowed to validate proofs). Admin only.
    function wire(address deliveryManager_) external onlyAdmin {
        if (wired) revert Errors.AlreadyWired();
        if (deliveryManager_ == address(0)) revert Errors.ZeroAddress();
        wired = true;
        deliveryManager = deliveryManager_;
        emit Wired(deliveryManager_);
    }

    /// @inheritdoc IBeneficiaryGroups
    function createProgram(bytes32 enrollmentPolicyHash, string calldata uri)
        external
        whenNotPaused
        returns (uint256 programId)
    {
        if (!roles.isActiveNgo(msg.sender)) revert Errors.Unauthorized();
        if (enrollmentPolicyHash == bytes32(0)) revert Errors.InvalidParameter();

        programId = ++programCount;
        uint256 groupId = semaphore.createGroup();
        _programs[programId] = Program({
            ngo: msg.sender,
            semaphoreGroupId: groupId,
            enrollmentPolicyHash: enrollmentPolicyHash,
            metadataURI: uri,
            active: true
        });
        emit ProgramCreated(programId, msg.sender, groupId, enrollmentPolicyHash, uri);
    }

    /// @inheritdoc IBeneficiaryGroups
    function addMembers(uint256 programId, uint256[] calldata identityCommitments) external whenNotPaused {
        Program storage p = _program(programId);
        if (msg.sender != p.ngo) revert Errors.Unauthorized();
        if (!roles.isActiveNgo(msg.sender)) revert Errors.NgoInactive();
        if (!p.active) revert Errors.ProgramInactive();
        uint256 count = identityCommitments.length;
        if (count == 0) revert Errors.EmptyMembers();

        memberCount[programId] += count;
        semaphore.addMembers(p.semaphoreGroupId, identityCommitments);
        emit MembersAdded(programId, count);
    }

    /// @inheritdoc IBeneficiaryGroups
    function setProgramActive(uint256 programId, bool active) external {
        Program storage p = _program(programId);
        if (msg.sender != p.ngo) revert Errors.Unauthorized();
        p.active = active;
        emit ProgramStatusChanged(programId, active);
    }

    /// @inheritdoc IBeneficiaryGroups
    /// @dev Not pausable: removal supports right-to-erasure requests and only reduces who can confirm.
    function removeMember(uint256 programId, uint256 commitment, uint256[] calldata merkleProofSiblings) external {
        Program storage p = _program(programId);
        if (msg.sender != p.ngo) revert Errors.Unauthorized();

        memberCount[programId] -= 1;
        semaphore.removeMember(p.semaphoreGroupId, commitment, merkleProofSiblings);
        emit MemberRemoved(programId);
    }

    /// @inheritdoc IBeneficiaryGroups
    function validateProof(uint256 programId, ISemaphore.SemaphoreProof calldata proof) external {
        if (msg.sender != deliveryManager || msg.sender == address(0)) revert Errors.Unauthorized();
        semaphore.validateProof(_program(programId).semaphoreGroupId, proof);
    }

    /// @inheritdoc IBeneficiaryGroups
    function getGroupId(uint256 programId) external view returns (uint256) {
        return _program(programId).semaphoreGroupId;
    }

    /// @inheritdoc IBeneficiaryGroups
    function getProgram(uint256 programId) external view returns (Program memory) {
        return _program(programId);
    }

    /// @inheritdoc IBeneficiaryGroups
    function programNgo(uint256 programId) external view returns (address) {
        return _programs[programId].ngo;
    }

    function _program(uint256 programId) internal view returns (Program storage p) {
        p = _programs[programId];
        if (p.ngo == address(0)) revert Errors.ProgramNotFound();
    }
}
