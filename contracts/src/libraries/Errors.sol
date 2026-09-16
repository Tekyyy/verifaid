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

    // ─── vaults ────────────────────────────────────────────────────────────────
    error AlreadyInitialized();
    error VaultAlreadyExists();
    error FundingNotOpen();
    error ExceedsTarget();
    error NothingDonated();
    error PaymentRefAlreadyUsed();
    error DonorRefPartnerMismatch();
    error InvalidTrancheIndex();
    error InvalidTrancheStatus();
    error PreviousTrancheNotReleased();
    error NotCancelled();
    error NothingToRefund();
    error RefundAlreadyClaimed();

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

    // ─── resolvers ─────────────────────────────────────────────────────────────
    error WrongSchema();
    error InvalidRecipient();
    error InvalidRefUID();
    error ExpiringAttestation();
    error NotRevocable();
    error RegionMismatch();
    error FiatDonationMismatch();
    error FiatDonationAlreadyAttested();
    error ReportAlreadyActive();
}
