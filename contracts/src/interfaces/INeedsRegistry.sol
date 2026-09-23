// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IRoleAware} from "./IRoleAware.sol";

/// @title INeedsRegistry
/// @notice Registry of verified humanitarian needs (the proposal's "NeedClaim") and their lifecycle state machine.
interface INeedsRegistry is IRoleAware {
    /// @notice The ERC-4626 vault a need's idle capital may wait in, and the share of the pot allowed there.
    /// @dev Returns (0, 0) when this need's NGO never opted in, which is the default.
    function yieldVenueOf(uint256 needId) external view returns (address venue, uint16 capBps);

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

    /// @notice One recipient of a need's money, fixed when the need is created. The vault pays payees directly.
    struct Payee {
        address account; // a registered supplier, or address(0) for the NGO's own payout Safe (its disclosed share)
        uint16[] shareBps; // share of each tranche, aligned with `trancheBps`; each tranche's shares sum to 10_000
        bytes32 refHash; // event only: hash of the contract or quote agreed with this payee
        string label; // event only: public name of the payee and what it provides
    }

    /// @notice A payee as stored: who, and its share of each tranche.
    struct PayeeShare {
        address account; // zero = the NGO's payout Safe
        uint16[] shareBps;
    }

    /// @notice A proposed replacement of one supplier, waiting for independent verifiers.
    struct PayeeChange {
        uint64 id;
        uint8 index; // position in the payment plan
        uint8 approvals;
        address account; // the replacement supplier
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
        uint64 fundingDeadline; // 0 = open-ended; after it anyone may call `expire`
        uint64 executionDeadline; // required; after it unreleased funds can be returned via `expire`
        uint16 minFundingBps; // share of the target that must be raised to execute (10_000 = all or nothing)
        uint16 thirdPartyCostBps; // disclosed cap on intermediary costs (conversions, payouts) per amount
        bytes32 expectedOutcomeHash; // event only: expected outcome and partial-execution terms
        bytes32 costDisclosureHash; // event only: the third-party cost disclosure document
        Payee[] payees; // required: who the vault pays, and how much of each tranche
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
        address vault; // the need's AidVault; zero until verified
        NeedStatus status;
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
    /// @notice The platform approved (or withdrew) the one venue where idle capital may wait.
    event YieldVenueSet(address indexed venue, uint16 capBps);
    /// @notice An NGO opted a need in, before it could take a single donation.
    event YieldEnabled(uint256 indexed needId, address indexed venue, uint16 capBps);
    event PayeeChangeProposed(
        uint256 indexed needId,
        uint256 indexed changeId,
        uint8 index,
        address from,
        address to,
        bytes32 refHash,
        string label
    );
    event PayeeChangeApproved(
        uint256 indexed needId, uint256 indexed changeId, address indexed verifier, uint8 approvals
    );
    event PayeeChanged(uint256 indexed needId, uint256 indexed changeId, uint8 index, address from, address to);
    event PayeeChangeCancelled(uint256 indexed needId, uint256 indexed changeId);

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

    /// @notice Proposes replacing the supplier at `index` of an on-chain need's payment plan with another
    ///         registered supplier. Only the need's NGO; the NGO's own share cannot be moved. It takes effect once
    ///         as many independent verifiers as the need required approve it, and only for tranches not yet paid.
    /// @param refHash Hash of the new contract or quote (event only).
    /// @param label Public name of the replacement and what it provides (event only).
    function proposePayeeChange(uint256 needId, uint8 index, address account, bytes32 refHash, string calldata label)
        external
        returns (uint256 changeId);

    /// @notice Approves the pending payee change. Callable by a verifier independent of the need's NGO.
    /// @dev It takes effect on the approval that reaches `payeeChangeApprovalsRequired`, and only while no tranche
    ///      of a payee that can still be paid is standing releasable: earned work is paid to whoever did it.
    function approvePayeeChange(uint256 needId, uint256 changeId) external;

    /// @notice Independent approvals a payee change needs: the need's verification threshold, but never below two.
    function payeeChangeApprovalsRequired(uint256 needId) external view returns (uint8);

    /// @notice Withdraws the pending payee change. Only the need's NGO.
    function cancelPayeeChange(uint256 needId, uint256 changeId) external;

    /// @notice The need's payment plan: every payee and its share of each tranche.
    function payeesOf(uint256 needId) external view returns (PayeeShare[] memory);

    /// @notice Who a tranche pays and how it is split, with the NGO's share resolved to its payout Safe and zero
    ///         shares left out. Reverts `SupplierInactive` while a supplier with a share has lost its role, so money
    ///         never reaches a de-registered supplier: the NGO must replace it first.
    function trancheSplitOf(uint256 needId, uint256 index)
        external
        view
        returns (address[] memory accounts, uint16[] memory shareBps);

    /// @notice The pending payee change, if any (`id` is zero when none).
    function pendingPayeeChangeOf(uint256 needId) external view returns (PayeeChange memory);

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
    function thirdPartyCostBpsOf(uint256 needId) external view returns (uint16);

    /// @notice When funding closes, or zero for a need that raises until its target is reached.
    function fundingDeadlineOf(uint256 needId) external view returns (uint64);
}
