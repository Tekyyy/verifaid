import { encodeSchemaData, saltedRefHash } from '@poa/shared'
import { type FiatTransfer, prisma } from '@poa/shared/db'
import type { FastifyBaseLogger } from 'fastify'
import { type Address, type Hex, zeroHash } from 'viem'
import { z } from 'zod'
import {
  aidVaultAbi,
  attestationForPayment,
  type Chain,
  confirm,
  easAbi,
  isBankPartner,
  mockEURCAbi,
  paymentRefUsed,
  readNeed,
  tokenAllowance,
  tokenBalance,
} from './chain.js'
import type { BankConfig } from './config.js'
import { badRequest, forbidden, notFound } from './errors.js'

/**
 * A fiat donation crossing into the chain (spec §5.6, §9.3).
 *
 * The whole flow is keyed on the ISO 20022 end-to-end id, which a bank may deliver more than once. Idempotency
 * is therefore not a nicety: replaying a webhook must never produce a second deposit. Two independent guards
 * enforce it — the `status` column records how far the last run got, and every step re-checks the chain, which
 * is the only authority on whether the deposit or the attestation already exists.
 *
 * `paymentRefHash = keccak256(abi.encode(salt, endToEndId))`. The salt never leaves this process, so the chain
 * carries a commitment to the payment that only the partner (or an auditor it shares the salt with) can open.
 */

/** 2 = Funding, per INeedsRegistry.NeedStatus. Donations are only accepted while a need is funding. */
const NEED_STATUS_FUNDING = 2

/** EUR cents → 6-decimal stablecoin base units. */
const CENTS_TO_BASE_UNITS = 10_000n

export const SepaWebhookSchema = z.object({
  /** ISO 20022 EndToEndId; the idempotency key of the whole flow. */
  endToEndId: z.string().min(1).max(140),
  amountEurCents: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  donorReference: z.string().min(1).max(140),
  needId: z.string().regex(/^\d+$/, 'needId must be a decimal integer string'),
})

export type SepaWebhook = z.infer<typeof SepaWebhookSchema>

export const TRANSFER_STATUS = ['RECEIVED', 'FUNDED', 'DONATED', 'ATTESTED', 'FAILED'] as const
export type TransferStatus = (typeof TRANSFER_STATUS)[number]

export interface ProcessResult {
  transfer: FiatTransfer
  /** True when the webhook was a replay and no new transaction was sent. */
  idempotent: boolean
}

export interface ProcessDeps {
  config: BankConfig
  chain: Chain
  log: FastifyBaseLogger
}

/**
 * Runs (or resumes) the pipeline for one payment. Steps, each skippable when the chain already shows it done:
 *   1. hold stablecoin  2. approve the vault  3. `donateOnBehalf`  4. `FiatDonation` attestation
 */
