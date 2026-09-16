import { easAttestationUrl, explorerTxUrl, saltedRefHash, verifyWebhookSignature } from '@poa/shared'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import type { Hex } from 'viem'
import { z } from 'zod'
import type { Chain } from './chain.js'
import type { BankConfig } from './config.js'
import { notFound, unauthorized } from './errors.js'
import { findTransfer, processSepaPayment, SepaWebhookSchema } from './sepa.js'

/**
 * The bank-facing surface. Two endpoints, deliberately asymmetric: the webhook is authenticated with a shared
 * HMAC because only the bank may create donations, while the proof endpoint is open because the end-to-end id
 * is itself the donor's capability — and the response contains no personal data, no raw reference and no salt.
 */

export interface RouteDeps {
  config: BankConfig
  chain: Chain
}

const SIGNATURE_HEADER = 'x-poa-signature'

const ProofSchema = z.object({
  needId: z.string(),
  vault: z.string(),
  amountBaseUnits: z.string(),
  amountEurCents: z.number(),
  paymentRefHash: z.string(),
  donorRefHash: z.string(),
  status: z.string(),
  donateTxHash: z.string().nullable(),
  attestTxHash: z.string().nullable(),
  attestationUID: z.string().nullable(),
  createdAt: z.string(),
  links: z.object({
    donateTx: z.string().nullable(),
    attestTx: z.string().nullable(),
    attestation: z.string().nullable(),
  }),
})

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
          'Idempotent on `endToEndId`: a replay returns the stored record and sends no transaction, and a run',
          'interrupted midway resumes from whichever step the chain shows as missing.',
        ].join(' '),
        body: SepaWebhookSchema,
        response: {
          200: z.object({
            status: z.string(),
            idempotent: z.boolean(),
            needId: z.string(),
            vault: z.string(),
            amountBaseUnits: z.string(),
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
      return {
        status: transfer.status,
        idempotent,
        needId: transfer.needId,
        vault: transfer.vault,
        amountBaseUnits: transfer.amountBaseUnits,
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
          'Everything a donor needs to check their transfer against the chain. The salt and the raw references ' +
          'are never returned: the donor already holds the reference and can recompute nothing without the salt.',
        params: z.object({ endToEndId: z.string().min(1).max(140) }),
        response: { 200: ProofSchema },
      },
    },
    async (request) => {
      const transfer = await findTransfer(request.params.endToEndId)
      if (!transfer) throw notFound('No fiat donation recorded for that reference')

      return {
        needId: transfer.needId,
        vault: transfer.vault,
        amountBaseUnits: transfer.amountBaseUnits,
        amountEurCents: transfer.amountEurCents,
        paymentRefHash: transfer.paymentRefHash,
        donorRefHash: transfer.donorRefHash,
        status: transfer.status,
        donateTxHash: transfer.donateTxHash,
        attestTxHash: transfer.attestTxHash,
        attestationUID: transfer.attestationUID,
        createdAt: transfer.createdAt.toISOString(),
        links: {
          donateTx: transfer.donateTxHash
            ? explorerTxUrl(deps.config.network, transfer.donateTxHash as Hex)
            : null,
          attestTx: transfer.attestTxHash
            ? explorerTxUrl(deps.config.network, transfer.attestTxHash as Hex)
            : null,
          attestation: transfer.attestationUID
            ? easAttestationUrl(deps.config.network, transfer.attestationUID as Hex)
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
}

/** HMAC over the raw bytes the bank sent, not over a re-serialised object, which would not round-trip. */
const verifySignature = async (config: BankConfig, request: FastifyRequest): Promise<void> => {
  if (!config.webhookSecret) {
    request.log.warn(
      { event: 'webhook.unauthenticated' },
      'BANK_WEBHOOK_SECRET is unset: accepting unsigned SEPA webhooks — development only',
    )
    return
  }
  const header = request.headers[SIGNATURE_HEADER]
  const signature = Array.isArray(header) ? header[0] : header
  const rawBody = (request as FastifyRequest & { rawBody?: string }).rawBody ?? ''
  if (!verifyWebhookSignature(config.webhookSecret, rawBody, signature)) {
    request.log.warn({ event: 'webhook.rejected' }, 'SEPA webhook signature did not verify')
    throw unauthorized(`Missing or invalid ${SIGNATURE_HEADER}`, 'BAD_SIGNATURE')
  }
}
