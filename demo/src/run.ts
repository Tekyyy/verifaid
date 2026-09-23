import { createHash } from 'node:crypto'
import {
  aidVaultAbi,
  buildManifest,
  categoryHash,
  conversionRouterAbi,
  deliveryManagerAbi,
  donationForwarderAbi,
  donationForwarderFactoryAbi,
  encodeSchemaData,
  formatAmount,
  mockEURCAbi,
  mockYieldVaultAbi,
  NATIVE_TOKEN,
  NEED_STATUS_VALUE,
  needStatusName,
  needsRegistryAbi,
  programRegistryAbi,
  proofOfAidResolverAbi,
  regionCode,
  roleRegistryAbi,
  tokenSymbolOf,
  VOTE_SIGNATURE_TTL_SECONDS,
  voiceName,
  voteTypedData,
} from '@poa/shared'
import {
  type Abi,
  type Address,
  formatEther,
  keccak256,
  parseEventLogs,
  stringToHex,
  type TransactionReceipt,
  zeroAddress,
  zeroHash,
} from 'viem'
import { attest, cidV1Raw, eventArg, send, waitSeconds } from './chain.js'
import { createContext, type DemoContext, type RoleName } from './config.js'
import { attestation, fail, heading, info, note, step, tx } from './log.js'

/**
 * Runs the VerifAid lifecycle against a live chain and prints an explorer link for every step, so a judge
 * can follow a need from "a verifier said this need is real" to "the donors approved how the money was spent,
 * and here is the money that moved because of it".
 *
 * Every scenario runs entirely on chain. Money only ever enters as tokens: a card buys USDC through the Coinbase
 * on-ramp into the donor's own wallet, which then donates it; there is no payment provider holding anyone's money.
 *   1. Escrow: a wallet donor and a card donor, and every tranche paid straight from the vault to the suppliers of
 *      the need's payment plan.
 *   2. A funding deadline passing below the NGO's minimum: the need expires and the donor is refunded.
 *   3. Conversions: USDC bought by card is donated as it is, because the vaults hold USDC; euros and ETH are
 *      swapped into it under the Chainlink bound; and an exchange withdrawal reaches a deposit address that can
 *      only ever donate to its need or refund.
 *   4. Idle capital: a programme whose deliveries run for months lets the committed money wait in an ERC-4626
 *      venue, earns on it, pays every supplier out of it, and hands the earnings to the NGO at the end.
 *   5. Rejection: under the "donors and a verifier" rule, the donor rejects the NGO's evidence, the NGO files again,
 *      a verifier rejects that too, and the need is cancelled — the donor claims back what was not released.
 *   (review, opt-in: leaves evidence waiting on a need page for a live audience to vote on.)
 *
 *   pnpm demo:run anvil            all five
 *   pnpm demo:run base-sepolia onchain idle
 */

const REGION = regionCode('ES-CM')
const BPS = 10_000n

type Scenario = 'onchain' | 'expiry' | 'conversion' | 'idle' | 'rejection' | 'review'
/** What runs when no scenario is named. `review` is opt-in: it deliberately leaves evidence waiting. */
const SCENARIOS: Scenario[] = ['onchain', 'expiry', 'conversion', 'idle', 'rejection']
const ALL_SCENARIOS: Scenario[] = [...SCENARIOS, 'review']

interface NeedSpec {
  label: string
  category: string
  target: bigint
  trancheBps: number[]
  minFundingBps: number
  thirdPartyCostBps: number
  fundingWindowSeconds: number
  executionWindowSeconds: number
  outcome: string
  /** The release policy it is judged by; the platform default (donors decide) when unset. */
  releasePolicy?: Address
}

/** How one voter casts their vote on a delivery: a transaction, or a free signature a relayer submits. */
interface Voter {
  role: RoleName
  approve: boolean
  signed?: boolean
}

const main = async (): Promise<void> => {
  const [networkArg, ...rest] = process.argv.slice(2)
  const selected =
    rest.length > 0 ? rest.filter((s): s is Scenario => ALL_SCENARIOS.includes(s as Scenario)) : SCENARIOS
  const ctx = createContext(networkArg)
  const { contracts, external } = ctx.deployment

  heading('VerifAid v9 — lifecycle demo')
  info('network', ctx.network)
  info('rpc', ctx.rpcUrl)
  info('NeedsRegistry', contracts.NeedsRegistry)
  info('ProofOfAidResolver', contracts.ProofOfAidResolver)
  info('token', external.Token)
  info('scenarios', selected.join(', '))

  await preflight(ctx)
  const programId = await resolveProgram(ctx)

  const links: string[] = []
  if (selected.includes('onchain')) links.push(...(await onChainScenario(ctx, programId)))
  if (selected.includes('expiry')) links.push(...(await expiryScenario(ctx, programId)))
  if (selected.includes('conversion')) {
    if (contracts.DonationForwarderFactory && contracts.ConversionRouter && external.USDC) {
      links.push(...(await conversionScenario(ctx, programId)))
    } else {
      note('skipping the conversion scenario: this deployment predates v3 (no DonationForwarderFactory)')
    }
  }

  if (selected.includes('idle')) {
    if (external.YieldVenue && external.YieldVenue !== zeroAddress) {
      links.push(...(await idleScenario(ctx, programId)))
    } else {
      note('skipping the idle-capital scenario: this deployment approves no venue')
    }
  }

  if (selected.includes('rejection')) {
    if (contracts.ReleasePolicyDonorsAndVerifier) {
      links.push(...(await rejectionScenario(ctx, programId)))
    } else {
      note('skipping the rejection scenario: this deployment predates v9 (no release policies)')
    }
  }
  if (selected.includes('review')) links.push(...(await reviewScenario(ctx, programId)))

  heading('Done')
  for (const link of links) note(link)
  console.log('')
}

// ─── scenario 1: escrow ───────────────────────────────────────────────────────

