// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AidVault} from "../../src/funds/AidVault.sol";
import {AidVaultFactory} from "../../src/funds/AidVaultFactory.sol";
import {IAidVaultFactory} from "../../src/interfaces/IAidVaultFactory.sol";
import {IRoleRegistry} from "../../src/interfaces/IRoleRegistry.sol";
import {Errors} from "../../src/libraries/Errors.sol";
import {PoATest} from "../utils/PoATest.sol";

contract AidVaultFactoryTest is PoATest {
    function test_constructor_revertsOnZeroImplementation() public {
        vm.expectRevert(Errors.ZeroAddress.selector);
        new AidVaultFactory(roles, address(0));
    }

    function test_constructor_revertsOnZeroRoles() public {
        vm.expectRevert(Errors.ZeroAddress.selector);
        new AidVaultFactory(IRoleRegistry(address(0)), address(new AidVault()));
    }

    function test_wire() public {
        AidVaultFactory fresh = new AidVaultFactory(roles, address(new AidVault()));
        assertFalse(fresh.wired());

        vm.prank(outsider);
        vm.expectRevert(Errors.Unauthorized.selector);
        fresh.wire(address(registry), address(deliveryManager), address(token), address(receipt));

        vm.prank(admin);
        vm.expectRevert(Errors.ZeroAddress.selector);
        fresh.wire(address(0), address(deliveryManager), address(token), address(receipt));

        vm.prank(admin);
        vm.expectEmit(false, false, false, true, address(fresh));
        emit IAidVaultFactory.Wired(address(registry), address(deliveryManager), address(token), address(receipt));
        fresh.wire(address(registry), address(deliveryManager), address(token), address(receipt));
        assertTrue(fresh.wired());
        assertEq(address(fresh.token()), address(token));

        vm.prank(admin);
        vm.expectRevert(Errors.AlreadyWired.selector);
        fresh.wire(address(registry), address(deliveryManager), address(token), address(receipt));
    }

    function test_createVault_onlyRegistry() public {
        vm.prank(outsider);
        vm.expectRevert(Errors.Unauthorized.selector);
        factory.createVault(1);
    }

    function test_createVault_revertsForDuplicateNeed() public {
        (uint256 needId,,) = _verifiedNeed(1000e6);
        vm.prank(address(registry));
        vm.expectRevert(Errors.VaultAlreadyExists.selector);
        factory.createVault(needId);
    }

    function test_createVault_marksVaultAndEmits() public {
        (uint256 needId,, AidVault vault) = _verifiedNeed(1000e6);
        assertTrue(factory.isVault(address(vault)));
        assertEq(factory.vaultOf(needId), address(vault));
        assertFalse(factory.isVault(outsider));
        assertEq(factory.implementation(), address(sys.vaultImplementation));
    }

    function test_consumePaymentRef_onlyVault() public {
        vm.prank(outsider);
        vm.expectRevert(Errors.NotVault.selector);
        factory.consumePaymentRef(keccak256("ref"));
    }

    function test_consumePaymentRef_rejectsDuplicates() public {
        (uint256 needId,, AidVault vault) = _verifiedNeed(1000e6);
        vm.startPrank(address(vault));
        factory.consumePaymentRef(keccak256("ref"));
        vm.expectRevert(Errors.PaymentRefAlreadyUsed.selector);
        factory.consumePaymentRef(keccak256("ref"));
        vm.stopPrank();
        assertTrue(factory.paymentRefConsumed(keccak256("ref")));
        needId; // silence unused warning
    }
}
