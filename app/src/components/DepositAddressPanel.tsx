'use client'

import { donationForwarderFactoryAbi, type ForwarderIntent } from '@poa/shared'
import { useTranslations } from 'next-intl'
import { useEffect, useId, useState } from 'react'
import { type Address, bytesToHex, getAddress, type Hex, isAddress, isAddressEqual, zeroAddress } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { useAccount, usePublicClient } from 'wagmi'
import { FormError } from '@/components/form'
import { Link } from '@/i18n/navigation'
import { createDepositAddress, type IntentJson } from '@/lib/appApi'
import { chain, chainId, conversionsEnabled, deployment, network } from '@/lib/config'
import {
  downloadJson,
  intentToJson,
  REFUND_KEY_FORMAT,
  type RefundKeyFile,
  refundKeyFileName,
} from '@/lib/depositKey'
import { shorten } from '@/lib/format'
import { useMounted } from '@/lib/hooks'
import { readStored, writeStored } from '@/lib/storage'

/** The address a donor was given, without its key, so it can be shown again after a reload. */
interface StoredDeposit {
  v: 1
  address: Address
  intent: IntentJson
}

const isStoredDeposit = (value: unknown): value is StoredDeposit => {
  const stored = value as Partial<StoredDeposit> | null
  return stored?.v === 1 && typeof stored.address === 'string' && isAddress(stored.address)
}

const storageKey = (needId: string) => `poa.deposit.v1.${chainId}.${needId}`

/** Generated in the browser: the intent, its predicted address and the refund key, which lives only in memory here. */
interface Draft {
  intent: ForwarderIntent
  address: Address
  file: RefundKeyFile
}

const randomSalt = (): Hex => bytesToHex(crypto.getRandomValues(new Uint8Array(32)))

/**
 * "Send from an exchange": a deposit address for this need. An exchange withdrawal cannot call a contract, so the
 * donor gets an address instead — a DonationForwarder at a CREATE2 address derived from an intent (this need, who
 * gets the receipt, where refunds go, which key may sign refunds). Whatever arrives there can only be swept into
 * this need or refunded as the intent says.
 *
 * The refund key is generated here and must be saved (downloaded or copied) before the address is shown: it is the
 * donor's way to recover money sent after the need closes, or its share if the need is cancelled. The server only
 * ever sees the key's address.
 */
