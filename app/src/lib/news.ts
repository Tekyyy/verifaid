/**
 * News about the problem a need addresses. What to search for is built from the need's category and its coarse
 * region only — never from anything about a person — so a search reveals nothing the chain does not already show.
 *
 * Pure functions: the queries, reading the search feeds, keeping the articles that are on topic, and reading the
 * preview an article page publishes about itself (its Open Graph tags). The fetching is in `server/news.ts`.
 */

export type NewsLanguage = 'en' | 'es'

export interface NewsArticle {
  /** The article itself, or for a Google News result Google's redirect to it. */
  url: string
  title: string
  source: string
  publishedAt: string | null
  snippet: string | null
  /** An https image the article page names as its preview. */
  image: string | null
  language: NewsLanguage
  via: 'bing' | 'google'
}

/** One search: a place and a problem, in one language, in one country's edition of the news. */
export interface NewsQuery {
  language: NewsLanguage
  country: string
  place: string
  /** Terms to search for, most specific first. */
  keywords: readonly string[]
  /** Terms an article's title or snippet must mention to count as on topic: the keywords and near variants. */
  matchTerms: readonly string[]
  /** Names that place an article there: the region in either language, its provinces and main cities. */
  placeTerms: readonly string[]
  excludeTerms: readonly string[]
}

/** Older news says little about the need in front of the donor. */
export const NEWS_WINDOW_DAYS = 365
export const NEWS_LIMIT = 6
const PER_SOURCE = 2

// ── what to search for ──────────────────────────────────────────────────────────────────────────────────────────

interface Terms {
  search: readonly string[]
  match: readonly string[]
  /** Phrases that use a keyword for something else: a hunger strike is not a food shortage. */
  exclude?: readonly string[]
}

const TOPICS: Record<string, Record<NewsLanguage, Terms>> = {
  WATER: {
    en: {
      search: ['drought', 'water shortage', 'drinking water'],
      match: ['water supply', 'water restrictions', 'reservoir'],
    },
    es: {
      search: ['sequía', 'escasez de agua', 'agua potable'],
      match: ['abastecimiento de agua', 'restricciones de agua', 'embalse'],
    },
  },
  // Not "hunger" or "hambre" on their own: sport and food writing use them far more than aid does.
  FOOD: {
    en: {
      search: ['food bank', 'food insecurity', 'food poverty'],
      match: ['food aid', 'food parcels', 'malnutrition', 'soup kitchen'],
      exclude: ['hunger strike'],
    },
    es: {
      search: ['banco de alimentos', 'inseguridad alimentaria', 'ayuda alimentaria'],
      match: ['comedor social', 'desnutrición', 'reparto de alimentos'],
      exclude: ['huelga de hambre'],
    },
  },
  SHELTER: {
    en: {
      search: ['homelessness', 'housing crisis', 'evictions'],
      match: ['homeless', 'displaced', 'eviction'],
    },
    es: {
      search: ['sin hogar', 'desahucios', 'crisis de vivienda'],
      match: ['sinhogarismo', 'desahucio', 'desplazados', 'realojo'],
    },
  },
  MEDICAL: {
    en: {
      search: ['health care', 'hospital', 'medical supplies'],
      match: ['waiting list', 'health service'],
    },
    es: {
      search: ['sanidad', 'listas de espera', 'hospital'],
      match: ['atención primaria', 'material sanitario', 'centro de salud'],
    },
  },
  CASH: {
    en: {
      search: ['poverty', 'cost of living', 'social exclusion'],
      match: ['low income', 'energy poverty'],
    },
    es: {
      search: ['pobreza', 'exclusión social', 'coste de vida'],
      match: ['pobreza energética', 'renta mínima', 'vulnerabilidad'],
    },
  },
  EDUCATION: {
    en: { search: ['school', 'education', 'school dropout'], match: ['pupils', 'students', 'teachers'] },
    es: {
      search: ['educación', 'abandono escolar', 'colegio'],
      match: ['escuela', 'alumnos', 'profesores', 'becas'],
    },
  },
}

const GENERIC: Record<NewsLanguage, Terms> = {
  en: { search: ['humanitarian aid', 'emergency'], match: ['aid', 'crisis'] },
  es: { search: ['ayuda humanitaria', 'emergencia'], match: ['ayuda', 'crisis'] },
}

