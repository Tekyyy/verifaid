import { ponder } from 'ponder:registry'
import schema from 'ponder:schema'
import { countryOf, needStatusName, regionLabel } from '@poa/shared'
import { eq } from 'ponder'
import { type Hex, zeroAddress, zeroHash } from 'viem'
import { ensurePolicy } from './lib/releasePolicy.js'
import { appendTimeline, seconds } from './lib/timeline.js'

/**
 * The need lifecycle: Pending → Verified → Funding → Funded → InDelivery → Completed, or Cancelled / Expired.
 * `NeedCreated` carries every term the NGO committed to, including the display-only commitments (category,
 * metadata URI, expected outcome, cost disclosure) that the contract logs instead of storing.
 */

const orNull = (value: bigint): number | null => (value === 0n ? null : Number(value))

ponder.on('NeedsRegistry:NeedCreated', async ({ event, context }) => {
  const { needId, ngo, programId, releasePolicy, params } = event.args
  const { trancheBps } = params
  await ensurePolicy(context, releasePolicy, seconds(event))

  await context.db.insert(schema.need).values({
    id: needId,
    ngo,
    // Set by BeneficiaryRegistry:BeneficiaryNeedPosted, logged later in the same transaction.
    beneficiary: null,
    programId,
    category: params.category,
    regionCode: params.regionCode,
    country: countryOf(regionLabel(params.regionCode as Hex)),
    dossierHash: params.dossierHash,
    metadataURI: params.metadataURI,
    targetAmount: params.targetAmount,
    verificationsRequired: params.verificationsRequired,
    verificationCount: 0,
    status: 'Pending',
    vault: null,
    releasePolicy,
    strikes: 0,
    fundingDeadline: orNull(params.fundingDeadline),
    executionDeadline: orNull(params.executionDeadline),
    minFundingBps: params.minFundingBps,
    thirdPartyCostBps: params.thirdPartyCostBps,
    expectedOutcomeHash: params.expectedOutcomeHash,
    costDisclosureHash: params.costDisclosureHash === zeroHash ? null : params.costDisclosureHash,
    totalDonated: 0n,
    totalReleased: 0n,
    totalRefunded: 0n,
    yieldVenue: null,
    yieldEnabled: false,
    deployedPrincipal: 0n,
    yieldRealised: 0n,
    yieldPaid: 0n,
    yieldLost: 0n,
    fundingFees: 0n,
    settlementFees: 0n,
    trancheCount: trancheBps.length,
    createdAt: seconds(event),
    createdTxHash: event.transaction.hash,
    fundingClosedAt: null,
    completedAt: null,
    cancelledAt: null,
    expiredAt: null,
  })

  // v4: who the vault pays. The owner's own share (account zero) goes, at release time, to the NGO's payout Safe or
  // (v10) to the wallet of the beneficiary who posted the need.
  if (params.payees.length > 0) {
    await context.db.insert(schema.payee).values(
      params.payees.map((planned, index) => ({
        needId,
        index,
        account: planned.account === zeroAddress ? null : planned.account,
        label: planned.label,
        refHash: planned.refHash,
        shareBps: planned.shareBps.map(Number),
        needShareBps: Math.floor(
          planned.shareBps.reduce((sum, share, t) => sum + Number(share) * Number(trancheBps[t] ?? 0), 0) /
            10_000,
        ),
        paid: 0n,
        held: 0n,
      })),
    )
  }

  // The plan is fixed at creation; the amounts are only known when funding closes.
  await context.db.insert(schema.tranche).values(
    trancheBps.map((bps, index) => ({
      needId,
      index,
      bps,
      amount: 0n,
      status: 'Locked',
      deliveryId: null,
      releasedAt: null,
      releasedTo: null,
      releaseTxHash: null,
    })),
  )

  await appendTimeline(context, event, {
    needId,
    type: 'NeedCreated',
    data: {
      ngo,
      programId: programId.toString(),
      releasePolicy,
      category: params.category,
      regionCode: params.regionCode,
      targetAmount: params.targetAmount.toString(),
      verificationsRequired: params.verificationsRequired,
      trancheCount: trancheBps.length,
      metadataURI: params.metadataURI,
      fundingDeadline: orNull(params.fundingDeadline),
      executionDeadline: orNull(params.executionDeadline),
      minFundingBps: params.minFundingBps,
      thirdPartyCostBps: params.thirdPartyCostBps,
      expectedOutcomeHash: params.expectedOutcomeHash,
    },
  })
})

ponder.on('NeedsRegistry:NeedVerificationRecorded', async ({ event, context }) => {
  const { needId, verifier, approved, attestationUID, verificationCount } = event.args

  await context.db.update(schema.need, { id: needId }).set({ verificationCount })

  await appendTimeline(context, event, {
    needId,
    type: 'NeedVerificationRecorded',
    data: { verifier, approved, verificationCount },
    attestationUID,
  })
})

