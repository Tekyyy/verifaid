// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AidVault} from "../../src/funds/AidVault.sol";
import {IDeliveryManager} from "../../src/interfaces/IDeliveryManager.sol";
import {INeedsRegistry} from "../../src/interfaces/INeedsRegistry.sol";
import {Errors} from "../../src/libraries/Errors.sol";
import {ProofOfAidResolver} from "../../src/resolvers/ProofOfAidResolver.sol";
import {PoATest} from "../utils/PoATest.sol";
import {
    AttestationRequest,
    AttestationRequestData
} from "@ethereum-attestation-service/eas-contracts/contracts/IEAS.sol";
import {ISchemaResolver} from "@ethereum-attestation-service/eas-contracts/contracts/resolver/ISchemaResolver.sol";

/// @notice Tests the resolver for all six schemas: who may attest what, and how attestations drive the core contracts.
contract ResolversTest is PoATest {
    uint256 internal constant TARGET = 10_000e6;

    uint256 internal programId;
    uint256 internal needId;
    AidVault internal vault;

    function setUp() public override {
        super.setUp();
        programId = _createProgram(ngo, 10);
        needId = _createNeed(ngo, programId, TARGET, 1);
    }

    function _attestRaw(bytes32 schema, address attester, AttestationRequestData memory data)
        internal
        returns (bytes32)
    {
        vm.prank(attester);
        return eas.attest(AttestationRequest({schema: schema, data: data}));
    }

    function _data(address recipient, bytes32 refUID, bool revocable, bytes memory payload)
        internal
        pure
        returns (AttestationRequestData memory)
    {
        return AttestationRequestData({
            recipient: recipient, expirationTime: 0, revocable: revocable, refUID: refUID, data: payload, value: 0
        });
    }

    // ─── shared resolver rules ─────────────────────────────────────────────────

    function test_rejectsAttestationUnderAForeignSchema() public {
        // Anyone can register another schema pointing at our resolver; the resolver must ignore it, otherwise
        // indexers filtering on the six official UIDs would miss state-changing attestations.
        bytes32 foreign = schemaRegistry.register(
            "uint256 needId,bytes32 dossierHash,bool approved,bytes32 reportHash,uint256 extra",
            ISchemaResolver(address(resolver)),
            true
        );
        vm.prank(verifier1);
        vm.expectRevert(Errors.WrongSchema.selector);
        eas.attest(
            AttestationRequest({
                schema: foreign,
                data: _data(
                    address(registry), bytes32(0), true, abi.encode(needId, DOSSIER_HASH, true, REPORT_HASH, uint256(1))
                )
            })
        );
    }

    function test_rejectsExpiringAttestation() public {
        vm.prank(verifier1);
        vm.expectRevert(Errors.ExpiringAttestation.selector);
        eas.attest(
            AttestationRequest({
                schema: needVerifiedSchema,
                data: AttestationRequestData({
                    recipient: address(registry),
                    expirationTime: uint64(block.timestamp + 365 days),
                    revocable: true,
                    refUID: bytes32(0),
                    data: abi.encode(needId, DOSSIER_HASH, true, REPORT_HASH),
                    value: 0
                })
            })
        );
    }

    function test_rejectsAttestationsWhilePaused() public {
        vm.prank(admin);
        roles.pause();
        vm.prank(verifier1);
        vm.expectRevert(Errors.SystemPaused.selector);
        eas.attest(
            AttestationRequest({
                schema: needVerifiedSchema,
                data: _data(address(registry), bytes32(0), true, abi.encode(needId, DOSSIER_HASH, true, REPORT_HASH))
            })
        );
    }

    // ─── NeedVerified ──────────────────────────────────────────────────────────

    function test_needVerified_happyPath() public {
        bytes32 uid = _attestNeedVerified(verifier1, needId, true);
        assertEq(registry.verificationUID(needId, verifier1), uid);
        assertEq(registry.statusOf(needId), INeedsRegistry.NeedStatus.Funding);
        assertEq(resolver.NEED_VERIFIED_UID(), needVerifiedSchema);
        (, bool revocable,) = resolver.schemaAt(0);
        assertTrue(revocable);
        assertEq(address(resolver.registry()), address(registry));
    }

    function test_needVerified_rejectsWrongRecipient() public {
        vm.prank(verifier1);
        vm.expectRevert(Errors.InvalidRecipient.selector);
        eas.attest(
            AttestationRequest({
                schema: needVerifiedSchema,
                // never a person — the recipient must be the registry
                data: _data(donor1, bytes32(0), true, abi.encode(needId, DOSSIER_HASH, true, REPORT_HASH))
            })
        );
    }

    function test_needVerified_rejectsDossierMismatch() public {
        vm.prank(verifier1);
        vm.expectRevert(Errors.DossierMismatch.selector);
        eas.attest(
            AttestationRequest({
                schema: needVerifiedSchema,
                data: _data(
                    address(registry),
                    bytes32(0),
                    true,
                    abi.encode(needId, keccak256("other-dossier"), true, REPORT_HASH)
                )
            })
        );
    }

    function test_needVerified_rejectsNonIndependentAttesters() public {
        // the NGO itself
        vm.prank(ngo);
        vm.expectRevert(Errors.NotIndependent.selector);
        eas.attest(
            AttestationRequest({
                schema: needVerifiedSchema,
                data: _data(address(registry), bytes32(0), true, abi.encode(needId, DOSSIER_HASH, true, REPORT_HASH))
            })
        );

        // its field agent
        vm.prank(fieldAgent);
        vm.expectRevert(Errors.NotIndependent.selector);
        eas.attest(
            AttestationRequest({
                schema: needVerifiedSchema,
                data: _data(address(registry), bytes32(0), true, abi.encode(needId, DOSSIER_HASH, true, REPORT_HASH))
            })
        );

        // a stranger with no verifier role
        vm.prank(outsider);
        vm.expectRevert(Errors.NotIndependent.selector);
        eas.attest(
            AttestationRequest({
                schema: needVerifiedSchema,
                data: _data(address(registry), bytes32(0), true, abi.encode(needId, DOSSIER_HASH, true, REPORT_HASH))
            })
        );
    }

    function test_needVerified_rejectsNeedThatIsNotPending() public {
        _attestNeedVerified(verifier1, needId, true); // → Funding
        vm.prank(verifier2);
        vm.expectRevert(Errors.InvalidNeedStatus.selector);
        eas.attest(
            AttestationRequest({
                schema: needVerifiedSchema,
                data: _data(address(registry), bytes32(0), true, abi.encode(needId, DOSSIER_HASH, true, REPORT_HASH))
            })
        );
    }

    function test_needVerified_revocationFlowsBackToRegistry() public {
        bytes32 uid = _attestNeedVerified(verifier1, needId, true);
        _revoke(needVerifiedSchema, verifier1, uid);
        assertEq(registry.statusOf(needId), INeedsRegistry.NeedStatus.Pending);
        assertEq(registry.getNeed(needId).verificationCount, 0);
    }

    // ─── DeliveryEvidence ──────────────────────────────────────────────────────

    function _deliveryReady() internal returns (uint256 deliveryId) {
        _attestNeedVerified(verifier1, needId, true);
        vault = AidVault(registry.vaultOf(needId));
        _donate(donor1, needId, TARGET);
        vault.releaseTranche(0);
        vm.prank(fieldAgent);
        deliveryId = deliveryManager.openDelivery(needId, 1, 10);
    }

    function test_deliveryEvidence_happyPath() public {
        uint256 deliveryId = _deliveryReady();
        bytes32 uid = _attestEvidence(fieldAgent, deliveryId);
        assertEq(deliveryManager.getDelivery(deliveryId).evidenceAttestationUID, uid);
        (, bool revocable,) = resolver.schemaAt(2);
        assertFalse(revocable);
    }

    function test_deliveryEvidence_onlyTheDeliverysFieldAgent() public {
        uint256 deliveryId = _deliveryReady();

        vm.prank(fieldAgent2);
        vm.expectRevert(Errors.Unauthorized.selector);
        eas.attest(
            AttestationRequest({
                schema: deliveryEvidenceSchema,
                data: _data(
                    address(deliveryManager),
                    bytes32(0),
                    false,
                    abi.encode(deliveryId, EVIDENCE_HASH, EVIDENCE_CID, uint32(10), REGION)
                )
            })
        );

        // an agent removed from the NGO can no longer file evidence
        vm.prank(ngo);
        roles.removeFieldAgent(fieldAgent);
        vm.prank(fieldAgent);
        vm.expectRevert(Errors.Unauthorized.selector);
        eas.attest(
            AttestationRequest({
                schema: deliveryEvidenceSchema,
                data: _data(
                    address(deliveryManager),
                    bytes32(0),
                    false,
                    abi.encode(deliveryId, EVIDENCE_HASH, EVIDENCE_CID, uint32(10), REGION)
                )
            })
        );
    }

    function test_deliveryEvidence_validatesPayload() public {
        uint256 deliveryId = _deliveryReady();

        vm.startPrank(fieldAgent);
        vm.expectRevert(Errors.InvalidParameter.selector);
        eas.attest(
            AttestationRequest({
                schema: deliveryEvidenceSchema,
                data: _data(
                    address(deliveryManager),
                    bytes32(0),
                    false,
                    abi.encode(deliveryId, bytes32(0), EVIDENCE_CID, uint32(10), REGION)
                )
            })
        );

        vm.expectRevert(Errors.InvalidParameter.selector);
        eas.attest(
            AttestationRequest({
                schema: deliveryEvidenceSchema,
                data: _data(
                    address(deliveryManager),
                    bytes32(0),
                    false,
                    abi.encode(deliveryId, EVIDENCE_HASH, "", uint32(10), REGION)
                )
            })
        );

        vm.expectRevert(Errors.InvalidParameter.selector);
        eas.attest(
            AttestationRequest({
                schema: deliveryEvidenceSchema,
                data: _data(
                    address(deliveryManager),
                    bytes32(0),
                    false,
                    abi.encode(deliveryId, EVIDENCE_HASH, EVIDENCE_CID, uint32(0), REGION)
                )
            })
        );

        // region must match the need's coarse region
        vm.expectRevert(Errors.RegionMismatch.selector);
        eas.attest(
            AttestationRequest({
                schema: deliveryEvidenceSchema,
                data: _data(
                    address(deliveryManager),
                    bytes32(0),
                    false,
                    abi.encode(deliveryId, EVIDENCE_HASH, EVIDENCE_CID, uint32(10), bytes32("FR-75"))
                )
            })
        );
        vm.stopPrank();
    }

    function test_deliveryEvidence_rejectsSecondEvidence() public {
        uint256 deliveryId = _deliveryReady();
        _attestEvidence(fieldAgent, deliveryId);
        vm.prank(fieldAgent);
        vm.expectRevert(Errors.EvidenceAlreadyLinked.selector);
        eas.attest(
            AttestationRequest({
                schema: deliveryEvidenceSchema,
                data: _data(
                    address(deliveryManager),
                    bytes32(0),
                    false,
                    abi.encode(deliveryId, keccak256("other"), EVIDENCE_CID, uint32(10), REGION)
                )
            })
        );
    }

    // ─── DeliveryVerified ──────────────────────────────────────────────────────

    function test_deliveryVerified_requiresRefUidPointingAtTheEvidence() public {
        uint256 deliveryId = _deliveryReady();
        bytes32 evidenceUID = _attestEvidence(fieldAgent, deliveryId);

        vm.prank(verifier2);
        vm.expectRevert(Errors.InvalidRefUID.selector);
        eas.attest(
            AttestationRequest({
                schema: deliveryVerifiedSchema,
                data: _data(address(deliveryManager), bytes32(0), false, abi.encode(deliveryId, true, REPORT_HASH))
            })
        );

        bytes32 uid = _attestDeliveryVerified(verifier2, deliveryId, true);
        assertEq(deliveryManager.getDelivery(deliveryId).verifierAttestationUID, uid);
        assertEq(eas.getAttestation(uid).refUID, evidenceUID, "evidence chain");
    }

    function test_deliveryVerified_requiresEvidenceAndIndependence() public {
        uint256 deliveryId = _deliveryReady();

        vm.prank(verifier2);
        vm.expectRevert(Errors.EvidenceMissing.selector);
        eas.attest(
            AttestationRequest({
                schema: deliveryVerifiedSchema,
                data: _data(address(deliveryManager), bytes32(0), false, abi.encode(deliveryId, true, REPORT_HASH))
            })
        );

        bytes32 evidenceUID = _attestEvidence(fieldAgent, deliveryId);

        vm.prank(ngo);
        vm.expectRevert(Errors.NotIndependent.selector);
        eas.attest(
            AttestationRequest({
                schema: deliveryVerifiedSchema,
                data: _data(address(deliveryManager), evidenceUID, false, abi.encode(deliveryId, true, REPORT_HASH))
            })
        );
    }

    // ─── conversion costs ──────────────────────────────────────────────────────

    /// @dev What a conversion costs on the way in counts against the need's disclosed cap, exactly at the boundary.
    ///      Money only arrives on chain, so these are the only fees recorded before funding closes.
    function test_conversionFees_upToTheDisclosedCapAreAccepted() public {
        INeedsRegistry.CreateNeedParams memory p = _needParams(programId, TARGET, 1, _threeTrancheBps());
        p.thirdPartyCostBps = 250; // 2.5%
        p.costDisclosureHash = COST_DISCLOSURE_HASH;
        uint256 costlyNeed = _verifiedNeedWith(p);
        AidVault costlyVault = AidVault(registry.vaultOf(costlyNeed));
        token.mint(address(forwarderFactory), 2000e6);
        vm.startPrank(address(forwarderFactory));
        token.approve(address(costlyVault), 2000e6);

        // 25 on 1000 paid is exactly the cap
        costlyVault.donateVia(975e6, 25e6, donor1);
        assertEq(resolver.fundingFeesOf(costlyNeed), 25e6);

        // 26 more on the next 1000 is not
        vm.expectRevert(Errors.FeeExceedsDisclosure.selector);
        costlyVault.donateVia(974e6, 26e6, donor2);
        vm.stopPrank();
    }

    // ─── Settlement ────────────────────────────────────────────────────────────

    function _settlementPayload(uint256 trancheIndex, uint256 gross, uint256 fee, bytes32 supplierRef)
        internal
        view
        returns (bytes memory)
    {
        return abi.encode(needId, trancheIndex, gross, fee, gross - fee, supplierRef, FX_REF);
    }

    function test_settlement_recordsTheNgosReconciliationOfAReleasedTranche() public {
        _attestNeedVerified(verifier1, needId, true);
        vault = AidVault(registry.vaultOf(needId));
        _donate(donor1, needId, TARGET);
        vault.releaseTranche(0);
        uint256 tranche0 = vault.getTranches()[0].amount;

        bytes32 uid = _attestSettlement(ngo, needId, 0, tranche0, 0);
        assertEq(resolver.settlementOf(needId, 0), uid);

        // once per tranche
        vm.expectRevert(Errors.SettlementAlreadyRecorded.selector);
        _attestRaw(
            settlementSchema,
            ngo,
            _data(address(vault), bytes32(0), false, _settlementPayload(0, tranche0, 0, SUPPLIER_REF))
        );
    }

    function test_settlement_rejectsInvalidReconciliations() public {
        _attestNeedVerified(verifier1, needId, true);
        vault = AidVault(registry.vaultOf(needId));
        _donate(donor1, needId, TARGET);
        uint256 tranche0 = vault.getTranches()[0].amount;
        uint256 tranche1 = vault.getTranches()[1].amount;

        // tranche 0 is releasable but not yet released
        vm.expectRevert(Errors.InvalidTrancheStatus.selector);
        _attestRaw(
            settlementSchema,
            ngo,
            _data(address(vault), bytes32(0), false, _settlementPayload(0, tranche0, 0, SUPPLIER_REF))
        );

        vault.releaseTranche(0);

        // only the NGO reports how its payout reached suppliers
        vm.expectRevert(Errors.Unauthorized.selector);
        _attestRaw(
            settlementSchema,
            verifier1,
            _data(address(vault), bytes32(0), false, _settlementPayload(0, tranche0, 0, SUPPLIER_REF))
        );

        // gross must be the whole tranche
        vm.expectRevert(Errors.AmountMismatch.selector);
        _attestRaw(
            settlementSchema,
            ngo,
            _data(address(vault), bytes32(0), false, _settlementPayload(0, tranche0 - 1, 0, SUPPLIER_REF))
        );

        // no costs were disclosed for this need
        vm.expectRevert(Errors.FeeExceedsDisclosure.selector);
        _attestRaw(
            settlementSchema,
            ngo,
            _data(address(vault), bytes32(0), false, _settlementPayload(0, tranche0, 1, SUPPLIER_REF))
        );

        // a still-locked tranche
        vm.expectRevert(Errors.InvalidTrancheStatus.selector);
        _attestRaw(
            settlementSchema,
            ngo,
            _data(address(vault), bytes32(0), false, _settlementPayload(1, tranche1, 0, SUPPLIER_REF))
        );

        // an unknown tranche
        vm.expectRevert(Errors.InvalidTrancheIndex.selector);
        _attestRaw(
            settlementSchema,
            ngo,
            _data(address(vault), bytes32(0), false, _settlementPayload(7, tranche0, 0, SUPPLIER_REF))
        );

        // a missing supplier reference
        vm.expectRevert(Errors.InvalidParameter.selector);
        _attestRaw(
            settlementSchema,
            ngo,
            _data(address(vault), bytes32(0), false, _settlementPayload(0, tranche0, 0, bytes32(0)))
        );

        // the wrong recipient
        vm.expectRevert(Errors.InvalidRecipient.selector);
        _attestRaw(
            settlementSchema,
            ngo,
            _data(address(registry), bytes32(0), false, _settlementPayload(0, tranche0, 0, SUPPLIER_REF))
        );
    }

    // ─── ImpactReport ──────────────────────────────────────────────────────────

    function _completedNeed() internal returns (uint256 completedNeedId) {
        vm.prank(ngo);
        completedNeedId = registry.createNeed(_needParams(programId, 1000e6, 1, _singleTrancheBps()));
        _attestNeedVerified(verifier1, completedNeedId, true);
        _donate(donor1, completedNeedId, 1000e6);
        AidVault(registry.vaultOf(completedNeedId)).releaseTranche(0);
        assertEq(registry.statusOf(completedNeedId), INeedsRegistry.NeedStatus.Completed);
    }

    function test_impactReport_happyPath() public {
        uint256 completed = _completedNeed();
        address vaultAddress = registry.vaultOf(completed);
        bytes32 uid = _attestImpactReport(ngo, completed, 120);
        assertEq(resolver.activeReportOf(completed), uid);

        // one live report at a time; revoking makes room for a correction
        vm.prank(ngo);
        vm.expectRevert(Errors.ReportAlreadyActive.selector);
        eas.attest(
            AttestationRequest({
                schema: impactReportSchema,
                data: _data(vaultAddress, bytes32(0), true, abi.encode(completed, uint32(130), KPI_HASH, REPORT_CID))
            })
        );

        _revoke(impactReportSchema, ngo, uid);
        assertEq(resolver.activeReportOf(completed), bytes32(0));
        bytes32 corrected = _attestImpactReport(ngo, completed, 130);
        assertEq(resolver.activeReportOf(completed), corrected);
    }

    /// @dev The same k-anonymity floor deliveries enforce: "2 beneficiaries served" in a known category and
    ///      region is a small-count disclosure about identifiable people.
    function test_impactReport_enforcesTheKAnonymityFloor() public {
        uint256 completed = _completedNeed();
        address vaultAddress = registry.vaultOf(completed);

        vm.prank(ngo);
        vm.expectRevert(Errors.TooFewRecipients.selector);
        eas.attest(
            AttestationRequest({
                schema: impactReportSchema,
                data: _data(vaultAddress, bytes32(0), true, abi.encode(completed, uint32(2), KPI_HASH, REPORT_CID))
            })
        );

        // at the floor it is accepted
        bytes32 uid = _attestImpactReport(ngo, completed, MIN_EXPECTED_RECIPIENTS);
        assertEq(resolver.activeReportOf(completed), uid);
    }

    function test_impactReport_onlyNgoAndOnlyWhenCompleted() public {
        uint256 completed = _completedNeed();
        address completedVault = registry.vaultOf(completed);

        vm.prank(verifier1);
        vm.expectRevert(Errors.Unauthorized.selector);
        eas.attest(
            AttestationRequest({
                schema: impactReportSchema,
                data: _data(completedVault, bytes32(0), true, abi.encode(completed, uint32(10), KPI_HASH, REPORT_CID))
            })
        );

        _attestNeedVerified(verifier1, needId, true); // needId is only in Funding
        address fundingVault = registry.vaultOf(needId);
        vm.prank(ngo);
        vm.expectRevert(Errors.InvalidNeedStatus.selector);
        eas.attest(
            AttestationRequest({
                schema: impactReportSchema,
                data: _data(fundingVault, bytes32(0), true, abi.encode(needId, uint32(10), KPI_HASH, REPORT_CID))
            })
        );
    }

    function test_impactReport_validatesPayloadAndRefUid() public {
        uint256 completed = _completedNeed();
        address vaultAddress = registry.vaultOf(completed);

        vm.startPrank(ngo);
        vm.expectRevert(Errors.InvalidParameter.selector);
        eas.attest(
            AttestationRequest({
                schema: impactReportSchema,
                data: _data(vaultAddress, bytes32(0), true, abi.encode(completed, uint32(10), bytes32(0), REPORT_CID))
            })
        );

        vm.expectRevert(Errors.InvalidParameter.selector);
        eas.attest(
            AttestationRequest({
                schema: impactReportSchema,
                data: _data(vaultAddress, bytes32(0), true, abi.encode(completed, uint32(10), KPI_HASH, ""))
            })
        );
        vm.stopPrank();

        // a need with no finalized delivery must reference nothing
        bytes32 strayRef = _attestNeedVerified(verifier2, needId, true);
        vm.prank(ngo);
        vm.expectRevert(Errors.InvalidRefUID.selector);
        eas.attest(
            AttestationRequest({
                schema: impactReportSchema,
                data: _data(vaultAddress, strayRef, true, abi.encode(completed, uint32(10), KPI_HASH, REPORT_CID))
            })
        );
    }

    // ─── irrevocability ────────────────────────────────────────────────────────

    /// @dev Evidence, sign-offs and settlements are registered as non-revocable schemas, so EAS itself
    ///      refuses the revocation before the resolver's `NotRevocable` guard is ever reached.
    function test_evidenceAndSignOffCannotBeRevoked() public {
        bytes4 irrevocable = bytes4(keccak256("Irrevocable()"));
        uint256 deliveryId = _deliveryReady();
        bytes32 evidenceUID = _attestEvidence(fieldAgent, deliveryId);

        vm.expectRevert(irrevocable);
        _revoke(deliveryEvidenceSchema, fieldAgent, evidenceUID);

        bytes32 signOffUID = _attestDeliveryVerified(verifier2, deliveryId, true);
        vm.expectRevert(irrevocable);
        _revoke(deliveryVerifiedSchema, verifier2, signOffUID);
    }

    function test_schemaAtRejectsUnknownIndex() public {
        vm.expectRevert(Errors.InvalidParameter.selector);
        resolver.schemaAt(5);
        assertEq(resolver.SCHEMA_COUNT(), 5);
    }

    // ─── constructor guards ────────────────────────────────────────────────────

    function test_resolverConstructorRejectsZeroAddresses() public {
        vm.expectRevert(Errors.ZeroAddress.selector);
        new ProofOfAidResolver(eas, roles, INeedsRegistry(address(0)), deliveryManager);

        vm.expectRevert(Errors.ZeroAddress.selector);
        new ProofOfAidResolver(eas, roles, registry, IDeliveryManager(address(0)));
    }
}