/** Spain's autonomous communities (ISO 3166-2:ES), the coarse regions the app suggests, by the names news uses. */
const SPAIN: Record<string, Record<NewsLanguage, string>> = {
  AN: { es: 'Andalucía', en: 'Andalusia' },
  AR: { es: 'Aragón', en: 'Aragon' },
  AS: { es: 'Asturias', en: 'Asturias' },
  CB: { es: 'Cantabria', en: 'Cantabria' },
  CE: { es: 'Ceuta', en: 'Ceuta' },
  CL: { es: 'Castilla y León', en: 'Castile and León' },
  CM: { es: 'Castilla-La Mancha', en: 'Castilla-La Mancha' },
  CN: { es: 'Canarias', en: 'Canary Islands' },
  CT: { es: 'Cataluña', en: 'Catalonia' },
  EX: { es: 'Extremadura', en: 'Extremadura' },
  GA: { es: 'Galicia', en: 'Galicia' },
  IB: { es: 'Baleares', en: 'Balearic Islands' },
  MC: { es: 'Murcia', en: 'Murcia' },
  MD: { es: 'Madrid', en: 'Madrid' },
  ML: { es: 'Melilla', en: 'Melilla' },
  NC: { es: 'Navarra', en: 'Navarre' },
  PV: { es: 'País Vasco', en: 'Basque Country' },
  RI: { es: 'La Rioja', en: 'La Rioja' },
  VC: { es: 'Comunidad Valenciana', en: 'Valencia region' },
}

const SUBDIVISIONS: Record<string, Record<string, Record<NewsLanguage, string>>> = { ES: SPAIN }

/** Other names news uses for the same community: its own language's, its provinces and its main cities. */
const SPAIN_ALIASES: Record<string, readonly string[]> = {
  AN: ['Almería', 'Cádiz', 'Córdoba', 'Granada', 'Huelva', 'Jaén', 'Málaga', 'Sevilla', 'Seville'],
  AR: ['Huesca', 'Teruel', 'Zaragoza'],
  AS: ['Oviedo', 'Gijón', 'Avilés'],
  CB: ['Santander', 'Torrelavega'],
  CE: [],
  CL: [
    'Castilla y León',
    'Ávila',
    'Burgos',
    'León',
    'Palencia',
    'Salamanca',
    'Segovia',
    'Soria',
    'Valladolid',
    'Zamora',
  ],
  CM: [
    'Castilla La Mancha',
    'CLM',
    'castellanomanchego',
    'castellano-manchego',
    'Albacete',
    'Ciudad Real',
    'Cuenca',
    'Guadalajara',
    'Toledo',
    'Talavera',
  ],
  CN: ['Canary Islands', 'Tenerife', 'Gran Canaria', 'Las Palmas', 'Lanzarote', 'Fuerteventura', 'La Palma'],
  CT: ['Catalunya', 'Barcelona', 'Girona', 'Lleida', 'Tarragona'],
  EX: ['Badajoz', 'Cáceres', 'Mérida'],
  GA: ['A Coruña', 'La Coruña', 'Lugo', 'Ourense', 'Pontevedra', 'Vigo', 'Santiago de Compostela', 'Xunta'],
  IB: ['Illes Balears', 'Islas Baleares', 'Mallorca', 'Majorca', 'Menorca', 'Ibiza', 'Eivissa', 'Formentera'],
  MC: ['Murcia', 'Cartagena', 'Lorca'],
  MD: ['Madrid'],
  ML: [],
  NC: ['Nafarroa', 'Pamplona', 'Iruña'],
  PV: [
    'Euskadi',
    'Álava',
    'Araba',
    'Bizkaia',
    'Vizcaya',
    'Gipuzkoa',
    'Guipúzcoa',
    'Bilbao',
    'Vitoria',
    'Donostia',
  ],
  RI: ['Logroño'],
  VC: [
    'Comunitat Valenciana',
    'Valencia',
    'València',
    'Alicante',
    'Alacant',
    'Castellón',
    'Castelló',
    'Elche',
  ],
}

const ALIASES: Record<string, Record<string, readonly string[]>> = { ES: SPAIN_ALIASES }

