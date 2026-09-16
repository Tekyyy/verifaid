'use client'

import { useTranslations } from 'next-intl'
import { useId, useState } from 'react'
import { FormError } from '@/components/form'
import { Link } from '@/i18n/navigation'
import { type AlertChannel, type AlertSubscription, subscribeAlerts, unsubscribeAlerts } from '@/lib/appApi'

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

const isWebhookUrl = (value: string): boolean => {
  try {
    const url = new URL(value)
    return (url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password
  } catch {
    return false
  }
}

/**
 * "Get alerts" for one donation (or one need): an email address or a webhook URL, and no account. The
 * notifier answers with an unsubscribe token that is shown exactly once — this app does not keep it.
 */
export function AlertsForm({ trackingRef, needId }: { trackingRef?: string; needId?: string }) {
  const t = useTranslations('alerts')
  const tErrors = useTranslations('errors')
  const inputId = useId()
  const [channel, setChannel] = useState<AlertChannel>('email')
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [created, setCreated] = useState<AlertSubscription | null>(null)
  const [removed, setRemoved] = useState(false)

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const target = value.trim()
    const valid = channel === 'email' ? EMAIL.test(target) && target.length <= 254 : isWebhookUrl(target)
    if (!valid) return setError(t(channel === 'email' ? 'invalidEmail' : 'invalidWebhook'))
    setError(null)
    setBusy(true)
    const result = await subscribeAlerts({
      trackingRef,
      needId,
      channel,
      ...(channel === 'email' ? { email: target } : { webhookUrl: target }),
    })
    setBusy(false)
    if (!result.ok) return setError(tErrors('serviceUnavailable', { detail: result.error }))
    setCreated(result.data)
    setValue('')
  }

  const unsubscribe = async () => {
    if (!created) return
    setBusy(true)
    const result = await unsubscribeAlerts(created.id, created.unsubscribeToken)
    setBusy(false)
    if (!result.ok) return setError(tErrors('serviceUnavailable', { detail: result.error }))
    setRemoved(true)
  }

  if (created) {
    const unsubscribeHref = `/alerts/unsubscribe#id=${encodeURIComponent(created.id)}&token=${encodeURIComponent(
      created.unsubscribeToken,
    )}`
    return (
      <div className="space-y-2 rounded-md border border-emerald-300 bg-emerald-50 p-3 text-sm text-emerald-950">
        {removed ? (
          <p className="font-semibold">{t('removed')}</p>
        ) : (
          <>
            <p className="font-semibold">
              {t(created.channel === 'email' ? 'createdEmail' : 'createdWebhook')}
            </p>
            <p className="text-xs font-semibold text-amber-900">{t('keepToken')}</p>
            <dl className="space-y-1 text-xs">
              <div>
                <dt className="text-slate-700">{t('subscriptionId')}</dt>
                <dd className="mono select-all">{created.id}</dd>
              </div>
              <div>
                <dt className="text-slate-700">{t('token')}</dt>
                <dd className="mono select-all">{created.unsubscribeToken}</dd>
              </div>
              {created.webhookSecret ? (
                <div>
                  <dt className="text-slate-700">{t('webhookSecret')}</dt>
                  <dd className="mono select-all">{created.webhookSecret}</dd>
                  <dd className="mt-1 text-slate-700">
                    {t('webhookSecretHint', {
                      signature: 'x-poa-signature: sha256=hex(HMAC-SHA256(secret, rawBody))',
                      headers: 'x-poa-event, x-poa-delivery, x-poa-timestamp',
                    })}
                  </dd>
                </div>
              ) : null}
            </dl>
            <div className="flex flex-wrap items-center gap-3">
              <Link className="link text-xs" href={unsubscribeHref}>
                {t('unsubscribeLink')}
              </Link>
              <button type="button" className="btn-secondary text-xs" disabled={busy} onClick={unsubscribe}>
                {t('unsubscribeNow')}
              </button>
            </div>
          </>
        )}
        <FormError message={error} />
      </div>
    )
  }

  return (
    <form className="space-y-3" onSubmit={submit}>
      <fieldset>
        <legend className="label">{t('channel')}</legend>
        <div className="mt-1 flex flex-wrap gap-4 text-sm">
          {(['email', 'webhook'] as const).map((option) => (
            <label key={option} className="flex min-h-[44px] items-center gap-2">
              <input
                type="radio"
                name={`${inputId}-channel`}
                value={option}
                checked={channel === option}
                onChange={() => setChannel(option)}
              />
              {t(option)}
            </label>
          ))}
        </div>
      </fieldset>
      <div>
        <label className="label" htmlFor={inputId}>
          {t(channel === 'email' ? 'emailLabel' : 'webhookLabel')}
        </label>
        <input
          id={inputId}
          className="input"
          type={channel === 'email' ? 'email' : 'url'}
          inputMode={channel === 'email' ? 'email' : 'url'}
          autoComplete={channel === 'email' ? 'email' : 'off'}
          value={value}
          placeholder={channel === 'email' ? 'name@example.org' : 'https://example.org/hooks/aid'}
          onChange={(event) => setValue(event.target.value)}
        />
        <p className="hint">{t(channel === 'email' ? 'emailHint' : 'webhookHint')}</p>
      </div>
      <FormError message={error} />
      <button type="submit" className="btn-primary text-sm" disabled={busy}>
        {t('subscribe')}
      </button>
    </form>
  )
}
