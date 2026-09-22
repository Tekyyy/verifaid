// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {RoleAware} from "../access/RoleAware.sol";
import {IAidVault} from "../interfaces/IAidVault.sol";
import {IAidVaultFactory} from "../interfaces/IAidVaultFactory.sol";
import {IBeneficiaryGroups} from "../interfaces/IBeneficiaryGroups.sol";
import {IDeliveryManager} from "../interfaces/IDeliveryManager.sol";
import {INeedsRegistry} from "../interfaces/INeedsRegistry.sol";
import {IRoleRegistry} from "../interfaces/IRoleRegistry.sol";
import {ITrancheLedger} from "../interfaces/ITrancheLedger.sol";
import {Errors} from "../libraries/Errors.sol";
import {Roles} from "../libraries/Roles.sol";

/// @title NeedsRegistry
/// @notice Registers previously verified needs and drives their lifecycle:
///         Pending → Verified → Funding → Funded → InDelivery → Completed (or Cancelled / Expired).
/// @dev Verification happens through EAS `NeedVerified` attestations; the resolver forwards them here.
///      An on-chain need also carries its payment plan: the registered suppliers its vault pays directly, and the
///      share of each tranche each one receives (the NGO itself at most `MAX_NGO_SHARE_BPS` of the need). The
///      plan is fixed at creation, verified with the rest of the need, and a supplier can only be replaced with
///      the approval of as many independent verifiers as verified the need.
contract NeedsRegistry is INeedsRegistry, RoleAware {
    uint16 public constant BPS_DENOMINATOR = 10_000;
    uint256 public constant MAX_TRANCHES = 5;
    /// @notice Hard cap on disclosed intermediary costs: above 20% a need is not a credible aid channel.
    uint16 public constant MAX_THIRD_PARTY_COST_BPS = 2000;
    /// @notice After the execution deadline, work already done keeps priority over expiry for this long: a
    ///         releasable tranche can still be paid and a verified delivery can still finish its challenge window.
    ///         Bounded, so a tranche nobody can release (a suspended NGO, an absent custodian) cannot block
    ///         refunds forever.
    uint256 public constant EXPIRY_GRACE_PERIOD = 14 days;
    /// @notice Most payees one need can have.
    uint256 public constant MAX_PAYEES = 5;
    /// @notice The most of an on-chain need the NGO may pay to itself (operations, staff, logistics); the rest goes
    ///         straight from the vault to the suppliers named in the plan.
    uint16 public constant MAX_NGO_SHARE_BPS = 2500;
    /// @notice Replacing a supplier always needs at least this many independent verifiers, even on a need that
    ///         one verifier was enough to verify: moving an escrow is a heavier decision than approving it.
    uint8 public constant MIN_PAYEE_CHANGE_APPROVALS = 2;

    /// @notice Needs with `targetAmount` above this value require at least two independent verifications.
    uint256 public immutable HIGH_VALUE_THRESHOLD;

    IAidVaultFactory public vaultFactory;
    IBeneficiaryGroups public beneficiaryGroups;
    address public deliveryManager;
    address public resolver;
    bool public wired;

    /// @inheritdoc INeedsRegistry
    uint256 public needCount;

    /// @dev Packed into five slots (six for off-chain custody). Display-only commitments (category, metadata URI, expected outcome, cost
    ///      disclosure) live in the `NeedCreated` event instead.
    struct NeedRecord {
        // slot 0
        address ngo;
        uint8 verificationsRequired;
        uint8 verificationCount;
        NeedStatus status;
        CustodyMode custodyMode;
        uint16 minFundingBps;
        uint16 thirdPartyCostBps;
        // slot 1
        address vault;
        uint40 fundingDeadline;
        uint40 executionDeadline;
        // slot 2
        uint96 targetAmount;
        uint64 programId;
        uint80 trancheBps; // up to five 16-bit entries, lowest first; every entry is non-zero
        // slots 3-4
        bytes32 regionCode;
        bytes32 dossierHash;
        // slot 5, off-chain custody only
        address custodian;
    }

    mapping(uint256 => NeedRecord) private _needs;

    /// @notice needId => verifier => has a live (non-revoked) verification recorded.
    mapping(uint256 => mapping(address => bool)) public verifiedBy;

    /// @notice needId => verifier => UID of the recorded NeedVerified attestation.
    mapping(uint256 => mapping(address => bytes32)) public verificationUID;

    /// @dev One slot per payee: the account (zero = the NGO's payout Safe) and its tranche shares, packed like
    ///      `trancheBps` except that a share may be zero (a supplier paid only in later tranches).
    struct PayeeRecord {
        address account;
        uint80 shares;
    }

    mapping(uint256 => PayeeRecord[]) private _payees;
    mapping(uint256 => PayeeChange) private _pendingChange;
    /// @dev changeId => verifier => approved. Change ids are global, so approvals never carry over.
    mapping(uint256 => mapping(address => bool)) private _changeApprovedBy;

    /// @notice The single ERC-4626 vault idle capital may be deployed into, or 0 while the platform allows none.
    /// @dev One approved venue, admin-set, never an address an NGO chooses: a vault that can pick where donations
    ///      wait is a vault that can send them somewhere that never gives them back.
    address public yieldVenue;
    /// @notice Share of a need's pot that may sit in the venue at once, in basis points.
    uint16 public yieldCapBps;
    /// @notice Needs whose NGO opted in while the need was still Pending, so donors saw it before they gave.
    mapping(uint256 => bool) public yieldEnabled;

    /// @notice Number of payee changes ever proposed (their ids are 1..payeeChangeCount).
    uint256 public payeeChangeCount;

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
        resolver = resolver_;
        emit Wired(vaultFactory_, beneficiaryGroups_, deliveryManager_, resolver_);
    }

    // ─── idle capital ──────────────────────────────────────────────────────────

    /// @notice Approves the one venue where a need's idle capital may wait, and how much of a pot may go there.
    /// @dev Withdrawing the venue (address 0) stops new deployments everywhere at once. It cannot pull money
    ///      back — each vault does that itself — but nothing new leaves while it is unset.
    // forge-lint: disable-next-line(missing-zero-check) the zero address is the "no venue approved" state
    function setYieldVenue(address venue, uint16 capBps) external {
        if (!roles.isAdmin(msg.sender)) revert Errors.Unauthorized();
        if (capBps > BPS_DENOMINATOR) revert Errors.InvalidParameter();
        if (venue == address(0) && capBps != 0) revert Errors.InvalidParameter();
        yieldVenue = venue;
        yieldCapBps = capBps;
        emit YieldVenueSet(venue, capBps);
    }

    /// @notice An NGO lets this need's committed money earn while it waits for the next delivery.
    /// @dev Only while the need is Pending: this changes what a donation is exposed to, so it has to be on the
    ///      page before anyone donates, not switched on over the heads of people who already gave.
    function enableYield(uint256 needId) external whenNotPaused {
        NeedRecord storage n = _need(needId);
        if (msg.sender != n.ngo) revert Errors.Unauthorized();
        if (n.status != NeedStatus.Pending) revert Errors.InvalidNeedStatus();
        address venue = yieldVenue;
        if (venue == address(0)) revert Errors.YieldNotEnabled();
        yieldEnabled[needId] = true;
        emit YieldEnabled(needId, venue, yieldCapBps);
    }

    /// @inheritdoc INeedsRegistry
    function yieldVenueOf(uint256 needId) external view returns (address venue, uint16 capBps) {
        if (!yieldEnabled[needId]) return (address(0), 0);
        return (yieldVenue, yieldCapBps);
    }

    // ─── NGO ───────────────────────────────────────────────────────────────────

    /// @inheritdoc INeedsRegistry
    function createNeed(CreateNeedParams calldata p) external whenNotPaused returns (uint256 needId) {
        if (!wired) revert Errors.NotWired();
        if (!roles.isActiveNgo(msg.sender)) revert Errors.Unauthorized();
        if (beneficiaryGroups.programNgo(p.programId) != msg.sender) revert Errors.ProgramMismatch();
        _validateTerms(p);
        if (p.verificationsRequired == 0 || (p.targetAmount > HIGH_VALUE_THRESHOLD && p.verificationsRequired < 2)) {
            revert Errors.InsufficientVerifications();
        }

        needId = ++needCount;
        NeedRecord storage n = _needs[needId];
        n.ngo = msg.sender;
        n.verificationsRequired = p.verificationsRequired;
        n.custodyMode = p.custodyMode;
        n.minFundingBps = p.minFundingBps;
        n.thirdPartyCostBps = p.thirdPartyCostBps;
        n.fundingDeadline = uint40(p.fundingDeadline);
        n.executionDeadline = uint40(p.executionDeadline);
        n.targetAmount = uint96(p.targetAmount);
        n.programId = uint64(p.programId);
        n.trancheBps = _packTranches(p.trancheBps);
        n.regionCode = p.regionCode;
        n.dossierHash = p.dossierHash;
        if (p.custodyMode == CustodyMode.OffChain) n.custodian = p.custodian;
        // status is Pending (the zero value)
        _storePayees(needId, p.payees);

        emit NeedCreated(needId, msg.sender, p.programId, p);
    }

    /// @inheritdoc INeedsRegistry
    function cancelNeed(uint256 needId) external {
        NeedRecord storage n = _need(needId);
        NeedStatus s = n.status;
        if (_isTerminal(s)) revert Errors.InvalidNeedStatus();
        if (!roles.isAdmin(msg.sender)) {
            if (msg.sender != n.ngo) revert Errors.Unauthorized();
            // NGOs may only cancel before funding closes; afterwards cancellation is an admin (dispute) decision.
            if (uint8(s) >= uint8(NeedStatus.Funded)) revert Errors.InvalidNeedStatus();
        }
        _cancel(needId, n, msg.sender);
    }

    // ─── payment plan ──────────────────────────────────────────────────────────

    /// @inheritdoc INeedsRegistry
    function proposePayeeChange(uint256 needId, uint8 index, address account, bytes32 refHash, string calldata label)
        external
        whenNotPaused
        returns (uint256 changeId)
    {
        NeedRecord storage n = _need(needId);
        if (msg.sender != n.ngo || !roles.isActiveNgo(msg.sender)) revert Errors.Unauthorized();
        if (_isTerminal(n.status)) revert Errors.InvalidNeedStatus();
        if (_pendingChange[needId].id != 0) revert Errors.ChangePending();
        PayeeRecord[] storage list = _payees[needId];
        if (index >= list.length) revert Errors.InvalidParameter();
        address from = list[index].account;
        // The NGO's own share stays exactly as disclosed: it cannot be moved to, or disguised as, a supplier.
        if (from == address(0)) revert Errors.InvalidParameter();
        if (!roles.isActiveSupplier(account)) revert Errors.SupplierNotRegistered();
        for (uint256 i; i < list.length; ++i) {
            if (list[i].account == account) revert Errors.InvalidPaymentPlan();
        }

        changeId = ++payeeChangeCount;
        _pendingChange[needId] = PayeeChange({id: uint64(changeId), index: index, approvals: 0, account: account});
        emit PayeeChangeProposed(needId, changeId, index, from, account, refHash, label);
    }

    /// @inheritdoc INeedsRegistry
    function approvePayeeChange(uint256 needId, uint256 changeId) external whenNotPaused {
        NeedRecord storage n = _need(needId);
        PayeeChange storage change = _pendingChange[needId];
        if (change.id == 0 || change.id != changeId) revert Errors.NoPendingChange();
        if (_isTerminal(n.status)) revert Errors.InvalidNeedStatus();
        if (!roles.isIndependent(msg.sender, n.ngo)) revert Errors.NotIndependent();
        if (_changeApprovedBy[changeId][msg.sender]) revert Errors.AlreadyApproved();

        _changeApprovedBy[changeId][msg.sender] = true;
        uint8 approvals = ++change.approvals;
        emit PayeeChangeApproved(needId, changeId, msg.sender, approvals);
        if (approvals < payeeChangeApprovalsRequired(needId)) return;

        // The replacement must still be a supplier when it takes effect, not only when it was proposed.
        address to = change.account;
        if (!roles.isActiveSupplier(to)) revert Errors.SupplierNotRegistered();
        uint8 index = change.index;
        address from = _payees[needId][index].account;
        // Work that has already been confirmed is paid to whoever did it: a tranche standing releasable cannot be
        // redirected, and releasing it is permissionless, so this only ever costs the NGO one transaction. A
        // supplier that has lost its role is the exception — it cannot be paid at all, and replacing it is the
        // way to unblock the need.
        if (roles.isActiveSupplier(from) && n.vault != address(0) && ITrancheLedger(n.vault).hasReleasableTranche()) {
            revert Errors.ReleasePending();
        }
        _payees[needId][index].account = to;
        delete _pendingChange[needId];
        emit PayeeChanged(needId, changeId, index, from, to);
        // Money the vault could not pay the old payee is owed to the new one.
        if (n.vault != address(0)) IAidVault(n.vault).onPayeeChanged(from, to);
    }

    /// @inheritdoc INeedsRegistry
    function payeeChangeApprovalsRequired(uint256 needId) public view returns (uint8) {
        uint8 required = _need(needId).verificationsRequired;
        return required < MIN_PAYEE_CHANGE_APPROVALS ? MIN_PAYEE_CHANGE_APPROVALS : required;
    }

    /// @inheritdoc INeedsRegistry
    function cancelPayeeChange(uint256 needId, uint256 changeId) external {
        NeedRecord storage n = _need(needId);
        if (msg.sender != n.ngo) revert Errors.Unauthorized();
        if (_pendingChange[needId].id == 0 || _pendingChange[needId].id != changeId) revert Errors.NoPendingChange();
        delete _pendingChange[needId];
        emit PayeeChangeCancelled(needId, changeId);
    }

    // ─── anyone ────────────────────────────────────────────────────────────────

    /// @inheritdoc INeedsRegistry
    function expire(uint256 needId) external whenNotPaused {
        NeedRecord storage n = _need(needId);
        NeedStatus s = n.status;

        if (s == NeedStatus.Pending) {
            if (!_passed(n.fundingDeadline) && !_passed(n.executionDeadline)) revert Errors.DeadlineNotReached();
            _expire(needId, n, 0);
        } else if (s == NeedStatus.Funding) {
            bool executionOver = _passed(n.executionDeadline);
            if (!_passed(n.fundingDeadline) && !executionOver) revert Errors.DeadlineNotReached();
            ITrancheLedger ledger = ITrancheLedger(n.vault);
            uint256 raised = ledger.totalDonated();
            // Reaching the target closes funding on the spot, so here raised < target: execute partially if the
            // NGO's own threshold allows it and there is still time to deliver, otherwise give the money back.
            if (!executionOver && raised != 0 && _meetsMinimum(n, raised)) {
                emit PartialFundingAccepted(needId, raised, n.targetAmount);
                ledger.closeFundingAtDeadline(); // calls back setStatus(Funded)
            } else {
                _expire(needId, n, raised);
            }
        } else if (s == NeedStatus.Funded || s == NeedStatus.InDelivery) {
            if (!_passed(n.executionDeadline)) revert Errors.DeadlineNotReached();
            ITrancheLedger ledger = ITrancheLedger(n.vault);
            // Work already done keeps priority for a bounded grace period: a tranche someone earned should be
            // paid (releasing is permissionless on-chain), and a verified delivery should finish its challenge
            // window or dispute, before the rest of the money goes back.
            if (
                block.timestamp < uint256(n.executionDeadline) + EXPIRY_GRACE_PERIOD
                    && (ledger.hasReleasableTranche() || IDeliveryManager(deliveryManager).hasDeliveryInFlight(needId))
            ) revert Errors.ReleasePending();
            _expire(needId, n, ledger.totalDonated());
        } else {
            revert Errors.InvalidNeedStatus();
        }
    }

    // ─── resolver callbacks ────────────────────────────────────────────────────

    /// @inheritdoc INeedsRegistry
    function onVerificationAttested(uint256 needId, address verifier, bool approved, bytes32 attestationUID)
        external
        whenNotPaused
    {
        if (msg.sender != resolver || msg.sender == address(0)) revert Errors.Unauthorized();
        NeedRecord storage n = _need(needId);
        if (n.status != NeedStatus.Pending) revert Errors.InvalidNeedStatus();
        if (_passed(n.fundingDeadline) || _passed(n.executionDeadline)) revert Errors.DeadlinePassed();
        if (!roles.isIndependent(verifier, n.ngo)) revert Errors.NotIndependent();
        if (verifiedBy[needId][verifier]) revert Errors.AlreadyVerified();

        verifiedBy[needId][verifier] = true;
        verificationUID[needId][verifier] = attestationUID;

        if (!approved) {
            // A rejection by an independent verifier blocks the need; the NGO must create a new one.
            emit NeedVerificationRecorded(needId, verifier, false, attestationUID, n.verificationCount);
            _cancel(needId, n, verifier);
            return;
        }

        uint8 count = ++n.verificationCount;
        emit NeedVerificationRecorded(needId, verifier, true, attestationUID, count);
        if (count == n.verificationsRequired) _onVerified(needId, n);
    }

    /// @inheritdoc INeedsRegistry
    /// @dev Honored only while `Pending`, or `Funding` with nothing raised (the need drops back to `Pending`).
    ///      Otherwise the revocation is logged for the dispute process and state is left untouched.
    function onVerificationRevoked(uint256 needId, address verifier, bytes32 attestationUID) external {
        if (msg.sender != resolver || msg.sender == address(0)) revert Errors.Unauthorized();
        NeedRecord storage n = _need(needId);
        if (verificationUID[needId][verifier] != attestationUID) revert Errors.UnknownVerification();

        bool honored = n.status == NeedStatus.Pending
            || (n.status == NeedStatus.Funding && ITrancheLedger(n.vault).totalDonated() == 0);
        if (!honored) {
            emit VerificationRevokedAfterFunding(needId, verifier, attestationUID);
            return;
        }

        // In Pending/Funding every recorded verification is an approval (a rejection cancels the need).
        delete verifiedBy[needId][verifier];
        delete verificationUID[needId][verifier];
        uint8 count = --n.verificationCount;
        emit NeedVerificationRevoked(needId, verifier, attestationUID, count);
        if (n.status == NeedStatus.Funding) _transition(needId, n, NeedStatus.Pending);
    }

    // ─── ledger callbacks ──────────────────────────────────────────────────────

    /// @inheritdoc INeedsRegistry
    /// @dev Only the need's own ledger. The spec also names the DeliveryManager, but it never calls this — and
    ///      an unused, unscoped authority here is dangerous: with it, a `Funded` need could be walked to
    ///      `Completed` without tranche 0 ever being released, locking the escrow with no refund path.
    function setStatus(uint256 needId, NeedStatus next) external {
        NeedRecord storage n = _need(needId);
        if (msg.sender != n.vault || msg.sender == address(0)) revert Errors.Unauthorized();
        NeedStatus current = n.status;
        bool allowed = (current == NeedStatus.Funding && next == NeedStatus.Funded)
            || (current == NeedStatus.Funded && next == NeedStatus.InDelivery)
            || (current == NeedStatus.InDelivery && next == NeedStatus.Completed);
        if (!allowed) revert Errors.InvalidTransition();
        _transition(needId, n, next);
    }

    // ─── views ─────────────────────────────────────────────────────────────────

    /// @inheritdoc INeedsRegistry
    function getNeed(uint256 needId) external view returns (Need memory need) {
        NeedRecord storage n = _need(needId);
        need = Need({
            id: needId,
            ngo: n.ngo,
            programId: n.programId,
            targetAmount: n.targetAmount,
            regionCode: n.regionCode,
            dossierHash: n.dossierHash,
            verificationsRequired: n.verificationsRequired,
            verificationCount: n.verificationCount,
            trancheBps: _unpackTranches(n.trancheBps),
            vault: n.vault,
            status: n.status,
            custodyMode: n.custodyMode,
            custodian: n.custodian,
            fundingDeadline: n.fundingDeadline,
            executionDeadline: n.executionDeadline,
            minFundingBps: n.minFundingBps,
            thirdPartyCostBps: n.thirdPartyCostBps
        });
    }

    /// @inheritdoc INeedsRegistry
    function fundingTermsOf(uint256 needId)
        external
        view
        returns (address ngo, uint256 targetAmount, uint16 minFundingBps, bool open)
    {
        NeedRecord storage n = _need(needId);
        open = n.status == NeedStatus.Funding && !_passed(n.fundingDeadline) && !_passed(n.executionDeadline);
        return (n.ngo, n.targetAmount, n.minFundingBps, open);
    }

    /// @inheritdoc INeedsRegistry
    function coreOf(uint256 needId)
        external
        view
        returns (address ngo, address vault, uint256 programId, NeedStatus status)
    {
        NeedRecord storage n = _need(needId);
        return (n.ngo, n.vault, n.programId, n.status);
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
        return _unpackTranches(_need(needId).trancheBps);
    }

    /// @inheritdoc INeedsRegistry
    function custodyModeOf(uint256 needId) external view returns (CustodyMode) {
        return _need(needId).custodyMode;
    }

    /// @inheritdoc INeedsRegistry
    function fundingDeadlineOf(uint256 needId) external view returns (uint64) {
        return _need(needId).fundingDeadline;
    }

    /// @inheritdoc INeedsRegistry
    function thirdPartyCostBpsOf(uint256 needId) external view returns (uint16) {
        return _need(needId).thirdPartyCostBps;
    }

    /// @inheritdoc INeedsRegistry
    function custodianOf(uint256 needId) external view returns (address) {
        return _need(needId).custodian;
    }

    /// @inheritdoc INeedsRegistry
    function payeesOf(uint256 needId) external view returns (PayeeShare[] memory payees) {
        uint256 tranches = _unpackTranches(_need(needId).trancheBps).length;
        PayeeRecord[] storage list = _payees[needId];
        payees = new PayeeShare[](list.length);
        for (uint256 i; i < list.length; ++i) {
            uint16[] memory shares = new uint16[](tranches);
            for (uint256 t; t < tranches; ++t) {
                shares[t] = _shareAt(list[i].shares, t);
            }
            payees[i] = PayeeShare({account: list[i].account, shareBps: shares});
        }
    }

    /// @inheritdoc INeedsRegistry
    function trancheSplitOf(uint256 needId, uint256 index)
        external
        view
        returns (address[] memory accounts, uint16[] memory shareBps)
    {
        NeedRecord storage n = _need(needId);
        PayeeRecord[] storage list = _payees[needId];
        uint256 count;
        for (uint256 i; i < list.length; ++i) {
            if (_shareAt(list[i].shares, index) != 0) ++count;
        }
        accounts = new address[](count);
        shareBps = new uint16[](count);
        uint256 j;
        for (uint256 i; i < list.length; ++i) {
            uint16 share = _shareAt(list[i].shares, index);
            if (share == 0) continue;
            address account = list[i].account;
            if (account == address(0)) {
                account = roles.payoutOf(n.ngo);
            } else if (!roles.isActiveSupplier(account)) {
                revert Errors.SupplierInactive();
            }
            (accounts[j], shareBps[j]) = (account, share);
            ++j;
        }
    }

    /// @inheritdoc INeedsRegistry
    function pendingPayeeChangeOf(uint256 needId) external view returns (PayeeChange memory) {
        _need(needId);
        return _pendingChange[needId];
    }

    // ─── internal ──────────────────────────────────────────────────────────────

    function _need(uint256 needId) internal view returns (NeedRecord storage n) {
        n = _needs[needId];
        if (n.ngo == address(0)) revert Errors.NeedNotFound();
    }

    function _validateTerms(CreateNeedParams calldata p) internal view {
        if (p.targetAmount == 0) revert Errors.ZeroAmount();
        if (
            p.category == bytes32(0) || p.regionCode == bytes32(0) || p.dossierHash == bytes32(0)
                || p.expectedOutcomeHash == bytes32(0)
        ) revert Errors.InvalidParameter();
        // Bounds of the packed storage layout (none of them is reachable by a real need).
        if (
            p.targetAmount > type(uint96).max || p.programId > type(uint64).max || p.fundingDeadline > type(uint40).max
                || p.executionDeadline > type(uint40).max
        ) revert Errors.InvalidParameter();
        if (p.minFundingBps == 0 || p.minFundingBps > BPS_DENOMINATOR) revert Errors.InvalidParameter();
        // Costs are either zero or capped and backed by a published disclosure.
        if (p.thirdPartyCostBps > MAX_THIRD_PARTY_COST_BPS) revert Errors.InvalidParameter();
        if ((p.thirdPartyCostBps == 0) != (p.costDisclosureHash == bytes32(0))) revert Errors.InvalidParameter();
        if (p.fundingDeadline != 0 && p.fundingDeadline <= block.timestamp) revert Errors.InvalidParameter();
        // Off-chain money has exactly one custodian, named up front: a provider cannot adopt someone else's need
        // by recording a token amount first, and nobody but the custodian can report its payouts.
        if (p.custodyMode == CustodyMode.OffChain) {
            if (!roles.hasRole(Roles.BANK_PARTNER_ROLE, p.custodian)) revert Errors.InvalidParameter();
        } else if (p.custodian != address(0)) {
            revert Errors.InvalidParameter();
        }
        // Money escrowed on-chain always has a horizon: without one, a need whose plan cannot be paid (a supplier
        // that lost its role, say) could never be expired, and donors would have no permissionless way back.
        if (p.custodyMode == CustodyMode.OnChain && p.executionDeadline == 0) revert Errors.InvalidParameter();
        if (p.executionDeadline != 0) {
            // Delivery cannot be due before money can have arrived.
            if (p.executionDeadline <= block.timestamp || p.executionDeadline <= p.fundingDeadline) {
                revert Errors.InvalidParameter();
            }
        }
        _validateTranches(p.trancheBps);
        _validatePayees(p);
    }

    /// @dev The rules of a payment plan. Off-chain money is paid by its custodian, so only on-chain needs have one,
    ///      and every on-chain need must: its vault pays nobody that is not in it.
    function _validatePayees(CreateNeedParams calldata p) internal view {
        uint256 count = p.payees.length;
        if (p.custodyMode == CustodyMode.OffChain) {
            if (count != 0) revert Errors.InvalidPaymentPlan();
            return;
        }
        if (count == 0 || count > MAX_PAYEES) revert Errors.InvalidPaymentPlan();
        uint256 tranches = p.trancheBps.length;
        uint256[MAX_TRANCHES] memory sums;
        uint256 ngoShare; // Σ trancheBps × the NGO's share of that tranche, in bps × bps
        bool ngoListed;
        for (uint256 i; i < count; ++i) {
            Payee calldata payee = p.payees[i];
            if (payee.shareBps.length != tranches) revert Errors.InvalidPaymentPlan();
            address account = payee.account;
            if (account == address(0)) {
                if (ngoListed) revert Errors.InvalidPaymentPlan();
                ngoListed = true;
            } else {
                if (!roles.isActiveSupplier(account)) revert Errors.SupplierNotRegistered();
                for (uint256 j; j < i; ++j) {
                    if (p.payees[j].account == account) revert Errors.InvalidPaymentPlan();
                }
            }
            uint256 total;
            for (uint256 t; t < tranches; ++t) {
                uint256 share = payee.shareBps[t];
                sums[t] += share;
                total += share;
                if (account == address(0)) ngoShare += share * p.trancheBps[t];
            }
            // A payee that is never paid has no place in the plan.
            if (total == 0) revert Errors.InvalidPaymentPlan();
        }
        for (uint256 t; t < tranches; ++t) {
            if (sums[t] != BPS_DENOMINATOR) revert Errors.InvalidPaymentPlan();
        }
        if (ngoShare > uint256(MAX_NGO_SHARE_BPS) * BPS_DENOMINATOR) revert Errors.NgoShareTooHigh();
    }

    function _storePayees(uint256 needId, Payee[] calldata payees) internal {
        PayeeRecord[] storage list = _payees[needId];
        for (uint256 i; i < payees.length; ++i) {
            list.push(PayeeRecord({account: payees[i].account, shares: _packTranches(payees[i].shareBps)}));
        }
    }

    function _shareAt(uint80 packed, uint256 index) internal pure returns (uint16) {
        return index < MAX_TRANCHES ? uint16(packed >> uint80(16 * index)) : 0;
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

    function _packTranches(uint16[] calldata bps) internal pure returns (uint80 packed) {
        for (uint256 i; i < bps.length; ++i) {
            packed |= uint80(bps[i]) << uint80(16 * i);
        }
    }

    /// @dev Entries are validated non-zero, so the plan ends at the first zero word.
    function _unpackTranches(uint80 packed) internal pure returns (uint16[] memory bps) {
        uint256 len;
        while (len < MAX_TRANCHES && uint16(packed >> uint80(16 * len)) != 0) ++len;
        bps = new uint16[](len);
        for (uint256 i; i < len; ++i) {
            bps[i] = uint16(packed >> uint80(16 * i));
        }
    }

    function _meetsMinimum(NeedRecord storage n, uint256 raised) internal view returns (bool) {
        return raised * BPS_DENOMINATOR >= uint256(n.targetAmount) * n.minFundingBps;
    }

    function _passed(uint40 deadline) internal view returns (bool) {
        return deadline != 0 && block.timestamp >= deadline;
    }

    function _isTerminal(NeedStatus s) internal pure returns (bool) {
        return s == NeedStatus.Completed || s == NeedStatus.Cancelled || s == NeedStatus.Expired;
    }

    /// @dev Verification threshold reached: deploy (or reuse) the ledger and open funding.
    function _onVerified(uint256 needId, NeedRecord storage n) internal {
        _transition(needId, n, NeedStatus.Verified);
        if (n.vault == address(0)) n.vault = vaultFactory.createVault(needId, n.custodyMode);
        emit NeedVerified(needId, n.vault);
        _transition(needId, n, NeedStatus.Funding);
    }

    function _cancel(uint256 needId, NeedRecord storage n, address by) internal {
        _transition(needId, n, NeedStatus.Cancelled);
        emit NeedCancelled(needId, by);
    }

    function _expire(uint256 needId, NeedRecord storage n, uint256 raised) internal {
        emit NeedExpired(needId, n.status, raised);
        _transition(needId, n, NeedStatus.Expired);
    }

    function _transition(uint256 needId, NeedRecord storage n, NeedStatus next) internal {
        emit NeedStatusChanged(needId, n.status, next);
        n.status = next;
    }
}
