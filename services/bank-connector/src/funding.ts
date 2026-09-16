import { regionCode, saltedRefHash } from '@poa/shared'
import { type FiatTransfer, type Prisma, prisma } from '@poa/shared/db'
import type { FastifyBaseLogger } from 'fastify'
import type { Address, Hex } from 'viem'
import {
  attestToLedger,
  type Chain,
  confirm,
  depositMatches,
  exclusive,
  fundingAttestationFor,
  hasLedger,
  httpErrorFromRevert,
  isBankPartner,
  mockEURCAbi,
  type NeedTarget,
  paymentRefConsumed,
  readFeeState,
  readFundingAttestation,
  readNeed,
  tokenAllowance,
  tokenBalance,
  VAULT_WRITE_ABI,
} from './chain.js'
import type { BankConfig } from './config.js'
import { badRequest, conflict, errorSummary, forbidden, notFound } from './errors.js'
import {
  centsToBaseUnits,
  formatEur,
  MAX_AMOUNT_CENTS,
  maxFundingFee,
  maxFundingFeeAfterDeposit,
  minBigInt,
} from './fees.js'

/**
 * A payment crossing into the chain (spec §5.6, §9.3), whichever way it arrived: a SEPA webhook, the checkout
 * mock or a CSV import. All three produce the same on-chain record, a `FundingRecorded` attestation by this
 * provider, addressed to the need's ledger:
 *
 * - **OnChain** need (AidVault): the net amount is deposited with `donateOnBehalf` first, then attested; the
 *   resolver checks the attestation against the deposit.
 * - **OffChain** need (NonCustodialLedger): no token moves. The provider keeps the money and the attestation is
 *   what counts it toward the target — which is why only the need's named custodian may make it.
 *
 * The flow is keyed on the ISO 20022 end-to-end id, which a bank may deliver more than once, so idempotency is not
 * a nicety. Two independent guards enforce it: the `status` column records how far the last run got, and every
 * step re-checks the chain — `AidVaultFactory.isPaymentRefConsumed(provider, ref)` for the deposit and
 * `ProofOfAidResolver.fundingAttestationOf(provider, ref)` for the attestation — which is the only authority.
 *
 * `paymentRefHash = keccak256(abi.encode(salt, endToEndId))`. The salt never leaves this process, so the chain
 * carries a commitment to the payment that only the provider (or an auditor it shares the salt with) can open.
 */

export const FUNDING_SOURCES = ['SEPA', 'CARD', 'BANK', 'CSV'] as const
export type FundingSource = (typeof FUNDING_SOURCES)[number]

export const TRANSFER_STATUS = ['RECEIVED', 'FUNDED', 'DONATED', 'ATTESTED', 'FAILED'] as const
export type TransferStatus = (typeof TRANSFER_STATUS)[number]

/** ISO 4217 alphabetic code, packed into bytes32 on-chain like a region code. */
export const CURRENCY_PATTERN = /^[A-Z]{3}$/

export interface FundingInstruction {
  /** ISO 20022 EndToEndId (or `CHK-…` for a checkout); the idempotency key of the whole flow. */
  endToEndId: string
  /** Decimal need id. */
  needId: string
  /** What the donor paid, in euro cents. */
  grossEurCents: number
  /** What the provider wants to keep, in euro cents, before the disclosure cap. */
  feeEurCents: number
  currency: string
  donorReference: string
  source: FundingSource
}

export interface FundingResult {
  transfer: FiatTransfer
  /** True when the payment was already recorded and no new transaction was sent. */
  idempotent: boolean
}

export interface FundingDeps {
  config: BankConfig
  chain: Chain
  log: FastifyBaseLogger
}

export const findTransfer = async (endToEndId: string): Promise<FiatTransfer | null> =>
  prisma().fiatTransfer.findUnique({ where: { endToEndId } })