const onChainScenario = async (ctx: DemoContext, programId: bigint): Promise<string[]> => {
  heading('1 · Escrow: stablecoin held by the vault, released tranche by tranche')
  const spec: NeedSpec = {
    label: 'winter food kits',
    category: 'FOOD',
    target: 6_000_000_000n, // below the high-value threshold, so one verifier suffices
    trancheBps: [3000, 4000, 3000],
    minFundingBps: 6000,
    thirdPartyCostBps: 150,
    fundingWindowSeconds: 30 * 86_400,
    executionWindowSeconds: 120 * 86_400,
    outcome: '400 families receive winter food kits in ES-CM; partial funding scales kits pro rata above 60%',
  }
  const needId = await createNeed(ctx, programId, spec)
  const vault = await verifyNeed(ctx, needId)

  step('Donations: a wallet donor, and a card donor through the Coinbase on-ramp')
  const direct = 3_600_000_000n
  const receiptId = await donateDirect(ctx, vault, direct)
  const card = await donateByCard(ctx, 'donor2', needId, spec.target - direct)
  await expectStatus(ctx, needId, 'Funded')

  await releaseOnChain(ctx, vault, 0)

  // donor2 (40%) is enough on its own; donor1 is asked only if it is not. donor2 signs its vote for free and the
  // relayer puts it on chain, the way the dashboard does for anyone who ticks "vote for free".
  for (let index = 1; index < spec.trancheBps.length; index += 1) {
    await runDelivery(ctx, needId, index, [
      { role: 'donor2', approve: true, signed: true },
      { role: 'donor1', approve: true },
    ])
    await releaseOnChain(ctx, vault, index)
  }

  await expectStatus(ctx, needId, 'Completed')
  await publishImpactReport(ctx, needId, vault, 400)
  return [
    `need ${needId} (on-chain):  ${ctx.dashboardUrl}/en/needs/${needId}`,
    `  wallet donor tracking:    ${ctx.dashboardUrl}/en/track/${receiptId}`,
    `  card donor tracking:      ${ctx.dashboardUrl}/en/track/${card}`,
    `  report:                   ${ctx.dashboardUrl}/api/reports/${needId}`,
  ]
}

// ─── scenario 5: rejection ────────────────────────────────────────────────────

/**
 * What happens when the account does not convince. The need is judged by donors and a verifier together: the
 * donor rejects the first evidence, the NGO gets its one second chance and files again, a verifier rejects that
 * too — and the need is cancelled on the spot. Tranche 0 was spent; the donor claims back the rest.
 */
const rejectionScenario = async (ctx: DemoContext, programId: bigint): Promise<string[]> => {
  heading('5 · Rejection: evidence voted down twice cancels the need and refunds the donor')
  const spec: NeedSpec = {
    label: 'emergency shelter repairs',
    category: 'SHELTER',
    target: 1_000_000_000n,
    trancheBps: [3000, 7000],
    minFundingBps: 10_000,
    thirdPartyCostBps: 0,
    fundingWindowSeconds: 30 * 86_400,
    executionWindowSeconds: 120 * 86_400,
    outcome: '40 homes in ES-CM repaired before the rains',
    releasePolicy: ctx.deployment.contracts.ReleasePolicyDonorsAndVerifier,
  }
  const needId = await createNeed(ctx, programId, spec)
  note('released only when the donors AND an independent verifier approve; either can reject')
  const vault = await verifyNeed(ctx, needId)
  const receiptId = await donateDirect(ctx, vault, spec.target)
  await expectStatus(ctx, needId, 'Funded')
  await releaseOnChain(ctx, vault, 0)

  await runDelivery(ctx, needId, 1, [{ role: 'donor1', approve: false, signed: true }], 'Rejected')
  note('the NGO gets one second chance')
  await runDelivery(ctx, needId, 1, [{ role: 'verifier1', approve: false }], 'Rejected')
  await expectStatus(ctx, needId, 'Cancelled')

  step('The donor claims back everything that was not released')
  const refund = await send(ctx, 'donor1', {
    address: vault,
    abi: aidVaultAbi as Abi,
    functionName: 'claimRefund',
    args: [],
  })
  const amount = eventArg<bigint>(refund.receipt, aidVaultAbi as Abi, 'Refunded', 'amount')
  info('refunded', `${formatAmount(amount)} units — the 70% that tranche 0 did not spend`)
  tx(ctx.network, 'tx', refund.hash)
  return [
    `need ${needId} (rejected twice, cancelled): ${ctx.dashboardUrl}/en/needs/${needId}`,
    `  donor tracking:           ${ctx.dashboardUrl}/en/track/${receiptId}`,
  ]
}

// ─── scenario 6: evidence waiting for the donors ──────────────────────────────

/**
 * Stops halfway on purpose: the NGO has been paid tranche 0 and filed its receipt, and the donors have not voted.
 * The need page then shows the evidence with an Approve button for whoever gave, which is the part of the flow a
 * live audience should see happen.
 */
const reviewScenario = async (ctx: DemoContext, programId: bigint): Promise<string[]> => {
  heading('6 · Evidence waiting for the donors: vote on it from the need page')
  const spec: NeedSpec = {
    label: 'school kits',
    category: 'EDUCATION',
    target: 2_000_000_000n,
    trancheBps: [3000, 7000],
    minFundingBps: 10_000,
    thirdPartyCostBps: 0,
    fundingWindowSeconds: 30 * 86_400,
    executionWindowSeconds: 120 * 86_400,
    outcome: '200 pupils in ES-CM receive a year of school supplies',
  }
  const needId = await createNeed(ctx, programId, spec)
  const vault = await verifyNeed(ctx, needId)
  await donateDirect(ctx, vault, spec.target)
  await expectStatus(ctx, needId, 'Funded')
  await releaseOnChain(ctx, vault, 0)
  await runDelivery(ctx, needId, 1, [])
  return [`need ${needId} (evidence waiting for the donors): ${ctx.dashboardUrl}/en/needs/${needId}`]
}

// ─── scenario 4: idle capital ─────────────────────────────────────────────────

/**
 * The case this exists for: a programme whose deliveries run for months, holding money nobody can spend yet.
 * Every rule that makes it safe is visible here — it only goes out once funding has closed, a tranche that is
 * payable now never leaves, releasing pulls back whatever the vault is short of, and the earnings are handed
 * over only at the end. What a donor gave stays what a donor is owed throughout.
 */
