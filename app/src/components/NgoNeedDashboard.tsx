'use client'

import type { NeedDetail, NeedStatus, NeedSummary } from '@poa/shared'
import { useQuery } from '@tanstack/react-query'
import { useSearchParams } from 'next/navigation'
import { useTranslations } from 'next-intl'
import type { ReactNode } from 'react'
import { useId } from 'react'
import { type Address, isAddressEqual } from 'viem'
import { useAccount } from 'wagmi'
import { AcknowledgeDonationsPanel } from '@/components/AcknowledgeDonationsPanel'
import { CancelNeedPanel } from '@/components/CancelNeedPanel'
import { Deadline } from '@/components/Deadline'
import { ExplorerLink } from '@/components/ExplorerLink'
import { BarePanels } from '@/components/form'
import { IdleCapitalPanel } from '@/components/IdleCapitalPanel'
import { CoverImage, ImagePlaceholder } from '@/components/ImagePlaceholder'
import { NeedPresentationPanel } from '@/components/NeedPresentationPanel'
import { NgoCampaignDashboard } from '@/components/NgoCampaignDashboard'
import { CloseFunding, PublishImpactReport } from '@/components/NgoConsole'
import { IndexerNotice, Notice } from '@/components/Notice'
import { ProposePayeeChangePanel } from '@/components/PayeeChangePanel'
import { ProgressBar } from '@/components/ProgressBar'
import { ProofBountyPanel } from '@/components/ProofBountyPanel'
import { PublishPhotosPanel } from '@/components/PublishPhotosPanel'
import { ReleaseTranchePanel } from '@/components/ReleaseTranchePanel'
import { SettlementPanel } from '@/components/SettlementPanel'
import { StatTile } from '@/components/StatTile'
import { NeedStatusBadge } from '@/components/StatusBadge'
import { SubmitEvidencePanel } from '@/components/SubmitEvidencePanel'
import { TrancheBar } from '@/components/TrancheBar'
import { Link, useRouter } from '@/i18n/navigation'
import { acceptsBounty, openBountyOf } from '@/lib/community'
import { deployment } from '@/lib/config'
import { amount, categoryIcon, percent, timestamp } from '@/lib/format'
import { useMounted } from '@/lib/hooks'
import { getNeed, getNeeds } from '@/lib/indexer'

/** Who is looking: the NGO dashboard, or a certified beneficiary's own. */
export type DashboardRole = 'ngo' | 'beneficiary'

/** How the connected wallet relates to one need. */
type Viewer = 'owner' | 'sponsor' | 'other'

/** Whoever runs a need: the beneficiary who posted it, otherwise its NGO. */
const ownerOf = (need: NeedSummary): Address => need.beneficiary ?? need.ngo

const viewerOf = (need: NeedSummary, address: Address | undefined): Viewer => {
  if (!address) return 'other'
  if (isAddressEqual(ownerOf(need), address)) return 'owner'
  // The NGO that certified the beneficiary: it answers for the need but does not run it.
  if (need.beneficiary && isAddressEqual(need.ngo, address)) return 'sponsor'
  return 'other'
}

/**
 * Need management: pick one of your needs at the top and work on it — where it stands, what happens next, and only
 * the actions that make sense in its current state, already pointed at it. With no need picked, the campaigns
 * overview. The choice lives in the URL (`?need=4`), so it survives a reload and can be linked to.
 *
 * An NGO sees its own needs and the ones its certified beneficiaries posted; a beneficiary sees theirs.
 */
