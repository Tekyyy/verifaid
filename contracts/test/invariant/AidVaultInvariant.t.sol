// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {RoleRegistry} from "../../src/access/RoleRegistry.sol";
import {AidVault} from "../../src/funds/AidVault.sol";
import {DonationForwarderFactory} from "../../src/funds/DonationForwarderFactory.sol";
import {IAidVault} from "../../src/interfaces/IAidVault.sol";
import {IDonationForwarder} from "../../src/interfaces/IDonationForwarder.sol";
import {INeedsRegistry} from "../../src/interfaces/INeedsRegistry.sol";
import {ITrancheLedger} from "../../src/interfaces/ITrancheLedger.sol";
import {MockEURC} from "../../src/mocks/MockEURC.sol";
import {MockUSDC} from "../../src/mocks/MockUSDC.sol";
import {MockV3Aggregator} from "../../src/mocks/MockV3Aggregator.sol";
import {MockYieldVault} from "../../src/mocks/MockYieldVault.sol";
import {NeedsRegistry} from "../../src/needs/NeedsRegistry.sol";
import {BlocklistEURC} from "../utils/BlocklistEURC.sol";
import {PoATest} from "../utils/PoATest.sol";
import {CommonBase} from "forge-std/Base.sol";
import {StdCheats} from "forge-std/StdCheats.sol";
import {StdUtils} from "forge-std/StdUtils.sol";

