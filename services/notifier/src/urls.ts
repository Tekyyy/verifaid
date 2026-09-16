import { BlockList, isIP } from 'node:net'

/**
 * A basic SSRF guard for URLs a stranger hands us. The worker POSTs to them, so without a check anyone could make
 * this service call the cloud metadata endpoint or an admin panel on the internal network.
 *
 * Production: https only, no `localhost`, no credentials, and IP literals must be public (private, loopback,
 * link-local, CGNAT, multicast, documentation and IPv4-mapped forms of those are refused). Development also allows
 * `http://localhost` and `http://127.0.0.1` so a local receiver works.
 *
 * Not covered: a public hostname that *resolves* to a private address (DNS rebinding). Closing that needs
 * resolve-then-pin at connect time or an egress proxy; see the README.
 */

const MAX_URL_LENGTH = 2048

const blocked = new BlockList()
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  blocked.addSubnet(network, prefix, 'ipv4')
}
for (const [network, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['64:ff9b::', 96],
  ['100::', 64],
  ['2001:db8::', 32],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const) {
  blocked.addSubnet(network, prefix, 'ipv6')
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

/** True for an IP literal in a private, loopback, link-local or otherwise non-public range. */
export const isPrivateAddress = (address: string): boolean => {
  const bare = address.replace(/^\[|\]$/g, '')
  const version = isIP(bare)
  if (version === 4) return blocked.check(bare, 'ipv4')
  // BlockList also matches IPv4-mapped IPv6 (`::ffff:7f00:1`) against the IPv4 rules.
  if (version === 6) return blocked.check(bare, 'ipv6')
  return false
}

export type UrlCheck = { ok: true; url: string } | { ok: false; reason: string }

export const checkWebhookUrl = (raw: string, options: { production: boolean }): UrlCheck => {
  if (raw.length > MAX_URL_LENGTH) return { ok: false, reason: 'URL is too long' }
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return { ok: false, reason: 'not a valid absolute URL' }
  }
  if (url.username || url.password) return { ok: false, reason: 'credentials in the URL are not allowed' }

  const host = url.hostname.toLowerCase()
  if (url.protocol === 'http:') {
    if (options.production || !LOOPBACK_HOSTS.has(host)) {
      return { ok: false, reason: 'https is required (plain http only for localhost in development)' }
    }
    return { ok: true, url: url.href }
  }
  if (url.protocol !== 'https:') return { ok: false, reason: 'https is required' }

  if (options.production) {
    if (host === 'localhost' || host.endsWith('.localhost')) {
      return { ok: false, reason: 'localhost is not allowed' }
    }
    if (isPrivateAddress(host)) {
      return { ok: false, reason: 'private, loopback and link-local addresses are not allowed' }
    }
  }
  return { ok: true, url: url.href }
}
