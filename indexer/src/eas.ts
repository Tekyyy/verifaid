import { ponder } from 'ponder:registry'
import schema from 'ponder:schema'
import {
  type CommunitySchemaName,
  type DeliveryEvidenceData,
  type DeliveryVerifiedData,
  decodeSchemaData,
  currencyLabel,
  easAbi,
  type FundingRecordedData,
  getDeployment,
  type ImpactReportData,
  type NeedVerifiedData,
  resolveNetwork,
  SCHEMAS,
  type SchemaName,
  type SettlementData,
  schemaToAbiParameters,
} from '@poa/shared'
import { and, eq } from 'ponder'
import type { Hex } from 'viem'
import { recordCommunityAttestation, revokeCommunityAttestation } from './community.js'
import { appendTimeline, seconds } from './lib/timeline.js'

/**
 * EAS attestations are the evidence layer: they are what verifiers, field agents, payment providers and NGOs sign.
 * The `Attested` log only carries the uid and the schema, so the payload is read back with `getAttestation`
 * and decoded with the same schema definitions the attesting code used (@poa/shared).
 *
 * EAS emits `Attested` *before* it calls the resolver, so the core-contract events triggered by an attestation
 * (NeedVerificationRecorded, DeliveryEvidenceLinked, …) always carry a higher log index in the same
 * transaction. Nothing here depends on state those handlers write.
 */

const deployment = getDeployment(resolveNetwork(process.env.PONDER_NETWORK ?? 'anvil'))
const easAddress = deployment.external.EAS

/** The six official schema UIDs of this deployment. Attestations under any other schema are ignored. */
const SCHEMA_BY_UID = new Map<string, SchemaName>(
  Object.entries(deployment.schemas).map(([name, uid]) => [uid.toLowerCase(), name as SchemaName]),
)

/** The resolver-less schemas: anyone may attest them, so `community.ts` decides what counts. */
const COMMUNITY_BY_UID = new Map<string, CommunitySchemaName>(
  Object.entries(deployment.communitySchemas ?? {}).map(([name, uid]) => [
    uid.toLowerCase(),
    name as CommunitySchemaName,
  ]),
)

const ZERO_UID: Hex = '0x0000000000000000000000000000000000000000000000000000000000000000'

/** Field names per schema, derived from the same schema strings the attesters encode with. */
const SCHEMA_FIELDS = new Map<SchemaName, readonly string[]>(
  Object.values(SCHEMAS).map((definition) => [
    definition.name,
    schemaToAbiParameters(definition.schema).map((parameter) => parameter.name ?? ''),
  ]),
)

type JsonValue = string | number | boolean
const toJson = (value: unknown): JsonValue =>
  typeof value === 'bigint' ? value.toString() : (value as JsonValue)

const decodedRecord = (name: SchemaName, values: readonly unknown[]): Record<string, JsonValue> =>
  Object.fromEntries((SCHEMA_FIELDS.get(name) ?? []).map((field, i) => [field, toJson(values[i])]))

