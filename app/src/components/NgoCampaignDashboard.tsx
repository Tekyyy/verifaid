'use client'

import { type NeedSummary, needsRegistryAbi } from '@poa/shared'
import { useQuery } from '@tanstack/react-query'
import { useLocale, useTranslations } from 'next-intl'
import { useState } from 'react'
import { type Address, isAddressEqual, zeroAddress } from 'viem'
import { useAccount, useReadContract } from 'wagmi'
import { Deadline } from '@/components/Deadline'
import { ExplorerLink } from '@/components/ExplorerLink'
import { Panel, SelectField } from '@/components/form'
import { CoverImage } from '@/components/ImagePlaceholder'
import { IndexerNotice } from '@/components/Notice'
import { ProgressBar } from '@/components/ProgressBar'
import { StatTile } from '@/components/StatTile'
import { NeedStatusBadge } from '@/components/StatusBadge'
import { Link } from '@/i18n/navigation'
import {
  earningsUpTo,
  isBeforeClose,
  isCurrent,
  isLongCampaign,
  monthsOf,
  type OptInState,
  optInState,
  waitingCapital,
  waitingWindow,
  type YieldVenueOption,
} from '@/lib/campaigns'
import { BASE_MAINNET_CHAIN_ID, chainId, deployment } from '@/lib/config'
import { amount, bpsPercent, categoryIcon, percent } from '@/lib/format'
import { useMounted } from '@/lib/hooks'
import { getNeed, getNeeds } from '@/lib/indexer'

const OPT_IN_TONES: Record<OptInState, string> = {
  optedIn: 'bg-emerald-100 text-emerald-900',
  canOptIn: 'bg-sky-100 text-sky-900',
  notOptedIn: 'bg-slate-200 text-slate-800',
}

/**
 * The top of the NGO console: every campaign the connected wallet runs that is still raising or delivering, and,
 * for the long ones, what their escrow could earn while it waits.
 */
export function NgoCampaignDashboard() {
  const t = useTranslations('campaigns')
  const tCommon = useTranslations('common')
  const mounted = useMounted()
  const { address, isConnected } = useAccount()

  const needs = useQuery({
    queryKey: ['ngo-campaigns'],
    queryFn: () => getNeeds(),
    enabled: mounted && isConnected,
    refetchInterval: 30_000,
  })

  if (!mounted || !isConnected || !address) {
    return (
      <Panel title={t('title')} description={t('body')}>
        <p className="hint">{t('connect')}</p>
      </Panel>
    )
  }

  const result = needs.data
  if (result && !result.ok) {
    return (
      <Panel title={t('title')} description={t('body')}>
        <IndexerNotice error={result.error} />
      </Panel>
    )
  }

  const now = Math.floor(Date.now() / 1000)
  const mine = (result?.ok ? result.data : []).filter(
    (need) => isAddressEqual(need.ngo, address) && isCurrent(need),
  )
  const long = mine.filter((need) => isLongCampaign(need, now))
  const unit = tCommon('amountUnit')

  const sum = (pick: (need: NeedSummary) => string | undefined) =>
    mine.reduce((total, need) => total + BigInt(pick(need) ?? '0'), 0n)
  const raised = sum((need) => need.totalDonated)
  const gap = sum((need) => need.fundingGap)
  const lent = sum((need) => need.idleCapital?.deployed)
  const earned = sum((need) => need.idleCapital?.earned)

  return (
    <Panel title={t('title')} description={t('body')}>
      {needs.isLoading ? <p className="hint">{tCommon('loading')}</p> : null}

      {result?.ok && mine.length === 0 ? <p className="text-sm text-slate-700">{t('empty')}</p> : null}

      {mine.length > 0 ? (
        <>
          <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <StatTile size="sm" label={t('active')} value={mine.length} />
            <StatTile size="sm" label={t('raised')} value={amount(raised)} hint={unit} />
            <StatTile size="sm" label={t('stillNeeded')} value={amount(gap)} hint={unit} />
            <StatTile
              size="sm"
              label={t('waiting')}
              value={amount(lent)}
              hint={earned > 0n ? t('earnedSoFar', { amount: amount(earned), unit }) : unit}
            />
          </dl>

          <ul className="divide-y divide-slate-200 overflow-hidden rounded-xl border border-slate-200">
            {mine.map((need) => (
              <CampaignRow key={need.id} need={need} long={long.includes(need)} now={now} />
            ))}
          </ul>
        </>
      ) : null}

      {long.length > 0 ? <LongCampaignVenues campaigns={long} now={now} /> : null}
    </Panel>
  )
}

