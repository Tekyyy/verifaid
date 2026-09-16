'use client'

import { useQuery } from '@tanstack/react-query'
import { useTranslations } from 'next-intl'
import { useId } from 'react'
import { TextField } from '@/components/form'
import { getProviders } from '@/lib/indexer'

/**
 * The payment provider that will hold an off-chain need's money. Only registered providers (BANK_PARTNER_ROLE)
 * are accepted by the registry, so the list comes from `GET /providers`; if the indexer cannot answer, the
 * address can still be pasted and the contract remains the final check.
 */
export function CustodianPicker({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const t = useTranslations('ngo')
  const id = useId()
  const query = useQuery({ queryKey: ['providers'], queryFn: getProviders })
  const active = query.data?.ok ? query.data.data.filter((provider) => provider.active) : []

  if (query.isLoading) return <p className="hint">{t('custodianLoading')}</p>

  if (active.length === 0) {
    return (
      <TextField
        label={t('custodian')}
        value={value}
        onChange={onChange}
        placeholder="0x…"
        hint={query.data?.ok ? t('custodianNone') : t('custodianUnavailable')}
      />
    )
  }

  return (
    <div>
      <label className="label" htmlFor={id}>
        {t('custodian')}
      </label>
      <select
        id={id}
        className="input font-mono"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value="">{t('custodianPick')}</option>
        {active.map((provider) => (
          <option key={provider.address} value={provider.address}>
            {provider.address}
          </option>
        ))}
      </select>
      <p className="hint">{t('custodianHint')}</p>
    </div>
  )
}
