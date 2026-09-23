import { db } from 'ponder:api'
import schema from 'ponder:schema'
import {
  categoryHash,
  categoryLabel,
  type DeliveryView,
  type DepositAddressView,
  type DonationTrack,
  type DonorReceiptTrace,
  type DonorTrace,
  type ImpactBucket,
  type ImpactSummary,
  NEED_SORTS,
  type NeedBadges,
  type NeedDetail,
  type NeedPresentationView,
  type NeedSort,
  type NeedStatus,
  type NeedSummary,
  type OrgTaxStatusView,
  type ProgramView,
  payeeChangeApprovalsRequired,
  type ReleasePolicyView,
  regionCode as regionCodeOf,
  regionLabel,
  type SupplierApplicationView,
  type SupplierDetail,
  type SupplierView,
  type TimelineEvent,
  type TimelinePage,
  trackingRefKind,
} from '@poa/shared'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { and, asc, desc, eq, graphql, gt, inArray, isNull, or } from 'ponder'
import type { Address, Hex } from 'viem'
import { renderRss } from './rss.js'
import { buildDonationTrack } from './track.js'
import {
  combineSweeps,
  type DonationRow,
  fundingGapOf,
  liveReport,
  type NeedRow,
  toDeliveryView,
  toDepositAddressView,
  toDonationView,
  toDonorTrancheSlice,
  toImpactReportView,
  toNeedPresentationView,
  toNeedSummary,
  toOrgTaxStatusView,
  toPayeeChangeView,
  toPayeePaymentView,
  toPayeeView,
  toReleasePolicyView,
  toSettlementView,
  toSupplierApplicationView,
  toSupplierView,
  toTimelineEvent,
  toTrancheView,
  toWorkPhotoView,
} from './views.js'

/**
 * The read API the dashboard, the notifier and the demo runner consume. Every response is one of the types
 * exported by @poa/shared, with bigints serialized as decimal strings in token base units (6 decimals).
 *
 * Nothing here can expose a beneficiary: none is indexed at all. Donors appear as the wallets that gave and voted,
 * already public on chain.
 */

const app = new Hono()

// Permissive CORS: everything served here is already public on-chain, and the Next.js dev server calls it
// from another origin. Ponder's own server applies the same middleware today; stating it here keeps the
// dashboard working if that default ever changes. Methods are left at Hono's defaults so /graphql can POST.
app.use('*', cors({ origin: '*', maxAge: 86_400 }))

app.use('/graphql', graphql({ db, schema }))

/** Links in feeds and alerts point at the public dashboard. */
const APP_BASE_URL = (process.env.APP_BASE_URL ?? 'http://localhost:3000').replace(/\/$/, '')

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

/**
 * `?status=&category=&region=&country=&open=true&sort=urgency|gap|newest`.
 * `urgency` puts needs that are still raising money first, soonest funding deadline first (open-ended ones after
 * the dated ones), then the largest funding gap; everything else follows, newest first.
 */
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

  const country = c.req.query('country')
  if (country) {
    if (!/^[A-Za-z]{2}$/.test(country)) return c.json({ error: 'invalid country' }, 400)
    filters.push(eq(schema.need.country, country.toUpperCase()))
  }

  const sort = (c.req.query('sort') ?? '') as NeedSort | ''
  if (sort && !(NEED_SORTS as readonly string[]).includes(sort)) return c.json({ error: 'invalid sort' }, 400)

  let rows = await db
    .select()
    .from(schema.need)
    .where(filters.length ? and(...filters) : undefined)
    .orderBy(asc(schema.need.id))

  const now = Math.floor(Date.now() / 1000)
  if (c.req.query('open') === 'true') rows = rows.filter((row) => isOpenForFunding(row, now))
  if (sort) rows = sortNeeds(rows, sort, now)

  const [badges, presentations, taxStatus, policies] = await Promise.all([
    badgesFor(rows),
    presentationsFor(rows),
    taxStatusFor(rows),
    policyIndex(),
  ])
  return c.json(
    rows.map((row) => ({
      ...toNeedSummary(row, policies),
      badges: badges.get(row.id) ?? EMPTY_BADGES,
      presentation: presentations.get(row.id) ?? null,
      taxStatus: taxStatus.get(row.ngo.toLowerCase()) ?? null,
    })) satisfies NeedSummary[],
  )
})