export function NgoNeedDashboard({ audience = 'ngo' }: { audience?: DashboardRole } = {}) {
  const t = useTranslations('manage')
  const tBeneficiary = useTranslations('beneficiary')
  const tStatus = useTranslations('needStatus')
  const selectId = useId()
  const mounted = useMounted()
  const { address } = useAccount()
  const router = useRouter()
  const selected = useSearchParams().get('need') ?? ''
  const basePath = audience === 'ngo' ? '/ngo/manage' : '/beneficiary'

  const needs = useQuery({
    queryKey: ['owner-needs', audience, address],
    queryFn: () => (audience === 'ngo' ? getNeeds() : getNeeds({ beneficiary: address })),
    enabled: Boolean(address),
    refetchInterval: 30_000,
  })
  const mine =
    needs.data?.ok && address
      ? needs.data.data
          .filter((need) =>
            audience === 'ngo'
              ? isAddressEqual(need.ngo, address)
              : Boolean(need.beneficiary && isAddressEqual(need.beneficiary, address)),
          )
          .sort((a, b) => Number(b.id) - Number(a.id))
      : []
  const choose = (id: string) => router.replace(id ? `${basePath}?need=${id}` : basePath, { scroll: false })

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="w-full sm:max-w-sm">
          <label className="label" htmlFor={selectId}>
            {t('pickLabel')}
          </label>
          <select
            id={selectId}
            className="input"
            value={selected}
            disabled={!mounted || !address}
            onChange={(event) => choose(event.target.value)}
          >
            <option value="">{audience === 'ngo' ? t('allCampaigns') : tBeneficiary('allNeeds')}</option>
            {mine.map((need) => (
              <option key={need.id} value={need.id}>
                {t('needOption', { id: need.id, category: need.categoryLabel, status: tStatus(need.status) })}
              </option>
            ))}
            {selected && !mine.some((need) => need.id === selected) ? (
              <option value={selected}>{t('needOptionOther', { id: selected })}</option>
            ) : null}
          </select>
        </div>
        {selected ? (
          <Link href={`/needs/${selected}`} className="btn-secondary">
            {t('publicPage')}
          </Link>
        ) : null}
      </div>

      {selected ? (
        <NeedWorkspace needId={selected} />
      ) : audience === 'ngo' ? (
        <NgoCampaignDashboard />
      ) : (
        <BeneficiaryNeedList needs={mine} loading={needs.isLoading} onChoose={choose} />
      )}
    </div>
  )
}

/** A beneficiary's needs, newest first, or the way to post the first one. */
function BeneficiaryNeedList({
  needs,
  loading,
  onChoose,
}: {
  needs: NeedSummary[]
  loading: boolean
  onChoose: (id: string) => void
}) {
  const t = useTranslations('beneficiary')
  const tCommon = useTranslations('common')
  const tUi = useTranslations('ui')
  const mounted = useMounted()
  const { address } = useAccount()

  if (!mounted || !address) return <Notice title={t('connectTitle')}>{t('connectBody')}</Notice>
  if (loading) return <p className="hint">{tCommon('loading')}</p>
  if (needs.length === 0) {
    return (
      <section className="card grid items-center gap-6 md:grid-cols-5">
        <ImagePlaceholder
          label={tUi('illustration')}
          hint={tUi('illustrationEmptyHint')}
          className="aspect-[4/3] w-full md:col-span-2"
        />
        <div className="space-y-3 md:col-span-3">
          <h2 className="text-xl font-semibold">{t('noneTitle')}</h2>
          <p className="text-sm text-slate-700">{t('noneBody')}</p>
          <Link href="/apply" className="btn-primary">
            {t('noneLink')}
          </Link>
        </div>
      </section>
    )
  }
  return (
    <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {needs.map((need) => {
        const progress = percent(need.totalDonated, need.targetAmount)
        return (
          <li key={need.id}>
            <button
              type="button"
              className="card flex h-full w-full flex-col gap-3 overflow-hidden p-0 text-left transition hover:border-teal-300 hover:shadow-md"
              onClick={() => onChoose(need.id)}
            >
              <CoverImage
                src={need.presentation?.coverImage}
                label={tUi('coverPhoto')}
                className="h-28 w-full"
                flush
              />
              <span className="flex flex-1 flex-col gap-2 px-4 pb-4">
                <span className="flex items-start justify-between gap-2">
                  <span className="font-semibold">
                    <span aria-hidden="true">{categoryIcon(need.categoryLabel)} </span>#{need.id} ·{' '}
                    {need.categoryLabel}
                  </span>
                  <NeedStatusBadge status={need.status} />
                </span>
                <span className="text-sm text-slate-600">{need.regionLabel}</span>
                <ProgressBar
                  value={progress}
                  label={t('raised', {
                    raised: amount(need.totalDonated),
                    target: amount(need.targetAmount),
                    unit: tCommon('amountUnit'),
                  })}
                />
                <span className="text-sm text-slate-700 tabular-nums">
                  {t('raised', {
                    raised: amount(need.totalDonated),
                    target: amount(need.targetAmount),
                    unit: tCommon('amountUnit'),
                  })}
                </span>
              </span>
            </button>
          </li>
        )
      })}
    </ul>
  )
}

