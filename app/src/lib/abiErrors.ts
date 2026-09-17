import {
  aidVaultAbi,
  conversionRouterAbi,
  donationForwarderAbi,
  donationForwarderFactoryAbi,
  mockEURCAbi,
  proofOfAidResolverAbi,
} from '@poa/shared'

/**
 * ABIs extended with the errors of every contract a conversion calls into, so a revert deep inside the router
 * (`StalePrice`), the vault (`ExceedsTarget`) or the resolver's cost cap (`FeeExceedsDisclosure`) is decoded by name
 * instead of surfacing as a raw selector. Used by the browser preflight and by the relayer routes alike.
 */

type AbiError<abi extends readonly unknown[]> = Extract<abi[number], { type: 'error' }>

const errorsOf = <const abi extends readonly { type: string }[]>(abi: abi): AbiError<abi>[] =>
  abi.filter((item): item is AbiError<abi> => item.type === 'error')

const downstreamErrors = [
  ...errorsOf(conversionRouterAbi),
  ...errorsOf(aidVaultAbi),
  ...errorsOf(proofOfAidResolverAbi),
  ...errorsOf(mockEURCAbi),
]

/** `DonationForwarderFactory` (the wallet path) plus downstream errors. */
export const factoryCallAbi = [...donationForwarderFactoryAbi, ...downstreamErrors]

/** `DonationForwarder` (a deposit address) plus downstream errors. */
export const forwarderCallAbi = [...donationForwarderAbi, ...downstreamErrors]

/**
 * Reverts a donor can do something about, mapped to the message that explains them (namespace `conversion`).
 * Anything else is shown as its error name.
 */
export const REVERT_MESSAGES: Record<string, string> = {
  FeeExceedsDisclosure: 'revertFeeCap',
  NotAccepting: 'revertNotAccepting',
  FundingNotOpen: 'revertNotAccepting',
  InsufficientOutput: 'revertSlippage',
  StalePrice: 'revertPrice',
  InvalidPrice: 'revertPrice',
  SequencerDown: 'revertPrice',
  PriceFeedNotSet: 'revertRoute',
  RouteNotSet: 'revertRoute',
  ERC20InsufficientBalance: 'revertBalance',
  SystemPaused: 'revertPaused',
}
