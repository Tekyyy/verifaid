// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AidVault} from "../../src/funds/AidVault.sol";
import {IAidVault} from "../../src/interfaces/IAidVault.sol";
import {INeedsRegistry} from "../../src/interfaces/INeedsRegistry.sol";
import {Errors} from "../../src/libraries/Errors.sol";
import {MockYieldVault} from "../../src/mocks/MockYieldVault.sol";
import {PoATest} from "../utils/PoATest.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice Committed money that will not be spent for a year, earning while it waits.
/// @dev The cases worth writing are the ones a happy path never shows: the venue cannot pay out today, the
///      venue lost money, a donor asks for a refund while the money is lent, and a supplier is owed now.
///      In every one of them the answer has to be the same — a donor is repaid the principal they gave, and a
///      payee is paid in full or the call reverts saying why.
contract YieldSleeveTest is PoATest {
    uint256 internal constant TARGET = 10_000e6;
    uint16 internal constant CAP_BPS = 8000;

    MockYieldVault internal venue;
    uint256 internal needId;
    uint256 internal programId;
    AidVault internal vault;

    function setUp() public override {
        super.setUp();
        venue = new MockYieldVault(IERC20(address(token)));
        vm.prank(admin);
        registry.setYieldVenue(address(venue), CAP_BPS);
    }

    /// @dev A need whose NGO opted in while it was still Pending, funded to its target so funding is closed.
    function _fundedOptedInNeed() internal returns (AidVault v) {
        programId = _createProgram(ngo, 10);
        needId = _createNeed(ngo, programId, TARGET, 1);
        vm.prank(ngo);
        registry.enableYield(needId);
        _attestNeedVerified(verifier1, needId, true);
        v = AidVault(registry.vaultOf(needId));
        _donate(donor1, needId, TARGET); // reaching the target closes funding
    }

    /// @dev The state this is all for: pre-financing paid, and the rest waiting on deliveries that take months.
    function _waitingNeed() internal returns (AidVault v) {
        v = _fundedOptedInNeed();
        v.releaseTranche(0);
    }

    /// @dev What is left in the vault once the pre-financing tranche is out.
    function _waiting() internal view returns (uint256) {
        return TARGET - vault.getTranches()[0].amount;
    }

    // ─── opting in ─────────────────────────────────────────────────────────────

    function test_optIn_isTheNgoDecisionAndOnlyBeforeAnyoneCanDonate() public {
        programId = _createProgram(ngo, 10);
        needId = _createNeed(ngo, programId, TARGET, 1);

        vm.prank(donor1);
        vm.expectRevert(Errors.Unauthorized.selector);
        registry.enableYield(needId);

        vm.expectEmit(true, true, true, true, address(registry));
        emit INeedsRegistry.YieldEnabled(needId, address(venue), CAP_BPS);
        vm.prank(ngo);
        registry.enableYield(needId);

        // Once the need is verified it can take money, and what a donation is exposed to is settled.
        _attestNeedVerified(verifier1, needId, true);
        vm.prank(ngo);
        vm.expectRevert(Errors.InvalidNeedStatus.selector);
        registry.enableYield(needId);
    }

    function test_optIn_needsAnApprovedVenue() public {
        vm.prank(admin);
        registry.setYieldVenue(address(0), 0);
        programId = _createProgram(ngo, 10);
        needId = _createNeed(ngo, programId, TARGET, 1);
        vm.prank(ngo);
        vm.expectRevert(Errors.YieldNotEnabled.selector);
        registry.enableYield(needId);
    }

    function test_venue_isTheAdminsToApprove() public {
        vm.prank(ngo);
        vm.expectRevert(Errors.Unauthorized.selector);
        registry.setYieldVenue(address(venue), CAP_BPS);
    }

    // ─── deploying ─────────────────────────────────────────────────────────────

    function test_deploy_refusesWhileADonorCouldStillTakeTheirMoneyBack() public {
        programId = _createProgram(ngo, 10);
        needId = _createNeed(ngo, programId, TARGET, 1);
        vm.prank(ngo);
        registry.enableYield(needId);
        _attestNeedVerified(verifier1, needId, true);
        vault = AidVault(registry.vaultOf(needId));
        _donate(donor1, needId, TARGET / 2); // funding still open

        vm.expectRevert(Errors.InvalidNeedStatus.selector);
        vault.deployIdle(1e6);
    }

    function test_deploy_refusesWhenTheNeedNeverOptedIn() public {
        (needId, programId, vault) = _verifiedNeed(TARGET);
        _donate(donor1, needId, TARGET);
        vm.expectRevert(Errors.YieldNotEnabled.selector);
        vault.deployIdle(1e6);
    }

    function test_deploy_sendsIdleMoneyAndKeepsTheBooksInAssets() public {
        vault = _waitingNeed();
        uint256 deployable = vault.deployableAmount();
        assertEq(deployable, (_waiting() * CAP_BPS) / 10_000, "the cap is on the whole pot");

        vm.expectEmit(true, true, false, false, address(vault));
        emit IAidVault.IdleDeployed(needId, address(venue), deployable, 0);
        vault.deployIdle(deployable);

        assertEq(vault.deployedPrincipal(), deployable, "principal is what went in, not a share price");
        assertEq(token.balanceOf(address(vault)), _waiting() - deployable, "the rest stays liquid");
        assertEq(token.balanceOf(address(venue)), deployable);
        assertVaultInvariant(vault);
    }

    function test_deploy_cannotCreepPastTheCapOneCallAtATime() public {
        vault = _waitingNeed();
        vault.deployIdle(1000e6);
        vault.deployIdle(1000e6);
        uint256 left = vault.deployableAmount();
        assertEq(left, (_waiting() * CAP_BPS) / 10_000 - 2000e6, "the cap counts what is already out there");

        vm.expectRevert(Errors.InvalidParameter.selector);
        vault.deployIdle(left + 1);
    }

    function test_deploy_leavesAReleasableTrancheWhereAPayeeCanReachIt() public {
        vault = _waitingNeed();
        _runDelivery(needId, 1); // a verified delivery makes tranche 1 payable right now

        uint256 releasable = _trancheAmount(1);
        assertGt(releasable, 0);
        assertEq(
            vault.deployableAmount(),
            token.balanceOf(address(vault)) - releasable,
            "money a supplier can claim this instant never leaves"
        );
    }

    // ─── earning, and handing it on ────────────────────────────────────────────

    function test_harvest_realisesTheGainAndLeavesThePrincipalWorking() public {
        vault = _waitingNeed();
        vault.deployIdle(5000e6);
        _accrue(400e6);

        (uint256 value, uint256 unrealised) = vault.sleeveValue();
        assertApproxEqAbs(value, 5400e6, 1, "4626 rounds the share price down");
        assertApproxEqAbs(unrealised, 400e6, 1);

        uint256 before = token.balanceOf(address(vault));
        vault.harvest();

        assertApproxEqAbs(vault.yieldRealised(), 400e6, 1);
        assertEq(vault.deployedPrincipal(), 5000e6, "the principal is still earning");
        assertApproxEqAbs(token.balanceOf(address(vault)), before + 400e6, 1);
        assertVaultInvariant(vault);
    }

    function test_yield_goesToTheNgoOnlyOnceTheNeedIsOverAndTheMoneyIsHome() public {
        vault = _waitingNeed();
        vault.deployIdle(5000e6);
        _accrue(400e6);
        vault.harvest();

        vm.expectRevert(Errors.InvalidNeedStatus.selector);
        vault.payYield();

        _completeNeed(); // each release pulls back whatever it is short of
        vm.expectRevert(Errors.SleeveNotClosed.selector);
        vault.payYield();

        vault.unwind(type(uint256).max);
        uint256 before = token.balanceOf(ngoPayout);
        uint256 handedOn = vault.payYield();
        assertApproxEqAbs(handedOn, 400e6, 1);
        assertEq(token.balanceOf(ngoPayout) - before, handedOn, "the earnings follow the work");
        assertVaultInvariant(vault);
    }

    // ─── the venue misbehaving ─────────────────────────────────────────────────

    function test_release_pullsTheMoneyBackSoASupplierIsPaidInFull() public {
        vault = _waitingNeed();
        vault.deployIdle(vault.deployableAmount());
        _runDelivery(needId, 1);

        uint256 owed = _trancheAmount(1);
        uint256 before = token.balanceOf(supplierA);
        vault.releaseTranche(1);

        assertEq(token.balanceOf(supplierA) - before, owed, "paid in full, from the venue if need be");
        assertEq(vault.totalHeld(), 0, "and nothing was quietly held back");
        assertVaultInvariant(vault);
    }

    function test_release_revertsPlainlyWhenTheVenueCannotPayToday() public {
        vault = _waitingNeed();
        vault.deployIdle(vault.deployableAmount());
        _runDelivery(needId, 1);
        venue.setLiquidityCap(0); // every market fully borrowed

        vm.expectRevert(Errors.SleeveIlliquid.selector);
        vault.releaseTranche(1);
    }

    function test_refund_paysTheDonorBackTheirPrincipalFromTheVenue() public {
        vault = _fundedOptedInNeed(); // nothing paid out yet, so every unit is still the donor's
        vault.deployIdle(5000e6);
        _accrue(500e6);
        vm.prank(admin);
        registry.cancelNeed(needId);

        vm.prank(donor1);
        uint256 refunded = vault.claimRefund();

        assertEq(refunded, TARGET, "a donor is repaid what they gave, never a slice of the yield");
        assertEq(token.balanceOf(donor1), TARGET);
        assertVaultInvariant(vault);
    }

    function test_loss_isChargedToTheEarningsBeforeAnyoneIsPaid() public {
        vault = _waitingNeed();
        vault.deployIdle(5000e6);
        _accrue(300e6);
        vault.harvest();
        venue.lose(500e6); // bad debt in a market the curator allocated to

        vault.unwind(type(uint256).max);

        assertApproxEqAbs(vault.lossRealised(), 500e6, 1, "the shortfall is on the books, not hidden");
        assertEq(vault.deployedPrincipal(), 0);
        assertApproxEqAbs(vault.yieldRealised(), 300e6, 1, "the gain was real while it lasted");

        // 300 earned against 500 lost: nothing is handed on, and the need carries the difference.
        vm.prank(admin);
        registry.cancelNeed(needId);
        vm.expectRevert(Errors.NothingToClaim.selector);
        vault.payYield();
        assertVaultInvariant(vault);
    }

    function test_unwind_worksWhileThePlatformIsPaused() public {
        vault = _waitingNeed();
        vault.deployIdle(5000e6);
        vm.prank(admin);
        roles.pause();

        vm.expectRevert(); // deploying more is not
        vault.deployIdle(1e6);
        assertEq(vault.unwind(type(uint256).max), 5000e6, "but getting escrow home always is");
        assertVaultInvariant(vault);
    }

    function test_deploy_refusesAfterTheAdminMovesTheApprovedVenue() public {
        vault = _fundedOptedInNeed();
        vault.deployIdle(1000e6);

        MockYieldVault other = new MockYieldVault(IERC20(address(token)));
        vm.prank(admin);
        registry.setYieldVenue(address(other), CAP_BPS);

        vm.expectRevert(Errors.YieldVenueChanged.selector);
        vault.deployIdle(1000e6);

        // Closing the old position first is what lets the vault follow the platform to the new one.
        vault.unwind(type(uint256).max);
        vault.deployIdle(1000e6);
        assertEq(address(vault.sleeve()), address(other));
    }

    // ─── helpers ───────────────────────────────────────────────────────────────

    function _accrue(uint256 amount) internal {
        deal(address(token), address(this), amount);
        token.approve(address(venue), amount);
        venue.accrue(amount);
    }

    function _trancheAmount(uint256 index) internal view returns (uint256) {
        return vault.getTranches()[index].amount;
    }

    /// @dev Runs every remaining tranche through a delivery so the need reaches Completed.
    function _completeNeed() internal {
        uint256 count = vault.trancheCount();
        for (uint256 i = 1; i < count; ++i) {
            _runDelivery(needId, i);
            vault.releaseTranche(i);
        }
    }
}
