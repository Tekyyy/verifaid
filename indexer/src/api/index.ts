import { db, publicClients } from 'ponder:api'
import schema from 'ponder:schema'
import {
  categoryHash,
  categoryLabel,
  type DeliveryStatus,
  type DeliveryView,
  type DonationView,
  type DonorReceiptTrace,
  type DonorTrace,
  type DonorTrancheSlice,
  getDeployment,
  type ImpactBucket,
  type ImpactReportView,
  type ImpactSummary,
  type NeedDetail,
  type NeedStatus,
  type NeedSummary,
  type ProgramMembersResponse,
  regionCode as regionCodeOf,
  regionLabel,
  resolveNetwork,
  semaphoreAbi,
  type TimelineEvent,
  type TimelineEventType,
  type TrancheStatus,
  type TrancheView,
} from '@poa/shared'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { and, asc, eq, graphql } from 'ponder'
import type { Address, Hex } from 'viem'

/**
 * The read API the dashboard and the demo runner consume. Every response is one of the types exported by
 * @poa/shared, with bigints serialized as decimal strings in token base units (6 decimals).
 *
 * Nothing here can expose a beneficiary: the only person-adjacent data indexed at all are Semaphore identity
 * commitments (public, unlinkable, and required to build a Merkle proof) and confirmation counts.
 */

const network = resolveNetwork(process.env.PONDER_NETWORK ?? 'anvil')
const deployment = getDeployment(network)
const client = publicClients[network]
if (!client) throw new Error(`Ponder exposes no public client for chain "${network}"`)

/**
 * Live tree depth from Semaphore. Falls back to the LeanIMT depth for `leaves` leaves — what
 * `@semaphore-protocol/group` computes client-side — if the RPC is unavailable.
 */
const merkleTreeDepth = async (groupId: bigint, leaves: number): Promise<number> => {
  try {
    const depth = await client.readContract({
      abi: semaphoreAbi,
      address: deployment.external.Semaphore,
      functionName: 'getMerkleTreeDepth',
      args: [groupId],
    })
    return Number(depth)
  } catch {
    return leaves <= 1 ? leaves : Math.ceil(Math.log2(leaves))
  }
}

const app = new Hono()

// Permissive CORS: everything served here is already public on-chain, and the Next.js dev server calls it
// from another origin. Ponder's own server applies the same middleware today; stating it here keeps the
// dashboard working if that default ever changes. Methods are left at Hono's defaults so /graphql can POST.
app.use('*', cors({ origin: '*', maxAge: 86_400 }))

app.use('/graphql', graphql({ db, schema }))

// ─── row → API type ──────────────────────────────────────────────────────────

type NeedRow = typeof schema.need.$inferSelect
type TrancheRow = typeof schema.tranche.$inferSelect
type DeliveryRow = typeof schema.delivery.$inferSelect
type DonationRow = typeof schema.donation.$inferSelect
type TimelineRow = typeof schema.timelineEvent.$inferSelect
type ImpactReportRow = typeof schema.impactReport.$inferSelect

const toNeedSummary = (row: NeedRow): NeedSummary => ({
  id: row.id.toString(),
  ngo: row.ngo as Address,
  // The NGO's display name lives in the off-chain profile JSON at metadataURI; only the URI is on-chain.
  ngoName: null,
  programId: row.programId.toString(),
  category: row.category,
  categoryLabel: categoryLabel(row.category as Hex),
  regionCode: row.regionCode,
  regionLabel: regionLabel(row.regionCode as Hex),
  targetAmount: row.targetAmount.toString(),
  totalDonated: row.totalDonated.toString(),
  totalReleased: row.totalReleased.toString(),
  status: row.status as NeedStatus,
  vault: (row.vault as Address | null) ?? null,
  metadataURI: row.metadataURI,
  verificationsRequired: row.verificationsRequired,
  verificationCount: row.verificationCount,
  createdAt: row.createdAt,
})

const toTrancheView = (row: TrancheRow): TrancheView => ({
  index: row.index,
  bps: row.bps,
  amount: row.amount.toString(),
  status: row.status as TrancheStatus,
  deliveryId: row.deliveryId?.toString() ?? null,
  releasedAt: row.releasedAt,
  releaseTxHash: (row.releaseTxHash as Hex | null) ?? null,
})

/** `amount` stays the real tranche; `donorShare` is this donor's slice of it. Never conflate the two. */
const toDonorTrancheSlice = (row: TrancheRow, donorShare: bigint): DonorTrancheSlice => ({
  ...toTrancheView(row),
  donorShare: donorShare.toString(),
})

