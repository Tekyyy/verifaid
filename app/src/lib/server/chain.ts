import { createPublicClient, http } from 'viem'
import { chain, rpcUrl } from '../config'

/**
 * Server-side read client. It exists so the beneficiary page can resolve a delivery straight from the chain
 * instead of depending on the indexer being up, and so the relayer route can estimate before sending.
 */
export const publicClient = createPublicClient({ chain, transport: http(rpcUrl) })
