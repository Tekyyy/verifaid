/**
 * Recent news about the problem a need addresses, for its public page: a search of news feeds for the need's
 * category and coarse region, and the preview each article page publishes about itself (its Open Graph image and
 * summary). Context for a donor, never evidence: nothing here is signed, checked or written on chain.
 *
 * The server fetches article pages whose addresses come from a third-party feed, so every hop is checked to be on
 * the public internet (no loopback, private network or cloud metadata address), bodies are capped and read only as
 * far as the page head, and every request has a deadline. Results are kept for a few hours: the page makes no
 * request of its own, and the same region and category share one search.
 *
 * Search feeds: Bing News and Google News RSS, which need no key. Their terms allow personal, non-commercial use;
 * a deployment beyond this project should swap in a licensed news API here.
 */
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import {
  bingNewsUrl,
  fromBing,
  fromGoogle,
  googleNewsPage,
  googleNewsUrl,
  isPublicAddress,
  type NewsArticle,
  type NewsLanguage,
  type NewsQuery,
  newsQueries,
  parseOpenGraph,
  parseRssItems,
  relevance,
  type Scored,
  selectArticles,
} from '../news.ts'

export interface NeedNews {
  articles: NewsArticle[]
  /** False when every search failed, so "nothing found" is never shown for "could not look". */
  searched: boolean
  fetchedAt: number
}

/** What a need's news section is about, known before any search: its place in the reader's language. */
export interface NewsTopic {
  category: string
  region: string
  locale: NewsLanguage
  place: string
  moreUrl: string
}

type Resolve = (host: string) => Promise<string[]>

export interface NewsDeps {
  fetchImpl?: typeof fetch
  resolve?: Resolve
  now?: () => number
  env?: Record<string, string | undefined>
}

const USER_AGENT = 'Mozilla/5.0 (compatible; VerifAidNews/1.0; news previews for aid needs)'
const SEARCH_TIMEOUT_MS = 6_000
const PAGE_TIMEOUT_MS = 4_000
const MAX_FEED_BYTES = 1_000_000
const MAX_PAGE_BYTES = 512_000
const MAX_REDIRECTS = 3
/** Bing's boolean operators are unreliable, so it gets one search per keyword. */
const BING_KEYWORDS = 3
const TTL_MS = 3 * 60 * 60_000
const FAILED_TTL_MS = 10 * 60_000
const MAX_ENTRIES = 300

/** On unless `NEWS_SEARCH=off`: a deployment without outbound internet, or that does not want it, turns it off. */
export const newsEnabled = (env: Record<string, string | undefined> = process.env): boolean =>
  env.NEWS_SEARCH?.trim().toLowerCase() !== 'off'

export const newsTopic = (
  category: string,
  region: string,
  locale: NewsLanguage,
  env: Record<string, string | undefined> = process.env,
): NewsTopic | null => {
  if (!newsEnabled(env)) return null
  const queries = newsQueries(category, region, locale)
  const reader = queries.find((query) => query.language === locale)
  if (!reader || !queries[0]) return null
  // The richest coverage is in the place's own language, which is where "more" sends the reader.
  return { category, region, locale, place: reader.place, moreUrl: googleNewsPage(queries[0]) }
}

// ── the cache ────────────────────────────────────────────────────────────────────────────────────────────────────

interface Entry<T> {
  value: Promise<T>
  expires: number
}

const searches = new Map<string, Entry<{ scored: Scored[]; ok: boolean }>>()
const previews = new Map<string, Entry<Partial<NewsArticle>>>()

