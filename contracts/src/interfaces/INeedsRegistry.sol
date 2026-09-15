// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IRoleAware} from "./IRoleAware.sol";

/// @title INeedsRegistry
/// @notice Registry of verified humanitarian needs and their lifecycle state machine.
interface INeedsRegistry is IRoleAware {
    enum NeedStatus {
        Pending,
        Verified,
        Funding,
        Funded,
        InDelivery,
        Completed,
        Cancelled
    }

    struct Need {
        uint256 id;
        address ngo;
        uint256 programId; // BeneficiaryGroups program whose members confirm deliveries
        bytes32 category; // e.g. keccak256("FOOD")
        uint256 targetAmount; // stablecoin base units
        bytes32 regionCode; // coarse region only (ISO 3166-2 subdivision), never GPS
        bytes32 dossierHash; // hash of the encrypted, off-chain needs assessment
        string metadataURI; // public, non-personal description
        uint8 verificationsRequired;
        uint8 verificationCount;
        uint16[] trancheBps; // sums to 10_000
        address vault;
        NeedStatus status;
        uint64 createdAt;
    }

    struct CreateNeedParams {
        uint256 programId;
        bytes32 category;
        uint256 targetAmount;
        bytes32 regionCode;
        bytes32 dossierHash;
        string metadataURI;
        uint8 verificationsRequired;
        uint16[] trancheBps;
    }

    event NeedCreated(
        uint256 indexed needId,
        address indexed ngo,
        uint256 indexed programId,
        bytes32 category,
        uint256 targetAmount,
        bytes32 regionCode,
        bytes32 dossierHash,
        uint8 verificationsRequired,
        uint16[] trancheBps,
        string metadataURI
    );
    event NeedVerificationRecorded(
        uint256 indexed needId, address indexed verifier, bool approved, bytes32 attestationUID, uint8 verificationCount
    );
    event NeedVerified(uint256 indexed needId, address vault);
    event NeedStatusChanged(uint256 indexed needId, NeedStatus from, NeedStatus to);
    event NeedCancelled(uint256 indexed needId, address indexed by);
    event NeedVerificationRevoked(
        uint256 indexed needId, address indexed verifier, bytes32 attestationUID, uint8 verificationCount
    );
    event VerificationRevokedAfterFunding(uint256 indexed needId, address indexed verifier, bytes32 attestationUID);
    event Wired(address vaultFactory, address beneficiaryGroups, address deliveryManager, address needVerifiedResolver);

    /// @notice Creates a need in `Pending` status. Caller must be an active NGO that owns `p.programId`.
    function createNeed(CreateNeedParams calldata p) external returns (uint256 needId);

    /// @notice Records a NeedVerified attestation. Callable only by the NeedVerifiedResolver.
    function onVerificationAttested(uint256 needId, address verifier, bool approved, bytes32 attestationUID) external;

    /// @notice Handles revocation of a NeedVerified attestation. Callable only by the NeedVerifiedResolver.
    function onVerificationRevoked(uint256 needId, address verifier, bytes32 attestationUID) external;

    /// @notice Moves a need forward (Funding→Funded→InDelivery→Completed). Callable by the need's vault or the DeliveryManager.
    function setStatus(uint256 needId, NeedStatus next) external;

    /// @notice Cancels a need. The NGO may cancel before `Funded`; the admin at any time before `Completed`.
    function cancelNeed(uint256 needId) external;

    /// @notice Full need record.
    function getNeed(uint256 needId) external view returns (Need memory);

    function needCount() external view returns (uint256);
    function statusOf(uint256 needId) external view returns (NeedStatus);
    function ngoOf(uint256 needId) external view returns (address);
    function vaultOf(uint256 needId) external view returns (address);
    function programOf(uint256 needId) external view returns (uint256);
    function targetAmountOf(uint256 needId) external view returns (uint256);
    function dossierHashOf(uint256 needId) external view returns (bytes32);
    function regionCodeOf(uint256 needId) external view returns (bytes32);
    function trancheBpsOf(uint256 needId) external view returns (uint16[] memory);
}
