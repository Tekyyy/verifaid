'use client'

import {
  aidVaultAbi,
  type DonationToken,
  donationForwarderFactoryAbi,
  donationTokens,
  mockEURCAbi,
  type OrgTaxStatusView,
} from '@poa/shared'
import { useTranslations } from 'next-intl'
import { useState } from 'react'
import { type Address, type Log, parseEventLogs } from 'viem'
import { useAccount, useBalance, useReadContract } from 'wagmi'
import { DeductibleLine } from '@/components/TaxDeductionNotice'
import { TxStatus } from '@/components/TxStatus'
import { Link } from '@/i18n/navigation'
import { conversionsEnabled, deployment } from '@/lib/config'
import { useConversionQuote, useDonationPreflight, useRevertMessage } from '@/lib/conversionHooks'
import { bpsPercent, amount as formatAmountValue, parseTokenAmount, tokenAmount } from '@/lib/format'
import { batchCall, useMounted, useTx, useWrongChain } from '@/lib/hooks'

/** The receipt id a donation minted, read from the vault's event rather than guessed. */
const receiptIdOf = (logs: Log[]): string | null => {
  const [direct] = parseEventLogs({ abi: aidVaultAbi, eventName: 'Donated', logs })
  if (direct) return direct.args.receiptId.toString()
  const [converted] = parseEventLogs({ abi: aidVaultAbi, eventName: 'DonatedVia', logs })
  return converted && converted.args.receiptId > 0n ? converted.args.receiptId.toString() : null
}

/**
 * Wallet donations. In the vault's own token (EURC) it is approve followed by `AidVault.donate`, two separate
 * transactions with their own status, because that is what the wallet will actually ask the donor to sign.
 *
 * In USDC or ETH (v3 deployments) it goes through `DonationForwarderFactory.donate`, which swaps into EURC bounded
 * by Chainlink fair value minus the router's slippage limit, donates what the need can still take and returns the rest
 * to the donor's wallet. USDC's approve and the donation go out as one batch when the wallet can bundle them.
 * Conversion costs count against the need's disclosed cost cap, so converted tokens are not offered to a need that
 * allows none, and every converted donation is simulated first so a cap overrun is explained, not just failed.
 */
