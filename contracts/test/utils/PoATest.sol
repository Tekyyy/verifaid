// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {SystemDeployer} from "../../script/lib/SystemDeployer.sol";
import {RoleRegistry} from "../../src/access/RoleRegistry.sol";
import {ConversionRouter} from "../../src/conversion/ConversionRouter.sol";
import {DeliveryManager} from "../../src/delivery/DeliveryManager.sol";
import {AidVault} from "../../src/funds/AidVault.sol";
import {AidVaultFactory} from "../../src/funds/AidVaultFactory.sol";
import {DonationForwarderFactory} from "../../src/funds/DonationForwarderFactory.sol";
import {DonationReceipt} from "../../src/funds/DonationReceipt.sol";
import {NonCustodialLedger} from "../../src/funds/NonCustodialLedger.sol";
import {BeneficiaryGroups} from "../../src/identity/BeneficiaryGroups.sol";
import {IAidVault} from "../../src/interfaces/IAidVault.sol";
import {IDeliveryManager} from "../../src/interfaces/IDeliveryManager.sol";
import {INeedsRegistry} from "../../src/interfaces/INeedsRegistry.sol";
import {ITrancheLedger} from "../../src/interfaces/ITrancheLedger.sol";
import {MockEURC} from "../../src/mocks/MockEURC.sol";
import {MockSemaphore} from "../../src/mocks/MockSemaphore.sol";
import {MockSwapRouter} from "../../src/mocks/MockSwapRouter.sol";
import {MockUSDC} from "../../src/mocks/MockUSDC.sol";
import {MockV3Aggregator} from "../../src/mocks/MockV3Aggregator.sol";
import {MockWETH9} from "../../src/mocks/MockWETH9.sol";
import {NeedsRegistry} from "../../src/needs/NeedsRegistry.sol";
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
import {ISemaphore} from "@semaphore-protocol/contracts/interfaces/ISemaphore.sol";
import {Test} from "forge-std/Test.sol";

