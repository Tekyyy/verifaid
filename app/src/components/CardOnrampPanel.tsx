'use client'

import { aidVaultAbi, donationForwarderFactoryAbi, mockEURCAbi } from '@poa/shared'
import { useLocale, useTranslations } from 'next-intl'
import { useCallback, useEffect, useId, useState } from 'react'
import { type Address, isAddressEqual, parseEventLogs } from 'viem'
import { useAccount, useConnect, useReadContract } from 'wagmi'
import { FormError } from '@/components/form'
import { TxStatus } from '@/components/TxStatus'
import { Link } from '@/i18n/navigation'
import {
  type MockOnrampResult,
  mockOnramp,
  type OnrampStatus,
  onrampStatus,
  startOnrampSession,
} from '@/lib/appApi'
import { chain, chainId, conversionsEnabled, deployment, type OnrampMode, onrampMode } from '@/lib/config'
import { useConversionQuote, useDonationPreflight, useRevertMessage } from '@/lib/conversionHooks'
import { parseEuro } from '@/lib/fees'
import { amount, bpsPercent } from '@/lib/format'
import { batchCall, useMounted, useTx, useWrongChain } from '@/lib/hooks'
import { readStored, writeStored } from '@/lib/storage'

/** A purchase in progress, kept across reloads (a donor often comes back from the Coinbase tab to a fresh page). */
interface StoredPurchase {
  v: 1
  needId: string
  address: Address
  amountEur: string
  mode: OnrampMode
  /** USDC balance before buying, in base units: only what arrives on top of it is offered for donation. */
  baseline: string
  startedAt: number
  partnerUserRef: string | null
  mint: MockOnrampResult | null
}

const isStoredPurchase = (value: unknown): value is StoredPurchase => {
  const stored = value as Partial<StoredPurchase> | null
  return (
    stored?.v === 1 &&
    typeof stored.needId === 'string' &&
    typeof stored.address === 'string' &&
    typeof stored.amountEur === 'string' &&
    typeof stored.baseline === 'string' &&
    /^\d+$/.test(stored.baseline)
  )
}

const storageKey = (needId: string) => `poa.onramp.v1.${chainId}.${needId}`

const USDC_POLL_MS = 5_000
const STATUS_POLL_MS = 15_000
const MIN_EUR = { coinbase: 500n * 10_000n, mock: 100n * 10_000n } as const
const MAX_EUR = 5_000n * 1_000_000n

/**
 * "Pay by card": buy USDC with the Coinbase Onramp into the donor's own wallet, then donate it with one tap.
 *
 * Two transactions on purpose. Coinbase's terms require the buyer to own the destination wallet, so the on-ramp
 * never pays a vault or a deposit address directly; the donor's Coinbase Smart Wallet (a passkey, nothing to
 * install) receives the USDC and then approves and donates it through the forwarder factory in one batch,
 * gas-sponsored when a paymaster is configured.
 *
 * On test networks (`mock` mode) Coinbase cannot deliver, so a sandbox route mints test USDC instead. The conversion
 * cost counts against the need's disclosed cost cap, so a need that allows none does not offer this at all.
 */
