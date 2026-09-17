import {
  AID_RECEIVED_MESSAGE,
  aidVaultAbi,
  beneficiaryGroupsAbi,
  categoryHash,
  CUSTODY_MODE,
  conversionRouterAbi,
  type CustodyMode,
  deliveryManagerAbi,
  donationForwarderAbi,
  donationForwarderFactoryAbi,
  encodeSchemaData,
  formatAmount,
  mockEURCAbi,
  NEED_STATUS_VALUE,
  needStatusName,
  NATIVE_TOKEN,
  needsRegistryAbi,
  nonCustodialLedgerAbi,
  proofOfAidResolverAbi,
  regionCode,
  roleRegistryAbi,
  saltedRefHash,
  seal,
  semaphoreAbi,
} from '@poa/shared'
import { generateProof } from '@semaphore-protocol/proof'
import {
  type Abi,
  type Address,
  formatEther,
  type Hex,
  keccak256,
  parseEventLogs,
  stringToHex,
  type TransactionReceipt,
  toHex,
  zeroAddress,
  zeroHash,
} from 'viem'
import { attest, cidV1Raw, eventArg, send, waitChallengePeriod } from './chain.js'
import { createContext, type DemoContext } from './config.js'
import { buildGroup, type DemoIdentity, loadDemoIdentities } from './identities.js'
import { attestation, fail, heading, info, note, step, tx } from './log.js'

/**
 * Runs the Proof of Aid lifecycle against a live chain and prints an explorer link for every step, so a judge
 * can follow a need from "a verifier said this need is real" to "beneficiaries confirmed they received the aid,
 * and here is the money that moved because of it".
 *
 * Four scenarios, one per way a need can go or be paid for:
 *   1. On-chain custody (the proposal's Model B): stablecoin escrow, a wallet donor and a card donor, settlement
 *      reports after every release.
 *   2. Off-chain custody (Model A): a payment provider holds the money; its attestations count the funding and
 *      release every tranche. No token touches the ledger.
 *   3. A funding deadline passing below the NGO's minimum: the need expires and the donor is refunded.
 *   4. Conversions (v3): USDC bought by card lands in the donor's own wallet and is swapped into the vault token
 *      on-chain under the Chainlink bound; ETH from a wallet; USDC withdrawn from an exchange to a deposit address.
 *
 *   pnpm demo:run anvil            all four
 *   pnpm demo:run base-sepolia onchain offchain
 */

const EXPECTED_RECIPIENTS = 10
const REGION = regionCode('ES-CM')
const BPS = 10_000n

type Scenario = 'onchain' | 'offchain' | 'expiry' | 'conversion'
const SCENARIOS: Scenario[] = ['onchain', 'offchain', 'expiry', 'conversion']

interface NeedSpec {
  label: string
  category: string
  target: bigint
  trancheBps: number[]
  custodyMode: CustodyMode
  minFundingBps: number
  thirdPartyCostBps: number
  fundingWindowSeconds: number
  executionWindowSeconds: number
  outcome: string
}

interface Proofs {
  identities: DemoIdentity[]
  group: ReturnType<typeof buildGroup>
}

const main = async (): Promise<void> => {
  const [networkArg, ...rest] = process.argv.slice(2)
  const selected =
    rest.length > 0 ? rest.filter((s): s is Scenario => SCENARIOS.includes(s as Scenario)) : SCENARIOS
  const ctx = createContext(networkArg)
  const { contracts, external } = ctx.deployment

  heading('Proof of Aid v3 — lifecycle demo')
  info('network', ctx.network)
  info('rpc', ctx.rpcUrl)
  info('NeedsRegistry', contracts.NeedsRegistry)
  info('ProofOfAidResolver', contracts.ProofOfAidResolver)
  info('token', external.Token)
  info('scenarios', selected.join(', '))

  await preflight(ctx)
  const identities = loadDemoIdentities(ctx.identitySeed)
  const proofs: Proofs = { identities, group: buildGroup(identities) }
  const programId = await resolveProgram(ctx, proofs.group.root)

  const links: string[] = []
  if (selected.includes('onchain')) links.push(...(await onChainScenario(ctx, programId, proofs)))
  if (selected.includes('offchain')) links.push(...(await offChainScenario(ctx, programId, proofs)))
  if (selected.includes('expiry')) links.push(...(await expiryScenario(ctx, programId)))
  if (selected.includes('conversion')) {
    if (contracts.DonationForwarderFactory && contracts.ConversionRouter && external.USDC) {
      links.push(...(await conversionScenario(ctx, programId)))
    } else {
      note('skipping the conversion scenario: this deployment predates v3 (no DonationForwarderFactory)')
    }
  }

  heading('Done')
  for (const link of links) note(link)
  console.log('')
}

