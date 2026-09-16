import { easAttestationUrl, explorerTxUrl, saltedRefHash } from '@poa/shared'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import type { Hex } from 'viem'
import { z } from 'zod'
import type { Chain } from './chain.js'
import { registerCheckoutRoutes } from './checkout.js'
import type { BankConfig } from './config.js'
import { notFound } from './errors.js'
import { findTransfer, transferAmounts } from './funding.js'
import { registerImportRoutes } from './imports.js'
import { processSepaPayment, SepaWebhookSchema } from './sepa.js'
import { registerSettlementRoutes } from './settlements.js'
import { verifySignature } from './signature.js'

/**
 * The provider-facing surface. Deliberately asymmetric: everything that creates money on-chain (the SEPA webhook,
 * the CSV import, settlements) is authenticated with a shared HMAC because only the bank may do it; the proof
 * endpoint is open because the end-to-end id is itself the donor's capability — and the response contains no
 * personal data, no raw reference and no salt. The checkout mock is the one open writer, and it is a sandbox.
 */

export interface RouteDeps {
  config: BankConfig
  chain: Chain
}

const CustodyModeSchema = z.enum(['OnChain', 'OffChain'])

const TransferAmountsSchema = {
  /** Net amount, kept under its v1 name: what reached the ledger and counts toward the target. */
  amountBaseUnits: z.string(),
  grossBaseUnits: z.string(),
  feeBaseUnits: z.string(),
  netBaseUnits: z.string(),
  currency: z.string(),
  custodyMode: CustodyModeSchema,
  source: z.string(),
}

const ProofSchema = z.object({
  needId: z.string(),
  /** The need's ledger: AidVault (OnChain) or NonCustodialLedger (OffChain). */
  vault: z.string(),
  ...TransferAmountsSchema,
  /** What the donor paid, in euro cents. */
  amountEurCents: z.number(),
  paymentRefHash: z.string(),
  donorRefHash: z.string(),
  status: z.string(),
  /** Null for an off-chain need: no token moves. */
  donateTxHash: z.string().nullable(),
  attestTxHash: z.string().nullable(),
  /** UID of the `FundingRecorded` attestation. */
  attestationUID: z.string().nullable(),
  attestationSchema: z.literal('FundingRecorded'),
  createdAt: z.string(),
  links: z.object({
    donateTx: z.string().nullable(),
    attestTx: z.string().nullable(),
    attestation: z.string().nullable(),
  }),
})

const custodyMode = (value: string): 'OnChain' | 'OffChain' => (value === 'OffChain' ? 'OffChain' : 'OnChain')

