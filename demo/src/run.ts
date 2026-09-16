import {
  AID_RECEIVED_MESSAGE,
  aidVaultAbi,
  beneficiaryGroupsAbi,
  categoryHash,
  deliveryManagerAbi,
  encodeSchemaData,
  formatAmount,
  mockEURCAbi,
  needsRegistryAbi,
  regionCode,
  roleRegistryAbi,
  saltedRefHash,
  seal,
  semaphoreAbi,
} from '@poa/shared'
import { generateProof } from '@semaphore-protocol/proof'
import { type Abi, type Address, type Hex, keccak256, stringToHex, toHex } from 'viem'
import { attest, cidV1Raw, eventArg, send, waitChallengePeriod } from './chain.js'
import { createContext, type DemoContext } from './config.js'
import { buildGroup, type DemoIdentity, loadDemoIdentities } from './identities.js'
import { attestation, fail, heading, info, note, step, tx } from './log.js'

/**
 * Runs the entire Proof of Aid lifecycle (spec §7) against a live chain and prints an explorer link for every
 * step, so a judge can follow one need from "a verifier said this need is real" to "beneficiaries confirmed
 * they received the aid, and here is the money that moved because of it".
 */

const TARGET = 6_000_000_000n // 6,000 units at 6 decimals — below the high-value threshold, so one verifier
const DIRECT_DONATION = 3_600_000_000n
const FIAT_DONATION = TARGET - DIRECT_DONATION
const EXPECTED_RECIPIENTS = 10
const REGION = regionCode('ES-CM')

const main = async (): Promise<void> => {
  const ctx = createContext(process.argv[2])
  const { contracts, external, params } = ctx.deployment

  heading('Proof of Aid — full lifecycle demo')
  info('network', ctx.network)
  info('rpc', ctx.rpcUrl)
  info('NeedsRegistry', contracts.NeedsRegistry)
  info('DeliveryManager', contracts.DeliveryManager)
  info('token', external.Token)

  await preflight(ctx)

  const identities = loadDemoIdentities(ctx.identitySeed)
  const group = buildGroup(identities)
  const programId = await resolveProgram(ctx, group.root)

  const needId = await createNeed(ctx, programId)
  const vault = await verifyNeed(ctx, needId)
  await fundNeed(ctx, needId, vault)
  await releasePreFinancing(ctx, needId, vault)

  const trancheCount = Number(
    await ctx.publicClient.readContract({ address: vault, abi: aidVaultAbi, functionName: 'trancheCount' }),
  )
  let lastVerifierUID: Hex | undefined
  for (let trancheIndex = 1; trancheIndex < trancheCount; trancheIndex += 1) {
    lastVerifierUID = await runDelivery(
      ctx,
      needId,
      vault,
      trancheIndex,
      identities,
      group,
      params.challengePeriodSeconds,
    )
  }

  await publishImpactReport(ctx, needId, vault, lastVerifierUID)
  await summarize(ctx, needId, vault)
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
  const programCount = (await ctx.publicClient.readContract({
    address: groups,
    abi: beneficiaryGroupsAbi,
    functionName: 'programCount',
  })) as bigint

  for (let programId = programCount; programId >= 1n; programId -= 1n) {
    const owner = (await ctx.publicClient.readContract({
      address: groups,
      abi: beneficiaryGroupsAbi,
      functionName: 'programNgo',
      args: [programId],
    })) as Address
    if (owner.toLowerCase() !== ctx.accounts.ngo.address.toLowerCase()) continue

    const groupId = (await ctx.publicClient.readContract({
      address: groups,
      abi: beneficiaryGroupsAbi,
      functionName: 'getGroupId',
      args: [programId],
    })) as bigint
    const root = (await ctx.publicClient.readContract({
      address: ctx.deployment.external.Semaphore,
      abi: semaphoreAbi,
      functionName: 'getMerkleTreeRoot',
      args: [groupId],
    })) as bigint

    if (root === expectedRoot) {
      const memberCount = (await ctx.publicClient.readContract({
        address: groups,
        abi: beneficiaryGroupsAbi,
        functionName: 'memberCount',
        args: [programId],
      })) as bigint
      info('program', programId.toString())
      info('semaphore group', groupId.toString())
      info('members enrolled', memberCount.toString())
      note('the on-chain Merkle root matches the demo identities, so their proofs will verify')
      return programId
    }
  }
  return fail(
    'no program on-chain matches the demo identities. Re-run the seed script, or regenerate identities.',
  )
}