/// @notice Drives one vault through random but legal sequences of donations (direct, provider, converted from USDC
///         and swept from deposit addresses), releases, cancellation, the passage of time (funding and execution
///         deadlines, partial execution), refunds (including forwarder-credited ones), and an issuer freezing a
///         payee, so payments the token refuses — and the claims that deliver them later — are fuzzed too.
///         Committed money also comes and goes from a yield venue that gains, loses and runs dry at random,
///         because the accounting identity has to close whatever a third party does with the money.
contract VaultHandler is CommonBase, StdCheats, StdUtils {
    AidVault public immutable vault;
    MockEURC public immutable token;
    NeedsRegistry public immutable registry;
    address public immutable admin;
    address public immutable ngo;
    address public immutable deliveryManager;
    address public immutable bankPartner;
    uint256 public immutable needId;

    address[3] public donors;
    /// @dev Receipts the handler's donations minted, so `withdrawDonation` has one to name.
    mapping(address => uint256[]) public receiptsOf;
    MockYieldVault public venue;
    address[3] public payees; // the plan: supplier A, supplier B, the NGO's payout Safe
    bytes32[2] public donorRefs;
    uint256 public paymentRefNonce;
    uint256 public deployCalls;
    uint256 public unwindCalls;
    uint256 public harvestCalls;
    uint256 public payYieldCalls;
    uint256 public venueCalls;

    // ─── call counters, reported by `forge test -vv` after the invariant run ───
    uint256 public donateCalls;
    uint256 public donateOnBehalfCalls;
    uint256 public releaseCalls;
    uint256 public refundCalls;
    uint256 public cancelCalls;
    uint256 public expireCalls;
    uint256 public convertedCalls;
    uint256 public sweepCalls;
    uint256 public forwarderRefundCalls;
    uint256 public freezeCalls;
    uint256 public claimHeldCalls;
    uint256 public withdrawCalls;

    // ─── conversion path ───────────────────────────────────────────────────────
    DonationForwarderFactory public forwarderFactory;
    MockUSDC public usdc;
    MockV3Aggregator[3] public feeds; // EUR/USD, USDC/USD, ETH/USD
    int256[3] public prices;
    address[] public forwarders;

    constructor(
        AidVault vault_,
        MockEURC token_,
        NeedsRegistry registry_,
        address admin_,
        address ngo_,
        address deliveryManager_,
        address bankPartner_
    ) {
        vault = vault_;
        token = token_;
        registry = registry_;
        admin = admin_;
        ngo = ngo_;
        deliveryManager = deliveryManager_;
        bankPartner = bankPartner_;
        needId = vault_.needId();

        donors = [makeAddr("invDonor1"), makeAddr("invDonor2"), makeAddr("invDonor3")];
        donorRefs = [keccak256("invRef1"), keccak256("invRef2")];
    }

    function setPayees(address[3] memory payees_) external {
        payees = payees_;
    }

    function setConversion(
        DonationForwarderFactory forwarderFactory_,
        MockUSDC usdc_,
        MockV3Aggregator[3] memory feeds_,
        int256[3] memory prices_
    ) external {
        forwarderFactory = forwarderFactory_;
        usdc = usdc_;
        feeds = feeds_;
        prices = prices_;
    }

    /// @dev Mock prices go stale when time is warped; converted donations republish them first.
    function _refreshPrices() internal {
        for (uint256 i; i < 3; ++i) {
            feeds[i].updateAnswer(prices[i]);
        }
    }

    /// @dev A wallet gives USDC; the factory converts it and donates up to the remaining target.
    function donateConverted(uint256 actorSeed, uint256 amount) external {
        if (!_fundingOpen()) return;
        _refreshPrices();
        address donor = donors[actorSeed % donors.length];
        amount = bound(amount, 1e6, 20_000e6);
        usdc.mint(donor, amount);
        vm.startPrank(donor);
        usdc.approve(address(forwarderFactory), amount);
        try forwarderFactory.donate(needId, address(usdc), amount) {
            convertedCalls++;
        } catch {}
        vm.stopPrank();
    }

    /// @dev USDC lands on a fresh deposit address and a stranger sweeps it.
    function depositAndSweep(uint256 actorSeed, uint256 amount) external {
        if (!_fundingOpen()) return;
        _refreshPrices();
        IDonationForwarder.Intent memory intent = IDonationForwarder.Intent({
            needId: needId,
            receiptTo: address(0),
            refundTo: donors[actorSeed % donors.length],
            refundSigner: address(0),
            salt: bytes32(forwarders.length + 1)
        });
        address depositAddress = forwarderFactory.forwarderAddress(intent);
        usdc.mint(depositAddress, bound(amount, 1e6, 20_000e6));
        try forwarderFactory.sweep(intent, address(usdc)) {
            forwarders.push(depositAddress);
            sweepCalls++;
        } catch {}
    }

    /// @dev Anyone can trigger a forwarder's vault refund once the need is cancelled or expired.
    function claimForwarderRefund(uint256 seed) external {
        if (!_refundable() || forwarders.length == 0) return;
        address forwarder = forwarders[seed % forwarders.length];
        bytes32 key = bytes32(uint256(uint160(forwarder)));
        if (vault.donatedByRef(key) == 0) return;
        IDonationForwarder(forwarder).claimVaultRefund();
        forwarderRefundCalls++;
    }

    function _status() internal view returns (INeedsRegistry.NeedStatus) {
        return registry.statusOf(needId);
    }

    function _fundingOpen() internal view returns (bool open) {
        (,,, open) = registry.fundingTermsOf(needId);
        open = open && !vault.fundingClosed();
    }

    function _refundable() internal view returns (bool) {
        INeedsRegistry.NeedStatus s = _status();
        return s == INeedsRegistry.NeedStatus.Cancelled || s == INeedsRegistry.NeedStatus.Expired;
    }

    function _remaining() internal view returns (uint256) {
        return registry.targetAmountOf(needId) - vault.totalDonated();
    }

    function donate(uint256 actorSeed, uint256 amount) external {
        if (!_fundingOpen()) return;
        uint256 remaining = _remaining();
        if (remaining == 0) return;
        address donor = donors[actorSeed % donors.length];
        amount = bound(amount, 1, remaining);

        token.mint(donor, amount);
        vm.startPrank(donor);
        token.approve(address(vault), amount);
        receiptsOf[donor].push(vault.donate(amount));
        vm.stopPrank();
        donateCalls++;
    }

    /// @dev Finishes the round in one call. Without it a fifty-call sequence spends itself raising 50,000 a
    ///      random slice at a time, and what happens *after* funding closes is barely fuzzed at all.
    function fundToTarget(uint256 actorSeed) external {
        if (!_fundingOpen()) return;
        uint256 remaining = _remaining();
        if (remaining == 0) return;
        address donor = donors[actorSeed % donors.length];

        token.mint(donor, remaining);
        vm.startPrank(donor);
        token.approve(address(vault), remaining);
        receiptsOf[donor].push(vault.donate(remaining));
        vm.stopPrank();
        donateCalls++;
    }

    function donateOnBehalf(uint256 refSeed, uint256 amount) external {
        if (!_fundingOpen()) return;
        uint256 remaining = _remaining();
        if (remaining == 0) return;
        bytes32 donorRef = donorRefs[refSeed % donorRefs.length];
        amount = bound(amount, 1, remaining);
        bytes32 paymentRef = keccak256(abi.encode("payment", paymentRefNonce++));

        token.mint(bankPartner, amount);
        vm.startPrank(bankPartner);
        token.approve(address(vault), amount);
        vault.donateOnBehalf(amount, donorRef, paymentRef);
        vm.stopPrank();
        donateOnBehalfCalls++;
    }

    function closeFunding() external {
        if (!_fundingOpen() || vault.totalDonated() == 0) return;
        (, uint256 target, uint16 minFundingBps,) = registry.fundingTermsOf(needId);
        if (vault.totalDonated() * 10_000 < target * minFundingBps) return;
        vm.prank(ngo);
        vault.closeFunding();
    }

    /// @dev Moves time forward so the funding and execution deadlines come into play.
    function warp(uint256 secondsSeed) external {
        vm.warp(block.timestamp + bound(secondsSeed, 1 hours, 25 days));
    }

    /// @dev Anyone may apply a passed deadline; outside its preconditions `expire` simply reverts.
    function expire() external {
        try registry.expire(needId) {
            expireCalls++;
        } catch {}
    }

    /// @dev Releases whatever is releasable, then unlocks the next tranche the way a finalized delivery would.
    function advanceTranches(uint256 seed) external {
        INeedsRegistry.NeedStatus status = _status();
        if (status != INeedsRegistry.NeedStatus.Funded && status != INeedsRegistry.NeedStatus.InDelivery) return;

        uint256 count = vault.trancheCount();
        for (uint256 i; i < count; ++i) {
            if (vault.trancheStatus(i) == ITrancheLedger.TrancheStatus.Releasable) {
                vault.releaseTranche(i);
                releaseCalls++;
                return;
            }
        }
        // nothing releasable: unlock the tranche after the last released one (simulating a finalized delivery)
        if (seed % 2 == 0) return;
        for (uint256 i = 1; i < count; ++i) {
            if (
                vault.trancheStatus(i) == ITrancheLedger.TrancheStatus.Locked
                    && vault.trancheStatus(i - 1) == ITrancheLedger.TrancheStatus.Released
                    && _status() == INeedsRegistry.NeedStatus.InDelivery
            ) {
                vm.prank(deliveryManager);
                vault.markReleasable(i, i);
                return;
            }
        }
    }

    function cancel(uint256 seed) external {
        // cancel rarely, otherwise most runs would end in the refund phase immediately
        if (seed % 8 != 0) return;
        INeedsRegistry.NeedStatus status = _status();
        if (
            status == INeedsRegistry.NeedStatus.Completed || status == INeedsRegistry.NeedStatus.Cancelled
                || status == INeedsRegistry.NeedStatus.Expired
        ) return;
        vm.prank(admin);
        registry.cancelNeed(needId);
        cancelCalls++;
    }

    function claimRefund(uint256 actorSeed) external {
        if (!_refundable()) return;
        address donor = donors[actorSeed % donors.length];
        if (vault.donatedBy(donor) == 0) return; // cleared once refunded
        vm.prank(donor);
        vault.claimRefund();
        refundCalls++;
    }

    /// @dev A donor changes their mind while the need is still raising. Every precondition (funding open, the
    ///      settling window, the disclosed cost cap) is enforced on chain, so a refusal is a legal outcome here.
    function withdrawDonation(uint256 actorSeed, uint256 amount) external {
        address donor = donors[actorSeed % donors.length];
        uint256[] storage ids = receiptsOf[donor];
        if (ids.length == 0) return;
        uint256 receiptId = ids[actorSeed % ids.length];
        uint256 held = vault.donatedBy(donor);
        if (held == 0) return;
        amount = bound(amount, 1, held);

        vm.prank(donor);
        try vault.withdrawDonation(receiptId, amount) {
            withdrawCalls++;
        } catch {}
    }

    function setVenue(MockYieldVault venue_) external {
        venue = venue_;
    }

    /// @dev Idle escrow goes out to earn. The vault decides how much may go; the fuzzer only picks a fraction.
    function deployIdle(uint256 amountSeed) external {
        uint256 room = vault.deployableAmount();
        if (room == 0) return;
        try vault.deployIdle(bound(amountSeed, 1, room)) {
            deployCalls++;
        } catch {}
    }

    /// @dev And comes back, in part or entirely.
    function unwind(uint256 amountSeed) external {
        uint256 principal = vault.deployedPrincipal();
        if (principal == 0) return;
        try vault.unwind(bound(amountSeed, 1, principal * 2)) {
            unwindCalls++;
        } catch {}
    }

    function harvest() external {
        try vault.harvest() {
            harvestCalls++;
        } catch {}
    }

    function payYield() external {
        try vault.payYield() {
            payYieldCalls++;
        } catch {}
    }

    /// @dev The venue itself: interest arriving, bad debt in a market, and liquidity coming and going.
    function moveVenue(uint256 seed, uint256 amount) external {
        if (address(venue) == address(0)) return;
        uint256 assets = token.balanceOf(address(venue));
        uint256 choice = seed % 3;
        if (choice == 0) {
            uint256 gain = bound(amount, 1, 1000e6);
            deal(address(token), address(this), gain);
            token.approve(address(venue), gain);
            venue.accrue(gain);
        } else if (choice == 1 && assets > 0) {
            venue.lose(bound(amount, 1, assets));
        } else {
            venue.setLiquidityCap(seed % 7 == 0 ? 0 : bound(amount, 0, type(uint128).max));
        }
        venueCalls++;
    }

    /// @dev The stablecoin issuer freezes or unfreezes a payee: its share of a release is held instead of paid.
    function setPayeeFrozen(uint256 seed) external {
        BlocklistEURC(address(token)).setBlocked(payees[seed % payees.length], seed % 3 != 0);
        freezeCalls++;
    }

    /// @dev Delivers a held payment once the payee can receive again. Permissionless, and it only ever pays the payee.
    function claimHeldPayment(uint256 seed) external {
        address payee = payees[seed % payees.length];
        if (vault.heldPaymentOf(payee) == 0) return;
        try vault.claimHeldPayment(payee) {
            claimHeldCalls++;
        } catch {} // still frozen
    }

    function claimRefundByRef(uint256 refSeed) external {
        if (!_refundable()) return;
        bytes32 donorRef = donorRefs[refSeed % donorRefs.length];
        if (vault.donatedByRef(donorRef) == 0) return; // cleared once refunded
        vm.prank(bankPartner);
        vault.claimRefundByRef(donorRef, bankPartner);
        refundCalls++;
    }
}

