// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {CommonBase} from "forge-std/Base.sol";
import {stdJson} from "forge-std/StdJson.sol";

/// @title DeploymentIO
/// @notice Reads and writes `deployments/<network>.json`, the file every off-chain package consumes
///         (indexer, services, frontend, demo runner).
abstract contract DeploymentIO is CommonBase {
    using stdJson for string;

    function _networkName(uint256 chainId) internal pure returns (string memory) {
        if (chainId == 84_532) return "base-sepolia";
        if (chainId == 8453) return "base";
        if (chainId == 31_337) return "anvil";
        return "unknown";
    }

    function _deploymentPath() internal view returns (string memory) {
        return string.concat("../deployments/", _networkName(block.chainid), ".json");
    }

    function _readDeployment() internal view returns (string memory) {
        return vm.readFile(_deploymentPath());
    }

    function _readAddress(string memory json, string memory key) internal pure returns (address) {
        return json.readAddress(key);
    }

    function _readUint(string memory json, string memory key) internal pure returns (uint256) {
        return json.readUint(key);
    }
}
