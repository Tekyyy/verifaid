'use client'

import type { DeliveryView, NeedSummary } from '@poa/shared'
import { deliveryManagerAbi, easAbi, needsRegistryAbi } from '@poa/shared'
import { useTranslations } from 'next-intl'
import { useState } from 'react'
import { type Address, type Hex, keccak256, toHex } from 'viem'
import { useReadContract } from 'wagmi'
import { CustodyBadge } from '@/components/CustodyBadge'
import { Deadline } from '@/components/Deadline'
import { FormError, TextField } from '@/components/form'
import { EmptyState, MissingDeployment } from '@/components/Notice'
import { DeliveryStatusBadge } from '@/components/StatusBadge'
import { TxStatus } from '@/components/TxStatus'
import { Link } from '@/i18n/navigation'
import { deployment } from '@/lib/config'
import { attestationRequest, schemaRecipient } from '@/lib/eas'
import { amount, bpsPercent, shorten } from '@/lib/format'
import { useTx } from '@/lib/hooks'
import { isZeroUid } from '@/lib/links'
import { dossierViewUrl, evidenceViewUrl } from '@/lib/services'

const ZERO_BYTES32 = `0x${'00'.repeat(32)}` as Hex
const hashOf = (text: string): Hex => (text ? keccak256(toHex(text)) : ZERO_BYTES32)

export function VerifierQueue({ needs, deliveries }: { needs: NeedSummary[]; deliveries: DeliveryView[] }) {
  const t = useTranslations('verifier')

  if (!deployment) return <MissingDeployment />

  const signable = deliveries.filter((d) => d.status === 'Open' && !isZeroUid(d.evidenceUID))
  const challengeable = deliveries.filter((d) => d.status === 'Challengeable')

  return (
    <div className="space-y-8">
      <section aria-labelledby="needs-queue" className="space-y-3">
        <h2 id="needs-queue" className="section-title">
          {t('needsQueue')}
        </h2>
        {needs.length === 0 ? (
          <EmptyState title={t('emptyNeeds')} />
        ) : (
          needs.map((need) => <NeedRow key={need.id} need={need} />)
        )}
      </section>

      <section aria-labelledby="deliveries-queue" className="space-y-3">
        <h2 id="deliveries-queue" className="section-title">
          {t('deliveriesQueue')}
        </h2>
        {signable.length === 0 ? (
          <EmptyState title={t('emptyDeliveries')} />
        ) : (
          signable.map((delivery) => <DeliveryRow key={delivery.id} delivery={delivery} />)
        )}
      </section>

      <section aria-labelledby="challenge" className="space-y-3">
        <h2 id="challenge" className="section-title">
          {t('challengeTitle')}
        </h2>
        <p className="text-sm text-slate-700">{t('challengeBody')}</p>
        {challengeable.length === 0 ? (
          <EmptyState title={t('emptyDeliveries')} />
        ) : (
          challengeable.map((delivery) => <ChallengeRow key={delivery.id} delivery={delivery} />)
        )}
      </section>
    </div>
  )
}

function NeedRow({ need }: { need: NeedSummary }) {
  const t = useTranslations('verifier')
  const tNeed = useTranslations('need')
  const tCommon = useTranslations('common')
  const tx = useTx()
  const [report, setReport] = useState('')

  // The resolver checks the attested dossier hash against the registry, so read it from the chain.
  const { data: dossierHash } = useReadContract({
    address: deployment?.contracts.NeedsRegistry as Address,
    abi: needsRegistryAbi,
    functionName: 'dossierHashOf',
    args: [BigInt(need.id)],
  })

  // Verification reverts once a deadline has passed (the need can only expire then).
  const now = Math.floor(Date.now() / 1000)
  const deadlinePassed = [need.fundingDeadline, need.executionDeadline].some(
    (deadline) => deadline && deadline <= now,
  )

  const attest = (approved: boolean) =>
    tx.run({
      address: deployment?.external.EAS as Address,
      abi: easAbi,
      functionName: 'attest',
      args: [
        attestationRequest({
          name: 'NeedVerified',
          recipient: schemaRecipient('NeedVerified') as Address,
          values: [BigInt(need.id), (dossierHash as Hex) ?? ZERO_BYTES32, approved, hashOf(report)],
        }),
      ],
    })

  return (
    <article className="card space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="font-semibold">
          <Link className="link" href={`/needs/${need.id}`}>
            {tNeed('title', { id: need.id })}
          </Link>
        </h3>
        <span className="text-xs text-slate-600">
          {need.categoryLabel} · {need.regionLabel} · {amount(need.targetAmount)} {tCommon('amountUnit')}
        </span>
      </div>

      <NeedTerms need={need} />
      {deadlinePassed ? <FormError message={t('deadlinePassed')} /> : null}

      <p className="text-xs">
        <a
          className="link"
          href={dossierViewUrl((dossierHash as string) ?? '')}
          target="_blank"
          rel="noreferrer noopener"
        >
          {t('openDossier')}
        </a>{' '}
        <span className="mono">{dossierHash ? shorten(dossierHash as string, 10, 6) : '—'}</span>
      </p>

      <TextField label={t('reportHash')} value={report} onChange={setReport} placeholder="…" />

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className="btn-primary"
          disabled={!dossierHash || tx.phase === 'signing' || tx.phase === 'pending'}
          onClick={() => attest(true)}
        >
          {t('approve')}
        </button>
        <button
          type="button"
          className="btn-danger"
          disabled={!dossierHash || tx.phase === 'signing' || tx.phase === 'pending'}
          onClick={() => attest(false)}
        >
          {t('reject')}
        </button>
      </div>
      <p className="text-xs text-amber-800">{t('rejectWarning')}</p>
      <TxStatus state={tx} />
    </article>
  )
}

