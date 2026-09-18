// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {NonCustodialLedger} from "../../src/funds/NonCustodialLedger.sol";
import {IAidVaultFactory} from "../../src/interfaces/IAidVaultFactory.sol";
import {IDeliveryManager} from "../../src/interfaces/IDeliveryManager.sol";
import {INeedsRegistry} from "../../src/interfaces/INeedsRegistry.sol";
import {INonCustodialLedger} from "../../src/interfaces/INonCustodialLedger.sol";
import {ITrancheLedger} from "../../src/interfaces/ITrancheLedger.sol";
import {Errors} from "../../src/libraries/Errors.sol";
import {PoATest} from "../utils/PoATest.sol";
import {
    AttestationRequest,
    AttestationRequestData
} from "@ethereum-attestation-service/eas-contracts/contracts/IEAS.sol";

/// @notice Model A: a need whose money is held by a payment provider. No token ever moves on-chain, yet the same
///         funding rules, tranche split, three-signal delivery gate and impact chain apply.
contract NonCustodialLedgerTest is PoATest {
    uint256 internal constant TARGET = 10_000e6;
    uint16 internal constant COST_CAP_BPS = 250; // 2.5%

    uint256 internal needId;
    uint256 internal programId;
    NonCustodialLedger internal ledger;

    function setUp() public override {
        super.setUp();
        (needId, programId, ledger) = _verifiedOffChainNeed(TARGET, COST_CAP_BPS);
    }

    function _ref(uint256 i) internal pure returns (bytes32) {
        return keccak256(abi.encode("card-payment", i));
    }

    /// @dev Settles tranche `index` from the provider with a 1% fee.
    function _settle(uint256 index) internal returns (bytes32 uid) {
        uint256 gross = ledger.getTranches()[index].amount;
        uid = _attestSettlement(bankPartner, needId, index, gross, gross / 100);
    }

    function _attestExpectingRevert(bytes32 schema, address attester, bytes memory payload, bytes4 selector) internal {
        vm.prank(attester);
        vm.expectRevert(selector);
        eas.attest(
            AttestationRequest({
                schema: schema,
                data: AttestationRequestData({
                    recipient: address(ledger),
                    expirationTime: 0,
                    revocable: false,
                    refUID: bytes32(0),
                    data: payload,
                    value: 0
                })
            })
        );
    }

    // ─── setup ─────────────────────────────────────────────────────────────────

    function test_ledgerHoldsNoTokensAndCannotBeUsedDirectly() public {
        assertEq(uint8(registry.custodyModeOf(needId)), uint8(INeedsRegistry.CustodyMode.OffChain));
        assertEq(registry.statusOf(needId), INeedsRegistry.NeedStatus.Funding);
        assertEq(token.balanceOf(address(ledger)), 0);

        vm.expectRevert(Errors.Unauthorized.selector);
        ledger.recordFunding(bankPartner, 1, 0, 1, EUR, _ref(0), keccak256("donor"));
        vm.expectRevert(Errors.Unauthorized.selector);
        ledger.recordRelease(0);

        NonCustodialLedger implementation = NonCustodialLedger(factory.ledgerImplementation());
        vm.prank(address(resolver));
        vm.expectRevert(Errors.NotLedger.selector);
        implementation.recordFunding(bankPartner, 1, 0, 1, EUR, _ref(0), keccak256("donor"));
    }

    function test_constructor_revertsOnZeroResolver() public {
        vm.expectRevert(Errors.ZeroAddress.selector);
        new NonCustodialLedger(
            roles, registry, address(deliveryManager), IAidVaultFactory(address(factory)), address(0)
        );
    }

    // ─── funding ───────────────────────────────────────────────────────────────

    function test_fundingRecorded_countsTowardTheTargetAndClosesFunding() public {
        vm.expectEmit(true, true, false, true, address(ledger));
        emit INonCustodialLedger.FundingRecorded(
            needId, bankPartner, 6150e6, 150e6, 6000e6, EUR, _ref(1), keccak256("d")
        );
        _attestFundingRecorded(bankPartner, needId, 6000e6, 150e6, _ref(1), keccak256("d"));

        assertEq(ledger.totalDonated(), 6000e6, "net counts toward the target");
        assertEq(registry.custodianOf(needId), bankPartner);
        assertTrue(factory.isPaymentRefConsumed(bankPartner, _ref(1)));
        assertFalse(ledger.fundingClosed());

        _attestFundingRecorded(bankPartner, needId, 4000e6, 0, _ref(2), keccak256("d2"));
        assertTrue(ledger.fundingClosed());
        assertEq(registry.statusOf(needId), INeedsRegistry.NeedStatus.Funded);

        ITrancheLedger.Tranche[] memory tranches = ledger.getTranches();
        assertEq(tranches[0].amount, 3000e6);
        assertEq(tranches[1].amount, 4000e6);
        assertEq(tranches[2].amount, 3000e6);
        assertEq(tranches[0].status, ITrancheLedger.TrancheStatus.Releasable);
    }

    function test_fundingRecorded_enforcesTheSameRulesAsAVault() public {
        // above the target
        _attestExpectingRevert(
            fundingRecordedSchema,
            bankPartner,
            abi.encode(needId, TARGET + 1, 0, TARGET + 1, EUR, _ref(1), keccak256("d")),
            Errors.ExceedsTarget.selector
        );

        // fee beyond the 2.5% disclosed for this need
        _attestExpectingRevert(
            fundingRecordedSchema,
            bankPartner,
            abi.encode(needId, 1000e6, 26e6, 974e6, EUR, _ref(1), keccak256("d")),
            Errors.FeeExceedsDisclosure.selector
        );

        // only a registered provider
        _attestExpectingRevert(
            fundingRecordedSchema,
            donor1,
            abi.encode(needId, 1000e6, 0, 1000e6, EUR, _ref(1), keccak256("d")),
            Errors.Unauthorized.selector
        );

        // a payment reference already used anywhere in the system
        _attestFundingRecorded(bankPartner, needId, 1000e6, _ref(1), keccak256("d"));
        _attestExpectingRevert(
            fundingRecordedSchema,
            bankPartner,
            abi.encode(needId, 1000e6, 0, 1000e6, EUR, _ref(1), keccak256("d")),
            Errors.FundingAlreadyAttested.selector
        );

        // an inactive NGO cannot receive more money
        vm.prank(admin);
        roles.setNgoActive(ngo, false);
        _attestExpectingRevert(
            fundingRecordedSchema,
            bankPartner,
            abi.encode(needId, 1000e6, 0, 1000e6, EUR, _ref(2), keccak256("d")),
            Errors.NgoInactive.selector
        );
    }

    function test_paymentReferenceCannotFundBothCustodyModes() public {
        (uint256 onChainNeed,,) = _verifiedNeed(1000e6);
        _donateOnBehalf(onChainNeed, 500e6, keccak256("d"), _ref(7));

        _attestExpectingRevert(
            fundingRecordedSchema,
            bankPartner,
            abi.encode(needId, 500e6, 0, 500e6, EUR, _ref(7), keccak256("d")),
            Errors.PaymentRefAlreadyUsed.selector
        );
    }

    function test_closeFunding_byTheNgoAndExpiryFollowTheThreshold() public {
        _attestFundingRecorded(bankPartner, needId, 2000e6, _ref(1), keccak256("d"));
        vm.prank(ngo);
        ledger.closeFunding(); // default test threshold is any amount
        assertEq(registry.statusOf(needId), INeedsRegistry.NeedStatus.Funded);
        assertEq(ledger.getTranches()[0].amount, 600e6);
    }

    function test_expire_belowThresholdMarksTheNeedExpired() public {
        INeedsRegistry.CreateNeedParams memory p = _needParams(programId, TARGET, 1, _threeTrancheBps());
        _asOffChain(p, bankPartner);
        p.fundingDeadline = uint64(block.timestamp + 7 days);
        p.minFundingBps = 5000;
        uint256 shortNeed = _verifiedNeedWith(p);
        _attestFundingRecorded(bankPartner, shortNeed, 4000e6, _ref(1), keccak256("d"));

        vm.warp(block.timestamp + 7 days);
        registry.expire(shortNeed);
        // the provider returns the money off-chain; the chain records that the need did not go ahead
        assertEq(registry.statusOf(shortNeed), INeedsRegistry.NeedStatus.Expired);
    }

    // ─── settlement releases tranches ──────────────────────────────────────────

    function test_settlement_releasesTheTrancheAndStartsDelivery() public {
        _attestFundingRecorded(bankPartner, needId, TARGET, _ref(1), keccak256("d"));

        vm.expectEmit(true, true, false, true, address(ledger));
        emit ITrancheLedger.TrancheReleased(needId, 0, 3000e6, ngoPayout);
        bytes32 uid = _settle(0);

        assertEq(resolver.settlementOf(needId, 0), uid);
        assertEq(ledger.totalReleased(), 3000e6);
        assertEq(ledger.getTranches()[0].status, ITrancheLedger.TrancheStatus.Released);
        assertEq(registry.statusOf(needId), INeedsRegistry.NeedStatus.InDelivery);
    }

    function test_settlement_rejectsInvalidPayouts() public {
        _attestFundingRecorded(bankPartner, needId, TARGET, _ref(1), keccak256("d"));

        // not the whole tranche
        _attestExpectingRevert(
            settlementSchema,
            bankPartner,
            abi.encode(needId, 0, 2999e6, 0, 2999e6, SUPPLIER_REF, FX_REF),
            Errors.AmountMismatch.selector
        );

        // a locked tranche
        _attestExpectingRevert(
            settlementSchema,
            bankPartner,
            abi.encode(needId, 1, 4000e6, 0, 4000e6, SUPPLIER_REF, FX_REF),
            Errors.InvalidTrancheStatus.selector
        );

        // the NGO cannot declare that the provider paid it
        _attestExpectingRevert(
            settlementSchema,
            ngo,
            abi.encode(needId, 0, 3000e6, 0, 3000e6, SUPPLIER_REF, FX_REF),
            Errors.Unauthorized.selector
        );

        // nor can another provider, even a registered one (review finding F1)
        address otherProvider = makeAddr("otherProvider");
        vm.prank(admin);
        roles.registerBankPartner(otherProvider);
        _attestExpectingRevert(
            settlementSchema,
            otherProvider,
            abi.encode(needId, 0, 3000e6, 0, 3000e6, SUPPLIER_REF, FX_REF),
            Errors.Unauthorized.selector
        );

        // and nothing is paid to a suspended NGO
        vm.prank(admin);
        roles.setNgoActive(ngo, false);
        _attestExpectingRevert(
            settlementSchema,
            bankPartner,
            abi.encode(needId, 0, 3000e6, 0, 3000e6, SUPPLIER_REF, FX_REF),
            Errors.NgoInactive.selector
        );
    }

    // ─── full Model A lifecycle ────────────────────────────────────────────────

    function test_fullLifecycleWithoutCustody() public {
        _attestFundingRecorded(bankPartner, needId, 7000e6, 100e6, _ref(1), keccak256("d1"));
        _attestFundingRecorded(bankPartner, needId, 3000e6, 0, _ref(2), keccak256("d2"));
        _settle(0);

        uint256 lastDelivery;
        for (uint256 index = 1; index < 3; ++index) {
            lastDelivery = _runDelivery(needId, index, 10);
            assertEq(ledger.getTranches()[index].status, ITrancheLedger.TrancheStatus.Releasable);
            _settle(index);
        }

        assertEq(registry.statusOf(needId), INeedsRegistry.NeedStatus.Completed);
        assertEq(ledger.totalReleased(), TARGET);
        assertEq(deliveryManager.getDelivery(lastDelivery).status, IDeliveryManager.DeliveryStatus.Finalized);

        bytes32 reportUID = _attestImpactReport(ngo, needId, 60);
        assertEq(resolver.activeReportOf(needId), reportUID);
        assertEq(token.balanceOf(address(ledger)), 0, "no custody at any point");
    }

    function test_expiryAfterExecutionDeadlineWaitsForAnEarnedTranche() public {
        INeedsRegistry.CreateNeedParams memory p = _needParams(programId, TARGET, 1, _threeTrancheBps());
        _asOffChain(p, bankPartner);
        p.executionDeadline = uint64(block.timestamp + 60 days);
        uint256 dueNeed = _verifiedNeedWith(p);
        NonCustodialLedger dueLedger = NonCustodialLedger(registry.vaultOf(dueNeed));
        _attestFundingRecorded(bankPartner, dueNeed, TARGET, _ref(1), keccak256("d"));
        _attestSettlement(bankPartner, dueNeed, 0, 3000e6, 0);
        _runDelivery(dueNeed, 1, 10);

        vm.warp(block.timestamp + 60 days);
        vm.expectRevert(Errors.ReleasePending.selector);
        registry.expire(dueNeed);

        _attestSettlement(bankPartner, dueNeed, 1, 4000e6, 0);
        registry.expire(dueNeed);
        assertEq(registry.statusOf(dueNeed), INeedsRegistry.NeedStatus.Expired);
        assertEq(dueLedger.totalReleased(), 7000e6);
    }
}