const idleScenario = async (ctx: DemoContext, programId: bigint): Promise<string[]> => {
  heading('4 · Idle capital: committed money earns while it waits for a delivery')
  const venue = ctx.deployment.external.YieldVenue as Address
  const spec: NeedSpec = {
    label: 'boreholes over two dry seasons',
    category: 'WATER',
    target: 4_000_000_000n,
    trancheBps: [2000, 4000, 4000],
    minFundingBps: 6000,
    thirdPartyCostBps: 0,
    fundingWindowSeconds: 30 * 86_400,
    executionWindowSeconds: 180 * 86_400,
    outcome: '6 boreholes drilled and handed over in ES-CM across two dry seasons',
  }
  const needId = await createNeed(ctx, programId, spec)

  step('The NGO opts the need in — only possible now, before it can take a single donation')
  const optIn = await send(ctx, 'ngo', {
    address: ctx.deployment.contracts.NeedsRegistry,
    abi: needsRegistryAbi as Abi,
    functionName: 'enableYield',
    args: [needId],
  })
  info('venue', venue)
  note('a donor sees this on the need before giving; after verification it can no longer be turned on')
  tx(ctx.network, 'tx', optIn.hash)

  const vault = await verifyNeed(ctx, needId)
  await donateDirect(ctx, vault, spec.target)
  await expectStatus(ctx, needId, 'Funded')
  await releaseOnChain(ctx, vault, 0)

  step('What no supplier can claim yet goes to the venue to earn')
  const room = (await ctx.publicClient.readContract({
    address: vault,
    abi: aidVaultAbi,
    functionName: 'deployableAmount',
  })) as bigint
  const deployed = await send(ctx, 'ngo', {
    address: vault,
    abi: aidVaultAbi as Abi,
    functionName: 'deployIdle',
    args: [room],
  })
  info('lent', `${formatAmount(room)} units, at cost`)
  note('the cap and every tranche a delivery could unlock today are both held back')
  tx(ctx.network, 'tx', deployed.hash)

  step('Interest arrives and the need takes it')
  const gain = room / 20n // a round 5%, standing in for months of a real rate
  await mintIfPossible(ctx, 'donor2', gain)
  await send(ctx, 'donor2', {
    address: ctx.deployment.external.Token,
    abi: mockEURCAbi as Abi,
    functionName: 'approve',
    args: [venue, gain],
  })
  await send(ctx, 'donor2', {
    address: venue,
    abi: mockYieldVaultAbi as Abi,
    functionName: 'accrue',
    args: [gain],
  })
  const harvested = await send(ctx, 'ngo', {
    address: vault,
    abi: aidVaultAbi as Abi,
    functionName: 'harvest',
    args: [],
  })
  const earned = (await ctx.publicClient.readContract({
    address: vault,
    abi: aidVaultAbi,
    functionName: 'yieldRealised',
  })) as bigint
  info('earned', `${formatAmount(earned)} units, realised into the vault`)
  tx(ctx.network, 'tx', harvested.hash)

  step('Deliveries: each release pulls back from the venue whatever the vault is short of')
  for (let index = 1; index < spec.trancheBps.length; index += 1) {
    await runDelivery(ctx, needId, index, [{ role: 'donor1', approve: true }])
    await releaseOnChain(ctx, vault, index)
  }
  await expectStatus(ctx, needId, 'Completed')

  step('The need is over: the position is closed and the earnings follow the work')
  // Releasing pulls back only what each tranche needed, so the position can still be open — and a position
  // that is open at all, even holding nothing, is one the vault will not pay earnings out of.
  const sleeve = (await ctx.publicClient.readContract({
    address: vault,
    abi: aidVaultAbi,
    functionName: 'sleeve',
  })) as Address
  const lent = (await ctx.publicClient.readContract({
    address: vault,
    abi: aidVaultAbi,
    functionName: 'deployedPrincipal',
  })) as bigint
  if (sleeve !== zeroAddress) {
    await send(ctx, 'ngo', {
      address: vault,
      abi: aidVaultAbi as Abi,
      functionName: 'unwind',
      args: [lent * 2n + 1n],
    })
  }
  const paid = await send(ctx, 'ngo', {
    address: vault,
    abi: aidVaultAbi as Abi,
    functionName: 'payYield',
    args: [],
  })
  info('handed to the NGO', `${formatAmount(earned)} units`)
  note('a donor would have been repaid what they gave, and never a slice of this')
  tx(ctx.network, 'tx', paid.hash)

  await publishImpactReport(ctx, needId, vault, 600)
  return [`need ${needId} (idle capital): ${ctx.dashboardUrl}/en/needs/${needId}`]
}

// ─── scenario 2: expiry below the minimum ─────────────────────────────────────

const expiryScenario = async (ctx: DemoContext, programId: bigint): Promise<string[]> => {
  heading('2 · A deadline passes below the minimum: the need expires and donors get their money back')
  // Long enough to verify and donate before it passes on a public testnet, short enough to wait for.
  const window = ctx.isLocal ? 3_600 : 150
  const spec: NeedSpec = {
    label: 'school supplies',
    category: 'EDUCATION',
    target: 5_000_000_000n,
    trancheBps: [5000, 5000],
    minFundingBps: 5000,
    thirdPartyCostBps: 0,
    fundingWindowSeconds: window,
    executionWindowSeconds: window * 20,
    outcome: 'school supplies for 200 pupils; all or nothing below 50%',
  }
  const needId = await createNeed(ctx, programId, spec)
  const vault = await verifyNeed(ctx, needId)

  step('Only 20% is raised before the funding deadline')
  const receiptId = await donateDirect(ctx, vault, 1_000_000_000n)

  const deadline = await readDeadline(ctx, needId)
  await waitUntil(ctx, deadline, 'waiting for the funding deadline')

  step('Anyone applies the deadline: below the 50% minimum, so the need expires')
  const expired = await send(ctx, 'relayer', {
    address: ctx.deployment.contracts.NeedsRegistry,
    abi: needsRegistryAbi as Abi,
    functionName: 'expire',
    args: [needId],
  })
  tx(ctx.network, 'expire', expired.hash)
  await expectStatus(ctx, needId, 'Expired')

  step('The donor claims a full refund')
  const refund = await send(ctx, 'donor1', {
    address: vault,
    abi: aidVaultAbi as Abi,
    functionName: 'claimRefund',
    args: [],
  })
  const refunded = eventArg<bigint>(refund.receipt, aidVaultAbi as Abi, 'Refunded', 'amount')
  info('refunded', `${formatAmount(refunded)} units`)
  tx(ctx.network, 'refund', refund.hash)
  return [
    `need ${needId} (expired):   ${ctx.dashboardUrl}/en/needs/${needId}`,
    `  donor tracking:           ${ctx.dashboardUrl}/en/track/${receiptId}`,
  ]
}