/** The tax standing of every organisation behind these needs, keyed by its address. */
const taxStatusFor = async (rows: NeedRow[]): Promise<Map<string, OrgTaxStatusView>> => {
  if (rows.length === 0) return new Map()
  const orgs = [...new Set(rows.map((row) => row.ngo.toLowerCase() as Address))]
  const found = await db
    .select()
    .from(schema.orgTaxStatus)
    .where(and(inArray(schema.orgTaxStatus.org, orgs), eq(schema.orgTaxStatus.revoked, false)))
  return new Map(found.map((row) => [row.org.toLowerCase(), toOrgTaxStatusView(row)]))
}

/** How each of these needs is presented, when its NGO has published anything. */
const presentationsFor = async (rows: NeedRow[]): Promise<Map<bigint, NeedPresentationView>> => {
  if (rows.length === 0) return new Map()
  const found = await db
    .select()
    .from(schema.needPresentation)
    .where(
      inArray(
        schema.needPresentation.needId,
        rows.map((row) => row.id),
      ),
    )
  return new Map(found.map((row) => [row.needId, toNeedPresentationView(row)]))
}

/** Zero history: an NGO that has never released anything gets no payout record, not a bad one. */
const EMPTY_BADGES: NeedBadges = {
  workPhotos: 0,
  payoutAccuracyBps: null,
  needsCompleted: 0,
  needsTotal: 0,
}

/**
 * What every need's card says about the organisation behind it, computed per NGO in two passes over the needs
 * it has run: how much of what it released actually reached a payee (the rest is still held because a token
 * refused it), and how many of its needs completed. Plus the photos it published for this particular need.
 */
const badgesFor = async (rows: NeedRow[]): Promise<Map<bigint, NeedBadges>> => {
  if (rows.length === 0) return new Map()
  const ngos = [...new Set(rows.map((row) => row.ngo.toLowerCase() as Address))]

  const theirNeeds = await db.select().from(schema.need).where(inArray(schema.need.ngo, ngos))
  const needIds = theirNeeds.map((need) => need.id)
  const held = needIds.length
    ? await db.select().from(schema.payee).where(inArray(schema.payee.needId, needIds))
    : []
  const photos = await db
    .select()
    .from(schema.workPhotos)
    .where(
      and(
        inArray(
          schema.workPhotos.needId,
          rows.map((row) => row.id),
        ),
        eq(schema.workPhotos.revoked, false),
      ),
    )

  const heldByNeed = new Map<bigint, bigint>()
  for (const payee of held) {
    heldByNeed.set(payee.needId, (heldByNeed.get(payee.needId) ?? 0n) + payee.held)
  }

  const perNgo = new Map<string, { released: bigint; held: bigint; completed: number; total: number }>()
  for (const need of theirNeeds) {
    const key = need.ngo.toLowerCase()
    const entry = perNgo.get(key) ?? { released: 0n, held: 0n, completed: 0, total: 0 }
    entry.released += need.totalReleased
    entry.held += heldByNeed.get(need.id) ?? 0n
    entry.total += 1
    if (need.status === 'Completed') entry.completed += 1
    perNgo.set(key, entry)
  }

  const photoCount = new Map<bigint, number>()
  for (const row of photos) photoCount.set(row.needId, (photoCount.get(row.needId) ?? 0) + 1)

  return new Map(
    rows.map((row) => {
      const record = perNgo.get(row.ngo.toLowerCase())
      const reached = record && record.released > 0n ? record.released - record.held : null
      return [
        row.id,
        {
          workPhotos: photoCount.get(row.id) ?? 0,
          payoutAccuracyBps:
            reached === null || !record?.released ? null : Number((reached * 10_000n) / record.released),
          needsCompleted: record?.completed ?? 0,
          needsTotal: record?.total ?? 0,
        },
      ]
    }),
  )
}

