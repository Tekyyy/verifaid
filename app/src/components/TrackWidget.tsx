import { DONOR_STAGES, type DonationTrack } from '@poa/shared'
import { useTranslations } from 'next-intl'
import { ConversionNote } from '@/components/ConversionNote'
import { stepState } from '@/components/StageStepper'
import { amount, bpsPercent, timestamp } from '@/lib/format'

const DOT = {
  done: 'border-emerald-600 bg-emerald-600 text-white',
  pending: 'border-amber-500 bg-amber-50 text-amber-900 dark:bg-amber-950 dark:text-amber-200',
  todo: 'border-slate-300 bg-white text-slate-500 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-400',
} as const

const OUTCOME_TONE: Record<DonationTrack['outcome'], string> = {
  InProgress: 'bg-indigo-100 text-indigo-900 dark:bg-indigo-900 dark:text-indigo-100',
  Completed: 'bg-emerald-100 text-emerald-900 dark:bg-emerald-900 dark:text-emerald-100',
  Refundable: 'bg-amber-100 text-amber-900 dark:bg-amber-900 dark:text-amber-100',
  Refunded: 'bg-slate-200 text-slate-800 dark:bg-slate-700 dark:text-slate-100',
  Expired: 'bg-orange-100 text-orange-900 dark:bg-orange-900 dark:text-orange-100',
  Cancelled: 'bg-red-100 text-red-900 dark:bg-red-900 dark:text-red-100',
}

/**
 * The embeddable tracker: one column, readable at 320px, following the reader's light or dark preference.
 * It shows the stages and the headline numbers only; everything else is one click away on the full page.
 */
export function TrackWidget({ track, fullPageHref }: { track: DonationTrack; fullPageHref: string }) {
  const t = useTranslations('track')
  const tCommon = useTranslations('common')
  const byStage = new Map(track.stages.map((view) => [view.stage, view]))
  const unit = tCommon('amountUnit')

  return (
    <div className="flex min-h-screen flex-col gap-3 bg-white p-3 text-slate-900 dark:bg-slate-900 dark:text-slate-100">
      <header className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-bold">
            {track.need.categoryLabel} · {track.need.regionLabel}
          </p>
          <p className="text-xs text-slate-600 dark:text-slate-400">
            {t('widgetDonation', { amount: amount(track.donation.amount), unit })}
          </p>
          {track.donation.conversion ? (
            <ConversionNote
              conversion={track.donation.conversion}
              className="text-[11px] text-slate-600 tabular-nums dark:text-slate-400"
            />
          ) : null}
        </div>
        <span className={`badge shrink-0 ${OUTCOME_TONE[track.outcome]}`}>
          {t(`outcome_${track.outcome}`)}
        </span>
      </header>

      <ol className="space-y-2" aria-label={t('stagesTitle')}>
        {DONOR_STAGES.map((stage, index) => {
          const view = byStage.get(stage)
          const state = stepState(view)
          return (
            <li
              key={stage}
              className="flex gap-2"
              aria-current={track.currentStage === stage ? 'step' : undefined}
            >
              <span
                className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full border-2 text-xs font-bold ${DOT[state]}`}
                aria-hidden="true"
              >
                {state === 'done' ? '✓' : index + 1}
              </span>
              <div className="min-w-0 text-xs">
                <p className="font-semibold">
                  {t(`stage_${stage}`)}
                  <span className="sr-only"> — {t(`state_${state}`)}</span>
                </p>
                {view?.reached && view.at ? (
                  <p className="text-slate-600 dark:text-slate-400">{timestamp(view.at)}</p>
                ) : null}
                {!view?.reached && view?.pending ? (
                  <p className="text-amber-800 dark:text-amber-300">{view.pending}</p>
                ) : null}
              </div>
            </li>
          )
        })}
      </ol>

      <dl className="grid grid-cols-2 gap-2 border-t border-slate-200 pt-2 text-xs dark:border-slate-700">
        <div>
          <dt className="text-slate-600 dark:text-slate-400">{t('share')}</dt>
          <dd className="font-semibold tabular-nums">{bpsPercent(track.shareBps)}%</dd>
        </div>
        <div>
          <dt className="text-slate-600 dark:text-slate-400">{t('releasedToNgo')}</dt>
          <dd className="font-semibold tabular-nums">
            {amount(track.releasedToNgo)} {unit}
          </dd>
        </div>
      </dl>

      <footer className="mt-auto flex items-center justify-between gap-2 text-[11px] text-slate-500 dark:text-slate-400">
        <span>{t('updatedAt', { at: timestamp(track.updatedAt) })}</span>
        <a
          className="font-semibold text-indigo-700 underline dark:text-indigo-300"
          href={fullPageHref}
          target="_blank"
          rel="noreferrer noopener"
        >
          {t('poweredBy')}
        </a>
      </footer>
    </div>
  )
}
