import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  bingNewsUrl,
  bingTarget,
  fromBing,
  fromGoogle,
  googleNewsUrl,
  isPublicAddress,
  type NewsArticle,
  newsQueries,
  parseOpenGraph,
  parseRssItems,
  placeName,
  plainText,
  relevance,
  selectArticles,
} from './news.ts'

const NOW = Date.parse('2026-09-24T12:00:00Z')
const DAY = 86_400_000

const article = (overrides: Partial<NewsArticle> = {}): NewsArticle => ({
  url: 'https://news.example/a',
  title: 'Sequía en Castilla-La Mancha',
  source: 'Diario',
  publishedAt: new Date(NOW - DAY).toISOString(),
  snippet: null,
  image: null,
  language: 'es',
  via: 'bing',
  ...overrides,
})

describe('what a need searches for', () => {
  it('names Spanish regions the way news does, in either language', () => {
    assert.equal(placeName('ES-CM', 'es'), 'Castilla-La Mancha')
    assert.equal(placeName('es-ct', 'en'), 'Catalonia')
    assert.equal(placeName('ES-CT', 'es'), 'Cataluña')
  })

  it('falls back to the country, uses a plain place name as written, and refuses anything else', () => {
    assert.equal(placeName('KE', 'en'), 'Kenya')
    assert.equal(placeName('ES-ZZ', 'es'), 'España')
    assert.equal(placeName('Cuenca', 'es'), 'Cuenca')
    assert.equal(placeName('<script>alert(1)</script>', 'en'), null)
    assert.equal(placeName('', 'en'), null)
  })

  it('searches in the language of the place, and also in the reader’s when it differs', () => {
    const [local, reader, ...rest] = newsQueries('WATER', 'ES-CM', 'en')
    assert.equal(rest.length, 0)
    assert.deepEqual([local?.language, local?.country, local?.place], ['es', 'ES', 'Castilla-La Mancha'])
    assert.deepEqual([reader?.language, reader?.country], ['en', 'US'])
    assert.ok(local?.keywords.includes('sequía'))
    assert.ok(reader?.keywords.includes('drought'))
    assert.ok(local?.placeTerms.includes('Toledo'))

    assert.equal(newsQueries('WATER', 'ES-CM', 'es').length, 1)
  })

  it('uses generic terms for a category it does not know, and does not search a region it cannot name', () => {
    const [query] = newsQueries('0x1234abcd…', 'KE', 'en')
    assert.deepEqual(query?.keywords, ['humanitarian aid', 'emergency'])
    assert.deepEqual(newsQueries('FOOD', '??', 'en'), [])
  })

  it('builds feed URLs with the place quoted and the keywords as the engine understands them', () => {
    const [query] = newsQueries('WATER', 'ES-CM', 'es')
    assert.ok(query)
    const bing = new URL(bingNewsUrl(query, 'escasez de agua'))
    assert.equal(bing.hostname, 'www.bing.com')
    assert.equal(bing.searchParams.get('q'), '"Castilla-La Mancha" "escasez de agua"')
    assert.equal(bing.searchParams.get('format'), 'rss')
    const google = new URL(googleNewsUrl(query))
    assert.equal(
      google.searchParams.get('q'),
      '"Castilla-La Mancha" (sequía OR "escasez de agua" OR "agua potable") when:365d',
    )
    assert.equal(google.searchParams.get('ceid'), 'ES:es')
  })
})

const BING_FEED = `<?xml version="1.0" encoding="utf-8" ?><rss version="2.0"><channel>
<item><title>Ayudas por sequ&#237;a en Castilla-La Mancha</title>
<link>http://www.bing.com/news/apiclick.aspx?ref=FexRss&amp;aid=&amp;url=https%3a%2f%2fwww.elplural.com%2fclm%2fayudas-sequia_1&amp;mkt=es-es</link>
<description>El consejero anunci&#243; las ayudas &amp;quot;para paliar&amp;quot; los efectos ...</description>
<pubDate>Mon, 21 Sep 2026 09:44:00 GMT</pubDate><News:Source>Elplural.com</News:Source></item>
<item><title>Broken</title><link>javascript:alert(1)</link><pubDate>nonsense</pubDate></item>
</channel></rss>`

