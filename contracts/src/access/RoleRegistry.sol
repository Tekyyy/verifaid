// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IRoleRegistry} from "../interfaces/IRoleRegistry.sol";
import {Errors} from "../libraries/Errors.sol";
import {Roles} from "../libraries/Roles.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

/// @title RoleRegistry
/// @notice Central role store for Proof of Aid. Every other contract calls `hasRole` / helper views on it.
/// @dev The admin is a Safe multisig in production and the deployer EOA on testnets.
///      Operational roles can only be assigned through the registration functions so that the
///      "one address, one role" rule and NGO/field-agent bindings are always enforced.
contract RoleRegistry is IRoleRegistry, AccessControl, Pausable {
    bytes32 public constant NGO_ROLE = Roles.NGO_ROLE;
    bytes32 public constant VERIFIER_ROLE = Roles.VERIFIER_ROLE;
    bytes32 public constant FIELD_AGENT_ROLE = Roles.FIELD_AGENT_ROLE;
    bytes32 public constant BANK_PARTNER_ROLE = Roles.BANK_PARTNER_ROLE;
    bytes32 public constant SUPPLIER_ROLE = Roles.SUPPLIER_ROLE;

    /// @notice NGO profiles (organization data only).
    mapping(address => NgoProfile) public ngos;

    /// @inheritdoc IRoleRegistry
    mapping(address => address) public fieldAgentNgo;

    /// @notice True for addresses registered as some NGO's payout Safe (they may not hold other roles).
    mapping(address => bool) public isPayoutAddress;

    /// @notice The operational role an address has ever held, kept after the role is removed. "One address, one
    ///         role" is a rule about the address's history, not only about its live roles.
    mapping(address => bytes32) public everHeldRole;

    /// @param admin Initial holder of DEFAULT_ADMIN_ROLE.
    constructor(address admin) {
        if (admin == address(0)) revert Errors.ZeroAddress();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    // ─── admin: registration ───────────────────────────────────────────────────

    /// @inheritdoc IRoleRegistry
    function registerNgo(address ngo, address payout, bytes32 credentialHash, string calldata uri)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        if (ngo == address(0) || payout == address(0)) revert Errors.ZeroAddress();
        if (credentialHash == bytes32(0)) revert Errors.InvalidParameter();
        if (ngos[ngo].payoutAddress != address(0)) revert Errors.AlreadyRegistered();
        _claimOperationalRole(ngo, NGO_ROLE);
        // An NGO may pay out to itself (a single-address NGO on a testnet), but a payout Safe may not double as
        // any other participant — including another NGO or another NGO's payout, which would let two nominally
        // independent organizations share one treasury.
        if (payout != ngo) _requireNoOperationalRole(payout, bytes32(0));

        ngos[ngo] = NgoProfile({active: true, payoutAddress: payout, credentialHash: credentialHash, metadataURI: uri});
        isPayoutAddress[payout] = true;
        _grantRole(NGO_ROLE, ngo);
        emit NgoRegistered(ngo, payout, credentialHash, uri);
    }

    /// @inheritdoc IRoleRegistry
    function setNgoActive(address ngo, bool active) external onlyRole(DEFAULT_ADMIN_ROLE) {
        NgoProfile storage profile = ngos[ngo];
        if (profile.payoutAddress == address(0)) revert Errors.NgoNotRegistered();
        profile.active = active;
        emit NgoStatusChanged(ngo, active);
    }

    /// @inheritdoc IRoleRegistry
    function registerVerifier(address verifier) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (verifier == address(0)) revert Errors.ZeroAddress();
        if (hasRole(VERIFIER_ROLE, verifier)) revert Errors.AlreadyRegistered();
        _claimOperationalRole(verifier, VERIFIER_ROLE);
        _grantRole(VERIFIER_ROLE, verifier);
        emit VerifierRegistered(verifier);
    }

    /// @inheritdoc IRoleRegistry
    function removeVerifier(address verifier) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (!_revokeRole(VERIFIER_ROLE, verifier)) revert Errors.InvalidParameter();
        emit VerifierRemoved(verifier);
    }

    /// @inheritdoc IRoleRegistry
    function registerBankPartner(address partner) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (partner == address(0)) revert Errors.ZeroAddress();
        if (hasRole(BANK_PARTNER_ROLE, partner)) revert Errors.AlreadyRegistered();
        _claimOperationalRole(partner, BANK_PARTNER_ROLE);
        _grantRole(BANK_PARTNER_ROLE, partner);
        emit BankPartnerRegistered(partner);
    }

    /// @inheritdoc IRoleRegistry
    function removeBankPartner(address partner) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (!_revokeRole(BANK_PARTNER_ROLE, partner)) revert Errors.InvalidParameter();
        emit BankPartnerRemoved(partner);
    }

    /// @inheritdoc IRoleRegistry
    /// @dev A supplier is a separate party by construction: it cannot also be an NGO, a payout Safe, a verifier,
    ///      a payment provider or a field agent, so an NGO cannot list its own treasury as a "supplier".
    function registerSupplier(address supplier, bytes32 credentialHash, string calldata uri)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        if (supplier == address(0)) revert Errors.ZeroAddress();
        if (credentialHash == bytes32(0)) revert Errors.InvalidParameter();
        if (hasRole(SUPPLIER_ROLE, supplier)) revert Errors.AlreadyRegistered();
        _claimOperationalRole(supplier, SUPPLIER_ROLE);
        _grantRole(SUPPLIER_ROLE, supplier);
        emit SupplierRegistered(supplier, credentialHash, uri);
    }

    /// @inheritdoc IRoleRegistry
    function removeSupplier(address supplier) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (!_revokeRole(SUPPLIER_ROLE, supplier)) revert Errors.InvalidParameter();
        emit SupplierRemoved(supplier);
    }

    /// @inheritdoc IRoleRegistry
    function pause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _pause();
    }

    /// @inheritdoc IRoleRegistry
    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }

    // ─── NGO: field agents ─────────────────────────────────────────────────────

    /// @inheritdoc IRoleRegistry
    function addFieldAgent(address agent) external {
        if (!isActiveNgo(msg.sender)) revert Errors.Unauthorized();
        if (agent == address(0)) revert Errors.ZeroAddress();
        if (fieldAgentNgo[agent] != address(0)) revert Errors.FieldAgentAlreadyBound();
        _claimOperationalRole(agent, FIELD_AGENT_ROLE);

        fieldAgentNgo[agent] = msg.sender;
        _grantRole(FIELD_AGENT_ROLE, agent);
        emit FieldAgentAdded(msg.sender, agent);
    }

    /// @inheritdoc IRoleRegistry
    function removeFieldAgent(address agent) external {
        if (fieldAgentNgo[agent] != msg.sender || msg.sender == address(0)) revert Errors.FieldAgentNotBound();
        delete fieldAgentNgo[agent];
        _revokeRole(FIELD_AGENT_ROLE, agent);
        emit FieldAgentRemoved(msg.sender, agent);
    }

    // ─── AccessControl hardening ───────────────────────────────────────────────

    /// @notice Only DEFAULT_ADMIN_ROLE can be granted directly; operational roles use the registration functions.
    function grantRole(bytes32 role, address account) public override(AccessControl, IAccessControl) {
        if (role != DEFAULT_ADMIN_ROLE) revert Errors.UseRegistrationFunction();
        super.grantRole(role, account);
    }

    /// @notice Only DEFAULT_ADMIN_ROLE can be revoked directly; operational roles use the removal functions.
    function revokeRole(bytes32 role, address account) public override(AccessControl, IAccessControl) {
        if (role != DEFAULT_ADMIN_ROLE) revert Errors.UseRegistrationFunction();
        super.revokeRole(role, account);
    }

    /// @notice Operational roles cannot be renounced, only removed by the admin.
    /// @dev Renouncing NGO_ROLE used to be an irreversible self-brick: `isActiveNgo` would stay false forever
    ///      (re-registration reverts because the profile persists, and `grantRole` is blocked), which froze
    ///      every one of that NGO's vaults — including needs whose pre-financing had already been spent.
    function renounceRole(bytes32 role, address callerConfirmation) public override(AccessControl, IAccessControl) {
        if (role != DEFAULT_ADMIN_ROLE) revert Errors.UseRegistrationFunction();
        super.renounceRole(role, callerConfirmation);
    }

    // ─── views ─────────────────────────────────────────────────────────────────

    /// @inheritdoc IRoleRegistry
    /// @dev Independence = holds VERIFIER_ROLE, is not the NGO, not the NGO's payout Safe, and not one of its field agents.
    function isIndependent(address verifier, address ngo) external view returns (bool) {
        return hasRole(VERIFIER_ROLE, verifier) && verifier != ngo && verifier != ngos[ngo].payoutAddress
            && fieldAgentNgo[verifier] != ngo;
    }

    /// @inheritdoc IRoleRegistry
    function isActiveNgo(address ngo) public view returns (bool) {
        return ngos[ngo].active && hasRole(NGO_ROLE, ngo);
    }

    /// @inheritdoc IRoleRegistry
    function isFieldAgentOf(address agent, address ngo) external view returns (bool) {
        return ngo != address(0) && fieldAgentNgo[agent] == ngo && hasRole(FIELD_AGENT_ROLE, agent);
    }

    /// @inheritdoc IRoleRegistry
    function isAdmin(address account) external view returns (bool) {
        return hasRole(DEFAULT_ADMIN_ROLE, account);
    }

    /// @inheritdoc IRoleRegistry
    function isActiveSupplier(address supplier) external view returns (bool) {
        return hasRole(SUPPLIER_ROLE, supplier);
    }

    /// @inheritdoc IRoleRegistry
    function payoutOf(address ngo) external view returns (address) {
        return ngos[ngo].payoutAddress;
    }

    /// @inheritdoc IRoleRegistry
    function paused() public view override(IRoleRegistry, Pausable) returns (bool) {
        return super.paused();
    }

    // ─── internal ──────────────────────────────────────────────────────────────

    /// @dev "One address, one role", for the address's whole history: claims `role` for `account` or reverts.
    function _claimOperationalRole(address account, bytes32 role) internal {
        _requireNoOperationalRole(account, role);
        if (everHeldRole[account] == bytes32(0)) everHeldRole[account] = role;
    }

    /// @dev An address may hold at most one operational role, and may never be re-registered under a different
    ///      one: without the memory, an NGO could remove its own field agent and have the admin register that
    ///      same address as an "independent" supplier, taking the share the NGO cap exists to bound.
    function _requireNoOperationalRole(address account, bytes32 role) internal view {
        bytes32 everHeld = everHeldRole[account];
        if (everHeld != bytes32(0) && everHeld != role) revert Errors.RoleConflict();
        if (
            hasRole(NGO_ROLE, account) || hasRole(VERIFIER_ROLE, account) || hasRole(BANK_PARTNER_ROLE, account)
                || hasRole(SUPPLIER_ROLE, account) || fieldAgentNgo[account] != address(0)
                || ngos[account].payoutAddress != address(0) || isPayoutAddress[account]
        ) revert Errors.RoleConflict();
    }
}