const SPANISH_SPEAKING = new Set([
  'ES',
  'MX',
  'AR',
  'CO',
  'CL',
  'PE',
  'VE',
  'EC',
  'GT',
  'CU',
  'BO',
  'DO',
  'HN',
  'PY',
  'SV',
  'NI',
  'CR',
  'PA',
  'UY',
  'PR',
  'GQ',
])

/** The edition of the news a language is searched in when the region's own country speaks another. */
const HOME_MARKET: Record<NewsLanguage, string> = { en: 'US', es: 'ES' }

const ISO_REGION = /^([A-Z]{2})(?:-([A-Z0-9]{1,3}))?$/
const FREE_TEXT_PLACE = /^[\p{L}\p{N} .'-]{2,40}$/u

/**
 * A region label as news would name it: a known subdivision by its name, otherwise the country. A label that is not
 * an ISO code is used as written if it looks like a place name, and not at all otherwise.
 */
const isoParts = (region: string): { country: string; subdivision: string | null } | null => {
  const match = region.trim().toUpperCase().match(ISO_REGION)
  return match?.[1] ? { country: match[1], subdivision: match[2] ?? null } : null
}

export const placeName = (region: string, language: NewsLanguage): string | null => {
  const label = region.trim()
  const iso = isoParts(label)
  if (!iso) return FREE_TEXT_PLACE.test(label) ? label : null
  const known = iso.subdivision ? SUBDIVISIONS[iso.country]?.[iso.subdivision]?.[language] : undefined
  if (known) return known
  try {
    const name = new Intl.DisplayNames([language], { type: 'region' }).of(iso.country)
    return name && name !== iso.country ? name : null
  } catch {
    return null
  }
}

/** The ISO country of a region label, if it is one. */
export const regionCountry = (region: string): string | null => isoParts(region)?.country ?? null

/** Every name that puts an article in the region: its name in both languages, and the aliases above. */
export const placeTerms = (region: string): string[] => {
  const iso = isoParts(region)
  const aliases = iso?.subdivision ? (ALIASES[iso.country]?.[iso.subdivision] ?? []) : []
  const names = (['en', 'es'] as const).map((language) => placeName(region, language))
  return [...new Set([...names, ...aliases].filter((name): name is string => Boolean(name)))]
}

const topicTerms = (category: string, language: NewsLanguage): Terms =>
  TOPICS[category.toUpperCase()]?.[language] ?? GENERIC[language]

/**
 * The searches for a need: in the language of the place (where most of its news is written) and in the reader's,
 * when they differ. None when the region cannot be named.
 */
export const newsQueries = (category: string, region: string, locale: NewsLanguage): NewsQuery[] => {
  const country = regionCountry(region)
  const local: NewsLanguage = country && SPANISH_SPEAKING.has(country) ? 'es' : 'en'
  const languages = [...new Set<NewsLanguage>([local, locale])]
  return languages.flatMap((language) => {
    const place = placeName(region, language)
    if (!place) return []
    const terms = topicTerms(category, language)
    const market = country && language === local ? country : HOME_MARKET[language]
    return [
      {
        language,
        country: market,
        place,
        keywords: terms.search,
        matchTerms: [...terms.search, ...terms.match],
        placeTerms: placeTerms(region),
        excludeTerms: terms.exclude ?? [],
      },
    ]
  })
}

const phrase = (term: string) => (term.includes(' ') ? `"${term}"` : term)

/**
 * Bing News as RSS. Its boolean operators are unreliable, so it gets one keyword per search; and its own relevance
 * order, since newest-first is mostly a region's other news (the year window and the ranking keep it recent).
 */
export const bingNewsUrl = (query: NewsQuery, keyword: string): string =>
  `https://www.bing.com/news/search?${new URLSearchParams({
    q: `"${query.place}" ${phrase(keyword)}`,
    format: 'rss',
    setlang: query.language,
    cc: query.country,
  })}`

const googleParams = (query: NewsQuery, window: boolean) =>
  new URLSearchParams({
    q: `"${query.place}" (${query.keywords.map(phrase).join(' OR ')})${window ? ` when:${NEWS_WINDOW_DAYS}d` : ''}`,
    hl: query.language,
    gl: query.country,
    ceid: `${query.country}:${query.language}`,
  })

/** Google News as RSS: one search with every keyword, ranked by relevance. */
export const googleNewsUrl = (query: NewsQuery): string =>
  `https://news.google.com/rss/search?${googleParams(query, true)}`

/** The same search on Google News' own page, for a reader who wants more than the few articles shown. */
export const googleNewsPage = (query: NewsQuery): string =>
  `https://news.google.com/search?${googleParams(query, false)}`

// ── reading the feeds ────────────────────────────────────────────────────────────────────────────────────────────

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  hellip: '…',
  ndash: '–',
  mdash: '—',
  laquo: '«',
  raquo: '»',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
}

