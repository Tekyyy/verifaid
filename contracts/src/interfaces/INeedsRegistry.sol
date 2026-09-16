// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IRoleAware} from "./IRoleAware.sol";

/// @title INeedsRegistry
/// @notice Registry of verified humanitarian needs (the proposal's "NeedClaim") and their lifecycle state machine.
interface INeedsRegistry is IRoleAware {
    enum NeedStatus {
        Pending,
        Verified,
        Funding,
        Funded,
        InDelivery,
        Completed,
        Cancelled,
        Expired
    }

    /// @notice Where the money for a need lives.
    /// @dev `OnChain`: stablecoin is escrowed in an AidVault and released by the contracts (proposal Model B).
    ///      `OffChain`: a regulated payment provider holds the money; `FundingRecorded` and `Settlement`
    ///      attestations drive a NonCustodialLedger that mirrors the same tranche rules (proposal Model A).
    enum CustodyMode {
        OnChain,
        OffChain
    }

    /// @notice Everything an NGO commits to when it registers a need. Emitted in full in `NeedCreated`.
    /// @dev Fields marked "event only" are commitments nothing on-chain reads, so they are logged rather than
    ///      stored: an event log is as immutable as storage and far cheaper.
    struct CreateNeedParams {
        uint256 programId; // BeneficiaryGroups program whose members confirm deliveries
        bytes32 category; // event only, e.g. keccak256("FOOD")
        uint256 targetAmount; // stablecoin base units
        bytes32 regionCode; // coarse region only (ISO 3166-2 subdivision), never GPS
        bytes32 dossierHash; // hash of the encrypted, off-chain needs assessment
        string metadataURI; // event only: public, non-personal description
        uint8 verificationsRequired;
        uint16[] trancheBps; // sums to 10_000
        CustodyMode custodyMode;
        address custodian; // OffChain only: the payment provider (BANK_PARTNER_ROLE) that holds the money
        uint64 fundingDeadline; // 0 = open-ended; after it anyone may call `expire`
        uint64 executionDeadline; // 0 = none; after it unreleased funds can be returned via `expire`
        uint16 minFundingBps; // share of the target that must be raised to execute (10_000 = all or nothing)
        uint16 thirdPartyCostBps; // disclosed cap on intermediary costs (payment, FX, banking) per amount
        bytes32 expectedOutcomeHash; // event only: expected outcome and partial-execution terms
        bytes32 costDisclosureHash; // event only: the third-party cost disclosure document
    }

    /// @notice Stored view of a need.
    struct Need {
        uint256 id;
        address ngo;
        uint256 programId;
        uint256 targetAmount;
        bytes32 regionCode;
        bytes32 dossierHash;
        uint8 verificationsRequired;
        uint8 verificationCount;
        uint16[] trancheBps;
        address vault; // AidVault (OnChain) or NonCustodialLedger (OffChain); zero until verified
        NeedStatus status;
        CustodyMode custodyMode;
        address custodian;
        uint64 fundingDeadline;
        uint64 executionDeadline;
        uint16 minFundingBps;
        uint16 thirdPartyCostBps;
    }

    event NeedCreated(uint256 indexed needId, address indexed ngo, uint256 indexed programId, CreateNeedParams params);
    event NeedVerificationRecorded(
        uint256 indexed needId, address indexed verifier, bool approved, bytes32 attestationUID, uint8 verificationCount
    );
    event NeedVerified(uint256 indexed needId, address vault);
    event NeedStatusChanged(uint256 indexed needId, NeedStatus from, NeedStatus to);
    event NeedCancelled(uint256 indexed needId, address indexed by);
    event NeedExpired(uint256 indexed needId, NeedStatus from, uint256 raised);
    event PartialFundingAccepted(uint256 indexed needId, uint256 raised, uint256 targetAmount);
    event NeedVerificationRevoked(
        uint256 indexed needId, address indexed verifier, bytes32 attestationUID, uint8 verificationCount
    );
    event VerificationRevokedAfterFunding(uint256 indexed needId, address indexed verifier, bytes32 attestationUID);
    event Wired(address vaultFactory, address beneficiaryGroups, address deliveryManager, address resolver);

    /// @notice Creates a need in `Pending` status. Caller must be an active NGO that owns `p.programId`.
    function createNeed(CreateNeedParams calldata p) external returns (uint256 needId);

    /// @notice Records a NeedVerified attestation. Callable only by the resolver.
    function onVerificationAttested(uint256 needId, address verifier, bool approved, bytes32 attestationUID) external;

    /// @notice Handles revocation of a NeedVerified attestation. Callable only by the resolver.
    function onVerificationRevoked(uint256 needId, address verifier, bytes32 attestationUID) external;

    /// @notice Moves a need forward (Funding→Funded→InDelivery→Completed). Callable only by the need's ledger.
    function setStatus(uint256 needId, NeedStatus next) external;

    /// @notice Cancels a need. The NGO may cancel before `Funded`; the admin at any time before it ends.
    function cancelNeed(uint256 needId) external;

    /// @notice Applies the need's deadlines. Callable by anyone once a deadline has passed:
    ///         - `Pending` after the funding deadline → `Expired`.
    ///         - `Funding` after the funding deadline → funding closes on what was raised if that meets
    ///           `minFundingBps` (partial execution, tranches scale down), otherwise `Expired` with refunds open.
    ///           Past the execution deadline it always expires: there is no time left to deliver.
    ///         - `Funded` / `InDelivery` after the execution deadline → `Expired`, refunding the unreleased balance.
    ///           Work already done wins during a grace period: while a tranche is releasable or a verified
    ///           delivery is in its challenge window or disputed, expiry waits until `EXPIRY_GRACE_PERIOD` ends.
    function expire(uint256 needId) external;

    /// @notice Full need record.
    function getNeed(uint256 needId) external view returns (Need memory);

    /// @notice The fields a ledger needs to accept money, in one call.
    /// @return ngo The need's NGO.
    /// @return targetAmount Funding target.
    /// @return minFundingBps Minimum share of the target required to execute.
    /// @return open True while the need is `Funding` and neither of its deadlines has passed.
    function fundingTermsOf(uint256 needId)
        external
        view
        returns (address ngo, uint256 targetAmount, uint16 minFundingBps, bool open);

    /// @notice The fields the delivery flow reads, in one call.
    function coreOf(uint256 needId)
        external
        view
        returns (address ngo, address vault, uint256 programId, NeedStatus status);

    function needCount() external view returns (uint256);
    function statusOf(uint256 needId) external view returns (NeedStatus);
    function ngoOf(uint256 needId) external view returns (address);
    function vaultOf(uint256 needId) external view returns (address);
    function programOf(uint256 needId) external view returns (uint256);
    function targetAmountOf(uint256 needId) external view returns (uint256);
    function dossierHashOf(uint256 needId) external view returns (bytes32);
    function regionCodeOf(uint256 needId) external view returns (bytes32);
    function trancheBpsOf(uint256 needId) external view returns (uint16[] memory);
    function custodyModeOf(uint256 needId) external view returns (CustodyMode);
    function thirdPartyCostBpsOf(uint256 needId) external view returns (uint16);
    function custodianOf(uint256 needId) external view returns (address);
}