app.get('/needs/:id', async (c) => {
  const id = parseId(c.req.param('id'))
  if (id === null) return c.json({ error: 'invalid need id' }, 400)

  const [row] = await db.select().from(schema.need).where(eq(schema.need.id, id)).limit(1)
  if (!row) return c.json({ error: 'need not found' }, 404)

  const [tranches, deliveries, donations, settlements, reports, payees, payments, changes] =
    await Promise.all([
      db
        .select()
        .from(schema.tranche)
        .where(eq(schema.tranche.needId, id))
        .orderBy(asc(schema.tranche.index)),
      db
        .select()
        .from(schema.delivery)
        .where(eq(schema.delivery.needId, id))
        .orderBy(asc(schema.delivery.id)),
      db
        .select()
        .from(schema.donation)
        .where(eq(schema.donation.needId, id))
        .orderBy(asc(schema.donation.timestamp)),
      db
        .select()
        .from(schema.settlement)
        .where(eq(schema.settlement.needId, id))
        .orderBy(asc(schema.settlement.trancheIndex)),
      db.select().from(schema.impactReport).where(eq(schema.impactReport.needId, id)),
      db.select().from(schema.payee).where(eq(schema.payee.needId, id)).orderBy(asc(schema.payee.index)),
      db
        .select()
        .from(schema.payeePayment)
        .where(eq(schema.payeePayment.needId, id))
        .orderBy(asc(schema.payeePayment.timestamp)),
      db
        .select()
        .from(schema.payeeChange)
        .where(eq(schema.payeeChange.needId, id))
        .orderBy(desc(schema.payeeChange.changeId)),
    ])

  const live = liveReport(reports)
  const votes = await votesOf([id])

  const photos = await db
    .select()
    .from(schema.workPhotos)
    .where(and(eq(schema.workPhotos.needId, id), eq(schema.workPhotos.revoked, false)))
    .orderBy(desc(schema.workPhotos.timestamp))
  const [badges, presentations, taxStatus, policies] = await Promise.all([
    badgesFor([row]),
    presentationsFor([row]),
    taxStatusFor([row]),
    policyIndex(),
  ])

  return c.json({
    ...toNeedSummary(row, policies),
    badges: badges.get(row.id) ?? EMPTY_BADGES,
    presentation: presentations.get(row.id) ?? null,
    taxStatus: taxStatus.get(row.ngo.toLowerCase()) ?? null,
    tranches: tranches.map((tranche) => toTrancheView(tranche)),
    deliveries: deliveries.map((delivery) => toDeliveryView(delivery, votes)),
    donations: donations.map(toDonationView),
    settlements: settlements.map(toSettlementView),
    impactReport: live ? toImpactReportView(live) : null,
    payees: payees.map(toPayeeView),
    payments: payments.map(toPayeePaymentView),
    payeeChanges: changes.map((change) =>
      toPayeeChangeView(change, payeeChangeApprovalsRequired(row.verificationsRequired)),
    ),
    photos: photos.map(toWorkPhotoView),
  } satisfies NeedDetail)
})

app.get('/needs/:id/timeline', async (c) => {
  const id = parseId(c.req.param('id'))
  if (id === null) return c.json({ error: 'invalid need id' }, 400)

  const rows = await needTimeline(id)
  return c.json(rows.map(toTimelineEvent) satisfies TimelineEvent[])
})

app.get('/needs/:id/feed.rss', async (c) => {
  const id = parseId(c.req.param('id'))
  if (id === null) return c.json({ error: 'invalid need id' }, 400)

  const [need] = await db.select().from(schema.need).where(eq(schema.need.id, id)).limit(1)
  if (!need) return c.json({ error: 'need not found' }, 404)

  const rows = await needTimeline(id)
  const link = `${APP_BASE_URL}/en/needs/${id}`
  return rss(
    c,
    renderRss({
      title: `VerifAid: need #${id} (${categoryLabel(need.category as Hex)}, ${regionLabel(need.regionCode as Hex)})`,
      link,
      description: 'Every verified step of this need, from verification to impact, as it happens on-chain.',
      selfUrl: new URL(c.req.url).toString(),
      itemLink: link,
      need,
      rows,
    }),
  )
})

// ─── global timeline ─────────────────────────────────────────────────────────

/**
 * Every need's events in chain order, paged by cursor, for consumers that follow the whole system (the notifier,
 * integrators). `?after=<blockNumber>:<logIndex>&limit=200`.
 */
