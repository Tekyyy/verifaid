'use client'

import { trackingRefKind } from '@poa/shared'
import { useTranslations } from 'next-intl'
import { useId, useState } from 'react'
import { FormError } from '@/components/form'
import { useRouter } from '@/i18n/navigation'

/** Takes a receipt number or a payment reference and opens its tracking page. No account, no login. */
export function TrackForm() {
  const t = useTranslations('track')
  const router = useRouter()
  const id = useId()
  const [value, setValue] = useState('')
  const [error, setError] = useState<string | null>(null)

  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const ref = value.trim().replace(/^#/, '')
    if (!trackingRefKind(ref)) return setError(t('invalidRef'))
    setError(null)
    router.push(`/track/${ref}`)
  }

  return (
    <form className="card space-y-3" onSubmit={submit}>
      <div>
        <label className="label" htmlFor={id}>
          {t('formLabel')}
        </label>
        <input
          id={id}
          className="input font-mono"
          value={value}
          autoComplete="off"
          spellCheck={false}
          placeholder="12 · 0x…"
          onChange={(event) => setValue(event.target.value)}
        />
        <p className="hint">{t('formHint')}</p>
      </div>
      <FormError message={error} />
      <button type="submit" className="btn-primary">
        {t('formSubmit')}
      </button>
    </form>
  )
}