/** Amounts of a stored transfer, as the attestation carries them. */
export const transferAmounts = (transfer: FiatTransfer): { gross: string; fee: string; net: string } => ({
  gross: (BigInt(transfer.amountBaseUnits) + BigInt(transfer.feeBaseUnits)).toString(),
  fee: transfer.feeBaseUnits,
  net: transfer.amountBaseUnits,
})

/**
 * Runs (or resumes) the pipeline for one payment. Steps, each skipped when the chain already shows it done:
 *   OnChain:  1. hold stablecoin  2. approve the vault  3. `donateOnBehalf(net)`  4. `FundingRecorded`
 *   OffChain: 4. `FundingRecorded`
 */
export const recordFunding = async (
  deps: FundingDeps,
  instruction: FundingInstruction,
): Promise<FundingResult> => {
  validateInstruction(instruction)
  const paymentRefHash = saltedRefHash(deps.config.refSalt, instruction.endToEndId)
  const donorRefHash = saltedRefHash(deps.config.refSalt, instruction.donorReference)

  // Fast path outside the write queue: a completed payment is answered from the database alone.
  const existing = await findTransfer(instruction.endToEndId)
  if (existing) {
    assertSamePayment(existing, instruction, donorRefHash)
    if (existing.status === 'ATTESTED') {
      deps.log.info({ event: 'funding.replay', paymentRefHash }, 'payment replayed after completion')
      return { transfer: existing, idempotent: true }
    }
  }

  return exclusive(deps.chain, () => runFunding(deps, instruction, paymentRefHash, donorRefHash))
}

const validateInstruction = (instruction: FundingInstruction): void => {
  if (!Number.isSafeInteger(instruction.grossEurCents) || instruction.grossEurCents <= 0) {
    throw badRequest('The amount must be a positive number of cents', 'INVALID_AMOUNT')
  }
  if (instruction.grossEurCents > MAX_AMOUNT_CENTS)
    throw badRequest('The amount is too large', 'INVALID_AMOUNT')
  if (!Number.isSafeInteger(instruction.feeEurCents) || instruction.feeEurCents < 0) {
    throw badRequest('The fee must be zero or a positive number of cents', 'INVALID_FEE')
  }
  if (instruction.feeEurCents > instruction.grossEurCents) {
    throw badRequest('The fee cannot exceed the amount the donor paid', 'FEE_EXCEEDS_AMOUNT')
  }
  if (!CURRENCY_PATTERN.test(instruction.currency)) {
    throw badRequest('The currency must be an ISO 4217 code such as EUR', 'INVALID_CURRENCY')
  }
  if (!/^\d{1,78}$/.test(instruction.needId)) throw badRequest('needId must be a decimal integer string')
}

/**
 * A reference reused for a different payment is a mistake to report, not a duplicate to absorb silently. The
 * fee is not compared: the stored one may have been capped by the disclosure.
 */
const assertSamePayment = (
  existing: FiatTransfer,
  instruction: FundingInstruction,
  donorRefHash: Hex,
): void => {
  if (
    existing.needId !== instruction.needId ||
    existing.amountEurCents !== instruction.grossEurCents ||
    existing.currency !== instruction.currency ||
    existing.donorRefHash !== donorRefHash
  ) {
    throw badRequest(
      'This endToEndId was already recorded with a different amount, currency, donor or need',
      'REFERENCE_CONFLICT',
    )
  }
}

const sameAddress = (a: Address, b: Address): boolean => a.toLowerCase() === b.toLowerCase()