const toDeliveryView = (row: DeliveryRow): DeliveryView => ({
  id: row.id.toString(),
  needId: row.needId.toString(),
  trancheIndex: row.trancheIndex,
  fieldAgent: row.fieldAgent as Address,
  expectedRecipients: row.expectedRecipients,
  confirmations: row.confirmations,
  confirmationRatio:
    row.expectedRecipients === 0
      ? 0
      : Math.round((row.confirmations / row.expectedRecipients) * 10_000) / 10_000,
  status: row.status as DeliveryStatus,
  evidenceUID: (row.evidenceUID as Hex | null) ?? null,
  evidenceCID: row.evidenceCID,
  verifierUID: (row.verifierUID as Hex | null) ?? null,
  verifier: (row.verifier as Address | null) ?? null,
  challengeDeadline: row.challengeDeadline,
})

const toDonationView = (row: DonationRow): DonationView => ({
  id: row.id,
  needId: row.needId.toString(),
  kind: row.kind as 'DIRECT' | 'FIAT',
  donor: (row.donor as Address | null) ?? null,
  donorRefHash: (row.donorRefHash as Hex | null) ?? null,
  paymentRefHash: (row.paymentRefHash as Hex | null) ?? null,
  amount: row.amount.toString(),
  receiptId: row.receiptId?.toString() ?? null,
  attestationUID: (row.attestationUID as Hex | null) ?? null,
  txHash: row.txHash as Hex,
  timestamp: row.timestamp,
})

const toTimelineEvent = (row: TimelineRow): TimelineEvent => ({
  id: row.id,
  needId: row.needId.toString(),
  type: row.type as TimelineEventType,
  data: row.data as TimelineEvent['data'],
  attestationUID: (row.attestationUID as Hex | null) ?? null,
  txHash: row.txHash as Hex,
  blockNumber: Number(row.blockNumber),
  timestamp: row.timestamp,
})

const toImpactReportView = (row: ImpactReportRow): ImpactReportView => ({
  needId: row.needId.toString(),
  uid: row.uid as Hex,
  beneficiariesServed: row.beneficiariesServed,
  kpiHash: row.kpiHash as Hex,
  reportCID: row.reportCID,
  revoked: row.revoked,
  timestamp: row.timestamp,
})

/** Query params accept either the human label ("FOOD", "ES-CM") or the raw bytes32 the contracts store. */
const asBytes32 = (value: string, encode: (label: string) => Hex): Hex | null => {
  const trimmed = value.trim()
  if (!trimmed) return null
  if (trimmed.startsWith('0x')) return trimmed.toLowerCase() as Hex
  try {
    return encode(trimmed).toLowerCase() as Hex
  } catch {
    return null
  }
}

// ─── needs ───────────────────────────────────────────────────────────────────

app.get('/needs', async (c) => {
  const filters = []

  const status = c.req.query('status')
  if (status) filters.push(eq(schema.need.status, status))

  const category = c.req.query('category')
  if (category) {
    const hash = asBytes32(category, categoryHash)
    if (!hash) return c.json({ error: 'invalid category' }, 400)
    filters.push(eq(schema.need.category, hash))
  }

  const region = c.req.query('region')
  if (region) {
    const hash = asBytes32(region, regionCodeOf)
    if (!hash) return c.json({ error: 'invalid region' }, 400)
    filters.push(eq(schema.need.regionCode, hash))
  }

  const rows = await db
    .select()
    .from(schema.need)
    .where(filters.length ? and(...filters) : undefined)
    .orderBy(asc(schema.need.id))

  return c.json(rows.map(toNeedSummary) satisfies NeedSummary[])
})

app.get('/needs/:id', async (c) => {
  const id = parseId(c.req.param('id'))
  if (id === null) return c.json({ error: 'invalid need id' }, 400)

  const [row] = await db.select().from(schema.need).where(eq(schema.need.id, id)).limit(1)
  if (!row) return c.json({ error: 'need not found' }, 404)

  const [tranches, deliveries, donations, reports] = await Promise.all([
    db.select().from(schema.tranche).where(eq(schema.tranche.needId, id)).orderBy(asc(schema.tranche.index)),
    db.select().from(schema.delivery).where(eq(schema.delivery.needId, id)).orderBy(asc(schema.delivery.id)),
    db
      .select()
      .from(schema.donation)
      .where(eq(schema.donation.needId, id))
      .orderBy(asc(schema.donation.timestamp)),
    db.select().from(schema.impactReport).where(eq(schema.impactReport.needId, id)),
  ])

  const live = reports.find((report) => !report.revoked) ?? reports[0]

  return c.json({
    ...toNeedSummary(row),
    tranches: tranches.map((tranche) => toTrancheView(tranche)),
    deliveries: deliveries.map(toDeliveryView),
    donations: donations.map(toDonationView),
    impactReport: live ? toImpactReportView(live) : null,
  } satisfies NeedDetail)
})

