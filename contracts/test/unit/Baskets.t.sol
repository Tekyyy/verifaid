// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AidVault} from "../../src/funds/AidVault.sol";
import {IDonationForwarderFactory} from "../../src/interfaces/IDonationForwarderFactory.sol";
import {INeedsRegistry} from "../../src/interfaces/INeedsRegistry.sol";
import {IReleasePolicy} from "../../src/interfaces/IReleasePolicy.sol";
import {Errors} from "../../src/libraries/Errors.sol";
import {PoATest} from "../utils/PoATest.sol";

/// @notice Giving baskets: one gift split equally, by the contract, across the needs of a basket (a category's open
///         needs), each part an ordinary donation in the giver's name.
contract BasketsTest is PoATest {
    uint256 internal constant TARGET = 1000e6;
    bytes32 internal constant WATER = keccak256("WATER");

    function _fund(address who, uint256 amount) internal {
        token.mint(who, amount);
        vm.prank(who);
        token.approve(address(forwarderFactory), amount);
    }

    function _give(address who, uint256[] memory needIds, uint256 total)
        internal
        returns (uint256[] memory amounts, uint256 returned)
    {
        _fund(who, total);
        vm.prank(who);
        (amounts, returned) = forwarderFactory.donateEqually(WATER, needIds, total);
    }

    function _raising(uint256 count) internal returns (uint256[] memory ids, AidVault[] memory vaults) {
        ids = new uint256[](count);
        vaults = new AidVault[](count);
        for (uint256 i; i < count; ++i) {
            (ids[i],, vaults[i]) = _verifiedNeed(TARGET);
        }
    }

    function test_donateEqually_splitsEquallyAndCreditsTheGiverOnEveryNeed() public {
        (uint256[] memory ids, AidVault[] memory vaults) = _raising(3);
        uint256[] memory expected = new uint256[](3);
        (expected[0], expected[1], expected[2]) = (100e6, 100e6, 100e6);

        _fund(donor1, 300e6);
        vm.expectEmit(true, true, false, true, address(forwarderFactory));
        emit IDonationForwarderFactory.BasketDonated(donor1, WATER, ids, expected, 0);
        vm.prank(donor1);
        forwarderFactory.donateEqually(WATER, ids, 300e6);

        for (uint256 i; i < 3; ++i) {
            assertEq(vaults[i].donatedBy(donor1), 100e6, "a donation in the giver's own name");
            (IReleasePolicy.Voice voice, uint256 weight) = deliveryManager.voiceOf(ids[i], donor1);
            assertEq(uint8(voice), uint8(IReleasePolicy.Voice.Donor), "with a say on its evidence");
            assertEq(weight, 100e6);
        }
        assertEq(receipt.balanceOf(donor1), 3, "one receipt per need");
        assertEq(token.balanceOf(donor1), 0);
    }

    /// @dev A need with less room than its equal part takes what it can; the others share the rest equally.
    function test_donateEqually_aNearlyFullNeedTakesItsRoom_theOthersShareTheRest() public {
        (uint256[] memory ids, AidVault[] memory vaults) = _raising(3);
        _donate(donor2, ids[1], TARGET - 50e6); // room for 50

        (uint256[] memory amounts, uint256 returned) = _give(donor1, ids, 300e6);

        assertEq(amounts[1], 50e6);
        assertEq(amounts[0], 125e6);
        assertEq(amounts[2], 125e6);
        assertEq(returned, 0);
        assertEq(registry.statusOf(ids[1]), INeedsRegistry.NeedStatus.Funded, "the gift filled it");
        assertEq(vaults[0].donatedBy(donor1), 125e6);
    }

    function test_donateEqually_skipsNeedsNotTakingMoney_andReturnsWhatNobodyCouldTake() public {
        (uint256[] memory ids,) = _raising(2);
        _donate(donor2, ids[0], TARGET); // full: funding closed
        _donate(donor2, ids[1], TARGET - 40e6); // room for 40

        (uint256[] memory amounts, uint256 returned) = _give(donor1, ids, 100e6);

        assertEq(amounts[0], 0);
        assertEq(amounts[1], 40e6);
        assertEq(returned, 60e6);
        assertEq(token.balanceOf(donor1), 60e6, "what no need could take went back");
    }

    function test_donateEqually_skipsANeedOfASuspendedNgo() public {
        (uint256[] memory ids,) = _raising(1);
        (uint256 other,,) = _verifiedNeedFor(ngo2);
        uint256[] memory both = new uint256[](2);
        (both[0], both[1]) = (ids[0], other);
        vm.prank(admin);
        roles.setNgoActive(ngo2, false);

        (uint256[] memory amounts,) = _give(donor1, both, 100e6);
        assertEq(amounts[0], 100e6);
        assertEq(amounts[1], 0);
    }

    function test_donateEqually_refusesWhenNothingIsTakingMoney() public {
        (uint256[] memory ids,) = _raising(1);
        _donate(donor2, ids[0], TARGET);
        _fund(donor1, 10e6);
        vm.prank(donor1);
        vm.expectRevert(Errors.NotAccepting.selector);
        forwarderFactory.donateEqually(WATER, ids, 10e6);
    }

    function test_donateEqually_refusesDuplicatesDisorderAndNonsense() public {
        (uint256[] memory ids,) = _raising(2);
        _fund(donor1, 10e6);
        vm.startPrank(donor1);

        uint256[] memory twice = new uint256[](2);
        (twice[0], twice[1]) = (ids[0], ids[0]);
        vm.expectRevert(Errors.InvalidParameter.selector);
        forwarderFactory.donateEqually(WATER, twice, 10e6);

        uint256[] memory backwards = new uint256[](2);
        (backwards[0], backwards[1]) = (ids[1], ids[0]);
        vm.expectRevert(Errors.InvalidParameter.selector);
        forwarderFactory.donateEqually(WATER, backwards, 10e6);

        vm.expectRevert(Errors.InvalidParameter.selector);
        forwarderFactory.donateEqually(WATER, new uint256[](0), 10e6);
        vm.expectRevert(Errors.ZeroAmount.selector);
        forwarderFactory.donateEqually(WATER, ids, 0);

        uint256 limit = forwarderFactory.MAX_BASKET_NEEDS();
        uint256[] memory tooMany = new uint256[](limit + 1);
        for (uint256 i; i <= limit; ++i) {
            tooMany[i] = i + 1;
        }
        vm.expectRevert(Errors.InvalidParameter.selector);
        forwarderFactory.donateEqually(WATER, tooMany, 10e6);
        vm.stopPrank();
    }

    /// @dev Whatever the rooms: nothing is lost, no need gets more than its room, money only goes back once every
    ///      need is full, and needs that were not capped get equal parts (to the unit).
    function testFuzz_donateEqually_isEqualAndLosesNothing(uint96 total, uint64 gap0, uint64 gap1, uint64 gap2) public {
        total = uint96(bound(total, 1, 3 * TARGET));
        uint256[3] memory gaps = [bound(gap0, 1, TARGET), bound(gap1, 1, TARGET), bound(gap2, 1, TARGET)];
        (uint256[] memory ids,) = _raising(3);
        for (uint256 i; i < 3; ++i) {
            if (gaps[i] < TARGET) _donate(donor2, ids[i], TARGET - gaps[i]);
        }

        (uint256[] memory amounts, uint256 returned) = _give(donor1, ids, total);

        uint256 given;
        for (uint256 i; i < 3; ++i) {
            assertLe(amounts[i], gaps[i], "never more than the room");
            given += amounts[i];
        }
        assertEq(given + returned, total, "nothing lost");
        if (returned > 0) {
            for (uint256 i; i < 3; ++i) {
                assertEq(amounts[i], gaps[i], "money goes back only once every need is full");
            }
        }
        for (uint256 i; i < 3; ++i) {
            for (uint256 j; j < 3; ++j) {
                // Two needs that both got less than their room got the same, give or take the rounding unit.
                if (amounts[i] < gaps[i] && amounts[j] < gaps[j]) {
                    assertApproxEqAbs(amounts[i], amounts[j], 1, "equal parts");
                }
            }
        }
    }

    /// @dev A verified need of `owner`'s, raising money.
    function _verifiedNeedFor(address owner) internal returns (uint256 needId, uint256 programId, AidVault vault) {
        programId = _createProgram(owner);
        vm.prank(owner);
        needId = registry.createNeed(_needParams(programId, TARGET, 1, _threeTrancheBps()));
        _attestNeedVerified(verifier1, needId, true);
        vault = AidVault(registry.vaultOf(needId));
    }
}
