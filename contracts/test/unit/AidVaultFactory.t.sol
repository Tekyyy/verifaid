// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AidVault} from "../../src/funds/AidVault.sol";
import {AidVaultFactory} from "../../src/funds/AidVaultFactory.sol";
import {NonCustodialLedger} from "../../src/funds/NonCustodialLedger.sol";
import {IAidVaultFactory} from "../../src/interfaces/IAidVaultFactory.sol";
import {INeedsRegistry} from "../../src/interfaces/INeedsRegistry.sol";
import {IRoleRegistry} from "../../src/interfaces/IRoleRegistry.sol";
import {Errors} from "../../src/libraries/Errors.sol";
import {PoATest} from "../utils/PoATest.sol";

contract AidVaultFactoryTest is PoATest {
    function test_constructor_revertsOnZeroRoles() public {
        vm.expectRevert(Errors.ZeroAddress.selector);
        new AidVaultFactory(IRoleRegistry(address(0)));
    }

    function test_wire() public {
        AidVaultFactory fresh = new AidVaultFactory(roles);
        address vaultImpl = address(sys.vaultImplementation);
        address ledgerImpl = address(sys.ledgerImplementation);
        assertFalse(fresh.wired());

        vm.prank(outsider);
        vm.expectRevert(Errors.Unauthorized.selector);
        fresh.wire(address(registry), address(token), vaultImpl, ledgerImpl);

        vm.startPrank(admin);
        vm.expectRevert(Errors.ZeroAddress.selector);
        fresh.wire(address(0), address(token), vaultImpl, ledgerImpl);
        vm.expectRevert(Errors.ZeroAddress.selector);
        fresh.wire(address(registry), address(token), vaultImpl, address(0));

        vm.expectEmit(false, false, false, true, address(fresh));
        emit IAidVaultFactory.Wired(address(registry), address(token), vaultImpl, ledgerImpl);
        fresh.wire(address(registry), address(token), vaultImpl, ledgerImpl);
        assertTrue(fresh.wired());
        assertEq(address(fresh.token()), address(token));
        assertEq(fresh.implementation(), vaultImpl);
        assertEq(fresh.ledgerImplementation(), ledgerImpl);

        vm.expectRevert(Errors.AlreadyWired.selector);
        fresh.wire(address(registry), address(token), vaultImpl, ledgerImpl);
        vm.stopPrank();
    }

    function test_createVault_onlyRegistry() public {
        vm.prank(outsider);
        vm.expectRevert(Errors.Unauthorized.selector);
        factory.createVault(1, INeedsRegistry.CustodyMode.OnChain);
    }

    function test_createVault_onChainCustodyGetsAVault() public {
        (uint256 needId,, AidVault vault) = _verifiedNeed(1000e6);
        assertTrue(factory.isVault(address(vault)));
        assertTrue(factory.isLedger(address(vault)));
        assertEq(uint8(factory.kindOf(address(vault))), uint8(AidVaultFactory.Kind.Vault));
        assertEq(vault.needId(), needId);
        assertFalse(factory.isVault(outsider));
        assertFalse(factory.isLedger(outsider));
        assertEq(factory.implementation(), address(sys.vaultImplementation));
    }

    function test_createVault_offChainCustodyGetsALedgerThatCannotMintReceipts() public {
        (uint256 needId,, NonCustodialLedger ledger) = _verifiedOffChainNeed(1000e6, 0);
        assertFalse(factory.isVault(address(ledger)), "only custodial vaults may mint receipts");
        assertTrue(factory.isLedger(address(ledger)));
        assertEq(ledger.needId(), needId);
        assertEq(ledger.resolver(), address(resolver));
        assertEq(factory.ledgerImplementation(), address(sys.ledgerImplementation));
    }

    function test_createVault_emits() public {
        vm.prank(address(registry));
        vm.expectEmit(true, false, false, false, address(factory));
        emit IAidVaultFactory.VaultCreated(42, address(0), INeedsRegistry.CustodyMode.OffChain);
        address ledger = factory.createVault(42, INeedsRegistry.CustodyMode.OffChain);
        assertEq(NonCustodialLedger(ledger).needId(), 42);
    }

    function test_consumePaymentRef_onlyLedgers() public {
        vm.prank(outsider);
        vm.expectRevert(Errors.NotLedger.selector);
        factory.consumePaymentRef(bankPartner, keccak256("ref"));
    }

    function test_consumePaymentRef_rejectsDuplicatesAcrossCustodyModes() public {
        (,, AidVault vault) = _verifiedNeed(1000e6);
        (,, NonCustodialLedger ledger) = _verifiedOffChainNeed(1000e6, 0);

        vm.prank(address(vault));
        factory.consumePaymentRef(bankPartner, keccak256("ref"));
        vm.prank(address(ledger));
        vm.expectRevert(Errors.PaymentRefAlreadyUsed.selector);
        factory.consumePaymentRef(bankPartner, keccak256("ref"));
        assertTrue(factory.isPaymentRefConsumed(bankPartner, keccak256("ref")));
    }

    /// @dev Review finding F7: references are scoped per provider, so one provider can neither collide with nor
    ///      squat another provider's reference (bank end-to-end ids are only unique within the issuing bank).
    function test_consumePaymentRef_isScopedToTheProvider() public {
        (,, AidVault vault) = _verifiedNeed(1000e6);
        address otherProvider = makeAddr("otherProvider");

        vm.startPrank(address(vault));
        factory.consumePaymentRef(otherProvider, keccak256("e2e-42"));
        factory.consumePaymentRef(bankPartner, keccak256("e2e-42"));
        vm.stopPrank();
        assertTrue(factory.isPaymentRefConsumed(otherProvider, keccak256("e2e-42")));
        assertTrue(factory.isPaymentRefConsumed(bankPartner, keccak256("e2e-42")));
        assertFalse(factory.isPaymentRefConsumed(outsider, keccak256("e2e-42")));
    }
}
