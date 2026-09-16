import { z } from 'zod'
import { CURRENCY_PATTERN, type FundingDeps, type FundingResult, recordFunding } from './funding.js'

/**
 * The SEPA credit-transfer webhook: a settled bank payment the provider received for a need. The pipeline itself
 * lives in funding.ts and is shared with the checkout mock and the CSV import.
 */

export const SepaWebhookSchema = z.object({
  /** ISO 20022 EndToEndId; the idempotency key of the whole flow. */
  endToEndId: z.string().min(1).max(140),
  /** What the donor paid (gross), in euro cents. */
  amountEurCents: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  /** What the provider keeps, in euro cents. Capped by the need's cost disclosure; the rest is absorbed. */
  feeEurCents: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
  /** ISO 4217 code of the currency the donor paid in. Amounts are always the EUR stablecoin equivalent. */
  currency: z.string().regex(CURRENCY_PATTERN, 'currency must be an ISO 4217 code').default('EUR'),
  donorReference: z.string().min(1).max(140),
  needId: z.string().regex(/^\d{1,78}$/, 'needId must be a decimal integer string'),
})

export type SepaWebhook = z.infer<typeof SepaWebhookSchema>

export const processSepaPayment = (deps: FundingDeps, payload: SepaWebhook): Promise<FundingResult> =>
  recordFunding(deps, {
    endToEndId: payload.endToEndId,
    needId: payload.needId,
    grossEurCents: payload.amountEurCents,
    feeEurCents: payload.feeEurCents,
    currency: payload.currency,
    donorReference: payload.donorReference,
    source: 'SEPA',
  })