app.get('/needs/:id/timeline', async (c) => {
  const id = parseId(c.req.param('id'))
  if (id === null) return c.json({ error: 'invalid need id' }, 400)

  const rows = await db
    .select()
    .from(schema.timelineEvent)
    .where(eq(schema.timelineEvent.needId, id))
    .orderBy(asc(schema.timelineEvent.blockNumber), asc(schema.timelineEvent.logIndex))

  return c.json(rows.map(toTimelineEvent) satisfies TimelineEvent[])
})

// ─── donors ──────────────────────────────────────────────────────────────────

/**
 * "Follow my money". For every receipt the donor holds: the need it funded, the donor's share of that need's
 * funding, each tranche with both its real amount and this donor's slice of it, and the deliveries whose
 * confirmations unlocked those releases.
 */
app.get('/donors/:address/trace', async (c) => {
  const address = c.req.param('address').toLowerCase()
  if (!/^0x[0-9a-f]{40}$/.test(address)) return c.json({ error: 'invalid address' }, 400)
  const donor = address as Address

  const receipts = await db
    .select()
    .from(schema.receipt)
    .where(eq(schema.receipt.owner, donor))
    .orderBy(asc(schema.receipt.id))

  const traces: DonorReceiptTrace[] = []
  let totalDonated = 0n

  for (const receipt of receipts) {
    totalDonated += receipt.amount

    const [need] = await db.select().from(schema.need).where(eq(schema.need.id, receipt.needId)).limit(1)
    if (!need) continue

    const [tranches, deliveries, refunds] = await Promise.all([
      db
        .select()
        .from(schema.tranche)
        .where(eq(schema.tranche.needId, need.id))
        .orderBy(asc(schema.tranche.index)),
      db
        .select()
        .from(schema.delivery)
        .where(eq(schema.delivery.needId, need.id))
        .orderBy(asc(schema.delivery.id)),
      db
        .select()
        .from(schema.refund)
        .where(and(eq(schema.refund.needId, need.id), eq(schema.refund.account, donor))),
    ])

    // Shares are pro-rata of what the vault actually collected, which is frozen once funding closes.
    const funded = need.totalDonated
    const share = (amount: bigint): bigint => (funded === 0n ? 0n : (amount * receipt.amount) / funded)

    let releasedToNgo = 0n
    const donorTranches = tranches.map((tranche) => {
      const slice = share(tranche.amount)
      if (tranche.status === 'Released') releasedToNgo += slice
      return toDonorTrancheSlice(tranche, slice)
    })

    traces.push({
      receiptId: receipt.id.toString(),
      needId: need.id.toString(),
      needStatus: need.status as NeedStatus,
      category: need.category,
      regionCode: need.regionCode,
      amount: receipt.amount.toString(),
      shareBps: funded === 0n ? 0 : Number((receipt.amount * 10_000n) / funded),
      releasedToNgo: releasedToNgo.toString(),
      refunded: refunds.reduce((sum, refund) => sum + refund.amount, 0n).toString(),
      tranches: donorTranches,
      deliveries: deliveries.map(toDeliveryView),
    })
  }

  return c.json({ donor, totalDonated: totalDonated.toString(), receipts: traces } satisfies DonorTrace)
})

// ─── impact ──────────────────────────────────────────────────────────────────

