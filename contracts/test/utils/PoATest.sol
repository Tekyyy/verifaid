// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {SystemDeployer} from "../../script/lib/SystemDeployer.sol";
import {RoleRegistry} from "../../src/access/RoleRegistry.sol";
import {DeliveryManager} from "../../src/delivery/DeliveryManager.sol";
import {AidVault} from "../../src/funds/AidVault.sol";
import {AidVaultFactory} from "../../src/funds/AidVaultFactory.sol";
import {DonationReceipt} from "../../src/funds/DonationReceipt.sol";
import {BeneficiaryGroups} from "../../src/identity/BeneficiaryGroups.sol";
import {IAidVault} from "../../src/interfaces/IAidVault.sol";
import {IDeliveryManager} from "../../src/interfaces/IDeliveryManager.sol";
import {INeedsRegistry} from "../../src/interfaces/INeedsRegistry.sol";
import {MockEURC} from "../../src/mocks/MockEURC.sol";
import {MockSemaphore} from "../../src/mocks/MockSemaphore.sol";
import {NeedsRegistry} from "../../src/needs/NeedsRegistry.sol";
import {DeliveryEvidenceResolver} from "../../src/resolvers/DeliveryEvidenceResolver.sol";
import {DeliveryVerifiedResolver} from "../../src/resolvers/DeliveryVerifiedResolver.sol";
import {FiatDonationResolver} from "../../src/resolvers/FiatDonationResolver.sol";
import {ImpactReportResolver} from "../../src/resolvers/ImpactReportResolver.sol";
import {NeedVerifiedResolver} from "../../src/resolvers/NeedVerifiedResolver.sol";
import {
    AttestationRequest,
    AttestationRequestData,
    IEAS,
    RevocationRequest,
    RevocationRequestData
} from "@ethereum-attestation-service/eas-contracts/contracts/IEAS.sol";
import {ISchemaRegistry} from "@ethereum-attestation-service/eas-contracts/contracts/ISchemaRegistry.sol";
import {ISchemaResolver} from "@ethereum-attestation-service/eas-contracts/contracts/resolver/ISchemaResolver.sol";
import {ISemaphore} from "@semaphore-protocol/contracts/interfaces/ISemaphore.sol";
import {Test} from "forge-std/Test.sol";

