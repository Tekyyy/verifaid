'use client'

import type { DonationTrack } from '@poa/shared'
import { useTranslations } from 'next-intl'
import { useState } from 'react'
import { FormError, TextField } from '@/components/form'
import { attestationUrl, txUrl } from '@/lib/links'
import { renderTaxReceipt } from '@/lib/taxReceipt'

/**
 * The donor's side of the tax story: a document they can hand to an accountant, built here in the browser.
 * Their name and address are typed into this form and used only to render the file — they are never sent to a
 * server, never stored, and never go near the chain. Everything else in the document comes from public events.
 */
export function TaxReceiptPanel({ track, unit }: { track: DonationTrack; unit: string }) {
  const t = useTranslations('tax')
  const [name, setName] = useState('')
  const [address, setAddress] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const tax = track.need.taxStatus
  const acknowledged = track.acknowledgment !== null

  const download = async () => {
    setBusy(true)
    setError(null)
    try {
      const bytes = await renderTaxReceipt({
        track,
        unit,
        donorName: name.trim(),
        donorAddress: address.trim(),
        trackingUrl: typeof window === 'undefined' ? '' : window.location.href,
        explorerTxUrl: txUrl(track.donation.txHash) ?? track.donation.txHash,
        explorerAttestationUrl: track.acknowledgment ? attestationUrl(track.acknowledgment.uid) : null,
      })
      const blob = new Blob([bytes as BlobPart], { type: 'application/pdf' })
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = `donation-receipt-${track.ref}.pdf`
      link.click()
      URL.revokeObjectURL(url)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="card" aria-labelledby="tax-receipt">
      <h2 id="tax-receipt" className="section-title">
        {t('title')}
      </h2>
      <p className="mt-1 text-sm text-slate-700">{t('body')}</p>

      <p className="mt-2 text-xs">
        {tax ? (
          <span
            className={`badge ${tax.verified ? 'bg-emerald-100 text-emerald-900' : 'bg-slate-100 text-slate-700'}`}
          >
            {tax.verified
              ? t('orgVerified', { name: tax.legalName, id: tax.taxId })
              : t('orgClaimed', { name: tax.legalName, id: tax.taxId })}
          </span>
        ) : (
          <span className="badge bg-slate-100 text-slate-700">{t('orgNone')}</span>
        )}
      </p>

      <p className="mt-2 text-xs text-slate-600">{acknowledged ? t('acknowledged') : t('notAcknowledged')}</p>

      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <TextField label={t('donorName')} value={name} onChange={setName} />
        <TextField label={t('donorAddress')} value={address} onChange={setAddress} />
      </div>
      <p className="hint">{t('privacy')}</p>

      <FormError message={error} />
      <button type="button" className="btn-secondary mt-3" disabled={busy} onClick={download}>
        {busy ? t('preparing') : t('download')}
      </button>
      <p className="mt-2 text-xs text-slate-500">{t('disclaimer')}</p>
    </section>
  )
}
