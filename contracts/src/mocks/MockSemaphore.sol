// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ISemaphore} from "@semaphore-protocol/contracts/interfaces/ISemaphore.sol";

/// @title MockSemaphore
/// @notice FOUNDRY TESTS ONLY. Implements the subset of Semaphore v4 used by BeneficiaryGroups.
///         A proof is "valid" iff `points[0] == 1`; nullifiers are tracked per group and reuse reverts,
///         matching the real contract's errors.
contract MockSemaphore {
    struct MockGroup {
        address admin;
        uint256 size;
        mapping(uint256 => bool) members;
        mapping(uint256 => bool) nullifiers;
    }

    uint256 public groupCounter;
    mapping(uint256 => MockGroup) private _groups;

    event MembersAdded(
        uint256 indexed groupId, uint256 startIndex, uint256[] identityCommitments, uint256 merkleTreeRoot
    );
    event MemberRemoved(uint256 indexed groupId, uint256 index, uint256 identityCommitment, uint256 merkleTreeRoot);
    event ProofValidated(
        uint256 indexed groupId,
        uint256 merkleTreeDepth,
        uint256 indexed merkleTreeRoot,
        uint256 nullifier,
        uint256 message,
        uint256 indexed scope,
        uint256[8] points
    );

    error Semaphore__CallerIsNotTheGroupAdmin();
    error Semaphore__GroupDoesNotExist();

    function createGroup() external returns (uint256 groupId) {
        groupId = groupCounter++;
        _groups[groupId].admin = msg.sender;
    }

    function addMembers(uint256 groupId, uint256[] calldata identityCommitments) external {
        MockGroup storage g = _adminGroup(groupId);
        uint256 start = g.size;
        for (uint256 i; i < identityCommitments.length; ++i) {
            g.members[identityCommitments[i]] = true;
        }
        g.size += identityCommitments.length;
        emit MembersAdded(groupId, start, identityCommitments, 0);
    }

    function removeMember(uint256 groupId, uint256 identityCommitment, uint256[] calldata) external {
        MockGroup storage g = _adminGroup(groupId);
        g.members[identityCommitment] = false;
        emit MemberRemoved(groupId, 0, identityCommitment, 0);
    }

    function validateProof(uint256 groupId, ISemaphore.SemaphoreProof calldata proof) external {
        MockGroup storage g = _groups[groupId];
        if (g.admin == address(0)) revert Semaphore__GroupDoesNotExist();
        if (g.nullifiers[proof.nullifier]) revert ISemaphore.Semaphore__YouAreUsingTheSameNullifierTwice();
        if (proof.points[0] != 1) revert ISemaphore.Semaphore__InvalidProof();
        g.nullifiers[proof.nullifier] = true;
        emit ProofValidated(
            groupId,
            proof.merkleTreeDepth,
            proof.merkleTreeRoot,
            proof.nullifier,
            proof.message,
            proof.scope,
            proof.points
        );
    }

    function hasMember(uint256 groupId, uint256 identityCommitment) external view returns (bool) {
        return _groups[groupId].members[identityCommitment];
    }

    function _adminGroup(uint256 groupId) internal view returns (MockGroup storage g) {
        g = _groups[groupId];
        if (g.admin == address(0)) revert Semaphore__GroupDoesNotExist();
        if (g.admin != msg.sender) revert Semaphore__CallerIsNotTheGroupAdmin();
    }
}