app.get('/timeline', async (c) => {
  const limit = Math.min(Math.max(Number(c.req.query('limit') ?? 200) || 200, 1), 1000)
  const after = c.req.query('after')

  let where: ReturnType<typeof or> | undefined
  if (after) {
    const match = /^(\d+):(\d+)$/.exec(after)
    if (!match) return c.json({ error: 'invalid cursor' }, 400)
    const block = BigInt(match[1] as string)
    const logIndex = Number(match[2])
    where = or(
      gt(schema.timelineEvent.blockNumber, block),
      and(eq(schema.timelineEvent.blockNumber, block), gt(schema.timelineEvent.logIndex, logIndex)),
    )
  }

  const rows = await db
    .select()
    .from(schema.timelineEvent)
    .where(where)
    .orderBy(asc(schema.timelineEvent.blockNumber), asc(schema.timelineEvent.logIndex))
    .limit(limit)

  const last = rows.at(-1)
  return c.json({
    events: rows.map(toTimelineEvent),
    cursor: last ? `${last.blockNumber}:${last.logIndex}` : (after ?? null),
  } satisfies TimelinePage)
})

// ─── donation tracking ───────────────────────────────────────────────────────

/**
 * The public "track this donation" view. `:ref` is a receipt id (wallet donations, card ones included) or a
 * deposit address (exchange withdrawals, all of its sweeps together). Neither identifies the donor, so the route
 * needs no login.
 */
app.get('/donations/:ref', async (c) => {
  const track = await loadTrack(c.req.param('ref'))
  if ('error' in track) return c.json({ error: track.error }, track.status)
  return c.json(track.value satisfies DonationTrack)
})

app.get('/donations/:ref/feed.rss', async (c) => {
  const ref = c.req.param('ref')
  const track = await loadTrack(ref)
  if ('error' in track) return c.json({ error: track.error }, track.status)

  const needId = BigInt(track.value.need.id)
  const [need] = await db.select().from(schema.need).where(eq(schema.need.id, needId)).limit(1)
  if (!need) return c.json({ error: 'need not found' }, 404)

  const link = `${APP_BASE_URL}/en/track/${ref}`
  return rss(
    c,
    renderRss({
      title: `VerifAid: your donation to need #${needId}`,
      link,
      description: 'Where this donation is: verified, funded, settled, delivered and impact confirmed.',
      selfUrl: new URL(c.req.url).toString(),
      itemLink: link,
      need,
      rows: await needTimeline(needId),
    }),
  )
})

// ─── deposit addresses ───────────────────────────────────────────────────────

/**
 * A deposit address once it exists on-chain (deployed by its first sweep, or explicitly): the need and refund
 * route it commits to, every sweep and every refund. 404 before deployment — the app then reads the balance.
 */
app.get('/deposits/:address', async (c) => {
  const address = c.req.param('address').toLowerCase()
  if (!/^0x[0-9a-f]{40}$/.test(address)) return c.json({ error: 'invalid address' }, 400)
  const deposit = await loadDeposit(address as Address)
  if (!deposit) return c.json({ error: 'deposit address not deployed' }, 404)
  return c.json(deposit.view satisfies DepositAddressView)
})

// ─── suppliers ───────────────────────────────────────────────────────────────

/** Needs a supplier is in the plan of, or has been paid by (it may have been replaced since). */
const supplierNeedIds = async (address: Address): Promise<string[]> => {
  const [planned, paid] = await Promise.all([
    db.select({ needId: schema.payee.needId }).from(schema.payee).where(eq(schema.payee.account, address)),
    db
      .select({ needId: schema.payeePayment.needId })
      .from(schema.payeePayment)
      .where(eq(schema.payeePayment.payee, address)),
  ])
  const ids = new Set([...planned, ...paid].map((row) => row.needId))
  return [...ids].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).map(String)
}

/** Registered suppliers: the only accounts, besides an NGO's disclosed share, a vault ever pays. */
app.get('/suppliers', async (c) => {
  const rows = await db.select().from(schema.supplier).orderBy(asc(schema.supplier.registeredAt))
  const views = await Promise.all(
    rows.map(async (row) => toSupplierView(row, await supplierNeedIds(row.address as Address))),
  )
  return c.json(views satisfies SupplierView[])
})

app.get('/suppliers/:address', async (c) => {
  const address = c.req.param('address').toLowerCase()
  if (!/^0x[0-9a-f]{40}$/.test(address)) return c.json({ error: 'invalid address' }, 400)
  const [row] = await db
    .select()
    .from(schema.supplier)
    .where(eq(schema.supplier.address, address as Address))
    .limit(1)
  if (!row) return c.json({ error: 'supplier not found' }, 404)
  const payments = await db
    .select()
    .from(schema.payeePayment)
    .where(eq(schema.payeePayment.payee, address as Address))
    .orderBy(asc(schema.payeePayment.timestamp))
  return c.json({
    ...toSupplierView(row, await supplierNeedIds(address as Address)),
    payments: payments.map(toPayeePaymentView),
  } satisfies SupplierDetail)
})

