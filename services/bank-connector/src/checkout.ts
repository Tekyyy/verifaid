import { randomUUID } from 'node:crypto'
import { hmac } from '@poa/shared'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { toBytes } from 'viem'
import { z } from 'zod'
import { badRequest, conflict, HttpError } from './errors.js'
import { cardFeeCents, parseEurAmount } from './fees.js'
import { type FundingDeps, findTransfer, recordFunding, transferAmounts } from './funding.js'
import { createRateLimiter } from './rate-limit.js'
import type { RouteDeps } from './routes.js'

/**
 * Checkout mock (gap plan A7): the donor-facing "give by card or bank" flow, standing in for a payment service
 * provider. It never sees card data — a real integration would hand that to the PSP's hosted fields — and runs the
 * same funding pipeline as a SEPA webhook once the "payment" succeeds, so the result on-chain is identical.
 *
 * Mock PSP pricing: card = 1.4% + €0.25 (configurable), bank transfer = free. The fee is then capped by the need's
 * cost disclosure; whatever the PSP would have charged above it, the provider absorbs.
 */

export const CHECKOUT_METHODS = ['card', 'bank'] as const
export type CheckoutMethod = (typeof CHECKOUT_METHODS)[number]

export const CheckoutRequestSchema = z.strictObject({
  needId: z.string().regex(/^\d{1,78}$/, 'needId must be a decimal integer string'),
  /** Decimal EUR the donor pays, e.g. "25.00". */
  amount: z
    .string()
    .max(13)
    .refine(
      (value) => (parseEurAmount(value) ?? 0) > 0,
      'amount must be a positive EUR amount with at most 2 decimals',
    ),
  method: z.enum(CHECKOUT_METHODS),
  /** Optional reference the donor can later use to find their donation; stored only as a salted hash. */
  donorReference: z.string().min(1).max(140).optional(),
})

export type CheckoutRequest = z.infer<typeof CheckoutRequestSchema>

export const CheckoutResponseSchema = z.object({
  checkoutId: z.string(),
  /** The salted payment reference hash: the "track this donation" reference, identical to the on-chain value. */
  trackingRef: z.string(),
  needId: z.string(),
  method: z.enum(CHECKOUT_METHODS),
  currency: z.literal('EUR'),
  /** Base units (6 decimals): what the donor paid, what intermediaries kept, what counts toward the target. */
  gross: z.string(),
  fee: z.string(),
  net: z.string(),
  status: z.string(),
  custodyMode: z.enum(['OnChain', 'OffChain']),
})

const IDEMPOTENCY_HEADER = 'idempotency-key'
const IDEMPOTENCY_KEY = /^[\x21-\x7e]{1,255}$/

/** Field names that suggest someone is trying to send card data, rejected with an explicit message. */
const CARD_FIELD = /card|^pan$|cvv|cvc|expir|exp_?(month|year|date)|security_?code/i

/**
 * `CHK-<uuid>`. With an Idempotency-Key the id is derived from it (keyed with the reference salt, so nobody can
 * predict another client's checkout id), which makes a retry land on the very same payment row and on-chain
 * reference without a separate key store.
 */
