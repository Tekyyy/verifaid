import type { TimelineEvent } from '@poa/shared'
import { useTranslations } from 'next-intl'
import { ExplorerLink } from '@/components/ExplorerLink'
import { timestamp } from '@/lib/format'
import { isZeroUid } from '@/lib/links'

/** Values the indexer already flattened; rendered as "key: value" pairs without inventing semantics. */
const entries = (data: TimelineEvent['data']): [string, string][] =>
  Object.entries(data)
    .filter(([, value]) => value !== null && value !== '')
    .map(([key, value]) => [key, String(value)])

export function Timeline({ events }: { events: TimelineEvent[] }) {
  const t = useTranslations('timeline')
  const tCommon = useTranslations('common')

  if (events.length === 0) {
    return <p className="text-sm text-slate-600">{tCommon('loading')}</p>
  }

  return (
    <ol className="relative space-y-4 border-l-2 border-slate-200 pl-5">
      {events.map((event) => (
        <li key={event.id} className="relative">
          <span
            className="absolute -left-[27px] top-1.5 h-3 w-3 rounded-full border-2 border-white bg-indigo-600"
            aria-hidden="true"
          />
          <div className="rounded-md border border-slate-200 bg-white p-3">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h3 className="text-sm font-semibold text-slate-900">{t(event.type)}</h3>
              <time className="text-xs text-slate-600">{timestamp(event.timestamp)}</time>
            </div>

            {entries(event.data).length > 0 ? (
              <dl className="mt-2 grid grid-cols-1 gap-x-4 gap-y-1 text-xs sm:grid-cols-2">
                {entries(event.data).map(([key, value]) => (
                  <div key={key} className="flex gap-1">
                    <dt className="font-medium text-slate-600">{key}</dt>
                    <dd className="truncate text-slate-800" title={value}>
                      {value}
                    </dd>
                  </div>
                ))}
              </dl>
            ) : null}

            <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
              <span className="flex items-center gap-1">
                <span className="text-slate-600">{tCommon('transaction')}</span>
                <ExplorerLink kind="tx" value={event.txHash} />
              </span>
              {!isZeroUid(event.attestationUID) ? (
                <span className="flex items-center gap-1">
                  <span className="text-slate-600">{tCommon('attestation')}</span>
                  <ExplorerLink kind="attestation" value={event.attestationUID} />
                </span>
              ) : null}
              <span className="text-slate-500">#{event.blockNumber}</span>
            </div>
          </div>
        </li>
      ))}
    </ol>
  )
}
