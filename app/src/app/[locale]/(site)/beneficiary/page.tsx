import type { Metadata } from 'next'
import { getTranslations } from 'next-intl/server'
import { Suspense } from 'react'
import { ImagePlaceholder } from '@/components/ImagePlaceholder'
import { NgoNeedDashboard } from '@/components/NgoNeedDashboard'
import { MissingDeployment } from '@/components/Notice'
import { Link } from '@/i18n/navigation'
import { deployment } from '@/lib/config'

export async function generateMetadata(props: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const params = await props.params

  const { locale } = params

  const t = await getTranslations({ locale, namespace: 'beneficiary' })
  return { title: t('title') }
}

/** A certified beneficiary's own needs: the same workspace an NGO has for one need, for the ones they posted. */
export default async function BeneficiaryPage() {
  const t = await getTranslations('beneficiary')
  const tUi = await getTranslations('ui')

  return (
    <div className="space-y-6">
      <header className="card flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-4">
          <ImagePlaceholder label={tUi('profilePhoto')} shape="circle" className="h-14 w-14 shrink-0" />
          <div>
            <p className="eyebrow">{t('eyebrow')}</p>
            <h1 className="text-2xl font-bold tracking-tight">{t('title')}</h1>
            <p className="mt-1 text-sm text-slate-700">{t('subtitle')}</p>
          </div>
        </div>
        <Link href="/apply" className="btn-primary">
          {t('applyButton')}
        </Link>
      </header>
      {/* The dashboard reads the chosen need from the URL, which Next renders inside a Suspense boundary. */}
      {deployment ? (
        <Suspense>
          <NgoNeedDashboard audience="beneficiary" />
        </Suspense>
      ) : (
        <MissingDeployment />
      )}
    </div>
  )
}