/** Verifiers attest the terms as much as the need: custody, deadlines, the funding threshold and the cost cap. */
function NeedTerms({ need }: { need: NeedSummary }) {
  const tTerms = useTranslations('terms')
  return (
    <dl className="grid gap-x-4 gap-y-1 text-xs sm:grid-cols-2">
      <div className="flex flex-wrap items-center gap-1 sm:col-span-2">
        <dt className="sr-only">{tTerms('custody')}</dt>
        <dd>
          <CustodyBadge mode={need.custodyMode} />
        </dd>
        {need.custodian ? (
          <dd className="font-mono text-slate-700" title={need.custodian}>
            {shorten(need.custodian)}
          </dd>
        ) : null}
      </div>
      <div className="flex flex-wrap gap-1">
        <dt className="text-slate-600">{tTerms('fundingDeadline')}</dt>
        <dd>
          <Deadline seconds={need.fundingDeadline} none={tTerms('openEnded')} />
        </dd>
      </div>
      <div className="flex flex-wrap gap-1">
        <dt className="text-slate-600">{tTerms('executionDeadline')}</dt>
        <dd>
          <Deadline seconds={need.executionDeadline} none={tTerms('noDeadline')} />
        </dd>
      </div>
      <div className="flex flex-wrap gap-1">
        <dt className="text-slate-600">{tTerms('minFunding')}</dt>
        <dd className="text-slate-800">{bpsPercent(need.minFundingBps)}%</dd>
      </div>
      <div className="flex flex-wrap gap-1">
        <dt className="text-slate-600">{tTerms('costCap')}</dt>
        <dd className="text-slate-800">{bpsPercent(need.thirdPartyCostBps)}%</dd>
      </div>
    </dl>
  )
}

function DeliveryRow({ delivery }: { delivery: DeliveryView }) {
  const t = useTranslations('verifier')
  const tNeed = useTranslations('need')
  const tx = useTx()
  const [report, setReport] = useState('')

  const evidenceUid = delivery.evidenceUID

  const attest = (approved: boolean) => {
    if (isZeroUid(evidenceUid)) return
    return tx.run({
      address: deployment?.external.EAS as Address,
      abi: easAbi,
      functionName: 'attest',
      args: [
        attestationRequest({
          name: 'DeliveryVerified',
          recipient: schemaRecipient('DeliveryVerified') as Address,
          // Required by the schema resolver: the sign-off must point at the evidence it reviewed.
          refUID: evidenceUid,
          values: [BigInt(delivery.id), approved, hashOf(report)],
        }),
      ],
    })
  }

  return (
    <article className="card space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="font-semibold">{tNeed('delivery', { id: delivery.id })}</h3>
        <DeliveryStatusBadge status={delivery.status} />
      </div>

      <p className="text-xs text-slate-700">
        {tNeed('confirmationRatio', {
          confirmations: delivery.confirmations,
          expected: delivery.expectedRecipients,
          percent: Math.round(delivery.confirmationRatio * 100),
        })}
      </p>

      {delivery.evidenceCID ? (
        <p className="text-xs">
          <a
            className="link"
            href={evidenceViewUrl(delivery.evidenceCID)}
            target="_blank"
            rel="noreferrer noopener"
          >
            {t('openEvidence')}
          </a>
        </p>
      ) : null}

      {isZeroUid(evidenceUid) ? (
        <FormError message={t('noEvidence')} />
      ) : (
        <p className="text-xs text-slate-600">
          {t('refUidNote', { uid: shorten(evidenceUid as string, 10, 6) })}
        </p>
      )}

      <TextField label={t('reportHash')} value={report} onChange={setReport} placeholder="…" />

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className="btn-primary"
          disabled={isZeroUid(evidenceUid) || tx.phase === 'signing' || tx.phase === 'pending'}
          onClick={() => attest(true)}
        >
          {t('approve')}
        </button>
        <button
          type="button"
          className="btn-danger"
          disabled={isZeroUid(evidenceUid) || tx.phase === 'signing' || tx.phase === 'pending'}
          onClick={() => attest(false)}
        >
          {t('reject')}
        </button>
      </div>
      <TxStatus state={tx} />
    </article>
  )
}

function ChallengeRow({ delivery }: { delivery: DeliveryView }) {
  const t = useTranslations('verifier')
  const tNeed = useTranslations('need')
  const tx = useTx()
  const [reason, setReason] = useState('')

  return (
    <article className="card space-y-3">
      <h3 className="font-semibold">{tNeed('delivery', { id: delivery.id })}</h3>
      <TextField label={t('reasonHash')} value={reason} onChange={setReason} placeholder="…" />
      <button
        type="button"
        className="btn-danger"
        disabled={tx.phase === 'signing' || tx.phase === 'pending'}
        onClick={() =>
          tx.run({
            address: deployment?.contracts.DeliveryManager as Address,
            abi: deliveryManagerAbi,
            functionName: 'challenge',
            args: [BigInt(delivery.id), hashOf(reason)],
          })
        }
      >
        {t('challenge')}
      </button>
      <TxStatus state={tx} />
    </article>
  )
}
