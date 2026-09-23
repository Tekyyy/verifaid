// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {RoleRegistry} from "../src/access/RoleRegistry.sol";
import {DeploymentIO} from "./lib/DeploymentIO.sol";
import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";

/// @title RegisterNgos
/// @notice Registers extra NGO wallets (`EXTRA_NGOS`, comma-separated), each paying out to itself — the wallets
///         people bring to a testnet demo. Run it before Handover.s.sol: afterwards registering an NGO is a Safe
///         proposal that waits out the timelock (scripts/admin.mjs).
///
///      EXTRA_NGOS=0x..,0x.. forge script script/RegisterNgos.s.sol --rpc-url base_sepolia --broadcast
contract RegisterNgos is Script, DeploymentIO {
    function run() external {
        address[] memory ngos = vm.envOr("EXTRA_NGOS", ",", new address[](0));
        if (ngos.length == 0) {
            console2.log("EXTRA_NGOS is empty: nothing to register");
            return;
        }
        RoleRegistry roles = RoleRegistry(_readAddress(_readDeployment(), ".contracts.RoleRegistry"));
        uint256 key = vm.envOr("DEPLOYER_PRIVATE_KEY", uint256(0));
        if (key != 0) vm.startBroadcast(key);
        else vm.startBroadcast();
        for (uint256 i; i < ngos.length; ++i) {
            if (roles.hasRole(roles.NGO_ROLE(), ngos[i])) continue;
            roles.registerNgo(ngos[i], ngos[i], keccak256(abi.encode("demo-ngo", ngos[i])), "ipfs://demo-ngo");
            console2.log("  registered NGO", ngos[i]);
        }
        vm.stopBroadcast();
    }
}