// ─── scenario 1: on-chain custody (Model B) ───────────────────────────────────

const onChainScenario = async (ctx: DemoContext, programId: bigint, proofs: Proofs): Promise<string[]> => {
  heading('1 · On-chain custody: escrowed stablecoin, released tranche by tranche')
  const spec: NeedSpec = {
    label: 'winter food kits',
    category: 'FOOD',
    target: 6_000_000_000n, // below the high-value threshold, so one verifier suffices
    trancheBps: [3000, 4000, 3000],
    custodyMode: 'OnChain',
    minFundingBps: 6000,
    thirdPartyCostBps: 150,
    fundingWindowSeconds: 30 * 86_400,
    executionWindowSeconds: 120 * 86_400,
    outcome: '400 families receive winter food kits in ES-CM; partial funding scales kits pro rata above 60%',
  }
  const needId = await createNeed(ctx, programId, spec, zeroAddress)
  const vault = await verifyNeed(ctx, needId)

  step('Donations: a wallet donor, and a card donor through the payment provider')
  const direct = 3_600_000_000n
  const receiptId = await donateDirect(ctx, vault, direct)
  const card = await providerDeposit(ctx, needId, vault, spec.target - direct, 'CARD')
  await expectStatus(ctx, needId, 'Funded')

  await releaseOnChain(ctx, vault, 0)
  await settle(ctx, 'ngo', needId, vault, 0, 30n)

  let lastSignOff: Hex | undefined
  for (let index = 1; index < spec.trancheBps.length; index += 1) {
    lastSignOff = await runDelivery(ctx, needId, index, proofs)
    await releaseOnChain(ctx, vault, index)
    await settle(ctx, 'ngo', needId, vault, index, 30n)
  }

  await expectStatus(ctx, needId, 'Completed')
  await publishImpactReport(ctx, needId, vault, lastSignOff, 400)
  return [
    `need ${needId} (on-chain):  ${ctx.dashboardUrl}/en/needs/${needId}`,
    `  wallet donor tracking:    ${ctx.dashboardUrl}/en/track/${receiptId}`,
    `  card donor tracking:      ${ctx.dashboardUrl}/en/track/${card}`,
    `  report:                   ${ctx.dashboardUrl}/api/reports/${needId}`,
  ]
}

// ─── scenario 2: off-chain custody (Model A) ──────────────────────────────────

const offChainScenario = async (ctx: DemoContext, programId: bigint, proofs: Proofs): Promise<string[]> => {
  heading('2 · Off-chain custody: the payment provider holds the money, the chain holds the rules')
  const spec: NeedSpec = {
    label: 'emergency cash transfers',
    category: 'CASH',
    target: 3_000_000_000n,
    trancheBps: [4000, 6000],
    custodyMode: 'OffChain',
    minFundingBps: 5000,
    thirdPartyCostBps: 250,
    fundingWindowSeconds: 30 * 86_400,
    executionWindowSeconds: 90 * 86_400,
    outcome:
      '60 households receive two cash transfers through the provider; below 50% funding the need expires',
  }
  const provider = ctx.accounts.bankPartner.address
  const needId = await createNeed(ctx, programId, spec, provider)
  const ledger = await verifyNeed(ctx, needId)
  note('no AidVault: the ledger records funding and releases, and never holds a token')

  step('Payments received by the provider, recorded on-chain by attestation')
  const cardRef = await providerRecord(ctx, needId, ledger, 1_000_000_000n, 150n, 'CARD')
  await providerRecord(ctx, needId, ledger, 2_000_000_000n, 0n, 'BANK')
  await expectStatus(ctx, needId, 'Funded')

  step('The provider pays out the pre-financing tranche; its Settlement attestation releases it on-chain')
  await settle(ctx, 'bankPartner', needId, ledger, 0, 50n)
  await expectStatus(ctx, needId, 'InDelivery')

  const signOff = await runDelivery(ctx, needId, 1, proofs)
  step('The verified delivery unlocks the final tranche; the provider settles it')
  await settle(ctx, 'bankPartner', needId, ledger, 1, 50n)
  await expectStatus(ctx, needId, 'Completed')

  await publishImpactReport(ctx, needId, ledger, signOff, 60)
  return [
    `need ${needId} (off-chain): ${ctx.dashboardUrl}/en/needs/${needId}`,
    `  card donor tracking:      ${ctx.dashboardUrl}/en/track/${cardRef}`,
    `  embeddable widget:        ${ctx.dashboardUrl}/en/embed/track/${cardRef}`,
  ]
}

