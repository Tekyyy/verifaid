// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ITrancheLedger} from "./ITrancheLedger.sol";

/// @title IAidVault
/// @notice Custodial ledger (`CustodyMode.OnChain`): per-need escrow that holds stablecoin donations and releases
///         them in tranches.
interface IAidVault is ITrancheLedger {
    event Donated(uint256 indexed needId, address indexed donor, uint256 amount, uint256 receiptId);
    event DonatedOnBehalf(
        uint256 indexed needId, address indexed partner, uint256 amount, bytes32 donorRefHash, bytes32 paymentRefHash
    );
    /// @notice A converted donation delivered by a DonationForwarder (card on-ramp or wallet in another token).
    /// @param receiptTo Wallet credited with the donation and its receipt; zero when the forwarder holds the claim.
    event DonatedVia(
        uint256 indexed needId,
        address indexed forwarder,
        address indexed receiptTo,
        uint256 amount,
        uint256 conversionFee,
        uint256 receiptId
    );
    event Refunded(uint256 indexed needId, address indexed account, uint256 amount);
    event RefundedByRef(uint256 indexed needId, bytes32 indexed donorRefHash, address indexed to, uint256 amount);
    /// @notice Part of a released tranche paid straight to a payee of the need's payment plan.
    event PayeePaid(uint256 indexed needId, uint256 indexed index, address indexed payee, uint256 amount);
    /// @notice Part of a released tranche the token would not deliver (a frozen address); kept for the payee.
    event PaymentHeld(uint256 indexed needId, uint256 indexed index, address indexed payee, uint256 amount);
    event HeldPaymentClaimed(uint256 indexed needId, address indexed payee, uint256 amount);
    /// @notice A donor took back part or all of a donation while the need was still raising.
    event DonationWithdrawn(uint256 indexed needId, address indexed donor, uint256 indexed receiptId, uint256 amount);
    /// @notice A held payment moved to the payee that replaced the one it was owed to.
    event HeldPaymentReassigned(uint256 indexed needId, address indexed from, address indexed to, uint256 amount);

    /// @notice Donates `amount` stablecoin (requires prior approval) and mints a soulbound receipt to the caller.
    function donate(uint256 amount) external returns (uint256 receiptId);

    /// @notice Deposits a fiat donation converted to stablecoin by a payment provider (BANK_PARTNER_ROLE).
    function donateOnBehalf(uint256 amount, bytes32 donorRefHash, bytes32 paymentRefHash) external;

    /// @notice Deposits a converted donation. Callable only by forwarders from the DonationForwarderFactory.
    ///         With a `receiptTo` wallet the donation is credited to it and receipted; otherwise it is credited to
    ///         the forwarder, which alone can claim its refund. `conversionFee` counts against the cost cap.
    function donateVia(uint256 amount, uint256 conversionFee, address receiptTo) external returns (uint256 receiptId);

    /// @notice Pays a releasable tranche straight to the payees of the need's payment plan, split as the plan says
    ///         (the NGO receives only its disclosed share). Callable by anyone. `TrancheReleased.to` is zero: the
    ///         recipients are in the `PayeePaid` events that follow.
    function releaseTranche(uint256 index) external;

    /// @notice Takes back `amount` of the donation `receiptId` records, while the need is still raising.
    /// @dev Only the receipt's owner, only while funding is open, and not within `WITHDRAW_LOCK_PERIOD` of the
    ///      funding deadline: an NGO decides whether to go ahead on a number that is settled. Once funding
    ///      closes the money is committed to the need's payment plan and only refunds can return it.
    function withdrawDonation(uint256 receiptId, uint256 amount) external;

    /// @notice Sends a payee the payments that were held for it. Callable by anyone; it only ever pays the payee.
    function claimHeldPayment(address payee) external returns (uint256 amount);

    /// @notice Moves what is held for `from` to `to`. Only the needs registry, when verifiers approve a change.
    function onPayeeChanged(address from, address to) external;

    /// @notice Released money not yet delivered to `payee` (the token refused the transfer).
    function heldPaymentOf(address payee) external view returns (uint256);

    /// @notice All held payments. Released, so never refundable: they belong to their payees.
    function totalHeld() external view returns (uint256);

    /// @notice Pro-rata refund of the unreleased balance to a direct donor of a cancelled or expired need.
    function claimRefund() external returns (uint256 amount);

    /// @notice Pro-rata refund for a fiat donor, executed by the provider that deposited it.
    function claimRefundByRef(bytes32 donorRefHash, address to) external returns (uint256 amount);

    function totalRefunded() external view returns (uint256);

    /// @notice True if `paymentRefHash` was deposited by `partner` for `donorRefHash` with exactly `amount`.
    function fiatDepositMatches(bytes32 paymentRefHash, address partner, bytes32 donorRefHash, uint256 amount)
        external
        view
        returns (bool);
}
