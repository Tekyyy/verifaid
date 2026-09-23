import type { DeliveryView, EvidenceFile } from '@poa/shared'
import { useTranslations } from 'next-intl'
import { ExplorerLink } from '@/components/ExplorerLink'
import { DeliveryStatusBadge } from '@/components/StatusBadge'
import { VoteProgress } from '@/components/VoteProgress'
import { ipfsGateway } from '@/lib/config'
import { timestamp } from '@/lib/format'

const isImage = (file: EvidenceFile) => file.type.startsWith('image/')

const kb = (size: number) =>
  size >= 1024 * 1024 ? `${(size / 1024 / 1024).toFixed(1)} MB` : `${Math.ceil(size / 1024)} KB`

/**
 * One delivery: how the NGO accounted for a tranche it was paid — its note and the files, each committed on chain
 * by hash, and pinned to IPFS where the platform could — and how far the votes on it have got.
 */
export function DeliveryCard({ delivery }: { delivery: DeliveryView }) {
  const t = useTranslations('need')
  const tCommon = useTranslations('common')
  const unit = tCommon('amountUnit')
  const files = delivery.manifest?.files ?? []
  const photos = files.filter(isImage)
  const documents = files.filter((file) => !isImage(file))

  return (
    <article id={`delivery-${delivery.id}`} className="rounded-md border border-slate-200 bg-white p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="font-semibold">{t('evidenceTitle', { spent: delivery.trancheIndex - 1 })}</h3>
          <p className="text-xs text-slate-600">
            {t('evidenceUnlocks', { index: delivery.trancheIndex })} ·{' '}
            {t('evidenceFiled', { date: timestamp(delivery.submittedAt) })}
          </p>
        </div>
        <DeliveryStatusBadge status={delivery.status} />
      </div>

      {delivery.manifest ? (
        <>
          {delivery.manifest.note ? (
            <p className="mt-3 whitespace-pre-line text-sm text-slate-800">{delivery.manifest.note}</p>
          ) : null}

          {photos.length > 0 ? (
            <ul className="mt-3 grid grid-cols-3 gap-2 sm:grid-cols-4">
              {photos.map((file) => (
                <li key={file.sha256}>
                  <a href={file.url || undefined} target="_blank" rel="noreferrer noopener" title={file.name}>
                    {/* biome-ignore lint/performance/noImgElement: user evidence served by hash; no optimisation wanted */}
                    <img
                      src={file.url || (file.cid ? `${ipfsGateway}${file.cid}` : '')}
                      alt={t(`evidenceKind.${file.kind}`)}
                      loading="lazy"
                      className="aspect-square w-full rounded border border-slate-200 object-cover"
                    />
                  </a>
                </li>
              ))}
            </ul>
          ) : null}

          {documents.length > 0 ? (
            <ul className="mt-3 space-y-1 text-sm">
              {documents.map((file) => (
                <li key={file.sha256} className="flex flex-wrap items-baseline gap-x-2">
                  <span className="rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-700">
                    {t(`evidenceKind.${file.kind}`)}
                  </span>
                  {file.url ? (
                    <a className="link break-all" href={file.url} target="_blank" rel="noreferrer noopener">
                      {file.name || file.sha256.slice(0, 12)}
                    </a>
                  ) : (
                    <span className="break-all">{file.name}</span>
                  )}
                  <span className="text-xs text-slate-500">{kb(file.size)}</span>
                  {file.cid ? <IpfsLink cid={file.cid} /> : null}
                </li>
              ))}
            </ul>
          ) : null}
        </>
      ) : (
        <div className="mt-3">
          <p className="text-xs text-amber-800">{t('evidenceUnreadable')}</p>
          <pre className="mt-1 max-h-40 overflow-auto rounded bg-slate-50 p-2 text-xs">
            {delivery.manifestText}
          </pre>
        </div>
      )}

      <div className="mt-4 space-y-1">
        <VoteProgress delivery={delivery} unit={unit} />
        <p className="text-xs text-slate-600">{t('voteCount', { count: delivery.votes.length })}</p>
        {delivery.status === 'Superseded' && delivery.supersededBy ? (
          <p className="text-xs text-slate-600">
            {t(delivery.contested ? 'evidenceContested' : 'evidenceSuperseded', {
              id: delivery.supersededBy,
            })}
          </p>
        ) : null}
        {delivery.status === 'Rejected' ? (
          <p className="text-xs font-medium text-red-800">
            {t(delivery.cancelledNeed ? 'evidenceRejectedFinal' : 'evidenceRejected')}
          </p>
        ) : null}
      </div>

      <dl className="mt-3 grid grid-cols-1 gap-x-4 gap-y-1 text-xs sm:grid-cols-2">
        <div className="flex gap-1">
          <dt className="text-slate-600">{t('evidenceTx')}</dt>
          <dd>
            <ExplorerLink kind="tx" value={delivery.txHash} />
          </dd>
        </div>
        <div className="flex min-w-0 gap-1">
          <dt className="shrink-0 text-slate-600">{t('evidenceHash')}</dt>
          <dd className="mono truncate" title={delivery.evidenceHash}>
            {delivery.evidenceHash}
          </dd>
        </div>
      </dl>
    </article>
  )
}

/** The same file on IPFS, where it outlives this server. Any gateway serves the bytes the sha256 above commits to. */
function IpfsLink({ cid }: { cid: string }) {
  const t = useTranslations('need')
  return (
    <a
      className="text-xs text-teal-800 underline"
      href={`${ipfsGateway}${cid}`}
      target="_blank"
      rel="noreferrer noopener"
      title={cid}
    >
      {t('evidenceIpfs')}
    </a>
  )
}