export function DepositAddressPanel({
  needId,
  open,
  thirdPartyCostBps,
}: {
  needId: string
  open: boolean
  thirdPartyCostBps: number
}) {
  const t = useTranslations('deposit')
  const tConversion = useTranslations('conversion')
  const tCommon = useTranslations('common')
  const mounted = useMounted()
  const publicClient = usePublicClient()
  const { address: wallet, isConnected } = useAccount()
  const receiptId = useId()
  const refundId = useId()

  const [creditWallet, setCreditWallet] = useState(true)
  const [refundTo, setRefundTo] = useState('')
  const [draft, setDraft] = useState<Draft | null>(null)
  const [saved, setSaved] = useState(false)
  const [ready, setReady] = useState<StoredDeposit | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState<'key' | 'address' | null>(null)
  const [qr, setQr] = useState<{ path: string; size: number } | null>(null)

  const factory = deployment?.contracts.DonationForwarderFactory

  useEffect(() => {
    setReady(readStored(storageKey(needId), isStoredDeposit))
  }, [needId])

  useEffect(() => {
    if (!ready) return setQr(null)
    let cancelled = false
    void import('@/lib/qr').then(({ encodeQr, qrToSvgPath }) => {
      if (!cancelled) setQr(qrToSvgPath(encodeQr(ready.address)))
    })
    return () => {
      cancelled = true
    }
  }, [ready])

  if (!conversionsEnabled || !factory || !deployment) return null

  const flash = (what: 'key' | 'address') => {
    setCopied(what)
    setTimeout(() => setCopied(null), 2000)
  }

  const prepare = async () => {
    const refund = refundTo.trim()
    if (refund && !isAddress(refund, { strict: false })) return setError(t('invalidRefundTo'))
    if (!publicClient) return setError(t('error', { detail: 'no RPC client' }))
    setError(null)
    setBusy(true)
    try {
      const key = generatePrivateKey()
      const intent: ForwarderIntent = {
        needId: BigInt(needId),
        receiptTo: isConnected && wallet && creditWallet ? wallet : zeroAddress,
        refundTo: refund ? getAddress(refund) : zeroAddress,
        refundSigner: privateKeyToAccount(key).address,
        salt: randomSalt(),
      }
      const address = await publicClient.readContract({
        address: factory,
        abi: donationForwarderFactoryAbi,
        functionName: 'forwarderAddress',
        args: [intent],
      })
      setDraft({
        intent,
        address,
        file: {
          format: REFUND_KEY_FORMAT,
          version: 1,
          chainId,
          network,
          depositAddress: address,
          factory,
          intent: intentToJson(intent),
          refundKey: key,
          trackingPath: `/track/${address}`,
          createdAt: new Date().toISOString(),
          notice: t('fileNotice'),
        },
      })
      setSaved(false)
    } catch (cause) {
      setError(
        t('error', { detail: cause instanceof Error ? (cause.message.split('\n')[0] ?? '') : String(cause) }),
      )
    } finally {
      setBusy(false)
    }
  }

  const download = () => {
    if (draft && downloadJson(refundKeyFileName(draft.address), draft.file)) setSaved(true)
  }

  const copyKey = async () => {
    if (!draft) return
    try {
      await navigator.clipboard.writeText(JSON.stringify(draft.file, null, 2))
      setSaved(true)
      flash('key')
    } catch {
      setError(t('copyFailed'))
    }
  }

  const reveal = async () => {
    if (!draft) return
    setError(null)
    setBusy(true)
    const result = await createDepositAddress(intentToJson(draft.intent))
    setBusy(false)
    if (!result.ok) return setError(t('error', { detail: result.error }))
    // The server deploys what the browser predicted; anything else means the two disagree about the intent.
    if (!isAddress(result.data.address) || !isAddressEqual(result.data.address, draft.address)) {
      return setError(t('mismatch'))
    }
    const stored: StoredDeposit = { v: 1, address: draft.address, intent: intentToJson(draft.intent) }
    writeStored(storageKey(needId), stored)
    setReady(stored)
    // The key is in the donor's file now; this page has no further use for it.
    setDraft(null)
  }

  const copyAddress = async () => {
    if (!ready) return
    try {
      await navigator.clipboard.writeText(ready.address)
      flash('address')
    } catch {
      setCopied(null)
    }
  }

  const startOver = () => {
    writeStored(storageKey(needId), null)
    setReady(null)
    setDraft(null)
    setSaved(false)
    setError(null)
  }

  const tokens = deployment.params.ethDonations ? 'USDC, ETH' : 'USDC'

  return (
    <section className="card" aria-labelledby="deposit-address">
      <h2 id="deposit-address" className="section-title">
        {t('title')}
      </h2>
      <p className="mt-1 text-sm text-slate-700">{t('body')}</p>

      {thirdPartyCostBps === 0 ? (
        <p className="mt-3 text-sm text-slate-700">{tConversion('noCosts')}</p>
      ) : ready ? (
        <div className="mt-3 space-y-3">
          <p className="text-sm font-semibold">{t('readyTitle')}</p>
          <p className="break-all rounded-md bg-slate-50 p-2 font-mono text-sm" data-testid="deposit-address">
            {ready.address}
          </p>
          <div className="flex flex-wrap gap-2">
            <button type="button" className="btn-secondary text-xs" onClick={copyAddress}>
              {copied === 'address' ? tCommon('copied') : t('copyAddress')}
            </button>
            <Link className="btn-secondary text-xs" href={`/track/${ready.address}`}>
              {t('trackLink')}
            </Link>
          </div>
          {qr ? (
            <svg
              className="h-auto w-full max-w-[220px] bg-white"
              viewBox={`0 0 ${qr.size} ${qr.size}`}
              role="img"
              aria-label={t('qrAlt')}
              shapeRendering="crispEdges"
            >
              <rect width={qr.size} height={qr.size} fill="#ffffff" />
              <path d={qr.path} fill="#000000" />
            </svg>
          ) : null}
          <dl className="grid grid-cols-2 gap-2 text-xs">
            <dt className="text-slate-600">{t('network')}</dt>
            <dd className="font-semibold">{chain.name}</dd>
            <dt className="text-slate-600">{t('tokens')}</dt>
            <dd className="font-semibold">{tokens}</dd>
            <dt className="text-slate-600">{t('receipt')}</dt>
            <dd className="font-mono">
              {/^0x0{40}$/i.test(ready.intent.receiptTo)
                ? t('receiptToAddress')
                : shorten(ready.intent.receiptTo)}
            </dd>
          </dl>
          <p className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-xs font-medium text-red-900">
            {t('warning', { network: chain.name, tokens })}
          </p>
          <p className="hint">{t('readyHint')}</p>
          <button type="button" className="text-xs text-slate-600 underline" onClick={startOver}>
            {t('another')}
          </button>
        </div>
      ) : !open ? (
        <p className="mt-3 text-sm font-medium text-slate-700">{t('closed')}</p>
      ) : draft ? (
        <div className="mt-3 space-y-3">
          <p className="text-sm font-semibold">{t('saveTitle')}</p>
          <p className="text-xs text-slate-700">{t('saveBody')}</p>
          <div className="flex flex-wrap gap-2">
            <button type="button" className="btn-primary text-xs" onClick={download}>
              {t('download')}
            </button>
            <button type="button" className="btn-secondary text-xs" onClick={copyKey}>
              {copied === 'key' ? tCommon('copied') : t('copyKey')}
            </button>
          </div>
          <button
            type="button"
            className="btn-primary w-full sm:w-auto"
            disabled={!saved || busy}
            onClick={reveal}
          >
            {busy ? t('creating') : t('reveal')}
          </button>
          {!saved ? <p className="hint">{t('saveFirst')}</p> : null}
        </div>
      ) : (
        <div className="mt-3 space-y-3">
          {mounted && isConnected && wallet ? (
            <label className="flex items-start gap-2 text-sm" htmlFor={receiptId}>
              <input
                id={receiptId}
                type="checkbox"
                className="mt-1"
                checked={creditWallet}
                onChange={(event) => setCreditWallet(event.target.checked)}
              />
              <span>{t('creditWallet', { address: shorten(wallet) })}</span>
            </label>
          ) : (
            <p className="text-xs text-slate-600">{t('noWallet')}</p>
          )}
          <div>
            <label className="label" htmlFor={refundId}>
              {t('refundTo')}
            </label>
            <input
              id={refundId}
              className="input font-mono"
              autoComplete="off"
              spellCheck={false}
              placeholder="0x…"
              value={refundTo}
              onChange={(event) => setRefundTo(event.target.value)}
            />
            <p className="hint">{t('refundToHint')}</p>
          </div>
          <button
            type="button"
            className="btn-primary w-full sm:w-auto"
            disabled={!mounted || busy}
            onClick={prepare}
          >
            {busy ? t('creating') : t('create')}
          </button>
        </div>
      )}
      <div className="mt-2">
        <FormError message={error} />
      </div>
    </section>
  )
}
