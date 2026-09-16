// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {RoleRegistry} from "../src/access/RoleRegistry.sol";
import {BeneficiaryGroups} from "../src/identity/BeneficiaryGroups.sol";
import {INeedsRegistry} from "../src/interfaces/INeedsRegistry.sol";
import {MockEURC} from "../src/mocks/MockEURC.sol";
import {NeedsRegistry} from "../src/needs/NeedsRegistry.sol";
import {DeploymentIO} from "./lib/DeploymentIO.sol";
import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";

/// @title SeedDemo
/// @notice Registers the demo NGO, verifiers, bank partner and field agent, enrols the demo beneficiary
///         commitments and creates two needs — one below and one above the high-value threshold, so the demo
///         shows both single and M-of-N verification.
/// @dev Role wallets are derived from DEMO_MNEMONIC (the anvil default when unset) and topped up from the
///      deployer on networks where they have no gas. Beneficiary commitments come from
///      script/fixtures/demo-identities.json, generated from a public seed.
///
///      forge script script/SeedDemo.s.sol --rpc-url base_sepolia --broadcast
contract SeedDemo is Script, DeploymentIO {
    string internal constant DEFAULT_MNEMONIC = "test test test test test test test test test test test junk";

    /// @dev Enough for hundreds of transactions on Base Sepolia, where the whole 27M-gas deployment costs about
    ///      0.0003 ETH. Funding six role wallets must stay well inside what one faucet drip provides.
    uint256 internal constant GAS_TOPUP = 0.0005 ether;

    struct Actors {
        uint256 adminKey;
        address admin;
        uint256 ngoKey;
        address ngo;
        address ngoPayout;
        uint256 fieldAgentKey;
        address fieldAgent;
        address verifier1;
        address verifier2;
        address bankPartner;
        address donor1;
        address donor2;
        address relayer;
    }

    function run() external {
        string memory deployment = _readDeployment();
        RoleRegistry roles = RoleRegistry(_readAddress(deployment, ".contracts.RoleRegistry"));
        NeedsRegistry registry = NeedsRegistry(_readAddress(deployment, ".contracts.NeedsRegistry"));
        BeneficiaryGroups groups = BeneficiaryGroups(_readAddress(deployment, ".contracts.BeneficiaryGroups"));
        address token = _readAddress(deployment, ".external.Token");
        uint256 highValueThreshold = _readUint(deployment, ".params.highValueThreshold");

        Actors memory a = _actors();
        _fundGas(a);

        // ── 1. platform admin registers the organizations ──
        vm.startBroadcast(a.adminKey);
        if (!roles.hasRole(roles.NGO_ROLE(), a.ngo)) {
            roles.registerNgo(a.ngo, a.ngoPayout, keccak256("demo-ngo-charity-number-ES-123456"), "ipfs://demo-ngo");
        }
        if (!roles.hasRole(roles.VERIFIER_ROLE(), a.verifier1)) roles.registerVerifier(a.verifier1);
        if (!roles.hasRole(roles.VERIFIER_ROLE(), a.verifier2)) roles.registerVerifier(a.verifier2);
        if (!roles.hasRole(roles.BANK_PARTNER_ROLE(), a.bankPartner)) roles.registerBankPartner(a.bankPartner);
        vm.stopBroadcast();

        // ── 2. the NGO onboards its field agent, program and beneficiaries ──
        vm.startBroadcast(a.ngoKey);
        if (roles.fieldAgentNgo(a.fieldAgent) == address(0)) roles.addFieldAgent(a.fieldAgent);

        uint256 programId = groups.createProgram(
            keccak256("demo-enrollment-policy-v1: households registered by the municipality"), "ipfs://demo-program"
        );
        groups.addMembers(programId, _demoCommitments());

        // ── 3. two needs: one single-verifier, one that needs M-of-N ──
        uint256 foodNeed = registry.createNeed(
            INeedsRegistry.CreateNeedParams({
                programId: programId,
                category: keccak256("FOOD"),
                targetAmount: 5000e6,
                regionCode: bytes32("ES-CM"),
                dossierHash: keccak256("demo-dossier-food-2026-09"),
                metadataURI: "ipfs://demo-need-food",
                verificationsRequired: 1,
                trancheBps: _bps(3000, 4000, 3000)
            })
        );

        uint256 shelterNeed = registry.createNeed(
            INeedsRegistry.CreateNeedParams({
                programId: programId,
                category: keccak256("SHELTER"),
                targetAmount: highValueThreshold + 2000e6, // above the threshold → two verifiers required
                regionCode: bytes32("ES-CM"),
                dossierHash: keccak256("demo-dossier-shelter-2026-09"),
                metadataURI: "ipfs://demo-need-shelter",
                verificationsRequired: 2,
                trancheBps: _bps(5000, 5000, 0)
            })
        );
        vm.stopBroadcast();

        _mintDemoTokens(token, a);

        console2.log("");
        console2.log("Demo data seeded");
        console2.log("  NGO            ", a.ngo);
        console2.log("  payout Safe    ", a.ngoPayout);
        console2.log("  field agent    ", a.fieldAgent);
        console2.log("  verifiers      ", a.verifier1, a.verifier2);
        console2.log("  bank partner   ", a.bankPartner);
        console2.log("  donors         ", a.donor1, a.donor2);
        console2.log("  program        ", programId);
        console2.log("  need FOOD      ", foodNeed, "target 5000 (1 verification)");
        console2.log("  need SHELTER   ", shelterNeed, "above threshold (2 verifications)");
    }

    // ─── helpers ───────────────────────────────────────────────────────────────

    function _actors() internal view returns (Actors memory a) {
        string memory mnemonic = vm.envOr("DEMO_MNEMONIC", DEFAULT_MNEMONIC);
        uint256 deployerKey = vm.envOr("DEPLOYER_PRIVATE_KEY", uint256(0));

        a.adminKey = deployerKey != 0 ? deployerKey : vm.deriveKey(mnemonic, 0);
        a.admin = vm.addr(a.adminKey);
        a.ngoKey = vm.deriveKey(mnemonic, 1);
        a.ngo = vm.addr(a.ngoKey);
        a.ngoPayout = vm.addr(vm.deriveKey(mnemonic, 2));
        a.fieldAgentKey = vm.deriveKey(mnemonic, 3);
        a.fieldAgent = vm.addr(a.fieldAgentKey);
        a.verifier1 = vm.addr(vm.deriveKey(mnemonic, 4));
        a.verifier2 = vm.addr(vm.deriveKey(mnemonic, 5));
        a.bankPartner = vm.addr(vm.deriveKey(mnemonic, 6));
        a.donor1 = vm.addr(vm.deriveKey(mnemonic, 7));
        a.donor2 = vm.addr(vm.deriveKey(mnemonic, 8));
        a.relayer = vm.addr(vm.deriveKey(mnemonic, 9));
    }

    /// @dev Tops up the role wallets that will have to send their own transactions during the demo — including
    ///      the relayer, which submits every beneficiary confirmation so their wallets never appear on-chain.
    function _fundGas(Actors memory a) internal {
        address[7] memory needsGas =
            [a.ngo, a.fieldAgent, a.verifier1, a.verifier2, a.bankPartner, a.donor1, a.relayer];
        uint256 budget = a.admin.balance;
        vm.startBroadcast(a.adminKey);
        for (uint256 i; i < needsGas.length; ++i) {
            if (needsGas[i].balance >= GAS_TOPUP) continue;
            uint256 missing = GAS_TOPUP - needsGas[i].balance;
            // Never spend the deployer down to nothing: it still has to send the registration transactions.
            if (budget < missing * 2) {
                console2.log("  skipping gas top-up, deployer balance is low:", needsGas[i]);
                continue;
            }
            (bool ok,) = needsGas[i].call{value: missing}("");
            require(ok, "gas top-up failed");
            budget -= missing;
        }
        vm.stopBroadcast();
    }

    /// @dev Mints demo stablecoin to the donors and the bank partner when the deployment uses MockEURC.
    function _mintDemoTokens(address token, Actors memory a) internal {
        vm.startBroadcast(a.adminKey);
        try MockEURC(token).mint(a.donor1, 50_000e6) {
            MockEURC(token).mint(a.donor2, 50_000e6);
            MockEURC(token).mint(a.bankPartner, 50_000e6);
            console2.log("  minted demo mEURC to donors and the bank partner");
        } catch {
            console2.log("  token is not mintable, fund the donors from a faucet:", token);
        }
        vm.stopBroadcast();
    }

    function _demoCommitments() internal view returns (uint256[] memory) {
        string memory json = vm.readFile("script/fixtures/demo-identities.json");
        return vm.parseJsonUintArray(json, ".commitments");
    }

    function _bps(uint16 first, uint16 second, uint16 third) internal pure returns (uint16[] memory out) {
        out = new uint16[](third == 0 ? 2 : 3);
        out[0] = first;
        out[1] = second;
        if (third != 0) out[2] = third;
    }
}