function NeedWorkspace({ needId }: { needId: string }) {
  const t = useTranslations('manage')
  const tCommon = useTranslations('common')
  const { address } = useAccount()
  const query = useQuery({
    queryKey: ['ngo-need', needId],
    queryFn: () => getNeed(needId),
    enabled: /^\d+$/.test(needId),
    refetchInterval: 15_000,
  })

  if (!/^\d+$/.test(needId)) return <Notice tone="error" title={t('notFound', { id: needId })} />
  if (query.isLoading || !query.data) return <p className="hint">{tCommon('loading')}</p>
  if (!query.data.ok) {
    return query.data.error.kind === 'http' && query.data.error.status === 404 ? (
      <Notice tone="error" title={t('notFound', { id: needId })} />
    ) : (
      <IndexerNotice error={query.data.error} />
    )
  }

  const need = query.data.data
  const viewer = viewerOf(need, address)

  return (
    <div className="space-y-6">
      {address && viewer === 'other' ? (
        <Notice tone="warning" title={t('notYoursTitle')}>
          {t('notYoursBody')}
        </Notice>
      ) : null}
      {viewer === 'sponsor' && need.beneficiary ? (
        <Notice title={t('sponsorTitle')}>{t('sponsorBody', { beneficiary: need.beneficiary })}</Notice>
      ) : null}
      <NeedOverview need={need} />
      <NeedActions need={need} viewer={viewer} />
    </div>
  )
}

