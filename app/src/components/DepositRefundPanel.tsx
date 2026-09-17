'use client'

import { NATIVE_TOKEN, type NeedStatus } from '@poa/shared'
import { useTranslations } from 'next-intl'
import { useId, useState } from 'react'
import { type Address, getAddress, isAddress } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { useAccount, usePublicClient } from 'wagmi'
import type { DepositBalance } from '@/components/DepositActivity'
import { ExplorerLink } from '@/components/ExplorerLink'
import { FormError } from '@/components/form'
import { relayDepositRefund } from '@/lib/appApi'
import { chainId } from '@/lib/config'
import { type RefundKind, readRefundNonce, refundTypedData } from '@/lib/conversion'
import { parseRefundKeyFile, type RefundKeyFile } from '@/lib/depositKey'
import { decimalsOfSymbol, shorten, tokenAmount } from '@/lib/format'
import { useMounted } from '@/lib/hooks'

/** Signatures are short-lived: the relay route rejects anything more than a day ahead. */
const SIGNATURE_LIFETIME_SECONDS = 30 * 60

const REFUNDABLE_STATUSES: NeedStatus[] = ['Cancelled', 'Expired']

/**
 * Refunds for a deposit address, signed in this browser with the refund key from the donor's file:
 *
 * - leftovers: anything the address still holds (money that arrived after the need stopped accepting, or that the
 *   donor wants back before it is swept), sent to the address the key signs for;
 * - the vault refund: the address's share of a cancelled or expired need, when the donation was credited to the
 *   address itself. When a wallet holds the receipt, that wallet claims on the need page instead.
 *
 * The key is read from the file into memory and never sent anywhere: only the EIP-712 signature goes to the relayer.
 */
