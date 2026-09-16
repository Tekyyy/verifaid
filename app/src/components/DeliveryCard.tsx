import type { DeliveryView } from '@poa/shared'
import { useTranslations } from 'next-intl'
import { ExplorerLink } from '@/components/ExplorerLink'
import { ProgressBar } from '@/components/ProgressBar'
import { DeliveryStatusBadge } from '@/components/StatusBadge'
import { Link } from '@/i18n/navigation'
import { ratioPercent, timestamp } from '@/lib/format'
import { isZeroUid } from '@/lib/links'
import { evidenceViewUrl } from '@/lib/services'

/** One delivery: who filed it, how many people confirmed, and the two attestations that back it. */
export function DeliveryCard({ delivery }: { delivery: DeliveryView }) {
  const t = useTranslations('need')
  const tCommon = useTranslations('common')
  const ratio = ratioPercent(delivery.confirmationRatio)

  return (
    <article className="rounded-md border border-slate-200 bg-white p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="font-semibold">{t('delivery', { id: delivery.id })}</h3>
          <p className="text-xs text-slate-600">{t('forTranche', { index: delivery.trancheIndex })}</p>
        </div>
        <DeliveryStatusBadge status={delivery.status} />
      </div>

      <div className="mt-3">
        <ProgressBar
          tone="emerald"
          value={ratio}
          label={t('confirmationRatio', {
            confirmations: delivery.confirmations,
            expected: delivery.expectedRecipients,
            percent: ratio,
          })}
        />
        <p className="mt-1 text-xs text-slate-700">
          {t('confirmationRatio', {
            confirmations: delivery.confirmations,
            expected: delivery.expectedRecipients,
            percent: ratio,
          })}
        </p>
      </div>

      <dl className="mt-3 grid grid-cols-1 gap-x-4 gap-y-1 text-xs sm:grid-cols-2">
        <div className="flex gap-1">
          <dt className="text-slate-600">{t('fieldAgent')}</dt>
          <dd>
            <ExplorerLink kind="address" value={delivery.fieldAgent} />
          </dd>
        </div>
        <div className="flex gap-1">
          <dt className="text-slate-600">{t('evidence')}</dt>
          <dd>
            {isZeroUid(delivery.evidenceUID) ? (
              <span className="text-slate-500">—</span>
            ) : (
              <ExplorerLink kind="attestation" value={delivery.evidenceUID} />
            )}
          </dd>
        </div>
        <div className="flex gap-1">
          <dt className="text-slate-600">{t('verifierAttestation')}</dt>
          <dd>
            {isZeroUid(delivery.verifierUID) ? (
              <span className="text-slate-500">—</span>
            ) : (
              <ExplorerLink kind="attestation" value={delivery.verifierUID} />
            )}
          </dd>
        </div>
        <div className="flex gap-1">
          <dt className="text-slate-600">{t('challengeDeadline')}</dt>
          <dd className="text-slate-800">{timestamp(delivery.challengeDeadline)}</dd>
        </div>
        {delivery.evidenceCID ? (
          <div className="flex gap-1 sm:col-span-2">
            <dt className="text-slate-600">{t('evidenceCid')}</dt>
            <dd>
              <a
                className="link font-mono text-xs"
                href={evidenceViewUrl(delivery.evidenceCID)}
                target="_blank"
                rel="noreferrer noopener"
              >
                {delivery.evidenceCID}
              </a>
            </dd>
          </div>
        ) : null}
      </dl>

      {delivery.status === 'Open' ? (
        <Link className="link mt-3 inline-block text-xs" href={`/confirm/${delivery.id}`}>
          {tCommon('confirmLink')}
        </Link>
      ) : null}
    </article>
  )
}