/// @title PoATest
/// @notice Shared fixture: deploys the full Proof of Aid system (local EAS + MockSemaphore), registers the six
///         schemas and provides helpers for the recurring flows (needs, donations, deliveries, attestations).
abstract contract PoATest is Test, SystemDeployer {
    // ─── protocol parameters used in tests ─────────────────────────────────────
    uint256 internal constant HIGH_VALUE_THRESHOLD = 10_000e6;
    uint16 internal constant CONFIRMATION_THRESHOLD_BPS = 7000;
    uint64 internal constant CHALLENGE_PERIOD = 10 minutes;
    uint32 internal constant MIN_EXPECTED_RECIPIENTS = 5;
    string internal constant DASHBOARD_BASE_URI = "https://proofofaid.example/needs/";

    /// @dev Mirrors DeliveryManager.AID_RECEIVED_MESSAGE. Kept as a constant so building a proof never makes an
    ///      external call (which would swallow a pending vm.prank / vm.expectRevert). Equality is asserted in
    ///      DeliveryManagerTest.test_constants.
    uint256 internal constant AID_RECEIVED_MESSAGE = uint256(keccak256("AID_RECEIVED"));

    bytes32 internal constant FOOD = keccak256("FOOD");
    bytes32 internal constant SHELTER = keccak256("SHELTER");
    bytes32 internal constant REGION = bytes32("ES-CM");
    bytes32 internal constant DOSSIER_HASH = keccak256("encrypted-needs-assessment-1");
    bytes32 internal constant POLICY_HASH = keccak256("enrollment-policy-v1");
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
    bytes32 internal fundingRecordedSchema;
    bytes32 internal deliveryEvidenceSchema;
    bytes32 internal deliveryVerifiedSchema;
    bytes32 internal settlementSchema;
    bytes32 internal impactReportSchema;

    /// @dev Which Semaphore implementation the system is deployed against. Overridden by the integration test
    ///      that runs against real Semaphore v4 contracts with real proofs.
    function _setUpSemaphore() internal virtual returns (address) {
        semaphore = new MockSemaphore();
        return address(semaphore);
    }

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
        address semaphoreAddress = _setUpSemaphore();
        (address schemaRegistry_, address eas_) = _deployLocalEAS();
        schemaRegistry = ISchemaRegistry(schemaRegistry_);
        eas = IEAS(eas_);

        vm.startPrank(admin);
        sys = _deploySystem(
            Params({
                admin: admin,
                token: _tokenAddress(),
                eas: eas_,
                semaphore: semaphoreAddress,
                highValueThreshold: HIGH_VALUE_THRESHOLD,
                confirmationThresholdBps: CONFIRMATION_THRESHOLD_BPS,
                challengePeriod: CHALLENGE_PERIOD,
                minExpectedRecipients: MIN_EXPECTED_RECIPIENTS,
                dashboardBaseURI: DASHBOARD_BASE_URI,
                conversion: _conversionParams()
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
        bytes32[6] memory uids;
        for (uint256 i; i < 6; ++i) {
            (string memory schema, bool revocable, bytes32 expected) = resolver.schemaAt(i);
            uids[i] = schemaRegistry.register(schema, ISchemaResolver(address(resolver)), revocable);
            // The resolver derives the UIDs it accepts from its own address; the registry must agree.
            assertEq(uids[i], expected, "schema uid");
        }
        (needVerifiedSchema, fundingRecordedSchema, deliveryEvidenceSchema) = (uids[0], uids[1], uids[2]);
        (deliveryVerifiedSchema, settlementSchema, impactReportSchema) = (uids[3], uids[4], uids[5]);
    }

    function _registerActors() internal {
        vm.startPrank(admin);
        roles.registerNgo(ngo, ngoPayout, keccak256("ngo-credential"), "ipfs://ngo-profile");
        roles.registerNgo(ngo2, ngo2Payout, keccak256("ngo2-credential"), "ipfs://ngo2-profile");
        roles.registerVerifier(verifier1);
        roles.registerVerifier(verifier2);
        roles.registerVerifier(verifier3);
        roles.registerBankPartner(bankPartner);
        roles.registerSupplier(supplierA, keccak256("supplierA-registration"), "ipfs://supplierA");
        roles.registerSupplier(supplierB, keccak256("supplierB-registration"), "ipfs://supplierB");
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
            custodyMode: INeedsRegistry.CustodyMode.OnChain,
            custodian: address(0),
            fundingDeadline: 0,
            // On-chain custody always has a delivery horizon, so donors always have a way back (expire).
            executionDeadline: uint64(block.timestamp + DEFAULT_EXECUTION_WINDOW),
            minFundingBps: 1,
            thirdPartyCostBps: 0,
            expectedOutcomeHash: OUTCOME_HASH,
            costDisclosureHash: bytes32(0),
            payees: _singlePayee(supplierA, bps.length)
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

    /// @dev Off-chain custody: the named provider holds (and pays out) the money, so the need has no payment plan.
    function _asOffChain(INeedsRegistry.CreateNeedParams memory p, address custodian) internal pure {
        p.custodyMode = INeedsRegistry.CustodyMode.OffChain;
        p.custodian = custodian;
        p.payees = new INeedsRegistry.Payee[](0);
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

    /// @dev A verified off-chain (Model A) need funded through the payment provider's ledger.
    function _verifiedOffChainNeed(uint256 target, uint16 thirdPartyCostBps)
        internal
        returns (uint256 needId, uint256 programId, NonCustodialLedger ledger)
    {
        programId = _createProgram(ngo, 10);
        INeedsRegistry.CreateNeedParams memory p = _needParams(programId, target, 1, _threeTrancheBps());
        _asOffChain(p, bankPartner);
        p.thirdPartyCostBps = thirdPartyCostBps;
        p.costDisclosureHash = thirdPartyCostBps == 0 ? bytes32(0) : COST_DISCLOSURE_HASH;
        needId = _verifiedNeedWith(p);
        ledger = NonCustodialLedger(registry.vaultOf(needId));
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

    /// @dev A provider vouching for a payment with no fee (gross == net).
    function _attestFundingRecorded(
        address partner,
        uint256 needId,
        uint256 amount,
        bytes32 paymentRefHash,
        bytes32 donorRefHash
    ) internal returns (bytes32 uid) {
        return _attestFundingRecorded(partner, needId, amount, 0, paymentRefHash, donorRefHash);
    }

    function _attestFundingRecorded(
        address partner,
        uint256 needId,
        uint256 net,
        uint256 fee,
        bytes32 paymentRefHash,
        bytes32 donorRefHash
    ) internal returns (bytes32 uid) {
        uid = _attest(
            fundingRecordedSchema,
            partner,
            registry.vaultOf(needId),
            bytes32(0),
            false,
            abi.encode(needId, net + fee, fee, net, EUR, paymentRefHash, donorRefHash)
        );
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
        pure
        returns (ISemaphore.SemaphoreProof memory proof)
    {
        uint256[8] memory points;
        points[0] = 1;
        proof = ISemaphore.SemaphoreProof({
            merkleTreeDepth: 3,
            merkleTreeRoot: uint256(keccak256("root")),
            nullifier: uint256(keccak256(abi.encode(deliveryId, nullifierSeed))),
            message: AID_RECEIVED_MESSAGE,
            scope: deliveryId,
            points: points
        });
    }

    /// @dev Submits `count` anonymous confirmations relayed by `relayer`. Nullifier seeds continue from the
    ///      delivery's current count, so repeated calls never replay a nullifier.
    function _confirm(uint256 deliveryId, uint256 count) internal {
        uint256 start = deliveryManager.getDelivery(deliveryId).confirmations;
        for (uint256 i; i < count; ++i) {
            vm.prank(relayer);
            deliveryManager.confirmReceipt(deliveryId, _proof(deliveryId, start + i));
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
    function assertVaultInvariant(AidVault vault) internal view {
        assertEq(
            token.balanceOf(address(vault)) + vault.totalReleased() + vault.totalRefunded(),
            vault.totalDonated() + vault.totalHeld(),
            "vault invariant"
        );
    }
}
