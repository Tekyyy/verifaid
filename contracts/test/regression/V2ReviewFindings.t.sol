// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AidVault} from "../../src/funds/AidVault.sol";
import {NonCustodialLedger} from "../../src/funds/NonCustodialLedger.sol";
import {IDeliveryManager} from "../../src/interfaces/IDeliveryManager.sol";
import {INeedsRegistry} from "../../src/interfaces/INeedsRegistry.sol";
import {ITrancheLedger} from "../../src/interfaces/ITrancheLedger.sol";
import {Errors} from "../../src/libraries/Errors.sol";
import {PoATest} from "../utils/PoATest.sol";
import {
    AttestationRequest,
    AttestationRequestData
} from "@ethereum-attestation-service/eas-contracts/contracts/IEAS.sol";

/// @notice The adversarial review of the v2 contracts, one test per finding, each asserting the fixed behaviour
///         with the reviewer's original exploit sequence. See docs/DECISIONS.md §12.
contract V2ReviewFindingsTest is PoATest {
    address internal bankPartner2 = makeAddr("bankPartner2");
    uint256 internal programId;

    function setUp() public override {
        super.setUp();
        vm.prank(admin);
        roles.registerBankPartner(bankPartner2);
        programId = _createProgram(ngo, 10);
    }

    function _attestExpectingRevert(
        bytes32 schema,
        address attester,
        address recipient,
        bytes memory payload,
        bytes4 selector
    ) internal {
        vm.prank(attester);
        vm.expectRevert(selector);
        eas.attest(
            AttestationRequest({
                schema: schema,
                data: AttestationRequestData({
                    recipient: recipient,
                    expirationTime: 0,
                    revocable: false,
                    refUID: bytes32(0),
                    data: payload,
                    value: 0
                })
            })
        );
    }

    function _offChainParams(uint256 target) internal view returns (INeedsRegistry.CreateNeedParams memory p) {
        p = _needParams(programId, target, 1, _threeTrancheBps());
        p.custodyMode = INeedsRegistry.CustodyMode.OffChain;
        p.custodian = bankPartner;
    }

    // ─── F1: one named custodian per off-chain need ────────────────────────────

    function test_F1_onlyTheNamedCustodianRecordsFundingOrSettles() public {
        (uint256 needId,, NonCustodialLedger ledger) = _verifiedOffChainNeed(1000e6, 0);

        // another registered provider can neither adopt the need with a token amount...
        _attestExpectingRevert(
            fundingRecordedSchema,
            bankPartner2,
            address(ledger),
            abi.encode(needId, uint256(1), uint256(0), uint256(1), EUR, keccak256("B-pay"), keccak256("B-donor")),
            Errors.Unauthorized.selector
        );

        _attestFundingRecorded(bankPartner, needId, 1000e6, keccak256("A-pay"), keccak256("A-donor"));
        uint256 tranche0 = ledger.getTranches()[0].amount;

        // ...nor report a payout of money it never held
        _attestExpectingRevert(
            settlementSchema,
            bankPartner2,
            address(ledger),
            abi.encode(needId, uint256(0), tranche0, uint256(0), tranche0, SUPPLIER_REF, FX_REF),
            Errors.Unauthorized.selector
        );

        _attestSettlement(bankPartner, needId, 0, tranche0, 0);
        assertEq(ledger.trancheStatus(0), ITrancheLedger.TrancheStatus.Released);
    }

    function test_F1_theCustodianIsNamedAtCreationAndValidated() public {
        INeedsRegistry.CreateNeedParams memory p = _offChainParams(1000e6);
        p.custodian = outsider; // not a payment provider
        vm.prank(ngo);
        vm.expectRevert(Errors.InvalidParameter.selector);
        registry.createNeed(p);

        p = _needParams(programId, 1000e6, 1, _threeTrancheBps());
        p.custodian = bankPartner; // on-chain custody has no custodian
        vm.prank(ngo);
        vm.expectRevert(Errors.InvalidParameter.selector);
        registry.createNeed(p);
    }

    function test_F1_aDeregisteredCustodianCanStillReportPayingOut() public {
        (uint256 needId,, NonCustodialLedger ledger) = _verifiedOffChainNeed(1000e6, 0);
        _attestFundingRecorded(bankPartner, needId, 1000e6, keccak256("pay"), keccak256("donor"));
        vm.prank(admin);
        roles.removeBankPartner(bankPartner);

        _attestSettlement(bankPartner, needId, 0, ledger.getTranches()[0].amount, 0);
        assertEq(registry.statusOf(needId), INeedsRegistry.NeedStatus.InDelivery);
    }

    // ─── F2: expiry waits for a verified delivery ──────────────────────────────

    function test_F2_aFrivolousChallengeCannotPushAnEarnedTranchePastTheDeadline() public {
        INeedsRegistry.CreateNeedParams memory p = _needParams(programId, 1000e6, 1, _threeTrancheBps());
        uint256 deadline = block.timestamp + 1 days;
        p.executionDeadline = uint64(deadline);
        uint256 needId = _verifiedNeedWith(p);
        AidVault vault = AidVault(registry.vaultOf(needId));
        _donate(donor1, needId, 1000e6);
        vault.releaseTranche(0);

        vm.warp(deadline - 30 minutes);
        vm.prank(fieldAgent);
        uint256 d = deliveryManager.openDelivery(needId, 1, 10);
        _attestEvidence(fieldAgent, d);
        _confirm(d, 7);
        _attestDeliveryVerified(verifier2, d, true);
        vm.warp(deadline - 21 minutes);
        vm.prank(verifier3);
        deliveryManager.challenge(d, keccak256("frivolous"));
        vm.warp(deadline - 5 minutes);
        vm.prank(admin);
        deliveryManager.resolveDispute(d, false);

        // the deadline passes while the delivery finishes its (resumed) window: expiry must wait
        vm.warp(deadline);
        vm.prank(outsider);
        vm.expectRevert(Errors.ReleasePending.selector);
        registry.expire(needId);

        // the resumed window (1 minute was left) ended before the deadline; finishing still wins
        assertLt(deliveryManager.getDelivery(d).challengeDeadline, deadline);
        deliveryManager.finalize(d);
        vault.releaseTranche(1);
        assertEq(token.balanceOf(ngoPayout), 700e6, "the NGO is paid for the delivery it made");

        registry.expire(needId);
        vm.prank(donor1);
        assertEq(vault.claimRefund(), 300e6, "only the undelivered tranche goes back");
        assertVaultInvariant(vault);
    }

    // ─── F3: expiry cannot be blocked forever ──────────────────────────────────

    function test_F3_anUnreleasableTrancheBlocksExpiryOnlyForTheGracePeriod() public {
        INeedsRegistry.CreateNeedParams memory p = _offChainParams(1000e6);
        p.executionDeadline = uint64(block.timestamp + 1 days);
        uint256 needId = _verifiedNeedWith(p);
        _attestFundingRecorded(bankPartner, needId, 1000e6, keccak256("pay"), keccak256("donor"));
        // the custodian never reports a payout; tranche 0 stays releasable

        vm.warp(block.timestamp + 1 days);
        vm.expectRevert(Errors.ReleasePending.selector);
        registry.expire(needId);

        vm.warp(block.timestamp + registry.EXPIRY_GRACE_PERIOD());
        registry.expire(needId);
        assertEq(registry.statusOf(needId), INeedsRegistry.NeedStatus.Expired);
    }

    function test_F3_aSuspendedNgoCannotLockDonorsOutOfRefunds() public {
        INeedsRegistry.CreateNeedParams memory p = _needParams(programId, 1000e6, 1, _threeTrancheBps());
        p.executionDeadline = uint64(block.timestamp + 1 days);
        uint256 needId = _verifiedNeedWith(p);
        AidVault vault = AidVault(registry.vaultOf(needId));
        _donate(donor1, needId, 1000e6); // tranche 0 releasable, but...
        vm.prank(admin);
        roles.setNgoActive(ngo, false); // ...nobody can release it

        vm.warp(block.timestamp + 1 days + registry.EXPIRY_GRACE_PERIOD());
        registry.expire(needId);
        vm.prank(donor1);
        assertEq(vault.claimRefund(), 1000e6);
    }

    // ─── F4: the execution deadline also closes funding ────────────────────────

    function test_F4_noFundingOrVerificationAfterTheExecutionDeadline() public {
        INeedsRegistry.CreateNeedParams memory p = _needParams(programId, 1000e6, 1, _threeTrancheBps());
        p.executionDeadline = uint64(block.timestamp + 1 days);
        uint256 needId = _verifiedNeedWith(p);
        AidVault vault = AidVault(registry.vaultOf(needId));
        _donate(donor1, needId, 900e6); // above the (test default) minimum

        vm.warp(block.timestamp + 30 days);
        _fundDonor(donor2, needId, 100e6);
        vm.prank(donor2);
        vm.expectRevert(Errors.FundingNotOpen.selector);
        vault.donate(100e6);

        // no time left to deliver: expire, never a partial close
        registry.expire(needId);
        assertEq(registry.statusOf(needId), INeedsRegistry.NeedStatus.Expired);
        vm.prank(donor1);
        assertEq(vault.claimRefund(), 900e6);

        // and a pending need cannot be verified into an overdue state
        vm.prank(ngo);
        uint256 lateNeed = registry.createNeed(p = _needParams(programId, 1000e6, 1, _threeTrancheBps()));
        p.executionDeadline = uint64(block.timestamp + 1 hours);
        vm.prank(ngo);
        uint256 overdue = registry.createNeed(p);
        vm.warp(block.timestamp + 1 hours);
        vm.expectRevert(Errors.DeadlinePassed.selector);
        this.attestVerification(overdue);
        registry.expire(overdue);
        assertEq(registry.statusOf(overdue), INeedsRegistry.NeedStatus.Expired);
        assertEq(registry.statusOf(lateNeed), INeedsRegistry.NeedStatus.Pending, "open-ended need unaffected");
    }

    function attestVerification(uint256 needId) external {
        _attestNeedVerified(verifier1, needId, true);
    }

    // ─── F6: the cost cap is cumulative ────────────────────────────────────────

    function test_F6_fundingAndSettlementFeesCannotStackPastTheDisclosure() public {
        (uint256 needId,, NonCustodialLedger ledger) = _verifiedOffChainNeed(1000e6, 2000); // 20% cap
        // 250 fee on 1250 paid is exactly 20%
        _attestFundingRecorded(bankPartner, needId, 1000e6, 250e6, keccak256("pay"), keccak256("donor"));
        uint256 gross = ledger.getTranches()[0].amount;

        // any settlement fee on top would take total costs past the 20% donors were shown
        _attestExpectingRevert(
            settlementSchema,
            bankPartner,
            address(ledger),
            abi.encode(needId, uint256(0), gross, gross / 5, gross - gross / 5, SUPPLIER_REF, FX_REF),
            Errors.FeeExceedsDisclosure.selector
        );
        _attestSettlement(bankPartner, needId, 0, gross, 0);
        assertEq(resolver.fundingFeesOf(needId), 250e6);
        assertEq(resolver.settlementFeesOf(needId), 0);
    }

    // ─── F7: payment references are scoped per provider ────────────────────────

    function test_F7_aProviderCannotSquatAnotherProvidersReference() public {
        INeedsRegistry.CreateNeedParams memory p = _offChainParams(1000e6);
        p.custodian = bankPartner2;
        uint256 offNeed = _verifiedNeedWith(p);
        uint256 onNeed = _verifiedNeedWith(_needParams(programId, 1000e6, 1, _threeTrancheBps()));
        bytes32 victimRef = keccak256("partnerA-e2e-id-42");

        // bankPartner2 uses the reference first on its own need...
        _attestFundingRecorded(bankPartner2, offNeed, 1, victimRef, keccak256("x"));
        // ...which does not stop bankPartner from using its own reference with the same value
        _donateOnBehalf(onNeed, 500e6, keccak256("donor"), victimRef);
        _attestFundingRecorded(bankPartner, onNeed, 500e6, victimRef, keccak256("donor"));
        assertEq(AidVault(registry.vaultOf(onNeed)).totalDonated(), 500e6);
    }
}