/// @title PoATest
/// @notice Shared fixture: deploys the full Proof of Aid system (local EAS + MockSemaphore), registers the five
///         schemas and provides helpers for the recurring flows (needs, donations, deliveries, attestations).
abstract contract PoATest is Test, SystemDeployer {
    // ─── protocol parameters used in tests ─────────────────────────────────────
    uint256 internal constant HIGH_VALUE_THRESHOLD = 10_000e6;
    uint16 internal constant CONFIRMATION_THRESHOLD_BPS = 7000;
    uint64 internal constant CHALLENGE_PERIOD = 10 minutes;
    uint32 internal constant MIN_EXPECTED_RECIPIENTS = 5;
    string internal constant DASHBOARD_BASE_URI = "https://proofofaid.example/needs/";

    bytes32 internal constant FOOD = keccak256("FOOD");
    bytes32 internal constant SHELTER = keccak256("SHELTER");
    bytes32 internal constant REGION = bytes32("ES-CM");
    bytes32 internal constant DOSSIER_HASH = keccak256("encrypted-needs-assessment-1");
    bytes32 internal constant POLICY_HASH = keccak256("enrollment-policy-v1");
    bytes32 internal constant REPORT_HASH = keccak256("verifier-report");
    bytes32 internal constant EVIDENCE_HASH = keccak256("ciphertext");
    bytes32 internal constant KPI_HASH = keccak256("kpis");
    string internal constant EVIDENCE_CID = "bafkreieviDenceCidPlaceholder";
    string internal constant REPORT_CID = "bafkreiReportCidPlaceholder";

    // ─── actors ────────────────────────────────────────────────────────────────
    address internal admin = makeAddr("admin");
    address internal ngo = makeAddr("ngo");
    address internal ngoPayout = makeAddr("ngoPayout");
    address internal fieldAgent = makeAddr("fieldAgent");
    address internal ngo2 = makeAddr("ngo2");
    address internal ngo2Payout = makeAddr("ngo2Payout");
    address internal fieldAgent2 = makeAddr("fieldAgent2");
    address internal verifier1 = makeAddr("verifier1");
    address internal verifier2 = makeAddr("verifier2");
    address internal verifier3 = makeAddr("verifier3");
    address internal bankPartner = makeAddr("bankPartner");
    address internal donor1 = makeAddr("donor1");
    address internal donor2 = makeAddr("donor2");
    address internal relayer = makeAddr("relayer");
    address internal outsider = makeAddr("outsider");

    // ─── system under test ─────────────────────────────────────────────────────
    System internal sys;
    RoleRegistry internal roles;
    NeedsRegistry internal registry;
    AidVaultFactory internal factory;
    DonationReceipt internal receipt;
    BeneficiaryGroups internal groups;
    DeliveryManager internal deliveryManager;
    MockEURC internal token;
    MockSemaphore internal semaphore;
    IEAS internal eas;
    ISchemaRegistry internal schemaRegistry;

    NeedVerifiedResolver internal needVerifiedResolver;
    DeliveryEvidenceResolver internal evidenceResolver;
    DeliveryVerifiedResolver internal deliveryVerifiedResolver;
    FiatDonationResolver internal fiatDonationResolver;
    ImpactReportResolver internal impactReportResolver;

    bytes32 internal needVerifiedSchema;
    bytes32 internal deliveryEvidenceSchema;
    bytes32 internal deliveryVerifiedSchema;
    bytes32 internal fiatDonationSchema;
    bytes32 internal impactReportSchema;

    function setUp() public virtual {
        semaphore = new MockSemaphore();
        (address schemaRegistry_, address eas_) = _deployLocalEAS();
        schemaRegistry = ISchemaRegistry(schemaRegistry_);
        eas = IEAS(eas_);

        vm.startPrank(admin);
        sys = _deploySystem(
            Params({
                admin: admin,
                token: address(0),
                eas: eas_,
                semaphore: address(semaphore),
                highValueThreshold: HIGH_VALUE_THRESHOLD,
                confirmationThresholdBps: CONFIRMATION_THRESHOLD_BPS,
                challengePeriod: CHALLENGE_PERIOD,
                minExpectedRecipients: MIN_EXPECTED_RECIPIENTS,
                dashboardBaseURI: DASHBOARD_BASE_URI
            })
        );
        vm.stopPrank();

        roles = sys.roles;
        registry = sys.registry;
        factory = sys.factory;
        receipt = sys.receipt;
        groups = sys.groups;
        deliveryManager = sys.deliveryManager;
        token = MockEURC(sys.token);
        needVerifiedResolver = sys.needVerifiedResolver;
        evidenceResolver = sys.evidenceResolver;
        deliveryVerifiedResolver = sys.deliveryVerifiedResolver;
        fiatDonationResolver = sys.fiatDonationResolver;
        impactReportResolver = sys.impactReportResolver;

        _registerSchemas();
        _registerActors();
    }

    // ─── setup helpers ─────────────────────────────────────────────────────────

    function _registerSchemas() internal {
        needVerifiedSchema = schemaRegistry.register(
            needVerifiedResolver.SCHEMA(), ISchemaResolver(address(needVerifiedResolver)), true
        );
        deliveryEvidenceSchema =
            schemaRegistry.register(evidenceResolver.SCHEMA(), ISchemaResolver(address(evidenceResolver)), false);
        deliveryVerifiedSchema = schemaRegistry.register(
            deliveryVerifiedResolver.SCHEMA(), ISchemaResolver(address(deliveryVerifiedResolver)), false
        );
        fiatDonationSchema = schemaRegistry.register(
            fiatDonationResolver.SCHEMA(), ISchemaResolver(address(fiatDonationResolver)), false
        );
        impactReportSchema = schemaRegistry.register(
            impactReportResolver.SCHEMA(), ISchemaResolver(address(impactReportResolver)), true
        );

        // Each resolver derives the UID it accepts from its own address; the registry must agree.
        assertEq(needVerifiedSchema, needVerifiedResolver.SCHEMA_UID(), "NeedVerified schema uid");
        assertEq(deliveryEvidenceSchema, evidenceResolver.SCHEMA_UID(), "DeliveryEvidence schema uid");
        assertEq(deliveryVerifiedSchema, deliveryVerifiedResolver.SCHEMA_UID(), "DeliveryVerified schema uid");
        assertEq(fiatDonationSchema, fiatDonationResolver.SCHEMA_UID(), "FiatDonation schema uid");
        assertEq(impactReportSchema, impactReportResolver.SCHEMA_UID(), "ImpactReport schema uid");
    }

    function _registerActors() internal {
        vm.startPrank(admin);
        roles.registerNgo(ngo, ngoPayout, keccak256("ngo-credential"), "ipfs://ngo-profile");
        roles.registerNgo(ngo2, ngo2Payout, keccak256("ngo2-credential"), "ipfs://ngo2-profile");
        roles.registerVerifier(verifier1);
        roles.registerVerifier(verifier2);
        roles.registerVerifier(verifier3);
        roles.registerBankPartner(bankPartner);
        vm.stopPrank();

        vm.prank(ngo);
        roles.addFieldAgent(fieldAgent);
        vm.prank(ngo2);
        roles.addFieldAgent(fieldAgent2);
    }

    // ─── programs & needs ──────────────────────────────────────────────────────

    /// @dev Creates a program owned by `owner` with `members` enrolled identity commitments.
    function _createProgram(address owner, uint256 members) internal returns (uint256 programId) {
        vm.prank(owner);
        programId = groups.createProgram(POLICY_HASH, "ipfs://program");
        if (members > 0) {
            uint256[] memory commitments = new uint256[](members);
            for (uint256 i; i < members; ++i) {
                commitments[i] = uint256(keccak256(abi.encode(owner, programId, i)));
            }
            vm.prank(owner);
            groups.addMembers(programId, commitments);
        }
    }

    function _threeTrancheBps() internal pure returns (uint16[] memory bps) {
        bps = new uint16[](3);
        bps[0] = 3000;
        bps[1] = 4000;
        bps[2] = 3000;
    }

    function _singleTrancheBps() internal pure returns (uint16[] memory bps) {
        bps = new uint16[](1);
        bps[0] = 10_000;
    }

    function _needParams(uint256 programId, uint256 target, uint8 verificationsRequired, uint16[] memory bps)
        internal
        pure
        returns (INeedsRegistry.CreateNeedParams memory p)
    {
        p = INeedsRegistry.CreateNeedParams({
            programId: programId,
            category: FOOD,
            targetAmount: target,
            regionCode: REGION,
            dossierHash: DOSSIER_HASH,
            metadataURI: "ipfs://need",
            verificationsRequired: verificationsRequired,
            trancheBps: bps
        });
    }

    function _createNeed(address owner, uint256 programId, uint256 target, uint8 verificationsRequired)
        internal
        returns (uint256 needId)
    {
        vm.prank(owner);
        needId = registry.createNeed(_needParams(programId, target, verificationsRequired, _threeTrancheBps()));
    }

    /// @dev Full happy path up to `Funding`: program, need and the required NeedVerified attestations.
    ///      Above the high-value threshold the need needs two independent verifiers, so both attest.
    function _verifiedNeed(uint256 target) internal returns (uint256 needId, uint256 programId, AidVault vault) {
        uint8 verificationsRequired = target > HIGH_VALUE_THRESHOLD ? 2 : 1;
        programId = _createProgram(ngo, 10);
        needId = _createNeed(ngo, programId, target, verificationsRequired);
        _attestNeedVerified(verifier1, needId, true);
        if (verificationsRequired > 1) _attestNeedVerified(verifier2, needId, true);
        vault = AidVault(registry.vaultOf(needId));
    }

    // ─── attestations ──────────────────────────────────────────────────────────

    function _attest(
        bytes32 schema,
        address attester,
        address recipient,
        bytes32 refUID,
        bool revocable,
        bytes memory data
    ) internal returns (bytes32 uid) {
        vm.prank(attester);
        uid = eas.attest(
            AttestationRequest({
                schema: schema,
                data: AttestationRequestData({
                    recipient: recipient, expirationTime: 0, revocable: revocable, refUID: refUID, data: data, value: 0
                })
            })
        );
    }

    function _attestNeedVerified(address verifier, uint256 needId, bool approved) internal returns (bytes32 uid) {
        return _attestNeedVerified(verifier, needId, approved, DOSSIER_HASH);
    }

    function _attestNeedVerified(address verifier, uint256 needId, bool approved, bytes32 dossierHash)
        internal
        returns (bytes32 uid)
    {
        uid = _attest(
            needVerifiedSchema,
            verifier,
            address(registry),
            bytes32(0),
            true,
            abi.encode(needId, dossierHash, approved, REPORT_HASH)
        );
    }

    function _revoke(bytes32 schema, address attester, bytes32 uid) internal {
        vm.prank(attester);
        eas.revoke(RevocationRequest({schema: schema, data: RevocationRequestData({uid: uid, value: 0})}));
    }

    function _attestEvidence(address agent, uint256 deliveryId) internal returns (bytes32 uid) {
        return _attestEvidence(agent, deliveryId, REGION);
    }

    function _attestEvidence(address agent, uint256 deliveryId, bytes32 regionCode) internal returns (bytes32 uid) {
        uid = _attest(
            deliveryEvidenceSchema,
            agent,
            address(deliveryManager),
            bytes32(0),
            false,
            abi.encode(deliveryId, EVIDENCE_HASH, EVIDENCE_CID, uint32(120), regionCode)
        );
    }

    function _attestDeliveryVerified(address verifier, uint256 deliveryId, bool approved)
        internal
        returns (bytes32 uid)
    {
        bytes32 evidenceUID = deliveryManager.getDelivery(deliveryId).evidenceAttestationUID;
        uid = _attest(
            deliveryVerifiedSchema,
            verifier,
            address(deliveryManager),
            evidenceUID,
            false,
            abi.encode(deliveryId, approved, REPORT_HASH)
        );
    }

    function _attestFiatDonation(
        address partner,
        uint256 needId,
        uint256 amount,
        bytes32 paymentRefHash,
        bytes32 donorRefHash
    ) internal returns (bytes32 uid) {
        uid = _attest(
            fiatDonationSchema,
            partner,
            registry.vaultOf(needId),
            bytes32(0),
            false,
            abi.encode(needId, amount, paymentRefHash, donorRefHash)
        );
    }

    function _attestImpactReport(address attester, uint256 needId, uint32 beneficiariesServed)
        internal
        returns (bytes32 uid)
    {
        uint256 lastDelivery = deliveryManager.lastFinalizedDeliveryOf(needId);
        bytes32 refUID =
            lastDelivery == 0 ? bytes32(0) : deliveryManager.getDelivery(lastDelivery).verifierAttestationUID;
        uid = _attest(
            impactReportSchema,
            attester,
            registry.vaultOf(needId),
            refUID,
            true,
            abi.encode(needId, beneficiariesServed, KPI_HASH, REPORT_CID)
        );
    }

    // ─── donations ─────────────────────────────────────────────────────────────

    /// @dev Mints and approves `amount` for `donor` without touching the vault, so a following
    ///      `vm.expectEmit` sees the donation event rather than the token's Transfer/Approval events.
    function _fundDonor(address donor, uint256 needId, uint256 amount) internal {
        address vault = registry.vaultOf(needId);
        token.mint(donor, amount);
        vm.prank(donor);
        token.approve(vault, amount);
    }

    function _donate(address donor, uint256 needId, uint256 amount) internal returns (uint256 receiptId) {
        address vault = registry.vaultOf(needId);
        token.mint(donor, amount);
        vm.startPrank(donor);
        token.approve(vault, amount);
        receiptId = IAidVault(vault).donate(amount);
        vm.stopPrank();
    }

    function _donateOnBehalf(uint256 needId, uint256 amount, bytes32 donorRefHash, bytes32 paymentRefHash) internal {
        address vault = registry.vaultOf(needId);
        token.mint(bankPartner, amount);
        vm.startPrank(bankPartner);
        token.approve(vault, amount);
        IAidVault(vault).donateOnBehalf(amount, donorRefHash, paymentRefHash);
        vm.stopPrank();
    }

    // ─── deliveries ────────────────────────────────────────────────────────────

    /// @dev Builds a MockSemaphore-valid proof (points[0] == 1) with a unique nullifier.
    function _proof(uint256 deliveryId, uint256 nullifierSeed)
        internal
        view
        returns (ISemaphore.SemaphoreProof memory proof)
    {
        uint256[8] memory points;
        points[0] = 1;
        proof = ISemaphore.SemaphoreProof({
            merkleTreeDepth: 3,
            merkleTreeRoot: uint256(keccak256("root")),
            nullifier: uint256(keccak256(abi.encode(deliveryId, nullifierSeed))),
            message: deliveryManager.AID_RECEIVED_MESSAGE(),
            scope: deliveryId,
            points: points
        });
    }

    /// @dev Submits `count` anonymous confirmations relayed by `relayer`.
    function _confirm(uint256 deliveryId, uint256 count) internal {
        for (uint256 i; i < count; ++i) {
            vm.prank(relayer);
            deliveryManager.confirmReceipt(deliveryId, _proof(deliveryId, i));
        }
    }

    /// @dev Evidence + threshold confirmations + approving verifier, then waits out the challenge period.
    function _runDelivery(uint256 needId, uint256 trancheIndex, uint32 expectedRecipients)
        internal
        returns (uint256 deliveryId)
    {
        vm.prank(fieldAgent);
        deliveryId = deliveryManager.openDelivery(needId, trancheIndex, expectedRecipients);
        _attestEvidence(fieldAgent, deliveryId);
        _confirm(deliveryId, _requiredConfirmations(expectedRecipients));
        _attestDeliveryVerified(verifier2, deliveryId, true);
        vm.warp(block.timestamp + CHALLENGE_PERIOD);
        deliveryManager.finalize(deliveryId);
    }

    function _requiredConfirmations(uint32 expectedRecipients) internal pure returns (uint256) {
        uint256 numerator = uint256(expectedRecipients) * CONFIRMATION_THRESHOLD_BPS;
        return (numerator + 9999) / 10_000;
    }

    // ─── assertions ────────────────────────────────────────────────────────────

    function assertEq(INeedsRegistry.NeedStatus a, INeedsRegistry.NeedStatus b) internal pure {
        assertEq(uint8(a), uint8(b), "need status");
    }

    function assertEq(IDeliveryManager.DeliveryStatus a, IDeliveryManager.DeliveryStatus b) internal pure {
        assertEq(uint8(a), uint8(b), "delivery status");
    }

    function assertEq(IAidVault.TrancheStatus a, IAidVault.TrancheStatus b) internal pure {
        assertEq(uint8(a), uint8(b), "tranche status");
    }

    /// @dev The core vault accounting invariant from the spec (§5.4).
    function assertVaultInvariant(AidVault vault) internal view {
        assertEq(
            token.balanceOf(address(vault)) + vault.totalReleased() + vault.totalRefunded(),
            vault.totalDonated(),
            "vault invariant"
        );
    }
}