export function DepositRefundPanel({
  address,
  balances,
  needStatus,
  receiptTo,
  refundSigner,
  swept,
}: {
  address: Address
  balances: DepositBalance[]
  needStatus: NeedStatus | null
  receiptTo: Address | null
  /** The refund signer the indexer recorded for this address, when it has; the loaded key must match it. */
  refundSigner: Address | null
  swept: boolean
}) {
  const t = useTranslations('deposit')
  const mounted = useMounted()
  const publicClient = usePublicClient()
  const { address: wallet } = useAccount()
  const fileId = useId()
  const toId = useId()

  const [file, setFile] = useState<RefundKeyFile | null>(null)
  const [to, setTo] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<{ txHash: string; amount: string; symbol: string } | null>(null)

  const held = balances.filter((balance) => (balance.value ?? 0n) > 0n)
  const vaultRefundable = swept && needStatus !== null && REFUNDABLE_STATUSES.includes(needStatus)
  // Before the indexer knows the address, the intent in the key file says who holds the receipt.
  const receiptWallet =
    receiptTo ??
    (file && !/^0x0{40}$/i.test(file.intent.receiptTo) ? (file.intent.receiptTo as Address) : null)

  const load = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const chosen = event.target.files?.[0]
    event.target.value = ''
    if (!chosen) return
    setError(null)
    setDone(null)
    if (chosen.size > 16_000) return setError(t('keyProblem_malformed'))
    const parsed = parseRefundKeyFile(await chosen.text(), { chainId, depositAddress: address, refundSigner })
    if (!parsed.ok) return setError(t(`keyProblem_${parsed.problem}`))
    setFile(parsed.file)
    const refundTo = parsed.file.intent.refundTo
    setTo(!/^0x0{40}$/i.test(refundTo) ? refundTo : (wallet ?? ''))
  }

  const refund = async (kind: RefundKind, balance?: DepositBalance) => {
    if (!file || !publicClient) return
    const recipient = to.trim()
    if (!isAddress(recipient, { strict: false }) || /^0x0{40}$/i.test(recipient)) {
      return setError(t('invalidRefundTo'))
    }
    setError(null)
    setDone(null)
    setBusy(kind === 'vault' ? 'vault' : (balance?.symbol ?? 'leftover'))
    try {
      const nonce = await readRefundNonce(publicClient, address)
      const deadline = BigInt(Math.floor(Date.now() / 1000) + SIGNATURE_LIFETIME_SECONDS)
      const token = balance?.token ?? NATIVE_TOKEN
      const typedData = refundTypedData({
        chainId,
        depositAddress: address,
        kind,
        token,
        to: getAddress(recipient),
        deadline,
        nonce,
      })
      const signature = await privateKeyToAccount(file.refundKey).signTypedData(typedData as never)
      const result = await relayDepositRefund(address, {
        kind,
        ...(kind === 'leftover' ? { token } : {}),
        to: getAddress(recipient),
        deadline: deadline.toString(),
        signature,
      })
      if (!result.ok) return setError(t('refundError', { detail: result.error }))
      setDone({ ...result.data, symbol: kind === 'vault' ? 'EURC' : (balance?.symbol ?? '') })
    } catch (cause) {
      setError(
        t('refundError', { detail: cause instanceof Error ? (cause.message.split('\n')[0] ?? '') : '' }),
      )
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="space-y-3 rounded-md border border-slate-200 p-3">
      <h3 className="text-sm font-semibold">{t('refundTitle')}</h3>
      <p className="text-xs text-slate-700">{t('refundBody')}</p>

      {!file ? (
        <div>
          <label className="btn-secondary cursor-pointer text-xs" htmlFor={fileId}>
            {t('loadKey')}
          </label>
          <input
            id={fileId}
            type="file"
            accept="application/json,.json"
            className="sr-only"
            disabled={!mounted}
            onChange={load}
          />
        </div>
      ) : (
        <>
          <p className="text-xs text-emerald-800">
            {t('keyLoaded', { signer: shorten(file.intent.refundSigner) })}
          </p>
          <div>
            <label className="label" htmlFor={toId}>
              {t('refundDestination')}
            </label>
            <input
              id={toId}
              className="input font-mono"
              autoComplete="off"
              spellCheck={false}
              placeholder="0x…"
              value={to}
              onChange={(event) => setTo(event.target.value)}
            />
            <p className="hint">{t('refundDestinationHint')}</p>
          </div>

          {held.length > 0 ? (
            <div className="flex flex-wrap gap-2">
              {held.map((balance) => (
                <button
                  key={balance.symbol}
                  type="button"
                  className="btn-secondary text-xs"
                  disabled={busy !== null}
                  onClick={() => refund('leftover', balance)}
                >
                  {busy === balance.symbol
                    ? t('refunding')
                    : t('refundLeftoverButton', {
                        amount: tokenAmount(balance.value ?? 0n, decimalsOfSymbol(balance.symbol)),
                        symbol: balance.symbol,
                      })}
                </button>
              ))}
            </div>
          ) : (
            <p className="text-xs text-slate-600">{t('nothingHeld')}</p>
          )}

          {vaultRefundable ? (
            receiptWallet ? (
              <p className="text-xs text-slate-700">
                {t('vaultRefundByWallet', { wallet: shorten(receiptWallet) })}
              </p>
            ) : (
              <button
                type="button"
                className="btn-primary text-xs"
                disabled={busy !== null}
                onClick={() => refund('vault')}
              >
                {busy === 'vault' ? t('refunding') : t('refundVaultButton')}
              </button>
            )
          ) : null}

          <button type="button" className="text-xs text-slate-600 underline" onClick={() => setFile(null)}>
            {t('forgetKey')}
          </button>
        </>
      )}

      {done ? (
        <p className="flex flex-wrap items-center gap-2 text-xs text-emerald-800" aria-live="polite">
          {t('refunded', {
            amount: tokenAmount(done.amount, decimalsOfSymbol(done.symbol)),
            symbol: done.symbol,
          })}
          <ExplorerLink kind="tx" value={done.txHash} />
        </p>
      ) : null}
      <FormError message={error} />
    </div>
  )
}
