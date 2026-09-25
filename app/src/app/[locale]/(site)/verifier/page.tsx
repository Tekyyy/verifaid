import type { Metadata } from 'next'
import { getTranslations } from 'next-intl/server'
import { IndexerNotice } from '@/components/Notice'
import { VerifierQueue } from '@/components/VerifierQueue'
import { getDeliveries, getNeeds } from '@/lib/indexer'

export const dynamic = 'force-dynamic'

export async function generateMetadata(props: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const params = await props.params

  const { locale } = params

  const t = await getTranslations({ locale, namespace: 'verifier' })
  return { title: t('title') }
}

export default async function VerifierPage() {
  const t = await getTranslations('verifier')
  const [needs, inDelivery, open] = await Promise.all([
    getNeeds({ status: 'Pending' }),
    getNeeds({ status: 'InDelivery' }),
    getDeliveries('Open'),
  ])
  // Evidence a verifier has a say on: open deliveries of needs whose release rule includes verifiers.
  const judged = new Map(
    (inDelivery.ok ? inDelivery.data : [])
      .filter((need) => need.releasePolicy.verifiers)
      .map((need) => [need.id, need]),
  )
  const evidence = (open.ok ? open.data : []).filter((delivery) => judged.has(delivery.needId))

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-bold tracking-tight">{t('title')}</h1>
        <p className="mt-1 text-sm text-slate-700">{t('subtitle')}</p>
      </header>

      {!needs.ok ? <IndexerNotice error={needs.error} /> : null}

      <VerifierQueue needs={needs.ok ? needs.data : []} evidence={evidence} />
    </div>
  )
}
