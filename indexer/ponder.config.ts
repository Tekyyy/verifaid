import {
  aidVaultAbi,
  aidVaultFactoryAbi,
  beneficiaryGroupsAbi,
  chainFor,
  deliveryManagerAbi,
  donationReceiptAbi,
  easAbi,
  getDeployment,
  needsRegistryAbi,
  resolveNetwork,
  roleRegistryAbi,
  semaphoreAbi,
} from '@poa/shared'
import { createConfig, factory } from 'ponder'
import { parseAbiItem } from 'viem'

/**
 * Addresses, schema UIDs and the start block all come from `deployments/<network>.json` through @poa/shared,
 * so the indexer can never drift from what the deploy scripts actually wrote.
 *
 *   PONDER_NETWORK=anvil        pnpm --filter @poa/indexer dev
 *   PONDER_NETWORK=base-sepolia PONDER_RPC_URL=https://... pnpm --filter @poa/indexer start
 */
const network = resolveNetwork(process.env.PONDER_NETWORK ?? 'anvil')
const deployment = getDeployment(network)
const { contracts, external, schemas, startBlock, chainId } = deployment

const rpc = process.env.PONDER_RPC_URL ?? chainFor(network).rpcUrls.default.http[0]

/** The five schema UIDs of this deployment; every other EAS attestation on the chain is ignored. */
const schemaUIDs = Object.values(schemas)

export default createConfig({
  chains: { [network]: { id: chainId, rpc } },
  contracts: {
    RoleRegistry: { abi: roleRegistryAbi, chain: network, address: contracts.RoleRegistry, startBlock },
    NeedsRegistry: { abi: needsRegistryAbi, chain: network, address: contracts.NeedsRegistry, startBlock },
    AidVaultFactory: {
      abi: aidVaultFactoryAbi,
      chain: network,
      address: contracts.AidVaultFactory,
      startBlock,
    },
    // One vault is cloned per need, so the address set is discovered from the factory's VaultCreated events.
    AidVault: {
      abi: aidVaultAbi,
      chain: network,
      address: factory({
        address: contracts.AidVaultFactory,
        event: parseAbiItem('event VaultCreated(uint256 indexed needId, address vault)'),
        parameter: 'vault',
        startBlock,
      }),
      startBlock,
    },
    DonationReceipt: {
      abi: donationReceiptAbi,
      chain: network,
      address: contracts.DonationReceipt,
      startBlock,
    },
    BeneficiaryGroups: {
      abi: beneficiaryGroupsAbi,
      chain: network,
      address: contracts.BeneficiaryGroups,
      startBlock,
    },
    DeliveryManager: {
      abi: deliveryManagerAbi,
      chain: network,
      address: contracts.DeliveryManager,
      startBlock,
    },
    // Semaphore is a shared deployment on public chains: the handlers drop events for groups we did not create.
    Semaphore: { abi: semaphoreAbi, chain: network, address: external.Semaphore, startBlock },
    EAS: {
      abi: easAbi,
      chain: network,
      address: external.EAS,
      startBlock,
      filter: [
        { event: 'Attested', args: { schemaUID: schemaUIDs } },
        { event: 'Revoked', args: { schemaUID: schemaUIDs } },
      ],
    },
  },
})
