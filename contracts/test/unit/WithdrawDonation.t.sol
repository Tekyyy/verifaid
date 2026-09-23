// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AidVault} from "../../src/funds/AidVault.sol";
import {IAidVault} from "../../src/interfaces/IAidVault.sol";
import {IDonationReceipt} from "../../src/interfaces/IDonationReceipt.sol";
import {INeedsRegistry} from "../../src/interfaces/INeedsRegistry.sol";
import {Errors} from "../../src/libraries/Errors.sol";
import {PoATest} from "../utils/PoATest.sol";

/// @notice Taking a donation back while the need is still raising: the donor changed their mind, nothing has
///         been committed to a supplier yet, and the money is still theirs. It stops the moment funding closes,
///         and a settling window before the deadline keeps the NGO's go/no-go decision from being sabotaged.
contract WithdrawDonationTest is PoATest {
    uint256 internal constant TARGET = 10_000e6;
    uint256 internal constant FUNDING_WINDOW = 30 days;

    uint256 internal programId;
    uint256 internal needId;
    AidVault internal vault;

    function setUp() public override {
        super.setUp();
        programId = _createProgram(ngo, 10);
        needId = _openNeed(0);
        vault = AidVault(registry.vaultOf(needId));
    }

    /// @dev A verified need raising for 30 days, optionally with a disclosed cost cap.
    function _openNeed(uint16 costBps) internal returns (uint256 id) {
        INeedsRegistry.CreateNeedParams memory p = _needParams(programId, TARGET, 1, _threeTrancheBps());
        p.fundingDeadline = uint64(block.timestamp + FUNDING_WINDOW);
        p.thirdPartyCostBps = costBps;
        p.costDisclosureHash = costBps == 0 ? bytes32(0) : COST_DISCLOSURE_HASH;
        id = _verifiedNeedWith(p);
    }

    function test_withdraw_returnsTheMoneyAndLowersTheReceipt() public {
        uint256 receiptId = _donate(donor1, needId, 1000e6);
        assertEq(vault.totalDonated(), 1000e6);

        vm.expectEmit(true, true, true, true, address(vault));
        emit IAidVault.DonationWithdrawn(needId, donor1, receiptId, 400e6);
        vm.prank(donor1);
        vault.withdrawDonation(receiptId, 400e6);

        assertEq(token.balanceOf(donor1), 400e6, "the donor has it back");
        assertEq(vault.totalDonated(), 600e6, "and the need no longer counts it");
        assertEq(vault.donatedBy(donor1), 600e6);
        assertEq(receipt.receiptOf(receiptId).amount, 600e6, "the receipt states what still stands");
        assertEq(receipt.ownerOf(receiptId), donor1, "the receipt itself is not burned");
        assertVaultInvariant(vault);
    }

    function test_withdraw_canTakeAllOfItAndDonateAgain() public {
        uint256 receiptId = _donate(donor1, needId, 1000e6);
        vm.prank(donor1);
        vault.withdrawDonation(receiptId, 1000e6);

        assertEq(vault.totalDonated(), 0);
        assertEq(receipt.receiptOf(receiptId).amount, 0);
        assertVaultInvariant(vault);

        // The headroom it freed is real: the need can take the money again.
        uint256 second = _donate(donor1, needId, 1000e6);
        assertEq(vault.totalDonated(), 1000e6);
        assertEq(receipt.receiptOf(second).amount, 1000e6);
    }

    function test_withdraw_onlyTheReceiptsOwner() public {
        uint256 receiptId = _donate(donor1, needId, 1000e6);
        _fundDonor(donor2, needId, 1000e6);
        vm.prank(donor2);
        vault.donate(1000e6);

        // donor2 has money in this need, but not under donor1's receipt.
        vm.prank(donor2);
        vm.expectRevert(Errors.Unauthorized.selector);
        vault.withdrawDonation(receiptId, 100e6);

        vm.prank(outsider);
        vm.expectRevert(Errors.InvalidParameter.selector);
        vault.withdrawDonation(receiptId, 100e6);
    }

    function test_withdraw_neverMoreThanTheDonation() public {
        uint256 receiptId = _donate(donor1, needId, 1000e6);

        vm.startPrank(donor1);
        vm.expectRevert(Errors.InvalidParameter.selector);
        vault.withdrawDonation(receiptId, 1000e6 + 1);
        vm.expectRevert(Errors.ZeroAmount.selector);
        vault.withdrawDonation(receiptId, 0);

        vault.withdrawDonation(receiptId, 1000e6);
        vm.expectRevert(Errors.InvalidParameter.selector);
        vault.withdrawDonation(receiptId, 1);
        vm.stopPrank();
    }

    function test_withdraw_stopsWhenFundingCloses() public {
        uint256 receiptId = _donate(donor1, needId, TARGET); // reaching the target closes funding

        vm.prank(donor1);
        vm.expectRevert(Errors.FundingNotOpen.selector);
        vault.withdrawDonation(receiptId, 1e6);
    }

    function test_withdraw_stopsInTheSettlingWindowBeforeTheDeadline() public {
        uint256 receiptId = _donate(donor1, needId, 1000e6);

        vm.warp(block.timestamp + FUNDING_WINDOW - vault.WITHDRAW_LOCK_PERIOD() + 1);
        vm.prank(donor1);
        vm.expectRevert(Errors.WithdrawalLocked.selector);
        vault.withdrawDonation(receiptId, 1e6);
    }

    function test_withdraw_worksUntilTheWindowOpens() public {
        uint256 receiptId = _donate(donor1, needId, 1000e6);

        vm.warp(block.timestamp + FUNDING_WINDOW - vault.WITHDRAW_LOCK_PERIOD() - 1);
        vm.prank(donor1);
        vault.withdrawDonation(receiptId, 1000e6);
        assertEq(token.balanceOf(donor1), 1000e6);
    }

    /// @dev A need with no deadline raises until its target, so there is no window to protect.
    function test_withdraw_hasNoWindowWithoutAFundingDeadline() public {
        uint256 open = _openNeed(0);
        INeedsRegistry.CreateNeedParams memory p = _needParams(programId, TARGET, 1, _threeTrancheBps());
        open = _verifiedNeedWith(p); // fundingDeadline 0
        AidVault openVault = AidVault(registry.vaultOf(open));
        uint256 receiptId = _donate(donor1, open, 1000e6);

        vm.warp(block.timestamp + 3650 days);
        vm.prank(donor1);
        openVault.withdrawDonation(receiptId, 1000e6);
        assertEq(openVault.totalDonated(), 0);
    }

    function test_withdraw_refusedWhilePaused() public {
        uint256 receiptId = _donate(donor1, needId, 1000e6);
        vm.prank(admin);
        roles.pause();

        vm.prank(donor1);
        vm.expectRevert(Errors.SystemPaused.selector);
        vault.withdrawDonation(receiptId, 1e6);
    }

    /// @dev A cost cap is a promise about what donors paid. A donation that is in the vault when a fee is
    ///      recorded is part of what keeps that promise true, so taking it back can break it — and then it is
    ///      refused. Withdrawing what the cap can still absorb stays allowed.
    function test_withdraw_cannotPushRecordedCostsOverTheDisclosedCap() public {
        uint256 capped = _openNeed(200); // 2% of what donors pay
        AidVault cappedVault = AidVault(registry.vaultOf(capped));
        uint256 receiptId = _donate(donor1, capped, 1000e6);

        // Another donor's euros convert into 100 at a cost of 20: fine at 1,100 raised, far over the cap at 100.
        // The factory's donateVia is the one path that records a conversion cost against the need.
        token.mint(address(forwarderFactory), 100e6);
        vm.startPrank(address(forwarderFactory));
        token.approve(address(cappedVault), 100e6);
        cappedVault.donateVia(100e6, 20e6, donor2);
        vm.stopPrank();

        vm.prank(donor1);
        vm.expectRevert(Errors.FeeExceedsDisclosure.selector);
        cappedVault.withdrawDonation(receiptId, 1000e6);

        // What the cap can still absorb comes back as normal.
        vm.prank(donor1);
        cappedVault.withdrawDonation(receiptId, 100e6);
        assertEq(cappedVault.totalDonated(), 1000e6);
        assertVaultInvariant(cappedVault);
    }

    function test_withdraw_refusedOnAnotherNeedsReceipt() public {
        uint256 other = _openNeed(0);
        uint256 otherReceipt = _donate(donor1, other, 500e6);
        _donate(donor1, needId, 500e6);

        vm.prank(donor1);
        vm.expectRevert(Errors.InvalidParameter.selector);
        vault.withdrawDonation(otherReceipt, 1e6);
    }
}