// ─── providers ───────────────────────────────────────────────────────────────

/** The programmes an NGO owns: the console needs them to fill "which programme" for a new need. */
app.get('/programs', async (c) => {
  const ngo = c.req.query('ngo')?.toLowerCase()
  if (ngo !== undefined && !/^0x[0-9a-f]{40}$/.test(ngo)) return c.json({ error: 'invalid ngo' }, 400)
  const rows = await db
    .select()
    .from(schema.program)
    .where(ngo ? eq(schema.program.ngo, ngo as Address) : undefined)
    .orderBy(asc(schema.program.id))

  return c.json(
    rows.map((row) => ({
      id: row.id.toString(),
      ngo: row.ngo as Address,
      eligibilityHash: row.eligibilityHash as Hex,
      metadataURI: row.metadataURI,
      active: row.active,
      createdAt: row.createdAt,
    })) satisfies ProgramView[],
  )
})

/**
 * The release policies a new need may choose, the default first. Needs keep the policy they chose even after the
 * platform withdraws it, so a need page reads its own policy from the need, not from this list.
 */
app.get('/release-policies', async (c) => {
  const rows = await db.select().from(schema.releasePolicy).where(eq(schema.releasePolicy.allowed, true))
  rows.sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.name.localeCompare(b.name))
  return c.json(
    rows.map((row) => ({
      ...toReleasePolicyView(row.address as Address, row),
      isDefault: row.isDefault,
    })) satisfies (ReleasePolicyView & {
      isDefault: boolean
    })[],
  )
})

/**
 * Suppliers that asked to be registered. Anyone can attest one of these for themselves, so it is a queue for
 * the admin, not a role: `registered` says whether the address actually holds SUPPLIER_ROLE now.
 */
app.get('/supplier-applications', async (c) => {
  const rows = await db
    .select()
    .from(schema.supplierApplication)
    .where(eq(schema.supplierApplication.revoked, false))
    .orderBy(desc(schema.supplierApplication.timestamp))
  const registered = new Set(
    (await db.select().from(schema.supplier))
      .filter((row) => row.active)
      .map((row) => row.address.toLowerCase()),
  )

  return c.json(
    rows.map((row) =>
      toSupplierApplicationView(row, registered.has(row.supplier.toLowerCase())),
    ) satisfies SupplierApplicationView[],
  )
})

// ─── donors ──────────────────────────────────────────────────────────────────

/**
 * "Follow my money". For every receipt the donor holds: the need it funded, the donor's share of that need's
 * funding, each tranche with both its real amount and this donor's slice of it, and the deliveries whose
 * approval unlocked those releases.
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

    const votes = await votesOf([need.id])
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
      deliveries: deliveries.map((delivery) => toDeliveryView(delivery, votes)),
    })
  }

  return c.json({ donor, totalDonated: totalDonated.toString(), receipts: traces } satisfies DonorTrace)
})

// ─── impact ──────────────────────────────────────────────────────────────────

app.get('/impact/summary', async (c) => {
  const [needs, deliveries, reports, approvals] = await Promise.all([
    db.select().from(schema.need),
    db.select().from(schema.delivery),
    db.select().from(schema.impactReport),
    db
      .select({ id: schema.deliveryVote.id })
      .from(schema.deliveryVote)
      .where(eq(schema.deliveryVote.approve, true)),
  ])

  const approvedByNeed = new Map<string, number>()
  for (const delivery of deliveries) {
    if (delivery.status !== 'Approved') continue
    const key = delivery.needId.toString()
    approvedByNeed.set(key, (approvedByNeed.get(key) ?? 0) + 1)
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
    deliveriesApproved: 0,
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
    const approved = approvedByNeed.get(key) ?? 0
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
      acc.deliveriesApproved += approved
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
      deliveriesApproved: deliveries.filter((delivery) => delivery.status === 'Approved').length,
      deliveriesRejected: deliveries.filter((delivery) => delivery.status === 'Rejected').length,
      approvals: approvals.length,
      beneficiariesServed: [...servedByNeed.values()].reduce((sum, value) => sum + value, 0),
    },
    byCategory: [...byCategory.values()].map(serializeBucket),
    byRegion: [...byRegion.values()].map(serializeBucket),
  } satisfies ImpactSummary)
})

// ─── deliveries ──────────────────────────────────────────────────────────────

/** Every delivery, or `?status=Open` for the evidence donors are still reviewing. */
app.get('/deliveries', async (c) => {
  const status = c.req.query('status')
  const rows = await db
    .select()
    .from(schema.delivery)
    .where(status ? eq(schema.delivery.status, status) : undefined)
    .orderBy(asc(schema.delivery.id))
  const votes = await votesOf([...new Set(rows.map((row) => row.needId))])

  return c.json(rows.map((row) => toDeliveryView(row, votes)) satisfies DeliveryView[])
})

