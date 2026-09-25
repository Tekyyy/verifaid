import type { Metadata } from 'next'
import { getTranslations } from 'next-intl/server'
import { Suspense } from 'react'
import { ApplyForNeed } from '@/components/ApplyForNeed'
import { ImagePlaceholder } from '@/components/ImagePlaceholder'
import { MissingDeployment } from '@/components/Notice'
import { deployment } from '@/lib/config'

export async function generateMetadata(props: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const params = await props.params

  const { locale } = params

  const t = await getTranslations({ locale, namespace: 'apply' })
  // A certificate link is for its beneficiary alone: keep the page out of search results.
  return { title: t('title'), robots: { index: false, follow: false } }
}

const STEPS = ['cert', 'post', 'paid'] as const

export default async function ApplyPage() {
  const t = await getTranslations('apply')
  const tUi = await getTranslations('ui')

  return (
    <div className="space-y-6">
      <header className="card grid items-center gap-6 md:grid-cols-5">
        <div className="space-y-4 md:col-span-3">
          <div>
            <p className="eyebrow">{t('eyebrow')}</p>
            <h1 className="mt-1 text-2xl font-bold tracking-tight sm:text-3xl">{t('title')}</h1>
            <p className="mt-2 text-sm text-slate-700">{t('subtitle')}</p>
          </div>
          <ol className="grid gap-3 sm:grid-cols-3">
            {STEPS.map((step, index) => (
              <li key={step} className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                <span className="grid h-7 w-7 place-items-center rounded-full bg-teal-700 text-sm font-bold text-white">
                  {index + 1}
                </span>
                <p className="mt-2 text-sm font-semibold text-slate-900">{t(`how.${step}.title`)}</p>
                <p className="mt-0.5 text-xs text-slate-600">{t(`how.${step}.body`)}</p>
              </li>
            ))}
          </ol>
        </div>
        <ImagePlaceholder
          label={tUi('illustration')}
          hint={tUi('illustrationApplyHint')}
          className="aspect-[4/3] w-full md:col-span-2"
        />
      </header>
      {/* The certificate arrives in the URL (`?cert=…`), which Next renders inside a Suspense boundary. */}
      {deployment ? (
        <Suspense>
          <ApplyForNeed />
        </Suspense>
      ) : (
        <MissingDeployment />
      )}
    </div>
  )
}
