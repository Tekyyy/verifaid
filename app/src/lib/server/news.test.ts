import assert from 'node:assert/strict'
import { beforeEach, describe, it } from 'node:test'
import { fetchArticleHead, findNeedNews, newsTopic, publicTarget, resetNewsCache } from './news.ts'

const NOW = Date.parse('2026-09-24T12:00:00Z')
const PUBLIC = '93.184.216.34'

/** Every name resolves to a public address except those listed. */
const resolver =
  (overrides: Record<string, string[]> = {}) =>
  async (host: string) =>
    overrides[host] ?? [PUBLIC]

const rss = (items: string) => `<?xml version="1.0"?><rss version="2.0"><channel>${items}</channel></rss>`

const BING = rss(`<item><title>Sequía extrema en Castilla-La Mancha</title>
<link>http://www.bing.com/news/apiclick.aspx?url=https%3a%2f%2fnews.example%2fsequia</link>
<description>Los embalses de Toledo, bajo mínimos.</description>
<pubDate>Mon, 21 Sep 2026 09:00:00 GMT</pubDate><News:Source>Noticias</News:Source></item>`)

const GOOGLE = rss(`<item><title>Toledo pide agua potable para sus pueblos - La Tribuna</title>
<link>https://news.google.com/rss/articles/abc?oc=5</link>
<pubDate>Sat, 19 Sep 2026 09:00:00 GMT</pubDate><source url="https://latribuna.example">La Tribuna</source></item>
<item><title>Fiestas en Toledo - La Tribuna</title>
<link>https://news.google.com/rss/articles/def?oc=5</link>
<pubDate>Sat, 19 Sep 2026 09:00:00 GMT</pubDate><source url="https://latribuna.example">La Tribuna</source></item>`)

const ARTICLE = `<html><head><meta property="og:image" content="https://news.example/campo.jpg">
<meta property="og:description" content="Resumen de la propia página."></head><body>…</body></html>`

const html = (body: string, init: ResponseInit = {}) =>
  new Response(body, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, ...init })

/** A network that answers the two feeds and one article page, and counts what it was asked for. */
const fakeNetwork = (overrides: { feeds?: number } = {}) => {
  const calls: string[] = []
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = new URL(String(input))
    calls.push(url.hostname)
    if (overrides.feeds && url.hostname !== 'news.example')
      return new Response('no', { status: overrides.feeds })
    if (url.hostname === 'www.bing.com') return new Response(BING)
    if (url.hostname === 'news.google.com') return new Response(GOOGLE)
    if (url.hostname === 'news.example') return html(ARTICLE)
    return new Response('not found', { status: 404 })
  }) as typeof fetch
  return { calls, fetchImpl }
}

const TOPIC = { category: 'WATER', region: 'ES-CM', locale: 'es' as const }

describe('finding news for a need', () => {
  beforeEach(() => resetNewsCache())

  it('keeps the on-topic articles and fills in each page’s own preview', async () => {
    const { fetchImpl } = fakeNetwork()
    const news = await findNeedNews(TOPIC, { fetchImpl, resolve: resolver(), now: () => NOW, env: {} })
    assert.ok(news)
    assert.equal(news.searched, true)
    assert.deepEqual(
      news.articles.map((article) => [article.via, article.title]),
      [
        ['bing', 'Sequía extrema en Castilla-La Mancha'],
        ['google', 'Toledo pide agua potable para sus pueblos'],
      ],
    )
    const [bing, google] = news.articles
    assert.equal(bing?.image, 'https://news.example/campo.jpg')
    assert.equal(bing?.snippet, 'Resumen de la propia página.')
    assert.equal(google?.image, null)
  })

  it('asks the network once for the same region and category, however many readers', async () => {
    const { calls, fetchImpl } = fakeNetwork()
    const deps = { fetchImpl, resolve: resolver(), now: () => NOW, env: {} }
    await Promise.all([findNeedNews(TOPIC, deps), findNeedNews(TOPIC, deps)])
    const first = calls.length
    await findNeedNews(TOPIC, deps)
    assert.equal(calls.length, first)
    // Three Bing keywords, one Google search, one article page.
    assert.equal(first, 5)
  })

  it('says it could not look, rather than that there is no news, when every feed fails', async () => {
    const { fetchImpl } = fakeNetwork({ feeds: 503 })
    const news = await findNeedNews(TOPIC, { fetchImpl, resolve: resolver(), now: () => NOW, env: {} })
    assert.deepEqual(news && { searched: news.searched, count: news.articles.length }, {
      searched: false,
      count: 0,
    })
  })

  it('does nothing when switched off, or when the region cannot be named', async () => {
    const { calls, fetchImpl } = fakeNetwork()
    assert.equal(await findNeedNews(TOPIC, { fetchImpl, env: { NEWS_SEARCH: 'off' } }), null)
    assert.equal(await findNeedNews({ ...TOPIC, region: '??' }, { fetchImpl, env: {} }), null)
    assert.equal(calls.length, 0)
    assert.equal(newsTopic('WATER', 'ES-CM', 'es', { NEWS_SEARCH: 'off' }), null)
    assert.equal(newsTopic('WATER', 'ES-CM', 'en', {})?.place, 'Castilla-La Mancha')
  })
})

