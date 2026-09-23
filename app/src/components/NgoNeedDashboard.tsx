'use client'

import type { NeedDetail, NeedStatus } from '@poa/shared'
import { useQuery } from '@tanstack/react-query'
import { useSearchParams } from 'next/navigation'
import { useTranslations } from 'next-intl'
import type { ReactNode } from 'react'
import { useId } from 'react'
import { isAddressEqual } from 'viem'
import { useAccount } from 'wagmi'
import { AcknowledgeDonationsPanel } from '@/components/AcknowledgeDonationsPanel'
import { Deadline } from '@/components/Deadline'
import { ExplorerLink } from '@/components/ExplorerLink'
import { IdleCapitalPanel } from '@/components/IdleCapitalPanel'
import { NeedPresentationPanel } from '@/components/NeedPresentationPanel'
import { NgoCampaignDashboard } from '@/components/NgoCampaignDashboard'
import { CloseFunding, PublishImpactReport } from '@/components/NgoConsole'
import { IndexerNotice, Notice } from '@/components/Notice'
import { ProposePayeeChangePanel } from '@/components/PayeeChangePanel'
import { ProgressBar } from '@/components/ProgressBar'
import { PublishPhotosPanel } from '@/components/PublishPhotosPanel'
import { ReleaseTranchePanel } from '@/components/ReleaseTranchePanel'
import { SettlementPanel } from '@/components/SettlementPanel'
import { NeedStatusBadge } from '@/components/StatusBadge'
import { TrancheBar } from '@/components/TrancheBar'
import { Link, useRouter } from '@/i18n/navigation'
import { amount, percent, timestamp } from '@/lib/format'
import { useMounted } from '@/lib/hooks'
import { getNeed, getNeeds } from '@/lib/indexer'

const ACTIVE_DELIVERY = new Set(['Open', 'Challengeable', 'Disputed'])

/**
 * Need management: pick one of the NGO's needs at the top and work on it — where it stands, what happens next,
 * and only the actions that make sense in its current state, already pointed at it. With no need picked, the
 * campaigns overview. The choice lives in the URL (`?need=4`), so it survives a reload and can be linked to.
 */
export function NgoNeedDashboard() {
  const t = useTranslations('manage')
  const tStatus = useTranslations('needStatus')
  const selectId = useId()
  const mounted = useMounted()
  const { address } = useAccount()
  const router = useRouter()
  const selected = useSearchParams().get('need') ?? ''

  const needs = useQuery({
    queryKey: ['ngo-needs', address],
    queryFn: () => getNeeds(),
    enabled: Boolean(address),
    refetchInterval: 30_000,
  })
  const mine =
    needs.data?.ok && address
      ? needs.data.data
          .filter((need) => isAddressEqual(need.ngo, address))
          .sort((a, b) => Number(b.id) - Number(a.id))
      : []
  const choose = (id: string) =>
    router.replace(id ? `/ngo/manage?need=${id}` : '/ngo/manage', { scroll: false })

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
            <option value="">{t('allCampaigns')}</option>
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

      {selected ? <NeedWorkspace needId={selected} /> : <NgoCampaignDashboard />}
    </div>
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
  const yours = Boolean(address && isAddressEqual(need.ngo, address))

  return (
    <div className="space-y-6">
      {address && !yours ? (
        <Notice tone="warning" title={t('notYoursTitle')}>
          {t('notYoursBody')}
        </Notice>
      ) : null}
      <NeedOverview need={need} />
      <NextStep need={need} />
      <NeedActions need={need} />
    </div>
  )
}

