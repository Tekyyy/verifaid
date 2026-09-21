'use client'

import { useQuery } from '@tanstack/react-query'
import { useTranslations } from 'next-intl'
import { useEffect } from 'react'
import { useAccount } from 'wagmi'
import { TextField } from '@/components/form'
import { getPrograms } from '@/lib/indexer'

/**
 * Which programme an action belongs to. An NGO almost always has one, so the common case is not a choice at
 * all: the picker selects it and says which one it used. The id is still typeable when the indexer cannot
 * answer, because the contract — not this list — is what decides whether the programme is yours.
 */
export function ProgramPicker({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const t = useTranslations('ngo')
  const { address } = useAccount()
  const query = useQuery({
    queryKey: ['programs', address],
    queryFn: () => getPrograms(address as string),
    enabled: Boolean(address),
  })
  const programs = query.data?.ok ? query.data.data.filter((program) => program.active) : []
  const only = programs.length === 1 ? programs[0] : undefined

  useEffect(() => {
    if (only && !value) onChange(only.id)
  }, [only, value, onChange])

  if (!address) {
    return (
      <div>
        <p className="label">{t('programLabel')}</p>
        <p className="mt-1 text-sm text-slate-600">{t('programConnect')}</p>
      </div>
    )
  }
  if (query.isLoading) return <p className="hint">{t('programLoading')}</p>

  if (programs.length === 0) {
    return (
      <TextField
        label={t('programId')}
        value={value}
        onChange={onChange}
        inputMode="numeric"
        hint={t('programNone')}
      />
    )
  }

  if (only) {
    return (
      <div>
        <p className="label">{t('programLabel')}</p>
        <p className="mt-1 text-sm text-slate-800">
          {t('programOne', { id: only.id, members: only.memberCount })}
        </p>
      </div>
    )
  }

  return (
    <div>
      <p className="label">{t('programLabel')}</p>
      <select className="input" value={value} onChange={(event) => onChange(event.target.value)}>
        <option value="">{t('programPick')}</option>
        {programs.map((program) => (
          <option key={program.id} value={program.id}>
            {t('programOption', { id: program.id, members: program.memberCount })}
          </option>
        ))}
      </select>
    </div>
  )
}
