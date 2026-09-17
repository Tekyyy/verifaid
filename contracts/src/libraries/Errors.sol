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
    error FieldAgentAlreadyBound();
    error FieldAgentNotBound();
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

    // ─── ledgers and vaults ────────────────────────────────────────────────────
    error NotLedger();
    error FundingNotOpen();
    error ExceedsTarget();
    error NothingDonated();
    error PaymentRefAlreadyUsed();
    error DonorRefPartnerMismatch();
    error InvalidTrancheIndex();
    error InvalidTrancheStatus();
    error PreviousTrancheNotReleased();
    error NotRefundable();
    error NothingToRefund();

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
    error DeliveryAlreadyActive();
    error TooFewRecipients();
    error TooManyRecipients();
    error EvidenceMissing();
    error EvidenceAlreadyLinked();
    error VerificationAlreadyLinked();
    error InvalidScope();
    error InvalidMessage();
    error TooManyConfirmations();
    error ChallengePeriodOver();
    error ChallengePeriodActive();
    error AlreadyChallenged();
    error AlreadyRejected();

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

    // ─── resolver ──────────────────────────────────────────────────────────────
    error WrongSchema();
    error InvalidRecipient();
    error InvalidRefUID();
    error ExpiringAttestation();
    error NotRevocable();
    error RegionMismatch();
    error FundingMismatch();
    error FundingAlreadyAttested();
    error FeeExceedsDisclosure();
    error AmountMismatch();
    error SettlementAlreadyRecorded();
    error ReportAlreadyActive();
}