ponder.on('NeedsRegistry:NeedVerified', async ({ event, context }) => {
  await context.db.update(schema.need, { id: event.args.needId }).set({ vault: event.args.vault })

  await appendTimeline(context, event, {
    needId: event.args.needId,
    type: 'NeedVerified',
    data: { vault: event.args.vault },
  })
})

ponder.on('NeedsRegistry:NeedStatusChanged', async ({ event, context }) => {
  const { needId } = event.args
  const from = needStatusName(event.args.from)
  const to = needStatusName(event.args.to)

  await context.db.update(schema.need, { id: needId }).set({
    status: to,
    ...(to === 'Completed' ? { completedAt: seconds(event) } : {}),
    ...(to === 'Cancelled' ? { cancelledAt: seconds(event) } : {}),
    ...(to === 'Expired' ? { expiredAt: seconds(event) } : {}),
  })

  await appendTimeline(context, event, { needId, type: 'NeedStatusChanged', data: { from, to } })
})

ponder.on('NeedsRegistry:NeedCancelled', async ({ event, context }) => {
  await appendTimeline(context, event, {
    needId: event.args.needId,
    type: 'NeedCancelled',
    data: { by: event.args.by },
  })
})

/** A deadline applied by anyone: the need did not go ahead, or its unreleased balance goes back to donors. */
ponder.on('NeedsRegistry:NeedExpired', async ({ event, context }) => {
  await appendTimeline(context, event, {
    needId: event.args.needId,
    type: 'NeedExpired',
    data: { from: needStatusName(event.args.from), raised: event.args.raised.toString() },
  })
})

/** The funding deadline passed above the NGO's threshold: the need goes ahead on what was raised. */
ponder.on('NeedsRegistry:PartialFundingAccepted', async ({ event, context }) => {
  const { needId, raised, targetAmount } = event.args
  await appendTimeline(context, event, {
    needId,
    type: 'PartialFundingAccepted',
    data: {
      raised: raised.toString(),
      targetAmount: targetAmount.toString(),
      scaleBps: targetAmount === 0n ? 0 : Number((raised * 10_000n) / targetAmount),
    },
  })
})

ponder.on('NeedsRegistry:NeedVerificationRevoked', async ({ event, context }) => {
  const { needId, verifier, attestationUID, verificationCount } = event.args

  await context.db.update(schema.need, { id: needId }).set({ verificationCount })

  await appendTimeline(context, event, {
    needId,
    type: 'VerificationRevoked',
    data: { verifier, verificationCount, honored: true },
    attestationUID,
  })
})

/** Revoking after money moved does not change state; it opens the off-chain dispute process (spec §5.2). */
ponder.on('NeedsRegistry:VerificationRevokedAfterFunding', async ({ event, context }) => {
  await appendTimeline(context, event, {
    needId: event.args.needId,
    type: 'VerificationRevoked',
    data: { verifier: event.args.verifier, honored: false },
    attestationUID: event.args.attestationUID,
  })
})

/**
 * The NGO let this need's committed money earn while it waits. It could only do this while the need was still
 * Pending — before it could take a single donation — so anyone who gave saw it on the page first.
 */
ponder.on('NeedsRegistry:YieldEnabled', async ({ event, context }) => {
  const { needId, venue } = event.args

  await context.db.update(schema.need, { id: needId }).set({ yieldEnabled: true })

  await appendTimeline(context, event, { needId, type: 'YieldEnabled', data: { venue } })
})

// ─── release policies ────────────────────────────────────────────────────────

/** The platform approved or withdrew a rule new needs may choose; needs that chose it keep it either way. */
ponder.on('NeedsRegistry:ReleasePolicySet', async ({ event, context }) => {
  const { policy, allowed } = event.args
  await ensurePolicy(context, policy, seconds(event))
  await context.db
    .update(schema.releasePolicy, { address: policy })
    .set({ allowed, updatedAt: seconds(event) })
})

ponder.on('NeedsRegistry:DefaultReleasePolicySet', async ({ event, context }) => {
  const { policy } = event.args
  await ensurePolicy(context, policy, seconds(event))
  const previous = await context.db.sql
    .select()
    .from(schema.releasePolicy)
    .where(eq(schema.releasePolicy.isDefault, true))
  for (const row of previous) {
    await context.db.update(schema.releasePolicy, { address: row.address }).set({ isDefault: false })
  }
  await context.db
    .update(schema.releasePolicy, { address: policy })
    .set({ isDefault: true, updatedAt: seconds(event) })
})