function CampaignRow({ need, long, now }: { need: NeedSummary; long: boolean; now: number }) {
  const t = useTranslations('campaigns')
  const tCommon = useTranslations('common')
  const tUi = useTranslations('ui')
  const unit = tCommon('amountUnit')
  const share = percent(need.totalDonated, need.targetAmount)
  const before = isBeforeClose(need)
  const state = optInState(need)

  return (
    <li className="flex gap-4 p-3 hover:bg-slate-50/60">
      <Link
        href={`/ngo/manage?need=${need.id}`}
        className="hidden shrink-0 sm:block"
        tabIndex={-1}
        aria-hidden="true"
      >
        <CoverImage src={need.presentation?.coverImage} label={tUi('coverPhoto')} className="h-20 w-28" />
      </Link>
      <div className="min-w-0 flex-1 space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Link
            href={`/needs/${need.id}`}
            className="font-semibold text-slate-900 underline-offset-2 hover:text-teal-800 hover:underline"
          >
            <span aria-hidden="true">{categoryIcon(need.categoryLabel)} </span>
            {t('needLabel', { id: need.id, category: need.categoryLabel })}
            <span className="ml-1 font-normal text-slate-500">· {need.regionLabel}</span>
          </Link>
          <div className="flex flex-wrap items-center gap-1.5">
            {long ? (
              <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-900">
                {t('long', { months: monthsOf(waitingWindow(need, now)) })}
              </span>
            ) : null}
            <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${OPT_IN_TONES[state]}`}>
              {t(`optIn.${state}`)}
            </span>
            <NeedStatusBadge status={need.status} />
          </div>
        </div>
        <ProgressBar value={share} label={t('progressLabel', { id: need.id })} />
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-xs text-slate-700">
          <span className="tabular-nums">
            {t('raisedOf', {
              raised: amount(need.totalDonated),
              target: amount(need.targetAmount),
              unit,
              share,
            })}
          </span>
          <span>
            {before ? t('fundingCloses') : t('deliverBy')}{' '}
            <Deadline
              seconds={before ? need.fundingDeadline : need.executionDeadline}
              none={t('noDeadline')}
            />
          </span>
          <Link href={`/ngo/manage?need=${need.id}`} className="btn-secondary px-3 py-1 text-xs">
            {t('manageLink')}
          </Link>
        </div>
      </div>
    </li>
  )
}

interface VenuesPayload {
  vaults: YieldVenueOption[]
  fetchedAt: number
}

const fetchVenues = async (): Promise<VenuesPayload> => {
  const response = await fetch('/api/yield-venues', { headers: { accept: 'application/json' } })
  if (!response.ok) throw new Error(String(response.status))
  return (await response.json()) as VenuesPayload
}

function LongCampaignVenues({ campaigns, now }: { campaigns: NeedSummary[]; now: number }) {
  const t = useTranslations('campaigns')
  const tCommon = useTranslations('common')
  const locale = useLocale()
  const unit = tCommon('amountUnit')
  const [selected, setSelected] = useState(campaigns[0]?.id ?? '')
  const campaign = campaigns.find((need) => need.id === selected) ?? campaigns[0]

  const registry = deployment?.contracts.NeedsRegistry as Address | undefined
  const { data: approved } = useReadContract({
    address: registry,
    abi: needsRegistryAbi,
    functionName: 'yieldVenue',
    query: { enabled: Boolean(registry) },
  })
  const { data: capBps } = useReadContract({
    address: registry,
    abi: needsRegistryAbi,
    functionName: 'yieldCapBps',
    query: { enabled: Boolean(registry) },
  })
  const venues = useQuery({ queryKey: ['yield-venues'], queryFn: fetchVenues, staleTime: 5 * 60_000 })
  const detail = useQuery({
    queryKey: ['ngo-campaign', campaign?.id],
    queryFn: () => getNeed(campaign?.id ?? ''),
    enabled: Boolean(campaign),
  })

  if (!campaign) return null

  const tranches = detail.data?.ok ? detail.data.data.tranches : null
  const cap = Number(capBps ?? 0)
  const waiting = tranches ? waitingCapital(campaign, tranches, cap, now) : null
  const venueApproved = approved !== undefined && approved !== zeroAddress
  const approvedListed = venues.data?.vaults.find(
    (vault) => approved && isAddressEqual(vault.address, approved),
  )
  const usd = new Intl.NumberFormat(locale, { style: 'currency', currency: 'USD', notation: 'compact' })
  const rate = (value: number) => `${(value * 100).toFixed(2)}%`

  return (
    <section className="space-y-3 border-t border-slate-200 pt-4" aria-labelledby="long-venues">
      <div>
        <h3 id="long-venues" className="text-base font-semibold">
          {t('venuesTitle')}
        </h3>
        <p className="mt-1 text-sm text-slate-700">{t('venuesBody')}</p>
      </div>

      <div className="rounded-md border border-slate-200 bg-slate-50 p-3 text-sm">
        {venueApproved ? (
          <p>
            {t('approvedVenue')} <ExplorerLink kind="address" value={approved} />{' '}
            {approvedListed
              ? `(${approvedListed.name})`
              : chainId !== BASE_MAINNET_CHAIN_ID
                ? t('approvedIsTest')
                : null}
            {cap > 0 ? ` · ${t('capNote', { cap: bpsPercent(cap) })}` : null}
          </p>
        ) : (
          <p>{t('noVenue')}</p>
        )}
      </div>

      {campaigns.length > 1 ? (
        <SelectField
          label={t('campaignPicker')}
          value={campaign.id}
          onChange={setSelected}
          options={campaigns.map((need) => need.id)}
          labelOf={(id) =>
            t('needLabel', { id, category: campaigns.find((need) => need.id === id)?.categoryLabel ?? '' })
          }
        />
      ) : null}

      <p className="text-sm">
        {waiting ? (
          <>
            <span className="font-semibold">
              {t('needLabel', { id: campaign.id, category: campaign.categoryLabel })}:
            </span>{' '}
            {t(waiting.basis === 'target' ? 'couldWaitTarget' : 'couldWaitRaised', {
              amount: amount(waiting.amount),
              unit,
              months: monthsOf(waiting.seconds),
            })}{' '}
            <span className="text-slate-600">{t(`optInExplain.${optInState(campaign)}`)}</span>
          </>
        ) : (
          <span className="hint">{tCommon('loading')}</span>
        )}
      </p>

      {venues.isError ? (
        <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          {t('venuesUnavailable')}
        </p>
      ) : !venues.data ? (
        <p className="hint">{tCommon('loading')}</p>
      ) : (
        <div className="-mx-1 overflow-x-auto">
          <table className="min-w-full text-left text-sm">
            <thead className="text-xs text-slate-600">
              <tr>
                <th className="px-1 py-2 font-medium">{t('col.vault')}</th>
                <th className="px-1 py-2 font-medium">{t('col.curator')}</th>
                <th className="px-1 py-2 text-right font-medium">{t('col.apy')}</th>
                <th className="px-1 py-2 text-right font-medium">{t('col.size')}</th>
                <th className="px-1 py-2 text-right font-medium">{t('col.liquid')}</th>
                <th className="px-1 py-2 text-right font-medium">{t('col.earn', { unit })}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200">
              {venues.data.vaults.map((vault) => {
                const isApproved = Boolean(approved && isAddressEqual(vault.address, approved))
                return (
                  <tr key={vault.address} className={isApproved ? 'bg-emerald-50' : undefined}>
                    <td className="px-1 py-2">
                      <a
                        href={vault.url}
                        target="_blank"
                        rel="noreferrer"
                        className="font-medium text-teal-800 underline-offset-2 hover:underline"
                      >
                        {vault.name}
                      </a>
                      <span className="ml-1 text-xs text-slate-500">{vault.version.toUpperCase()}</span>
                      {isApproved ? (
                        <span className="ml-1 rounded-full bg-emerald-100 px-1.5 text-xs text-emerald-900">
                          {t('approvedTag')}
                        </span>
                      ) : null}
                    </td>
                    <td className="px-1 py-2 text-slate-700">{vault.curator ?? '—'}</td>
                    <td className="whitespace-nowrap px-1 py-2 text-right tabular-nums">
                      {rate(vault.netApy)}
                    </td>
                    <td className="whitespace-nowrap px-1 py-2 text-right tabular-nums">
                      {usd.format(vault.tvlUsd)}
                    </td>
                    <td className="whitespace-nowrap px-1 py-2 text-right tabular-nums">
                      {usd.format(vault.liquidityUsd)}
                    </td>
                    <td className="whitespace-nowrap px-1 py-2 text-right font-medium tabular-nums text-emerald-800">
                      {waiting ? amount(earningsUpTo(waiting, vault.netApy)) : '—'}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      <p className="hint">
        {t('venuesFootnote', {
          time: venues.data ? new Date(venues.data.fetchedAt).toLocaleTimeString(locale) : '—',
        })}
        {chainId !== BASE_MAINNET_CHAIN_ID ? ` ${t('venuesTestnet')}` : ''}
      </p>
    </section>
  )
}