/** One promise per key, shared by concurrent readers; a failure is remembered briefly, so a dead feed is not hammered. */
const remember = <T>(
  store: Map<string, Entry<T>>,
  key: string,
  now: number,
  make: () => Promise<T>,
  failed: (value: T) => boolean,
): Promise<T> => {
  const hit = store.get(key)
  if (hit && hit.expires > now) return hit.value
  const entry: Entry<T> = { value: make(), expires: now + TTL_MS }
  entry.value.then(
    (value) => {
      if (failed(value)) entry.expires = now + FAILED_TTL_MS
    },
    () => {
      entry.expires = now + FAILED_TTL_MS
    },
  )
  store.delete(key)
  store.set(key, entry)
  for (const oldest of store.keys()) {
    if (store.size <= MAX_ENTRIES) break
    store.delete(oldest)
  }
  return entry.value
}

export const resetNewsCache = () => {
  searches.clear()
  previews.clear()
}

// ── fetching ─────────────────────────────────────────────────────────────────────────────────────────────────────

const charsetOf = (contentType: string | null, head: string): string => {
  const declared =
    contentType?.match(/charset=["']?([\w-]+)/i)?.[1] ?? head.match(/<meta[^>]+charset=["']?([\w-]+)/i)?.[1]
  return declared?.toLowerCase() ?? 'utf-8'
}

/** At most `max` bytes of a body, stopping early once `until` shows up (the end of an HTML head, say). */
const readCapped = async (response: Response, max: number, until?: RegExp): Promise<string> => {
  const reader = response.body?.getReader()
  if (!reader) return ''
  const chunks: Uint8Array[] = []
  const ascii = new TextDecoder('latin1')
  let size = 0
  let tail = ''
  try {
    while (size < max) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
      size += value.byteLength
      // Markup is ASCII in any of the encodings news sites use, so a byte-for-byte view is enough to spot it.
      tail = (tail + ascii.decode(value)).slice(-4_096)
      if (until?.test(tail)) break
    }
  } finally {
    reader.cancel().catch(() => {})
  }
  const bytes = new Uint8Array(Math.min(size, max))
  let offset = 0
  for (const chunk of chunks) {
    const part = chunk.subarray(0, bytes.length - offset)
    bytes.set(part, offset)
    offset += part.length
    if (offset >= bytes.length) break
  }
  const charset = charsetOf(response.headers.get('content-type'), ascii.decode(bytes.subarray(0, 2_048)))
  try {
    return new TextDecoder(charset).decode(bytes)
  } catch {
    return new TextDecoder('utf-8').decode(bytes)
  }
}

const defaultResolve: Resolve = async (host) =>
  (await lookup(host, { all: true, verbatim: true })).map((entry) => entry.address)

const BLOCKED_HOSTS = /(^|\.)(localhost|local|internal|home\.arpa)$/i

/** The address, if it is a web page on the public internet on a standard port; null for anything else. */
export const publicTarget = async (
  raw: string,
  resolve: Resolve = defaultResolve,
): Promise<string | null> => {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
  if (url.username || url.password) return null
  if (url.port && url.port !== '80' && url.port !== '443') return null
  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (!host || BLOCKED_HOSTS.test(host)) return null
  const addresses = isIP(host) ? [host] : await resolve(host).catch(() => [])
  if (addresses.length === 0 || !addresses.every(isPublicAddress)) return null
  return url.toString()
}

/**
 * An article page's head, following redirects by hand so that each hop is checked. A name that resolves to a
 * public address when checked and a private one when fetched (DNS rebinding) is the case this does not close.
 */
export const fetchArticleHead = async (
  address: string,
  { fetchImpl = fetch, resolve = defaultResolve }: NewsDeps = {},
): Promise<{ url: string; html: string } | null> => {
  let current = address
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const target = await publicTarget(current, resolve)
    if (!target) return null
    const response = await fetchImpl(target, {
      redirect: 'manual',
      headers: { 'user-agent': USER_AGENT, accept: 'text/html,application/xhtml+xml' },
      cache: 'no-store',
      signal: AbortSignal.timeout(PAGE_TIMEOUT_MS),
    })
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location')
      await response.body?.cancel().catch(() => {})
      if (!location) return null
      current = new URL(location, target).toString()
      continue
    }
    const type = response.headers.get('content-type') ?? ''
    if (!response.ok || !/text\/html|application\/xhtml\+xml/i.test(type)) {
      await response.body?.cancel().catch(() => {})
      return null
    }
    return { url: target, html: await readCapped(response, MAX_PAGE_BYTES, /<\/head\s*>/i) }
  }
  return null
}

