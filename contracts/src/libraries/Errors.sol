// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title Errors
/// @notice Custom errors shared by every Proof of Aid contract (no revert strings anywhere).
library Errors {
    // ─── generic ───────────────────────────────────────────────────────────────
    error ZeroAddress();
    error ZeroAmount();
    error InvalidParameter();
    error Unauthorized();
    error AlreadyWired();
    error NotWired();
    error SystemPaused();

    // ─── roles ─────────────────────────────────────────────────────────────────
    error UseRegistrationFunction();
    error AlreadyRegistered();
    error NgoNotRegistered();
    error NgoInactive();
    error RoleConflict();
    error NotIndependent();

    // ─── needs ─────────────────────────────────────────────────────────────────
    error NeedNotFound();
    error InvalidTrancheSplit();
    /// @notice A beneficiary's need must keep most of its money behind evidence: two tranches or more, the first at
    ///         most `MAX_BENEFICIARY_FIRST_TRANCHE_BPS`.
    error BeneficiaryPrefinancingTooLarge();
    error InsufficientVerifications();
    error InvalidNeedStatus();
    error InvalidTransition();
    error AlreadyVerified();
    error UnknownVerification();
    error DossierMismatch();
    error ProgramMismatch();
    error DeadlineNotReached();
    error DeadlinePassed();
    error BelowMinimumFunding();
    error ReleasePending();
    error InvalidPaymentPlan();
    error SupplierNotRegistered();
    error SupplierInactive();
    error NgoShareTooHigh();
    error ChangePending();
    error NoPendingChange();
    error AlreadyApproved();

    // ─── ledgers and vaults ────────────────────────────────────────────────────
    error NotLedger();
    error FundingNotOpen();
    /// @notice A donation can no longer be taken back: the funding deadline is too close.
    error WithdrawalLocked();
    error ExceedsTarget();
    error NothingDonated();
    error DonorRefPartnerMismatch();
    error InvalidTrancheIndex();
    error InvalidTrancheStatus();
    error PreviousTrancheNotReleased();
    error NotRefundable();
    error NothingToRefund();
    error NothingToClaim();

    // ─── receipts ──────────────────────────────────────────────────────────────
    error Soulbound();
    error NotVault();

    // ─── programmes ────────────────────────────────────────────────────────────
    error ProgramNotFound();
    error ProgramInactive();

    // ─── beneficiaries ─────────────────────────────────────────────────────────
    /// @dev The NGO's certificate is past its expiry, or not valid yet.
    error CertificationExpired();
    /// @dev The NGO withdrew its certification of this wallet after the certificate was issued.
    error CertificationRevoked();
    /// @dev A beneficiary has one need open at a time; the last one must be over first.
    error OpenNeedExists();

    // ─── community proofs ──────────────────────────────────────────────────────
    error ProofNotFound();
    error BountyNotFound();
    /// @dev A need has one reward pot open at a time; the last one must be closed first.
    error BountyAlreadyOpen();
    error NoOpenBounty();
    /// @dev A wallet is paid once per need, however many proofs it files.
    error AlreadyRewarded();
    /// @dev More reward credit asked for than the wallet holds.
    error InsufficientCredit();
    /// @dev A wallet already filed as many proofs about this need as one wallet may.
    error ProofLimitReached();
    /// @dev A need a person posted for themselves publishes no impact report.
    error ImpactReportNotApplicable();
    /// @dev A beneficiary's own need may raise at most the high-value threshold.
    error BeneficiaryNeedTooLarge();
    /// @dev The NGO's certificates already have as many beneficiary needs open as one NGO may.
    error TooManyOpenNeeds();
    /// @dev Filed after the pot's deadline, which is what the NGO promised to pay for.
    error ProofAfterDeadline();

    // ─── deliveries ────────────────────────────────────────────────────────────
    error DeliveryNotFound();
    error InvalidDeliveryStatus();
    /// @dev The need's release policy gives this address no say on its evidence.
    error NoSay();
    error AlreadyVoted();
    /// @dev Evidence someone already rejected cannot be replaced once the need has no retries left.
    error EvidenceContested();
    /// @dev Not one of the platform's approved release policies, or a policy that gives nobody a say.
    error InvalidReleasePolicy();
    error TooFewRecipients();

    // ─── conversions and forwarders ────────────────────────────────────────────
    error PriceFeedNotSet();
    error StalePrice();
    error InvalidPrice();
    error SequencerDown();
    error RouteNotSet();
    error SlippageTooHigh();
    error InsufficientOutput();
    error NothingToSweep();
    error NotAccepting();
    error InvalidSignature();
    error SignatureExpired();
    error TransferFailed();
    error ChangeNotReady();

    // ─── resolver ──────────────────────────────────────────────────────────────
    error WrongSchema();
    error InvalidRecipient();
    error InvalidRefUID();
    error ExpiringAttestation();
    error NotRevocable();
    error FeeExceedsDisclosure();
    error AmountMismatch();
    error SettlementAlreadyRecorded();
    error ReportAlreadyActive();

    // ─── idle capital (yield sleeve) ───────────────────────────────────────────
    error YieldNotEnabled();
    error YieldVenueChanged();
    error SleeveIlliquid();
    error SleeveNotClosed();
    /// @dev The venue gave the vault shares worth less than the deposit: its share price was being moved.
    error DepositShortfall();
}
