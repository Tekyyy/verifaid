import { AID_RECEIVED_MESSAGE, deliveryManagerAbi, needsRegistryAbi } from '@poa/shared'
import type { Metadata } from 'next'
import { getTranslations } from 'next-intl/server'
import { ConfirmClient } from '@/components/ConfirmClient'
import { MissingDeployment, Notice } from '@/components/Notice'
import { deployment } from '@/lib/config'
import { getProgramMembers } from '@/lib/indexer'
import { publicClient } from '@/lib/server/chain'

export const dynamic = 'force-dynamic'

/** Above this the member list is fetched on demand instead of being inlined into the HTML. */
const INLINE_MEMBERS_LIMIT = 500

export async function generateMetadata({
  params,
}: {
  params: { locale: string; deliveryId: string }
}): Promise<Metadata> {
  const t = await getTranslations({ locale: params.locale, namespace: 'confirm' })
  return { title: `${t('title')} · ${t('delivery', { id: params.deliveryId })}` }
}

export default async function ConfirmPage({ params }: { params: { deliveryId: string } }) {
  const t = await getTranslations('confirm')
  const tErrors = await getTranslations('errors')
  const { deliveryId } = params

  if (!deployment) return <MissingDeployment />
  if (!/^\d+$/.test(deliveryId)) {
    return (
      <Notice tone="error" title={tErrors('notFoundTitle')}>
        {tErrors('deliveryNotFound', { id: deliveryId })}
      </Notice>
    )
  }

  // Read the delivery from the chain rather than the indexer: this page must work even when the indexer is
  // catching up, and it is the contract that decides whether a confirmation is still accepted.
  let programId: string | null = null
  let status: number | null = null
  try {
    const delivery = await publicClient.readContract({
      address: deployment.contracts.DeliveryManager,
      abi: deliveryManagerAbi,
      functionName: 'getDelivery',
      args: [BigInt(deliveryId)],
    })
    status = delivery.status
    if (delivery.needId !== 0n) {
      const program = await publicClient.readContract({
        address: deployment.contracts.NeedsRegistry,
        abi: needsRegistryAbi,
        functionName: 'programOf',
        args: [delivery.needId],
      })
      programId = program.toString()
    }
  } catch {
    programId = null
  }

  if (!programId || programId === '0') {
    return (
      <Notice tone="error" title={tErrors('notFoundTitle')}>
        {tErrors('deliveryNotFound', { id: deliveryId })}
      </Notice>
    )
  }

  const members = await getProgramMembers(programId)
  const inline =
    members.ok && members.data.members.length <= INLINE_MEMBERS_LIMIT ? members.data.members : null

  return (
    <>
      <h1 className="mt-2 text-2xl font-bold tracking-tight">{t('title')}</h1>
      <p className="mt-1 text-sm text-slate-600">{t('delivery', { id: deliveryId })}</p>
      <p className="mt-3 text-base text-slate-800">{t('lead')}</p>

      <ConfirmClient
        deliveryId={deliveryId}
        programId={programId}
        message={AID_RECEIVED_MESSAGE.toString()}
        members={inline}
        deliveryOpen={status === 0}
      />
    </>
  )
}
