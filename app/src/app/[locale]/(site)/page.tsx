import { getTranslations } from 'next-intl/server'
import { ImagePlaceholder } from '@/components/ImagePlaceholder'
import { NeedCard } from '@/components/NeedCard'
import { IndexerNotice } from '@/components/Notice'
import { StatTile } from '@/components/StatTile'
import { Link } from '@/i18n/navigation'
import { amount } from '@/lib/format'
import { getImpactSummary, getNeeds } from '@/lib/indexer'

// Live totals: never prerendered, so the page always shows the current state of the chain.
export const dynamic = 'force-dynamic'

/** How many open needs the home page puts in front of a donor before sending them to the full list. */
const FEATURED = 3

export default async function HomePage() {
  const t = await getTranslations('home')
  const tCommon = await getTranslations('common')
  const tUi = await getTranslations('ui')
  const [summary, open] = await Promise.all([getImpactSummary(), getNeeds({ open: true, sort: 'urgency' })])
  const unit = tCommon('amountUnit')
  const featured = open.ok ? open.data.slice(0, FEATURED) : []

  const flow = [1, 2, 3, 4, 5] as const

  return (
    <div className="space-y-14">
      {/* ── what this is ─────────────────────────────────────────────────────── */}
      <section className="grid items-center gap-8 overflow-hidden rounded-2xl border border-teal-100 bg-gradient-to-br from-teal-200 to-white px-6 py-10 sm:px-10 sm:py-12 lg:grid-cols-5">
        <div className="lg:col-span-3">
          <p className="eyebrow">{tCommon('tagline')}</p>
          <h1 className="mt-2 text-4xl font-bold tracking-tight text-slate-900 sm:text-5xl">{t('title')}</h1>
          <p className="mt-3 max-w-2xl text-base text-slate-700">{t('lead')}</p>
          <div className="mt-6 flex flex-wrap gap-3">
            <Link className="btn-primary" href="/needs">
              {t('browseNeeds')}
            </Link>
            <Link className="btn-secondary" href="/impact">
              {t('seeImpact')}
            </Link>
          </div>
        </div>
        <ImagePlaceholder
          label={tUi('heroPhoto')}
          hint={tUi('heroPhotoHint')}
          className="aspect-[16/9] w-full bg-white/60 lg:col-span-2 lg:aspect-[4/3]"
        />
      </section>

      {/* ── live totals ──────────────────────────────────────────────────────── */}
      <section aria-labelledby="totals" className="space-y-4">
        <div>
          <h2 id="totals" className="section-title">
            {t('totalsTitle')}
          </h2>
          <p className="mt-1 text-sm text-slate-600">{t('totalsNote')}</p>
        </div>

        {summary.ok ? (
          <>
            <dl className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <StatTile
                size="lg"
                label={t('donated')}
                value={amount(summary.data.totals.donated)}
                hint={unit}
              />
              <StatTile
                size="lg"
                label={t('released')}
                value={amount(summary.data.totals.released)}
                hint={unit}
              />
              <StatTile size="lg" label={t('needs')} value={summary.data.totals.needs} />
              <StatTile size="lg" label={t('completed')} value={summary.data.totals.needsCompleted} />
            </dl>
            <dl className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <StatTile size="sm" label={t('deliveries')} value={summary.data.totals.deliveriesApproved} />
              <StatTile size="sm" label={t('confirmations')} value={summary.data.totals.approvals} />
              <StatTile
                size="sm"
                label={t('beneficiaries')}
                value={summary.data.totals.beneficiariesServed}
              />
            </dl>
          </>
        ) : (
          <IndexerNotice error={summary.error} />
        )}
      </section>

      {/* ── needs to fund now ────────────────────────────────────────────────── */}
      {featured.length > 0 ? (
        <section aria-labelledby="featured" className="space-y-4">
          <div className="flex flex-wrap items-end justify-between gap-2">
            <div>
              <h2 id="featured" className="section-title">
                {t('featuredTitle')}
              </h2>
              <p className="mt-1 text-sm text-slate-600">{t('featuredNote')}</p>
            </div>
            <Link href="/needs?open=true" className="link text-sm font-semibold">
              {t('featuredAll')} →
            </Link>
          </div>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {featured.map((need) => (
              <NeedCard key={need.id} need={need} />
            ))}
          </div>
        </section>
      ) : null}

      {/* ── how the money moves ──────────────────────────────────────────────── */}
      <section aria-labelledby="flow" className="space-y-4">
        <h2 id="flow" className="section-title">
          {t('flowTitle')}
        </h2>
        <ol className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          {flow.map((step) => (
            <li key={step} className="card relative pt-6">
              <span
                className="absolute -top-3 left-4 flex h-7 w-7 items-center justify-center rounded-full bg-teal-700 text-sm font-bold text-white shadow"
                aria-hidden="true"
              >
                {step}
              </span>
              <h3 className="font-semibold">{t(`flow${step}Title`)}</h3>
              <p className="mt-1 text-sm text-slate-700">{t(`flow${step}Body`)}</p>
            </li>
          ))}
        </ol>
      </section>

      {/* ── what never reaches the chain ─────────────────────────────────────── */}
      <section
        aria-labelledby="privacy"
        className="card flex flex-col gap-4 border-teal-200 bg-teal-50 sm:flex-row"
      >
        <span
          className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-white text-2xl"
          aria-hidden="true"
        >
          🔒
        </span>
        <div>
          <h2 id="privacy" className="section-title">
            {t('privacyTitle')}
          </h2>
          <p className="mt-1 max-w-3xl text-sm text-slate-800">{t('privacyBody')}</p>
        </div>
      </section>
    </div>
  )
}