// ─── scenario 3: conversions (v3) ─────────────────────────────────────────────

const conversionScenario = async (ctx: DemoContext, programId: bigint): Promise<string[]> => {
  heading('3 · Full blockchain mode: card-bought USDC as it is, euros and ETH converted on-chain')
  const factory = ctx.deployment.contracts.DonationForwarderFactory as Address
  const router = ctx.deployment.contracts.ConversionRouter as Address
  const usdc = ctx.deployment.external.USDC as Address
  const token = ctx.deployment.external.Token
  // The euro stablecoin, when this deployment has one that is not the vault currency itself.
  const eurc = ctx.deployment.external.EURC
  const convertible = eurc && eurc.toLowerCase() !== token.toLowerCase() ? (eurc as Address) : null
  const maxSlippageBps = BigInt(ctx.deployment.params.maxSlippageBps ?? 100)
  const spec: NeedSpec = {
    label: 'water purification tablets',
    category: 'WATER',
    target: 4_000_000_000n,
    trancheBps: [5000, 5000],
    minFundingBps: 10_000,
    // Swaps cost something (pool fee, price impact): the NGO discloses it and the contract caps it.
    thirdPartyCostBps: 150,
    fundingWindowSeconds: 30 * 86_400,
    executionWindowSeconds: 90 * 86_400,
    outcome: 'water purification tablets for 1 000 households; all or nothing',
  }
  const needId = await createNeed(ctx, programId, spec)
  const vault = await verifyNeed(ctx, needId)
  const quote = (tokenIn: Address, amountIn: bigint) =>
    ctx.publicClient.readContract({
      address: router,
      abi: conversionRouterAbi,
      functionName: 'quote',
      args: [tokenIn, amountIn, token],
    }) as Promise<bigint>

  const bought = 2_000_000_000n
  info('fair value of card USDC', `${formatAmount(await quote(usdc, bought))} units: the same money, no pool`)
  const receiptId = await donateByCard(ctx, 'donor1', needId, bought)

  if (convertible) {
    step('A wallet gives euros: the factory swaps EURC on Uniswap v3, bounded by Chainlink')
    const euros = 500_000_000n
    await mintIfPossible(ctx, 'donor2', euros, convertible)
    const fair = await quote(convertible, euros)
    info('EURC given', formatAmount(euros))
    info('fair value', `${formatAmount(fair)} units (Chainlink EUR/USD and USDC/USD)`)
    info('minimum accepted', `${formatAmount((fair * (BPS - maxSlippageBps)) / BPS)} units, or it reverts`)
    await send(ctx, 'donor2', {
      address: convertible,
      abi: mockEURCAbi as Abi,
      functionName: 'approve',
      args: [factory, euros],
    })
    const euroDonation = await send(ctx, 'donor2', {
      address: factory,
      abi: donationForwarderFactoryAbi as Abi,
      functionName: 'donate',
      args: [needId, convertible, euros],
    })
    logConversion(euroDonation.receipt, 'DonatedWithConversion')
    tx(ctx.network, 'tx', euroDonation.hash)
  } else {
    note('this deployment has no second stablecoin, so there is nothing to convert from')
  }

  if (ctx.deployment.params.ethDonations) {
    step('A wallet donates ETH: routed ETH → USDC in the same transaction')
    const eth = 100_000_000_000_000_000n // 0.1 ETH
    info('ETH given', formatEther(eth))
    info('fair value', `${formatAmount(await quote(NATIVE_TOKEN, eth))} units`)
    const ethDonation = await send(ctx, 'donor1', {
      address: factory,
      abi: donationForwarderFactoryAbi as Abi,
      functionName: 'donate',
      args: [needId, NATIVE_TOKEN, eth],
      value: eth,
    })
    logConversion(ethDonation.receipt, 'DonatedWithConversion')
    tx(ctx.network, 'tx', ethDonation.hash)
  } else {
    note('ETH donations are off on this deployment (no WETH liquidity against the test tokens)')
  }

  step('An exchange withdrawal: USDC sent to a deposit address that commits to this need')
  const intent = {
    needId,
    receiptTo: zeroAddress, // an exchange cannot hold a receipt: the deposit address holds the claim
    refundTo: ctx.accounts.donor1.address,
    refundSigner: zeroAddress,
    salt: keccak256(stringToHex(`demo-deposit-${needId}-${Date.now()}`)),
  }
  const depositAddress = (await ctx.publicClient.readContract({
    address: factory,
    abi: donationForwarderFactoryAbi,
    functionName: 'forwarderAddress',
    args: [intent],
  })) as Address
  info('deposit address', depositAddress)
  note('nothing is deployed yet: the address is fixed by the intent (need, refund route, salt)')
  const raised = (await ctx.publicClient.readContract({
    address: vault,
    abi: aidVaultAbi,
    functionName: 'totalDonated',
    args: [],
  })) as bigint
  // Enough USDC to fill the need, plus 100 more: the part the need cannot take goes straight back.
  const unitsPerUsdc = await quote(usdc, 1_000_000n)
  const withdrawal = ((spec.target - raised) * 1_000_000n * 102n) / (unitsPerUsdc * 100n) + 100_000_000n
  await mintIfPossible(ctx, 'donor1', withdrawal, usdc)
  const sent = await send(ctx, 'donor1', {
    address: usdc,
    abi: mockEURCAbi as Abi,
    functionName: 'transfer',
    args: [depositAddress, withdrawal],
  })
  info('withdrawn to it', `${formatAmount(withdrawal)} USDC`)
  tx(ctx.network, 'transfer', sent.hash)

  step('The platform keeper sweeps it: deploy, donate what fills the need, return the rest')
  note("only the donor's own addresses or a registered keeper may sweep, so nobody can sandwich the swap")
  const sweep = await send(ctx, 'relayer', {
    address: factory,
    abi: donationForwarderFactoryAbi as Abi,
    functionName: 'sweep',
    args: [intent, usdc],
  })
  logConversion(sweep.receipt, 'Swept')
  const leftovers = parseEventLogs({
    abi: donationForwarderAbi,
    eventName: 'LeftoverRefunded',
    logs: sweep.receipt.logs,
  })
  for (const leftover of leftovers) {
    const symbol = tokenSymbolOf(ctx.deployment, leftover.args.token)
    info(`returned (${symbol})`, `${formatAmount(leftover.args.amount)} to the donor`)
  }
  note('only what the need could take was donated: the rest goes home in the token it came in')
  tx(ctx.network, 'tx', sweep.hash)
  await expectStatus(ctx, needId, 'Funded')

  step('Conversion costs count against the cost cap the NGO disclosed')
  const fees = (await ctx.publicClient.readContract({
    address: ctx.deployment.contracts.ProofOfAidResolver,
    abi: proofOfAidResolverAbi,
    functionName: 'fundingFeesOf',
    args: [needId],
  })) as bigint
  info('conversion costs', `${formatAmount(fees)} units (the euro and ETH swaps; USDC cost nothing)`)
  info('cap', `${spec.thirdPartyCostBps / 100}% of what donors paid`)
  note('a swap costing more than the cap allows reverts: the need never silently absorbs it')

  return [
    `need ${needId} (converted):  ${ctx.dashboardUrl}/en/needs/${needId}`,
    `  card donor tracking:      ${ctx.dashboardUrl}/en/track/${receiptId}`,
    `  deposit address tracking: ${ctx.dashboardUrl}/en/track/${depositAddress}`,
  ]
}

