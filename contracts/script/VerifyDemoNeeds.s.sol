// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {INeedsRegistry} from "../src/interfaces/INeedsRegistry.sol";
import {DeploymentIO} from "./lib/DeploymentIO.sol";
import {
    AttestationRequest,
    AttestationRequestData,
    IEAS
} from "@ethereum-attestation-service/eas-contracts/contracts/IEAS.sol";
import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";

/// @notice Opens funding on the needs SeedDemo registered. Registering a need only records it; until an
///         independent verifier attests the dossier it takes no money — which is exactly what a freshly seeded
///         dashboard showed: three needs, none accepting donations. The first demo verifier signs each Pending
///         need, and the second follows where the need asks for two.
/// @dev Idempotent and re-runnable on its own: `pnpm deploy:sepolia verify`. Only needs owned by the demo NGO
///      are touched, and only while they are still Pending.
contract VerifyDemoNeeds is Script, DeploymentIO {
    string internal constant DEFAULT_MNEMONIC = "test test test test test test test test test test test junk";
    bytes32 internal constant REPORT_HASH = keccak256("verifier-report");

    function run() external {
        string memory deployment = _readDeployment();
        INeedsRegistry registry = INeedsRegistry(_readAddress(deployment, ".contracts.NeedsRegistry"));
        IEAS eas = IEAS(_readAddress(deployment, ".external.EAS"));
        bytes32 schema = vm.parseJsonBytes32(deployment, ".schemas.NeedVerified");

        string memory mnemonic = vm.envOr("DEMO_MNEMONIC", DEFAULT_MNEMONIC);
        if (bytes(mnemonic).length == 0) mnemonic = DEFAULT_MNEMONIC;
        address ngo = vm.addr(vm.deriveKey(mnemonic, 1));
        uint256 verifier1Key = vm.deriveKey(mnemonic, 4);
        uint256 verifier2Key = vm.deriveKey(mnemonic, 5);

        uint256 count = registry.needCount();
        uint256 opened;
        for (uint256 id = 1; id <= count; ++id) {
            if (registry.ngoOf(id) != ngo) continue;
            if (registry.statusOf(id) != INeedsRegistry.NeedStatus.Pending) continue;

            bytes32 dossierHash = registry.dossierHashOf(id);
            _attest(eas, schema, address(registry), verifier1Key, id, dossierHash);
            // Above the high-value threshold the need asks for two signatures; the first leaves it Pending.
            if (registry.statusOf(id) == INeedsRegistry.NeedStatus.Pending) {
                _attest(eas, schema, address(registry), verifier2Key, id, dossierHash);
            }
            console2.log("  need", id, "verified: funding is open");
            ++opened;
        }
        if (opened == 0) console2.log("  nothing to verify: no demo need is Pending");
    }

    function _attest(IEAS eas, bytes32 schema, address registry, uint256 key, uint256 needId, bytes32 dossierHash)
        internal
    {
        vm.startBroadcast(key);
        eas.attest(
            AttestationRequest({
                schema: schema,
                data: AttestationRequestData({
                    recipient: registry,
                    expirationTime: 0,
                    revocable: true,
                    refUID: bytes32(0),
                    data: abi.encode(needId, dossierHash, true, REPORT_HASH),
                    value: 0
                })
            })
        );
        vm.stopBroadcast();
    }
}