const createNeed = async (ctx: DemoContext, programId: bigint): Promise<bigint> => {
  step('NGO registers a need with a 30 / 40 / 30 tranche plan')
  const dossierHash = keccak256(stringToHex(`demo-dossier-${Date.now()}`))
  const { hash, receipt } = await send(ctx, 'ngo', {
    address: ctx.deployment.contracts.NeedsRegistry,
    abi: needsRegistryAbi as Abi,
    functionName: 'createNeed',
    args: [
      {
        programId,
        category: categoryHash('FOOD'),
        targetAmount: TARGET,
        regionCode: REGION,
        dossierHash,
        metadataURI: 'ipfs://demo-need-food-winter-kits',
        verificationsRequired: 1,
        trancheBps: [3000, 4000, 3000],
      },
    ],
  })
  const needId = eventArg<bigint>(receipt, needsRegistryAbi as Abi, 'NeedCreated', 'needId')
  info('need', needId.toString())
  info('target', `${formatAmount(TARGET)} units`)
  info('dossier hash', dossierHash)
  note('the assessment itself stays encrypted off-chain; only its hash is public')
  tx(ctx.network, 'tx', hash)
  ctx.dossierHashByNeed.set(needId, dossierHash)
  return needId
}

const verifyNeed = async (ctx: DemoContext, needId: bigint): Promise<Address> => {
  step('An independent verifier attests the need — this deploys its vault and opens funding')
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

  const vault = (await ctx.publicClient.readContract({
    address: ctx.deployment.contracts.NeedsRegistry,
    abi: needsRegistryAbi,
    functionName: 'vaultOf',
    args: [needId],
  })) as Address
  info('vault', vault)
  return vault
}

const fundNeed = async (ctx: DemoContext, needId: bigint, vault: Address): Promise<void> => {
  step('Donations: one crypto donor and one fiat donor through a bank partner')
  const token = ctx.deployment.external.Token

  await mintIfPossible(ctx, 'donor1', DIRECT_DONATION)
  await send(ctx, 'donor1', {
    address: token,
    abi: mockEURCAbi as Abi,
    functionName: 'approve',
    args: [vault, DIRECT_DONATION],
  })
  const donation = await send(ctx, 'donor1', {
    address: vault,
    abi: aidVaultAbi as Abi,
    functionName: 'donate',
    args: [DIRECT_DONATION],
  })
  info('direct donation', `${formatAmount(DIRECT_DONATION)} units from donor 1`)
  tx(ctx.network, 'tx', donation.hash)

  // The bank partner converts a SEPA transfer and deposits it on behalf of a donor it never names on-chain.
  const salt = (process.env.BANK_REF_SALT as Hex | undefined) ?? keccak256(stringToHex('demo-bank-salt'))
  const endToEndId = `SEPA-DEMO-${Date.now()}`
  const paymentRefHash = saltedRefHash(salt, endToEndId)
  const donorRefHash = saltedRefHash(salt, 'donor-reference-jane')

  await mintIfPossible(ctx, 'bankPartner', FIAT_DONATION)
  await send(ctx, 'bankPartner', {
    address: token,
    abi: mockEURCAbi as Abi,
    functionName: 'approve',
    args: [vault, FIAT_DONATION],
  })
  const fiat = await send(ctx, 'bankPartner', {
    address: vault,
    abi: aidVaultAbi as Abi,
    functionName: 'donateOnBehalf',
    args: [FIAT_DONATION, donorRefHash, paymentRefHash],
  })
  info('fiat donation', `${formatAmount(FIAT_DONATION)} units, reference ${endToEndId}`)
  note('only salted hashes of the payment and donor references reach the chain')
  tx(ctx.network, 'tx', fiat.hash)

  const fiatAttestation = await attest(ctx, 'bankPartner', {
    schema: ctx.deployment.schemas.FiatDonation,
    recipient: vault,
    revocable: false,
    data: encodeSchemaData('FiatDonation', [needId, FIAT_DONATION, paymentRefHash, donorRefHash]),
  })
  attestation(ctx.network, 'FiatDonation', fiatAttestation.uid)

  const closed = (await ctx.publicClient.readContract({
    address: vault,
    abi: aidVaultAbi,
    functionName: 'fundingClosed',
  })) as boolean
  info('funding closed', closed ? 'yes, target reached' : 'no')
}