const runFunding = async (
  deps: FundingDeps,
  instruction: FundingInstruction,
  paymentRefHash: Hex,
  donorRefHash: Hex,
): Promise<FundingResult> => {
  const { chain, log } = deps
  const { endToEndId } = instruction
  const needId = BigInt(instruction.needId)

  // Re-read inside the queue: an identical request may have completed while this one waited.
  const existing = await findTransfer(endToEndId)
  if (existing) {
    assertSamePayment(existing, instruction, donorRefHash)
    if (existing.status === 'ATTESTED') return { transfer: existing, idempotent: true }
  }

  const need = await readNeed(chain, needId)
  if (!need) throw notFound(`Need ${instruction.needId} does not exist`)
  if (!hasLedger(need)) {
    throw conflict(
      `Need ${instruction.needId} is not open for funding: it has not been verified yet`,
      'NEED_NOT_FUNDING',
    )
  }

  const attestedUid = await fundingAttestationFor(chain, paymentRefHash)
  if (attestedUid) {
    return adoptAttestation(chain, instruction, need, attestedUid, existing, paymentRefHash, donorRefHash)
  }

  const provider = chain.account.address
  if (need.custodyMode === 'OffChain' && !sameAddress(need.custodian, provider)) {
    throw forbidden(
      `Need ${instruction.needId} is held off-chain by another payment provider; only its custodian can record funding`,
      'NOT_CUSTODIAN',
    )
  }
  if (!(await isBankPartner(chain, provider))) {
    throw forbidden('The configured wallet does not hold BANK_PARTNER_ROLE on-chain', 'NOT_PAYMENT_PROVIDER')
  }

  const [consumed, feeState] = await Promise.all([
    paymentRefConsumed(chain, paymentRefHash),
    readFeeState(chain, need),
  ])
  const costCapBps = need.thirdPartyCostBps
  let gross: bigint
  let fee: bigint
  let net: bigint

  if (!consumed) {
    if (!need.open) throw conflict(`Need ${instruction.needId} is not open for funding`, 'NEED_NOT_FUNDING')
    gross = centsToBaseUnits(instruction.grossEurCents)
    const requestedFee = centsToBaseUnits(instruction.feeEurCents)
    fee = minBigInt(requestedFee, maxFundingFee(feeState, costCapBps, gross))
    net = gross - fee
    if (net <= 0n) throw badRequest('The amount does not cover the payment fee', 'AMOUNT_TOO_SMALL')
    const remaining =
      need.targetAmount > feeState.totalDonated ? need.targetAmount - feeState.totalDonated : 0n
    if (net > remaining) {
      throw conflict(
        `Need ${instruction.needId} can only accept ${formatEur(remaining)} EUR more`,
        'EXCEEDS_REMAINING',
        { remaining: remaining.toString() },
      )
    }
    if (fee < requestedFee) {
      log.info(
        {
          event: 'funding.fee_capped',
          paymentRefHash,
          requested: requestedFee.toString(),
          fee: fee.toString(),
        },
        'fee capped by the need’s cost disclosure; the provider absorbs the difference',
      )
    }
  } else {
    // Only a custodial deposit can consume a reference without an attestation (off-chain funding does both in
    // one transaction). Resume only if it is *this* payment's deposit in *this* vault.
    const matches =
      need.custodyMode === 'OnChain' &&
      existing !== null &&
      (await depositMatches(
        chain,
        need.vault,
        paymentRefHash,
        donorRefHash,
        BigInt(existing.amountBaseUnits),
      ))
    if (!matches || !existing) {
      throw conflict(
        'This payment reference was already used by this provider for another payment',
        'PAYMENT_REF_CONSUMED',
      )
    }
    net = BigInt(existing.amountBaseUnits)
    // The net amount is fixed by the deposit; if the cap tightened meanwhile, only the fee can give.
    fee = minBigInt(BigInt(existing.feeBaseUnits), maxFundingFeeAfterDeposit(feeState, costCapBps))
    gross = net + fee
  }

  const amounts = {
    vault: need.vault,
    amountBaseUnits: net.toString(),
    feeBaseUnits: fee.toString(),
    custodyMode: need.custodyMode,
  }
  let transfer = existing
    ? await prisma().fiatTransfer.update({ where: { endToEndId }, data: { ...amounts, error: null } })
    : await prisma().fiatTransfer.create({
        data: {
          ...amounts,
          endToEndId,
          needId: instruction.needId,
          amountEurCents: instruction.grossEurCents,
          currency: instruction.currency,
          source: instruction.source,
          paymentRefHash,
          donorRefHash,
          status: 'RECEIVED',
        },
      })

  const setStatus = async (
    status: TransferStatus,
    data: Prisma.FiatTransferUpdateInput = {},
  ): Promise<void> => {
    transfer = await prisma().fiatTransfer.update({
      where: { endToEndId },
      data: { ...data, status, error: null },
    })
  }

  try {
    if (need.custodyMode === 'OnChain') {
      if (!consumed) {
        await ensureFunded(deps, need.vault, net)
        await setStatus('FUNDED')
        const donateTxHash = await confirm(
          chain,
          await chain.wallet.writeContract({
            account: chain.account,
            chain: null,
            address: need.vault,
            abi: VAULT_WRITE_ABI,
            functionName: 'donateOnBehalf',
            args: [net, donorRefHash, paymentRefHash],
          }),
        )
        log.info({ event: 'funding.donated', paymentRefHash, needId: instruction.needId }, 'fiat deposited')
        await setStatus('DONATED', { donateTxHash })
      } else if (transfer.status !== 'DONATED') {
        // The deposit landed but the run was interrupted before the row caught up.
        await setStatus('DONATED')
      }
    }

    const attestTxHash = await attestToLedger(chain, 'FundingRecorded', need.vault, [
      needId,
      gross,
      fee,
      net,
      regionCode(instruction.currency),
      paymentRefHash,
      donorRefHash,
    ])
    const attestationUID = await fundingAttestationFor(chain, paymentRefHash)
    if (!attestationUID) throw new Error('FundingRecorded was mined but the resolver has no record of it')

    await setStatus('ATTESTED', { attestTxHash, attestationUID })
    log.info(
      { event: 'funding.attested', paymentRefHash, attestationUID, custodyMode: need.custodyMode },
      'funding attested',
    )
    return { transfer, idempotent: false }
  } catch (error) {
    await prisma().fiatTransfer.update({
      where: { endToEndId },
      data: { status: 'FAILED', error: errorSummary(error).slice(0, 500) },
    })
    throw httpErrorFromRevert(error)
  }
}

