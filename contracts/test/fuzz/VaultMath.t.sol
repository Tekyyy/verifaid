// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AidVault} from "../../src/funds/AidVault.sol";
import {IAidVault} from "../../src/interfaces/IAidVault.sol";
import {INeedsRegistry} from "../../src/interfaces/INeedsRegistry.sol";
import {Errors} from "../../src/libraries/Errors.sol";
import {PoATest} from "../utils/PoATest.sol";

/// @notice Fuzz tests for the two pieces of arithmetic that decide where donor money goes:
///         the tranche split at `closeFunding` and the pro-rata refund of a cancelled need.
contract VaultMathFuzzTest is PoATest {
    uint256 internal programId;

    function setUp() public override {
        super.setUp();
        programId = _createProgram(ngo, 10);
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

        IAidVault.Tranche[] memory tranches = vault.getTranches();
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
        uint256 fiat,
        bool releaseFirstTranche,
        bool releaseSecondTranche
    ) public {
        a = bound(a, 1e6, 100_000e6);
        b = bound(b, 1e6, 100_000e6);
        fiat = bound(fiat, 1e6, 100_000e6);
        uint256 target = a + b + fiat;

        vm.prank(ngo);
        uint256 needId = registry.createNeed(_needParams(programId, target, 2, _threeTrancheBps()));
        _attestNeedVerified(verifier1, needId, true);
        _attestNeedVerified(verifier2, needId, true);
        AidVault vault = AidVault(registry.vaultOf(needId));

        bytes32 donorRef = keccak256("fiat-donor");
        _donate(donor1, needId, a);
        _donate(donor2, needId, b);
        _donateOnBehalf(needId, fiat, donorRef, keccak256("payment-ref"));
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
        vm.prank(bankPartner);
        uint256 r3 = vault.claimRefundByRef(donorRef, bankPartner);

        assertLe(r1 + r2 + r3, unreleased, "refunds never exceed the unreleased balance");
        // floor rounding can strand at most 1 base unit per claimant
        assertGe(r1 + r2 + r3 + 3, unreleased, "refunds distribute all but dust");
        assertEq(token.balanceOf(address(vault)), unreleased - (r1 + r2 + r3), "dust stays in the vault");
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