export const registerRoutes = (app: FastifyInstance, deps: RouteDeps): void => {
  const typed = app.withTypeProvider<ZodTypeProvider>()

  typed.post(
    '/webhooks/sepa',
    {
      // Runs before validation so an unsigned request never reaches the schema, let alone the chain.
      preValidation: async (request: FastifyRequest) => verifySignature(deps.config, request),
      schema: {
        tags: ['webhooks'],
        summary: 'Receive a settled SEPA credit transfer',
        description: [
          'Signed with `x-poa-signature: sha256=<hex>`, an HMAC-SHA256 of the raw body under `BANK_WEBHOOK_SECRET`.',
          '`amountEurCents` is what the donor paid (gross); `feeEurCents` (default 0) is what the provider keeps,',
          'capped by the need’s cost disclosure. On-chain need: the net amount is deposited with `donateOnBehalf`,',
          'then `FundingRecorded` is attested. Off-chain need: only the attestation, and only if this provider is',
          'the need’s custodian (403 `NOT_CUSTODIAN`). Idempotent on `endToEndId`: a replay returns the stored',
          'record and sends no transaction, and a run interrupted midway resumes from whichever step the chain',
          'shows as missing. 409 `NEED_NOT_FUNDING` / `EXCEEDS_REMAINING` when the need cannot take the money.',
        ].join(' '),
        body: SepaWebhookSchema,
        response: {
          200: z.object({
            status: z.string(),
            idempotent: z.boolean(),
            needId: z.string(),
            vault: z.string(),
            ...TransferAmountsSchema,
            paymentRefHash: z.string(),
            donorRefHash: z.string(),
            donateTxHash: z.string().nullable(),
            attestTxHash: z.string().nullable(),
            attestationUID: z.string().nullable(),
          }),
        },
      },
    },
    async (request) => {
      const { transfer, idempotent } = await processSepaPayment(
        { config: deps.config, chain: deps.chain, log: request.log },
        request.body,
      )
      const amounts = transferAmounts(transfer)
      return {
        status: transfer.status,
        idempotent,
        needId: transfer.needId,
        vault: transfer.vault,
        amountBaseUnits: transfer.amountBaseUnits,
        grossBaseUnits: amounts.gross,
        feeBaseUnits: amounts.fee,
        netBaseUnits: amounts.net,
        currency: transfer.currency,
        custodyMode: custodyMode(transfer.custodyMode),
        source: transfer.source,
        paymentRefHash: transfer.paymentRefHash,
        donorRefHash: transfer.donorRefHash,
        donateTxHash: transfer.donateTxHash,
        attestTxHash: transfer.attestTxHash,
        attestationUID: transfer.attestationUID,
      }
    },
  )

  typed.get(
    '/donations/:endToEndId/proof',
    {
      schema: {
        tags: ['donations'],
        summary: 'Proof that a fiat payment reached a need',
        description:
          'Everything a donor needs to check their payment against the chain: gross, fee and net amounts, the ' +
          'currency, the need’s custody mode and the `FundingRecorded` attestation UID. The salt and the raw ' +
          'references are never returned: the donor already holds the reference and can recompute nothing ' +
          'without the salt. Works for SEPA, checkout (`CHK-…`) and CSV-imported payments alike.',
        params: z.object({ endToEndId: z.string().min(1).max(140) }),
        response: { 200: ProofSchema },
      },
    },
    async (request) => {
      const transfer = await findTransfer(request.params.endToEndId)
      if (!transfer) throw notFound('No fiat donation recorded for that reference')
      const amounts = transferAmounts(transfer)
      const { network } = deps.config

      return {
        needId: transfer.needId,
        vault: transfer.vault,
        amountBaseUnits: transfer.amountBaseUnits,
        grossBaseUnits: amounts.gross,
        feeBaseUnits: amounts.fee,
        netBaseUnits: amounts.net,
        currency: transfer.currency,
        custodyMode: custodyMode(transfer.custodyMode),
        source: transfer.source,
        amountEurCents: transfer.amountEurCents,
        paymentRefHash: transfer.paymentRefHash,
        donorRefHash: transfer.donorRefHash,
        status: transfer.status,
        donateTxHash: transfer.donateTxHash,
        attestTxHash: transfer.attestTxHash,
        attestationUID: transfer.attestationUID,
        attestationSchema: 'FundingRecorded' as const,
        createdAt: transfer.createdAt.toISOString(),
        links: {
          donateTx: transfer.donateTxHash ? explorerTxUrl(network, transfer.donateTxHash as Hex) : null,
          attestTx: transfer.attestTxHash ? explorerTxUrl(network, transfer.attestTxHash as Hex) : null,
          attestation: transfer.attestationUID
            ? easAttestationUrl(network, transfer.attestationUID as Hex)
            : null,
        },
      }
    },
  )

  typed.get(
    '/donations/:endToEndId/reference-hash',
    {
      schema: {
        tags: ['donations'],
        summary: 'Compute the on-chain hash of a payment reference',
        description:
          'Lets a donor or auditor turn a reference they already hold into the value the chain stores, without ' +
          'the salt ever leaving this service.',
        params: z.object({ endToEndId: z.string().min(1).max(140) }),
        response: { 200: z.object({ paymentRefHash: z.string() }) },
      },
    },
    async (request) => ({ paymentRefHash: saltedRefHash(deps.config.refSalt, request.params.endToEndId) }),
  )

  if (deps.config.checkout.enabled) registerCheckoutRoutes(app, deps)
  registerImportRoutes(app, deps)
  registerSettlementRoutes(app, deps)
}