function NeedOverview({ need }: { need: NeedDetail }) {
  const t = useTranslations('manage')
  const tCommon = useTranslations('common')
  const tUi = useTranslations('ui')
  const unit = tCommon('amountUnit')
  const beforeClose = need.status === 'Pending' || need.status === 'Verified' || need.status === 'Funding'
  const progress = percent(need.totalDonated, need.targetAmount)

  return (
    <section className="card space-y-5" aria-labelledby="need-overview">
      <div className="grid gap-5 md:grid-cols-3">
        <CoverImage
          src={need.presentation?.coverImage}
          label={tUi('coverPhoto')}
          hint={tUi('coverPhotoManageHint')}
          className="aspect-[5/2] w-full md:aspect-[4/3]"
        />
        <div className="space-y-3 md:col-span-2">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <p className="eyebrow">
                <span aria-hidden="true">{categoryIcon(need.categoryLabel)} </span>
                {need.categoryLabel} · {need.regionLabel}
              </p>
              <h2 id="need-overview" className="mt-1 text-2xl font-bold tracking-tight">
                {t('needHeading', { id: need.id })}
              </h2>
            </div>
            <NeedStatusBadge status={need.status} />
          </div>
          <div>
            <p className="text-sm text-slate-800 tabular-nums">
              <span className="text-2xl font-bold text-teal-700">{amount(need.totalDonated)}</span>{' '}
              {t('ofTarget', { target: amount(need.targetAmount), unit, percent: progress.toFixed(0) })}
            </p>
            <div className="mt-2">
              <ProgressBar
                value={progress}
                label={t('raised', {
                  raised: amount(need.totalDonated),
                  target: amount(need.targetAmount),
                  unit,
                })}
              />
            </div>
          </div>
          <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <StatTile size="sm" label={t('paidOut')} value={amount(need.totalReleased)} hint={unit} />
            <StatTile size="sm" label={t('donations')} value={need.donations.length} />
            <StatTile
              size="sm"
              label={t('verifications')}
              value={`${need.verificationCount} / ${need.verificationsRequired}`}
            />
            <StatTile size="sm" label={t('deliveries')} value={need.deliveries.length} />
          </dl>
          <dl className="grid grid-cols-1 gap-x-4 gap-y-2 text-xs sm:grid-cols-3">
            <Fact label={beforeClose ? t('fundingCloses') : t('deliverBy')}>
              <Deadline seconds={beforeClose ? need.fundingDeadline : need.executionDeadline} none="—" />
            </Fact>
            <Fact label={t('vault')}>
              <ExplorerLink kind="address" value={need.vault} />
            </Fact>
            {need.beneficiary ? (
              <Fact label={t('runBy')}>
                <ExplorerLink kind="address" value={need.beneficiary} />
              </Fact>
            ) : null}
          </dl>
        </div>
      </div>

      <div className="border-t border-slate-100 pt-4">
        <h3 className="text-sm font-semibold text-slate-800">{t('tranches')}</h3>
        <div className="mt-2">
          <TrancheBar tranches={need.tranches} />
        </div>
      </div>
    </section>
  )
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="text-slate-600">{label}</dt>
      <dd className="text-slate-800">{children}</dd>
    </div>
  )
}

/** One sentence on what the need is waiting for, so the NGO never has to work it out from the statuses. */
function useNextStep(need: NeedDetail, viewer: Viewer): string {
  const t = useTranslations('manage')
  const tCommon = useTranslations('common')
  const tNeedStatus = useTranslations('needStatus')
  const unit = tCommon('amountUnit')

  const ready = need.tranches.find((tranche) => tranche.status === 'Releasable')
  const nextLocked = need.tranches.find((tranche) => tranche.status === 'Locked')
  const underReview = [...need.deliveries].reverse().find((delivery) => delivery.status === 'Open')
  const minimum = (BigInt(need.targetAmount) * BigInt(need.minFundingBps) + 9_999n) / 10_000n
  // A person's own need publishes no impact report: once the last tranche is paid there is nothing left to do.
  const completed = need.beneficiary ? 'next.CompletedPersonal' : 'next.Completed'
  // A tranche goes where the payment plan says: to suppliers on an NGO's need, to the person on a beneficiary's own.
  const release = !need.beneficiary
    ? 'next.release'
    : viewer === 'owner'
      ? 'next.releaseOwn'
      : 'next.releaseBeneficiary'

  return (() => {
    switch (need.status) {
      case 'Pending':
        return t('next.Pending', { count: need.verificationCount, required: need.verificationsRequired })
      case 'Verified':
        return t('next.Verified')
      case 'Funding':
        return t('next.Funding', { date: timestamp(need.fundingDeadline), minimum: amount(minimum), unit })
      case 'Funded':
      case 'InDelivery':
        if (ready) return t(release, { index: ready.index, amount: amount(ready.amount), unit })
        if (underReview) {
          // A rule where only verifiers decide has no donor threshold to count towards.
          return underReview.requiredAmount === '0'
            ? t('next.deliveryUnderwayVerifier', {
                spent: underReview.trancheIndex - 1,
                approved: underReview.verifierApprovals,
                required: underReview.requiredVerifiers,
              })
            : t('next.deliveryUnderway', {
                spent: underReview.trancheIndex - 1,
                approved: amount(underReview.approvedAmount),
                required: amount(underReview.requiredAmount),
                unit,
              })
        }
        return nextLocked
          ? t('next.openDelivery', { spent: nextLocked.index - 1, index: nextLocked.index })
          : t(completed)
      case 'Completed':
        return need.impactReport ? t('next.Done') : t(completed)
      default:
        return t('next.Closed', { status: tNeedStatus(need.status as NeedStatus).toLowerCase() })
    }
  })()
}

