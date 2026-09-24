// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {SystemDeployer} from "../../script/lib/SystemDeployer.sol";
import {RoleRegistry} from "../../src/access/RoleRegistry.sol";
import {BeneficiaryRegistry} from "../../src/beneficiaries/BeneficiaryRegistry.sol";
import {CommunityProofs} from "../../src/community/CommunityProofs.sol";
import {ConversionRouter} from "../../src/conversion/ConversionRouter.sol";
import {DeliveryManager} from "../../src/delivery/DeliveryManager.sol";
import {ReleasePolicy} from "../../src/delivery/ReleasePolicy.sol";
import {AidVault} from "../../src/funds/AidVault.sol";
import {AidVaultFactory} from "../../src/funds/AidVaultFactory.sol";
import {DonationForwarderFactory} from "../../src/funds/DonationForwarderFactory.sol";
import {DonationReceipt} from "../../src/funds/DonationReceipt.sol";
import {IAidVault} from "../../src/interfaces/IAidVault.sol";
import {IBeneficiaryRegistry} from "../../src/interfaces/IBeneficiaryRegistry.sol";
import {IDeliveryManager} from "../../src/interfaces/IDeliveryManager.sol";
import {INeedsRegistry} from "../../src/interfaces/INeedsRegistry.sol";
import {IReleasePolicy} from "../../src/interfaces/IReleasePolicy.sol";
import {ITrancheLedger} from "../../src/interfaces/ITrancheLedger.sol";
import {MockEURC} from "../../src/mocks/MockEURC.sol";
import {MockSwapRouter} from "../../src/mocks/MockSwapRouter.sol";
import {MockUSDC} from "../../src/mocks/MockUSDC.sol";
import {MockV3Aggregator} from "../../src/mocks/MockV3Aggregator.sol";
import {MockWETH9} from "../../src/mocks/MockWETH9.sol";
import {NeedsRegistry} from "../../src/needs/NeedsRegistry.sol";
import {ProgramRegistry} from "../../src/programs/ProgramRegistry.sol";
import {ProofOfAidResolver} from "../../src/resolvers/ProofOfAidResolver.sol";
import {
    AttestationRequest,
    AttestationRequestData,
    IEAS,
    RevocationRequest,
    RevocationRequestData
} from "@ethereum-attestation-service/eas-contracts/contracts/IEAS.sol";
import {ISchemaRegistry} from "@ethereum-attestation-service/eas-contracts/contracts/ISchemaRegistry.sol";
import {ISchemaResolver} from "@ethereum-attestation-service/eas-contracts/contracts/resolver/ISchemaResolver.sol";
import {Test} from "forge-std/Test.sol";