const codePoint = (value: number) => {
  try {
    return String.fromCodePoint(value)
  } catch {
    return ''
  }
}

export const decodeEntities = (text: string): string =>
  text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
    if (name[0] === '#') {
      return codePoint(
        name[1] === 'x' || name[1] === 'X' ? Number.parseInt(name.slice(2), 16) : Number(name.slice(1)),
      )
    }
    return NAMED_ENTITIES[name.toLowerCase()] ?? whole
  })

/** Markup-free, whitespace-collapsed text: feeds escape HTML inside their text, sometimes twice. */
export const plainText = (text: string): string =>
  decodeEntities(decodeEntities(text.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')).replace(/<[^>]*>/g, ' '))
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

export const truncate = (text: string, max: number): string => {
  if (text.length <= max) return text
  const cut = text.slice(0, max - 1)
  const space = cut.lastIndexOf(' ')
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s.,;:–—-]+$/, '')}…`
}

export interface FeedItem {
  title: string
  link: string
  description: string
  pubDate: string
  source: string
}

const element = (xml: string, name: string): string => {
  const match = xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i'))
  return match?.[1] ?? ''
}

/** The items of an RSS 2.0 feed, as raw text fields. Enough for news feeds; not a general XML parser. */
export const parseRssItems = (xml: string, max = 50): FeedItem[] =>
  [...xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)].slice(0, max).map((match) => {
    const item = match[1] ?? ''
    return {
      title: plainText(element(item, 'title')),
      link: plainText(element(item, 'link')),
      description: element(item, 'description'),
      pubDate: plainText(element(item, 'pubDate')),
      source: plainText(element(item, 'News:Source') || element(item, 'source')),
    }
  })

const isoDate = (text: string): string | null => {
  const time = Date.parse(text)
  return Number.isNaN(time) ? null : new Date(time).toISOString()
}

/** Only web pages: a feed must not be able to hand the server, or a reader, some other kind of address. */
export const httpUrl = (value: string, base?: string): string | null => {
  try {
    const url = new URL(value, base)
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null
  } catch {
    return null
  }
}

/** Bing links go through its click tracker; the article's own address is in the `url` parameter. */
export const bingTarget = (link: string): string | null => {
  try {
    const url = new URL(link)
    if (/(^|\.)bing\.com$/i.test(url.hostname) && url.searchParams.has('url')) {
      return httpUrl(url.searchParams.get('url') ?? '')
    }
    return httpUrl(link)
  } catch {
    return null
  }
}

const hostName = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

export const fromBing = (item: FeedItem, language: NewsLanguage): NewsArticle | null => {
  const url = bingTarget(item.link)
  if (!url || !item.title) return null
  const snippet = plainText(item.description)
  return {
    url,
    title: truncate(item.title, 200),
    source: item.source || hostName(url),
    publishedAt: isoDate(item.pubDate),
    snippet: snippet ? truncate(snippet, 280) : null,
    image: null,
    language,
    via: 'bing',
  }
}

/** Google titles end in " - Outlet"; its description repeats the title and says nothing more. */
export const fromGoogle = (item: FeedItem, language: NewsLanguage): NewsArticle | null => {
  const url = httpUrl(item.link)
  if (!url || !item.title) return null
  const suffix = item.source ? ` - ${item.source}` : ''
  const title = suffix && item.title.endsWith(suffix) ? item.title.slice(0, -suffix.length) : item.title
  return {
    url,
    title: truncate(title, 200),
    source: item.source || hostName(url),
    publishedAt: isoDate(item.pubDate),
    snippet: null,
    image: null,
    language,
    via: 'google',
  }
}

// ── which results are on topic ───────────────────────────────────────────────────────────────────────────────────

/** Case- and accent-insensitive form for matching: "Sequía" and "sequia" are the same word here. */
export const fold = (text: string): string => text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * A matcher for any of the terms as whole words, accents and case aside. With `prefix`, a term may run on into a
 * longer word ("sequía" finds "sequías"); without it, it must end there too ("León" does not find "Leonor").
 */
const wordMatcher = (terms: readonly string[], prefix: boolean): ((text: string) => boolean) => {
  const alternatives = terms.map((term) => escapeRegExp(fold(term))).filter(Boolean)
  if (alternatives.length === 0) return () => false
  const pattern = new RegExp(
    `(?:^|[^\\p{L}\\p{N}])(?:${alternatives.join('|')})${prefix ? '' : '(?![\\p{L}\\p{N}])'}`,
    'u',
  )
  return (text) => pattern.test(fold(text))
}

/**
 * How well an article fits the need, or 0 when it does not: its title or snippet must name the problem and the
 * place. Search engines match on the whole page — and Bing does not even hold to the quoted place — so without this
 * a region's search is mostly its other news, and a problem's search is mostly other regions. A mention in the
 * title counts for more, and a result that links to the article itself (so it has a preview) edges ahead of one
 * that does not.
 */
export const relevance = (
  article: NewsArticle,
  query: Pick<NewsQuery, 'matchTerms' | 'placeTerms' | 'excludeTerms'>,
): number => {
  const topical = wordMatcher(query.matchTerms, true)
  const local = wordMatcher(query.placeTerms, false)
  const offTopic = wordMatcher(query.excludeTerms, true)
  const snippet = article.snippet ?? ''
  if (offTopic(article.title) || offTopic(snippet)) return 0
  const topicScore = topical(article.title) ? 3 : topical(snippet) ? 1 : 0
  const placeScore = local(article.title) ? 2 : local(snippet) ? 1 : 0
  if (topicScore === 0 || placeScore === 0) return 0
  return topicScore + placeScore + (article.via === 'bing' ? 1 : 0)
}

export interface Scored {
  article: NewsArticle
  score: number
}

const titleKey = (title: string) =>
  fold(title)
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .slice(0, 80)

/**
 * The articles to show: on topic, from the last year, one copy of each story (the Bing copy when both engines found
 * it, since it links to the article itself and carries a snippet), no more than two from one outlet, best first.
 */
export const selectArticles = (candidates: Scored[], now = Date.now(), limit = NEWS_LIMIT): NewsArticle[] => {
  const oldest = now - NEWS_WINDOW_DAYS * 86_400_000
  const best = new Map<string, Scored>()
  for (const candidate of candidates) {
    const { article, score } = candidate
    if (score <= 0) continue
    if (article.publishedAt && Date.parse(article.publishedAt) < oldest) continue
    const key = titleKey(article.title)
    const seen = best.get(key)
    // Same title: a Bing copy scores at least as high as Google's, since only it has a snippet to match too.
    const better =
      !seen ||
      score > seen.score ||
      (score === seen.score && article.via === 'bing' && seen.article.via !== 'bing')
    if (better) best.set(key, candidate)
  }
  const byUrl = new Map<string, Scored>()
  for (const candidate of best.values()) {
    if (!byUrl.has(candidate.article.url)) byUrl.set(candidate.article.url, candidate)
  }
  const ranked = [...byUrl.values()].sort(
    (a, b) =>
      b.score - a.score ||
      Date.parse(b.article.publishedAt ?? '1970-01-01') - Date.parse(a.article.publishedAt ?? '1970-01-01'),
  )
  const perSource = new Map<string, number>()
  const chosen: NewsArticle[] = []
  for (const { article } of ranked) {
    const source = fold(article.source)
    const count = perSource.get(source) ?? 0
    if (count >= PER_SOURCE) continue
    perSource.set(source, count + 1)
    chosen.push(article)
    if (chosen.length === limit) break
  }
  return chosen
}

// ── what an article page says about itself ───────────────────────────────────────────────────────────────────────

export interface PagePreview {
  title: string | null
  description: string | null
  image: string | null
  siteName: string | null
}

const ATTRIBUTE = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g

/** The Open Graph (and Twitter card) preview in a page's head. Images must be https: the page is served over it. */
export const parseOpenGraph = (html: string, pageUrl: string): PagePreview => {
  const headEnd = html.search(/<\/head\s*>/i)
  const head = headEnd >= 0 ? html.slice(0, headEnd) : html
  const meta = new Map<string, string>()
  for (const tag of head.matchAll(/<meta\b([^>]*)>/gi)) {
    const fields: Record<string, string> = {}
    for (const [, name = '', double, single, bare] of (tag[1] ?? '').matchAll(ATTRIBUTE)) {
      fields[name.toLowerCase()] = double ?? single ?? bare ?? ''
    }
    const key = (fields.property ?? fields.name ?? '').toLowerCase()
    if (key && fields.content !== undefined && !meta.has(key)) meta.set(key, fields.content)
  }
  const first = (...keys: string[]) => {
    for (const key of keys) {
      const value = meta.get(key)
      if (value?.trim()) return value.trim()
    }
    return null
  }
  const text = (value: string | null, max: number) => {
    const clean = value ? plainText(value) : ''
    return clean ? truncate(clean, max) : null
  }
  const rawImage = first(
    'og:image:secure_url',
    'og:image',
    'og:image:url',
    'twitter:image',
    'twitter:image:src',
  )
  const image = rawImage ? httpUrl(decodeEntities(rawImage), pageUrl) : null
  return {
    title: text(first('og:title', 'twitter:title'), 200),
    description: text(first('og:description', 'twitter:description', 'description'), 280),
    image: image?.startsWith('https:') && image.length <= 2_000 ? image : null,
    siteName: text(first('og:site_name'), 80),
  }
}

// ── which addresses the server may fetch ─────────────────────────────────────────────────────────────────────────

const ipv4 = (text: string): number[] | null => {
  const parts = text.split('.')
  if (parts.length !== 4) return null
  const bytes = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : Number.NaN))
  return bytes.every((byte) => byte >= 0 && byte <= 255) ? bytes : null
}

const publicIpv4 = ([a = 0, b = 0, c = 0]: readonly number[]): boolean =>
  !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  )

/** Eight 16-bit groups of an IPv6 address, or null if it is not one. */
const ipv6 = (text: string): number[] | null => {
  let address =
    text
      .toLowerCase()
      .replace(/^\[|\]$/g, '')
      .split('%')[0] ?? ''
  // A dotted IPv4 tail (::ffff:10.0.0.1) stands for the last two groups.
  const dotted = address.match(/(\d+\.\d+\.\d+\.\d+)$/)?.[1]
  if (dotted) {
    const bytes = ipv4(dotted)
    if (!bytes) return null
    const [a = 0, b = 0, c = 0, d = 0] = bytes
    address = `${address.slice(0, -dotted.length)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`
  }
  const halves = address.split('::')
  if (halves.length > 2) return null
  const groups = (half: string | undefined) => (half ? half.split(':') : [])
  const head = groups(halves[0])
  const tail = halves.length === 2 ? groups(halves[1]) : []
  const missing = 8 - head.length - tail.length
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null
  const all = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill('0'), ...tail]
  if (!all.every((group) => /^[0-9a-f]{1,4}$/.test(group))) return null
  return all.map((group) => Number.parseInt(group, 16))
}

/**
 * Whether an IP address is on the public internet. The server fetches article pages whose addresses come from a
 * search feed, so it must never be pointed at itself, its network, or a cloud metadata endpoint.
 */
export const isPublicAddress = (address: string): boolean => {
  const v4 = ipv4(address)
  if (v4) return publicIpv4(v4)
  const v6 = ipv6(address)
  if (!v6) return false
  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = v6
  const v4Tail = [g6 >> 8, g6 & 0xff, g7 >> 8, g7 & 0xff]
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && (g5 === 0xffff || g5 === 0)) {
    // ::ffff:a.b.c.d (mapped), ::a.b.c.d (compatible), :: and ::1
    return g5 === 0xffff ? publicIpv4(v4Tail) : g6 !== 0 && publicIpv4(v4Tail)
  }
  if (g0 === 0x64 && g1 === 0xff9b) return publicIpv4(v4Tail) // NAT64
  if ((g0 & 0xfe00) === 0xfc00) return false // unique local
  if ((g0 & 0xffc0) === 0xfe80) return false // link local
  if ((g0 & 0xff00) === 0xff00) return false // multicast
  if (g0 === 0x2001 && g1 === 0x0db8) return false // documentation
  if (g0 === 0x2002) return publicIpv4([g1 >> 8, g1 & 0xff, g2 >> 8, g2 & 0xff]) // 6to4
  return true
}
