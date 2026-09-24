import type { Metadata } from 'next'
import { getTranslations } from 'next-intl/server'
import { EmptyState, IndexerNotice } from '@/components/Notice'
import { RewardCreditPanel } from '@/components/RewardCreditPanel'
import { NeedStatusBadge } from '@/components/StatusBadge'
import { Link } from '@/i18n/navigation'
import { acceptsProof, rewardsLeft } from '@/lib/community'
import { amount, categoryIcon, flagEmoji, imageSrc, timestamp } from '@/lib/format'
import { getOpenBounties } from '@/lib/indexer'

export const dynamic = 'force-dynamic'

export async function generateMetadata({
  params: { locale },
}: {
  params: { locale: string }
}): Promise<Metadata> {
  const t = await getTranslations({ locale, namespace: 'earn' })
  return { title: t('title') }
}

/**
 * Needs whose NGO is paying for proof right now: go and photograph the goods, the site or the delivery, file it on
 * the need's page, and the NGO may reward the wallet that filed it. The pot is the NGO's own money, locked in the
 * CommunityProofs contract when it was opened, so what is listed here is really there. A reward is credit, not cash:
 * its holder gives it to a need or a basket from the panel below, and it counts for no vote.
 */
export default async function EarnPage() {
  const t = await getTranslations('earn')
  const tCommon = await getTranslations('common')
  const bounties = await getOpenBounties()
  const unit = tCommon('amountUnit')

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-bold tracking-tight">{t('title')}</h1>
        <p className="mt-1 max-w-3xl text-sm text-slate-700">{t('subtitle')}</p>
      </header>

      <ol className="grid gap-3 sm:grid-cols-3">
        {(['step1', 'step2', 'step3'] as const).map((step, index) => (
          <li key={step} className="card">
            <p className="text-xs font-semibold uppercase tracking-wide text-teal-800">
              {t('stepLabel', { n: index + 1 })}
            </p>
            <p className="mt-1 text-sm text-slate-800">{t(step)}</p>
          </li>
        ))}
      </ol>
      <p className="max-w-3xl text-xs text-slate-600">{t('rules')}</p>

      <RewardCreditPanel />

      {!bounties.ok ? <IndexerNotice error={bounties.error} /> : null}
      {bounties.ok && bounties.data.length === 0 ? (
        <EmptyState title={t('empty')} body={t('emptyBody')} />
      ) : null}

      {bounties.ok && bounties.data.length > 0 ? (
        <ul className="grid gap-3 sm:grid-cols-2">
          {bounties.data.map(({ bounty, need }) => {
            const cover = need.presentation?.coverImage
            return (
              <li key={bounty.id} className="card flex gap-4">
                {cover ? (
                  // biome-ignore lint/performance/noImgElement: the NGO hosts its own images; there is no loader for them
                  <img
                    src={imageSrc(cover)}
                    alt=""
                    loading="lazy"
                    referrerPolicy="no-referrer"
                    className="h-20 w-20 flex-none rounded-lg bg-slate-100 object-cover"
                  />
                ) : (
                  <span
                    className="flex h-20 w-20 flex-none items-center justify-center rounded-lg bg-teal-50 text-3xl"
                    aria-hidden="true"
                  >
                    {categoryIcon(need.categoryLabel)}
                  </span>
                )}
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <h2 className="text-base font-semibold leading-tight">
                      <Link
                        className="text-slate-900 no-underline hover:underline"
                        href={`/needs/${need.id}`}
                      >
                        #{need.id} · {need.categoryLabel}
                      </Link>
                    </h2>
                    <NeedStatusBadge status={need.status} />
                  </div>
                  <p className="text-xs text-slate-600">
                    <span aria-hidden="true">{flagEmoji(need.country)} </span>
                    {need.regionLabel}
                    {need.ngoName ? ` · ${need.ngoName}` : ''}
                  </p>
                  <p className="text-sm font-semibold text-amber-900">
                    {t('reward', { reward: amount(bounty.reward), unit })}
                  </p>
                  <p className="text-xs text-slate-600">
                    {t('left', {
                      left: rewardsLeft(bounty),
                      max: bounty.maxRewards,
                      date: timestamp(bounty.deadline),
                    })}
                  </p>
                  <p className="pt-1 text-sm">
                    <Link className="link" href={`/needs/${need.id}#community`}>
                      {acceptsProof(need.status) ? t('cta') : t('ctaLater')}
                    </Link>
                  </p>
                </div>
              </li>
            )
          })}
        </ul>
      ) : null}
    </div>
  )
}