/** Prints what a converted donation did, from the vault's and the converter's events; returns the receipt id. */
const logConversion = (receipt: TransactionReceipt, eventName: 'DonatedWithConversion' | 'Swept'): bigint => {
  const [via] = parseEventLogs({ abi: aidVaultAbi, eventName: 'DonatedVia', logs: receipt.logs })
  if (!via) return fail('converted donation emitted no DonatedVia event')
  const [swap] =
    eventName === 'Swept'
      ? parseEventLogs({ abi: donationForwarderAbi, eventName: 'Swept', logs: receipt.logs })
      : parseEventLogs({
          abi: donationForwarderFactoryAbi,
          eventName: 'DonatedWithConversion',
          logs: receipt.logs,
        })
  if (!swap) return fail(`converted donation emitted no ${eventName} event`)
  info('swap output', `${formatAmount(swap.args.converted)} units`)
  info('fair value', `${formatAmount(swap.args.fairValue)} units`)
  info('donated', `${formatAmount(via.args.amount)} units`)
  info('conversion cost', `${formatAmount(via.args.conversionFee)} units`)
  if (via.args.receiptId > 0n) info('receipt', `#${via.args.receiptId}`)
  return via.args.receiptId
}

// ─── steps ───────────────────────────────────────────────────────────────────

const preflight = async (ctx: DemoContext): Promise<void> => {
  step('Preflight: the organizations are registered on-chain')
  const roleRegistry = ctx.deployment.contracts.RoleRegistry
  const read = (functionName: string, args: readonly unknown[]) =>
    ctx.publicClient.readContract({ address: roleRegistry, abi: roleRegistryAbi as Abi, functionName, args })

  const ngo = ctx.accounts.ngo.address
  const checks: [string, boolean][] = [
    ['NGO active', (await read('isActiveNgo', [ngo])) as boolean],
    [
      'verifier 1 independent',
      (await read('isIndependent', [ctx.accounts.verifier1.address, ngo])) as boolean,
    ],
    [
      'verifier 2 independent',
      (await read('isIndependent', [ctx.accounts.verifier2.address, ngo])) as boolean,
    ],
  ]
  for (const [label, ok] of checks) {
    info(label, ok ? 'yes' : 'NO')
    if (!ok) {
      fail(
        'the demo roles are not registered. Run `pnpm deploy:local` (anvil) or SeedDemo.s.sol (testnet) first.',
      )
    }
  }
}

/** The demo NGO's newest active programme: every need it registers belongs to one. */
const resolveProgram = async (ctx: DemoContext): Promise<bigint> => {
  step('The programme the demo needs belong to')
  const programs = ctx.deployment.contracts.ProgramRegistry
  const read = <T>(functionName: string, args: readonly unknown[] = []) =>
    ctx.publicClient.readContract({
      address: programs,
      abi: programRegistryAbi as Abi,
      functionName,
      args,
    }) as Promise<T>

  const programCount = await read<bigint>('programCount')
  for (let programId = programCount; programId >= 1n; programId -= 1n) {
    const owner = await read<Address>('programNgo', [programId])
    if (owner.toLowerCase() !== ctx.accounts.ngo.address.toLowerCase()) continue
    info('program', programId.toString())
    note('nobody is enrolled on chain: the NGO keeps its beneficiaries in its own encrypted records')
    return programId
  }
  return fail('the demo NGO has no programme on-chain. Re-run the seed script.')
}