/// @title PoATest
/// @notice Shared fixture: deploys the full Proof of Aid system (with a local EAS), registers the three
///         schemas and provides helpers for the recurring flows (needs, donations, deliveries, attestations).
abstract contract PoATest is Test, SystemDeployer {
    // ─── protocol parameters used in tests ─────────────────────────────────────
    uint256 internal constant HIGH_VALUE_THRESHOLD = 10_000e6;
    uint16 internal constant DONOR_APPROVAL_BPS = 3000;
    uint16 internal constant DONOR_REJECTION_BPS = 5000;
    uint8 internal constant REJECTION_RETRIES = 1;
    uint32 internal constant MIN_BENEFICIARIES_SERVED = 5;
    string internal constant DASHBOARD_BASE_URI = "https://proofofaid.example/needs/";

    /// @dev What an NGO files for a delivery: the files by content hash, what each one is, and a note.
    string internal constant MANIFEST =
        '{"v":1,"note":"Materials bought and delivered","files":[{"kind":"receipt","sha256":"ab12"},{"kind":"photo","sha256":"cd34"}]}';

    bytes32 internal constant FOOD = keccak256("FOOD");
    bytes32 internal constant SHELTER = keccak256("SHELTER");
    bytes32 internal constant REGION = bytes32("ES-CM");
    bytes32 internal constant DOSSIER_HASH = keccak256("encrypted-needs-assessment-1");
    bytes32 internal constant ELIGIBILITY_HASH = keccak256("eligibility-rules-v1");
    bytes32 internal constant REPORT_HASH = keccak256("verifier-report");
    bytes32 internal constant EVIDENCE_HASH = keccak256("ciphertext");
    bytes32 internal constant KPI_HASH = keccak256("kpis");
    bytes32 internal constant OUTCOME_HASH = keccak256("expected-outcome");
    bytes32 internal constant COST_DISCLOSURE_HASH = keccak256("cost-disclosure");
    bytes32 internal constant EUR = bytes32("EUR");
    bytes32 internal constant SUPPLIER_REF = keccak256("supplier-invoice-1");
    bytes32 internal constant FX_REF = keccak256("ecb-rate-2026-09-16");
    string internal constant EVIDENCE_CID = "bafkreieviDenceCidPlaceholder";
    string internal constant REPORT_CID = "bafkreiReportCidPlaceholder";

    // ─── actors ────────────────────────────────────────────────────────────────
    address internal admin = makeAddr("admin");
    address internal ngo = makeAddr("ngo");
    address internal ngoPayout = makeAddr("ngoPayout");
    address internal ngo2 = makeAddr("ngo2");
    address internal ngo2Payout = makeAddr("ngo2Payout");
    address internal verifier1 = makeAddr("verifier1");
    address internal verifier2 = makeAddr("verifier2");
    address internal verifier3 = makeAddr("verifier3");
    address internal donor1 = makeAddr("donor1");
    address internal donor2 = makeAddr("donor2");
    address internal relayer = makeAddr("relayer");
    address internal outsider = makeAddr("outsider");
    /// @dev People an NGO certified; nothing on chain knows them until they post a need.
    address internal beneficiary = makeAddr("beneficiary");
    address internal beneficiary2 = makeAddr("beneficiary2");
    /// @dev How long the fixture's certificates last.
    uint256 internal constant CERTIFICATE_LIFETIME = 90 days;

    // ─── system under test ─────────────────────────────────────────────────────
    System internal sys;
    RoleRegistry internal roles;
    NeedsRegistry internal registry;
    AidVaultFactory internal factory;
    DonationReceipt internal receipt;
    ProgramRegistry internal programs;
    BeneficiaryRegistry internal beneficiaries;
    CommunityProofs internal communityProofs;
    DeliveryManager internal deliveryManager;
    /// @dev The built-in release policies; needs use `donorPolicy` unless a test picks another.
    ReleasePolicy internal donorPolicy;
    ReleasePolicy internal verifierPolicy;
    ReleasePolicy internal bothPolicy;
    MockEURC internal token;
    IEAS internal eas;
    ISchemaRegistry internal schemaRegistry;

    ProofOfAidResolver internal resolver;

    // ─── conversion path (mocks) ───────────────────────────────────────────────
    ConversionRouter internal router;
    DonationForwarderFactory internal forwarderFactory;
    MockUSDC internal usdc;
    /// @dev The euro stablecoin of the deployment: the vault token itself in the default fixture.
    MockEURC internal eurc;
    address internal defaultVaultToken;
    MockWETH9 internal weth;
    MockSwapRouter internal swapRouter;
    MockV3Aggregator internal eurUsdFeed;
    MockV3Aggregator internal usdcUsdFeed;
    MockV3Aggregator internal ethUsdFeed;
    uint16 internal constant MAX_SLIPPAGE_BPS = 100;
    /// @dev Registered suppliers: the default payment plan pays every tranche to `supplierA`.
    address internal supplierA = makeAddr("supplierA");
    address internal supplierB = makeAddr("supplierB");
    bytes32 internal constant SUPPLIER_QUOTE = keccak256("supplier-quote");

    /// @dev Registered on the forwarder factory: may sweep any deposit address (the platform relayer's role).
    address internal keeper = makeAddr("sweepKeeper");

    bytes32 internal needVerifiedSchema;
    bytes32 internal settlementSchema;
    bytes32 internal impactReportSchema;

    /// @dev Hooks for tests that run against a fork with real DeFi instead of the local mocks.
    ///      By default the fixture holds euros (a MockEURC vault, USDC and ETH converted into it), which exercises
    ///      the conversion path in every suite. `UsdcVaultTest` covers the USD-denominated deployment instead.
    function _beforeDeploy() internal virtual {
        defaultVaultToken = address(new MockEURC());
    }

    function _tokenAddress() internal view virtual returns (address) {
        return defaultVaultToken;
    }

    function _conversionParams() internal view virtual returns (ConversionParams memory) {
        return ConversionParams({
            swapRouter: address(0),
            weth: address(0),
            usdc: address(0),
            eurc: address(0),
            eurUsdFeed: address(0),
            usdcUsdFeed: address(0),
            ethUsdFeed: address(0),
            sequencerUptimeFeed: address(0),
            maxSlippageBps: MAX_SLIPPAGE_BPS,
            ethMaxSlippageBps: MAX_SLIPPAGE_BPS,
            usdcToTokenFee: 0,
            wethToUsdcFee: 0,
            ethRoute: true,
            eurHeartbeat: 0,
            usdcHeartbeat: 0,
            ethHeartbeat: 0
        });
    }

    function setUp() public virtual {
        _beforeDeploy();
        (address schemaRegistry_, address eas_) = _deployLocalEAS();
        schemaRegistry = ISchemaRegistry(schemaRegistry_);
        eas = IEAS(eas_);

        vm.startPrank(admin);
        sys = _deploySystem(
            Params({
                admin: admin,
                token: _tokenAddress(),
                eas: eas_,
                highValueThreshold: HIGH_VALUE_THRESHOLD,
                donorApprovalBps: DONOR_APPROVAL_BPS,
                donorRejectionBps: DONOR_REJECTION_BPS,
                rejectionRetries: REJECTION_RETRIES,
                minBeneficiariesServed: MIN_BENEFICIARIES_SERVED,
                dashboardBaseURI: DASHBOARD_BASE_URI,
                yieldVenue: address(0),
                yieldCapBps: 0,
                conversion: _conversionParams()
            })
        );
        vm.stopPrank();

        roles = sys.roles;
        registry = sys.registry;
        factory = sys.factory;
        receipt = sys.receipt;
        programs = sys.programs;
        beneficiaries = sys.beneficiaries;
        communityProofs = sys.communityProofs;
        deliveryManager = sys.deliveryManager;
        donorPolicy = sys.donorPolicy;
        verifierPolicy = sys.verifierPolicy;
        bothPolicy = sys.donorAndVerifierPolicy;
        token = MockEURC(sys.token);
        resolver = sys.resolver;
        router = sys.router;
        forwarderFactory = sys.forwarderFactory;
        usdc = MockUSDC(sys.conversion.usdc);
        eurc = MockEURC(sys.conversion.eurc);
        weth = MockWETH9(payable(sys.conversion.weth));
        swapRouter = MockSwapRouter(sys.conversion.swapRouter);
        eurUsdFeed = MockV3Aggregator(sys.conversion.eurUsdFeed);
        usdcUsdFeed = MockV3Aggregator(sys.conversion.usdcUsdFeed);
        ethUsdFeed = MockV3Aggregator(sys.conversion.ethUsdFeed);

        _registerSchemas();
        _registerActors();
        vm.prank(admin);
        forwarderFactory.setKeeper(keeper, true);
    }

    // ─── setup helpers ─────────────────────────────────────────────────────────

    function _registerSchemas() internal {
        bytes32[3] memory uids;
        for (uint256 i; i < 3; ++i) {
            (string memory schema, bool revocable, bytes32 expected) = resolver.schemaAt(i);
            uids[i] = schemaRegistry.register(schema, ISchemaResolver(address(resolver)), revocable);
            // The resolver derives the UIDs it accepts from its own address; the registry must agree.
            assertEq(uids[i], expected, "schema uid");
        }
        (needVerifiedSchema, settlementSchema, impactReportSchema) = (uids[0], uids[1], uids[2]);
    }

    function _registerActors() internal {
        vm.startPrank(admin);
        roles.registerNgo(ngo, ngoPayout, keccak256("ngo-credential"), "ipfs://ngo-profile");
        roles.registerNgo(ngo2, ngo2Payout, keccak256("ngo2-credential"), "ipfs://ngo2-profile");
        roles.registerVerifier(verifier1);
        roles.registerVerifier(verifier2);
        roles.registerVerifier(verifier3);
        roles.registerSupplier(supplierA, keccak256("supplierA-registration"), "ipfs://supplierA");
        roles.registerSupplier(supplierB, keccak256("supplierB-registration"), "ipfs://supplierB");
        vm.stopPrank();
    }

    // ─── programs & needs ──────────────────────────────────────────────────────

    /// @dev Creates a programme owned by `owner`.
    function _createProgram(address owner) internal returns (uint256 programId) {
        vm.prank(owner);
        programId = programs.createProgram(ELIGIBILITY_HASH, "ipfs://program");
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

    /// @dev v1-equivalent terms: on-chain custody, no deadlines, any amount may execute, no intermediary costs.
    /// @dev How long the default fixture gives a need to deliver, counted from the moment it is created.
    uint256 internal constant DEFAULT_EXECUTION_WINDOW = 365 days;

    function _needParams(uint256 programId, uint256 target, uint8 verificationsRequired, uint16[] memory bps)
        internal
        view
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
            trancheBps: bps,
            fundingDeadline: 0,
            // On-chain custody always has a delivery horizon, so donors always have a way back (expire).
            executionDeadline: uint64(block.timestamp + DEFAULT_EXECUTION_WINDOW),
            minFundingBps: 1,
            thirdPartyCostBps: 0,
            expectedOutcomeHash: OUTCOME_HASH,
            costDisclosureHash: bytes32(0),
            payees: _singlePayee(supplierA, bps.length),
            releasePolicy: address(0) // the default: donors decide
        });
    }

    /// @dev A payment plan that pays every tranche in full to `account`.
    function _singlePayee(address account, uint256 tranches)
        internal
        pure
        returns (INeedsRegistry.Payee[] memory plan)
    {
        plan = new INeedsRegistry.Payee[](1);
        plan[0] = _payee(account, _uniformShares(tranches, 10_000));
    }

    function _payee(address account, uint16[] memory shares) internal pure returns (INeedsRegistry.Payee memory) {
        return INeedsRegistry.Payee({account: account, shareBps: shares, refHash: SUPPLIER_QUOTE, label: "supplier"});
    }

    function _uniformShares(uint256 tranches, uint16 share) internal pure returns (uint16[] memory shares) {
        shares = new uint16[](tranches);
        for (uint256 i; i < tranches; ++i) {
            shares[i] = share;
        }
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
        programId = _createProgram(ngo);
        needId = _createNeed(ngo, programId, target, verificationsRequired);
        _attestNeedVerified(verifier1, needId, true);
        if (verificationsRequired > 1) _attestNeedVerified(verifier2, needId, true);
        vault = AidVault(registry.vaultOf(needId));
    }

    /// @dev A fully funded need with tranche 0 released, i.e. ready for deliveries.
    function _needInDelivery(uint256 target) internal returns (uint256 needId, uint256 programId, AidVault vault) {
        (needId, programId, vault) = _verifiedNeed(target);
        _donate(donor1, needId, target); // reaching the target closes funding
        vault.releaseTranche(0); // pre-financing paid out → InDelivery
    }

    /// @dev Creates and verifies a need with custom terms (single verifier, so keep `targetAmount` ≤ threshold).
    function _verifiedNeedWith(INeedsRegistry.CreateNeedParams memory p) internal returns (uint256 needId) {
        vm.prank(ngo);
        needId = registry.createNeed(p);
        _attestNeedVerified(verifier1, needId, true);
    }

    // ─── beneficiaries ─────────────────────────────────────────────────────────

    /// @dev The key a fixture NGO signs with: the one `makeAddr` derived its address from.
    function _keyOf(address who) internal view returns (uint256) {
        if (who == ngo) return uint256(keccak256(abi.encodePacked("ngo")));
        if (who == ngo2) return uint256(keccak256(abi.encodePacked("ngo2")));
        revert("PoATest: no key for this address");
    }

    /// @dev A certificate `certifier` would issue now for `who` in `programId`, valid for `CERTIFICATE_LIFETIME`.
    function _certification(address who, address certifier, uint256 programId)
        internal
        view
        returns (IBeneficiaryRegistry.Certification memory)
    {
        return IBeneficiaryRegistry.Certification({
            beneficiary: who,
            ngo: certifier,
            programId: programId,
            issuedAt: uint64(block.timestamp),
            expiresAt: uint64(block.timestamp + CERTIFICATE_LIFETIME)
        });
    }

    function _signCertification(IBeneficiaryRegistry.Certification memory c, uint256 key)
        internal
        view
        returns (bytes memory)
    {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, beneficiaries.certificationDigest(c));
        return abi.encodePacked(r, s, v);
    }

    /// @dev A beneficiary's own need: the default terms, every tranche paid in full to their wallet.
    function _beneficiaryNeedParams(uint256 programId, uint256 target)
        internal
        view
        returns (INeedsRegistry.CreateNeedParams memory p)
    {
        uint16[] memory bps = _threeTrancheBps();
        p = _needParams(programId, target, target > HIGH_VALUE_THRESHOLD ? 2 : 1, bps);
        p.payees = _singlePayee(address(0), bps.length);
    }

    /// @dev `who` posts a need on a fresh certificate from the fixture NGO.
    function _postBeneficiaryNeed(address who, uint256 programId, uint256 target) internal returns (uint256 needId) {
        IBeneficiaryRegistry.Certification memory c = _certification(who, ngo, programId);
        bytes memory signature = _signCertification(c, _keyOf(ngo));
        vm.prank(who);
        needId = beneficiaries.createNeed(_beneficiaryNeedParams(programId, target), c, signature);
    }

    /// @dev A beneficiary's need, verified and fully funded, with tranche 0 paid to them: ready for evidence.
    function _beneficiaryNeedInDelivery(uint256 target)
        internal
        returns (uint256 needId, uint256 programId, AidVault vault)
    {
        programId = _createProgram(ngo);
        needId = _postBeneficiaryNeed(beneficiary, programId, target);
        _attestNeedVerified(verifier1, needId, true);
        if (target > HIGH_VALUE_THRESHOLD) _attestNeedVerified(verifier2, needId, true);
        vault = AidVault(registry.vaultOf(needId));
        _donate(donor1, needId, target);
        vault.releaseTranche(0);
    }

    /// @dev Mock feeds go stale when a test warps time; this re-publishes the demo prices.
    function _refreshPrices() internal {
        eurUsdFeed.updateAnswer(MOCK_EUR_USD);
        usdcUsdFeed.updateAnswer(MOCK_USDC_USD);
        ethUsdFeed.updateAnswer(MOCK_ETH_USD);
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

    function _attestSettlement(address attester, uint256 needId, uint256 trancheIndex, uint256 gross, uint256 fee)
        internal
        returns (bytes32 uid)
    {
        uid = _attest(
            settlementSchema,
            attester,
            registry.vaultOf(needId),
            bytes32(0),
            false,
            abi.encode(needId, trancheIndex, gross, fee, gross - fee, SUPPLIER_REF, FX_REF)
        );
    }

    function _attestImpactReport(address attester, uint256 needId, uint32 beneficiariesServed)
        internal
        returns (bytes32 uid)
    {
        uid = _attest(
            impactReportSchema,
            attester,
            registry.vaultOf(needId),
            bytes32(0),
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

    // ─── deliveries ────────────────────────────────────────────────────────────

    /// @dev The need's NGO files its evidence for the next locked tranche, which must be `trancheIndex`, and the
    ///      fixture's donors approve it until the threshold unlocks the tranche.
    function _runDelivery(uint256 needId, uint256 trancheIndex) internal returns (uint256 deliveryId) {
        deliveryId = _submitEvidence(needId);
        assertEq(deliveryManager.getDelivery(deliveryId).trancheIndex, trancheIndex, "delivery tranche");
        _approveByDonors(deliveryId);
    }

    /// @dev Filed by whoever runs the need: its NGO, or the beneficiary who posted it.
    function _submitEvidence(uint256 needId) internal returns (uint256 deliveryId) {
        vm.prank(registry.ownerOf(needId));
        deliveryId = deliveryManager.submitEvidence(needId, MANIFEST);
    }

    /// @dev Every fixture address with a say on the need approves, in turn, until the delivery is approved.
    function _approveByDonors(uint256 deliveryId) internal {
        _voteUntilDecided(deliveryId, true);
        assertEq(
            uint8(deliveryManager.getDelivery(deliveryId).status),
            uint8(IDeliveryManager.DeliveryStatus.Approved),
            "the voters did not reach the approval threshold"
        );
    }

    /// @dev The same, rejecting.
    function _rejectByDonors(uint256 deliveryId) internal {
        _voteUntilDecided(deliveryId, false);
        assertEq(
            uint8(deliveryManager.getDelivery(deliveryId).status),
            uint8(IDeliveryManager.DeliveryStatus.Rejected),
            "the voters did not reach the rejection threshold"
        );
    }

    function _voteUntilDecided(uint256 deliveryId, bool approve) internal {
        uint256 needId = deliveryManager.getDelivery(deliveryId).needId;
        address[7] memory candidates = [donor1, donor2, outsider, relayer, verifier1, verifier2, verifier3];
        for (uint256 i; i < candidates.length; ++i) {
            if (deliveryManager.getDelivery(deliveryId).status != IDeliveryManager.DeliveryStatus.Open) break;
            address candidate = candidates[i];
            (IReleasePolicy.Voice voice,) = deliveryManager.voiceOf(needId, candidate);
            if (voice == IReleasePolicy.Voice.None) continue;
            if (deliveryManager.hasVoted(deliveryId, candidate)) continue;
            vm.prank(candidate);
            if (approve) deliveryManager.approve(deliveryId);
            else deliveryManager.reject(deliveryId);
        }
    }

    // ─── assertions ────────────────────────────────────────────────────────────

    function assertEq(INeedsRegistry.NeedStatus a, INeedsRegistry.NeedStatus b) internal pure {
        assertEq(uint8(a), uint8(b), "need status");
    }

    function assertEq(INeedsRegistry.NeedStatus a, INeedsRegistry.NeedStatus b, string memory err) internal pure {
        assertEq(uint8(a), uint8(b), err);
    }

    function assertEq(IDeliveryManager.DeliveryStatus a, IDeliveryManager.DeliveryStatus b) internal pure {
        assertEq(uint8(a), uint8(b), "delivery status");
    }

    function assertEq(IDeliveryManager.DeliveryStatus a, IDeliveryManager.DeliveryStatus b, string memory err)
        internal
        pure
    {
        assertEq(uint8(a), uint8(b), err);
    }

    function assertEq(ITrancheLedger.TrancheStatus a, ITrancheLedger.TrancheStatus b) internal pure {
        assertEq(uint8(a), uint8(b), "tranche status");
    }

    function assertEq(ITrancheLedger.TrancheStatus a, ITrancheLedger.TrancheStatus b, string memory err) internal pure {
        assertEq(uint8(a), uint8(b), err);
    }

    /// @dev The core vault accounting invariant from the spec (§5.4).
    /// @dev Money is in exactly one of five places: this vault, the venue it was lent to, a payee, a donor it
    ///      went back to, or gone in a loss. Gains raise the right-hand side until they are handed on.
    function assertVaultInvariant(AidVault vault) internal view {
        assertEq(
            token.balanceOf(address(vault)) + vault.deployedPrincipal() + vault.totalReleased() + vault.totalRefunded()
                + vault.lossRealised(),
            vault.totalDonated() + vault.totalHeld() + vault.yieldRealised() - vault.yieldPaid(),
            "vault invariant"
        );
    }
}