app.get('/impact/summary', async (c) => {
  const [needs, deliveries, reports, confirmations] = await Promise.all([
    db.select().from(schema.need),
    db.select().from(schema.delivery),
    db.select().from(schema.impactReport),
    db.select({ id: schema.confirmation.id }).from(schema.confirmation),
  ])

  const finalizedByNeed = new Map<string, number>()
  for (const delivery of deliveries) {
    if (delivery.status !== 'Finalized') continue
    const key = delivery.needId.toString()
    finalizedByNeed.set(key, (finalizedByNeed.get(key) ?? 0) + 1)
  }

  // Revoked reports are excluded: `beneficiariesServed` must reflect live attestations only.
  const servedByNeed = new Map<string, number>()
  for (const report of reports) {
    if (report.revoked) continue
    const key = report.needId.toString()
    servedByNeed.set(key, (servedByNeed.get(key) ?? 0) + report.beneficiariesServed)
  }

  const bucket = (key: string, label: string): ImpactBucketAcc => ({
    key,
    label,
    needs: 0,
    donated: 0n,
    released: 0n,
    deliveriesFinalized: 0,
    beneficiariesServed: 0,
  })

  const byCategory = new Map<string, ImpactBucketAcc>()
  const byRegion = new Map<string, ImpactBucketAcc>()

  let donated = 0n
  let released = 0n
  let refunded = 0n
  let needsCompleted = 0

  for (const need of needs) {
    const key = need.id.toString()
    const finalized = finalizedByNeed.get(key) ?? 0
    const served = servedByNeed.get(key) ?? 0

    donated += need.totalDonated
    released += need.totalReleased
    refunded += need.totalRefunded
    if (need.status === 'Completed') needsCompleted += 1

    for (const [map, code, label] of [
      [byCategory, need.category, categoryLabel(need.category as Hex)],
      [byRegion, need.regionCode, regionLabel(need.regionCode as Hex)],
    ] as const) {
      const acc = map.get(code) ?? bucket(code, label)
      acc.needs += 1
      acc.donated += need.totalDonated
      acc.released += need.totalReleased
      acc.deliveriesFinalized += finalized
      acc.beneficiariesServed += served
      map.set(code, acc)
    }
  }

  return c.json({
    totals: {
      needs: needs.length,
      needsCompleted,
      donated: donated.toString(),
      released: released.toString(),
      refunded: refunded.toString(),
      deliveriesFinalized: deliveries.filter((delivery) => delivery.status === 'Finalized').length,
      confirmations: confirmations.length,
      beneficiariesServed: [...servedByNeed.values()].reduce((sum, value) => sum + value, 0),
    },
    byCategory: [...byCategory.values()].map(serializeBucket),
    byRegion: [...byRegion.values()].map(serializeBucket),
  } satisfies ImpactSummary)
})

// ─── programs ────────────────────────────────────────────────────────────────

/**
 * Identity commitments in insertion order, so the beneficiary page can rebuild the Semaphore group and
 * produce a Merkle proof whose root matches the on-chain tree. Removed members keep their leaf as "0",
 * exactly like the on-chain LeanIMT, otherwise every subsequent proof would be invalid.
 */
app.get('/programs/:id/members', async (c) => {
  const id = parseId(c.req.param('id'))
  if (id === null) return c.json({ error: 'invalid program id' }, 400)

  const [program] = await db.select().from(schema.program).where(eq(schema.program.id, id)).limit(1)
  if (!program) return c.json({ error: 'program not found' }, 404)

  const members = await db
    .select()
    .from(schema.programMember)
    .where(eq(schema.programMember.programId, id))
    .orderBy(asc(schema.programMember.leafIndex))

  return c.json({
    programId: program.id.toString(),
    groupId: program.groupId.toString(),
    memberCount: program.memberCount,
    members: members.map((member) => member.commitment.toString()),
    merkleTreeDepth: await merkleTreeDepth(program.groupId, members.length),
  } satisfies ProgramMembersResponse)
})

// ─── deliveries ──────────────────────────────────────────────────────────────

/** The verifier queue: `?status=Open` is what needs a sign-off, `?status=Challengeable` what can be disputed. */
app.get('/deliveries', async (c) => {
  const status = c.req.query('status')
  const rows = await db
    .select()
    .from(schema.delivery)
    .where(status ? eq(schema.delivery.status, status) : undefined)
    .orderBy(asc(schema.delivery.id))

  return c.json(rows.map(toDeliveryView) satisfies DeliveryView[])
})

// ─── helpers ─────────────────────────────────────────────────────────────────

interface ImpactBucketAcc {
  key: string
  label: string
  needs: number
  donated: bigint
  released: bigint
  deliveriesFinalized: number
  beneficiariesServed: number
}

const serializeBucket = (acc: ImpactBucketAcc): ImpactBucket => ({
  key: acc.key,
  label: acc.label,
  needs: acc.needs,
  donated: acc.donated.toString(),
  released: acc.released.toString(),
  deliveriesFinalized: acc.deliveriesFinalized,
  beneficiariesServed: acc.beneficiariesServed,
})

function parseId(value: string): bigint | null {
  if (!/^\d+$/.test(value)) return null
  try {
    return BigInt(value)
  } catch {
    return null
  }
}

export default app
