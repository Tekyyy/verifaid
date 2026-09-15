// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {RoleAware} from "../access/RoleAware.sol";
import {IAidVault} from "../interfaces/IAidVault.sol";
import {IAidVaultFactory} from "../interfaces/IAidVaultFactory.sol";
import {IBeneficiaryGroups} from "../interfaces/IBeneficiaryGroups.sol";
import {INeedsRegistry} from "../interfaces/INeedsRegistry.sol";
import {IRoleRegistry} from "../interfaces/IRoleRegistry.sol";
import {Errors} from "../libraries/Errors.sol";

/// @title NeedsRegistry
/// @notice Registers previously verified needs and drives their lifecycle:
///         Pending → Verified → Funding → Funded → InDelivery → Completed (or Cancelled).
/// @dev Verification happens through EAS `NeedVerified` attestations; the resolver forwards them here.
contract NeedsRegistry is INeedsRegistry, RoleAware {
    uint16 public constant BPS_DENOMINATOR = 10_000;
    uint256 public constant MAX_TRANCHES = 5;

    /// @notice Needs with `targetAmount` above this value require at least two independent verifications.
    uint256 public immutable HIGH_VALUE_THRESHOLD;

    IAidVaultFactory public vaultFactory;
    IBeneficiaryGroups public beneficiaryGroups;
    address public deliveryManager;
    address public needVerifiedResolver;
    bool public wired;

    /// @inheritdoc INeedsRegistry
    uint256 public needCount;

    mapping(uint256 => Need) private _needs;

    /// @notice needId => verifier => has a live (non-revoked) verification recorded.
    mapping(uint256 => mapping(address => bool)) public verifiedBy;

    /// @notice needId => verifier => UID of the recorded NeedVerified attestation.
    mapping(uint256 => mapping(address => bytes32)) public verificationUID;

    /// @param roles_ System role registry.
    /// @param highValueThreshold Target amount (base units) above which M-of-N (M ≥ 2) verification is enforced.
    constructor(IRoleRegistry roles_, uint256 highValueThreshold) RoleAware(roles_) {
        HIGH_VALUE_THRESHOLD = highValueThreshold;
    }

    /// @notice One-time wiring of the contracts this registry depends on. Admin only.
    function wire(address vaultFactory_, address beneficiaryGroups_, address deliveryManager_, address resolver_)
        external
        onlyAdmin
    {
        if (wired) revert Errors.AlreadyWired();
        if (
            vaultFactory_ == address(0) || beneficiaryGroups_ == address(0) || deliveryManager_ == address(0)
                || resolver_ == address(0)
        ) revert Errors.ZeroAddress();
        wired = true;
        vaultFactory = IAidVaultFactory(vaultFactory_);
        beneficiaryGroups = IBeneficiaryGroups(beneficiaryGroups_);
        deliveryManager = deliveryManager_;
        needVerifiedResolver = resolver_;
        emit Wired(vaultFactory_, beneficiaryGroups_, deliveryManager_, resolver_);
    }

    // ─── NGO ───────────────────────────────────────────────────────────────────

    /// @inheritdoc INeedsRegistry
    function createNeed(CreateNeedParams calldata p) external whenNotPaused returns (uint256 needId) {
        if (!wired) revert Errors.NotWired();
        if (!roles.isActiveNgo(msg.sender)) revert Errors.Unauthorized();
        if (beneficiaryGroups.programNgo(p.programId) != msg.sender) revert Errors.ProgramMismatch();
        if (p.targetAmount == 0) revert Errors.ZeroAmount();
        if (p.category == bytes32(0) || p.regionCode == bytes32(0) || p.dossierHash == bytes32(0)) {
            revert Errors.InvalidParameter();
        }
        _validateTranches(p.trancheBps);
        if (p.verificationsRequired == 0 || (p.targetAmount > HIGH_VALUE_THRESHOLD && p.verificationsRequired < 2)) {
            revert Errors.InsufficientVerifications();
        }

        needId = ++needCount;
        Need storage n = _needs[needId];
        n.id = needId;
        n.ngo = msg.sender;
        n.programId = p.programId;
        n.category = p.category;
        n.targetAmount = p.targetAmount;
        n.regionCode = p.regionCode;
        n.dossierHash = p.dossierHash;
        n.metadataURI = p.metadataURI;
        n.verificationsRequired = p.verificationsRequired;
        n.trancheBps = p.trancheBps;
        n.status = NeedStatus.Pending;
        n.createdAt = uint64(block.timestamp);

        _emitNeedCreated(n);
    }

    /// @inheritdoc INeedsRegistry
    function cancelNeed(uint256 needId) external {
        Need storage n = _need(needId);
        NeedStatus s = n.status;
        if (s == NeedStatus.Completed || s == NeedStatus.Cancelled) revert Errors.InvalidNeedStatus();
        if (!roles.isAdmin(msg.sender)) {
            if (msg.sender != n.ngo) revert Errors.Unauthorized();
            // NGOs may only cancel before funding closes; afterwards cancellation is an admin (dispute) decision.
            if (uint8(s) >= uint8(NeedStatus.Funded)) revert Errors.InvalidNeedStatus();
        }
        _cancel(n, msg.sender);
    }

    // ─── resolver callbacks ────────────────────────────────────────────────────

    /// @inheritdoc INeedsRegistry
    function onVerificationAttested(uint256 needId, address verifier, bool approved, bytes32 attestationUID)
        external
        whenNotPaused
    {
        if (msg.sender != needVerifiedResolver || msg.sender == address(0)) revert Errors.Unauthorized();
        Need storage n = _need(needId);
        if (n.status != NeedStatus.Pending) revert Errors.InvalidNeedStatus();
        if (!roles.isIndependent(verifier, n.ngo)) revert Errors.NotIndependent();
        if (verifiedBy[needId][verifier]) revert Errors.AlreadyVerified();

        verifiedBy[needId][verifier] = true;
        verificationUID[needId][verifier] = attestationUID;

        if (!approved) {
            // A rejection by an independent verifier blocks the need; the NGO must create a new one.
            emit NeedVerificationRecorded(needId, verifier, false, attestationUID, n.verificationCount);
            _cancel(n, verifier);
            return;
        }

        uint8 count = ++n.verificationCount;
        emit NeedVerificationRecorded(needId, verifier, true, attestationUID, count);
        if (count == n.verificationsRequired) _onVerified(n);
    }

    /// @inheritdoc INeedsRegistry
    /// @dev Honored only while `Pending`, or `Funding` with zero donations (the need drops back to `Pending`).
    ///      Otherwise the revocation is logged for the dispute process and state is left untouched.
    function onVerificationRevoked(uint256 needId, address verifier, bytes32 attestationUID) external {
        if (msg.sender != needVerifiedResolver || msg.sender == address(0)) revert Errors.Unauthorized();
        Need storage n = _need(needId);
        if (verificationUID[needId][verifier] != attestationUID) revert Errors.UnknownVerification();

        bool honored = n.status == NeedStatus.Pending
            || (n.status == NeedStatus.Funding && IAidVault(n.vault).totalDonated() == 0);
        if (!honored) {
            emit VerificationRevokedAfterFunding(needId, verifier, attestationUID);
            return;
        }

        // In Pending/Funding every recorded verification is an approval (a rejection cancels the need).
        delete verifiedBy[needId][verifier];
        delete verificationUID[needId][verifier];
        uint8 count = --n.verificationCount;
        emit NeedVerificationRevoked(needId, verifier, attestationUID, count);
        if (n.status == NeedStatus.Funding) _transition(n, NeedStatus.Pending);
    }

    // ─── vault / delivery callbacks ────────────────────────────────────────────

    /// @inheritdoc INeedsRegistry
    function setStatus(uint256 needId, NeedStatus next) external {
        Need storage n = _need(needId);
        if (msg.sender != n.vault && msg.sender != deliveryManager) revert Errors.Unauthorized();
        NeedStatus current = n.status;
        bool allowed = (current == NeedStatus.Funding && next == NeedStatus.Funded)
            || (current == NeedStatus.Funded && next == NeedStatus.InDelivery)
            || (current == NeedStatus.InDelivery && next == NeedStatus.Completed);
        if (!allowed) revert Errors.InvalidTransition();
        _transition(n, next);
    }

    // ─── views ─────────────────────────────────────────────────────────────────

    /// @inheritdoc INeedsRegistry
    function getNeed(uint256 needId) external view returns (Need memory) {
        return _need(needId);
    }

    /// @inheritdoc INeedsRegistry
    function statusOf(uint256 needId) external view returns (NeedStatus) {
        return _need(needId).status;
    }

    /// @inheritdoc INeedsRegistry
    function ngoOf(uint256 needId) external view returns (address) {
        return _need(needId).ngo;
    }

    /// @inheritdoc INeedsRegistry
    function vaultOf(uint256 needId) external view returns (address) {
        return _need(needId).vault;
    }

    /// @inheritdoc INeedsRegistry
    function programOf(uint256 needId) external view returns (uint256) {
        return _need(needId).programId;
    }

    /// @inheritdoc INeedsRegistry
    function targetAmountOf(uint256 needId) external view returns (uint256) {
        return _need(needId).targetAmount;
    }

    /// @inheritdoc INeedsRegistry
    function dossierHashOf(uint256 needId) external view returns (bytes32) {
        return _need(needId).dossierHash;
    }

    /// @inheritdoc INeedsRegistry
    function regionCodeOf(uint256 needId) external view returns (bytes32) {
        return _need(needId).regionCode;
    }

    /// @inheritdoc INeedsRegistry
    function trancheBpsOf(uint256 needId) external view returns (uint16[] memory) {
        return _need(needId).trancheBps;
    }

    // ─── internal ──────────────────────────────────────────────────────────────

    function _need(uint256 needId) internal view returns (Need storage n) {
        n = _needs[needId];
        if (n.id == 0) revert Errors.NeedNotFound();
    }

    function _validateTranches(uint16[] calldata bps) internal pure {
        uint256 len = bps.length;
        if (len == 0 || len > MAX_TRANCHES) revert Errors.InvalidTrancheSplit();
        uint256 sum;
        for (uint256 i; i < len; ++i) {
            if (bps[i] == 0) revert Errors.InvalidTrancheSplit();
            sum += bps[i];
        }
        if (sum != BPS_DENOMINATOR) revert Errors.InvalidTrancheSplit();
    }

    /// @dev Verification threshold reached: deploy (or reuse) the vault and open funding.
    function _onVerified(Need storage n) internal {
        _transition(n, NeedStatus.Verified);
        if (n.vault == address(0)) n.vault = vaultFactory.createVault(n.id);
        emit NeedVerified(n.id, n.vault);
        _transition(n, NeedStatus.Funding);
    }

    function _cancel(Need storage n, address by) internal {
        _transition(n, NeedStatus.Cancelled);
        emit NeedCancelled(n.id, by);
    }

    function _transition(Need storage n, NeedStatus next) internal {
        emit NeedStatusChanged(n.id, n.status, next);
        n.status = next;
    }

    function _emitNeedCreated(Need storage n) internal {
        emit NeedCreated(
            n.id,
            n.ngo,
            n.programId,
            n.category,
            n.targetAmount,
            n.regionCode,
            n.dossierHash,
            n.verificationsRequired,
            n.trancheBps,
            n.metadataURI
        );
    }
}
