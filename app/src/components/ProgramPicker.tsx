'use client'

import type { ProgramView } from '@poa/shared'
import { useQuery } from '@tanstack/react-query'
import { useTranslations } from 'next-intl'
import { useEffect, useId } from 'react'
import { useAccount } from 'wagmi'
import { TextField } from '@/components/form'
import { useMounted } from '@/lib/hooks'
import { getPrograms } from '@/lib/indexer'
import { programPolicyLabel } from '@/lib/programNames'

/**
 * Which programme an action belongs to, picked from the connected NGO's own programmes. An NGO almost always has
 * one, so it comes preselected. The id is still typeable when the indexer cannot answer, because the contract —
 * not this list — is what decides whether the programme is yours.
 */
export function ProgramPicker({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const t = useTranslations('ngo')
  const id = useId()
  const mounted = useMounted()
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

  if (!mounted || !address) {
    return (
      <div>
        <p className="label">{t('programLabel')}</p>
        <p className="mt-1 text-sm text-slate-600">{t('programConnect')}</p>
      </div>
    )
  }
  if (query.isLoading) return <p className="hint">{t('programLoading')}</p>

  // The indexer could not answer: typing the id still works, and the contract checks it.
  if (query.data && !query.data.ok) {
    return <TextField label={t('programId')} value={value} onChange={onChange} inputMode="numeric" />
  }

  const label = (program: ProgramView) => {
    const name = programPolicyLabel(program.eligibilityHash)
    return name ? t('programOptionNamed', { id: program.id, name }) : t('programOption', { id: program.id })
  }

  return (
    <div>
      <label className="label" htmlFor={id}>
        {t('programLabel')}
      </label>
      <select
        id={id}
        className="input"
        value={value}
        disabled={programs.length === 0}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value="" disabled>
          {programs.length === 0 ? t('programNoneOption') : t('programPick')}
        </option>
        {programs.map((program) => (
          <option key={program.id} value={program.id}>
            {label(program)}
          </option>
        ))}
      </select>
      {programs.length === 0 ? <p className="hint">{t('programNone')}</p> : null}
    </div>
  )
}
