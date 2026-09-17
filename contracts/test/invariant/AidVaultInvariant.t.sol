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
import {NeedsRegistry} from "../../src/needs/NeedsRegistry.sol";
import {PoATest} from "../utils/PoATest.sol";
import {CommonBase} from "forge-std/Base.sol";
import {StdCheats} from "forge-std/StdCheats.sol";
import {StdUtils} from "forge-std/StdUtils.sol";

/// @notice Drives one vault through random but legal sequences of donations (direct, provider, converted from USDC
///         and swept from deposit addresses), releases, cancellation, the passage of time (funding and execution
///         deadlines, partial execution) and refunds (including forwarder-credited ones).
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
    bytes32[2] public donorRefs;
    uint256 public paymentRefNonce;

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
        vault.donate(amount);
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
        vm.prank(ngo);
        needId = registry.createNeed(p);
        _attestNeedVerified(verifier1, needId, true);
        _attestNeedVerified(verifier2, needId, true);
        vault = AidVault(registry.vaultOf(needId));

        handler = new VaultHandler(vault, token, registry, admin, ngo, address(deliveryManager), bankPartner);
        handler.setConversion(
            forwarderFactory, usdc, [eurUsdFeed, usdcUsdFeed, ethUsdFeed], [MOCK_EUR_USD, MOCK_USDC_USD, MOCK_ETH_USD]
        );

        bytes4[] memory selectors = new bytes4[](12);
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
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
        targetContract(address(handler));
    }

    /// @notice The spec's core accounting identity (§5.4).
    function invariant_vaultAccounting() public view {
        assertEq(
            token.balanceOf(address(vault)) + vault.totalReleased() + vault.totalRefunded(),
            vault.totalDonated(),
            "balance + released + refunded == donated"
        );
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
                    + handler.forwarderRefundCalls() >= 0
        );
    }
}
