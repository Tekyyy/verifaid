// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {RoleAware} from "../access/RoleAware.sol";
import {IBeneficiaryRegistry} from "../interfaces/IBeneficiaryRegistry.sol";
import {INeedsRegistry} from "../interfaces/INeedsRegistry.sol";
import {IProgramRegistry} from "../interfaces/IProgramRegistry.sol";
import {IRoleRegistry} from "../interfaces/IRoleRegistry.sol";
import {Errors} from "../libraries/Errors.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";

/// @title BeneficiaryRegistry
/// @notice Lets a person an NGO has certified post a need of their own, and holds the NGOs' withdrawals of
///         certification.
///
///         Each NGO keeps its beneficiaries in its own encrypted records, never here. For a wallet it has certified,
///         the NGO signs a `Certification`: this wallet, in this programme of ours, from `issuedAt` until
///         `expiresAt`. The beneficiary presents it when posting a need. Until they do, nothing on chain says the
///         wallet has anything to do with the NGO; posting a need is the beneficiary's own choice to appear.
///
///         The need itself is an ordinary one: independent verifiers attest it before it can raise money, it pays by
///         tranches, and each tranche after the first waits for evidence judged under the need's release policy. What
///         differs is who owns it — the beneficiary files the evidence and receives the need's own share, which may
///         be all of it — and that the certifying NGO stays accountable for it: a suspended NGO freezes its
///         beneficiaries' needs exactly as it freezes its own.
///
///         A person's need is a person's size, and an NGO's certificates open only so many at once. The whole of a
///         beneficiary's need may be paid to the beneficiary, where an NGO's own need keeps at most 25% for the NGO and
///         pays the rest to vetted suppliers; an NGO certifying wallets it secretly controls would get round that cap.
///         Nothing on chain can tell a real person's wallet from such a wallet — the independent verifiers who attest
///         each need are the check — but two limits bound what the trick could take: a beneficiary's need raises at
///         most the high-value threshold (what one verifier may attest; bigger needs are the NGO's own, with
///         suppliers), and one NGO's certificates have at most `MAX_OPEN_NEEDS_PER_NGO` needs open at a time.
/// @dev What "certified" requires the NGO to have checked is deliberately not decided here. A later certification
///      scheme can tighten what an NGO must do before it signs without touching the needs already posted.
contract BeneficiaryRegistry is IBeneficiaryRegistry, RoleAware, EIP712 {
    bytes32 public constant CERTIFICATION_TYPEHASH =
        keccak256("Certification(address beneficiary,address ngo,uint256 programId,uint64 issuedAt,uint64 expiresAt)");
    /// @notice Beneficiary needs one NGO's certificates may have open (not yet completed, cancelled or expired).
    uint256 public constant MAX_OPEN_NEEDS_PER_NGO = 20;

    /// @inheritdoc IBeneficiaryRegistry
    INeedsRegistry public immutable registry;
    IProgramRegistry public immutable programs;

    /// @inheritdoc IBeneficiaryRegistry
    mapping(address => mapping(address => uint64)) public revokedAt;
    /// @inheritdoc IBeneficiaryRegistry
    mapping(address => uint256) public lastNeedOf;
    /// @dev Needs posted under each NGO's certificates that were open when last looked at; pruned on every post.
    mapping(address => uint256[]) internal _needsOf;

    constructor(IRoleRegistry roles_, INeedsRegistry registry_, IProgramRegistry programs_)
        RoleAware(roles_)
        EIP712("VerifAid Beneficiaries", "1")
    {
        if (address(registry_) == address(0) || address(programs_) == address(0)) {
            revert Errors.ZeroAddress();
        }
        registry = registry_;
        programs = programs_;
    }

    // ─── beneficiaries ─────────────────────────────────────────────────────────

    /// @inheritdoc IBeneficiaryRegistry
    /// @dev One open need at a time keeps a certificate from turning into a stream of needs for verifiers to wade
    ///      through; when the last one is completed, cancelled or expired, the beneficiary can post the next.
    function createNeed(INeedsRegistry.CreateNeedParams calldata p, Certification calldata c, bytes calldata signature)
        external
        whenNotPaused
        returns (uint256 needId)
    {
        if (msg.sender != c.beneficiary) revert Errors.Unauthorized();
        if (p.programId != c.programId) revert Errors.ProgramMismatch();
        if (p.targetAmount > registry.HIGH_VALUE_THRESHOLD()) revert Errors.BeneficiaryNeedTooLarge();
        bytes4 failure = _failure(c, signature);
        if (failure != bytes4(0)) _revert(failure);
        uint256 last = lastNeedOf[msg.sender];
        if (last != 0 && !_isOver(registry.statusOf(last))) revert Errors.OpenNeedExists();

        needId = registry.createBeneficiaryNeed(p, c.ngo, msg.sender);
        lastNeedOf[msg.sender] = needId;
        _pruneAndAdd(c.ngo, needId);
        emit BeneficiaryNeedPosted(needId, msg.sender, c.ngo, c.programId, c.issuedAt);
    }

    // ─── NGOs ──────────────────────────────────────────────────────────────────

    /// @inheritdoc IBeneficiaryRegistry
    /// @dev Open to a suspended NGO too: withdrawing trust is always allowed. The wallet it names becomes public,
    ///      which is the price of revoking before expiry; short-lived certificates are the quiet alternative.
    function revoke(address beneficiary) external {
        if (roles.payoutOf(msg.sender) == address(0)) revert Errors.NgoNotRegistered();
        if (beneficiary == address(0)) revert Errors.ZeroAddress();
        revokedAt[msg.sender][beneficiary] = uint64(block.timestamp);
        emit CertificationRevoked(msg.sender, beneficiary);
    }

    // ─── views ─────────────────────────────────────────────────────────────────

    /// @inheritdoc IBeneficiaryRegistry
    function openNeedsOf(address ngo) public view returns (uint256 open) {
        uint256[] storage ids = _needsOf[ngo];
        for (uint256 i; i < ids.length; ++i) {
            if (!_isOver(registry.statusOf(ids[i]))) ++open;
        }
    }

    /// @inheritdoc IBeneficiaryRegistry
    function isCertified(Certification calldata c, bytes calldata signature) external view returns (bool) {
        return _failure(c, signature) == bytes4(0);
    }

    /// @inheritdoc IBeneficiaryRegistry
    function certificationDigest(Certification calldata c) public view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(abi.encode(CERTIFICATION_TYPEHASH, c.beneficiary, c.ngo, c.programId, c.issuedAt, c.expiresAt))
        );
    }

    /// @notice The EIP-712 domain separator certificates are signed under.
    // forge-lint: disable-next-line(mixed-case-function)
    function DOMAIN_SEPARATOR() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    // ─── internal ──────────────────────────────────────────────────────────────

    /// @dev Why `c` would be refused right now, as an error selector, or zero when it would be accepted. One list of
    ///      checks serves both the transaction and the view the app asks before a beneficiary fills in a form.
    function _failure(Certification calldata c, bytes calldata signature) internal view returns (bytes4) {
        if (c.beneficiary == address(0) || c.ngo == address(0)) return Errors.ZeroAddress.selector;
        if (c.expiresAt <= c.issuedAt) return Errors.InvalidParameter.selector;
        if (block.timestamp < c.issuedAt || block.timestamp >= c.expiresAt) {
            return Errors.CertificationExpired.selector;
        }
        // Issued in the same second as a withdrawal counts as withdrawn: the NGO has to mean the new one.
        if (c.issuedAt <= revokedAt[c.ngo][c.beneficiary]) return Errors.CertificationRevoked.selector;
        if (!roles.isActiveNgo(c.ngo)) return Errors.NgoInactive.selector;
        if (programs.programNgo(c.programId) != c.ngo) return Errors.ProgramMismatch.selector;
        if (!programs.isProgramActive(c.programId)) return Errors.ProgramInactive.selector;
        // An NGO, a verifier, a supplier or a payout Safe is a participant, not a person the aid is for: letting one
        // post as a beneficiary would let it own a need its own role is meant to check or be paid by.
        if (roles.holdsOperationalRole(c.beneficiary)) return Errors.RoleConflict.selector;
        if (openNeedsOf(c.ngo) >= MAX_OPEN_NEEDS_PER_NGO) return Errors.TooManyOpenNeeds.selector;
        if (!SignatureChecker.isValidSignatureNow(c.ngo, certificationDigest(c), signature)) {
            return Errors.InvalidSignature.selector;
        }
        return bytes4(0);
    }

    /// @dev Drops the NGO's needs that are over and records the new one, so the list never holds more than the cap.
    function _pruneAndAdd(address ngo, uint256 needId) internal {
        uint256[] storage ids = _needsOf[ngo];
        uint256 kept;
        for (uint256 i; i < ids.length; ++i) {
            uint256 id = ids[i];
            if (!_isOver(registry.statusOf(id))) ids[kept++] = id;
        }
        while (ids.length > kept) ids.pop();
        ids.push(needId);
    }

    function _revert(bytes4 selector) internal pure {
        assembly ("memory-safe") {
            mstore(0, selector)
            revert(0, 4)
        }
    }

    function _isOver(INeedsRegistry.NeedStatus s) internal pure returns (bool) {
        return s == INeedsRegistry.NeedStatus.Completed || s == INeedsRegistry.NeedStatus.Cancelled
            || s == INeedsRegistry.NeedStatus.Expired;
    }
}
