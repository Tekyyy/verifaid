// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AidVault} from "../../src/funds/AidVault.sol";
import {AidVaultFactory} from "../../src/funds/AidVaultFactory.sol";
import {IAidVaultFactory} from "../../src/interfaces/IAidVaultFactory.sol";
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
        assertFalse(fresh.wired());

        vm.prank(outsider);
        vm.expectRevert(Errors.Unauthorized.selector);
        fresh.wire(address(registry), address(token), vaultImpl);

        vm.startPrank(admin);
        vm.expectRevert(Errors.ZeroAddress.selector);
        fresh.wire(address(0), address(token), vaultImpl);
        vm.expectRevert(Errors.ZeroAddress.selector);
        fresh.wire(address(registry), address(token), address(0));

        vm.expectEmit(false, false, false, true, address(fresh));
        emit IAidVaultFactory.Wired(address(registry), address(token), vaultImpl);
        fresh.wire(address(registry), address(token), vaultImpl);
        assertTrue(fresh.wired());
        assertEq(address(fresh.token()), address(token));
        assertEq(fresh.implementation(), vaultImpl);

        vm.expectRevert(Errors.AlreadyWired.selector);
        fresh.wire(address(registry), address(token), vaultImpl);
        vm.stopPrank();
    }

    function test_createVault_onlyRegistry() public {
        vm.prank(outsider);
        vm.expectRevert(Errors.Unauthorized.selector);
        factory.createVault(1);
    }

    /// @dev Every verified need gets an AidVault: there is no other kind of ledger since money only arrives on chain.
    function test_createVault_everyNeedGetsAVault() public {
        (uint256 needId,, AidVault vault) = _verifiedNeed(1000e6);
        assertTrue(factory.isVault(address(vault)), "the vault may mint receipts");
        assertEq(vault.needId(), needId);
        assertFalse(factory.isVault(outsider));
        assertEq(factory.implementation(), address(sys.vaultImplementation));
    }

    function test_createVault_emits() public {
        vm.prank(address(registry));
        vm.expectEmit(true, false, false, false, address(factory));
        emit IAidVaultFactory.VaultCreated(42, address(0));
        address vault = factory.createVault(42);
        assertEq(AidVault(vault).needId(), 42);
        assertTrue(factory.isVault(vault));
    }
}