ponder.on('EAS:Attested', async ({ event, context }) => {
  const schemaName = SCHEMA_BY_UID.get(event.args.schemaUID.toLowerCase())
  const communityName = COMMUNITY_BY_UID.get(event.args.schemaUID.toLowerCase())
  if (!schemaName && !communityName) return

  const record = await context.client.readContract({
    abi: easAbi,
    address: easAddress,
    functionName: 'getAttestation',
    args: [event.args.uid],
  })

  if (communityName) {
    const needId = await recordCommunityAttestation(communityName, {
      uid: event.args.uid,
      attester: event.args.attester,
      data: record.data,
      timestamp: seconds(event),
      txHash: event.transaction.hash,
      db: context.db,
    })
    if (needId !== null) {
      await appendTimeline(context, event, {
        needId,
        type: communityName === 'NeedPresentation' ? 'NeedPresentationPublished' : 'WorkPhotosPublished',
        data: { attester: event.args.attester, uid: event.args.uid },
        attestationUID: event.args.uid,
      })
    }
    return
  }
  if (!schemaName) return

  const values = decodeSchemaData<readonly unknown[]>(schemaName, record.data)
  const decoded = decodedRecord(schemaName, values)
  const refUID = record.refUID === ZERO_UID ? null : record.refUID

  let needId: bigint | null = null
  let deliveryId: bigint | null = null

  switch (schemaName) {
    case 'NeedVerified': {
      needId = (values as NeedVerifiedData)[0]
      break
    }
    case 'DeliveryEvidence': {
      const [id, evidenceHash, evidenceCID, itemsDelivered] = values as DeliveryEvidenceData
      deliveryId = id
      const delivery = await context.db.find(schema.delivery, { id })
      needId = delivery?.needId ?? null
      if (delivery) {
        await context.db.update(schema.delivery, { id }).set({ evidenceCID, evidenceHash, itemsDelivered })
      }
      break
    }
    case 'DeliveryVerified': {
      const [id] = values as DeliveryVerifiedData
      deliveryId = id
      needId = (await context.db.find(schema.delivery, { id }))?.needId ?? null
      break
    }
    case 'FundingRecorded': {
      const [id, gross, fee, , currency, paymentRefHash] = values as FundingRecordedData
      needId = id
      // On-chain custody: links the attestation to the DonatedOnBehalf deposit it vouches for, which happened
      // in an earlier transaction. Off-chain custody: the ledger's FundingRecorded event later in this same
      // transaction creates the donation row and reads this attestation back (see ledger.ts).
      const [match] = await context.db.sql
        .select({ id: schema.donation.id })
        .from(schema.donation)
        .where(
          and(
            eq(schema.donation.paymentRefHash, paymentRefHash),
            eq(schema.donation.partner, event.args.attester),
            eq(schema.donation.kind, 'FIAT'),
          ),
        )
        .limit(1)
      if (match) {
        await context.db
          .update(schema.donation, { id: match.id })
          .set({ attestationUID: event.args.uid, gross, fee, currency: currencyLabel(currency) })
        await context.db.update(schema.need, { id }).set((row) => ({ fundingFees: row.fundingFees + fee }))
      }
      break
    }
    case 'Settlement': {
      const [id, trancheIndex, gross, fee, net, supplierRefHash, fxRef] = values as SettlementData
      needId = id
      await context.db.insert(schema.settlement).values({
        uid: event.args.uid,
        needId: id,
        trancheIndex: Number(trancheIndex),
        attester: event.args.attester,
        gross,
        fee,
        net,
        supplierRefHash,
        fxRef,
        txHash: event.transaction.hash,
        timestamp: seconds(event),
      })
      await context.db
        .update(schema.need, { id })
        .set((row) => ({ settlementFees: row.settlementFees + fee }))
      await appendTimeline(context, event, {
        needId: id,
        type: 'SettlementRecorded',
        data: {
          trancheIndex: Number(trancheIndex),
          attester: event.args.attester,
          gross: gross.toString(),
          fee: fee.toString(),
          net: net.toString(),
          supplierRefHash,
          fxRef,
        },
        attestationUID: event.args.uid,
      })
      break
    }
    case 'ImpactReport': {
      const [id, beneficiariesServed, kpiHash, reportCID] = values as ImpactReportData
      needId = id
      await context.db.insert(schema.impactReport).values({
        uid: event.args.uid,
        needId: id,
        beneficiariesServed,
        kpiHash,
        reportCID,
        revoked: false,
        timestamp: seconds(event),
      })
      await appendTimeline(context, event, {
        needId: id,
        type: 'ImpactReportPublished',
        data: { beneficiariesServed, kpiHash, reportCID },
        attestationUID: event.args.uid,
      })
      break
    }
  }

  await context.db.insert(schema.attestation).values({
    uid: event.args.uid,
    schemaUID: event.args.schemaUID,
    schemaName,
    attester: event.args.attester,
    recipient: event.args.recipient,
    refUID,
    needId,
    deliveryId,
    decoded,
    revoked: false,
    revokedAt: null,
    txHash: event.transaction.hash,
    blockNumber: event.block.number,
    timestamp: seconds(event),
  })
})

ponder.on('EAS:Revoked', async ({ event, context }) => {
  const communityName = COMMUNITY_BY_UID.get(event.args.schemaUID.toLowerCase())
  if (communityName) {
    await revokeCommunityAttestation(communityName, context.db, event.args.uid)
    return
  }
  const schemaName = SCHEMA_BY_UID.get(event.args.schemaUID.toLowerCase())
  if (!schemaName) return

  const existing = await context.db.find(schema.attestation, { uid: event.args.uid })
  if (!existing) return

  await context.db
    .update(schema.attestation, { uid: event.args.uid })
    .set({ revoked: true, revokedAt: seconds(event) })

  // A revoked impact report drops out of the public totals but stays visible as part of the audit trail.
  if (schemaName === 'ImpactReport') {
    await context.db.update(schema.impactReport, { uid: event.args.uid }).set({ revoked: true })
  }
})
