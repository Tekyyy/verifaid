// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IProgramRegistry
/// @notice An NGO's programmes: who it serves and by which published rules it picks them. Every need belongs to one
///         of its NGO's programmes. Nobody is enrolled on chain — the NGO's records of the people it serves stay in
///         its encrypted, off-chain vault. A beneficiary appears only by posting a need of their own, through the
///         BeneficiaryRegistry, and then only as that need's owner.
interface IProgramRegistry {
    struct Program {
        address ngo;
        bool active;
        bytes32 eligibilityHash; // commits to the published rules for who the programme serves
        string metadataURI; // public, non-personal description
    }

    event ProgramCreated(uint256 indexed programId, address indexed ngo, bytes32 eligibilityHash, string metadataURI);
    event ProgramStatusChanged(uint256 indexed programId, bool active);

    /// @notice Creates a programme owned by the caller, which must be an active NGO.
    function createProgram(bytes32 eligibilityHash, string calldata uri) external returns (uint256 programId);

    /// @notice Opens or closes a programme to new needs. The programme's NGO only.
    function setProgramActive(uint256 programId, bool active) external;

    function getProgram(uint256 programId) external view returns (Program memory);
    /// @notice The programme's NGO, or zero for an unknown programme.
    function programNgo(uint256 programId) external view returns (address);
    function isProgramActive(uint256 programId) external view returns (bool);
    function programCount() external view returns (uint256);
}
