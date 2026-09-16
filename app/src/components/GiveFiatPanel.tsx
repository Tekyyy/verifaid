'use client'

import type { CustodyMode } from '@poa/shared'
import { useTranslations } from 'next-intl'
import { useId, useRef, useState } from 'react'
import { FormError } from '@/components/form'
import { useRouter } from '@/i18n/navigation'
import { startCheckout } from '@/lib/appApi'
import { estimateFee, feeWithinCap, PAYMENT_METHODS, type PaymentMethod, parseEuro } from '@/lib/fees'
import { amount, bpsPercent } from '@/lib/format'

/** `crypto.randomUUID` needs a secure context; a LAN demo over plain http still gets a random key. */
const randomKey = (): string => {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

/**
 * "Give by card or bank transfer": a sandbox checkout. The bank connector plays the payment provider — for an
 * on-chain need it converts and deposits into the vault, for an off-chain need it attests the payment it holds —
 * and returns the payment reference the donor then tracks. No card data is ever asked for or handled here.
 */
export function GiveFiatPanel({
  needId,
  custodyMode,
  open,
  thirdPartyCostBps,
}: {
  needId: string
  custodyMode: CustodyMode
  open: boolean
  thirdPartyCostBps: number
}) {
  const t = useTranslations('give')
  const tErrors = useTranslations('errors')
  const router = useRouter()
  const amountId = useId()
  const [value, setValue] = useState('')
  const [method, setMethod] = useState<PaymentMethod>('card')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // One key per attempt the donor intends: a double click or a retry after a timeout cannot charge twice.
  const idempotencyKey = useRef<string | null>(null)

  const parsed = parseEuro(value)
  const fee = parsed ? estimateFee(method, parsed.units) : 0n
  const overCap = parsed !== null && fee > 0n && !feeWithinCap(fee, parsed.units, thirdPartyCostBps)

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!parsed) return setError(tErrors('invalidEuro'))
    setError(null)
    setBusy(true)
    idempotencyKey.current ??= randomKey()
    const result = await startCheckout({ needId, amount: parsed.decimal, method }, idempotencyKey.current)
    if (!result.ok) {
      setBusy(false)
      return setError(t('error', { detail: result.error }))
    }
    idempotencyKey.current = null
    router.push(`/track/${result.data.trackingRef}`)
  }

  return (
    <section className="card" aria-labelledby="give-fiat">
      <h2 id="give-fiat" className="section-title">
        {t('title')}
      </h2>
      <p className="mt-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs font-medium text-amber-900">
        {t('sandbox')}
      </p>
      {custodyMode === 'OffChain' ? <p className="mt-2 text-sm text-slate-700">{t('onlyWay')}</p> : null}

      {!open ? (
        <p className="mt-3 text-sm font-medium text-slate-700">{t('closed')}</p>
      ) : (
        <form className="mt-3 space-y-3" onSubmit={submit}>
          <div>
            <label className="label" htmlFor={amountId}>
              {t('amount')}
            </label>
            <input
              id={amountId}
              className="input"
              inputMode="decimal"
              autoComplete="off"
              value={value}
              placeholder="25.00"
              onChange={(event) => {
                setValue(event.target.value)
                idempotencyKey.current = null
              }}
            />
          </div>

          <fieldset>
            <legend className="label">{t('method')}</legend>
            <div className="mt-1 flex flex-wrap gap-2">
              {PAYMENT_METHODS.map((option) => (
                <label
                  key={option}
                  className={`flex min-h-[44px] cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm ${
                    method === option ? 'border-indigo-700 bg-indigo-50' : 'border-slate-300 bg-white'
                  }`}
                >
                  <input
                    type="radio"
                    name="give-method"
                    value={option}
                    checked={method === option}
                    onChange={() => {
                      setMethod(option)
                      idempotencyKey.current = null
                    }}
                  />
                  {t(option)}
                </label>
              ))}
            </div>
            <p className="hint">{t(method === 'card' ? 'cardRule' : 'bankRule')}</p>
          </fieldset>

          {parsed ? (
            <dl className="grid grid-cols-2 gap-2 rounded-md bg-slate-50 p-3 text-xs">
              <dt className="text-slate-600">{t('feeEstimate')}</dt>
              <dd className="text-right font-semibold tabular-nums">{amount(fee)} EUR</dd>
              <dt className="text-slate-600">{t('reachesNeed')}</dt>
              <dd className="text-right font-semibold tabular-nums">{amount(parsed.units - fee)} EUR</dd>
            </dl>
          ) : null}

          <p className="hint">
            {thirdPartyCostBps === 0
              ? t('capZero')
              : t('capNote', { percent: bpsPercent(thirdPartyCostBps) })}
          </p>
          {overCap ? <p className="text-xs font-medium text-amber-900">{t('overCap')}</p> : null}

          <FormError message={error} />
          <button type="submit" className="btn-primary w-full sm:w-auto" disabled={busy}>
            {busy ? t('submitting') : t('submit')}
          </button>
        </form>
      )}
    </section>
  )
}