export const processSepaPayment = async (deps: ProcessDeps, payload: SepaWebhook): Promise<ProcessResult> => {
  const { chain, config, log } = deps
  const paymentRefHash = saltedRefHash(config.refSalt, payload.endToEndId)
  const donorRefHash = saltedRefHash(config.refSalt, payload.donorReference)
  const amount = BigInt(payload.amountEurCents) * CENTS_TO_BASE_UNITS

  const existing = await prisma().fiatTransfer.findUnique({ where: { endToEndId: payload.endToEndId } })
  // Checked before the replay shortcut: a reference reused for a different payment is a mistake to report, not
  // a duplicate to absorb silently.
  if (existing && (existing.amountBaseUnits !== amount.toString() || existing.needId !== payload.needId)) {
    throw badRequest(
      'This endToEndId was already recorded with a different amount or need',
      'REFERENCE_CONFLICT',
    )
  }
  if (existing?.status === 'ATTESTED') {
    // Nothing left to do: the deposit and its attestation are both on-chain.
    log.info({ event: 'sepa.replay', paymentRefHash }, 'webhook replayed after completion')
    return { transfer: existing, idempotent: true }
  }

  if (!(await isBankPartner(chain, chain.account.address))) {
    throw forbidden('The configured wallet does not hold BANK_PARTNER_ROLE on-chain')
  }

  const need = await readNeed(chain, BigInt(payload.needId))
  if (!need) throw notFound(`Need ${payload.needId} does not exist`)
  if (need.vault === '0x0000000000000000000000000000000000000000') {
    throw notFound(`Need ${payload.needId} has no vault yet; it must be verified first`)
  }

  const alreadyDeposited = await paymentRefUsed(chain, need.vault, paymentRefHash)
  if (!alreadyDeposited && need.status !== NEED_STATUS_FUNDING) {
    throw badRequest(`Need ${payload.needId} is not open for funding`, 'NEED_NOT_FUNDING')
  }

  let transfer =
    existing ??
    (await prisma().fiatTransfer.create({
      data: {
        endToEndId: payload.endToEndId,
        needId: payload.needId,
        vault: need.vault,
        amountBaseUnits: amount.toString(),
        amountEurCents: payload.amountEurCents,
        paymentRefHash,
        donorRefHash,
        status: 'RECEIVED',
      },
    }))

  const setStatus = async (status: TransferStatus, data: Partial<FiatTransfer> = {}): Promise<void> => {
    transfer = await prisma().fiatTransfer.update({
      where: { endToEndId: payload.endToEndId },
      data: { status, error: null, ...data },
    })
  }

  try {
    if (!alreadyDeposited) {
      await ensureFunded(deps, need.vault, amount)
      await setStatus('FUNDED')

      const donateTxHash = await confirm(
        chain,
        await chain.wallet.writeContract({
          account: chain.account,
          chain: null,
          address: need.vault,
          abi: aidVaultAbi,
          functionName: 'donateOnBehalf',
          args: [amount, donorRefHash, paymentRefHash],
        }),
      )
      log.info({ event: 'sepa.donated', paymentRefHash, needId: payload.needId }, 'fiat donation deposited')
      await setStatus('DONATED', { donateTxHash } as Partial<FiatTransfer>)
    } else if (
      transfer.status === 'RECEIVED' ||
      transfer.status === 'FUNDED' ||
      transfer.status === 'FAILED'
    ) {
      // The deposit landed but the run was interrupted before the row caught up.
      await setStatus('DONATED')
    }

    const existingUid = await attestationForPayment(chain, paymentRefHash)
    if (existingUid !== zeroHash) {
      await setStatus('ATTESTED', { attestationUID: existingUid } as Partial<FiatTransfer>)
      return { transfer, idempotent: true }
    }

    const attestTxHash = await confirm(
      chain,
      await chain.wallet.writeContract({
        account: chain.account,
        chain: null,
        address: chain.deployment.external.EAS,
        abi: easAbi,
        functionName: 'attest',
        args: [
          {
            schema: chain.deployment.schemas.FiatDonation,
            data: {
              // Never a person: the attestation is addressed to the vault that received the money (spec §6).
              recipient: need.vault,
              expirationTime: 0n,
              revocable: false,
              refUID: zeroHash,
              data: encodeSchemaData('FiatDonation', [
                BigInt(payload.needId),
                amount,
                paymentRefHash,
                donorRefHash,
              ]),
              value: 0n,
            },
          },
        ],
      }),
    )

    const attestationUID = await attestationForPayment(chain, paymentRefHash)
    await setStatus('ATTESTED', { attestTxHash, attestationUID } as Partial<FiatTransfer>)
    log.info({ event: 'sepa.attested', paymentRefHash, attestationUID }, 'fiat donation attested')
    return { transfer, idempotent: false }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown error'
    await prisma().fiatTransfer.update({
      where: { endToEndId: payload.endToEndId },
      data: { status: 'FAILED', error: message.slice(0, 500) },
    })
    throw error
  }
}

/**
 * Makes sure the hot wallet holds and has approved the amount. Minting is a demo affordance of `MockEURC`; with
 * a real stablecoin the partner already holds the converted funds and this step is a balance check that fails
 * loudly rather than inventing money.
 */
const ensureFunded = async (deps: ProcessDeps, vault: Address, amount: bigint): Promise<void> => {
  const { chain, log } = deps
  const partner = chain.account.address

  if ((await tokenBalance(chain, partner)) < amount) {
    const mintable = await chain.client
      .simulateContract({
        account: chain.account,
        address: chain.deployment.external.Token,
        abi: mockEURCAbi,
        functionName: 'mint',
        args: [partner, amount],
      })
      .then(() => true)
      .catch(() => false)
    if (!mintable) {
      throw badRequest(
        'The partner wallet does not hold enough stablecoin and the token is not mintable',
        'NO_FUNDS',
      )
    }
    log.warn(
      { event: 'sepa.minted', amount: amount.toString() },
      'minted demo stablecoin for a fiat donation',
    )
    await confirm(
      chain,
      await chain.wallet.writeContract({
        account: chain.account,
        chain: null,
        address: chain.deployment.external.Token,
        abi: mockEURCAbi,
        functionName: 'mint',
        args: [partner, amount],
      }),
    )
  }

  if ((await tokenAllowance(chain, partner, vault)) < amount) {
    await confirm(
      chain,
      await chain.wallet.writeContract({
        account: chain.account,
        chain: null,
        address: chain.deployment.external.Token,
        abi: mockEURCAbi,
        functionName: 'approve',
        args: [vault, amount],
      }),
    )
  }
}

export const findTransfer = async (endToEndId: string): Promise<FiatTransfer | null> =>
  prisma().fiatTransfer.findUnique({ where: { endToEndId } })

export type { Hex }