const createNeed = async (ctx: DemoContext, programId: bigint, spec: NeedSpec): Promise<bigint> => {
  step(`NGO registers a need: ${spec.label}`)
  const now = await chainTime(ctx)
  const dossierHash = keccak256(stringToHex(`demo-dossier-${spec.category}-${Date.now()}`))
  const costDisclosure = `Conversion and payout costs for ${spec.label}, capped by contract`
  const params = {
    programId,
    category: categoryHash(spec.category),
    targetAmount: spec.target,
    regionCode: REGION,
    dossierHash,
    metadataURI: `ipfs://demo-need-${spec.category.toLowerCase()}`,
    verificationsRequired: 1,
    trancheBps: spec.trancheBps,
    fundingDeadline: now + BigInt(spec.fundingWindowSeconds),
    executionDeadline: now + BigInt(spec.executionWindowSeconds),
    minFundingBps: spec.minFundingBps,
    thirdPartyCostBps: spec.thirdPartyCostBps,
    expectedOutcomeHash: keccak256(stringToHex(spec.outcome)),
    costDisclosureHash: spec.thirdPartyCostBps === 0 ? zeroHash : keccak256(stringToHex(costDisclosure)),
    payees: paymentPlan(ctx, spec.trancheBps.length),
    releasePolicy: spec.releasePolicy ?? zeroAddress,
  }
  const { hash, receipt } = await send(ctx, 'ngo', {
    address: ctx.deployment.contracts.NeedsRegistry,
    abi: needsRegistryAbi as Abi,
    functionName: 'createNeed',
    args: [params],
  })
  const needId = eventArg<bigint>(receipt, needsRegistryAbi as Abi, 'NeedCreated', 'needId')
  info('need', needId.toString())
  info(
    'target',
    `${formatAmount(spec.target)} units, tranches ${spec.trancheBps.map((b) => b / 100).join(' / ')}%`,
  )
  info('minimum to go ahead', `${spec.minFundingBps / 100}% of the target`)
  info('cost cap', `${spec.thirdPartyCostBps / 100}% of what donors pay`)
  info('funding deadline', new Date(Number(params.fundingDeadline) * 1000).toISOString())
  note('the outcome, cost disclosure and category are committed in the NeedCreated event')
  tx(ctx.network, 'tx', hash)
  ctx.dossierHashByNeed.set(needId, dossierHash)
  return needId
}

const verifyNeed = async (ctx: DemoContext, needId: bigint): Promise<Address> => {
  step('An independent verifier attests the need: its ledger is cloned and funding opens')
  const dossierHash = ctx.dossierHashByNeed.get(needId)
  if (!dossierHash) return fail('internal: dossier hash missing')

  const { uid, hash } = await attest(ctx, 'verifier1', {
    schema: ctx.deployment.schemas.NeedVerified,
    recipient: ctx.deployment.contracts.NeedsRegistry,
    revocable: true,
    data: encodeSchemaData('NeedVerified', [
      needId,
      dossierHash,
      true,
      keccak256(stringToHex('verifier-report')),
    ]),
  })
  attestation(ctx.network, 'NeedVerified', uid)
  tx(ctx.network, 'tx', hash)

  const ledger = (await ctx.publicClient.readContract({
    address: ctx.deployment.contracts.NeedsRegistry,
    abi: needsRegistryAbi,
    functionName: 'vaultOf',
    args: [needId],
  })) as Address
  info('ledger', ledger)
  return ledger
}

/** A wallet donation into the vault; returns the receipt id, which is also the donor's tracking reference. */
const donateDirect = async (ctx: DemoContext, vault: Address, amount: bigint): Promise<bigint> => {
  await mintIfPossible(ctx, 'donor1', amount)
  await send(ctx, 'donor1', {
    address: ctx.deployment.external.Token,
    abi: mockEURCAbi as Abi,
    functionName: 'approve',
    args: [vault, amount],
  })
  const donation = await send(ctx, 'donor1', {
    address: vault,
    abi: aidVaultAbi as Abi,
    functionName: 'donate',
    args: [amount],
  })
  const receiptId = eventArg<bigint>(donation.receipt, aidVaultAbi as Abi, 'Donated', 'receiptId')
  info('wallet donation', `${formatAmount(amount)} units, receipt #${receiptId}`)
  tx(ctx.network, 'tx', donation.hash)
  return receiptId
}

/**
 * A card donation, the only kind there is: the Coinbase on-ramp buys USDC into the donor's own wallet, and one tap
 * donates it through the forwarder factory. Coinbase does not deliver on test networks, so the mock on-ramp mints
 * test USDC instead; on mainnet the purchase is Coinbase's hosted checkout and everything after it is identical.
 */
const donateByCard = async (
  ctx: DemoContext,
  role: 'donor1' | 'donor2',
  needId: bigint,
  amount: bigint,
): Promise<bigint> => {
  const usdc = ctx.deployment.external.USDC as Address
  const factory = ctx.deployment.contracts.DonationForwarderFactory as Address
  step("Card: the Coinbase on-ramp delivers USDC to the donor's own wallet")
  note('Coinbase does not deliver on test networks; the mock on-ramp mints test USDC instead')
  await mintIfPossible(ctx, role, amount, usdc)
  info('USDC in the wallet', formatAmount(amount))
  note('the donor owns that wallet, as Coinbase requires: no platform account ever holds the money')

  step('One tap gives it to the need, and the vaults hold USDC, so there is nothing to swap')
  await send(ctx, role, {
    address: usdc,
    abi: mockEURCAbi as Abi,
    functionName: 'approve',
    args: [factory, amount],
  })
  const card = await send(ctx, role, {
    address: factory,
    abi: donationForwarderFactoryAbi as Abi,
    functionName: 'donate',
    args: [needId, usdc, amount],
  })
  const receiptId = logConversion(card.receipt, 'DonatedWithConversion')
  tx(ctx.network, 'tx', card.hash)
  return receiptId
}

/**
 * The demo payment plan: the vault pays the food supplier 90% of every tranche directly, and the NGO keeps 10% for
 * its own transport and distribution costs (the contract caps the NGO's share at 25% of the need).
 */
