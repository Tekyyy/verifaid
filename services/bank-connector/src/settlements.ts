import { saltedRefHash } from '@poa/shared'
import { type ProviderSettlement, prisma } from '@poa/shared/db'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { type Address, type Hex, keccak256, stringToHex, zeroHash } from 'viem'
import { z } from 'zod'
import {
  attestToLedger,
  exclusive,
  hasLedger,
  httpErrorFromRevert,
  readFeeState,
  readNeed,
  readSettlementAttestation,
  readTranches,
  settlementAttestationFor,
} from './chain.js'
import { badRequest, conflict, errorSummary, forbidden, notFound } from './errors.js'
import { centsToBaseUnits, maxSettlementFee, minBigInt } from './fees.js'
import type { FundingDeps } from './funding.js'
import type { RouteDeps } from './routes.js'
import { verifySignature } from './signature.js'

/**
 * Provider settlements (the proposal's Model A payouts). For an off-chain need the provider holds the money, so
 * when a tranche becomes releasable it pays the supplier from its own accounts and reports the payout with a
 * `Settlement` attestation — which is what releases the tranche in the NonCustodialLedger. On-chain needs are
 * settled by the NGO after the vault pays out, never by the provider, so they are refused here.
 *
 * Idempotent on (needId, trancheIndex), re-checked against `ProofOfAidResolver.settlementOf`, since a tranche can
 * only be paid out once.
 */

export const SETTLEMENT_STATUS = ['RECEIVED', 'ATTESTED', 'FAILED'] as const
export type SettlementStatus = (typeof SETTLEMENT_STATUS)[number]

export const SettlementRequestSchema = z.object({
  needId: z.string().regex(/^\d{1,78}$/, 'needId must be a decimal integer string'),
  /** The registry allows at most five tranches. */
  trancheIndex: z.number().int().min(0).max(4),
  /** Payout fees (bank, FX) in euro cents. Capped by the need's cost disclosure; the rest is absorbed. */
  feeEurCents: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  /** The provider's reference for the supplier payment; only its salted hash goes on-chain. */
  supplierReference: z.string().min(1).max(140),
  /** FX deal or rate reference, if the payout crossed currencies; committed as keccak256 of the text. */
  fxReference: z.string().min(1).max(140).optional(),
})

export type SettlementRequest = z.infer<typeof SettlementRequestSchema>

export const SettlementResponseSchema = z.object({
  id: z.string(),
  needId: z.string(),
  trancheIndex: z.number(),
  gross: z.string(),
  fee: z.string(),
  net: z.string(),
  attestationUID: z.string().nullable(),
  txHash: z.string().nullable(),
  status: z.string(),
  idempotent: z.boolean(),
})

export interface SettlementResult {
  settlement: ProviderSettlement
  idempotent: boolean
}

const sameAddress = (a: Address, b: Address): boolean => a.toLowerCase() === b.toLowerCase()

export const fxRefHash = (fxReference?: string): Hex =>
  fxReference ? keccak256(stringToHex(fxReference)) : zeroHash

