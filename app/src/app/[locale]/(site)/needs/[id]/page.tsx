import type { NeedStatus } from '@poa/shared'
import type { Metadata } from 'next'
import { getLocale, getTranslations } from 'next-intl/server'
import { CardOnrampPanel } from '@/components/CardOnrampPanel'
import { CommunityProofs } from '@/components/CommunityProofs'
import { Deadline } from '@/components/Deadline'
import { DeliveryCard } from '@/components/DeliveryCard'
import { DeliveryReviewPanel } from '@/components/DeliveryReviewPanel'
import { DepositAddressPanel } from '@/components/DepositAddressPanel'
import { DonatePanel } from '@/components/DonatePanel'
import { DonationList } from '@/components/DonationList'
import { ExpireButton } from '@/components/ExpireButton'
import { ExplorerLink } from '@/components/ExplorerLink'
import { IdleCapitalNote } from '@/components/IdleCapitalNote'
import { CoverImage, ImagePlaceholder } from '@/components/ImagePlaceholder'
import { MobileDonateBar } from '@/components/MobileDonateBar'
import { NeedBadgeRow } from '@/components/NeedBadgeRow'
import { NeedNews } from '@/components/NeedNews'
import { NeedPresentation } from '@/components/NeedPresentation'
import { IndexerNotice, Notice } from '@/components/Notice'
import { PaymentPlanPanel } from '@/components/PaymentPlanPanel'
import { ProgressBar } from '@/components/ProgressBar'
import { RefundPanel } from '@/components/RefundPanel'
import { ReleasePolicyNote } from '@/components/ReleasePolicyNote'
import { SettlementList } from '@/components/SettlementList'
import { StatTile } from '@/components/StatTile'
import { NeedStatusBadge } from '@/components/StatusBadge'
import { TaxDeductionNotice } from '@/components/TaxDeductionNotice'
import { TermsPanel } from '@/components/TermsPanel'
import { Timeline } from '@/components/Timeline'
import { TrancheBar } from '@/components/TrancheBar'
import { WithdrawDonationPanel } from '@/components/WithdrawDonationPanel'
import { WorkPhotos } from '@/components/WorkPhotos'
import { YourDonationsNote } from '@/components/YourDonationsNote'
import { Link } from '@/i18n/navigation'
import { conversionsEnabled, deployment } from '@/lib/config'
import { amount, categoryIcon, flagEmoji, percent, timestamp } from '@/lib/format'
import { getNeed, getTimeline, needFeedPath } from '@/lib/indexer'
import { newsTopic } from '@/lib/server/news'

export const dynamic = 'force-dynamic'

export async function generateMetadata(props: {
  params: Promise<{ locale: string; id: string }>
}): Promise<Metadata> {
  const params = await props.params
  const t = await getTranslations({ locale: params.locale, namespace: 'need' })
  return { title: t('title', { id: params.id }) }
}

const EXPIRABLE_BEFORE_FUNDING: NeedStatus[] = ['Pending', 'Funding']
const EXPIRABLE_AFTER_FUNDING: NeedStatus[] = ['Funded', 'InDelivery']
const BEFORE_CLOSE: NeedStatus[] = ['Pending', 'Verified', 'Funding']

/**
 * A need as a donor reads it: first the picture and what it is raising, then the few numbers that say how far it
 * got, then the detail — the tranches and the evidence behind each, the terms, who is paid, and the full history.
 * Addresses and identifiers are all still here, in one "on-chain details" card, instead of in the way at the top.
 */