export function DonatePanel({
  needId,
  vault,
  fundingOpen,
  targetAmount,
  totalDonated,
  thirdPartyCostBps,
  taxStatus = null,
}: {
  needId: string
  vault: Address | null
  /** Status is Funding and no deadline has passed, as computed by the page. */
  fundingOpen: boolean
  targetAmount: string
  totalDonated: string
  /** The need's disclosed cap on intermediary costs; conversion fees count against it. */
  thirdPartyCostBps: number
  taxStatus?: OrgTaxStatusView | null
}) {
  const t = useTranslations('need')
  const tCommon = useTranslations('common')
  const tErrors = useTranslations('errors')
  const tConversion = useTranslations('conversion')
  const mounted = useMounted()
  const { address: wallet, isConnected } = useAccount()
  const wrongChain = useWrongChain()
  const approve = useTx()
  const donate = useTx()
  const convert = useTx()
  const preflight = useDonationPreflight()
  const explain = useRevertMessage()
  const [checking, setChecking] = useState(false)
  const [value, setValue] = useState('')
  const [symbol, setSymbol] = useState<DonationToken['symbol']>('USDC')
  const [formError, setFormError] = useState<string | null>(null)
  const [receiptId, setReceiptId] = useState<string | null>(null)

  const unit = tCommon('amountUnit')
  const token = deployment?.external.Token
  const factory = deployment?.contracts.DonationForwarderFactory
  const router = deployment?.contracts.ConversionRouter
  // A need that allows no intermediary costs would reject any conversion that costs something: offer USDC only.
  const conversionsAllowed = conversionsEnabled && thirdPartyCostBps > 0
  const tokens = deployment
    ? donationTokens(deployment).filter((item) => conversionsAllowed || !item.converted)
    : []
  const selected = tokens.find((item) => item.symbol === symbol) ?? tokens[0]
  const converted = Boolean(selected?.converted && factory && router)

  const open = fundingOpen && vault !== null
  const remaining = BigInt(targetAmount) - BigInt(totalDonated)
  const parsed = selected ? parseTokenAmount(value, selected.decimals) : null

  const quoting = converted && parsed !== null && parsed > 0n
  const { used, returned, fairValue, minimum, slippageBps, unavailable } = useConversionQuote(
    converted ? selected?.address : undefined,
    quoting ? parsed : null,
    remaining,
  )

  const tokenBalance = useReadContract({
    address: selected && !selected.native ? selected.address : undefined,
    abi: mockEURCAbi,
    functionName: 'balanceOf',
    args: wallet ? [wallet] : undefined,
    query: { enabled: Boolean(wallet && selected && !selected.native) },
  })
  const ethBalance = useBalance({ address: wallet, query: { enabled: Boolean(wallet && selected?.native) } })
  const balance = selected?.native ? ethBalance.data?.value : tokenBalance.data

  /**
   * `AidVault.donate` pulls the tokens, so without an allowance it reverts before a wallet can even estimate
   * its gas — which a wallet reports as "this transaction is likely to fail". The button is held until the
   * allowance is really there rather than letting someone sign something that cannot succeed.
   */
  const allowance = useReadContract({
    address: token,
    abi: mockEURCAbi,
    functionName: 'allowance',
    args: wallet && vault ? [wallet, vault] : undefined,
    query: { enabled: Boolean(wallet && vault && token) },
  })
  const approved = parsed !== null && parsed > 0n && (allowance.data ?? 0n) >= parsed

  const choose = (next: DonationToken['symbol']) => {
    setSymbol(next)
    setValue('')
    setFormError(null)
    setReceiptId(null)
    approve.reset()
    donate.reset()
    convert.reset()
  }

  const runApprove = async () => {
    if (!parsed || !token || !vault) return setFormError(tErrors('invalidAmount'))
    setFormError(null)
    const result = await approve.run({
      address: token,
      abi: mockEURCAbi,
      functionName: 'approve',
      args: [vault, parsed],
    })
    if (result) await allowance.refetch()
  }

  const runDonate = async () => {
    if (!parsed || !vault) return setFormError(tErrors('invalidAmount'))
    setFormError(null)
    setReceiptId(null)
    const result = await donate.run({
      address: vault,
      abi: aidVaultAbi,
      functionName: 'donate',
      args: [parsed],
    })
    if (result) {
      setReceiptId(receiptIdOf(result.logs))
      await allowance.refetch()
    }
  }

  const runConverted = async () => {
    if (!parsed || parsed === 0n || !selected || !factory) {
      return setFormError(
        t('donateInvalidToken', { symbol: selected?.symbol ?? '', decimals: selected?.decimals ?? 6 }),
      )
    }
    setFormError(null)
    setReceiptId(null)
    setChecking(true)
    const check = await preflight({ needId, token: selected.address, amount: parsed })
    setChecking(false)
    if (!check.ok) return setFormError(explain(check.reason))
    const donation = batchCall({
      address: factory,
      abi: donationForwarderFactoryAbi,
      functionName: 'donate',
      args: [BigInt(needId), selected.address, parsed],
      ...(selected.native ? { value: parsed } : {}),
    })
    const result = await convert.runBatch(
      selected.native
        ? [donation]
        : [
            batchCall({
              address: selected.address,
              abi: mockEURCAbi,
              functionName: 'approve',
              args: [factory, parsed],
            }),
            donation,
          ],
    )
    if (result) setReceiptId(receiptIdOf(result.logs))
  }

  const busy = (state: { phase: string }) => state.phase === 'signing' || state.phase === 'pending'
  const succeeded = converted ? convert.phase === 'success' : donate.phase === 'success'

  return (
    <section className="card" aria-labelledby="donate">
      <h2 id="donate" className="section-title">
        {t('donateTitle')}
      </h2>
      <p className="mt-1 text-sm text-slate-700">
        {converted && selected
          ? t('donateConvertedBody', { symbol: selected.symbol, unit })
          : t('donateBody', { unit })}
      </p>
      {open ? <DeductibleLine taxStatus={taxStatus} channel="digital" /> : null}

      {!open ? (
        <p className="mt-3 text-sm font-medium text-slate-700">{t('donateClosed')}</p>
      ) : (
        <>
          <p className="mt-3 text-xs text-slate-600">
            {t('donateRemaining', {
              amount: formatAmountValue(remaining > 0n ? remaining : 0n),
              unit,
            })}
          </p>

          {conversionsEnabled && !conversionsAllowed ? (
            <p className="mt-3 text-xs text-slate-600">{tConversion('noCosts')}</p>
          ) : null}

          {tokens.length > 1 ? (
            <fieldset className="mt-3">
              <legend className="label">{t('donateToken')}</legend>
              <div className="mt-1 flex flex-wrap gap-2">
                {tokens.map((option) => (
                  <label
                    key={option.symbol}
                    className={`flex min-h-[44px] cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm ${
                      selected?.symbol === option.symbol
                        ? 'border-teal-700 bg-teal-50'
                        : 'border-slate-300 bg-white'
                    }`}
                  >
                    <input
                      type="radio"
                      name="donate-token"
                      value={option.symbol}
                      checked={selected?.symbol === option.symbol}
                      onChange={() => choose(option.symbol)}
                    />
                    {option.symbol}
                  </label>
                ))}
              </div>
            </fieldset>
          ) : null}

          <div className="mt-3">
            <label className="label" htmlFor="donate-amount">
              {t('donateAmount', { unit: selected?.symbol ?? unit })}
            </label>
            <input
              id="donate-amount"
              className="input"
              inputMode="decimal"
              autoComplete="off"
              value={value}
              onChange={(event) => setValue(event.target.value)}
              placeholder={selected?.native ? '0.05' : '100.00'}
            />
            {mounted && balance !== undefined && selected ? (
              <p className="hint">
                {t('donateBalance', {
                  amount: tokenAmount(balance, selected.decimals),
                  symbol: selected.symbol,
                })}
              </p>
            ) : null}
          </div>

          {quoting ? (
            <div
              className="mt-3 space-y-1 rounded-md bg-slate-50 p-3 text-xs text-slate-700"
              aria-live="polite"
            >
              <p>{tConversion('costCapNote', { percent: bpsPercent(thirdPartyCostBps) })}</p>
              {fairValue !== undefined ? (
                <>
                  <p className="font-semibold tabular-nums">
                    {t('donateQuote', { fair: formatAmountValue(fairValue), unit })}
                  </p>
                  {minimum !== undefined && slippageBps !== null ? (
                    <p className="tabular-nums">
                      {t('donateMinimum', {
                        minimum: formatAmountValue(minimum),
                        unit,
                        percent: bpsPercent(slippageBps),
                      })}
                    </p>
                  ) : null}
                  {returned > 0n && used !== undefined && selected ? (
                    <p className="font-medium text-amber-900 tabular-nums">
                      {t('donateReturned', {
                        used: tokenAmount(used, selected.decimals),
                        returned: tokenAmount(returned, selected.decimals),
                        symbol: selected.symbol,
                      })}
                    </p>
                  ) : null}
                </>
              ) : unavailable ? (
                <p className="font-medium text-amber-900">{t('donateQuoteUnavailable')}</p>
              ) : (
                <p>{tCommon('loading')}</p>
              )}
            </div>
          ) : null}

          {formError ? (
            <p className="mt-2 text-xs text-red-800" role="alert">
              {formError}
            </p>
          ) : null}

          {!isConnected ? (
            <p className="mt-3 text-sm text-slate-700">{tErrors('connectFirst')}</p>
          ) : converted && selected ? (
            <div className="mt-4">
              <button
                type="button"
                className="btn-accent w-full sm:w-auto"
                onClick={runConverted}
                disabled={wrongChain || checking || busy(convert)}
              >
                {checking ? tConversion('checking') : t('donateConvert', { symbol: selected.symbol })}
              </button>
              <TxStatus state={convert} />
            </div>
          ) : (
            <div className="mt-4 space-y-3">
              <div>
                <button
                  type="button"
                  className="btn-secondary w-full sm:w-auto"
                  onClick={runApprove}
                  disabled={wrongChain || busy(approve) || approved}
                >
                  {approved ? t('donateApproved') : t('donateApprove')}
                </button>
                <TxStatus state={approve} />
              </div>
              <div>
                <button
                  type="button"
                  className="btn-accent w-full sm:w-auto"
                  onClick={runDonate}
                  disabled={wrongChain || busy(donate) || !approved}
                >
                  {t('donateSend')}
                </button>
                {!approved && parsed !== null && parsed > 0n ? (
                  <p className="hint">{t('donateApproveFirst')}</p>
                ) : null}
                <TxStatus state={donate} />
              </div>
            </div>
          )}

          {isConnected && succeeded ? (
            <div className="mt-3 space-y-2">
              <p className="text-sm font-medium text-emerald-800">{t('donateSuccess')}</p>
              {receiptId ? (
                <Link className="btn-secondary" href={`/track/${receiptId}`}>
                  {t('trackThisDonation', { id: receiptId })}
                </Link>
              ) : null}
            </div>
          ) : null}
        </>
      )}
    </section>
  )
}
