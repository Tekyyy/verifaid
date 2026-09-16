// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {RoleRegistry} from "../../src/access/RoleRegistry.sol";
import {DeliveryManager} from "../../src/delivery/DeliveryManager.sol";
import {AidVault} from "../../src/funds/AidVault.sol";
import {AidVaultFactory} from "../../src/funds/AidVaultFactory.sol";
import {DonationReceipt} from "../../src/funds/DonationReceipt.sol";
import {NonCustodialLedger} from "../../src/funds/NonCustodialLedger.sol";
import {BeneficiaryGroups} from "../../src/identity/BeneficiaryGroups.sol";
import {IAidVaultFactory} from "../../src/interfaces/IAidVaultFactory.sol";
import {IDonationReceipt} from "../../src/interfaces/IDonationReceipt.sol";
import {INeedsRegistry} from "../../src/interfaces/INeedsRegistry.sol";
import {IRoleRegistry} from "../../src/interfaces/IRoleRegistry.sol";
import {MockEURC} from "../../src/mocks/MockEURC.sol";
import {NeedsRegistry} from "../../src/needs/NeedsRegistry.sol";
import {ProofOfAidResolver} from "../../src/resolvers/ProofOfAidResolver.sol";
import {IEAS} from "@ethereum-attestation-service/eas-contracts/contracts/IEAS.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ISemaphore} from "@semaphore-protocol/contracts/interfaces/ISemaphore.sol";
import {CommonBase} from "forge-std/Base.sol";

/// @title SystemDeployer
/// @notice Single source of truth for deploying and wiring the whole Proof of Aid system.
/// @dev Shared by `Deploy.s.sol` and the Foundry test fixtures so tests exercise the deployed topology.
///      The caller must be the admin (broadcaster or pranked account) because `wire` is admin-gated.
abstract contract SystemDeployer is CommonBase {
    /// @dev Published EAS artifacts; EAS pins solc 0.8.29 so its bytecode is deployed rather than recompiled.
    string internal constant EAS_ARTIFACT =
        "node_modules/@ethereum-attestation-service/eas-contracts/artifacts/contracts/EAS.sol/EAS.json";
    string internal constant SCHEMA_REGISTRY_ARTIFACT =
        "node_modules/@ethereum-attestation-service/eas-contracts/artifacts/contracts/SchemaRegistry.sol/SchemaRegistry.json";

    struct Params {
        address admin;
        address token; // zero → deploy MockEURC
        address eas;
        address semaphore;
        uint256 highValueThreshold;
        uint16 confirmationThresholdBps;
        uint64 challengePeriod;
        uint32 minExpectedRecipients;
        string dashboardBaseURI;
    }

    struct System {
        RoleRegistry roles;
        NeedsRegistry registry;
        AidVault vaultImplementation;
        NonCustodialLedger ledgerImplementation;
        AidVaultFactory factory;
        DonationReceipt receipt;
        BeneficiaryGroups groups;
        DeliveryManager deliveryManager;
        ProofOfAidResolver resolver;
        address token;
        address eas;
        address semaphore;
    }

    /// @dev Deploys every contract and wires them together. Must be called by `p.admin`.
    ///      Order matters: the ledger implementations take the factory, receipt and resolver as immutables, so
    ///      those exist first and the factory learns the implementations through `wire`.
    function _deploySystem(Params memory p) internal returns (System memory s) {
        s.eas = p.eas;
        s.semaphore = p.semaphore;
        s.token = p.token == address(0) ? address(new MockEURC()) : p.token;
        IRoleRegistry roles = IRoleRegistry(address(s.roles = new RoleRegistry(p.admin)));

        s.registry = new NeedsRegistry(roles, p.highValueThreshold);
        s.groups = new BeneficiaryGroups(roles, ISemaphore(p.semaphore));
        s.deliveryManager = new DeliveryManager(
            roles,
            INeedsRegistry(address(s.registry)),
            s.groups,
            p.confirmationThresholdBps,
            p.challengePeriod,
            p.minExpectedRecipients
        );
        s.resolver = new ProofOfAidResolver(IEAS(p.eas), roles, INeedsRegistry(address(s.registry)), s.deliveryManager);
        s.factory = new AidVaultFactory(roles);
        s.receipt = new DonationReceipt(roles, IAidVaultFactory(address(s.factory)), p.dashboardBaseURI);
        s.vaultImplementation = new AidVault(
            roles,
            INeedsRegistry(address(s.registry)),
            address(s.deliveryManager),
            IAidVaultFactory(address(s.factory)),
            IERC20(s.token),
            IDonationReceipt(address(s.receipt))
        );
        s.ledgerImplementation = new NonCustodialLedger(
            roles,
            INeedsRegistry(address(s.registry)),
            address(s.deliveryManager),
            IAidVaultFactory(address(s.factory)),
            address(s.resolver)
        );

        s.registry.wire(address(s.factory), address(s.groups), address(s.deliveryManager), address(s.resolver));
        s.factory.wire(address(s.registry), s.token, address(s.vaultImplementation), address(s.ledgerImplementation));
        s.groups.wire(address(s.deliveryManager));
        s.deliveryManager.wire(address(s.resolver));
    }

    /// @dev Deploys EAS/ + SchemaRegistry from the published artifacts (local chains only).
    function _deployLocalEAS() internal returns (address schemaRegistry, address eas) {
        schemaRegistry = vm.deployCode(SCHEMA_REGISTRY_ARTIFACT);
        eas = vm.deployCode(EAS_ARTIFACT, abi.encode(schemaRegistry));
    }
}