type ToolKey =
  | 'evidence'
  | 'release'
  | 'close'
  | 'idle'
  | 'settle'
  | 'payee'
  | 'photos'
  | 'ack'
  | 'impact'
  | 'presentation'
  | 'bounty'
  | 'cancel'

const TOOL_ICONS: Record<ToolKey, string> = {
  evidence: '🧾',
  release: '💸',
  close: '🔒',
  idle: '🏦',
  settle: '🤝',
  payee: '🔁',
  photos: '📷',
  ack: '🧾',
  impact: '📊',
  presentation: '✏️',
  bounty: '🎁',
  cancel: '⛔',
}

/**
 * Only what can be done to the need now, each panel already pointed at it. Whoever runs the need gets its actions;
 * the NGO that certified a beneficiary gets what stays the NGO's on such a need — withdrawing it before funding
 * closes, and the impact report — plus releasing a tranche, which anyone may do. Acknowledging donations for tax
 * is an organisation's statement, so it is offered on the NGO's own needs only.
 */
function NeedActions({ need, viewer }: { need: NeedDetail; viewer: Viewer }) {
  const t = useTranslations('manage')
  const s = need.status
  const delivering = s === 'Funded' || s === 'InDelivery'
  const closed = s === 'Cancelled' || s === 'Expired'
  const beforeClose = s === 'Pending' || s === 'Verified' || s === 'Funding'
  const runs = viewer !== 'sponsor'
  const ngoRuns = need.beneficiary === null
  const ngoVoice = ngoRuns || viewer === 'sponsor'

  const nextStep = useNextStep(need, viewer)

  const actions: { key: ToolKey; show: boolean; panel: ReactNode }[] = [
    { key: 'evidence', show: runs && s === 'InDelivery', panel: <SubmitEvidencePanel need={need} /> },
    { key: 'release', show: delivering, panel: <ReleaseTranchePanel needId={need.id} /> },
    { key: 'close', show: runs && s === 'Funding', panel: <CloseFunding needId={need.id} /> },
    {
      key: 'idle',
      show: runs && need.idleCapital !== null && (delivering || s === 'Completed'),
      panel: <IdleCapitalPanel needId={need.id} />,
    },
    {
      key: 'settle',
      show: runs && BigInt(need.totalReleased) > 0n,
      panel: <SettlementPanel needId={need.id} />,
    },
    {
      key: 'payee',
      // Only a plan with a supplier in it has anyone to replace.
      show: runs && need.payees.some((payee) => payee.account !== null) && (s === 'Funding' || delivering),
      panel: <ProposePayeeChangePanel needId={need.id} />,
    },
    {
      key: 'photos',
      show: runs && (delivering || s === 'Completed'),
      panel: <PublishPhotosPanel needId={need.id} />,
    },
    {
      key: 'ack',
      show: ngoRuns && need.donations.length > 0,
      panel: <AcknowledgeDonationsPanel needId={need.id} />,
    },
    {
      key: 'impact',
      // Not on a person's own need: it serves one household, and the resolver refuses a report for it.
      show: ngoVoice && !need.beneficiary && (s === 'InDelivery' || s === 'Completed'),
      panel: <PublishImpactReport needId={need.id} />,
    },
    { key: 'presentation', show: runs && !closed, panel: <NeedPresentationPanel needId={need.id} /> },
    {
      key: 'bounty',
      // The NGO's own money, paid to people who document the need; a pot left open on a need that has since closed
      // can still be closed and its balance taken back.
      show:
        ngoVoice &&
        Boolean(deployment?.contracts.CommunityProofs) &&
        (acceptsBounty(s) || openBountyOf(need.bounties) !== null),
      panel: <ProofBountyPanel need={need} />,
    },
    { key: 'cancel', show: beforeClose, panel: <CancelNeedPanel needId={need.id} /> },
  ]
  const shown = actions.filter((action) => action.show)

  // The one thing the need is waiting on from this viewer, lifted out of the list. Closing early only works once the
  // minimum is in, so until then the useful thing to do is to tell the story better.
  const minimum = (BigInt(need.targetAmount) * BigInt(need.minFundingBps) + 9_999n) / 10_000n
  const canClose = BigInt(need.totalDonated) >= minimum
  const releasable = need.tranches.some((tranche) => tranche.status === 'Releasable')
  const primaryKey: ToolKey | null =
    delivering && releasable
      ? 'release'
      : runs && s === 'InDelivery'
        ? 'evidence'
        : runs && s === 'Funding' && canClose
          ? 'close'
          : runs && beforeClose
            ? 'presentation'
            : ngoVoice && s === 'Completed' && !need.impactReport
              ? 'impact'
              : null
  const primary = shown.find((action) => action.key === primaryKey)
  const rest = shown.filter((action) => action !== primary)

  return (
    <div className="space-y-6">
      <section
        className="overflow-hidden rounded-xl border border-teal-200 bg-white shadow-sm"
        aria-labelledby="need-next"
      >
        <div className="border-b border-teal-100 bg-teal-50 px-5 py-4" role="status">
          <h2 id="need-next" className="eyebrow">
            {t('nextTitle')}
          </h2>
          <p className="mt-1 text-base text-slate-900">{nextStep}</p>
        </div>
        {primary ? (
          <div className="space-y-3 px-5 py-5">
            <h3 className="flex items-center gap-2 text-lg font-semibold text-slate-900">
              <span aria-hidden="true">{TOOL_ICONS[primary.key]}</span>
              {t(`tool.${primary.key}.title`)}
            </h3>
            <BarePanels>{primary.panel}</BarePanels>
          </div>
        ) : null}
      </section>

      <section className="space-y-3" aria-labelledby="need-tools">
        <div>
          <h2 id="need-tools" className="section-title">
            {primary ? t('moreTools') : t('actionsTitle')}
          </h2>
          <p className="hint">{primary ? t('moreToolsHint') : t('toolsHint')}</p>
        </div>
        {rest.length === 0 ? (
          <p className="text-sm text-slate-700">{primary ? t('noMoreTools') : t('noActions')}</p>
        ) : (
          <div className="divide-y divide-slate-200 overflow-hidden rounded-xl border border-slate-200 bg-white">
            {rest.map((action) => (
              <details key={action.key} className="group">
                <summary className="flex cursor-pointer list-none items-center gap-3 px-4 py-3 hover:bg-slate-50 [&::-webkit-details-marker]:hidden">
                  <span
                    aria-hidden="true"
                    className={`grid h-9 w-9 shrink-0 place-items-center rounded-lg text-lg ${
                      action.key === 'cancel' ? 'bg-rose-50' : 'bg-teal-50'
                    }`}
                  >
                    {TOOL_ICONS[action.key]}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span
                      className={`block font-medium ${action.key === 'cancel' ? 'text-rose-800' : 'text-slate-900'}`}
                    >
                      {t(`tool.${action.key}.title`)}
                    </span>
                    <span className="block text-sm text-slate-600">{t(`tool.${action.key}.body`)}</span>
                  </span>
                  <span aria-hidden="true" className="text-xl text-slate-400 transition group-open:rotate-90">
                    ›
                  </span>
                </summary>
                <div className="border-t border-slate-100 bg-slate-50/60 px-4 py-4">
                  <BarePanels>{action.panel}</BarePanels>
                </div>
              </details>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}
