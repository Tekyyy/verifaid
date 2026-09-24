// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IAidVault} from "../interfaces/IAidVault.sol";
import {INeedsRegistry} from "../interfaces/INeedsRegistry.sol";
import {IReleasePolicy} from "../interfaces/IReleasePolicy.sol";
import {IRoleRegistry} from "../interfaces/IRoleRegistry.sol";
import {ITrancheLedger} from "../interfaces/ITrancheLedger.sol";
import {Errors} from "../libraries/Errors.sol";

/// @title ReleasePolicy
/// @notice The built-in rules for unlocking a tranche, one deployment per rule:
///         - donors decide: donors who gave `donorApprovalBps` of the raised amount approve, `donorRejectionBps`
///           reject;
///         - a verifier checks: as many independent verifiers as verified the need approve, or as many reject;
///         - both: the donors *and* the verifiers must approve, and either of them can reject.
///
///         A donor's say weighs what they gave, so splitting one gift across many wallets gains nothing. The NGO,
///         its payout address, the need's payees and the beneficiary who posted it have no say, however much they
///         gave: they would be judging their own accounts. A verifier counts as a verifier, never also as a donor.
contract ReleasePolicy is IReleasePolicy {
    uint16 public constant BPS_DENOMINATOR = 10_000;

    IRoleRegistry public immutable roles;
    INeedsRegistry public immutable registry;

    /// @notice Share of the raised amount whose donors must approve; zero when donors have no say.
    uint16 public immutable donorApprovalBps;
    /// @notice Share of the raised amount whose donors must reject; zero when donors have no say.
    uint16 public immutable donorRejectionBps;
    /// @notice Whether independent verifiers must approve (and may reject).
    bool public immutable verifiers;
    /// @notice Fresh starts the NGO gets on rejected or contested evidence before a rejection cancels the need.
    uint8 public immutable retries;

    string private _name;

    constructor(
        IRoleRegistry roles_,
        INeedsRegistry registry_,
        string memory name_,
        uint16 donorApprovalBps_,
        uint16 donorRejectionBps_,
        bool verifiers_,
        uint8 retries_
    ) {
        if (address(roles_) == address(0) || address(registry_) == address(0)) {
            revert Errors.ZeroAddress();
        }
        if (bytes(name_).length == 0) revert Errors.InvalidParameter();
        if (donorApprovalBps_ > BPS_DENOMINATOR || donorRejectionBps_ > BPS_DENOMINATOR) {
            revert Errors.InvalidParameter();
        }
        // Donors either have both an approval and a rejection threshold, or no say at all; and somebody decides.
        if ((donorApprovalBps_ == 0) != (donorRejectionBps_ == 0)) revert Errors.InvalidParameter();
        if (donorApprovalBps_ == 0 && !verifiers_) revert Errors.InvalidParameter();
        roles = roles_;
        registry = registry_;
        _name = name_;
        donorApprovalBps = donorApprovalBps_;
        donorRejectionBps = donorRejectionBps_;
        verifiers = verifiers_;
        retries = retries_;
    }

    /// @inheritdoc IReleasePolicy
    function name() external view returns (string memory) {
        return _name;
    }

    /// @inheritdoc IReleasePolicy
    /// @dev Donor thresholds are shares of what was raised, which is fixed once funding closes, rounded up so "30%"
    ///      never means a hair less. Verifier thresholds follow the need's own verification requirement, so a
    ///      high-value need that took two verifiers to open also takes two to release.
    function rulesOf(uint256 needId) external view returns (Rules memory r) {
        r.retries = retries;
        if (donorApprovalBps != 0) {
            address vault = registry.vaultOf(needId);
            uint256 raised = vault == address(0) ? 0 : ITrancheLedger(vault).totalDonated();
            r.donorApproval = _share(raised, donorApprovalBps);
            r.donorRejection = _share(raised, donorRejectionBps);
        }
        if (verifiers) {
            uint8 required = registry.verificationsRequiredOf(needId);
            r.verifierApproval = required;
            r.verifierRejection = required;
        }
    }

    /// @inheritdoc IReleasePolicy
    function voiceOf(uint256 needId, address voter) external view returns (Voice, uint256) {
        // The beneficiary who posted the need is judged here, whatever other role their wallet came to hold.
        if (voter == address(0) || voter == registry.beneficiaryOf(needId)) return (Voice.None, 0);
        (address ngo, address vault,,) = registry.coreOf(needId);
        if (verifiers && roles.isIndependent(voter, ngo)) return (Voice.Verifier, 1);
        if (donorApprovalBps == 0 || vault == address(0)) return (Voice.None, 0);
        if (voter == ngo || voter == roles.payoutOf(ngo)) return (Voice.None, 0);
        INeedsRegistry.PayeeShare[] memory payees = registry.payeesOf(needId);
        for (uint256 i; i < payees.length; ++i) {
            if (payees[i].account == voter) return (Voice.None, 0);
        }
        uint256 given = IAidVault(vault).donatedBy(voter);
        return given == 0 ? (Voice.None, 0) : (Voice.Donor, given);
    }

    function _share(uint256 amount, uint16 bps) internal pure returns (uint256) {
        return (amount * bps + BPS_DENOMINATOR - 1) / BPS_DENOMINATOR;
    }
}
