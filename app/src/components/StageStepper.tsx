import { DONOR_STAGES, type DonorStage, type DonorStageView } from '@poa/shared'
import { useTranslations } from 'next-intl'
import { ExplorerLink } from '@/components/ExplorerLink'
import { timestamp } from '@/lib/format'
import { isZeroUid } from '@/lib/links'

type StepState = 'done' | 'pending' | 'todo'

const DOT: Record<StepState, string> = {
  done: 'border-emerald-600 bg-emerald-600 text-white',
  pending: 'border-amber-500 bg-amber-50 text-amber-900',
  todo: 'border-slate-300 bg-white text-slate-500',
}

export const stepState = (view: DonorStageView | undefined): StepState =>
  view?.reached ? 'done' : view?.pending ? 'pending' : 'todo'

/**
 * Verified → Funded → Settled → Delivered → Impact confirmed. Each reached stage links to the transaction and
 * attestation behind it; a stage that is partly there says what is still missing instead of looking finished.
 */
export function StageStepper({
  stages,
  currentStage,
}: {
  stages: DonorStageView[]
  currentStage: DonorStage | null
}) {
  const t = useTranslations('track')
  const tCommon = useTranslations('common')
  const byStage = new Map(stages.map((view) => [view.stage, view]))

  return (
    <ol className="relative space-y-5">
      {DONOR_STAGES.map((stage, index) => {
        const view = byStage.get(stage)
        const state = stepState(view)
        return (
          <li key={stage} className="flex gap-3" aria-current={currentStage === stage ? 'step' : undefined}>
            <span
              className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full border-2 text-sm font-bold ${DOT[state]}`}
              aria-hidden="true"
            >
              {state === 'done' ? '✓' : index + 1}
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold text-slate-900">
                {t(`stage_${stage}`)}
                <span className="ml-2 text-xs font-normal text-slate-600">{t(`state_${state}`)}</span>
              </p>
              <p className="text-xs text-slate-600">{t(`stageBody_${stage}`)}</p>
              {view?.reached && view.at ? (
                <p className="mt-1 text-xs text-slate-800">{timestamp(view.at)}</p>
              ) : null}
              {!view?.reached && view?.pending ? (
                <p className="mt-1 text-xs font-medium text-amber-900">
                  {t('pendingLabel')}: {view.pending}
                </p>
              ) : null}
              {view?.txHash || !isZeroUid(view?.attestationUID) ? (
                <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
                  {view?.txHash ? (
                    <span className="flex items-center gap-1">
                      <span className="text-slate-600">{tCommon('transaction')}</span>
                      <ExplorerLink kind="tx" value={view.txHash} />
                    </span>
                  ) : null}
                  {!isZeroUid(view?.attestationUID) ? (
                    <span className="flex items-center gap-1">
                      <span className="text-slate-600">{tCommon('attestation')}</span>
                      <ExplorerLink kind="attestation" value={view?.attestationUID} />
                    </span>
                  ) : null}
                </div>
              ) : null}
            </div>
          </li>
        )
      })}
    </ol>
  )
}
