// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {RoleRegistry} from "../src/access/RoleRegistry.sol";
import {DonationForwarderFactory} from "../src/funds/DonationForwarderFactory.sol";
import {BeneficiaryGroups} from "../src/identity/BeneficiaryGroups.sol";
import {INeedsRegistry} from "../src/interfaces/INeedsRegistry.sol";
import {MockEURC} from "../src/mocks/MockEURC.sol";
import {MockUSDC} from "../src/mocks/MockUSDC.sol";
import {NeedsRegistry} from "../src/needs/NeedsRegistry.sol";
import {DeploymentIO} from "./lib/DeploymentIO.sol";
import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";

/// @title SeedDemo
/// @notice Registers the demo NGO, verifiers, payment provider and field agent, enrols the demo beneficiary
///         commitments and creates three needs that between them show every term a need can carry:
///         - FOOD: on-chain custody, deadlines, partial execution above 60%, a disclosed 1.5% cost cap;
///         - SHELTER: above the high-value threshold (two verifiers), all or nothing, no intermediary costs;
///         - CASH: off-chain custody through the payment provider (Model A), with a 2.5% cost cap.
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
        address foodSupplier;
        address shelterSupplier;
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
        if (!roles.isActiveSupplier(a.foodSupplier)) {
            roles.registerSupplier(
                a.foodSupplier, keccak256("demo-supplier-food-wholesaler-ES-B12345678"), "ipfs://demo-supplier-food"
            );
        }
        if (!roles.isActiveSupplier(a.shelterSupplier)) {
            roles.registerSupplier(
                a.shelterSupplier, keccak256("demo-supplier-shelter-kits-ES-B87654321"), "ipfs://demo-supplier-shelter"
            );
        }
        vm.stopBroadcast();

        // ── 2. the NGO onboards its field agent, program and beneficiaries ──
        vm.startBroadcast(a.ngoKey);
        if (roles.fieldAgentNgo(a.fieldAgent) == address(0)) roles.addFieldAgent(a.fieldAgent);

        uint256 programId = groups.createProgram(
            keccak256("demo-enrollment-policy-v1: households registered by the municipality"), "ipfs://demo-program"
        );
        groups.addMembers(programId, _demoCommitments());

        // ── 3. three needs covering both custody models and every funding rule ──
        INeedsRegistry.CreateNeedParams memory food =
            _need(programId, "FOOD", 5000e6, 1, _bps(3000, 4000, 3000), INeedsRegistry.CustodyMode.OnChain, 6000, 150);
        food.payees = _plan(a.foodSupplier, "Mercados del Centro SL: food kits", 3, 1000);
        uint256 foodNeed = registry.createNeed(food);
        INeedsRegistry.CreateNeedParams memory shelter = _need(
            programId,
            "SHELTER",
            highValueThreshold + 2000e6, // above the threshold → two verifiers required
            2,
            _bps(5000, 5000, 0),
            INeedsRegistry.CustodyMode.OnChain,
            10_000,
            0
        );
        shelter.payees = _plan(a.shelterSupplier, "Refugio Kits SA: shelter kits", 2, 0);
        uint256 shelterNeed = registry.createNeed(shelter);
        INeedsRegistry.CreateNeedParams memory cash =
            _need(programId, "CASH", 3000e6, 1, _bps(4000, 6000, 0), INeedsRegistry.CustodyMode.OffChain, 5000, 250);
        cash.custodian = a.bankPartner; // the payment provider that will hold the money
        uint256 cashNeed = registry.createNeed(cash);
        vm.stopBroadcast();

        _mintDemoTokens(token, a);
        _mintDemoAltStable(deployment, a);
        _registerKeeper(deployment, a);

        console2.log("");
        console2.log("Demo data seeded");
        console2.log("  NGO            ", a.ngo);
        console2.log("  payout Safe    ", a.ngoPayout);
        console2.log("  field agent    ", a.fieldAgent);
        console2.log("  verifiers      ", a.verifier1, a.verifier2);
        console2.log("  bank partner   ", a.bankPartner);
        console2.log("  suppliers      ", a.foodSupplier, a.shelterSupplier);
        console2.log("  donors         ", a.donor1, a.donor2);
        console2.log("  program        ", programId);
        console2.log("  need FOOD      ", foodNeed, "target 5000 (1 verification)");
        console2.log("  need SHELTER   ", shelterNeed, "above threshold (2 verifications), all or nothing");
        console2.log("  need CASH      ", cashNeed, "target 3000, off-chain custody (Model A)");
    }

    // ─── helpers ───────────────────────────────────────────────────────────────

    function _actors() internal view returns (Actors memory a) {
        string memory mnemonic = vm.envOr("DEMO_MNEMONIC", DEFAULT_MNEMONIC);
        // Present but empty (how deploy-local forces the public anvil wallets) means the default too.
        if (bytes(mnemonic).length == 0) mnemonic = DEFAULT_MNEMONIC;
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
        // Suppliers never send a transaction in the demo (the vaults pay them), so they need no gas.
        a.foodSupplier = vm.addr(vm.deriveKey(mnemonic, 10));
        a.shelterSupplier = vm.addr(vm.deriveKey(mnemonic, 11));
    }

    /// @dev Tops up the role wallets that will have to send their own transactions during the demo — including
    ///      the relayer, which submits every beneficiary confirmation so their wallets never appear on-chain.
    function _fundGas(Actors memory a) internal {
        address[7] memory needsGas = [a.ngo, a.fieldAgent, a.verifier1, a.verifier2, a.bankPartner, a.donor1, a.relayer];
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

    /// @dev Mints the vault's own currency to the donors and the bank partner, when it is a mintable mock.
    function _mintDemoTokens(address token, Actors memory a) internal {
        vm.startBroadcast(a.adminKey);
        try MockEURC(token).mint(a.donor1, 50_000e6) {
            MockEURC(token).mint(a.donor2, 50_000e6);
            MockEURC(token).mint(a.bankPartner, 50_000e6);
            console2.log("  minted the vault currency to the donors and the bank partner");
        } catch {
            console2.log("  token is not mintable, fund the donors from a faucet:", token);
        }
        vm.stopBroadcast();
    }

    /// @dev v3: the relayer sweeps deposit addresses for donors whose refund address cannot send a transaction (an
    ///      exchange). Sweeping is limited to keepers so nobody can sandwich a sweep inside one transaction.
    function _registerKeeper(string memory deployment, Actors memory a) internal {
        if (!vm.keyExistsJson(deployment, ".contracts.DonationForwarderFactory")) return;
        DonationForwarderFactory factory =
            DonationForwarderFactory(_readAddress(deployment, ".contracts.DonationForwarderFactory"));
        if (factory.isKeeper(a.relayer)) return;
        vm.startBroadcast(a.adminKey);
        factory.setKeeper(a.relayer, true);
        vm.stopBroadcast();
        console2.log("  relayer registered as deposit-address keeper", a.relayer);
    }

    /// @dev v3/v4: donors also hold the deployment's other stablecoin (mock EURC), so the demo can show a donation
    ///      that has to be converted into the vault's currency. Skipped when there is none, or it is not mintable.
    function _mintDemoAltStable(string memory deployment, Actors memory a) internal {
        if (!vm.keyExistsJson(deployment, ".external.EURC")) return;
        address eurc = _readAddress(deployment, ".external.EURC");
        if (eurc == address(0) || eurc == _readAddress(deployment, ".external.Token")) return;
        vm.startBroadcast(a.adminKey);
        try MockUSDC(eurc).mint(a.donor1, 50_000e6) {
            MockUSDC(eurc).mint(a.donor2, 50_000e6);
            console2.log("  minted demo mEURC to donors, to convert");
        } catch {
            console2.log("  the other stablecoin is not mintable, skipping:", eurc);
        }
        vm.stopBroadcast();
    }

    /// @dev Demo needs: funding open 30 days, delivery due within 120 days.
    function _need(
        uint256 programId,
        string memory category,
        uint256 target,
        uint8 verificationsRequired,
        uint16[] memory trancheBps,
        INeedsRegistry.CustodyMode custodyMode,
        uint16 minFundingBps,
        uint16 thirdPartyCostBps
    ) internal view returns (INeedsRegistry.CreateNeedParams memory) {
        string memory slug = vm.toLowercase(category);
        return INeedsRegistry.CreateNeedParams({
            programId: programId,
            category: keccak256(bytes(category)),
            targetAmount: target,
            regionCode: bytes32("ES-CM"),
            dossierHash: keccak256(bytes(string.concat("demo-dossier-", slug, "-2026-09"))),
            metadataURI: string.concat("ipfs://demo-need-", slug),
            verificationsRequired: verificationsRequired,
            trancheBps: trancheBps,
            custodyMode: custodyMode,
            custodian: address(0),
            fundingDeadline: uint64(block.timestamp + 30 days),
            executionDeadline: uint64(block.timestamp + 120 days),
            minFundingBps: minFundingBps,
            thirdPartyCostBps: thirdPartyCostBps,
            expectedOutcomeHash: keccak256(bytes(string.concat("demo-outcome-", slug))),
            costDisclosureHash: thirdPartyCostBps == 0
                ? bytes32(0)
                : keccak256(bytes(string.concat("demo-cost-disclosure-", slug))),
            payees: new INeedsRegistry.Payee[](0)
        });
    }

    /// @dev The vault pays `supplier` directly; the NGO keeps `ngoBps` of each tranche for its own costs.
    function _plan(address supplier, string memory label, uint256 tranches, uint16 ngoBps)
        internal
        pure
        returns (INeedsRegistry.Payee[] memory plan)
    {
        plan = new INeedsRegistry.Payee[](ngoBps == 0 ? 1 : 2);
        uint16[] memory supplierShares = new uint16[](tranches);
        uint16[] memory ngoShares = new uint16[](tranches);
        for (uint256 i; i < tranches; ++i) {
            supplierShares[i] = 10_000 - ngoBps;
            ngoShares[i] = ngoBps;
        }
        plan[0] = INeedsRegistry.Payee({
            account: supplier,
            shareBps: supplierShares,
            refHash: keccak256(bytes(string.concat("demo-contract-", label))),
            label: label
        });
        if (ngoBps != 0) {
            plan[1] = INeedsRegistry.Payee({
                account: address(0),
                shareBps: ngoShares,
                refHash: keccak256("demo-ngo-operations-budget"),
                label: "NGO operations: transport and distribution staff"
            });
        }
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