const releasePreFinancing = async (ctx: DemoContext, needId: bigint, vault: Address): Promise<void> => {
  step('Tranche 0 is released as pre-financing so the NGO can buy the goods')
  const { hash } = await send(ctx, 'relayer', {
    address: vault,
    abi: aidVaultAbi as Abi,
    functionName: 'releaseTranche',
    args: [0n],
  })
  const paid = (await ctx.publicClient.readContract({
    address: ctx.deployment.external.Token,
    abi: mockEURCAbi,
    functionName: 'balanceOf',
    args: [ctx.accounts.ngoPayout.address],
  })) as bigint
  info('paid to NGO payout', `${formatAmount(paid)} units (cumulative)`)
  info('need status', 'InDelivery')
  tx(ctx.network, 'tx', hash)
  void needId
}

const runDelivery = async (
  ctx: DemoContext,
  needId: bigint,
  vault: Address,
  trancheIndex: number,
  identities: DemoIdentity[],
  group: ReturnType<typeof buildGroup>,
  challengePeriodSeconds: number,
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
  const { evidenceHash, cid } = await uploadEvidence(ctx, deliveryId, trancheIndex)
  const evidence = await attest(ctx, 'fieldAgent', {
    schema: ctx.deployment.schemas.DeliveryEvidence,
    recipient: deliveryManager,
    revocable: false,
    data: encodeSchemaData('DeliveryEvidence', [deliveryId, evidenceHash, cid, 120, REGION]),
  })
  info('evidence hash', evidenceHash)
  info('evidence CID', cid)
  attestation(ctx.network, 'DeliveryEvidence', evidence.uid)

  // Beneficiaries confirm anonymously. Proofs are generated here, but relayed by a third party so that no
  // beneficiary's wallet ever appears in a transaction.
  const required = Math.ceil((EXPECTED_RECIPIENTS * ctx.deployment.params.confirmationThresholdBps) / 10_000)
  note(`generating ${required} zero-knowledge receipt proofs (${EXPECTED_RECIPIENTS} expected recipients)`)
  for (let i = 0; i < required; i += 1) {
    const entry = identities[i]
    if (!entry) return fail('not enough demo identities for the confirmation threshold')
    const proof = await generateProof(entry.identity, group, AID_RECEIVED_MESSAGE, deliveryId)
    await send(ctx, 'relayer', {
      address: deliveryManager,
      abi: deliveryManagerAbi as Abi,
      functionName: 'confirmReceipt',
      args: [
        deliveryId,
        {
          merkleTreeDepth: BigInt(proof.merkleTreeDepth),
          merkleTreeRoot: BigInt(proof.merkleTreeRoot),
          nullifier: BigInt(proof.nullifier),
          message: BigInt(proof.message),
          scope: BigInt(proof.scope),
          points: proof.points.map((point: string | bigint) => BigInt(point)) as unknown as readonly bigint[],
        },
      ],
    })
    process.stdout.write(`\r    confirmations: ${i + 1}/${required}   `)
  }
  process.stdout.write('\n')
  note('each confirmation reveals a nullifier and nothing else — not who, not where')

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
  note('sign-off references the evidence attestation, so the chain of evidence is traversable in EAS')

  info('challenge window', `${challengePeriodSeconds}s — any independent verifier can dispute`)
  await waitChallengePeriod(ctx, challengePeriodSeconds)

  const finalized = await send(ctx, 'relayer', {
    address: deliveryManager,
    abi: deliveryManagerAbi as Abi,
    functionName: 'finalize',
    args: [deliveryId],
  })
  tx(ctx.network, 'finalized', finalized.hash)

  const released = await send(ctx, 'relayer', {
    address: vault,
    abi: aidVaultAbi as Abi,
    functionName: 'releaseTranche',
    args: [BigInt(trancheIndex)],
  })
  const paid = (await ctx.publicClient.readContract({
    address: ctx.deployment.external.Token,
    abi: mockEURCAbi,
    functionName: 'balanceOf',
    args: [ctx.accounts.ngoPayout.address],
  })) as bigint
  info('tranche released', `${formatAmount(paid)} units paid to the NGO so far`)
  tx(ctx.network, 'released', released.hash)

  return signOff.uid
}

