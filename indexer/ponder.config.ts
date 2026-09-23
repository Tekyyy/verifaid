import {
  aidVaultAbi,
  aidVaultFactoryAbi,
  chainFor,
  deliveryManagerAbi,
  donationForwarderAbi,
  donationForwarderFactoryAbi,
  donationReceiptAbi,
  easAbi,
  getDeployment,
  needsRegistryAbi,
  programRegistryAbi,
  resolveNetwork,
  roleRegistryAbi,
} from '@poa/shared'
import { createConfig, factory } from 'ponder'
import { parseAbiItem, zeroAddress } from 'viem'

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

/** v3 conversion contracts; a deployment without them indexes nothing at the zero address. */
const forwarderFactory = contracts.DonationForwarderFactory ?? zeroAddress

/**
 * The schema UIDs this deployment cares about: the three the resolver gates, plus the resolver-less ones an NGO
 * and a supplier can write to (work photos, supplier applications). Every other attestation on the chain is
 * ignored.
 */
const schemaUIDs = [...Object.values(schemas), ...Object.values(deployment.communitySchemas ?? {})]

/** One vault is cloned per need; every vault is an AidVault. */
const ledgerAbi = aidVaultAbi

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
    // One ledger is cloned per need, so the address set is discovered from the factory's VaultCreated events.
    Ledger: {
      abi: ledgerAbi,
      chain: network,
      address: factory({
        address: contracts.AidVaultFactory,
        event: parseAbiItem('event VaultCreated(uint256 indexed needId, address vault)'),
        parameter: 'vault',
        startBlock,
      }),
      startBlock,
    },
    // Wallet donations in USDC or ETH, converted on the way in; also deploys the deposit addresses.
    DonationForwarderFactory: {
      abi: donationForwarderFactoryAbi,
      chain: network,
      address: forwarderFactory,
      startBlock,
    },
    // One deposit address per donor intent, discovered from the factory like the ledgers.
    DonationForwarder: {
      abi: donationForwarderAbi,
      chain: network,
      address: factory({
        address: forwarderFactory,
        event: parseAbiItem(
          'event ForwarderDeployed(address indexed forwarder, uint256 indexed needId, address receiptTo, address refundTo, address refundSigner, bytes32 salt)',
        ),
        parameter: 'forwarder',
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
    ProgramRegistry: {
      abi: programRegistryAbi,
      chain: network,
      address: contracts.ProgramRegistry,
      startBlock,
    },
    DeliveryManager: {
      abi: deliveryManagerAbi,
      chain: network,
      address: contracts.DeliveryManager,
      startBlock,
    },
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