const GOOGLE_FEED = `<rss version="2.0"><channel>
<item><title>La sequía pasa factura al viñedo de Castilla-La Mancha - El Debate</title>
<link>https://news.google.com/rss/articles/CBMi5gFBVV?oc=5</link>
<pubDate>Wed, 02 Sep 2026 07:00:00 GMT</pubDate>
<description>&lt;a href="https://news.google.com/rss/articles/CBMi"&gt;La sequía pasa factura&lt;/a&gt;&amp;nbsp;&amp;nbsp;&lt;font color="#6f6f6f"&gt;El Debate&lt;/font&gt;</description>
<source url="https://www.eldebate.com">El Debate</source></item>
</channel></rss>`

describe('reading the feeds', () => {
  it('takes the article address out of Bing’s click tracker and decodes the text', () => {
    const [first, broken] = parseRssItems(BING_FEED)
    assert.ok(first && broken)
    const result = fromBing(first, 'es')
    assert.equal(result?.url, 'https://www.elplural.com/clm/ayudas-sequia_1')
    assert.equal(result?.title, 'Ayudas por sequía en Castilla-La Mancha')
    assert.equal(result?.snippet, 'El consejero anunció las ayudas "para paliar" los efectos ...')
    assert.equal(result?.source, 'Elplural.com')
    assert.equal(result?.publishedAt, '2026-09-21T09:44:00.000Z')
    assert.equal(fromBing(broken, 'es'), null)
  })

  it('drops the outlet from a Google title and keeps its link, which is Google’s', () => {
    const [item] = parseRssItems(GOOGLE_FEED)
    assert.ok(item)
    const result = fromGoogle(item, 'es')
    assert.equal(result?.title, 'La sequía pasa factura al viñedo de Castilla-La Mancha')
    assert.equal(result?.source, 'El Debate')
    assert.equal(result?.snippet, null)
    assert.ok(result?.url.startsWith('https://news.google.com/'))
  })

  it('never lets a feed hand over something that is not a web address', () => {
    assert.equal(bingTarget('https://www.bing.com/news/apiclick.aspx?url=javascript%3aalert(1)'), null)
    assert.equal(bingTarget('https://outlet.example/story'), 'https://outlet.example/story')
    assert.equal(bingTarget('data:text/html,hi'), null)
  })

  it('strips markup that feeds escape, even twice', () => {
    assert.equal(plainText('&lt;b&gt;Hola&lt;/b&gt;&amp;nbsp;mundo &amp;amp; <i>más</i>'), 'Hola mundo & más')
  })
})