// ─── scenario 3: expiry below the minimum ─────────────────────────────────────

const expiryScenario = async (ctx: DemoContext, programId: bigint): Promise<string[]> => {
  heading('3 · A deadline passes below the minimum: the need expires and donors get their money back')
  // Long enough to verify and donate before it passes on a public testnet, short enough to wait for.
  const window = ctx.isLocal ? 3_600 : 150
  const spec: NeedSpec = {
    label: 'school supplies',
    category: 'EDUCATION',
    target: 5_000_000_000n,
    trancheBps: [5000, 5000],
    custodyMode: 'OnChain',
    minFundingBps: 5000,
    thirdPartyCostBps: 0,
    fundingWindowSeconds: window,
    executionWindowSeconds: window * 20,
    outcome: 'school supplies for 200 pupils; all or nothing below 50%',
  }
  const needId = await createNeed(ctx, programId, spec, zeroAddress)
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

// ─── scenario 4: conversions (v3) ─────────────────────────────────────────────

const conversionScenario = async (ctx: DemoContext, programId: bigint): Promise<string[]> => {
  heading('4 · Full blockchain mode: card-bought USDC, ETH and an exchange withdrawal, converted on-chain')
  const factory = ctx.deployment.contracts.DonationForwarderFactory as Address
  const router = ctx.deployment.contracts.ConversionRouter as Address
  const usdc = ctx.deployment.external.USDC as Address
  const token = ctx.deployment.external.Token
  const maxSlippageBps = BigInt(ctx.deployment.params.maxSlippageBps ?? 100)
  const spec: NeedSpec = {
    label: 'water purification tablets',
    category: 'WATER',
    target: 4_000_000_000n,
    trancheBps: [5000, 5000],
    custodyMode: 'OnChain',
    minFundingBps: 10_000,
    // Swaps cost something (pool fee, price impact): the NGO discloses it and the contract caps it.
    thirdPartyCostBps: 150,
    fundingWindowSeconds: 30 * 86_400,
    executionWindowSeconds: 90 * 86_400,
    outcome: 'water purification tablets for 1 000 households; all or nothing',
  }
  const needId = await createNeed(ctx, programId, spec, zeroAddress)
  const vault = await verifyNeed(ctx, needId)
  const quote = (tokenIn: Address, amountIn: bigint) =>
    ctx.publicClient.readContract({
      address: router,
      abi: conversionRouterAbi,
      functionName: 'quote',
      args: [tokenIn, amountIn, token],
    }) as Promise<bigint>

  step("Card: Coinbase Onramp delivers USDC to the donor's own wallet")
  const bought = 2_000_000_000n
  note('Coinbase Onramp does not deliver on test networks; the mock on-ramp mints test USDC instead')
  await mintIfPossible(ctx, 'donor1', bought, usdc)
  info('USDC in the wallet', formatAmount(bought))
  note('the donor owns that wallet, as Coinbase requires: no platform account ever holds the money')

  step('One tap: the factory swaps the USDC on Uniswap v3 and donates, bounded by Chainlink')
  const fair = await quote(usdc, bought)
  info('fair value', `${formatAmount(fair)} units (Chainlink EUR/USD and USDC/USD)`)
  info('minimum accepted', `${formatAmount((fair * (BPS - maxSlippageBps)) / BPS)} units, or it reverts`)
  await send(ctx, 'donor1', {
    address: usdc,
    abi: mockEURCAbi as Abi,
    functionName: 'approve',
    args: [factory, bought],
  })
  const card = await send(ctx, 'donor1', {
    address: factory,
    abi: donationForwarderFactoryAbi as Abi,
    functionName: 'donate',
    args: [needId, usdc, bought],
  })
  const receiptId = logConversion(card.receipt, 'DonatedWithConversion')
  tx(ctx.network, 'tx', card.hash)

  if (ctx.deployment.params.ethDonations) {
    step('A wallet donates ETH: routed ETH → USDC → vault token in the same transaction')
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

  step('Anyone sweeps it: deploy, convert, donate up to the target, return the rest')
  const sweep = await send(ctx, 'relayer', {
    address: factory,
    abi: donationForwarderFactoryAbi as Abi,
    functionName: 'sweep',
    args: [intent, usdc],
  })
  logConversion(sweep.receipt, 'Swept')
  const [leftover] = parseEventLogs({
    abi: donationForwarderAbi,
    eventName: 'LeftoverRefunded',
    logs: sweep.receipt.logs,
  })
  if (leftover)
    info('sent back to the donor', `${formatAmount(leftover.args.amount)} units of the vault token`)
  tx(ctx.network, 'tx', sweep.hash)
  await expectStatus(ctx, needId, 'Funded')

  step('Conversion costs count against the cost cap the NGO disclosed')
  const fees = (await ctx.publicClient.readContract({
    address: ctx.deployment.contracts.ProofOfAidResolver,
    abi: proofOfAidResolverAbi,
    functionName: 'fundingFeesOf',
    args: [needId],
  })) as bigint
  info('conversion costs', `${formatAmount(fees)} units`)
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
    ['field agent bound', (await read('isFieldAgentOf', [ctx.accounts.fieldAgent.address, ngo])) as boolean],
    [
      'verifier 1 independent',
      (await read('isIndependent', [ctx.accounts.verifier1.address, ngo])) as boolean,
    ],
    [
      'verifier 2 independent',
      (await read('isIndependent', [ctx.accounts.verifier2.address, ngo])) as boolean,
    ],
    [
      'payment provider registered',
      (await read('hasRole', [
        keccak256(stringToHex('BANK_PARTNER_ROLE')),
        ctx.accounts.bankPartner.address,
      ])) as boolean,
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

/** Finds the seeded program whose on-chain Merkle root matches the identities this script can prove with. */
const resolveProgram = async (ctx: DemoContext, expectedRoot: bigint): Promise<bigint> => {
  step('Beneficiary program: the group this demo can produce real proofs for')
  const groups = ctx.deployment.contracts.BeneficiaryGroups
  const read = <T>(functionName: string, args: readonly unknown[] = []) =>
    ctx.publicClient.readContract({
      address: groups,
      abi: beneficiaryGroupsAbi as Abi,
      functionName,
      args,
    }) as Promise<T>

  const programCount = await read<bigint>('programCount')
  for (let programId = programCount; programId >= 1n; programId -= 1n) {
    const owner = await read<Address>('programNgo', [programId])
    if (owner.toLowerCase() !== ctx.accounts.ngo.address.toLowerCase()) continue
    const groupId = await read<bigint>('getGroupId', [programId])
    const root = (await ctx.publicClient.readContract({
      address: ctx.deployment.external.Semaphore,
      abi: semaphoreAbi,
      functionName: 'getMerkleTreeRoot',
      args: [groupId],
    })) as bigint
    if (root !== expectedRoot) continue

    info('program', programId.toString())
    info('semaphore group', groupId.toString())
    info('members enrolled', (await read<bigint>('memberCount', [programId])).toString())
    note('the on-chain Merkle root matches the demo identities, so their proofs will verify')
    return programId
  }
  return fail(
    'no program on-chain matches the demo identities. Re-run the seed script, or regenerate identities.',
  )
}

const createNeed = async (
  ctx: DemoContext,
  programId: bigint,
  spec: NeedSpec,
  custodian: Address,
): Promise<bigint> => {
  step(`NGO registers a need: ${spec.label}`)
  const now = await chainTime(ctx)
  const dossierHash = keccak256(stringToHex(`demo-dossier-${spec.category}-${Date.now()}`))
  const costDisclosure = `Card and bank processing, FX and payout fees for ${spec.label}, capped by contract`
  const params = {
    programId,
    category: categoryHash(spec.category),
    targetAmount: spec.target,
    regionCode: REGION,
    dossierHash,
    metadataURI: `ipfs://demo-need-${spec.category.toLowerCase()}`,
    verificationsRequired: 1,
    trancheBps: spec.trancheBps,
    custodyMode: CUSTODY_MODE.indexOf(spec.custodyMode),
    custodian,
    fundingDeadline: now + BigInt(spec.fundingWindowSeconds),
    executionDeadline: now + BigInt(spec.executionWindowSeconds),
    minFundingBps: spec.minFundingBps,
    thirdPartyCostBps: spec.thirdPartyCostBps,
    expectedOutcomeHash: keccak256(stringToHex(spec.outcome)),
    costDisclosureHash: spec.thirdPartyCostBps === 0 ? zeroHash : keccak256(stringToHex(costDisclosure)),
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
    'custody',
    spec.custodyMode === 'OnChain' ? 'on-chain vault (Model B)' : `payment provider ${custodian} (Model A)`,
  )
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

/** Provider's per-payment references, salted so the chain carries a commitment only the provider can open. */
const paymentRefs = (kind: string) => {
  const salt = toSalt(process.env.BANK_REF_SALT)
  const endToEndId = `${kind}-DEMO-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  return {
    endToEndId,
    paymentRefHash: saltedRefHash(salt, endToEndId),
    donorRefHash: saltedRefHash(salt, `donor-${kind.toLowerCase()}-${Date.now()}`),
  }
}

/** On-chain custody: the provider converts a card payment, deposits it, then attests gross, fee and net. */
const providerDeposit = async (
  ctx: DemoContext,
  needId: bigint,
  vault: Address,
  net: bigint,
  kind: 'CARD' | 'BANK',
): Promise<Hex> => {
  const fee = (net * 100n) / BPS // 1% processing fee, within the need's disclosed cap
  const refs = paymentRefs(kind)
  await mintIfPossible(ctx, 'bankPartner', net)
  await send(ctx, 'bankPartner', {
    address: ctx.deployment.external.Token,
    abi: mockEURCAbi as Abi,
    functionName: 'approve',
    args: [vault, net],
  })
  const deposit = await send(ctx, 'bankPartner', {
    address: vault,
    abi: aidVaultAbi as Abi,
    functionName: 'donateOnBehalf',
    args: [net, refs.donorRefHash, refs.paymentRefHash],
  })
  info(
    `${kind.toLowerCase()} donation`,
    `donor paid ${formatAmount(net + fee)}, fee ${formatAmount(fee)}, ${formatAmount(net)} deposited`,
  )
  tx(ctx.network, 'deposit', deposit.hash)

  const recorded = await attest(ctx, 'bankPartner', {
    schema: ctx.deployment.schemas.FundingRecorded,
    recipient: vault,
    revocable: false,
    data: encodeSchemaData('FundingRecorded', [
      needId,
      net + fee,
      fee,
      net,
      regionCode('EUR'),
      refs.paymentRefHash,
      refs.donorRefHash,
    ]),
  })
  attestation(ctx.network, 'FundingRecorded', recorded.uid)
  note('only salted hashes of the payment and donor references reach the chain')
  return refs.paymentRefHash
}

/** Off-chain custody: the custodian attests a payment it holds; that attestation is the funding record. */
const providerRecord = async (
  ctx: DemoContext,
  needId: bigint,
  ledger: Address,
  net: bigint,
  feeBps: bigint,
  kind: 'CARD' | 'BANK',
): Promise<Hex> => {
  const fee = (net * feeBps) / BPS
  const refs = paymentRefs(kind)
  const recorded = await attest(ctx, 'bankPartner', {
    schema: ctx.deployment.schemas.FundingRecorded,
    recipient: ledger,
    revocable: false,
    data: encodeSchemaData('FundingRecorded', [
      needId,
      net + fee,
      fee,
      net,
      regionCode('EUR'),
      refs.paymentRefHash,
      refs.donorRefHash,
    ]),
  })
  const raised = (await ctx.publicClient.readContract({
    address: ledger,
    abi: nonCustodialLedgerAbi,
    functionName: 'totalDonated',
  })) as bigint
  info(
    `${kind.toLowerCase()} payment held`,
    `${formatAmount(net)} net (fee ${formatAmount(fee)}); raised ${formatAmount(raised)}`,
  )
  attestation(ctx.network, 'FundingRecorded', recorded.uid)
  tx(ctx.network, 'tx', recorded.hash)
  return refs.paymentRefHash
}

const releaseOnChain = async (ctx: DemoContext, vault: Address, index: number): Promise<void> => {
  step(index === 0 ? 'Tranche 0 is released as pre-financing' : `Tranche ${index} is released`)
  const { hash, receipt } = await send(ctx, 'relayer', {
    address: vault,
    abi: aidVaultAbi as Abi,
    functionName: 'releaseTranche',
    args: [BigInt(index)],
  })
  const amount = eventArg<bigint>(receipt, aidVaultAbi as Abi, 'TrancheReleased', 'amount')
  info('paid to the NGO payout Safe', `${formatAmount(amount)} units`)
  tx(ctx.network, 'tx', hash)
}

/**
 * A Settlement attestation for one tranche: gross is the whole tranche, fee what intermediaries kept on the way to
 * suppliers. On-chain custody the NGO reports it after the release; off-chain custody the custodian's report is
 * what releases the tranche.
 */
const settle = async (
  ctx: DemoContext,
  role: 'ngo' | 'bankPartner',
  needId: bigint,
  ledger: Address,
  index: number,
  feeBps: bigint,
): Promise<void> => {
  const tranches = (await ctx.publicClient.readContract({
    address: ledger,
    abi: aidVaultAbi,
    functionName: 'getTranches',
  })) as readonly { amount: bigint }[]
  const gross = tranches[index]?.amount ?? fail(`tranche ${index} not found`)
  const fee = (gross * feeBps) / BPS
  const report = await attest(ctx, role, {
    schema: ctx.deployment.schemas.Settlement,
    recipient: ledger,
    revocable: false,
    data: encodeSchemaData('Settlement', [
      needId,
      BigInt(index),
      gross,
      fee,
      gross - fee,
      keccak256(stringToHex(`supplier-invoice-${needId}-${index}`)),
      keccak256(stringToHex('ECB-EUR-reference-rate')),
    ]),
  })
  info(`tranche ${index} settled`, `${formatAmount(gross - fee)} to suppliers, ${formatAmount(fee)} in fees`)
  attestation(ctx.network, 'Settlement', report.uid)
}

const runDelivery = async (
  ctx: DemoContext,
  needId: bigint,
  trancheIndex: number,
  proofs: Proofs,
): Promise<Hex> => {
  step(`Delivery for tranche ${trancheIndex}: evidence, anonymous confirmations, independent sign-off`)
  const deliveryManager = ctx.deployment.contracts.DeliveryManager

  const opened = await send(ctx, 'fieldAgent', {
    address: deliveryManager,
    abi: deliveryManagerAbi as Abi,
    functionName: 'openDelivery',
    args: [needId, BigInt(trancheIndex), EXPECTED_RECIPIENTS],
  })
  const deliveryId = eventArg<bigint>(
    opened.receipt,
    deliveryManagerAbi as Abi,
    'DeliveryOpened',
    'deliveryId',
  )
  info('delivery', deliveryId.toString())
  tx(ctx.network, 'opened', opened.hash)

  // Evidence: encrypted before it leaves the device; only the ciphertext hash and its CID go on-chain.
  const { evidenceHash, cid } = await sealEvidence(ctx, deliveryId, trancheIndex)
  const evidence = await attest(ctx, 'fieldAgent', {
    schema: ctx.deployment.schemas.DeliveryEvidence,
    recipient: deliveryManager,
    revocable: false,
    data: encodeSchemaData('DeliveryEvidence', [deliveryId, evidenceHash, cid, 120, REGION]),
  })
  info('evidence CID', cid)
  attestation(ctx.network, 'DeliveryEvidence', evidence.uid)

  // Beneficiaries confirm anonymously; a relayer submits every proof in one transaction, so no beneficiary's
  // wallet ever appears on-chain.
  const required = Math.ceil((EXPECTED_RECIPIENTS * ctx.deployment.params.confirmationThresholdBps) / 10_000)
  note(`generating ${required} zero-knowledge receipt proofs (${EXPECTED_RECIPIENTS} expected recipients)`)
  const batch = []
  for (let i = 0; i < required; i += 1) {
    const entry = proofs.identities[i] ?? fail('not enough demo identities for the confirmation threshold')
    const proof = await generateProof(entry.identity, proofs.group, AID_RECEIVED_MESSAGE, deliveryId)
    batch.push({
      merkleTreeDepth: BigInt(proof.merkleTreeDepth),
      merkleTreeRoot: BigInt(proof.merkleTreeRoot),
      nullifier: BigInt(proof.nullifier),
      message: BigInt(proof.message),
      scope: BigInt(proof.scope),
      points: proof.points.map((point: string | bigint) => BigInt(point)) as unknown as readonly bigint[],
    })
    process.stdout.write(`\r    proofs generated: ${i + 1}/${required}   `)
  }
  process.stdout.write('\n')
  const confirmed = await send(ctx, 'relayer', {
    address: deliveryManager,
    abi: deliveryManagerAbi as Abi,
    functionName: 'confirmReceiptBatch',
    args: [deliveryId, batch],
  })
  info('confirmations', `${required} in one relayed transaction`)
  tx(ctx.network, 'confirmed', confirmed.hash)
  note('each confirmation reveals a nullifier and nothing else: not who, not where')

  const signOff = await attest(ctx, 'verifier2', {
    schema: ctx.deployment.schemas.DeliveryVerified,
    recipient: deliveryManager,
    revocable: false,
    refUID: evidence.uid,
    data: encodeSchemaData('DeliveryVerified', [
      deliveryId,
      true,
      keccak256(stringToHex('spot-check-report')),
    ]),
  })
  attestation(ctx.network, 'DeliveryVerified', signOff.uid)

  const challengePeriod = ctx.deployment.params.challengePeriodSeconds
  info('challenge window', `${challengePeriod}s: any independent verifier can dispute`)
  await waitChallengePeriod(ctx, challengePeriod)

  const finalized = await send(ctx, 'relayer', {
    address: deliveryManager,
    abi: deliveryManagerAbi as Abi,
    functionName: 'finalize',
    args: [deliveryId],
  })
  tx(ctx.network, 'finalized', finalized.hash)
  return signOff.uid
}

const publishImpactReport = async (
  ctx: DemoContext,
  needId: bigint,
  ledger: Address,
  lastVerifierUID: Hex | undefined,
  beneficiariesServed: number,
): Promise<void> => {
  step('The need is complete: the NGO publishes a verifiable impact report')
  const report = await attest(ctx, 'ngo', {
    schema: ctx.deployment.schemas.ImpactReport,
    recipient: ledger,
    revocable: true,
    refUID: lastVerifierUID,
    data: encodeSchemaData('ImpactReport', [
      needId,
      beneficiariesServed,
      keccak256(stringToHex(`kpis-${needId}`)),
      cidV1Raw(Buffer.from(`impact-report-${needId}`)),
    ]),
  })
  attestation(ctx.network, 'ImpactReport', report.uid)
  note('it can only reference the last verified delivery: an unverified report cannot be published')
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
  await waitChallengePeriod(ctx, seconds)
  while ((await chainTime(ctx)) < timestamp) await new Promise((resolve) => setTimeout(resolve, 3000))
}

/**
 * The partner's reference salt: a 32-byte hex value is used as is, anything else (including an env var that is
 * present but empty, which is not the same as unset) is hashed into one.
 */
const toSalt = (value: string | undefined): Hex => {
  const trimmed = value?.trim()
  if (trimmed && /^0x[0-9a-fA-F]{64}$/.test(trimmed)) return trimmed as Hex
  return keccak256(stringToHex(trimmed || 'demo-bank-salt'))
}

const mintIfPossible = async (
  ctx: DemoContext,
  role: 'donor1' | 'bankPartner',
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
 * Seals the delivery evidence and returns exactly what goes on-chain: the hash of the ciphertext and its CID.
 * The demo encrypts locally to stay self-contained; the field-agent page does the same thing through the
 * evidence service, which additionally strips image metadata and pins the ciphertext to IPFS.
 */
const sealEvidence = async (
  ctx: DemoContext,
  deliveryId: bigint,
  trancheIndex: number,
): Promise<{ evidenceHash: Hex; cid: string }> => {
  if (ctx.evidenceServiceUrl) {
    note(`evidence service configured at ${ctx.evidenceServiceUrl}; the /field page uploads through it`)
  }
  const manifest = {
    deliveryId: deliveryId.toString(),
    trancheIndex,
    itemsDelivered: 120,
    regionCode: 'ES-CM',
    capturedAt: new Date().toISOString(),
    note: 'demo evidence bundle: distribution manifest and photos with metadata stripped',
  }
  const bundle = Buffer.from(JSON.stringify({ manifest, files: [{ name: 'manifest.json', bytes: 0 }] }))
  const dek = Buffer.from(keccak256(stringToHex(`demo-dek-${deliveryId}`)).slice(2), 'hex')
  const ciphertext = seal(dek, bundle)
  return { evidenceHash: keccak256(toHex(ciphertext)), cid: cidV1Raw(ciphertext) }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
