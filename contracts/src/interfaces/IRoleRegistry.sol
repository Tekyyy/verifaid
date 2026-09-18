// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";

/// @title IRoleRegistry
/// @notice Central role store consulted by all Proof of Aid contracts.
interface IRoleRegistry is IAccessControl {
    /// @notice Public, organization-level profile of a registered NGO. Never contains personal data.
    struct NgoProfile {
        bool active;
        address payoutAddress; // Safe that receives released tranches
        bytes32 credentialHash; // hash of the legal registration credential / charity number document
        string metadataURI; // public profile JSON (name, country, website)
    }

    event NgoRegistered(address indexed ngo, address indexed payoutAddress, bytes32 credentialHash, string metadataURI);
    event NgoStatusChanged(address indexed ngo, bool active);
    event VerifierRegistered(address indexed verifier);
    event VerifierRemoved(address indexed verifier);
    event BankPartnerRegistered(address indexed partner);
    event BankPartnerRemoved(address indexed partner);
    event FieldAgentAdded(address indexed ngo, address indexed agent);
    event FieldAgentRemoved(address indexed ngo, address indexed agent);
    event SupplierRegistered(address indexed supplier, bytes32 credentialHash, string metadataURI);
    event SupplierRemoved(address indexed supplier);

    /// @notice Registers an NGO and grants it NGO_ROLE. Admin only.
    function registerNgo(address ngo, address payout, bytes32 credentialHash, string calldata uri) external;

    /// @notice Activates or deactivates a registered NGO. Admin only.
    function setNgoActive(address ngo, bool active) external;

    /// @notice Grants VERIFIER_ROLE. Admin only.
    function registerVerifier(address verifier) external;

    /// @notice Revokes VERIFIER_ROLE. Admin only.
    function removeVerifier(address verifier) external;

    /// @notice Grants BANK_PARTNER_ROLE. Admin only.
    function registerBankPartner(address partner) external;

    /// @notice Revokes BANK_PARTNER_ROLE. Admin only.
    function removeBankPartner(address partner) external;

    /// @notice Grants SUPPLIER_ROLE to a vetted service provider a vault may pay directly. Admin only.
    /// @param credentialHash Hash of the supplier's company registration / due-diligence file.
    /// @param uri Public profile JSON (legal name, country, what it supplies).
    function registerSupplier(address supplier, bytes32 credentialHash, string calldata uri) external;

    /// @notice Revokes SUPPLIER_ROLE: vaults stop paying it until the NGO replaces it. Admin only.
    function removeSupplier(address supplier) external;

    /// @notice True if `supplier` currently holds SUPPLIER_ROLE.
    function isActiveSupplier(address supplier) external view returns (bool);

    /// @notice Binds a field agent to the calling (active) NGO.
    function addFieldAgent(address agent) external;

    /// @notice Unbinds a field agent from the calling NGO.
    function removeFieldAgent(address agent) external;

    /// @notice Pauses every pausable action in the system. Admin only.
    function pause() external;

    /// @notice Lifts the global pause. Admin only.
    function unpause() external;

    /// @notice True if `verifier` holds VERIFIER_ROLE and has no relationship with `ngo`.
    function isIndependent(address verifier, address ngo) external view returns (bool);

    /// @notice True if `ngo` holds NGO_ROLE and is active.
    function isActiveNgo(address ngo) external view returns (bool);

    /// @notice True if `agent` holds FIELD_AGENT_ROLE and is bound to `ngo`.
    function isFieldAgentOf(address agent, address ngo) external view returns (bool);

    /// @notice True if `account` is a platform admin.
    function isAdmin(address account) external view returns (bool);

    /// @notice Payout address of a registered NGO (zero if unregistered).
    function payoutOf(address ngo) external view returns (address);

    /// @notice NGO a field agent is bound to (zero if none).
    function fieldAgentNgo(address agent) external view returns (address);

    /// @notice Global pause flag.
    function paused() external view returns (bool);
}
