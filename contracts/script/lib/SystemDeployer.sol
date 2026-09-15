// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {RoleRegistry} from "../../src/access/RoleRegistry.sol";
import {DeliveryManager} from "../../src/delivery/DeliveryManager.sol";
import {AidVault} from "../../src/funds/AidVault.sol";
import {AidVaultFactory} from "../../src/funds/AidVaultFactory.sol";
import {DonationReceipt} from "../../src/funds/DonationReceipt.sol";
import {BeneficiaryGroups} from "../../src/identity/BeneficiaryGroups.sol";
import {INeedsRegistry} from "../../src/interfaces/INeedsRegistry.sol";
import {IRoleRegistry} from "../../src/interfaces/IRoleRegistry.sol";
import {MockEURC} from "../../src/mocks/MockEURC.sol";
import {NeedsRegistry} from "../../src/needs/NeedsRegistry.sol";
import {DeliveryEvidenceResolver} from "../../src/resolvers/DeliveryEvidenceResolver.sol";
import {DeliveryVerifiedResolver} from "../../src/resolvers/DeliveryVerifiedResolver.sol";
import {FiatDonationResolver} from "../../src/resolvers/FiatDonationResolver.sol";
import {ImpactReportResolver} from "../../src/resolvers/ImpactReportResolver.sol";
import {NeedVerifiedResolver} from "../../src/resolvers/NeedVerifiedResolver.sol";
import {IEAS} from "@ethereum-attestation-service/eas-contracts/contracts/IEAS.sol";
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
        AidVaultFactory factory;
        DonationReceipt receipt;
        BeneficiaryGroups groups;
        DeliveryManager deliveryManager;
        NeedVerifiedResolver needVerifiedResolver;
        DeliveryEvidenceResolver evidenceResolver;
        DeliveryVerifiedResolver deliveryVerifiedResolver;
        FiatDonationResolver fiatDonationResolver;
        ImpactReportResolver impactReportResolver;
        address token;
        address eas;
        address semaphore;
    }

    /// @dev Deploys every contract and wires them together. Must be called by `p.admin`.
    function _deploySystem(Params memory p) internal returns (System memory s) {
        s.eas = p.eas;
        s.semaphore = p.semaphore;
        s.token = p.token == address(0) ? address(new MockEURC()) : p.token;

        s.roles = new RoleRegistry(p.admin);
        s.registry = new NeedsRegistry(IRoleRegistry(address(s.roles)), p.highValueThreshold);
        s.vaultImplementation = new AidVault();
        s.factory = new AidVaultFactory(IRoleRegistry(address(s.roles)), address(s.vaultImplementation));
        s.receipt = new DonationReceipt(IRoleRegistry(address(s.roles)), s.factory, p.dashboardBaseURI);
        s.groups = new BeneficiaryGroups(IRoleRegistry(address(s.roles)), ISemaphore(p.semaphore));
        s.deliveryManager = new DeliveryManager(
            IRoleRegistry(address(s.roles)),
            INeedsRegistry(address(s.registry)),
            s.groups,
            p.confirmationThresholdBps,
            p.challengePeriod,
            p.minExpectedRecipients
        );

        s.needVerifiedResolver =
            new NeedVerifiedResolver(IEAS(p.eas), IRoleRegistry(address(s.roles)), INeedsRegistry(address(s.registry)));
        s.evidenceResolver = new DeliveryEvidenceResolver(
            IEAS(p.eas), IRoleRegistry(address(s.roles)), s.deliveryManager, INeedsRegistry(address(s.registry))
        );
        s.deliveryVerifiedResolver = new DeliveryVerifiedResolver(
            IEAS(p.eas), IRoleRegistry(address(s.roles)), s.deliveryManager, INeedsRegistry(address(s.registry))
        );
        s.fiatDonationResolver =
            new FiatDonationResolver(IEAS(p.eas), IRoleRegistry(address(s.roles)), INeedsRegistry(address(s.registry)));
        s.impactReportResolver = new ImpactReportResolver(
            IEAS(p.eas), IRoleRegistry(address(s.roles)), INeedsRegistry(address(s.registry)), s.deliveryManager
        );

        s.registry
            .wire(address(s.factory), address(s.groups), address(s.deliveryManager), address(s.needVerifiedResolver));
        s.factory.wire(address(s.registry), address(s.deliveryManager), s.token, address(s.receipt));
        s.groups.wire(address(s.deliveryManager));
        s.deliveryManager.wire(address(s.evidenceResolver), address(s.deliveryVerifiedResolver));
    }

    /// @dev Deploys EAS + SchemaRegistry from the published artifacts (local chains only).
    function _deployLocalEAS() internal returns (address schemaRegistry, address eas) {
        schemaRegistry = vm.deployCode(SCHEMA_REGISTRY_ARTIFACT);
        eas = vm.deployCode(EAS_ARTIFACT, abi.encode(schemaRegistry));
    }
}
