// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AidVault} from "../../src/funds/AidVault.sol";
import {IAidVault} from "../../src/interfaces/IAidVault.sol";
import {INeedsRegistry} from "../../src/interfaces/INeedsRegistry.sol";
import {ITrancheLedger} from "../../src/interfaces/ITrancheLedger.sol";
import {Errors} from "../../src/libraries/Errors.sol";
import {PoATest} from "../utils/PoATest.sol";

/// @notice Fuzz tests for the arithmetic that decides where donor money goes: the tranche split at
///         `closeFunding` (including partial execution at the deadline) and pro-rata refunds.
contract VaultMathFuzzTest is PoATest {
    uint256 internal programId;

    function setUp() public override {
        super.setUp();
        programId = _createProgram(ngo);
    }

    /// @dev Builds a valid split (1–5 parts, each ≥ 1 bp, summing to exactly 10_000) from fuzz input.
    function _fuzzBps(uint256[4] memory seeds, uint8 countSeed) internal pure returns (uint16[] memory bps) {
        uint256 n = uint256(countSeed) % 5 + 1;
        bps = new uint16[](n);
        uint256 prev;
        for (uint256 i; i + 1 < n; ++i) {
            uint256 lo = prev + 1;
            uint256 hi = 10_000 - (n - 1 - i);
            uint256 cut = lo + (seeds[i] % (hi - lo + 1));
            bps[i] = uint16(cut - prev);
            prev = cut;
        }
        bps[n - 1] = uint16(10_000 - prev);
    }

    function testFuzz_trancheSplitSumsToTotalDonated(uint256[4] memory seeds, uint8 countSeed, uint256 amount) public {
        uint16[] memory bps = _fuzzBps(seeds, countSeed);
        amount = bound(amount, 1, 1_000_000_000e6);

        vm.prank(ngo);
        uint256 needId = registry.createNeed(_needParams(programId, amount, 2, bps));
        _attestNeedVerified(verifier1, needId, true);
        _attestNeedVerified(verifier2, needId, true);
        AidVault vault = AidVault(registry.vaultOf(needId));

        _donate(donor1, needId, amount); // hits the target and closes funding

        ITrancheLedger.Tranche[] memory tranches = vault.getTranches();
        uint256 sum;
        for (uint256 i; i < tranches.length; ++i) {
            if (i + 1 < tranches.length) {
                assertEq(tranches[i].amount, (amount * tranches[i].bps) / 10_000, "floor share");
            }
            sum += tranches[i].amount;
        }
        assertEq(sum, amount, "tranches sum to donations");
        assertEq(vault.totalDonated(), amount);
        assertVaultInvariant(vault);
    }

    function testFuzz_donationsNeverExceedTarget(uint256 target, uint256 first, uint256 second) public {
        target = bound(target, 2, HIGH_VALUE_THRESHOLD);
        first = bound(first, 1, target - 1);
        second = bound(second, target - first + 1, type(uint128).max);

        uint256 needId = _createNeed(ngo, programId, target, 1);
        _attestNeedVerified(verifier1, needId, true);
        AidVault vault = AidVault(registry.vaultOf(needId));

        _donate(donor1, needId, first);
        _fundDonor(donor2, needId, second);
        vm.prank(donor2);
        vm.expectRevert(Errors.ExceedsTarget.selector);
        vault.donate(second);

        assertEq(vault.totalDonated(), first);
        assertVaultInvariant(vault);
    }

    function testFuzz_refundsSplitTheUnreleasedBalance(
        uint256 a,
        uint256 b,
        uint256 c,
        bool releaseFirstTranche,
        bool releaseSecondTranche
    ) public {
        a = bound(a, 1e6, 100_000e6);
        b = bound(b, 1e6, 100_000e6);
        c = bound(c, 1e6, 100_000e6);
        uint256 target = a + b + c;

        vm.prank(ngo);
        uint256 needId = registry.createNeed(_needParams(programId, target, 2, _threeTrancheBps()));
        _attestNeedVerified(verifier1, needId, true);
        _attestNeedVerified(verifier2, needId, true);
        AidVault vault = AidVault(registry.vaultOf(needId));

        address donor3 = makeAddr("donor3");
        _donate(donor1, needId, a);
        _donate(donor2, needId, b);
        _donate(donor3, needId, c);
        assertTrue(vault.fundingClosed(), "target reached");

        if (releaseFirstTranche) {
            vault.releaseTranche(0);
            if (releaseSecondTranche) {
                vm.prank(address(deliveryManager));
                vault.markReleasable(1, 1);
                vault.releaseTranche(1);
            }
        }

        vm.prank(admin);
        registry.cancelNeed(needId);

        uint256 unreleased = vault.totalDonated() - vault.totalReleased();
        vm.prank(donor1);
        uint256 r1 = vault.claimRefund();
        vm.prank(donor2);
        uint256 r2 = vault.claimRefund();
        vm.prank(donor3);
        uint256 r3 = vault.claimRefund();

        assertLe(r1 + r2 + r3, unreleased, "refunds never exceed the unreleased balance");
        // floor rounding can strand at most 1 base unit per claimant
        assertGe(r1 + r2 + r3 + 3, unreleased, "refunds distribute all but dust");
        assertEq(token.balanceOf(address(vault)), unreleased - (r1 + r2 + r3), "dust stays in the vault");
        assertVaultInvariant(vault);
    }

    /// @dev Partial execution: whatever was raised at or above the threshold is split by the same basis points, so
    ///      every tranche shrinks by the same factor and nothing is lost to rounding.
    function testFuzz_partialExecutionRescalesTranches(
        uint256[4] memory seeds,
        uint8 countSeed,
        uint256 target,
        uint16 minFundingBps,
        uint256 raised
    ) public {
        uint16[] memory bps = _fuzzBps(seeds, countSeed);
        target = bound(target, 100, HIGH_VALUE_THRESHOLD);
        minFundingBps = uint16(bound(minFundingBps, 1, 10_000));
        uint256 minimum = (target * minFundingBps + 9999) / 10_000;
        if (minimum >= target) return; // all or nothing: covered by the expiry test below
        raised = bound(raised, minimum, target - 1);

        INeedsRegistry.CreateNeedParams memory p = _needParams(programId, target, 1, bps);
        p.fundingDeadline = uint64(block.timestamp + 1 days);
        p.minFundingBps = minFundingBps;
        uint256 needId = _verifiedNeedWith(p);
        AidVault vault = AidVault(registry.vaultOf(needId));
        _donate(donor1, needId, raised);

        vm.warp(block.timestamp + 1 days);
        registry.expire(needId);
        assertEq(registry.statusOf(needId), INeedsRegistry.NeedStatus.Funded);

        ITrancheLedger.Tranche[] memory tranches = vault.getTranches();
        uint256 sum;
        for (uint256 i; i < tranches.length; ++i) {
            if (i + 1 < tranches.length) assertEq(tranches[i].amount, (raised * bps[i]) / 10_000, "scaled share");
            sum += tranches[i].amount;
        }
        assertEq(sum, raised, "scaled tranches sum to what was raised");
        assertVaultInvariant(vault);
    }

    /// @dev Below the threshold the need expires and every donor gets exactly their donation back.
    function testFuzz_expiryBelowThresholdRefundsInFull(uint256 target, uint16 minFundingBps, uint256 a, uint256 b)
        public
    {
        target = bound(target, 10_000, HIGH_VALUE_THRESHOLD); // with minFundingBps >= 2 the minimum is >= 2 units
        minFundingBps = uint16(bound(minFundingBps, 2, 10_000));
        uint256 minimum = (target * minFundingBps + 9999) / 10_000;
        a = bound(a, 1, minimum - 1);
        b = bound(b, 0, minimum - 1 - a);

        INeedsRegistry.CreateNeedParams memory p = _needParams(programId, target, 1, _threeTrancheBps());
        p.fundingDeadline = uint64(block.timestamp + 1 days);
        p.minFundingBps = minFundingBps;
        uint256 needId = _verifiedNeedWith(p);
        AidVault vault = AidVault(registry.vaultOf(needId));
        _donate(donor1, needId, a);
        if (b > 0) _donate(donor2, needId, b);

        vm.warp(block.timestamp + 1 days);
        registry.expire(needId);
        assertEq(registry.statusOf(needId), INeedsRegistry.NeedStatus.Expired);

        vm.prank(donor1);
        assertEq(vault.claimRefund(), a);
        if (b > 0) {
            vm.prank(donor2);
            assertEq(vault.claimRefund(), b);
        }
        assertEq(token.balanceOf(address(vault)), 0);
        assertVaultInvariant(vault);
    }

    function testFuzz_refundIsProportionalToDonation(uint256 a, uint256 b) public {
        a = bound(a, 1e6, 1_000_000e6);
        b = bound(b, 1e6, 1_000_000e6);

        vm.prank(ngo);
        uint256 needId = registry.createNeed(_needParams(programId, a + b, 2, _threeTrancheBps()));
        _attestNeedVerified(verifier1, needId, true);
        _attestNeedVerified(verifier2, needId, true);
        AidVault vault = AidVault(registry.vaultOf(needId));

        _donate(donor1, needId, a);
        _donate(donor2, needId, b);
        vault.releaseTranche(0);
        vm.prank(admin);
        registry.cancelNeed(needId);

        uint256 unreleased = vault.totalDonated() - vault.totalReleased();
        vm.prank(donor1);
        uint256 r1 = vault.claimRefund();
        vm.prank(donor2);
        uint256 r2 = vault.claimRefund();

        assertEq(r1, (a * unreleased) / (a + b));
        assertEq(r2, (b * unreleased) / (a + b));
        assertVaultInvariant(vault);
    }
}