/** The chain already holds this provider's attestation for the reference: bring the database in line with it. */
const adoptAttestation = async (
  chain: Chain,
  instruction: FundingInstruction,
  need: NeedTarget,
  uid: Hex,
  existing: FiatTransfer | null,
  paymentRefHash: Hex,
  donorRefHash: Hex,
): Promise<FundingResult> => {
  const [attestedNeedId, , fee, net] = await readFundingAttestation(chain, uid)
  if (attestedNeedId !== need.needId) {
    throw conflict(
      'This payment reference was already used by this provider for another need',
      'PAYMENT_REF_CONSUMED',
    )
  }
  const data = {
    vault: need.vault,
    amountBaseUnits: net.toString(),
    feeBaseUnits: fee.toString(),
    custodyMode: need.custodyMode,
    status: 'ATTESTED',
    attestationUID: uid,
    error: null,
  }
  const transfer = existing
    ? await prisma().fiatTransfer.update({ where: { endToEndId: instruction.endToEndId }, data })
    : await prisma().fiatTransfer.create({
        data: {
          ...data,
          endToEndId: instruction.endToEndId,
          needId: instruction.needId,
          amountEurCents: instruction.grossEurCents,
          currency: instruction.currency,
          source: instruction.source,
          paymentRefHash,
          donorRefHash,
        },
      })
  return { transfer, idempotent: true }
}

/**
 * Makes sure the hot wallet holds and has approved the amount. Minting is a demo affordance of `MockEURC`; with
 * a real stablecoin the provider already holds the converted funds and this step is a balance check that fails
 * loudly rather than inventing money.
 */
const ensureFunded = async (deps: FundingDeps, vault: Address, amount: bigint): Promise<void> => {
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
      throw conflict(
        'The provider wallet does not hold enough stablecoin and the token is not mintable',
        'NO_FUNDS',
      )
    }
    log.warn(
      { event: 'funding.minted', amount: amount.toString() },
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