// ─── helpers ─────────────────────────────────────────────────────────────────

interface ImpactBucketAcc {
  key: string
  label: string
  needs: number
  donated: bigint
  released: bigint
  deliveriesApproved: number
  beneficiariesServed: number
}

const serializeBucket = (acc: ImpactBucketAcc): ImpactBucket => ({
  key: acc.key,
  label: acc.label,
  needs: acc.needs,
  donated: acc.donated.toString(),
  released: acc.released.toString(),
  deliveriesApproved: acc.deliveriesApproved,
  beneficiariesServed: acc.beneficiariesServed,
})

/** The votes on every delivery of these needs. */
const votesOf = async (needIds: readonly bigint[]) =>
  needIds.length === 0
    ? []
    : db
        .select()
        .from(schema.deliveryVote)
        .where(inArray(schema.deliveryVote.needId, [...needIds]))

/** Every release policy the indexer has seen, by lowercase address. There are a handful at most. */
const policyIndex = async () =>
  new Map((await db.select().from(schema.releasePolicy)).map((row) => [row.address.toLowerCase(), row]))

const needTimeline = (needId: bigint) =>
  db
    .select()
    .from(schema.timelineEvent)
    .where(eq(schema.timelineEvent.needId, needId))
    .orderBy(asc(schema.timelineEvent.blockNumber), asc(schema.timelineEvent.logIndex))

const rss = (
  c: { body: (body: string, status: 200, headers: Record<string, string>) => Response },
  xml: string,
) =>
  c.body(xml, 200, {
    'content-type': 'application/rss+xml; charset=utf-8',
    'cache-control': 'public, max-age=60',
  })

/** Funding is open while the need is raising money and neither of its deadlines has passed. */
const isOpenForFunding = (row: NeedRow, now: number): boolean =>
  row.status === 'Funding' &&
  (row.fundingDeadline === null || row.fundingDeadline > now) &&
  (row.executionDeadline === null || row.executionDeadline > now)

const sortNeeds = (rows: NeedRow[], sort: NeedSort, now: number): NeedRow[] => {
  const byGap = (a: NeedRow, b: NeedRow) => {
    const gap = fundingGapOf(b) - fundingGapOf(a)
    return gap === 0n ? 0 : gap > 0n ? 1 : -1
  }
  const newest = (a: NeedRow, b: NeedRow) => (a.id === b.id ? 0 : a.id < b.id ? 1 : -1)
  const sorted = [...rows]
  if (sort === 'newest') return sorted.sort(newest)
  if (sort === 'gap') return sorted.sort((a, b) => byGap(a, b) || newest(a, b))
  return sorted.sort((a, b) => {
    const openA = isOpenForFunding(a, now)
    const openB = isOpenForFunding(b, now)
    if (openA !== openB) return openA ? -1 : 1
    if (openA) {
      const deadlineA = a.fundingDeadline ?? Number.MAX_SAFE_INTEGER
      const deadlineB = b.fundingDeadline ?? Number.MAX_SAFE_INTEGER
      if (deadlineA !== deadlineB) return deadlineA - deadlineB
      return byGap(a, b) || newest(a, b)
    }
    return newest(a, b)
  })
}

type Loaded<T> = { value: T } | { error: string; status: 400 | 404 | 409 }