export const recordSettlement = async (
  deps: FundingDeps,
  request: SettlementRequest,
): Promise<SettlementResult> => {
  const supplierRefHash = saltedRefHash(deps.config.refSalt, request.supplierReference)
  const fxRef = fxRefHash(request.fxReference)
  const where = { needId_trancheIndex: { needId: request.needId, trancheIndex: request.trancheIndex } }

  const assertSame = (existing: ProviderSettlement): void => {
    if (existing.supplierRefHash !== supplierRefHash || existing.fxRef !== fxRef) {
      throw conflict(
        'This tranche was already reported with a different supplier or FX reference',
        'SETTLEMENT_CONFLICT',
      )
    }
  }

  const needId = BigInt(request.needId)
  /**
   * A completed row is only trusted while the chain still shows the same attestation: needs are numbered per
   * deployment, so a row left over from a reset local chain must not answer for a new need with the same id.
   * Rows that never reached the chain carry no commitment and are simply overwritten by a new attempt.
   */
  const completed = async (): Promise<ProviderSettlement | null> => {
    const row = await prisma().providerSettlement.findUnique({ where })
    if (row?.status !== 'ATTESTED' || !row.attestationUID) return null
    if ((await settlementAttestationFor(deps.chain, needId, request.trancheIndex)) !== row.attestationUID)
      return null
    assertSame(row)
    return row
  }

  const cached = await completed()
  if (cached) return { settlement: cached, idempotent: true }

  return exclusive(deps.chain, async () => {
    const { chain, log } = deps
    const existing = await completed()
    if (existing) return { settlement: existing, idempotent: true }

    const need = await readNeed(chain, needId)
    if (!need) throw notFound(`Need ${request.needId} does not exist`)
    if (!hasLedger(need)) {
      throw conflict(
        `Need ${request.needId} has not been verified, so it has no ledger or tranches`,
        'NO_LEDGER',
      )
    }
    if (need.custodyMode !== 'OffChain') {
      throw conflict(
        `Need ${request.needId} is held on-chain: its vault releases tranches and the NGO reports settlements`,
        'NOT_OFF_CHAIN_CUSTODY',
      )
    }
    if (!sameAddress(need.custodian, chain.account.address)) {
      throw forbidden(`This provider is not the custodian of need ${request.needId}`, 'NOT_CUSTODIAN')
    }

    const settledUid = await settlementAttestationFor(chain, needId, request.trancheIndex)
    if (settledUid) {
      // Already on-chain (an earlier run died before the row caught up): adopt what the chain says.
      const [, , gross, fee, , attestedSupplierRef, attestedFxRef] = await readSettlementAttestation(
        chain,
        settledUid,
      )
      if (attestedSupplierRef !== supplierRefHash || attestedFxRef !== fxRef) {
        throw conflict('This tranche was already settled with a different reference', 'SETTLEMENT_CONFLICT')
      }
      const data = {
        grossBaseUnits: gross.toString(),
        feeBaseUnits: fee.toString(),
        supplierRefHash,
        fxRef,
        status: 'ATTESTED',
        attestationUID: settledUid,
        error: null,
      }
      const settlement = await prisma().providerSettlement.upsert({
        where,
        update: data,
        create: { ...data, needId: request.needId, trancheIndex: request.trancheIndex },
      })
      return { settlement, idempotent: true }
    }

    const tranches = await readTranches(chain, need.vault)
    const tranche = tranches[request.trancheIndex]
    if (!tranche) {
      throw badRequest(`Need ${request.needId} has ${tranches.length} tranches`, 'INVALID_TRANCHE_INDEX')
    }
    if (tranche.status !== 'Releasable') {
      throw conflict(
        `Tranche ${request.trancheIndex} of need ${request.needId} is ${tranche.status}, not Releasable`,
        'TRANCHE_NOT_RELEASABLE',
      )
    }

    const gross = tranche.amount
    const requestedFee = centsToBaseUnits(request.feeEurCents ?? 0)
    const feeState = await readFeeState(chain, need)
    const fee = minBigInt(requestedFee, maxSettlementFee(feeState, need.thirdPartyCostBps), gross)
    const net = gross - fee
    if (fee < requestedFee) {
      log.info(
        { event: 'settlement.fee_capped', needId: request.needId, requested: requestedFee.toString() },
        'settlement fee capped by the need’s cost disclosure; the provider absorbs the difference',
      )
    }

    const amounts = {
      grossBaseUnits: gross.toString(),
      feeBaseUnits: fee.toString(),
      supplierRefHash,
      fxRef,
      status: 'RECEIVED',
      error: null,
    }
    let settlement = await prisma().providerSettlement.upsert({
      where,
      update: amounts,
      create: { ...amounts, needId: request.needId, trancheIndex: request.trancheIndex },
    })

    try {
      const attestTxHash = await attestToLedger(chain, 'Settlement', need.vault, [
        needId,
        BigInt(request.trancheIndex),
        gross,
        fee,
        net,
        supplierRefHash,
        fxRef,
      ])
      const attestationUID = await settlementAttestationFor(chain, needId, request.trancheIndex)
      if (!attestationUID) throw new Error('Settlement was mined but the resolver has no record of it')

      settlement = await prisma().providerSettlement.update({
        where,
        data: { status: 'ATTESTED', attestTxHash, attestationUID, error: null },
      })
      log.info(
        {
          event: 'settlement.attested',
          needId: request.needId,
          trancheIndex: request.trancheIndex,
          attestationUID,
        },
        'tranche payout attested',
      )
      return { settlement, idempotent: false }
    } catch (error) {
      await prisma().providerSettlement.update({
        where,
        data: { status: 'FAILED', error: errorSummary(error).slice(0, 500) },
      })
      throw httpErrorFromRevert(error)
    }
  })
}

export const settlementView = ({ settlement, idempotent }: SettlementResult) => ({
  id: settlement.id,
  needId: settlement.needId,
  trancheIndex: settlement.trancheIndex,
  gross: settlement.grossBaseUnits,
  fee: settlement.feeBaseUnits,
  net: (BigInt(settlement.grossBaseUnits) - BigInt(settlement.feeBaseUnits)).toString(),
  attestationUID: settlement.attestationUID,
  txHash: settlement.attestTxHash,
  status: settlement.status,
  idempotent,
})

export const registerSettlementRoutes = (app: FastifyInstance, deps: RouteDeps): void => {
  const { config } = deps
  app.withTypeProvider<ZodTypeProvider>().post(
    '/settlements',
    {
      preValidation: async (request: FastifyRequest) => verifySignature(config, request),
      schema: {
        tags: ['settlements'],
        summary: 'Report the payout of a releasable tranche of an off-chain need',
        description: [
          'Signed like the SEPA webhook. Only for needs in off-chain custody whose custodian is this provider',
          '(403 `NOT_CUSTODIAN`; 409 `NOT_OFF_CHAIN_CUSTODY` for on-chain needs), and only for a Releasable',
          'tranche (409 `TRANCHE_NOT_RELEASABLE`). `gross` is the tranche amount on-chain; the fee is capped by the',
          'need’s cost disclosure. The `Settlement` attestation releases the tranche in the ledger. Idempotent on',
          '(needId, trancheIndex); amounts are base-unit decimal strings.',
        ].join(' '),
        body: SettlementRequestSchema,
        response: { 200: SettlementResponseSchema },
      },
    },
    async (request) =>
      settlementView(await recordSettlement({ config, chain: deps.chain, log: request.log }, request.body)),
  )
}