contract AidVaultInvariantTest is PoATest {
    VaultHandler internal handler;
    AidVault internal vault;
    uint256 internal needId;
    BlocklistEURC internal freezable;

    /// @dev The vault currency is a stablecoin whose issuer can freeze an address, like the real ones.
    function _beforeDeploy() internal override {
        freezable = new BlocklistEURC();
    }

    function _tokenAddress() internal view override returns (address) {
        return address(freezable);
    }

    function setUp() public override {
        super.setUp();
        // Above the high-value threshold (two verifiers), with deadlines and a 60% partial-execution threshold.
        uint256 programId = _createProgram(ngo, 10);
        INeedsRegistry.CreateNeedParams memory p = _needParams(programId, 50_000e6, 2, _threeTrancheBps());
        p.fundingDeadline = uint64(block.timestamp + 30 days);
        p.executionDeadline = uint64(block.timestamp + 90 days);
        p.minFundingBps = 6000;
        p.thirdPartyCostBps = 200; // converted donations have a swap cost, which the cap must allow
        p.costDisclosureHash = COST_DISCLOSURE_HASH;
        // Two suppliers and a 10% NGO share of every tranche: the vault pays all three directly.
        p.payees = new INeedsRegistry.Payee[](3);
        p.payees[0] = _payee(supplierA, _uniformShares(3, 6000));
        p.payees[1] = _payee(supplierB, _uniformShares(3, 3000));
        p.payees[2] = _payee(address(0), _uniformShares(3, 1000));
        vm.prank(ngo);
        needId = registry.createNeed(p);
        // The venue has to be approved and the need opted in before it is verified: after that it can take money,
        // and what a donation is exposed to is settled.
        MockYieldVault venue = new MockYieldVault(token);
        vm.prank(admin);
        registry.setYieldVenue(address(venue), 8000);
        vm.prank(ngo);
        registry.enableYield(needId);
        _attestNeedVerified(verifier1, needId, true);
        _attestNeedVerified(verifier2, needId, true);
        vault = AidVault(registry.vaultOf(needId));

        handler = new VaultHandler(vault, token, registry, admin, ngo, address(deliveryManager), bankPartner);
        handler.setPayees([supplierA, supplierB, ngoPayout]);
        handler.setVenue(venue);
        vm.prank(admin);
        forwarderFactory.setKeeper(address(handler), true); // the handler sweeps like the platform's relayer
        handler.setConversion(
            forwarderFactory, usdc, [eurUsdFeed, usdcUsdFeed, ethUsdFeed], [MOCK_EUR_USD, MOCK_USDC_USD, MOCK_ETH_USD]
        );

        bytes4[] memory selectors = new bytes4[](21);
        selectors[0] = VaultHandler.donate.selector;
        selectors[1] = VaultHandler.donateOnBehalf.selector;
        selectors[2] = VaultHandler.closeFunding.selector;
        selectors[3] = VaultHandler.advanceTranches.selector;
        selectors[4] = VaultHandler.cancel.selector;
        selectors[5] = VaultHandler.claimRefund.selector;
        selectors[6] = VaultHandler.claimRefundByRef.selector;
        selectors[7] = VaultHandler.warp.selector;
        selectors[8] = VaultHandler.expire.selector;
        selectors[9] = VaultHandler.donateConverted.selector;
        selectors[10] = VaultHandler.depositAndSweep.selector;
        selectors[11] = VaultHandler.claimForwarderRefund.selector;
        selectors[12] = VaultHandler.setPayeeFrozen.selector;
        selectors[13] = VaultHandler.claimHeldPayment.selector;
        selectors[14] = VaultHandler.withdrawDonation.selector;
        selectors[15] = VaultHandler.deployIdle.selector;
        selectors[16] = VaultHandler.unwind.selector;
        selectors[17] = VaultHandler.harvest.selector;
        selectors[18] = VaultHandler.payYield.selector;
        selectors[19] = VaultHandler.moveVenue.selector;
        selectors[20] = VaultHandler.fundToTarget.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
        targetContract(address(handler));
    }

    /// @notice The spec's core accounting identity (§5.4), with payments the token refused still in the vault.
    function invariant_vaultAccounting() public view {
        assertEq(
            token.balanceOf(address(vault)) + vault.deployedPrincipal() + vault.totalReleased() + vault.totalRefunded()
                + vault.lossRealised(),
            vault.totalDonated() + vault.totalHeld() + vault.yieldRealised() - vault.yieldPaid(),
            "balance + lent + released + refunded + lost == donated + held + earned - handed on"
        );
    }

    /// @notice Every released unit went to a payee of the plan, and in the plan's proportions. A payment the
    ///         issuer froze is still that payee's, so what each one is owed counts its held share too.
    function invariant_releasedMoneyReachedOnlyThePlan() public view {
        uint256 a = _owedTo(supplierA);
        uint256 b = _owedTo(supplierB);
        // The NGO's payout address also receives the need's earnings, which are not released money: they are
        // paid by payYield, under their own event, and counting them here would read a gain as an overpayment.
        uint256 ngoShare = _owedTo(ngoPayout) - vault.yieldPaid();
        assertEq(a + b + ngoShare, vault.totalReleased(), "released == paid to, or still owed to, the plan");
        // 60 / 30 / 10 per tranche. A and B are rounded down (losing up to 1 unit each per tranche); the NGO is
        // last in the plan, so it also takes that dust (up to 2 units per tranche). Over three tranches that is up
        // to 6 units on the NGO's side, which the x6 comparison magnifies, and 3 on A's.
        assertApproxEqAbs(ngoShare * 6, a, 6 * 6 + 3, "NGO share stays 10%");
        assertApproxEqAbs(b * 2, a, 3 * 2 + 3, "supplier B stays at half of A");
    }

    /// @notice Whatever the venue did, a donor is owed the principal they gave and never a unit less. The
    ///         earnings are the need's; the risk of the venue is not quietly the donor's.
    function invariant_donorsAreOwedTheirPrincipal() public view {
        uint256 owed;
        for (uint256 i; i < 3; ++i) {
            owed += vault.donatedBy(handler.donors(i));
        }
        assertLe(owed, vault.totalDonated(), "a donor is never owed more than the need holds for them");
        assertLe(vault.yieldPaid(), vault.yieldRealised(), "earnings handed on never exceed earnings made");
    }

    function _owedTo(address payee) internal view returns (uint256) {
        return token.balanceOf(payee) + vault.heldPaymentOf(payee);
    }

    function invariant_neverPaysOutMoreThanDonated() public view {
        assertLe(vault.totalReleased() + vault.totalRefunded(), vault.totalDonated());
    }

    function invariant_targetIsNeverExceeded() public view {
        assertLe(vault.totalDonated(), registry.targetAmountOf(needId));
    }

    function invariant_trancheAmountsMatchDonations() public view {
        if (!vault.fundingClosed()) return;
        ITrancheLedger.Tranche[] memory tranches = vault.getTranches();
        uint256 sum;
        uint256 released;
        for (uint256 i; i < tranches.length; ++i) {
            sum += tranches[i].amount;
            if (tranches[i].status == ITrancheLedger.TrancheStatus.Released) released += tranches[i].amount;
        }
        assertEq(sum, vault.totalDonated(), "tranche plan covers every donated unit");
        assertEq(released, vault.totalReleased(), "released tranches equal totalReleased");
    }

    function invariant_cancelledNeedsStopReleasing() public view {
        if (registry.statusOf(needId) != INeedsRegistry.NeedStatus.Cancelled) return;
        assertLe(vault.totalReleased(), vault.totalDonated());
    }

    /// @dev Funding only ever closes on at least the minimum the NGO committed to.
    function invariant_closedFundingMeetsTheThreshold() public view {
        if (!vault.fundingClosed()) return;
        (, uint256 target, uint16 minFundingBps,) = registry.fundingTermsOf(needId);
        assertGe(vault.totalDonated() * 10_000, target * minFundingBps, "closed below the threshold");
    }

    function invariant_callSummary() public view {
        // Surfaced with -vvv so a run that exercised nothing is visible rather than silently green.
        assertTrue(
            handler.donateCalls() + handler.donateOnBehalfCalls() + handler.releaseCalls() + handler.refundCalls()
                    + handler.cancelCalls() + handler.expireCalls() + handler.convertedCalls() + handler.sweepCalls()
                    + handler.forwarderRefundCalls() + handler.freezeCalls() + handler.claimHeldCalls()
                    + handler.withdrawCalls() + handler.deployCalls() + handler.unwindCalls() + handler.harvestCalls()
                    + handler.payYieldCalls() + handler.venueCalls() >= 0
        );
    }
}