export const checkoutIdFor = (refSalt: `0x${string}`, idempotencyKey?: string): string => {
  if (!idempotencyKey) return `CHK-${randomUUID()}`
  const hex = hmac(Buffer.from(toBytes(refSalt)), `checkout-idempotency:${idempotencyKey}`)
    .subarray(0, 16)
    .toString('hex')
  return `CHK-${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
}

export const registerCheckoutRoutes = (app: FastifyInstance, deps: RouteDeps): void => {
  const { config } = deps
  const limiter = createRateLimiter(config.checkout.rateLimitPerMinute)

  app.withTypeProvider<ZodTypeProvider>().post(
    '/checkout/sessions',
    {
      onRequest: limiter,
      preValidation: async (request: FastifyRequest) => rejectCardData(request.body),
      schema: {
        tags: ['checkout'],
        summary: 'Mock card or bank checkout for a need (sandbox)',
        description: [
          'Sandbox stand-in for a payment service provider. **Never send card data**: requests carrying card fields',
          'are rejected. The "payment" succeeds immediately and runs the same pipeline as a SEPA webhook: an',
          'on-chain need receives a stablecoin deposit plus a `FundingRecorded` attestation, an off-chain need',
          'only the attestation. Fees: card 1.4% + €0.25, bank €0, capped by the need’s cost disclosure.',
          'Send an `Idempotency-Key` header to retry safely: the same key returns the same checkout without a',
          'second transaction (`idempotent-replayed: true`); reusing it for a different checkout is a 409.',
          'Errors: 400 validation, 404 unknown need, 409 need not open (`NEED_NOT_FUNDING`) or above the remaining',
          'target (`EXCEEDS_REMAINING`, with `remaining` in base units), 429 rate limited.',
        ].join(' '),
        headers: z.looseObject({ [IDEMPOTENCY_HEADER]: z.string().min(1).max(255).optional() }),
        body: CheckoutRequestSchema,
        response: { 201: CheckoutResponseSchema },
      },
    },
    async (request, reply) => {
      const header = request.headers[IDEMPOTENCY_HEADER]
      const idempotencyKey = Array.isArray(header) ? header[0] : header
      if (idempotencyKey !== undefined && !IDEMPOTENCY_KEY.test(idempotencyKey)) {
        throw badRequest(
          'Idempotency-Key must be 1-255 printable ASCII characters',
          'INVALID_IDEMPOTENCY_KEY',
        )
      }

      const { transfer, idempotent } = await createCheckout(
        { config, chain: deps.chain, log: request.log },
        request.body,
        idempotencyKey,
      )
      reply.code(201).header('idempotent-replayed', String(idempotent))
      const amounts = transferAmounts(transfer)
      return {
        checkoutId: transfer.endToEndId,
        trackingRef: transfer.paymentRefHash,
        needId: transfer.needId,
        method: request.body.method,
        currency: 'EUR' as const,
        gross: amounts.gross,
        fee: amounts.fee,
        net: amounts.net,
        status: transfer.status,
        custodyMode: transfer.custodyMode === 'OffChain' ? ('OffChain' as const) : ('OnChain' as const),
      }
    },
  )
}

const rejectCardData = (body: unknown): void => {
  if (body && typeof body === 'object' && Object.keys(body).some((key) => CARD_FIELD.test(key))) {
    throw badRequest('This checkout never accepts card data; the PSP collects it', 'CARD_DATA_REJECTED')
  }
}

export const createCheckout = async (deps: FundingDeps, body: CheckoutRequest, idempotencyKey?: string) => {
  const amountCents = parseEurAmount(body.amount)
  if (amountCents === null || amountCents <= 0) throw badRequest('amount must be a positive EUR amount')
  const pspFeeCents =
    body.method === 'card'
      ? cardFeeCents(amountCents, deps.config.checkout.cardFeeBps, deps.config.checkout.cardFeeFixedCents)
      : 0
  const source = body.method === 'card' ? 'CARD' : 'BANK'
  const endToEndId = checkoutIdFor(deps.config.refSalt, idempotencyKey)
  const reused = () =>
    conflict('This Idempotency-Key was already used for a different checkout', 'IDEMPOTENCY_KEY_REUSED')

  if (idempotencyKey) {
    const existing = await findTransfer(endToEndId)
    if (existing && existing.source !== source) throw reused()
  }

  try {
    return await recordFunding(deps, {
      endToEndId,
      needId: body.needId,
      grossEurCents: amountCents,
      // A tiny card payment may not even cover the fixed fee; the pipeline rejects a zero net amount.
      feeEurCents: Math.min(pspFeeCents, amountCents),
      currency: 'EUR',
      donorReference: body.donorReference ?? `checkout:${endToEndId}`,
      source,
    })
  } catch (error) {
    if (error instanceof HttpError && error.code === 'REFERENCE_CONFLICT') throw reused()
    throw error
  }
}
