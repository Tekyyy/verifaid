'use client'

import type { DeliveryView, NeedSummary } from '@poa/shared'
import { easAbi, needsRegistryAbi } from '@poa/shared'
import { useTranslations } from 'next-intl'
import { useState } from 'react'
import { type Address, type Hex, keccak256, toHex } from 'viem'
import { useReadContract } from 'wagmi'
import { Deadline } from '@/components/Deadline'
import { FormError, TextField } from '@/components/form'
import { EmptyState, MissingDeployment } from '@/components/Notice'
import { ApprovePayeeChangePanel } from '@/components/PayeeChangePanel'
import { TxStatus } from '@/components/TxStatus'
import { Link } from '@/i18n/navigation'
import { deployment } from '@/lib/config'
import { attestationRequest, schemaRecipient } from '@/lib/eas'
import { amount, bpsPercent, shorten } from '@/lib/format'
import { useTx } from '@/lib/hooks'
import { dossierViewUrl } from '@/lib/services'

const ZERO_BYTES32 = `0x${'00'.repeat(32)}` as Hex
const hashOf = (text: string): Hex => (text ? keccak256(toHex(text)) : ZERO_BYTES32)

/**
 * What a verifier signs: that a need is real, before it may raise a cent, a supplier change on a need, and — on the
 * needs whose release rule gives verifiers a say — the NGO's account of how a tranche was spent. That last vote
 * happens on the need's own page, next to the evidence; this lists where it is waiting.
 */
export function VerifierQueue({ needs, evidence }: { needs: NeedSummary[]; evidence: DeliveryView[] }) {
  const t = useTranslations('verifier')

  if (!deployment) return <MissingDeployment />

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

      <section aria-labelledby="evidence-queue" className="space-y-3">
        <h2 id="evidence-queue" className="section-title">
          {t('evidenceQueue')}
        </h2>
        <p className="text-sm text-slate-700">{t('evidenceQueueNote')}</p>
        {evidence.length === 0 ? (
          <EmptyState title={t('emptyEvidence')} />
        ) : (
          <ul className="space-y-2">
            {evidence.map((delivery) => (
              <li key={delivery.id} className="card flex flex-wrap items-center justify-between gap-2">
                <span className="text-sm">
                  {t('evidenceRow', { need: delivery.needId, spent: delivery.trancheIndex - 1 })}
                </span>
                <Link className="btn-secondary text-sm" href={`/needs/${delivery.needId}#review`}>
                  {t('evidenceOpen')}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <ApprovePayeeChangePanel />
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
