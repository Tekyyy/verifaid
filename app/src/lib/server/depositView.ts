import { type DepositAddressView, donationForwarderAbi } from '@poa/shared'
import { type Address, getAddress, zeroAddress } from 'viem'
import { useFixtures } from '../config'
import { getDepositAddress } from '../indexer'
import { publicClient } from './chain'
import { forwarderContext, isFactoryForwarder } from './deposits'

const orNull = (address: Address): Address | null => (address === zeroAddress ? null : address)

/**
 * A deposit address for its tracking page: the indexer's view when it has one, otherwise read straight from the
 * chain. A donor opens the tracking link seconds after the address was deployed, often before the indexer has
 * caught up, and "not found" would be exactly the wrong thing to show them then.
 *
 * Null when the address is not a forwarder of this deployment.
 */
export const loadDepositView = async (ref: string): Promise<DepositAddressView | null> => {
  const indexed = await getDepositAddress(ref)
  if (indexed.ok) return indexed.data
  const context = forwarderContext()
  if (useFixtures || !context || !/^0x[0-9a-fA-F]{40}$/.test(ref)) return null

  try {
    const address = getAddress(ref)
    if (!(await isFactoryForwarder(context, address))) return null
    const intent = await publicClient.readContract({
      address,
      abi: donationForwarderAbi,
      functionName: 'intent',
    })
    return {
      address,
      needId: intent.needId.toString(),
      receiptTo: orNull(intent.receiptTo),
      refundTo: orNull(intent.refundTo),
      refundSigner: orNull(intent.refundSigner),
      salt: intent.salt,
      deployedAt: 0,
      sweeps: [],
      refunds: [],
    }
  } catch {
    return null
  }
}
