// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IAidVault} from "../interfaces/IAidVault.sol";
import {IDeliveryManager} from "../interfaces/IDeliveryManager.sol";
import {IFeeRecorder} from "../interfaces/IFeeRecorder.sol";
import {INeedsRegistry} from "../interfaces/INeedsRegistry.sol";
import {INonCustodialLedger} from "../interfaces/INonCustodialLedger.sol";
import {IRoleRegistry} from "../interfaces/IRoleRegistry.sol";
import {ITrancheLedger} from "../interfaces/ITrancheLedger.sol";
import {Errors} from "../libraries/Errors.sol";
import {Roles} from "../libraries/Roles.sol";
import {Attestation, IEAS} from "@ethereum-attestation-service/eas-contracts/contracts/IEAS.sol";
import {SchemaResolver} from "@ethereum-attestation-service/eas-contracts/contracts/resolver/SchemaResolver.sol";

/// @title ProofOfAidResolver
/// @notice The single EAS resolver for all six Proof of Aid schemas. Every attestation that moves money or state
///         passes through here, which validates the attester's role and the payload before forwarding it.
/// @dev The resolver derives each schema's UID from its own address exactly as the SchemaRegistry does
///      (`keccak256(abi.encodePacked(schema, resolver, revocable))`) and dispatches on it. Attestations under any
///      other schema that points at this resolver are rejected, so indexers can trust the six official UIDs.
///
///      Lifecycle, in the order a donor sees it:
///        NeedVerified      independent verifier approves the dossier            → funding opens
///        FundingRecorded   payment provider vouches for money it received       → Funded
///        Settlement        payout of a released tranche, with fees and FX ref   → Settled
///        DeliveryEvidence  field agent files encrypted evidence                 ┐
///        DeliveryVerified  independent verifier signs the delivery off          ┘ → Delivered
///        ImpactReport      NGO publishes outcomes, chained to the last sign-off → Impact confirmed
contract ProofOfAidResolver is SchemaResolver, IFeeRecorder {
    uint16 internal constant BPS_DENOMINATOR = 10_000;
    uint256 public constant SCHEMA_COUNT = 6;

    string public constant NEED_VERIFIED_SCHEMA = "uint256 needId,bytes32 dossierHash,bool approved,bytes32 reportHash";
    string public constant FUNDING_RECORDED_SCHEMA =
        "uint256 needId,uint256 gross,uint256 fee,uint256 net,bytes32 currency,bytes32 paymentRefHash,bytes32 donorRefHash";
    string public constant DELIVERY_EVIDENCE_SCHEMA =
        "uint256 deliveryId,bytes32 evidenceHash,string evidenceCID,uint32 itemsDelivered,bytes32 regionCode";
    string public constant DELIVERY_VERIFIED_SCHEMA = "uint256 deliveryId,bool approved,bytes32 reportHash";
    string public constant SETTLEMENT_SCHEMA =
        "uint256 needId,uint256 trancheIndex,uint256 gross,uint256 fee,uint256 net,bytes32 supplierRefHash,bytes32 fxRef";
    string public constant IMPACT_REPORT_SCHEMA =
        "uint256 needId,uint32 beneficiariesServed,bytes32 kpiHash,string reportCID";

    bytes32 public immutable NEED_VERIFIED_UID;
    bytes32 public immutable FUNDING_RECORDED_UID;
    bytes32 public immutable DELIVERY_EVIDENCE_UID;
    bytes32 public immutable DELIVERY_VERIFIED_UID;
    bytes32 public immutable SETTLEMENT_UID;
    bytes32 public immutable IMPACT_REPORT_UID;

    IRoleRegistry public immutable roles;
    INeedsRegistry public immutable registry;
    IDeliveryManager public immutable deliveryManager;

    /// @notice provider => paymentRefHash => FundingRecorded attestation UID (references are scoped per provider).
    mapping(address => mapping(bytes32 => bytes32)) public fundingAttestationOf;
    /// @notice needId => fees intermediaries kept on the way in (FundingRecorded).
    mapping(uint256 => uint256) public fundingFeesOf;
    /// @notice needId => fees intermediaries kept on the way out (Settlement).
    mapping(uint256 => uint256) public settlementFeesOf;
    /// @notice needId => trancheIndex => Settlement attestation UID.
    mapping(uint256 => mapping(uint256 => bytes32)) public settlementOf;
    /// @notice needId => UID of the live (non-revoked) impact report.
    mapping(uint256 => bytes32) public activeReportOf;

    event FundingAttestationLinked(uint256 indexed needId, bytes32 indexed paymentRefHash, bytes32 attestationUID);
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

    constructor(IEAS eas, IRoleRegistry roles_, INeedsRegistry registry_, IDeliveryManager deliveryManager_)
        SchemaResolver(eas)
    {
        if (
            address(roles_) == address(0) || address(registry_) == address(0) || address(deliveryManager_) == address(0)
        ) revert Errors.ZeroAddress();
        roles = roles_;
        registry = registry_;
        deliveryManager = deliveryManager_;

        NEED_VERIFIED_UID = _uid(NEED_VERIFIED_SCHEMA, true);
        FUNDING_RECORDED_UID = _uid(FUNDING_RECORDED_SCHEMA, false);
        DELIVERY_EVIDENCE_UID = _uid(DELIVERY_EVIDENCE_SCHEMA, false);
        DELIVERY_VERIFIED_UID = _uid(DELIVERY_VERIFIED_SCHEMA, false);
        SETTLEMENT_UID = _uid(SETTLEMENT_SCHEMA, false);
        IMPACT_REPORT_UID = _uid(IMPACT_REPORT_SCHEMA, true);
    }

    /// @notice Schema `index` as it must be registered: the string, its revocability and the UID it yields.
    function schemaAt(uint256 index) external view returns (string memory schema, bool revocable, bytes32 uid) {
        // forge-lint: disable-start(boolean-cst)
        if (index == 0) return (NEED_VERIFIED_SCHEMA, true, NEED_VERIFIED_UID);
        if (index == 1) return (FUNDING_RECORDED_SCHEMA, false, FUNDING_RECORDED_UID);
        if (index == 2) return (DELIVERY_EVIDENCE_SCHEMA, false, DELIVERY_EVIDENCE_UID);
        if (index == 3) return (DELIVERY_VERIFIED_SCHEMA, false, DELIVERY_VERIFIED_UID);
        if (index == 4) return (SETTLEMENT_SCHEMA, false, SETTLEMENT_UID);
        if (index == 5) return (IMPACT_REPORT_SCHEMA, true, IMPACT_REPORT_UID);
        // forge-lint: disable-end(boolean-cst)
        revert Errors.InvalidParameter();
    }

    // ─── conversion fees ───────────────────────────────────────────────────────

    /// @inheritdoc IFeeRecorder
    /// @dev Conversion costs are computed by the contracts (oracle fair value minus swap output), so they need no
    ///      attestation; they share the attested funding fees' budget under the need's disclosed cap.
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
        else if (schema == FUNDING_RECORDED_UID) _onFundingRecorded(a);
        else if (schema == DELIVERY_EVIDENCE_UID) _onDeliveryEvidence(a);
        else if (schema == DELIVERY_VERIFIED_UID) _onDeliveryVerified(a);
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
        } else if (
            schema == FUNDING_RECORDED_UID || schema == DELIVERY_EVIDENCE_UID || schema == DELIVERY_VERIFIED_UID
                || schema == SETTLEMENT_UID
        ) {
            // Money, evidence and sign-offs are irrevocable; disagreement goes through challenges and disputes.
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

    // ─── FundingRecorded ───────────────────────────────────────────────────────

    /// @dev A payment provider (BANK_PARTNER_ROLE) vouches for a payment. Amounts are in the need's stablecoin
    ///      base units; `currency` is what the donor paid in. For an on-chain need the matching deposit must
    ///      already be in the vault; for an off-chain need this attestation *is* the funding record.
    function _onFundingRecorded(Attestation calldata a) internal {
        (
            uint256 needId,
            uint256 gross,
            uint256 fee,
            uint256 net,
            bytes32 currency,
            bytes32 paymentRefHash,
            bytes32 donorRefHash
        ) = abi.decode(a.data, (uint256, uint256, uint256, uint256, bytes32, bytes32, bytes32));

        if (!roles.hasRole(Roles.BANK_PARTNER_ROLE, a.attester)) revert Errors.Unauthorized();
        if (net == 0 || currency == bytes32(0) || paymentRefHash == bytes32(0) || donorRefHash == bytes32(0)) {
            revert Errors.InvalidParameter();
        }
        INeedsRegistry.Need memory n = registry.getNeed(needId);
        if (n.vault == address(0) || a.recipient != n.vault) revert Errors.InvalidRecipient();
        _checkAmounts(gross, fee, net);
        if (fundingAttestationOf[a.attester][paymentRefHash] != bytes32(0)) revert Errors.FundingAlreadyAttested();
        fundingAttestationOf[a.attester][paymentRefHash] = a.uid;
        fundingFeesOf[needId] += fee;

        if (n.custodyMode == INeedsRegistry.CustodyMode.OnChain) {
            if (!IAidVault(n.vault).fiatDepositMatches(paymentRefHash, a.attester, donorRefHash, net)) {
                revert Errors.FundingMismatch();
            }
        } else {
            // Only the custodian the NGO named can say it received money for this need.
            if (a.attester != n.custodian) revert Errors.Unauthorized();
            INonCustodialLedger(n.vault)
                .recordFunding(a.attester, gross, fee, net, currency, paymentRefHash, donorRefHash);
        }
        _checkCostCap(needId, n.vault, n.thirdPartyCostBps);
        emit FundingAttestationLinked(needId, paymentRefHash, a.uid);
    }

    // ─── DeliveryEvidence ──────────────────────────────────────────────────────

    /// @dev Attester must be the delivery's field agent (still bound to the NGO), the delivery must be Open without
    ///      evidence, and the coarse region must match the need's region.
    function _onDeliveryEvidence(Attestation calldata a) internal {
        (uint256 deliveryId, bytes32 evidenceHash, string memory evidenceCID, uint32 itemsDelivered, bytes32 region) =
            abi.decode(a.data, (uint256, bytes32, string, uint32, bytes32));

        if (a.recipient != address(deliveryManager)) revert Errors.InvalidRecipient();
        if (evidenceHash == bytes32(0) || bytes(evidenceCID).length == 0 || itemsDelivered == 0) {
            revert Errors.InvalidParameter();
        }

        IDeliveryManager.Delivery memory d = deliveryManager.getDelivery(deliveryId);
        if (d.fieldAgent != a.attester) revert Errors.Unauthorized();
        if (!roles.isFieldAgentOf(a.attester, registry.ngoOf(d.needId))) revert Errors.Unauthorized();
        if (d.status != IDeliveryManager.DeliveryStatus.Open) revert Errors.InvalidDeliveryStatus();
        if (d.evidenceAttestationUID != bytes32(0)) revert Errors.EvidenceAlreadyLinked();
        if (region != registry.regionCodeOf(d.needId)) revert Errors.RegionMismatch();

        deliveryManager.onEvidenceAttested(deliveryId, a.uid);
    }

    // ─── DeliveryVerified ──────────────────────────────────────────────────────

    /// @dev `refUID` must point at the delivery's `DeliveryEvidence` attestation, building a traversable chain.
    ///      Sign-offs are irrevocable; disagreement goes through `DeliveryManager.challenge`.
    function _onDeliveryVerified(Attestation calldata a) internal {
        (uint256 deliveryId, bool approved,) = abi.decode(a.data, (uint256, bool, bytes32));

        if (a.recipient != address(deliveryManager)) revert Errors.InvalidRecipient();
        IDeliveryManager.Delivery memory d = deliveryManager.getDelivery(deliveryId);
        if (d.evidenceAttestationUID == bytes32(0)) revert Errors.EvidenceMissing();
        if (a.refUID != d.evidenceAttestationUID) revert Errors.InvalidRefUID();
        if (d.status != IDeliveryManager.DeliveryStatus.Open) revert Errors.InvalidDeliveryStatus();
        if (!roles.isIndependent(a.attester, registry.ngoOf(d.needId))) revert Errors.NotIndependent();

        deliveryManager.onDeliveryVerified(deliveryId, a.attester, approved, a.uid);
    }

    // ─── Settlement ────────────────────────────────────────────────────────────

    /// @dev Reconciles one tranche payout: gross must equal the tranche, fees must stay within the disclosed cap.
    ///      On-chain custody: the vault already released the tranche; the NGO reports how it reached the supplier.
    ///      Off-chain custody: the custodian holding the money reports the payout, which is what releases the
    ///      tranche in the ledger (the same checks as an on-chain release apply there).
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

        if (n.custodyMode == INeedsRegistry.CustodyMode.OnChain) {
            if (a.attester != n.ngo) revert Errors.Unauthorized();
            if (tranches[trancheIndex].status != ITrancheLedger.TrancheStatus.Released) {
                revert Errors.InvalidTrancheStatus();
            }
        } else {
            // The designation is the authority, not a live role: a custodian that loses its role must still be
            // able to report paying out money it already holds (the same rule as refunds by reference).
            if (a.attester != n.custodian) revert Errors.Unauthorized();
            INonCustodialLedger(n.vault).recordRelease(trancheIndex);
        }
        _checkCostCap(needId, n.vault, n.thirdPartyCostBps);
        emit SettlementLinked(needId, trancheIndex, a.uid, gross, fee, net);
    }

    // ─── ImpactReport ──────────────────────────────────────────────────────────

    /// @dev `refUID` must equal the DeliveryVerified UID of the need's last finalized delivery (or be empty if the
    ///      need had a single tranche and therefore no deliveries). One live report per need; revoke to correct.
    function _onImpactReport(Attestation calldata a) internal {
        (uint256 needId, uint32 beneficiariesServed, bytes32 kpiHash, string memory reportCID) =
            abi.decode(a.data, (uint256, uint32, bytes32, string));

        (address ngo, address vault,, INeedsRegistry.NeedStatus status) = registry.coreOf(needId);
        if (a.attester != ngo) revert Errors.Unauthorized();
        if (status != INeedsRegistry.NeedStatus.Completed) revert Errors.InvalidNeedStatus();
        if (a.recipient != vault) revert Errors.InvalidRecipient();
        if (kpiHash == bytes32(0) || bytes(reportCID).length == 0) revert Errors.InvalidParameter();
        // The same k-anonymity floor that `openDelivery` enforces: publishing "2 beneficiaries served" for a
        // known category and region is a small-count disclosure about identifiable people.
        if (beneficiariesServed < deliveryManager.minExpectedRecipients()) revert Errors.TooFewRecipients();
        if (a.refUID != _expectedImpactRefUID(needId)) revert Errors.InvalidRefUID();
        if (activeReportOf[needId] != bytes32(0)) revert Errors.ReportAlreadyActive();

        activeReportOf[needId] = a.uid;
        emit ImpactReportLinked(needId, a.uid, beneficiariesServed);
    }

    // ─── internal ──────────────────────────────────────────────────────────────

    function _checkAmounts(uint256 gross, uint256 fee, uint256 net) internal pure {
        if (gross < fee || gross - fee != net) revert Errors.AmountMismatch();
    }

    /// @dev The disclosure is binding and cumulative: everything intermediaries kept on the way in and on the way
    ///      out, together, stays within `thirdPartyCostBps` of what donors paid. Checking each fee on its own would
    ///      let a funding fee and a settlement fee stack past the cap donors were shown.
    function _checkCostCap(uint256 needId, address ledger, uint16 costCapBps) internal view {
        uint256 fundingFees = fundingFeesOf[needId];
        uint256 paidByDonors = ITrancheLedger(ledger).totalDonated() + fundingFees;
        if ((fundingFees + settlementFeesOf[needId]) * BPS_DENOMINATOR > paidByDonors * costCapBps) {
            revert Errors.FeeExceedsDisclosure();
        }
    }

    function _expectedImpactRefUID(uint256 needId) internal view returns (bytes32) {
        uint256 lastDelivery = deliveryManager.lastFinalizedDeliveryOf(needId);
        return lastDelivery == 0 ? bytes32(0) : deliveryManager.getDelivery(lastDelivery).verifierAttestationUID;
    }

    function _uid(string memory schema, bool revocable) internal view returns (bytes32) {
        return keccak256(abi.encodePacked(schema, address(this), revocable));
    }
}