const paymentPlan = (ctx: DemoContext, tranches: number) => [
  {
    account: ctx.accounts.foodSupplier.address,
    shareBps: Array.from({ length: tranches }, () => 9000),
    refHash: keccak256(stringToHex('demo-contract-food-kits-2026')),
    label: 'Mercados del Centro SL: food kits',
  },
  {
    account: zeroAddress,
    shareBps: Array.from({ length: tranches }, () => 1000),
    refHash: keccak256(stringToHex('demo-ngo-operations-budget')),
    label: 'NGO operations: transport and distribution staff',
  },
]

const releaseOnChain = async (ctx: DemoContext, vault: Address, index: number): Promise<void> => {
  step(
    index === 0
      ? 'Tranche 0 is released as pre-financing, straight to the payment plan'
      : `Tranche ${index} is released, straight to the payment plan`,
  )
  const { hash, receipt } = await send(ctx, 'relayer', {
    address: vault,
    abi: aidVaultAbi as Abi,
    functionName: 'releaseTranche',
    args: [BigInt(index)],
  })
  const amount = eventArg<bigint>(receipt, aidVaultAbi as Abi, 'TrancheReleased', 'amount')
  info('tranche', `${formatAmount(amount)} units`)
  for (const paid of parseEventLogs({ abi: aidVaultAbi, eventName: 'PayeePaid', logs: receipt.logs })) {
    const who =
      paid.args.payee.toLowerCase() === ctx.accounts.foodSupplier.address.toLowerCase()
        ? 'supplier (food kits)'
        : 'NGO operations share'
    info(`paid to ${who}`, `${formatAmount(paid.args.amount)} units`)
  }
  note("the NGO never holds the suppliers' money: the vault pays them directly")
  tx(ctx.network, 'tx', hash)
}

/**
 * The NGO accounts for the tranche it was paid — here, one receipt — and the voters vote on it in turn until the
 * need's release policy decides it. Approval makes the next tranche releasable in the deciding transaction; a
 * rejection sends the NGO back, and past its retries cancels the need. A signed vote goes through `voteBySig`,
 * sent by the relayer, so the voter pays no gas. Returns how the evidence ended.
 */
const runDelivery = async (
  ctx: DemoContext,
  needId: bigint,
  trancheIndex: number,
  voters: Voter[],
  expected: 'Approved' | 'Rejected' = 'Approved',
): Promise<'Open' | 'Approved' | 'Rejected'> => {
  step(`Tranche ${trancheIndex - 1} accounted for: the NGO files a receipt, and it is judged under the need's rule`)
  const deliveryManager = ctx.deployment.contracts.DeliveryManager
  const readManager = <T>(functionName: string, args: readonly unknown[]) =>
    ctx.publicClient.readContract({
      address: deliveryManager,
      abi: deliveryManagerAbi as Abi,
      functionName,
      args,
    }) as Promise<T>

  const file = await evidenceFile(ctx, needId, trancheIndex - 1)
  const manifest = buildManifest(
    `Tranche ${trancheIndex - 1} of need ${needId}: the supplier's invoice was paid and the goods delivered (demo).`,
    [file],
  )
  const submitted = await send(ctx, 'ngo', {
    address: deliveryManager,
    abi: deliveryManagerAbi as Abi,
    functionName: 'submitEvidence',
    args: [needId, manifest],
  })
  const deliveryId = eventArg<bigint>(
    submitted.receipt,
    deliveryManagerAbi as Abi,
    'DeliverySubmitted',
    'deliveryId',
  )
  info('evidence', `#${deliveryId}: ${file.name}, sha256 ${file.sha256.slice(0, 16)}…`)
  if (file.cid) info('pinned to IPFS', file.cid)
  if (file.url) note(`the receipt is served at ${ctx.dashboardUrl}${file.url}`)
  tx(ctx.network, 'filed', submitted.hash)
  if (voters.length === 0) {
    note('left for the voters: open the need page with a donor wallet to approve or reject it')
    return 'Open'
  }

  const rules = await readManager<{ donorApproval: bigint; donorRejection: bigint; verifierApproval: number }>(
    'rulesOf',
    [needId],
  )
  for (const voter of voters) {
    const current = await readManager<{ status: number }>('getDelivery', [deliveryId])
    if (current.status !== 0) break // no longer Open: decided
    const account = ctx.accounts[voter.role].address
    const [voiceValue, weight] = await readManager<readonly [number, bigint]>('voiceOf', [needId, account])
    const voice = voiceName(Number(voiceValue))
    if (voice === 'None') continue
    const functionName = voter.approve ? 'approve' : 'reject'
    const cast = voter.signed
      ? await signedVote(ctx, voter.role, deliveryId, voter.approve)
      : await send(ctx, voter.role, {
          address: deliveryManager,
          abi: deliveryManagerAbi as Abi,
          functionName,
          args: [deliveryId],
        })
    const say = voice === 'Verifier' ? 'as an independent verifier' : `weighing ${formatAmount(weight)} units`
    info(`${voter.role} ${voter.approve ? 'approves' : 'rejects'}`, voter.signed ? `${say}, signed for free` : say)
    tx(ctx.network, voter.approve ? 'approved' : 'rejected', cast.hash)
  }

  const delivery = await readManager<{ status: number; approvedAmount: bigint; rejectedAmount: bigint }>(
    'getDelivery',
    [deliveryId],
  )
  const outcome = delivery.status === 1 ? 'Approved' : delivery.status === 3 ? 'Rejected' : 'Open'
  if (outcome !== expected) fail(`the demo voters left the evidence ${outcome}, expected ${expected}`)
  if (outcome === 'Approved') {
    note(
      rules.donorApproval > 0n
        ? `donors who gave ${formatAmount(delivery.approvedAmount)} of the ${formatAmount(rules.donorApproval)} units required approved: tranche ${trancheIndex} is releasable`
        : `the verifiers approved: tranche ${trancheIndex} is releasable`,
    )
  } else {
    const strikes = await readManager<number>('strikesOf', [needId])
    note(`rejected: strike ${strikes} for this need`)
  }
  return outcome
}