export default async function NeedPage(props: { params: Promise<{ id: string }> }) {
  const params = await props.params
  const t = await getTranslations('need')
  const tCommon = await getTranslations('common')
  const tTimeline = await getTranslations('timeline')
  const tErrors = await getTranslations('errors')
  const tSettlements = await getTranslations('settlements')
  const tPhotos = await getTranslations('photos')
  const tUi = await getTranslations('ui')

  const [need, timeline] = await Promise.all([getNeed(params.id), getTimeline(params.id)])

  if (!need.ok) {
    return need.error.kind === 'http' && need.error.status === 404 ? (
      <Notice tone="error" title={tErrors('notFoundTitle')}>
        {tErrors('needNotFound', { id: params.id })}
      </Notice>
    ) : (
      <IndexerNotice error={need.error} />
    )
  }

  const data = need.data
  const unit = tCommon('amountUnit')
  const progress = percent(data.totalDonated, data.targetAmount)

  // Rendered per request, so "now" is the moment the page was served; the contract re-checks on submit.
  const now = Math.floor(Date.now() / 1000)
  const passed = (deadline: number | null) => Boolean(deadline) && (deadline as number) <= now
  const deadlineReached =
    (EXPIRABLE_BEFORE_FUNDING.includes(data.status) &&
      (passed(data.fundingDeadline) || passed(data.executionDeadline))) ||
    (EXPIRABLE_AFTER_FUNDING.includes(data.status) && passed(data.executionDeadline))
  const fundingOpen =
    data.status === 'Funding' && !passed(data.fundingDeadline) && !passed(data.executionDeadline)
  const refundable = data.status === 'Cancelled' || data.status === 'Expired'
  // Evidence the donors can still approve: only while the need is being delivered.
  const underReview =
    data.status === 'InDelivery' ? data.deliveries.find((delivery) => delivery.status === 'Open') : undefined
  const beforeClose = BEFORE_CLOSE.includes(data.status)
  const tranchesPaid = data.tranches.filter((tranche) => tranche.status === 'Released').length
  const evidenceApproved = data.deliveries.filter((delivery) => delivery.status === 'Approved').length
  const photosDue = data.status === 'InDelivery' || data.status === 'Completed'
  // Searched by category and coarse region only; null when news is off or the region cannot be named.
  const news = newsTopic(data.categoryLabel, data.regionLabel, (await getLocale()) === 'es' ? 'es' : 'en')

  const sections = [
    ['about', t('navAbout')],
    ...(news ? ([['news', t('navNews')]] as const) : []),
    ['tranches', t('navTranches')],
    ['deliveries', t('navEvidence')],
    ...(deployment?.contracts.CommunityProofs ? ([['community', t('navCommunity')]] as const) : []),
    ['terms', t('navTerms')],
    ['plan', t('navPlan')],
    ['timeline', t('navTimeline')],
    ['details', t('navDetails')],
  ] as const

  return (
    // Room at the bottom on a phone for the donate bar, so it never covers the last panel.
    <div className={`space-y-8 ${fundingOpen ? 'pb-20 lg:pb-0' : ''}`}>
      {fundingOpen ? (
        <MobileDonateBar
          label={t('donateTitle')}
          summary={t('raisedOfTarget', {
            raised: amount(data.totalDonated),
            target: amount(data.targetAmount),
            unit,
          })}
        />
      ) : null}

      {/* ── who, what, where ─────────────────────────────────────────────────── */}
      <header className="space-y-3">
        <Link href="/needs" className="link text-sm no-underline hover:underline">
          ← {t('backToNeeds')}
        </Link>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="eyebrow">
              <span aria-hidden="true">{categoryIcon(data.categoryLabel)} </span>
              {data.categoryLabel} · <span aria-hidden="true">{flagEmoji(data.country)} </span>
              {data.regionLabel}
              {data.ngoName ? ` · ${data.ngoName}` : ''}
            </p>
            <h1 className="mt-1 text-3xl font-bold tracking-tight">{t('title', { id: data.id })}</h1>
            {data.presentation?.summary ? (
              <p className="mt-2 max-w-2xl text-base text-slate-700">{data.presentation.summary}</p>
            ) : null}
          </div>
          <div className="flex flex-wrap gap-2">
            <a
              className="btn-secondary text-xs"
              href={`/api/reports/${encodeURIComponent(data.id)}`}
              download
            >
              {t('downloadReport')}
            </a>
            <a className="btn-secondary text-xs" href={needFeedPath(data.id)} type="application/rss+xml">
              {t('rss')}
            </a>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <NeedStatusBadge status={data.status} />
          {data.beneficiary ? (
            <span className="chip bg-teal-50 text-teal-800">{t('postedByBeneficiaryShort')}</span>
          ) : null}
          <NeedBadgeRow badges={data.badges} taxStatus={data.taxStatus} />
        </div>
        {data.beneficiary ? <p className="text-sm text-slate-700">{t('postedByBeneficiary')}</p> : null}
      </header>

      {/* ── the picture, and what it is raising ──────────────────────────────── */}
      <section className="grid gap-6 lg:grid-cols-3" aria-labelledby="funding">
        <div className="lg:col-span-2">
          <CoverImage
            src={data.presentation?.coverImage}
            label={tUi('coverPhoto')}
            hint={tUi('coverPhotoHint')}
            className="aspect-[5/2] w-full lg:aspect-[16/9]"
          />
        </div>

        <div className="card flex flex-col gap-4">
          <h2 id="funding" className="sr-only">
            {t('fundingTitle')}
          </h2>
          <div>
            <p className="text-3xl font-bold tabular-nums text-teal-700">
              {amount(data.totalDonated)}{' '}
              <span className="text-base font-semibold text-slate-600">{unit}</span>
            </p>
            <p className="text-sm text-slate-600">
              {t('ofTargetPercent', {
                target: amount(data.targetAmount),
                unit,
                percent: progress.toFixed(0),
              })}
            </p>
          </div>
          <ProgressBar value={progress} label={`${progress.toFixed(0)}%`} />
          <dl className="grid grid-cols-2 gap-3 text-sm">
            <div>
              <dt className="text-xs text-slate-600">{t('donorsLabel')}</dt>
              <dd className="font-semibold tabular-nums">{data.donations.length}</dd>
            </div>
            <div>
              <dt className="text-xs text-slate-600">{t('fundingGap')}</dt>
              <dd className="font-semibold tabular-nums">
                {amount(data.fundingGap)} {unit}
              </dd>
            </div>
            <div className="col-span-2">
              <dt className="text-xs text-slate-600">{beforeClose ? t('fundingCloses') : t('deliverBy')}</dt>
              <dd className="text-xs">
                <Deadline
                  seconds={beforeClose ? data.fundingDeadline : data.executionDeadline}
                  none={t('openEnded')}
                />
              </dd>
            </div>
          </dl>
          {fundingOpen ? (
            <a href="#donate" className="btn-primary w-full no-underline">
              {t('donateCta')}
            </a>
          ) : (
            <p className="rounded-md bg-slate-50 px-3 py-2 text-sm text-slate-700">{t('notFundingNow')}</p>
          )}
          <div className="mt-auto flex items-center gap-3 border-t border-slate-100 pt-3">
            <ImagePlaceholder shape="circle" label={tUi('ngoLogo')} className="h-10 w-10 shrink-0" />
            <div className="min-w-0 text-sm">
              <p className="text-xs text-slate-600">{t('organisedBy')}</p>
              <ExplorerLink kind="address" value={data.ngo} />
            </div>
          </div>
        </div>
      </section>

      {/* ── how far it got ───────────────────────────────────────────────────── */}
      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4" aria-label={t('atGlance')}>
        <StatTile label={t('released')} value={amount(data.totalReleased)} hint={unit} />
        <StatTile
          label={t('tranchesPaid')}
          value={`${tranchesPaid} / ${data.tranches.length}`}
          hint={t('tranchesPaidHint')}
        />
        <StatTile label={t('evidenceApproved')} value={evidenceApproved} hint={t('evidenceApprovedHint')} />
        <StatTile
          label={t('verifications')}
          value={`${data.verificationCount} / ${data.verificationsRequired}`}
          hint={t('verificationsHint')}
        />
      </dl>

      <nav
        aria-label={t('sectionsLabel')}
        className="no-scrollbar -mx-4 flex gap-2 overflow-x-auto px-4 sm:mx-0 sm:px-0"
      >
        {sections.map(([id, label]) => (
          <a
            key={id}
            href={`#${id}`}
            className="chip whitespace-nowrap border border-slate-200 bg-white px-3 py-1 text-slate-700 no-underline hover:border-teal-300 hover:text-teal-800"
          >
            {label}
          </a>
        ))}
      </nav>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="min-w-0 space-y-6 lg:col-span-2">
          {/* ── about ──────────────────────────────────────────────────────────── */}
          <div id="about" className="space-y-6">
            {data.presentation?.summary || data.presentation?.gallery.length ? (
              <NeedPresentation presentation={data.presentation} withCover={false} />
            ) : (
              <section className="card space-y-3" aria-labelledby="about-empty">
                <h2 id="about-empty" className="section-title">
                  {t('presentationTitle')}
                </h2>
                <p className="text-sm text-slate-700">{t('aboutEmpty')}</p>
                <div className="grid grid-cols-3 gap-2">
                  {[1, 2, 3].map((slot) => (
                    <ImagePlaceholder
                      key={slot}
                      label={tUi('galleryPhoto')}
                      className="aspect-[4/3] w-full"
                    />
                  ))}
                </div>
              </section>
            )}
          </div>

          {/* ── the problem in the news ────────────────────────────────────────── */}
          {news ? <NeedNews topic={news} /> : null}

          {/* ── tranches and the evidence behind them ──────────────────────────── */}
          <section className="card" aria-labelledby="tranches">
            <h2 id="tranches" className="section-title">
              {t('trancheTitle')}
            </h2>
            <p className="mt-1 text-sm text-slate-700">{t('trancheNote')}</p>
            <div className="mt-3">
              {data.tranches.length > 0 ? (
                <TrancheBar tranches={data.tranches} />
              ) : (
                <p className="text-sm text-slate-600">{tErrors('empty')}</p>
              )}
            </div>
          </section>

          <section className="card" aria-labelledby="deliveries">
            <h2 id="deliveries" className="section-title">
              {t('deliveriesTitle')}
            </h2>
            <p className="mt-1 text-sm text-slate-700">{t('deliveriesNote')}</p>
            <div className="mt-2">
              <ReleasePolicyNote
                policy={data.releasePolicy}
                verifiers={data.verificationsRequired}
                strikes={data.strikes}
                ownerIsBeneficiary={data.beneficiary !== null}
              />
            </div>
            <div className="mt-3 space-y-3">
              {data.deliveries.length > 0 ? (
                data.deliveries.map((delivery) => <DeliveryCard key={delivery.id} delivery={delivery} />)
              ) : (
                <p className="text-sm text-slate-600">{t('noDeliveries')}</p>
              )}
            </div>
          </section>

          {data.photos.length > 0 ? (
            <WorkPhotos photos={data.photos} />
          ) : photosDue ? (
            <section className="card space-y-3" aria-labelledby="work-photos-empty">
              <h2 id="work-photos-empty" className="section-title">
                {tPhotos('title')}
              </h2>
              <p className="text-sm text-slate-700">{t('workPhotosEmpty')}</p>
              <div className="grid grid-cols-3 gap-2">
                {[1, 2, 3].map((slot) => (
                  <ImagePlaceholder key={slot} label={tUi('workPhoto')} className="aspect-[4/3] w-full" />
                ))}
              </div>
            </section>
          ) : null}

          <CommunityProofs need={data} />

          {/* ── the terms and who is paid ───────────────────────────────────────── */}
          <TermsPanel need={data} />
          <PaymentPlanPanel need={data} />

          <section className="card" aria-labelledby="settlements">
            <h2 id="settlements" className="section-title">
              {tSettlements('title')}
            </h2>
            <p className="mt-1 text-sm text-slate-700">{tSettlements('note')}</p>
            <div className="mt-3">
              <SettlementList settlements={data.settlements} />
            </div>
          </section>

          {/* ── the full history ────────────────────────────────────────────────── */}
          <section className="card" aria-labelledby="timeline">
            <h2 id="timeline" className="section-title">
              {tTimeline('title')}
            </h2>
            <p className="mt-1 text-sm text-slate-700">{tTimeline('description')}</p>
            <div className="mt-4">
              {timeline.ok ? (
                timeline.data.length > 0 ? (
                  <Timeline events={timeline.data} />
                ) : (
                  <p className="text-sm text-slate-600">{tErrors('empty')}</p>
                )
              ) : (
                <IndexerNotice error={timeline.error} />
              )}
            </div>
          </section>

          <section className="card" aria-labelledby="details">
            <h2 id="details" className="section-title">
              {t('detailsTitle')}
            </h2>
            <p className="mt-1 text-sm text-slate-700">{t('detailsNote')}</p>
            <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3 text-xs sm:grid-cols-3">
              <div>
                <dt className="text-slate-600">{t('ngo')}</dt>
                <dd>
                  <ExplorerLink kind="address" value={data.ngo} />
                </dd>
              </div>
              {data.beneficiary ? (
                <div>
                  <dt className="text-slate-600">{t('runBy')}</dt>
                  <dd>
                    <ExplorerLink kind="address" value={data.beneficiary} />
                  </dd>
                </div>
              ) : null}
              <div>
                <dt className="text-slate-600">{t('vault')}</dt>
                <dd>
                  <ExplorerLink kind="address" value={data.vault} />
                </dd>
              </div>
              <div>
                <dt className="text-slate-600">{t('program')}</dt>
                <dd className="text-slate-800">#{data.programId}</dd>
              </div>
              <div>
                <dt className="text-slate-600">{t('created')}</dt>
                <dd className="text-slate-800">{timestamp(data.createdAt)}</dd>
              </div>
              <div>
                <dt className="text-slate-600">{t('refunded')}</dt>
                <dd className="text-slate-800 tabular-nums">
                  {amount(data.totalRefunded)} {unit}
                </dd>
              </div>
            </dl>
          </section>
        </div>

        <aside className="min-w-0 space-y-6">
          {underReview ? (
            <DeliveryReviewPanel
              needId={data.id}
              delivery={underReview}
              policy={data.releasePolicy}
              verifications={data.verificationsRequired}
              strikes={data.strikes}
              ownerIsBeneficiary={data.beneficiary !== null}
            />
          ) : null}
          {deadlineReached ? <ExpireButton needId={data.id} /> : null}
          {refundable ? <RefundPanel vault={data.vault} /> : null}
          <WithdrawDonationPanel need={data} />

          {fundingOpen ? <TaxDeductionNotice taxStatus={data.taxStatus} /> : null}

          <DonatePanel
            needId={data.id}
            vault={data.vault}
            fundingOpen={fundingOpen}
            targetAmount={data.targetAmount}
            totalDonated={data.totalDonated}
            thirdPartyCostBps={data.thirdPartyCostBps}
            taxStatus={data.taxStatus}
          />

          {/* Every way in ends on chain. A card buys USDC through the Coinbase on-ramp into the donor's own wallet,
              which then donates it; an exchange withdrawal lands in a deposit address that can only donate or
              refund. No payment provider holds anyone's money on the way. */}
          {conversionsEnabled ? (
            <>
              <CardOnrampPanel
                needId={data.id}
                open={fundingOpen}
                remaining={data.fundingGap}
                thirdPartyCostBps={data.thirdPartyCostBps}
                taxStatus={data.taxStatus}
              />
              <DepositAddressPanel
                needId={data.id}
                open={fundingOpen}
                thirdPartyCostBps={data.thirdPartyCostBps}
                taxStatus={data.taxStatus}
              />
            </>
          ) : null}

          <IdleCapitalNote need={data} />

          <section className="card" aria-labelledby="donations">
            <h2 id="donations" className="section-title">
              {t('donationsTitle')}
            </h2>
            <YourDonationsNote need={data} />
            <DonationList donations={data.donations} />
          </section>

          {data.impactReport ? (
            <section className="card border-emerald-200 bg-emerald-50" aria-labelledby="impact">
              <h2 id="impact" className="section-title">
                {t('impactTitle')}
              </h2>
              <dl className="mt-2 space-y-1 text-xs">
                <div className="flex justify-between gap-2">
                  <dt className="text-slate-700">{t('beneficiariesServed')}</dt>
                  <dd className="font-semibold tabular-nums">{data.impactReport.beneficiariesServed}</dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt className="text-slate-700">{tCommon('attestation')}</dt>
                  <dd>
                    <ExplorerLink kind="attestation" value={data.impactReport.uid} />
                  </dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt className="text-slate-700">{t('reportCid')}</dt>
                  <dd className="mono">{data.impactReport.reportCID}</dd>
                </div>
              </dl>
              {data.impactReport.revoked ? (
                <p className="mt-2 text-xs font-semibold text-red-800">{t('revoked')}</p>
              ) : null}
            </section>
          ) : null}
        </aside>
      </div>
    </div>
  )
}
