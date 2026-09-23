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

    // ─── identity ──────────────────────────────────────────────────────────────
    error ProgramNotFound();
    error ProgramInactive();
    error EmptyMembers();

    // ─── deliveries ────────────────────────────────────────────────────────────
    error DeliveryNotFound();
    error InvalidDeliveryStatus();
    /// @dev Only a donor to the need, other than the NGO, its payout address and its payees, may approve its evidence.
    error NotADonor();
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
}
