// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {RoleRegistry} from "../src/access/RoleRegistry.sol";
import {DonationForwarderFactory} from "../src/funds/DonationForwarderFactory.sol";
import {DeploymentIO} from "./lib/DeploymentIO.sol";
import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";

/// @title RegisterRoles
/// @notice Registers what a launch needs besides its NGOs, each list comma-separated: the verifiers
///         (`EXTRA_VERIFIERS`), the suppliers (`EXTRA_SUPPLIERS`) and the keepers that may sweep deposit addresses
///         (`KEEPERS`, typically the app's relayer). Like RegisterNgos, run it before Handover.s.sol: afterwards each
///         of these is a Safe proposal that waits out the timelock, and without a verifier no need could take money
///         until the first one executed.
///
///      EXTRA_VERIFIERS=0x.. KEEPERS=0x.. forge script script/RegisterRoles.s.sol --rpc-url base --broadcast
contract RegisterRoles is Script, DeploymentIO {
    function run() external {
        address[] memory verifiers = vm.envOr("EXTRA_VERIFIERS", ",", new address[](0));
        address[] memory suppliers = vm.envOr("EXTRA_SUPPLIERS", ",", new address[](0));
        address[] memory keepers = vm.envOr("KEEPERS", ",", new address[](0));
        if (verifiers.length + suppliers.length + keepers.length == 0) {
            console2.log("EXTRA_VERIFIERS, EXTRA_SUPPLIERS and KEEPERS are empty: nothing to register");
            return;
        }
        string memory deployment = _readDeployment();
        RoleRegistry roles = RoleRegistry(_readAddress(deployment, ".contracts.RoleRegistry"));
        DonationForwarderFactory factory =
            DonationForwarderFactory(_readAddress(deployment, ".contracts.DonationForwarderFactory"));

        uint256 key = vm.envOr("DEPLOYER_PRIVATE_KEY", uint256(0));
        if (key != 0) vm.startBroadcast(key);
        else vm.startBroadcast();
        for (uint256 i; i < verifiers.length; ++i) {
            if (roles.hasRole(roles.VERIFIER_ROLE(), verifiers[i])) continue;
            roles.registerVerifier(verifiers[i]);
            console2.log("  registered verifier", verifiers[i]);
        }
        for (uint256 i; i < suppliers.length; ++i) {
            if (roles.hasRole(roles.SUPPLIER_ROLE(), suppliers[i])) continue;
            roles.registerSupplier(suppliers[i], keccak256(abi.encode("supplier", suppliers[i])), "ipfs://supplier");
            console2.log("  registered supplier", suppliers[i]);
        }
        for (uint256 i; i < keepers.length; ++i) {
            if (factory.isKeeper(keepers[i])) continue;
            factory.setKeeper(keepers[i], true);
            console2.log("  keeper", keepers[i]);
        }
        vm.stopBroadcast();
    }
}