describe('fetching an article page safely', () => {
  it('refuses anything that is not a web page on the public internet', async () => {
    const resolve = resolver({ 'intranet.example': ['10.0.0.5'], 'mixed.example': [PUBLIC, '127.0.0.1'] })
    assert.equal(await publicTarget('https://news.example/a', resolve), 'https://news.example/a')
    for (const address of [
      'file:///etc/passwd',
      'ftp://news.example/a',
      'https://user:pass@news.example/a',
      'https://news.example:8080/a',
      'http://localhost/a',
      'http://metadata.internal/a',
      'http://169.254.169.254/latest/meta-data',
      'http://[::1]/a',
      'https://intranet.example/a',
      'https://mixed.example/a',
    ]) {
      assert.equal(await publicTarget(address, resolve), null, address)
    }
  })

  it('follows a redirect only to another public page', async () => {
    const pages: Record<string, Response> = {
      'https://news.example/moved': new Response(null, {
        status: 301,
        headers: { location: 'https://news.example/story' },
      }),
      'https://news.example/story': html(ARTICLE),
      'https://news.example/sneaky': new Response(null, {
        status: 302,
        headers: { location: 'http://169.254.169.254/latest/meta-data' },
      }),
    }
    const fetched: string[] = []
    const fetchImpl = (async (input: string | URL | Request) => {
      fetched.push(String(input))
      return pages[String(input)] ?? new Response('', { status: 404 })
    }) as typeof fetch
    const deps = { fetchImpl, resolve: resolver() }

    const moved = await fetchArticleHead('https://news.example/moved', deps)
    assert.equal(moved?.url, 'https://news.example/story')
    assert.match(moved?.html ?? '', /og:image/)

    assert.equal(await fetchArticleHead('https://news.example/sneaky', deps), null)
    assert.ok(!fetched.some((url) => url.includes('169.254')))
  })

  it('reads only HTML, and only as far as the end of its head', async () => {
    let pulls = 0
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1
        const chunk =
          pulls === 1 ? '<html><head><meta property="og:title" content="T"></head>' : 'x'.repeat(10_000)
        controller.enqueue(new TextEncoder().encode(chunk))
      },
    })
    const fetchImpl = (async () => html('', { headers: { 'content-type': 'text/html' } })) as typeof fetch
    const streaming = (async () =>
      new Response(endless, { headers: { 'content-type': 'text/html' } })) as typeof fetch
    const head = await fetchArticleHead('https://news.example/a', {
      fetchImpl: streaming,
      resolve: resolver(),
    })
    assert.equal(head?.html, '<html><head><meta property="og:title" content="T"></head>')
    assert.ok(pulls <= 2)

    const pdf = (async () =>
      new Response('%PDF', { headers: { 'content-type': 'application/pdf' } })) as typeof fetch
    assert.equal(
      await fetchArticleHead('https://news.example/a', { fetchImpl: pdf, resolve: resolver() }),
      null,
    )
    assert.ok(await fetchArticleHead('https://news.example/a', { fetchImpl, resolve: resolver() }))
  })
})
