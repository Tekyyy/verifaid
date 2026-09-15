// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AidVault} from "../../src/funds/AidVault.sol";
import {IDeliveryManager} from "../../src/interfaces/IDeliveryManager.sol";
import {INeedsRegistry} from "../../src/interfaces/INeedsRegistry.sol";
import {Errors} from "../../src/libraries/Errors.sol";
import {ImpactReportResolver} from "../../src/resolvers/ImpactReportResolver.sol";
import {NeedVerifiedResolver} from "../../src/resolvers/NeedVerifiedResolver.sol";
import {PoATest} from "../utils/PoATest.sol";
import {
    AttestationRequest,
    AttestationRequestData
} from "@ethereum-attestation-service/eas-contracts/contracts/IEAS.sol";
import {ISchemaResolver} from "@ethereum-attestation-service/eas-contracts/contracts/resolver/ISchemaResolver.sol";

/// @notice Tests the five EAS resolvers: who may attest what, and how attestations drive the core contracts.
contract ResolversTest is PoATest {
    uint256 internal constant TARGET = 10_000e6;

    bytes32 internal constant DONOR_REF = keccak256("donor-ref");
    bytes32 internal constant PAYMENT_REF = keccak256("payment-ref");

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
        // indexers filtering on the five official UIDs would miss state-changing attestations.
        bytes32 foreign = schemaRegistry.register(
            "uint256 needId,bytes32 dossierHash,bool approved,bytes32 reportHash,uint256 extra",
            ISchemaResolver(address(needVerifiedResolver)),
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
        assertEq(needVerifiedResolver.SCHEMA_UID(), needVerifiedSchema);
        assertTrue(needVerifiedResolver.REVOCABLE());
        assertEq(address(needVerifiedResolver.registry()), address(registry));
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
        assertFalse(evidenceResolver.REVOCABLE());
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

    // ─── FiatDonation ──────────────────────────────────────────────────────────

    function test_fiatDonation_happyPath() public {
        _attestNeedVerified(verifier1, needId, true);
        _donateOnBehalf(needId, 1000e6, DONOR_REF, PAYMENT_REF);

        bytes32 uid = _attestFiatDonation(bankPartner, needId, 1000e6, PAYMENT_REF, DONOR_REF);
        assertEq(fiatDonationResolver.attestationOf(PAYMENT_REF), uid);
    }

    function test_fiatDonation_requiresMatchingOnChainDeposit() public {
        _attestNeedVerified(verifier1, needId, true);
        _donateOnBehalf(needId, 1000e6, DONOR_REF, PAYMENT_REF);
        address vaultAddress = registry.vaultOf(needId);

        // wrong amount
        vm.prank(bankPartner);
        vm.expectRevert(Errors.FiatDonationMismatch.selector);
        eas.attest(
            AttestationRequest({
                schema: fiatDonationSchema,
                data: _data(vaultAddress, bytes32(0), false, abi.encode(needId, 999e6, PAYMENT_REF, DONOR_REF))
            })
        );

        // wrong donor reference
        vm.prank(bankPartner);
        vm.expectRevert(Errors.FiatDonationMismatch.selector);
        eas.attest(
            AttestationRequest({
                schema: fiatDonationSchema,
                data: _data(vaultAddress, bytes32(0), false, abi.encode(needId, 1000e6, PAYMENT_REF, keccak256("x")))
            })
        );

        // unknown payment reference
        vm.prank(bankPartner);
        vm.expectRevert(Errors.FiatDonationMismatch.selector);
        eas.attest(
            AttestationRequest({
                schema: fiatDonationSchema,
                data: _data(vaultAddress, bytes32(0), false, abi.encode(needId, 1000e6, keccak256("nope"), DONOR_REF))
            })
        );
    }

    function test_fiatDonation_onlyBankPartnersAndOnlyOnce() public {
        _attestNeedVerified(verifier1, needId, true);
        _donateOnBehalf(needId, 1000e6, DONOR_REF, PAYMENT_REF);
        address vaultAddress = registry.vaultOf(needId);

        vm.prank(verifier1);
        vm.expectRevert(Errors.Unauthorized.selector);
        eas.attest(
            AttestationRequest({
                schema: fiatDonationSchema,
                data: _data(vaultAddress, bytes32(0), false, abi.encode(needId, 1000e6, PAYMENT_REF, DONOR_REF))
            })
        );

        _attestFiatDonation(bankPartner, needId, 1000e6, PAYMENT_REF, DONOR_REF);
        vm.prank(bankPartner);
        vm.expectRevert(Errors.FiatDonationAlreadyAttested.selector);
        eas.attest(
            AttestationRequest({
                schema: fiatDonationSchema,
                data: _data(vaultAddress, bytes32(0), false, abi.encode(needId, 1000e6, PAYMENT_REF, DONOR_REF))
            })
        );
    }

    function test_fiatDonation_requiresVaultRecipient() public {
        _attestNeedVerified(verifier1, needId, true);
        _donateOnBehalf(needId, 1000e6, DONOR_REF, PAYMENT_REF);

        vm.prank(bankPartner);
        vm.expectRevert(Errors.InvalidRecipient.selector);
        eas.attest(
            AttestationRequest({
                schema: fiatDonationSchema,
                data: _data(donor1, bytes32(0), false, abi.encode(needId, 1000e6, PAYMENT_REF, DONOR_REF))
            })
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
        assertEq(impactReportResolver.activeReportOf(completed), uid);

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
        assertEq(impactReportResolver.activeReportOf(completed), bytes32(0));
        bytes32 corrected = _attestImpactReport(ngo, completed, 130);
        assertEq(impactReportResolver.activeReportOf(completed), corrected);
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

    /// @dev Evidence, sign-offs and fiat donation records are registered as non-revocable schemas, so EAS itself
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

    function test_fiatDonationCannotBeRevoked() public {
        _attestNeedVerified(verifier1, needId, true);
        _donateOnBehalf(needId, 1000e6, DONOR_REF, PAYMENT_REF);
        bytes32 uid = _attestFiatDonation(bankPartner, needId, 1000e6, PAYMENT_REF, DONOR_REF);

        vm.expectRevert(bytes4(keccak256("Irrevocable()")));
        _revoke(fiatDonationSchema, bankPartner, uid);
    }

    // ─── constructor guards ────────────────────────────────────────────────────

    function test_resolverConstructorsRejectZeroAddresses() public {
        vm.expectRevert(Errors.ZeroAddress.selector);
        new NeedVerifiedResolver(eas, roles, INeedsRegistry(address(0)));

        vm.expectRevert(Errors.ZeroAddress.selector);
        new ImpactReportResolver(eas, roles, registry, IDeliveryManager(address(0)));
    }
}
