import { NextResponse } from 'next/server'
import {
  type Abi,
  type Address,
  BaseError,
  type ContractFunctionArgs,
  type ContractFunctionName,
  ContractFunctionRevertedError,
  createWalletClient,
  type Hex,
  http,
  isHex,
  nonceManager,
  type PrivateKeyAccount,
  type TransactionReceipt,
  type WalletClient,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { chain, rpcUrl } from '../config'
import { publicClient } from './chain'

/**
 * The app's relayer: one server-held key (`RELAYER_PRIVATE_KEY`) that pays gas for writes a user should not or
 * cannot send themselves — anonymous beneficiary confirmations, deposit-address deploys and sweeps, refunds signed
 * with a donor's refund key, and sandbox on-ramp mints.
 *
 * Every route writes through one queue, because two routes sending at once would race for the same nonce, and the
 * account's nonce manager keeps counting locally when a load-balanced RPC lags behind. Every write is simulated
 * first: a call that would revert costs nothing and comes back as its reason. The key never reaches a response or
 * a log.
 */

export interface Relayer {
  account: PrivateKeyAccount
  wallet: WalletClient
}

let relayer: Relayer | null = null

/** The configured relayer, or null when the key is missing or malformed (routes answer 503). */
export const getRelayer = (): Relayer | null => {
  if (relayer) return relayer
  const key = process.env.RELAYER_PRIVATE_KEY
  if (!key || !isHex(key) || key.length !== 66) return null
  const account = privateKeyToAccount(key, { nonceManager })
  relayer = { account, wallet: createWalletClient({ account, chain, transport: http(rpcUrl) }) }
  return relayer
}

let queue: Promise<unknown> = Promise.resolve()

/** One relayer transaction at a time, across every route that uses it. */
const serialize = <T>(task: () => Promise<T>): Promise<T> => {
  const result = queue.then(task, task)
  queue = result.catch(() => undefined)
  return result
}

type RelayMutability = 'nonpayable' | 'payable'

export interface RelayCall<abi extends Abi, functionName extends ContractFunctionName<abi, RelayMutability>> {
  address: Address
  abi: abi
  functionName: functionName
  args: ContractFunctionArgs<abi, RelayMutability, functionName>
}

/** Simulates `call` as the relayer and sends it. Throws the simulation error, which carries the revert reason. */
export const relayWrite = <
  const abi extends Abi,
  functionName extends ContractFunctionName<abi, RelayMutability>,
>(
  from: Relayer,
  call: RelayCall<abi, functionName>,
): Promise<Hex> =>
  serialize(async () => {
    const { request } = await publicClient.simulateContract({ account: from.account, ...call } as never)
    return from.wallet.writeContract(request as never)
  })

const RECEIPT_TIMEOUT_MS = 90_000

export const waitForReceipt = (hash: Hex): Promise<TransactionReceipt> =>
  publicClient.waitForTransactionReceipt({ hash, timeout: RECEIPT_TIMEOUT_MS })

/**
 * The custom error a contract reverted with (`NothingToSweep`, `NotAccepting`, …) when the ABI names it, plus a
 * short single-line message. Transport details (which can include the RPC URL) are left out.
 */
export const revertOf = (error: unknown): { name: string | null; message: string } => {
  if (error instanceof BaseError) {
    const reverted = error.walk((cause) => cause instanceof ContractFunctionRevertedError)
    if (reverted instanceof ContractFunctionRevertedError && reverted.data?.errorName) {
      return { name: reverted.data.errorName, message: reverted.data.errorName }
    }
    return { name: null, message: error.shortMessage.slice(0, 200) }
  }
  return { name: null, message: 'failed' }
}

/**
 * Wraps a route handler so a chain read that fails (RPC down, rate-limited) answers 502 with a short reason instead
 * of an unhandled 500. Reverts are handled inside the handlers, where they mean something.
 */
export const withChainErrors =
  <Args extends unknown[]>(handler: (...args: Args) => Promise<Response>) =>
  async (...args: Args): Promise<Response> => {
    try {
      return await handler(...args)
    } catch (error) {
      return NextResponse.json(
        { error: 'chain_unavailable', message: revertOf(error).message },
        { status: 502 },
      )
    }
  }