/** Resolves a tracking reference to its donation and gathers everything the tracking view is built from. */
const loadTrack = async (ref: string): Promise<Loaded<DonationTrack>> => {
  const refKind = trackingRefKind(ref)
  if (!refKind) return { error: 'invalid tracking reference', status: 400 }

  let donation: DonationRow | undefined
  let deposit: DepositAddressView | null = null
  if (refKind === 'deposit') {
    const loaded = await loadDeposit(ref.toLowerCase() as Address)
    if (!loaded) return { error: 'deposit address not deployed', status: 404 }
    if (loaded.sweeps.length === 0)
      return { error: 'nothing swept from this deposit address yet', status: 404 }
    donation = combineSweeps(loaded.sweeps)
    deposit = loaded.view
  } else {
    ;[donation] = await db
      .select()
      .from(schema.donation)
      .where(eq(schema.donation.receiptId, BigInt(ref)))
      .limit(1)
  }
  if (!donation) return { error: 'donation not found', status: 404 }

  const needId = donation.needId
  const [need] = await db.select().from(schema.need).where(eq(schema.need.id, needId)).limit(1)
  if (!need) return { error: 'need not found', status: 404 }

  const sameDonor = donation.donor
    ? and(eq(schema.donation.needId, needId), eq(schema.donation.donor, donation.donor as Address))
    : and(eq(schema.donation.needId, needId), eq(schema.donation.donorRefHash, donation.donorRefHash as Hex))
  const refundsOfDonor = donation.donor
    ? and(
        eq(schema.refund.needId, needId),
        eq(schema.refund.account, donation.donor as Address),
        isNull(schema.refund.donorRefHash),
      )
    : and(eq(schema.refund.needId, needId), eq(schema.refund.donorRefHash, donation.donorRefHash as Hex))

  const [
    sameDonorDonations,
    tranches,
    deliveries,
    settlements,
    reports,
    refunds,
    timeline,
    payees,
    payments,
    votes,
    policies,
  ] = await Promise.all([
    db.select().from(schema.donation).where(sameDonor),
    db
      .select()
      .from(schema.tranche)
      .where(eq(schema.tranche.needId, needId))
      .orderBy(asc(schema.tranche.index)),
    db
      .select()
      .from(schema.delivery)
      .where(eq(schema.delivery.needId, needId))
      .orderBy(asc(schema.delivery.id)),
    db.select().from(schema.settlement).where(eq(schema.settlement.needId, needId)),
    db.select().from(schema.impactReport).where(eq(schema.impactReport.needId, needId)),
    db.select().from(schema.refund).where(refundsOfDonor),
    needTimeline(needId),
    db.select().from(schema.payee).where(eq(schema.payee.needId, needId)).orderBy(asc(schema.payee.index)),
    db
      .select()
      .from(schema.payeePayment)
      .where(eq(schema.payeePayment.needId, needId))
      .orderBy(asc(schema.payeePayment.timestamp)),
    votesOf([needId]),
    policyIndex(),
  ])

  return {
    value: buildDonationTrack({
      ref,
      refKind,
      donation,
      need,
      sameDonorDonations,
      tranches,
      deliveries,
      votes,
      policies,
      settlements,
      reports,
      refunds,
      timeline,
      deposit,
      payees,
      payments,
      badges: (await badgesFor([need])).get(need.id) ?? EMPTY_BADGES,
      presentation: (await presentationsFor([need])).get(need.id) ?? null,
      taxStatus: (await taxStatusFor([need])).get(need.ngo.toLowerCase()) ?? null,
      acknowledgment: donation.receiptId
        ? ((await db
            .select()
            .from(schema.donationAcknowledgment)
            .where(eq(schema.donationAcknowledgment.receiptId, donation.receiptId))
            .limit(1)
            .then((rows) => rows[0])) ?? null)
        : null,
    }),
  }
}

const loadDeposit = async (address: Address) => {
  const [row] = await db
    .select()
    .from(schema.depositAddress)
    .where(eq(schema.depositAddress.address, address))
    .limit(1)
  if (!row) return null
  const [sweeps, refunds] = await Promise.all([
    db
      .select()
      .from(schema.donation)
      .where(and(eq(schema.donation.via, address), eq(schema.donation.viaDepositAddress, true)))
      .orderBy(asc(schema.donation.timestamp)),
    db
      .select()
      .from(schema.depositRefund)
      .where(eq(schema.depositRefund.depositAddress, address))
      .orderBy(asc(schema.depositRefund.timestamp)),
  ])
  return { view: toDepositAddressView(row, sweeps, refunds), sweeps }
}

function parseId(value: string): bigint | null {
  if (!/^\d+$/.test(value)) return null
  try {
    return BigInt(value)
  } catch {
    return null
  }
}

export default app
