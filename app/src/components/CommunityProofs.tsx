import type { NeedDetail } from '@poa/shared'
import { useTranslations } from 'next-intl'
import { EvidenceFiles } from '@/components/DeliveryCard'
import { ExplorerLink } from '@/components/ExplorerLink'
import { SubmitCommunityProof } from '@/components/SubmitCommunityProof'
import { isPaying, openBountyOf, rewardsLeft } from '@/lib/community'
import { deployment } from '@/lib/config'
import { amount, timestamp } from '@/lib/format'

/** Proofs listed before the rest fold away: a page someone flooded from many wallets still reads. */
const SHOWN_PROOFS = 10

/**
 * Proof about a need from people who do not run it, on the need's public page: the reward on offer, if any, the
 * form to file proof, and every proof filed — paid for or not, because the NGO chooses what to reward, never what
 * donors get to see.
 */
export function CommunityProofs({ need }: { need: NeedDetail }) {
  const t = useTranslations('community')
  const tCommon = useTranslations('common')
  if (!deployment?.contracts.CommunityProofs) return null

  const unit = tCommon('amountUnit')
  const now = Math.floor(Date.now() / 1000)
  const bounty = openBountyOf(need.bounties)
  const paying = isPaying(bounty, now) ? bounty : null
  const rewardText = paying ? `${amount(paying.reward)} ${unit}` : null

  return (
    <section id="community" className="card space-y-4" aria-labelledby="community-title">
      <div>
        <h2 id="community-title" className="section-title">
          {t('title')}
        </h2>
        <p className="mt-1 text-sm text-slate-700">{t('intro')}</p>
      </div>

      {paying ? (
        <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          <span aria-hidden="true">🎁 </span>
          {t('bountyOpen', {
            reward: amount(paying.reward),
            unit,
            left: rewardsLeft(paying),
            max: paying.maxRewards,
            date: timestamp(paying.deadline),
          })}
        </p>
      ) : null}

      <SubmitCommunityProof
        needId={need.id}
        status={need.status}
        ngo={need.ngo}
        beneficiary={need.beneficiary}
        rewardText={rewardText}
      />

      {need.communityProofs.length === 0 ? (
        <p className="text-sm text-slate-600">{t('empty')}</p>
      ) : (
        <>
          <ProofList proofs={shownFirst(need.communityProofs).slice(0, SHOWN_PROOFS)} />
          {need.communityProofs.length > SHOWN_PROOFS ? (
            <details>
              <summary className="cursor-pointer text-sm font-medium text-teal-800">
                {t('showMore', { count: need.communityProofs.length - SHOWN_PROOFS })}
              </summary>
              <div className="mt-3">
                <ProofList proofs={shownFirst(need.communityProofs).slice(SHOWN_PROOFS)} />
              </div>
            </details>
          ) : null}
        </>
      )}
    </section>
  )
}

/** Rewarded proof first — the NGO found it useful — then the newest; the rest keep their order. */
const shownFirst = (proofs: NeedDetail['communityProofs']) =>
  [...proofs].sort(
    (a, b) => Number(Boolean(b.reward)) - Number(Boolean(a.reward)) || b.submittedAt - a.submittedAt,
  )

function ProofList({ proofs }: { proofs: NeedDetail['communityProofs'] }) {
  const t = useTranslations('community')
  const tCommon = useTranslations('common')
  const unit = tCommon('amountUnit')
  return (
    <ul className="space-y-3">
      {proofs.map((proof) => (
        <li key={proof.id} className="rounded-md border border-slate-200 bg-white p-4">
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-600">
            <span className="flex flex-wrap items-center gap-1">
              {t('filedBy')} <ExplorerLink kind="address" value={proof.submitter} /> ·{' '}
              {timestamp(proof.submittedAt)}
            </span>
            {proof.reward ? (
              <span className="chip bg-emerald-100 text-emerald-900">
                {t('rewarded', { amount: amount(proof.reward.amount), unit })}
              </span>
            ) : null}
          </div>
          {proof.manifest ? (
            <>
              {proof.manifest.note ? (
                <p className="mt-2 whitespace-pre-line text-sm text-slate-800">{proof.manifest.note}</p>
              ) : null}
              <EvidenceFiles files={proof.manifest.files} />
            </>
          ) : (
            <p className="mt-2 text-xs text-amber-800">{t('unreadable')}</p>
          )}
          <p className="mt-2 text-xs text-slate-500">
            <ExplorerLink kind="tx" value={proof.txHash} />
          </p>
        </li>
      ))}
    </ul>
  )
}