/** Signs a vote as `role` (EIP-712) and has the relayer submit it: the voter never pays gas. */
const signedVote = async (ctx: DemoContext, role: RoleName, deliveryId: bigint, approve: boolean) => {
  const account = ctx.accounts[role]
  if (!account.signTypedData) return fail(`${role}'s account cannot sign typed data`)
  const deadline = BigInt(Math.floor(Date.now() / 1000) + VOTE_SIGNATURE_TTL_SECONDS)
  const signature = await account.signTypedData(
    voteTypedData({
      chainId: ctx.chain.id,
      deliveryManager: ctx.deployment.contracts.DeliveryManager,
      voter: account.address,
      deliveryId,
      approve,
      deadline,
    }),
  )
  return send(ctx, 'relayer', {
    address: ctx.deployment.contracts.DeliveryManager,
    abi: deliveryManagerAbi as Abi,
    functionName: 'voteBySig',
    args: [deliveryId, account.address, approve, deadline, signature],
  })
}

const publishImpactReport = async (
  ctx: DemoContext,
  needId: bigint,
  ledger: Address,
  beneficiariesServed: number,
): Promise<void> => {
  step('The need is complete: the NGO publishes a verifiable impact report')
  const report = await attest(ctx, 'ngo', {
    schema: ctx.deployment.schemas.ImpactReport,
    recipient: ledger,
    revocable: true,
    data: encodeSchemaData('ImpactReport', [
      needId,
      beneficiariesServed,
      keccak256(stringToHex(`kpis-${needId}`)),
      cidV1Raw(Buffer.from(`impact-report-${needId}`)),
    ]),
  })
  attestation(ctx.network, 'ImpactReport', report.uid)
  note('only the NGO can publish it, and only once every tranche has been paid')
}

// ─── helpers ─────────────────────────────────────────────────────────────────

const chainTime = async (ctx: DemoContext): Promise<bigint> => (await ctx.publicClient.getBlock()).timestamp

const expectStatus = async (ctx: DemoContext, needId: bigint, expected: keyof typeof NEED_STATUS_VALUE) => {
  const status = (await ctx.publicClient.readContract({
    address: ctx.deployment.contracts.NeedsRegistry,
    abi: needsRegistryAbi,
    functionName: 'statusOf',
    args: [needId],
  })) as number
  info('need status', needStatusName(status))
  if (status !== NEED_STATUS_VALUE[expected]) fail(`expected ${expected}, got ${needStatusName(status)}`)
}

const readDeadline = async (ctx: DemoContext, needId: bigint): Promise<bigint> => {
  const need = (await ctx.publicClient.readContract({
    address: ctx.deployment.contracts.NeedsRegistry,
    abi: needsRegistryAbi,
    functionName: 'getNeed',
    args: [needId],
  })) as { fundingDeadline: bigint }
  return need.fundingDeadline
}

/** Waits until the chain's clock passes `timestamp`: instantly on anvil, in real time elsewhere. */
const waitUntil = async (ctx: DemoContext, timestamp: bigint, label: string): Promise<void> => {
  const now = await chainTime(ctx)
  if (now >= timestamp) return
  const seconds = Number(timestamp - now)
  info(label, `${seconds}s`)
  await waitSeconds(ctx, seconds)
  while ((await chainTime(ctx)) < timestamp) await new Promise((resolve) => setTimeout(resolve, 3000))
}

const mintIfPossible = async (
  ctx: DemoContext,
  role: 'donor1' | 'donor2',
  amount: bigint,
  token: Address = ctx.deployment.external.Token,
): Promise<void> => {
  const balance = (await ctx.publicClient.readContract({
    address: token,
    abi: mockEURCAbi,
    functionName: 'balanceOf',
    args: [ctx.accounts[role].address],
  })) as bigint
  if (balance >= amount) return

  try {
    await send(ctx, role, {
      address: token,
      abi: mockEURCAbi as Abi,
      functionName: 'mint',
      args: [ctx.accounts[role].address, amount],
    })
  } catch {
    fail(
      `${role} holds ${formatAmount(balance)} units but needs ${formatAmount(amount)}, and the token is not ` +
        'mintable. Fund the account from a faucet and re-run.',
    )
  }
}

/**
 * A one-page receipt for the tranche, uploaded to the dashboard when it is running so the need page shows it (and
 * pinned to IPFS when the dashboard has a pinning key); the manifest commits to its SHA-256 either way.
 */
const evidenceFile = async (ctx: DemoContext, needId: bigint, spentTranche: number) => {
  const name = `receipt-need-${needId}-tranche-${spentTranche}.pdf`
  const bytes = demoPdf([
    'VerifAid demo receipt',
    `Need ${needId}, tranche ${spentTranche}`,
    'Paid to the supplier in the payment plan; goods delivered.',
    new Date().toISOString(),
  ])
  const local = {
    kind: 'receipt' as const,
    name,
    type: 'application/pdf',
    size: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    cid: undefined as string | undefined,
    url: '',
  }
  try {
    const body = new FormData()
    body.append('files', new Blob([bytes], { type: 'application/pdf' }), name)
    const response = await fetch(`${ctx.dashboardUrl}/api/uploads`, { method: 'POST', body })
    if (!response.ok) return local
    const uploaded = ((await response.json()) as { files: { sha256: string; cid?: string; url: string }[] })
      .files[0]
    // The dashboard pins to IPFS when it has a pinning key, and says so with the file's CID.
    return uploaded && uploaded.sha256 === local.sha256 ? { ...local, cid: uploaded.cid, url: uploaded.url } : local
  } catch {
    note('the dashboard is not running: the receipt is committed by hash only')
    return local
  }
}

/** A minimal, valid one-page PDF with a few lines of text. */
const demoPdf = (lines: string[]): Buffer => {
  const text = lines
    .map((line, i) => `BT /F1 12 Tf 50 ${740 - i * 20} Td (${line.replace(/[()\\]/g, '')}) Tj ET`)
    .join('\n')
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${Buffer.byteLength(text, 'latin1')} >>\nstream\n${text}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]
  let out = '%PDF-1.4\n'
  const offsets: number[] = []
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out, 'latin1'))
    out += `${i + 1} 0 obj\n${body}\nendobj\n`
  })
  const xref = Buffer.byteLength(out, 'latin1')
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  out += offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(out, 'latin1')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