const fetchFeed = async (url: string, fetchImpl: typeof fetch): Promise<string> => {
  const response = await fetchImpl(url, {
    headers: {
      'user-agent': USER_AGENT,
      accept: 'application/rss+xml, application/xml;q=0.9, text/xml;q=0.8',
    },
    cache: 'no-store',
    signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
  })
  if (!response.ok) {
    await response.body?.cancel().catch(() => {})
    throw new Error(`${new URL(url).hostname} answered ${response.status}`)
  }
  return readCapped(response, MAX_FEED_BYTES)
}

/** One query against both engines. It never throws: a feed that fails just contributes nothing. */
const search = async (
  query: NewsQuery,
  fetchImpl: typeof fetch,
): Promise<{ scored: Scored[]; ok: boolean }> => {
  const bing = query.keywords
    .slice(0, BING_KEYWORDS)
    .map(async (keyword) =>
      parseRssItems(await fetchFeed(bingNewsUrl(query, keyword), fetchImpl)).map((item) =>
        fromBing(item, query.language),
      ),
    )
  const google = (async () =>
    parseRssItems(await fetchFeed(googleNewsUrl(query), fetchImpl)).map((item) =>
      fromGoogle(item, query.language),
    ))()
  const results = await Promise.allSettled([...bing, google])
  const articles = results
    .flatMap((result) => (result.status === 'fulfilled' ? result.value : []))
    .filter((article): article is NewsArticle => article !== null)
  return {
    ok: results.some((result) => result.status === 'fulfilled'),
    scored: articles.map((article) => ({ article, score: relevance(article, query) })),
  }
}

/** The image and summary an article page gives for itself. Google results link to Google, so they have none. */
const preview = async (article: NewsArticle, deps: NewsDeps): Promise<Partial<NewsArticle>> => {
  if (article.via !== 'bing') return {}
  try {
    const page = await fetchArticleHead(article.url, deps)
    if (!page) return {}
    const found = parseOpenGraph(page.html, page.url)
    return {
      image: found.image,
      // A page's own summary reads better than the search engine's cut of its first paragraph.
      snippet: found.description ?? article.snippet,
    }
  } catch {
    return {}
  }
}

/** The articles for a need's page, best first; null when news is off or the region cannot be searched for. */
export const findNeedNews = async (
  { category, region, locale }: { category: string; region: string; locale: NewsLanguage },
  deps: NewsDeps = {},
): Promise<NeedNews | null> => {
  const env = deps.env ?? process.env
  if (!newsEnabled(env)) return null
  const queries = newsQueries(category, region, locale)
  if (queries.length === 0) return null
  const fetchImpl = deps.fetchImpl ?? fetch
  const now = deps.now?.() ?? Date.now()

  const results = await Promise.all(
    queries.map((query) =>
      remember(
        searches,
        [category, query.language, query.country, query.place].join('|').toLowerCase(),
        now,
        () => search(query, fetchImpl),
        (result) => !result.ok,
      ),
    ),
  )
  const chosen = selectArticles(
    results.flatMap((result) => result.scored),
    now,
  )
  const details = await Promise.all(
    chosen.map((article) =>
      remember(
        previews,
        article.url,
        now,
        () => preview(article, deps),
        (found) => !found.image && !found.snippet,
      ),
    ),
  )
  return {
    articles: chosen.map((article, index) => ({ ...article, ...details[index] })),
    searched: results.some((result) => result.ok),
    fetchedAt: now,
  }
}
