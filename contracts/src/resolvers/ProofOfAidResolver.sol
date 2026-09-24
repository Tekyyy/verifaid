// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IFeeRecorder} from "../interfaces/IFeeRecorder.sol";
import {INeedsRegistry} from "../interfaces/INeedsRegistry.sol";
import {IRoleRegistry} from "../interfaces/IRoleRegistry.sol";
import {ITrancheLedger} from "../interfaces/ITrancheLedger.sol";
import {Errors} from "../libraries/Errors.sol";
import {Attestation, IEAS} from "@ethereum-attestation-service/eas-contracts/contracts/IEAS.sol";
import {SchemaResolver} from "@ethereum-attestation-service/eas-contracts/contracts/resolver/SchemaResolver.sol";

/// @title ProofOfAidResolver
/// @notice The single EAS resolver for all three Proof of Aid schemas. Every attestation that moves money or state
///         passes through here, which validates the attester's role and the payload before forwarding it.
/// @dev The resolver derives each schema's UID from its own address exactly as the SchemaRegistry does
///      (`keccak256(abi.encodePacked(schema, resolver, revocable))`) and dispatches on it. Attestations under any
///      other schema that points at this resolver are rejected, so indexers can trust the three official UIDs.
///
///      Lifecycle, in the order a donor sees it:
///        NeedVerified      independent verifier approves the dossier            → funding opens
///        Settlement        payout of a released tranche, with fees and FX ref   → Settled
///        ImpactReport      NGO publishes outcomes once every tranche is paid    → Impact confirmed
///
///      Deliveries need no attestation: the NGO files its evidence with `DeliveryManager` and the need's donors
///      approve it there, weighted by what they gave.
///
///      Money only ever arrives on chain — a wallet, a card through the Coinbase on-ramp into the donor's own
///      wallet, or an exchange withdrawal to a deposit address — so no attestation is needed to say it did.
contract ProofOfAidResolver is SchemaResolver, IFeeRecorder {
    uint16 internal constant BPS_DENOMINATOR = 10_000;
    uint256 public constant SCHEMA_COUNT = 3;

    string public constant NEED_VERIFIED_SCHEMA = "uint256 needId,bytes32 dossierHash,bool approved,bytes32 reportHash";
    string public constant SETTLEMENT_SCHEMA =
        "uint256 needId,uint256 trancheIndex,uint256 gross,uint256 fee,uint256 net,bytes32 supplierRefHash,bytes32 fxRef";
    string public constant IMPACT_REPORT_SCHEMA =
        "uint256 needId,uint32 beneficiariesServed,bytes32 kpiHash,string reportCID";

    bytes32 public immutable NEED_VERIFIED_UID;
    bytes32 public immutable SETTLEMENT_UID;
    bytes32 public immutable IMPACT_REPORT_UID;

    IRoleRegistry public immutable roles;
    INeedsRegistry public immutable registry;
    /// @notice Smallest `beneficiariesServed` an impact report may state: publishing "2 people served" for a known
    ///         category and region is a small-count disclosure about identifiable people.
    uint32 public immutable minBeneficiariesServed;

    /// @notice needId => what conversions cost on the way in (oracle fair value minus what the swap delivered).
    mapping(uint256 => uint256) public fundingFeesOf;
    /// @notice needId => fees intermediaries kept on the way out (Settlement).
    mapping(uint256 => uint256) public settlementFeesOf;
    /// @notice needId => trancheIndex => Settlement attestation UID.
    mapping(uint256 => mapping(uint256 => bytes32)) public settlementOf;
    /// @notice needId => UID of the live (non-revoked) impact report.
    mapping(uint256 => bytes32) public activeReportOf;

    event SettlementLinked(
        uint256 indexed needId,
        uint256 indexed trancheIndex,
        bytes32 attestationUID,
        uint256 gross,
        uint256 fee,
        uint256 net
    );
    event ImpactReportLinked(uint256 indexed needId, bytes32 attestationUID, uint32 beneficiariesServed);
    event ImpactReportRevoked(uint256 indexed needId, bytes32 attestationUID);

    constructor(IEAS eas, IRoleRegistry roles_, INeedsRegistry registry_, uint32 minBeneficiariesServed_)
        SchemaResolver(eas)
    {
        if (address(roles_) == address(0) || address(registry_) == address(0)) revert Errors.ZeroAddress();
        if (minBeneficiariesServed_ == 0) revert Errors.InvalidParameter();
        roles = roles_;
        registry = registry_;
        minBeneficiariesServed = minBeneficiariesServed_;

        NEED_VERIFIED_UID = _uid(NEED_VERIFIED_SCHEMA, true);
        SETTLEMENT_UID = _uid(SETTLEMENT_SCHEMA, false);
        IMPACT_REPORT_UID = _uid(IMPACT_REPORT_SCHEMA, true);
    }

    /// @notice Schema `index` as it must be registered: the string, its revocability and the UID it yields.
    function schemaAt(uint256 index) external view returns (string memory schema, bool revocable, bytes32 uid) {
        // forge-lint: disable-start(boolean-cst)
        if (index == 0) return (NEED_VERIFIED_SCHEMA, true, NEED_VERIFIED_UID);
        if (index == 1) return (SETTLEMENT_SCHEMA, false, SETTLEMENT_UID);
        if (index == 2) return (IMPACT_REPORT_SCHEMA, true, IMPACT_REPORT_UID);
        // forge-lint: disable-end(boolean-cst)
        revert Errors.InvalidParameter();
    }

    // ─── conversion fees ───────────────────────────────────────────────────────

    /// @inheritdoc IFeeRecorder
    /// @dev Conversion costs are computed by the contracts (oracle fair value minus swap output), so they need no
    ///      attestation; with settlement fees they share the budget of the need's disclosed cap.
    function recordConversionFee(uint256 needId, uint256 fee) external {
        INeedsRegistry.Need memory n = registry.getNeed(needId);
        if (msg.sender != n.vault || n.vault == address(0)) revert Errors.Unauthorized();
        fundingFeesOf[needId] += fee;
        _checkCostCap(needId, n.vault, n.thirdPartyCostBps);
        emit ConversionFeeRecorded(needId, fee);
    }

    // ─── dispatch ──────────────────────────────────────────────────────────────

    function onAttest(Attestation calldata a, uint256) internal override returns (bool) {
        bytes32 schema = a.schema;
        if (a.expirationTime != 0) revert Errors.ExpiringAttestation();
        if (roles.paused()) revert Errors.SystemPaused();

        if (schema == NEED_VERIFIED_UID) _onNeedVerified(a);
        else if (schema == SETTLEMENT_UID) _onSettlement(a);
        else if (schema == IMPACT_REPORT_UID) _onImpactReport(a);
        else revert Errors.WrongSchema();
        return true;
    }

    /// @dev Revocations are allowed while paused: revoking only makes the system safer.
    function onRevoke(Attestation calldata a, uint256) internal override returns (bool) {
        bytes32 schema = a.schema;
        if (schema == NEED_VERIFIED_UID) {
            (uint256 needId,,,) = abi.decode(a.data, (uint256, bytes32, bool, bytes32));
            // The registry decides whether the revocation changes state.
            registry.onVerificationRevoked(needId, a.attester, a.uid);
        } else if (schema == IMPACT_REPORT_UID) {
            (uint256 needId,,,) = abi.decode(a.data, (uint256, uint32, bytes32, string));
            if (activeReportOf[needId] == a.uid) {
                delete activeReportOf[needId];
                emit ImpactReportRevoked(needId, a.uid);
            }
        } else if (schema == SETTLEMENT_UID) {
            // Money is irrevocable: a settlement records a payment that happened.
            revert Errors.NotRevocable();
        } else {
            revert Errors.WrongSchema();
        }
        return true;
    }

    // ─── NeedVerified ──────────────────────────────────────────────────────────

    /// @dev Attester must be independent of the need's NGO, the dossier hash must match, the need must be Pending,
    ///      and the recipient must be the NeedsRegistry (never a person).
    function _onNeedVerified(Attestation calldata a) internal {
        (uint256 needId, bytes32 dossierHash, bool approved,) = abi.decode(a.data, (uint256, bytes32, bool, bytes32));
        if (a.recipient != address(registry)) revert Errors.InvalidRecipient();
        if (registry.statusOf(needId) != INeedsRegistry.NeedStatus.Pending) revert Errors.InvalidNeedStatus();
        if (registry.dossierHashOf(needId) != dossierHash) revert Errors.DossierMismatch();
        if (!roles.isIndependent(a.attester, registry.ngoOf(needId))) revert Errors.NotIndependent();

        registry.onVerificationAttested(needId, a.attester, approved, a.uid);
    }

    // ─── Settlement ────────────────────────────────────────────────────────────

    /// @dev Reconciles one tranche payout: gross must equal the tranche, fees must stay within the disclosed cap.
    ///      The vault has already released the tranche; the NGO reports how it reached the supplier.
    function _onSettlement(Attestation calldata a) internal {
        (uint256 needId, uint256 trancheIndex, uint256 gross, uint256 fee, uint256 net, bytes32 supplierRefHash,) =
            abi.decode(a.data, (uint256, uint256, uint256, uint256, uint256, bytes32, bytes32));

        if (supplierRefHash == bytes32(0)) revert Errors.InvalidParameter();
        INeedsRegistry.Need memory n = registry.getNeed(needId);
        if (n.vault == address(0) || a.recipient != n.vault) revert Errors.InvalidRecipient();
        _checkAmounts(gross, fee, net);
        if (settlementOf[needId][trancheIndex] != bytes32(0)) revert Errors.SettlementAlreadyRecorded();

        ITrancheLedger ledger = ITrancheLedger(n.vault);
        ITrancheLedger.Tranche[] memory tranches = ledger.getTranches();
        if (trancheIndex >= tranches.length) revert Errors.InvalidTrancheIndex();
        if (gross != tranches[trancheIndex].amount) revert Errors.AmountMismatch();
        settlementOf[needId][trancheIndex] = a.uid;
        settlementFeesOf[needId] += fee;

        // Whoever was paid the owner's share accounts for it: the NGO, or the beneficiary who posted the need.
        if (a.attester != registry.ownerOf(needId)) revert Errors.Unauthorized();
        if (tranches[trancheIndex].status != ITrancheLedger.TrancheStatus.Released) {
            revert Errors.InvalidTrancheStatus();
        }
        _checkCostCap(needId, n.vault, n.thirdPartyCostBps);
        emit SettlementLinked(needId, trancheIndex, a.uid, gross, fee, net);
    }

    // ─── ImpactReport ──────────────────────────────────────────────────────────

    /// @dev Only once every tranche is paid, by the NGO, one live report per need; revoke to correct. `refUID` is
    ///      left empty: there is no sign-off chain to point at since donors approve deliveries directly.
    function _onImpactReport(Attestation calldata a) internal {
        (uint256 needId, uint32 beneficiariesServed, bytes32 kpiHash, string memory reportCID) =
            abi.decode(a.data, (uint256, uint32, bytes32, string));

        (address ngo, address vault,, INeedsRegistry.NeedStatus status) = registry.coreOf(needId);
        if (a.attester != ngo) revert Errors.Unauthorized();
        if (status != INeedsRegistry.NeedStatus.Completed) revert Errors.InvalidNeedStatus();
        if (a.recipient != vault) revert Errors.InvalidRecipient();
        if (kpiHash == bytes32(0) || bytes(reportCID).length == 0) revert Errors.InvalidParameter();
        if (beneficiariesServed < minBeneficiariesServed) revert Errors.TooFewRecipients();
        if (a.refUID != bytes32(0)) revert Errors.InvalidRefUID();
        if (activeReportOf[needId] != bytes32(0)) revert Errors.ReportAlreadyActive();

        activeReportOf[needId] = a.uid;
        emit ImpactReportLinked(needId, a.uid, beneficiariesServed);
    }

    // ─── internal ──────────────────────────────────────────────────────────────

    function _checkAmounts(uint256 gross, uint256 fee, uint256 net) internal pure {
        if (gross < fee || gross - fee != net) revert Errors.AmountMismatch();
    }

    /// @dev The disclosure is binding and cumulative: everything intermediaries kept on the way in (conversions)
    ///      and on the way out (settlements), together, stays within `thirdPartyCostBps` of what donors paid.
    ///      Checking each fee on its own would let a conversion and a settlement stack past the cap donors saw.
    function _checkCostCap(uint256 needId, address ledger, uint16 costCapBps) internal view {
        uint256 fundingFees = fundingFeesOf[needId];
        uint256 paidByDonors = ITrancheLedger(ledger).totalDonated() + fundingFees;
        if ((fundingFees + settlementFeesOf[needId]) * BPS_DENOMINATOR > paidByDonors * costCapBps) {
            revert Errors.FeeExceedsDisclosure();
        }
    }

    function _uid(string memory schema, bool revocable) internal view returns (bytes32) {
        return keccak256(abi.encodePacked(schema, address(this), revocable));
    }
}