describe('which articles are on topic', () => {
  const [query] = newsQueries('SHELTER', 'ES-CT', 'es')
  assert.ok(query)

  it('needs both the problem and the place, and counts the title for more', () => {
    const both = relevance(article({ title: 'Más desahucios en Cataluña' }), query)
    const placeInSnippet = relevance(
      article({ title: 'Récord de desahucios', snippet: 'Los datos de Cataluña muestran…' }),
      query,
    )
    assert.ok(both > placeInSnippet && placeInSnippet > 0)
    assert.equal(relevance(article({ title: 'Récord de desahucios en Sacramento' }), query), 0)
    assert.equal(relevance(article({ title: 'Fiestas de la Mercè en Cataluña' }), query), 0)
  })

  it('knows a region by its provinces and cities, and ignores accents and case', () => {
    assert.ok(relevance(article({ title: 'SIN HOGAR en BARCELONA' }), query) > 0)
    assert.ok(relevance(article({ title: 'Sinhogarismo en Catalunya' }), query) > 0)
  })

  it('matches place names as whole words', () => {
    const [castile] = newsQueries('WATER', 'ES-CL', 'es')
    assert.ok(castile)
    assert.ok(relevance(article({ title: 'Sequía en León' }), castile) > 0)
    assert.equal(relevance(article({ title: 'Leonor habla de la sequía' }), castile), 0)
  })

  it('leaves out phrases that use a keyword for something else', () => {
    const [food] = newsQueries('FOOD', 'ES-MD', 'es')
    assert.ok(food)
    assert.equal(
      relevance(article({ title: 'Huelga de hambre ante el banco de alimentos de Madrid' }), food),
      0,
    )
    assert.ok(relevance(article({ title: 'El banco de alimentos de Madrid pide voluntarios' }), food) > 0)
    assert.equal(relevance(article({ title: 'Vuelve el hambre al Madrid' }), food), 0)
  })

  it('puts a result with a preview ahead of an equal one without', () => {
    const bing = relevance(article({ title: 'Desahucios en Barcelona', via: 'bing' }), query)
    const google = relevance(article({ title: 'Desahucios en Barcelona', via: 'google' }), query)
    assert.equal(bing, google + 1)
  })

  it('keeps one copy of a story, recent ones only, two per outlet at most, best first', () => {
    const chosen = selectArticles(
      [
        {
          article: article({ url: 'https://g/1', title: 'Story one', via: 'google', source: 'A' }),
          score: 5,
        },
        { article: article({ url: 'https://b/1', title: 'Story one!', via: 'bing', source: 'A' }), score: 5 },
        { article: article({ url: 'https://a/2', title: 'Story two', source: 'A' }), score: 6 },
        { article: article({ url: 'https://a/3', title: 'Story three', source: 'A' }), score: 4 },
        {
          article: article({ url: 'https://c/1', title: 'Old story', publishedAt: '2024-01-01T00:00:00Z' }),
          score: 9,
        },
        { article: article({ url: 'https://c/2', title: 'Off topic', source: 'C' }), score: 0 },
        { article: article({ url: 'https://d/1', title: 'Story four', source: 'D' }), score: 4 },
      ],
      NOW,
    )
    assert.deepEqual(
      chosen.map((item) => item.url),
      ['https://a/2', 'https://b/1', 'https://d/1'],
    )
  })
})

describe('what an article page says about itself', () => {
  const page = `<!doctype html><html><head>
    <meta content="Sequía &amp; campo" property="og:title">
    <meta property='og:description' content='Las ayudas llegan &quot;tarde&quot;'>
    <meta name="description" content="fallback">
    <meta property="og:image" content="/img/campo.jpg">
    <meta property="og:site_name" content="El Plural">
  </head><body><meta property="og:image" content="https://evil.example/late.jpg"></body></html>`

  it('reads the Open Graph tags in any attribute order, and resolves a relative image', () => {
    const preview = parseOpenGraph(page, 'https://www.elplural.com/clm/story')
    assert.deepEqual(preview, {
      title: 'Sequía & campo',
      description: 'Las ayudas llegan "tarde"',
      image: 'https://www.elplural.com/img/campo.jpg',
      siteName: 'El Plural',
    })
  })

  it('refuses an image that is not https, and falls back to the plain description', () => {
    const preview = parseOpenGraph(
      '<head><meta name="description" content="Plain"><meta property="og:image" content="http://x.example/a.jpg"></head>',
      'https://x.example/',
    )
    assert.equal(preview.image, null)
    assert.equal(preview.description, 'Plain')
  })
})

describe('which addresses the server may fetch', () => {
  const cases: [string, boolean][] = [
    ['93.184.216.34', true],
    ['8.8.8.8', true],
    ['127.0.0.1', false],
    ['10.1.2.3', false],
    ['172.16.0.1', false],
    ['172.32.0.1', true],
    ['192.168.1.1', false],
    ['169.254.169.254', false],
    ['100.64.0.1', false],
    ['0.0.0.0', false],
    ['224.0.0.1', false],
    ['2606:4700::1111', true],
    ['::1', false],
    ['::', false],
    ['fe80::1', false],
    ['fd00::1', false],
    ['::ffff:127.0.0.1', false],
    ['::ffff:93.184.216.34', true],
    ['64:ff9b::a9fe:a9fe', false],
    ['2002:c0a8:0101::1', false],
    ['not an address', false],
  ]
  for (const [address, expected] of cases) {
    it(`${address} is ${expected ? 'public' : 'not public'}`, () => {
      assert.equal(isPublicAddress(address), expected)
    })
  }
})
