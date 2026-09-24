import { getLocale, getTranslations } from 'next-intl/server'
import { Suspense } from 'react'
import { NewsThumb } from '@/components/NewsThumb'
import { categoryIcon } from '@/lib/format'
import type { NewsArticle } from '@/lib/news'
import { findNeedNews, type NewsTopic } from '@/lib/server/news'

const TOPICS = new Set(['WATER', 'FOOD', 'SHELTER', 'MEDICAL', 'CASH', 'EDUCATION'])

/**
 * Recent news about the problem a need addresses, found by searching for its category and region. The heading is
 * drawn at once; the articles stream in when the search is done, so a slow news site never holds up the page.
 */
export async function NeedNews({ topic }: { topic: NewsTopic }) {
  const t = await getTranslations('news')
  const subject = t(`topic.${TOPICS.has(topic.category) ? topic.category : 'other'}`)

  return (
    <section id="news" className="card space-y-4" aria-labelledby="news-title">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 id="news-title" className="section-title">
            {t('title')}
          </h2>
          <p className="mt-1 text-sm text-slate-700">
            {t('subtitle', { topic: subject, place: topic.place })}
          </p>
        </div>
        <a
          href={topic.moreUrl}
          target="_blank"
          rel="noopener noreferrer nofollow"
          className="btn-secondary text-sm"
        >
          {t('more')} <span aria-hidden="true">↗</span>
          <span className="sr-only"> {t('newTab')}</span>
        </a>
      </div>

      <Suspense fallback={<NewsSkeleton label={t('loading')} />}>
        <NewsList topic={topic} subject={subject} />
      </Suspense>

      <p className="hint">{t('disclaimer')}</p>
    </section>
  )
}

async function NewsList({ topic, subject }: { topic: NewsTopic; subject: string }) {
  const t = await getTranslations('news')
  const locale = await getLocale()
  const news = await findNeedNews(topic)

  if (!news?.searched) return <p className="text-sm text-slate-600">{t('unavailable')}</p>
  if (news.articles.length === 0) {
    return <p className="text-sm text-slate-600">{t('empty', { topic: subject, place: topic.place })}</p>
  }

  const date = new Intl.DateTimeFormat(locale, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  })
  const icon = categoryIcon(topic.category)
  return (
    <ul className="space-y-3">
      {news.articles.map((article) => (
        <ArticleRow
          key={article.url}
          article={article}
          icon={icon}
          date={article.publishedAt ? date.format(new Date(article.publishedAt)) : null}
          languageNote={article.language === locale ? null : t(`language.${article.language}`)}
          newTab={t('newTab')}
        />
      ))}
    </ul>
  )
}

function ArticleRow({
  article,
  icon,
  date,
  languageNote,
  newTab,
}: {
  article: NewsArticle
  icon: string
  date: string | null
  languageNote: string | null
  newTab: string
}) {
  return (
    <li>
      <a
        href={article.url}
        target="_blank"
        rel="noopener noreferrer nofollow"
        className="group flex gap-3 rounded-xl border border-slate-200 bg-white p-3 no-underline transition hover:border-teal-300 hover:shadow-sm sm:gap-4"
      >
        <NewsThumb src={article.image} icon={icon} />
        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-slate-500">
            <span className="font-semibold text-slate-700">{article.source}</span>
            {date ? (
              <>
                <span aria-hidden="true">·</span>
                <time dateTime={article.publishedAt ?? undefined}>{date}</time>
              </>
            ) : null}
            {languageNote ? <span className="chip px-2 py-0 text-[11px]">{languageNote}</span> : null}
          </span>
          <span className="line-clamp-3 font-semibold leading-snug text-slate-900 group-hover:text-teal-800 group-hover:underline sm:line-clamp-2">
            {article.title}
          </span>
          {article.snippet ? (
            <span className="line-clamp-2 text-sm text-slate-600">{article.snippet}</span>
          ) : null}
        </span>
        <span
          aria-hidden="true"
          className="hidden self-start text-slate-400 group-hover:text-teal-700 sm:inline"
        >
          ↗
        </span>
        <span className="sr-only">{newTab}</span>
      </a>
    </li>
  )
}

function NewsSkeleton({ label }: { label: string }) {
  return (
    <div role="status" aria-live="polite">
      <span className="sr-only">{label}</span>
      <ul className="space-y-3" aria-hidden="true">
        {[0, 1, 2].map((row) => (
          <li key={row} className="flex gap-3 rounded-xl border border-slate-200 bg-white p-3 sm:gap-4">
            <span className="h-16 w-16 shrink-0 animate-pulse rounded-lg bg-slate-100 sm:h-24 sm:w-36" />
            <span className="flex flex-1 flex-col gap-2 py-1">
              <span className="h-3 w-24 animate-pulse rounded bg-slate-100" />
              <span className="h-4 w-full animate-pulse rounded bg-slate-100" />
              <span className="h-4 w-2/3 animate-pulse rounded bg-slate-100" />
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}
