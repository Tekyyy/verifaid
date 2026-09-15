// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ISemaphore} from "@semaphore-protocol/contracts/interfaces/ISemaphore.sol";

/// @title IBeneficiaryGroups
/// @notice One Semaphore group per NGO program. Beneficiaries exist on-chain only as identity commitments.
interface IBeneficiaryGroups {
    struct Program {
        address ngo;
        uint256 semaphoreGroupId;
        bytes32 enrollmentPolicyHash; // commits to the published eligibility rules
        string metadataURI;
        bool active;
    }

    event ProgramCreated(
        uint256 indexed programId,
        address indexed ngo,
        uint256 semaphoreGroupId,
        bytes32 enrollmentPolicyHash,
        string metadataURI
    );
    event MembersAdded(uint256 indexed programId, uint256 count);
    event MemberRemoved(uint256 indexed programId);
    event ProgramStatusChanged(uint256 indexed programId, bool active);
    event Wired(address deliveryManager);

    /// @notice Creates a program and its Semaphore group. Caller must be an active NGO.
    function createProgram(bytes32 enrollmentPolicyHash, string calldata uri) external returns (uint256 programId);

    /// @notice Enrolls identity commitments into the program's group. Program's NGO only.
    function addMembers(uint256 programId, uint256[] calldata identityCommitments) external;

    /// @notice Opens or closes enrollment for a program. Program's NGO only.
    function setProgramActive(uint256 programId, bool active) external;

    /// @notice Removes a member (e.g. after a right-to-erasure request). Program's NGO only.
    function removeMember(uint256 programId, uint256 commitment, uint256[] calldata merkleProofSiblings) external;

    /// @notice Validates a Semaphore proof against the program's group (reverts on invalid proof or reused nullifier).
    ///         DeliveryManager only.
    function validateProof(uint256 programId, ISemaphore.SemaphoreProof calldata proof) external;

    function getGroupId(uint256 programId) external view returns (uint256);
    function getProgram(uint256 programId) external view returns (Program memory);
    function programNgo(uint256 programId) external view returns (address);
    function memberCount(uint256 programId) external view returns (uint256);
    function programCount() external view returns (uint256);
}
