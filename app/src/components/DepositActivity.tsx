'use client'

import {
  donationForwarderAbi,
  donationTokens,
  type DonationTokenSymbol,
  erc20TokenAbi,
  NATIVE_TOKEN,
  type NeedStatus,
  vaultCurrency,
} from '@poa/shared'
import { useTranslations } from 'next-intl'
import { useState } from 'react'
import { type Address, isAddressEqual } from 'viem'
import { useAccount, useBalance, useReadContract } from 'wagmi'
import { DepositRefundPanel } from '@/components/DepositRefundPanel'
import { ExplorerLink } from '@/components/ExplorerLink'
import { TxStatus } from '@/components/TxStatus'
import { useRouter } from '@/i18n/navigation'
import { type SweepResult, sweepDeposit } from '@/lib/appApi'
import { deployment } from '@/lib/config'
import { amount, decimalsOfSymbol, tokenAmount } from '@/lib/format'
import { batchCall, useMounted, useTx, useWrongChain } from '@/lib/hooks'

const POLL_MS = 10_000
/** The indexer needs a moment to pick up a sweep before the refreshed page can show it. */
const REFRESH_DELAY_MS = 4_000

export interface DepositBalance {
  symbol: DonationTokenSymbol
  token: Address
  value: bigint | undefined
}

/** The vault's own currency, and the stablecoin that converts into it: the two ERC-20s a deposit may hold. */
const vault = deployment ? vaultCurrency(deployment) : undefined
const convertible = deployment
  ? donationTokens(deployment).find((token) => token.converted && !token.native)
  : undefined

/** Live balances of what a deposit address may hold, refreshed while the page is open. */
const useDepositBalances = (address: Address): DepositBalance[] => {
  const query = { refetchInterval: POLL_MS }
  const convertibleBalance = useReadContract({
    address: convertible?.address,
    abi: erc20TokenAbi,
    functionName: 'balanceOf',
    args: [address],
    query: { ...query, enabled: Boolean(convertible) },
  })
  const vaultBalance = useReadContract({
    address: vault?.address,
    abi: erc20TokenAbi,
    functionName: 'balanceOf',
    args: [address],
    query: { ...query, enabled: Boolean(vault) },
  })
  const ethBalance = useBalance({ address, query })
  return [
    ...(convertible
      ? [{ symbol: convertible.symbol, token: convertible.address, value: convertibleBalance.data }]
      : []),
    { symbol: 'ETH', token: NATIVE_TOKEN, value: ethBalance.data?.value },
    ...(vault ? [{ symbol: vault.symbol, token: vault.address, value: vaultBalance.data }] : []),
  ]
}

/**
 * The live side of a deposit address on its tracking page: what it holds right now, a "Sweep now" button for money
 * that arrived and has not been converted yet, and the refund section driven by the donor's refund-key file.
 *
 * "Sweep now" goes through the relayer, a keeper on the factory. The intent's own receipt and refund addresses may
 * sweep too, so a donor connected with one of those wallets also gets a button that sends the sweep themselves.
 */
export function DepositActivity({
  address,
  needStatus,
  receiptTo,
  refundTo,
  refundSigner,
  swept,
}: {
  address: Address
  needStatus: NeedStatus | null
  /** The wallet credited with this address's donations; null when the address itself holds the claim. */
  receiptTo: Address | null
  refundTo: Address | null
  refundSigner: Address | null
  /** Something was already donated from this address (a vault refund can exist). */
  swept: boolean
}) {
  const t = useTranslations('deposit')
  const unit = useTranslations('common')('amountUnit')
  const router = useRouter()
  const mounted = useMounted()
  const balances = useDepositBalances(address)
  const [busy, setBusy] = useState(false)
  const [results, setResults] = useState<SweepResult[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const { address: wallet } = useAccount()
  const wrongChain = useWrongChain()
  const walletSweep = useTx()

  const held = balances.filter((balance) => (balance.value ?? 0n) > 0n)
  const holding = held.length > 0
  const ownWallet =
    mounted &&
    wallet !== undefined &&
    [receiptTo, refundTo].some((allowed) => allowed !== null && isAddressEqual(allowed, wallet))

  const refreshSoon = () => {
    router.refresh()
    setTimeout(() => router.refresh(), REFRESH_DELAY_MS)
  }

  const sweepFromWallet = async () => {
    const result = await walletSweep.runBatch(
      held.map((balance) =>
        batchCall({ address, abi: donationForwarderAbi, functionName: 'sweep', args: [balance.token] }),
      ),
    )
    if (result) refreshSoon()
  }

  const sweep = async () => {
    setBusy(true)
    setError(null)
    setResults(null)
    const result = await sweepDeposit(address)
    setBusy(false)
    if (!result.ok) return setError(t('sweepError', { detail: result.error }))
    setResults(result.data.results)
    if (result.data.results.some((item) => item.outcome === 'swept')) refreshSoon()
  }

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-sm font-semibold">{t('balancesTitle')}</h3>
        <dl className="mt-1 grid grid-cols-3 gap-2 text-xs">
          {balances.map((balance) => (
            <div key={balance.symbol}>
              <dt className="text-slate-600">{balance.symbol}</dt>
              <dd className="font-semibold tabular-nums">
                {mounted && balance.value !== undefined
                  ? tokenAmount(balance.value, decimalsOfSymbol(balance.symbol))
                  : '…'}
              </dd>
            </div>
          ))}
        </dl>
        <p className="hint">{holding ? t('holdingHint', { unit }) : t('emptyHint')}</p>
      </div>

      <div>
        <button type="button" className="btn-primary" disabled={!mounted || busy || !holding} onClick={sweep}>
          {busy ? t('sweeping') : t('sweepNow')}
        </button>
        {ownWallet && holding ? (
          <div className="mt-2">
            <button
              type="button"
              className="btn-secondary text-xs"
              disabled={wrongChain || walletSweep.phase === 'signing' || walletSweep.phase === 'pending'}
              onClick={sweepFromWallet}
            >
              {t('sweepFromWallet')}
            </button>
            <p className="hint">{t('sweepFromWalletHint')}</p>
            <TxStatus state={walletSweep} />
          </div>
        ) : null}
        {error ? (
          <p className="mt-2 text-xs text-red-800" role="alert">
            {error}
          </p>
        ) : null}
        {results ? (
          <ul className="mt-2 space-y-1 text-xs" aria-live="polite">
            {results.length === 0 ? <li className="text-slate-600">{t('outcome_nothingToSweep')}</li> : null}
            {results.map((item) => (
              <li key={item.token} className="flex flex-wrap items-center gap-x-2">
                <span className="font-semibold tabular-nums">
                  {tokenAmount(item.balance, decimalsOfSymbol(item.symbol))} {item.symbol}
                </span>
                <span className={item.outcome === 'swept' ? 'text-emerald-800' : 'text-amber-900'}>
                  {item.outcome === 'swept'
                    ? t('outcome_swept', { deposited: amount(item.deposited ?? '0'), unit })
                    : item.outcome === 'failed'
                      ? t('outcome_failed', { detail: item.error ?? '' })
                      : t(`outcome_${item.outcome}`)}
                </span>
                {item.txHash ? <ExplorerLink kind="tx" value={item.txHash} /> : null}
              </li>
            ))}
          </ul>
        ) : null}
      </div>

      <DepositRefundPanel
        address={address}
        balances={balances}
        needStatus={needStatus}
        receiptTo={receiptTo}
        refundSigner={refundSigner}
        swept={swept}
      />
    </div>
  )
}
