'use client'

import { useTranslations } from 'next-intl'
import { useEffect, useState } from 'react'
import { FormError, TextField } from '@/components/form'
import { unsubscribeAlerts } from '@/lib/appApi'

/**
 * Stops an alert subscription. The id and token arrive in the URL fragment, which browsers never send to a
 * server, and are wiped from the address bar as soon as they have been read into the form.
 */
export function UnsubscribeForm() {
  const t = useTranslations('alerts')
  const tErrors = useTranslations('errors')
  const [id, setId] = useState('')
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)

  useEffect(() => {
    const params = new URLSearchParams(window.location.hash.replace(/^#/, ''))
    const fromHash = { id: params.get('id'), token: params.get('token') }
    if (fromHash.id) setId(fromHash.id)
    if (fromHash.token) setToken(fromHash.token)
    if (fromHash.id || fromHash.token) {
      window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`)
    }
  }, [])

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!id.trim() || !token.trim()) return setError(tErrors('required'))
    setError(null)
    setBusy(true)
    const result = await unsubscribeAlerts(id.trim(), token.trim())
    setBusy(false)
    if (!result.ok) return setError(tErrors('serviceUnavailable', { detail: result.error }))
    setDone(true)
  }

  if (done) {
    return (
      <p className="card border-emerald-300 bg-emerald-50 text-sm font-semibold text-emerald-900">
        {t('removed')}
      </p>
    )
  }

  return (
    <form className="card space-y-3" onSubmit={submit}>
      <TextField label={t('subscriptionId')} value={id} onChange={setId} />
      <TextField label={t('token')} value={token} onChange={setToken} />
      <FormError message={error} />
      <button type="submit" className="btn-danger" disabled={busy}>
        {t('unsubscribeNow')}
      </button>
    </form>
  )
}
