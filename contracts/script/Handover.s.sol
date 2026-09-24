// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {RoleRegistry} from "../src/access/RoleRegistry.sol";
import {DeploymentIO} from "./lib/DeploymentIO.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";

interface ISafe {
    function getThreshold() external view returns (uint256);
}

interface ISafeProxyFactory {
    function createProxyWithNonce(address singleton, bytes memory initializer, uint256 saltNonce)
        external
        returns (address proxy);
}

/// @title Handover
/// @notice Takes the admin role away from the deployer, the last step of a deployment. After it:
///         - every admin action is proposed by a Safe multisig (`ADMIN_SAFE_THRESHOLD` of `ADMIN_SAFE_OWNERS`),
///         - and waits out a public `ADMIN_TIMELOCK_DELAY` in a TimelockController before anyone may execute it,
///           so a registration nobody expected can be seen, and cancelled by the Safe, before it takes effect;
///         - the guardian (`GUARDIAN_ADDRESS`, the deployer by default) can pause at once, and do nothing else.
/// @dev Run after Deploy, RegisterSchemas and SeedDemo, which need the deployer to be the admin. Creates the Safe
///      from the canonical Safe v1.4.1 factory, or uses `ADMIN_SAFE_ADDRESS` where one exists already (and on a
///      local chain, where Safe is not deployed). scripts/admin.mjs drives the timelock afterwards.
///
///      ADMIN_SAFE_OWNERS=0x..,0x..,0x.. forge script script/Handover.s.sol --rpc-url base_sepolia --broadcast
contract Handover is Script, DeploymentIO {
    /// @dev Safe v1.4.1, deployed at the same addresses on every chain Safe supports.
    address internal constant SAFE_PROXY_FACTORY = 0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67;
    address internal constant SAFE_L2_SINGLETON = 0x29fcB43b46531BcA003ddC8FCB67FFE91900C762;
    address internal constant SAFE_FALLBACK_HANDLER = 0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99;

    function run() external {
        uint256 deployerKey = vm.envOr("DEPLOYER_PRIVATE_KEY", uint256(0));
        address deployer = deployerKey != 0 ? vm.addr(deployerKey) : msg.sender;
        string memory deployment = _readDeployment();
        RoleRegistry roles = RoleRegistry(_readAddress(deployment, ".contracts.RoleRegistry"));
        require(roles.isAdmin(deployer), "Handover: the deployer is not the admin (already handed over?)");

        uint256 delay = vm.envOr("ADMIN_TIMELOCK_DELAY", uint256(2 days));
        address guardian = vm.envOr("GUARDIAN_ADDRESS", deployer);
        address safe = vm.envOr("ADMIN_SAFE_ADDRESS", address(0));
        uint256 threshold;

        if (deployerKey != 0) vm.startBroadcast(deployerKey);
        else vm.startBroadcast();

        if (safe == address(0)) {
            require(SAFE_PROXY_FACTORY.code.length != 0, "Handover: no Safe on this chain; pass ADMIN_SAFE_ADDRESS");
            address[] memory owners = vm.envAddress("ADMIN_SAFE_OWNERS", ",");
            threshold = vm.envOr("ADMIN_SAFE_THRESHOLD", uint256(2));
            require(threshold >= 1 && threshold <= owners.length, "Handover: bad Safe threshold");
            safe = _createSafe(owners, threshold);
        } else {
            // An existing Safe keeps its own threshold; an account standing in for one (a local chain) is one key.
            threshold = safe.code.length == 0 ? 1 : ISafe(safe).getThreshold();
        }

        address[] memory proposers = new address[](1);
        proposers[0] = safe;
        // Anyone may execute an operation once its delay is over: the signatures and the wait are the protection,
        // and an executor role would only add one more key that could stall a decision the Safe already took.
        address[] memory executors = new address[](1);
        executors[0] = address(0);
        TimelockController timelock = new TimelockController(delay, proposers, executors, address(0));

        roles.grantRole(roles.GUARDIAN_ROLE(), guardian);
        roles.grantRole(roles.DEFAULT_ADMIN_ROLE(), address(timelock));
        roles.renounceRole(roles.DEFAULT_ADMIN_ROLE(), deployer);

        vm.stopBroadcast();

        string memory path = _deploymentPath();
        vm.writeJson(vm.toString(address(timelock)), path, ".admin");
        vm.writeJson(vm.toString(safe), path, ".governance.Safe");
        vm.writeJson(vm.toString(address(timelock)), path, ".governance.Timelock");
        vm.writeJson(vm.toString(guardian), path, ".governance.Guardian");
        vm.writeJson(vm.toString(threshold), path, ".governance.threshold");
        vm.writeJson(vm.toString(delay), path, ".governance.delay");

        console2.log("Admin handed over");
        console2.log("  Safe (proposer)  ", safe, threshold);
        console2.log("  Timelock (admin) ", address(timelock), delay);
        console2.log("  Guardian (pause) ", guardian);
    }

    function _createSafe(address[] memory owners, uint256 threshold) internal returns (address) {
        bytes memory setup = abi.encodeWithSignature(
            "setup(address[],uint256,address,bytes,address,address,uint256,address)",
            owners,
            threshold,
            address(0),
            "",
            SAFE_FALLBACK_HANDLER,
            address(0),
            0,
            address(0)
        );
        return ISafeProxyFactory(SAFE_PROXY_FACTORY).createProxyWithNonce(SAFE_L2_SINGLETON, setup, block.timestamp);
    }
}
