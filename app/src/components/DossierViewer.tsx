'use client'

import { useTranslations } from 'next-intl'
import { useState } from 'react'
import { piiVaultUrl, vaultEnabled } from '@/lib/config'
import { shorten } from '@/lib/format'
import { useVaultSession } from '@/lib/useVaultSession'
import { type DossierView, readDossier } from '@/lib/vault'

/**
 * The needs assessment a verifier checks before attesting a need, read from the NGO's vault. The verifier signs in
 * once (a wallet signature, no transaction), the vault checks they are a registered verifier, and what it returns
 * is compared with the dossier hash the need committed to on chain.
 */
export function DossierViewer({ dossierHash }: { dossierHash: string | undefined }) {
  const t = useTranslations('verifier')
  const vault = useVaultSession()
  const [dossier, setDossier] = useState<DossierView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const hashLabel = <span className="mono">{dossierHash ? shorten(dossierHash, 10, 6) : '—'}</span>
  if (!vaultEnabled) {
    return (
      <p className="text-xs text-slate-600">
        {t('dossierNoVault')} {hashLabel}
      </p>
    )
  }

  const open = async () => {
    if (!dossierHash) return
    setBusy(true)
    setError(null)
    const token = await vault.getToken()
    if (!token.ok) {
      setBusy(false)
      return setError(t('dossierError', { detail: token.error }))
    }
    const result = await readDossier({ baseUrl: piiVaultUrl }, token.data, dossierHash)
    setBusy(false)
    if (result.ok) return setDossier(result.data)
    if (result.status === 404) return setError(t('dossierNotStored'))
    if (result.status === 403) return setError(t('dossierForbidden'))
    setError(t('dossierError', { detail: result.error }))
  }

  const matches =
    Boolean(dossier?.hashMatches) && dossier?.ciphertextHash.toLowerCase() === dossierHash?.toLowerCase()

  return (
    <div className="space-y-2 text-xs">
      <p>
        <button
          type="button"
          className="btn-secondary px-3 py-1 text-xs"
          onClick={open}
          disabled={!dossierHash || busy || !vault.address}
        >
          {busy ? t('dossierLoading') : t('openDossier')}
        </button>{' '}
        {hashLabel}
      </p>
      {error ? (
        <p className="text-amber-900" role="alert">
          {error}
        </p>
      ) : null}
      {dossier ? (
        <div className="rounded-md border border-slate-200 bg-slate-50 p-3">
          <p className={matches ? 'font-medium text-emerald-800' : 'font-medium text-red-800'}>
            {matches ? t('dossierMatches') : t('dossierMismatch')}
          </p>
          <p className="mt-2 whitespace-pre-line text-sm text-slate-800">
            {typeof dossier.assessment.summary === 'string'
              ? dossier.assessment.summary
              : JSON.stringify(dossier.assessment)}
          </p>
        </div>
      ) : null}
    </div>
  )
}