export function CardOnrampPanel({
  needId,
  open,
  remaining,
  thirdPartyCostBps,
}: {
  needId: string
  open: boolean
  /** What the need still takes, in vault-token base units: USDC beyond it is returned unconverted. */
  remaining: string
  thirdPartyCostBps: number
}) {
  const t = useTranslations('onramp')
  const tConversion = useTranslations('conversion')
  const tCommon = useTranslations('common')
  const tErrors = useTranslations('errors')
  const locale = useLocale()
  const mounted = useMounted()
  const amountId = useId()
  const { address, isConnected, connector } = useAccount()
  const { connectors, connect, isPending: connecting } = useConnect()
  const wrongChain = useWrongChain()
  const tx = useTx()
  const preflight = useDonationPreflight()
  const explain = useRevertMessage()

  const [value, setValue] = useState('')
  const [purchase, setPurchase] = useState<StoredPurchase | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [checkoutUrl, setCheckoutUrl] = useState<string | null>(null)
  const [providerStatus, setProviderStatus] = useState<OnrampStatus | null>(null)
  const [receiptId, setReceiptId] = useState<string | null>(null)

  const usdc = deployment?.external.USDC
  const factory = deployment?.contracts.DonationForwarderFactory
  const smartWallet = connectors.find((item) => item.id === 'coinbaseWalletSDK')

  useEffect(() => {
    setPurchase(readStored(storageKey(needId), isStoredPurchase))
  }, [needId])

  const remember = useCallback(
    (next: StoredPurchase | null) => {
      setPurchase(next)
      writeStored(storageKey(needId), next)
    },
    [needId],
  )

  // A purchase belongs to the wallet it was delivered to; another connected wallet starts from scratch.
  const active = purchase && address && isAddressEqual(purchase.address, address) ? purchase : null

  const balance = useReadContract({
    address: usdc,
    abi: mockEURCAbi,
    functionName: 'balanceOf',
    args: address ? [address] : undefined,
    query: {
      enabled: Boolean(usdc && address),
      refetchInterval: active && !receiptId ? USDC_POLL_MS : false,
    },
  })
  const arrived =
    active && balance.data !== undefined && balance.data > BigInt(active.baseline)
      ? balance.data - BigInt(active.baseline)
      : 0n

  const { fairValue, returned } = useConversionQuote(usdc, arrived > 0n ? arrived : null, BigInt(remaining))

  // Coinbase's own view of the purchase, while the USDC has not shown up in the wallet yet.
  const partnerUserRef = active?.mode === 'coinbase' ? active.partnerUserRef : null
  useEffect(() => {
    if (!partnerUserRef || arrived > 0n || receiptId) return
    let cancelled = false
    const poll = async () => {
      const result = await onrampStatus(partnerUserRef)
      if (!cancelled && result.ok) setProviderStatus(result.data.status)
    }
    void poll()
    const timer = setInterval(poll, STATUS_POLL_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [partnerUserRef, arrived, receiptId])

  if (!conversionsEnabled || !usdc || !factory) return null

  const parsed = parseEuro(value)
  const withinLimits = parsed !== null && parsed.units >= MIN_EUR[onrampMode] && parsed.units <= MAX_EUR

  const buy = async () => {
    if (!address || !parsed || !withinLimits) {
      return setError(t('amountRange', { min: onrampMode === 'coinbase' ? '5.00' : '1.00', max: '5,000.00' }))
    }
    setError(null)
    // Opened now, still inside the click, so a popup blocker allows it; pointed at Coinbase once the session exists.
    const popup = onrampMode === 'coinbase' ? window.open('about:blank', '_blank') : null
    if (popup) popup.opener = null
    setBusy(true)
    const refreshed = await balance.refetch()
    // Without the starting balance, USDC the donor already held could later be offered as if it had just arrived.
    if (refreshed.data === undefined) {
      setBusy(false)
      popup?.close()
      return setError(t('balanceUnavailable'))
    }
    const baseline = refreshed.data.toString()
    const started = { v: 1, needId, address, amountEur: parsed.decimal, mode: onrampMode, baseline } as const

    if (onrampMode === 'mock') {
      const result = await mockOnramp({ address, amountEur: parsed.decimal })
      setBusy(false)
      if (!result.ok) return setError(t('error', { detail: result.error }))
      return remember({ ...started, startedAt: Date.now(), partnerUserRef: null, mint: result.data })
    }

    const result = await startOnrampSession({ address, amountEur: parsed.decimal, needId, locale })
    setBusy(false)
    if (!result.ok) {
      popup?.close()
      return setError(t('error', { detail: result.error }))
    }
    remember({ ...started, startedAt: Date.now(), partnerUserRef: result.data.partnerUserRef, mint: null })
    setCheckoutUrl(result.data.url)
    if (popup) popup.location.href = result.data.url
  }

  const donate = async () => {
    if (!active || arrived === 0n) return
    setReceiptId(null)
    setError(null)
    setBusy(true)
    const check = await preflight({ needId, token: usdc, amount: arrived })
    setBusy(false)
    if (!check.ok) return setError(explain(check.reason))
    const result = await tx.runBatch([
      batchCall({ address: usdc, abi: mockEURCAbi, functionName: 'approve', args: [factory, arrived] }),
      batchCall({
        address: factory,
        abi: donationForwarderFactoryAbi,
        functionName: 'donate',
        args: [BigInt(needId), usdc, arrived],
      }),
    ])
    if (!result) return
    const [donated] = parseEventLogs({ abi: aidVaultAbi, eventName: 'DonatedVia', logs: result.logs })
    setReceiptId(donated ? donated.args.receiptId.toString() : null)
    remember(null)
    setCheckoutUrl(null)
    setProviderStatus(null)
  }

  const startOver = () => {
    remember(null)
    setCheckoutUrl(null)
    setProviderStatus(null)
    setError(null)
    tx.reset()
  }

  const txBusy = tx.phase === 'signing' || tx.phase === 'pending'
  const stepClass = (done: boolean) =>
    `flex h-6 w-6 shrink-0 items-center justify-center rounded-full border-2 text-xs font-bold ${
      done ? 'border-emerald-600 bg-emerald-600 text-white' : 'border-slate-300 bg-white text-slate-600'
    }`

  return (
    <section className="card" aria-labelledby="card-onramp">
      <h2 id="card-onramp" className="section-title">
        {t('title')}
      </h2>
      <p className="mt-1 text-sm text-slate-700">{t('body')}</p>
      {onrampMode === 'mock' ? (
        <p className="mt-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs font-medium text-amber-900">
          {t('sandbox')}
        </p>
      ) : (
        <p className="mt-2 text-xs text-slate-600">{t('coinbaseNote')}</p>
      )}

      {thirdPartyCostBps === 0 ? (
        <p className="mt-3 text-sm text-slate-700">{tConversion('noCosts')}</p>
      ) : !open ? (
        <p className="mt-3 text-sm font-medium text-slate-700">{t('closed')}</p>
      ) : receiptId !== null || tx.phase === 'success' ? (
        <div className="mt-3 space-y-2">
          <p className="text-sm font-medium text-emerald-800">{t('thanks')}</p>
          <TxStatus state={tx} />
          {receiptId ? (
            <Link className="btn-secondary" href={`/track/${receiptId}`}>
              {t('track', { id: receiptId })}
            </Link>
          ) : null}
        </div>
      ) : (
        <ol className="mt-4 space-y-4">
          <li className="flex gap-3">
            <span className={stepClass(mounted && isConnected)} aria-hidden="true">
              1
            </span>
            <div className="min-w-0 flex-1 text-sm">
              <p className="font-semibold">{t('step1')}</p>
              {mounted && isConnected && address ? (
                <p className="text-xs text-slate-600">
                  {t('connectedAs', {
                    wallet: connector?.name ?? '',
                    address: `${address.slice(0, 6)}…${address.slice(-4)}`,
                  })}
                </p>
              ) : (
                <>
                  <p className="text-xs text-slate-600">{t('step1Body')}</p>
                  <button
                    type="button"
                    className="btn-primary mt-2"
                    disabled={!mounted || connecting || !smartWallet}
                    onClick={() => smartWallet && connect({ connector: smartWallet })}
                  >
                    {connecting ? tCommon('connecting') : t('connect')}
                  </button>
                </>
              )}
              {wrongChain ? (
                <p className="mt-1 text-xs text-red-800">{tErrors('wrongNetwork', { chain: chain.name })}</p>
              ) : null}
            </div>
          </li>

          <li className="flex gap-3">
            <span className={stepClass(Boolean(active) || withinLimits)} aria-hidden="true">
              2
            </span>
            <div className="min-w-0 flex-1 text-sm">
              <label className="font-semibold" htmlFor={amountId}>
                {t('step2')}
              </label>
              {active ? (
                <p className="text-xs text-slate-600 tabular-nums">
                  {t('amountChosen', { amount: active.amountEur })}
                </p>
              ) : (
                <input
                  id={amountId}
                  className="input mt-1"
                  inputMode="decimal"
                  autoComplete="off"
                  placeholder="25.00"
                  value={value}
                  disabled={!mounted || !isConnected}
                  onChange={(event) => setValue(event.target.value)}
                />
              )}
            </div>
          </li>

          <li className="flex gap-3">
            <span className={stepClass(Boolean(active))} aria-hidden="true">
              3
            </span>
            <div className="min-w-0 flex-1 text-sm">
              <p className="font-semibold">{t('step3')}</p>
              {!active ? (
                <>
                  <p className="text-xs text-slate-600">
                    {onrampMode === 'mock' ? t('step3BodyMock') : t('step3Body')}
                  </p>
                  <button
                    type="button"
                    className="btn-primary mt-2"
                    disabled={!mounted || !isConnected || wrongChain || busy || !parsed}
                    onClick={buy}
                  >
                    {busy ? t('starting') : onrampMode === 'mock' ? t('buyMock') : t('buy')}
                  </button>
                </>
              ) : (
                <div className="space-y-1 text-xs text-slate-700">
                  {active.mint ? (
                    <p className="tabular-nums">
                      {t('mockMinted', {
                        eur: active.mint.amountEur,
                        rate: active.mint.eurUsd,
                        fee: amount(active.mint.feeUsdc),
                        percent: bpsPercent(active.mint.feeBps),
                        usdc: amount(active.mint.usdc),
                      })}
                    </p>
                  ) : null}
                  {checkoutUrl ? (
                    <a className="link" href={checkoutUrl} target="_blank" rel="noreferrer noopener">
                      {t('openCheckout')}
                    </a>
                  ) : null}
                  {arrived === 0n ? (
                    <p aria-live="polite">
                      {providerStatus === 'failed'
                        ? t('statusFailed')
                        : providerStatus === 'success'
                          ? t('statusDelivered')
                          : t('waiting')}
                    </p>
                  ) : null}
                  <button type="button" className="text-xs text-slate-600 underline" onClick={startOver}>
                    {t('startOver')}
                  </button>
                </div>
              )}
            </div>
          </li>

          <li className="flex gap-3">
            <span className={stepClass(false)} aria-hidden="true">
              4
            </span>
            <div className="min-w-0 flex-1 text-sm">
              <p className="font-semibold">{t('step4')}</p>
              {arrived > 0n ? (
                <>
                  <p className="text-xs text-slate-700 tabular-nums" aria-live="polite">
                    {fairValue !== undefined
                      ? t('arrivedQuote', {
                          usdc: amount(arrived),
                          eurc: amount(fairValue),
                          unit: tCommon('amountUnit'),
                        })
                      : t('arrived', { usdc: amount(arrived) })}
                  </p>
                  {returned > 0n ? (
                    <p className="text-xs font-medium text-amber-900 tabular-nums">
                      {t('arrivedReturned', { returned: amount(returned) })}
                    </p>
                  ) : null}
                  <button
                    type="button"
                    className="btn-primary mt-2"
                    disabled={wrongChain || busy || txBusy}
                    onClick={donate}
                  >
                    {busy ? tConversion('checking') : t('donate', { usdc: amount(arrived) })}
                  </button>
                  <TxStatus state={tx} />
                </>
              ) : (
                <p className="text-xs text-slate-600">{t('step4Body')}</p>
              )}
            </div>
          </li>
        </ol>
      )}
      <FormError message={error} />
    </section>
  )
}