function NeedOverview({ need }: { need: NeedDetail }) {
  const t = useTranslations('manage')
  const tCommon = useTranslations('common')
  const unit = tCommon('amountUnit')
  const beforeClose = need.status === 'Pending' || need.status === 'Verified' || need.status === 'Funding'

  return (
    <section className="card space-y-4" aria-labelledby="need-overview">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h2 id="need-overview" className="section-title">
          {t('needTitle', { id: need.id, category: need.categoryLabel, region: need.regionLabel })}
        </h2>
        <NeedStatusBadge status={need.status} />
      </div>

      <div>
        <p className="text-sm text-slate-800 tabular-nums">
          {t('raised', { raised: amount(need.totalDonated), target: amount(need.targetAmount), unit })}
        </p>
        <div className="mt-2">
          <ProgressBar
            value={percent(need.totalDonated, need.targetAmount)}
            label={t('raised', {
              raised: amount(need.totalDonated),
              target: amount(need.targetAmount),
              unit,
            })}
          />
        </div>
      </div>

      <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-xs sm:grid-cols-3">
        <Fact label={beforeClose ? t('fundingCloses') : t('deliverBy')}>
          <Deadline seconds={beforeClose ? need.fundingDeadline : need.executionDeadline} none="—" />
        </Fact>
        <Fact label={t('paidOut')}>
          <span className="tabular-nums">
            {amount(need.totalReleased)} / {amount(need.totalDonated)} {unit}
          </span>
        </Fact>
        <Fact label={t('donations')}>{need.donations.length}</Fact>
        <Fact label={t('verifications')}>
          {need.verificationCount} / {need.verificationsRequired}
        </Fact>
        <Fact label={t('deliveries')}>{need.deliveries.length}</Fact>
        <Fact label={t('vault')}>
          <ExplorerLink kind="address" value={need.vault} />
        </Fact>
      </dl>

      <div>
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
function NextStep({ need }: { need: NeedDetail }) {
  const t = useTranslations('manage')
  const tCommon = useTranslations('common')
  const tNeedStatus = useTranslations('needStatus')
  const tDelivery = useTranslations('deliveryStatus')
  const unit = tCommon('amountUnit')

  const ready = need.tranches.find((tranche) => tranche.status === 'Releasable')
  const nextLocked = need.tranches.find((tranche) => tranche.status === 'Locked')
  const activeDelivery = [...need.deliveries]
    .reverse()
    .find((delivery) => ACTIVE_DELIVERY.has(delivery.status))
  const minimum = (BigInt(need.targetAmount) * BigInt(need.minFundingBps) + 9_999n) / 10_000n

  const text = (() => {
    switch (need.status) {
      case 'Pending':
        return t('next.Pending', { count: need.verificationCount, required: need.verificationsRequired })
      case 'Verified':
        return t('next.Verified')
      case 'Funding':
        return t('next.Funding', { date: timestamp(need.fundingDeadline), minimum: amount(minimum), unit })
      case 'Funded':
      case 'InDelivery':
        if (ready) return t('next.release', { index: ready.index, amount: amount(ready.amount), unit })
        if (activeDelivery) {
          return t('next.deliveryUnderway', {
            index: activeDelivery.trancheIndex,
            status: tDelivery(activeDelivery.status),
          })
        }
        return nextLocked ? t('next.openDelivery', { index: nextLocked.index }) : t('next.Completed')
      case 'Completed':
        return need.impactReport ? t('next.Done') : t('next.Completed')
      default:
        return t('next.Closed', { status: tNeedStatus(need.status as NeedStatus).toLowerCase() })
    }
  })()

  return (
    <div className="rounded-lg border border-teal-200 bg-teal-50 p-4" role="status">
      <p className="text-xs font-semibold uppercase tracking-wide text-teal-800">{t('nextTitle')}</p>
      <p className="mt-1 text-sm text-slate-900">{text}</p>
    </div>
  )
}

/** Only what can be done to the need now, each panel already pointed at it. */
function NeedActions({ need }: { need: NeedDetail }) {
  const t = useTranslations('manage')
  const s = need.status
  const delivering = s === 'Funded' || s === 'InDelivery'
  const closed = s === 'Cancelled' || s === 'Expired'

  const actions: { key: string; show: boolean; panel: ReactNode }[] = [
    { key: 'release', show: delivering, panel: <ReleaseTranchePanel needId={need.id} /> },
    { key: 'close', show: s === 'Funding', panel: <CloseFunding needId={need.id} /> },
    {
      key: 'idle',
      show: need.idleCapital !== null && (delivering || s === 'Completed'),
      panel: <IdleCapitalPanel needId={need.id} />,
    },
    {
      key: 'settle',
      show: BigInt(need.totalReleased) > 0n,
      panel: <SettlementPanel needId={need.id} />,
    },
    {
      key: 'payee',
      show: s === 'Funding' || delivering,
      panel: <ProposePayeeChangePanel needId={need.id} />,
    },
    {
      key: 'photos',
      show: delivering || s === 'Completed',
      panel: <PublishPhotosPanel needId={need.id} />,
    },
    {
      key: 'ack',
      show: need.donations.length > 0,
      panel: <AcknowledgeDonationsPanel needId={need.id} />,
    },
    {
      key: 'impact',
      show: s === 'InDelivery' || s === 'Completed',
      panel: <PublishImpactReport needId={need.id} />,
    },
    { key: 'presentation', show: !closed, panel: <NeedPresentationPanel needId={need.id} /> },
  ]
  const shown = actions.filter((action) => action.show)

  return (
    <section className="space-y-4" aria-labelledby="need-actions">
      <h2 id="need-actions" className="section-title">
        {t('actionsTitle')}
      </h2>
      {shown.length === 0 ? <p className="text-sm text-slate-700">{t('noActions')}</p> : null}
      {shown.map((action) => (
        <div key={action.key}>{action.panel}</div>
      ))}
    </section>
  )
}