const publishImpactReport = async (
  ctx: DemoContext,
  needId: bigint,
  vault: Address,
  lastVerifierUID: Hex | undefined,
): Promise<void> => {
  step('The need is complete: the NGO publishes a verifiable impact report')
  const status = (await ctx.publicClient.readContract({
    address: ctx.deployment.contracts.NeedsRegistry,
    abi: needsRegistryAbi,
    functionName: 'statusOf',
    args: [needId],
  })) as number
  info('need status', status === 5 ? 'Completed' : `unexpected (${status})`)

  const report = await attest(ctx, 'ngo', {
    schema: ctx.deployment.schemas.ImpactReport,
    recipient: vault,
    revocable: true,
    refUID: lastVerifierUID,
    data: encodeSchemaData('ImpactReport', [
      needId,
      EXPECTED_RECIPIENTS * 4,
      keccak256(stringToHex('kpis-winter-kits')),
      cidV1Raw(Buffer.from(`impact-report-${needId}`)),
    ]),
  })
  attestation(ctx.network, 'ImpactReport', report.uid)
  note('it can only reference the last verified delivery — an unverified report cannot be published')
}

const summarize = async (ctx: DemoContext, needId: bigint, vault: Address): Promise<void> => {
  const totals = (await ctx.publicClient.readContract({
    address: vault,
    abi: aidVaultAbi,
    functionName: 'totalDonated',
  })) as bigint
  const released = (await ctx.publicClient.readContract({
    address: vault,
    abi: aidVaultAbi,
    functionName: 'totalReleased',
  })) as bigint

  heading('Done — one need, followed end to end')
  info('need', needId.toString())
  info('donated', `${formatAmount(totals)} units`)
  info('released to the NGO', `${formatAmount(released)} units`)
  console.log('')
  note(`dashboard:  ${ctx.dashboardUrl}/needs/${needId}`)
  note(`timeline:   ${ctx.indexerUrl}/needs/${needId}/timeline`)
  note(`donor view: ${ctx.dashboardUrl}/donor`)
  console.log('')
}

// ─── helpers ─────────────────────────────────────────────────────────────────

const mintIfPossible = async (
  ctx: DemoContext,
  role: 'donor1' | 'bankPartner',
  amount: bigint,
): Promise<void> => {
  const token = ctx.deployment.external.Token
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
const uploadEvidence = async (
  ctx: DemoContext,
  deliveryId: bigint,
  trancheIndex: number,
): Promise<{ evidenceHash: Hex; cid: string }> => {
  if (ctx.evidenceServiceUrl) {
    note(`evidence service configured at ${ctx.evidenceServiceUrl} — the /field page uploads through it`)
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
