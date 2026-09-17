import { createServer, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import {
  DONOR_STAGES,
  type DonationOutcome,
  type DonationTrack,
  type DonorStage,
  type NeedDetail,
  type NeedStatus,
  type TimelineEvent,
  type TimelineEventType,
} from '@poa/shared'

/** Tiny HTTP doubles: a canned indexer, a webhook receiver and a Resend-style email API. */

export interface FakeServer {
  url: string
  close(): Promise<void>
}

const readBody = (request: IncomingMessage): Promise<string> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    request.on('error', reject)
  })

const listen = async (
  handler: (request: IncomingMessage, response: ServerResponse, body: string) => void,
): Promise<FakeServer> => {
  const server = createServer((request, response) => {
    readBody(request).then((body) => handler(request, response, body))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}

const json = (response: ServerResponse, status: number, value: unknown): void => {
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify(value))
}

// ─── indexer ────────────────────────────────────────────────────────────────

export interface FakeIndexer extends FakeServer {
  events: TimelineEvent[]
  tracks: Map<string, DonationTrack>
  needs: Map<string, NeedDetail>
  /** Request path → count. */
  hits: Map<string, number>
  /** When set, every request answers with this status. */
  failWith: number | null
}

const position = (event: Pick<TimelineEvent, 'blockNumber' | 'logIndex'>): bigint =>
  BigInt(event.blockNumber) * 1_000_000n + BigInt(event.logIndex)

export const startFakeIndexer = async (): Promise<FakeIndexer> => {
  const state = {
    events: [] as TimelineEvent[],
    tracks: new Map<string, DonationTrack>(),
    needs: new Map<string, NeedDetail>(),
    hits: new Map<string, number>(),
    failWith: null as number | null,
  }
  const server = await listen((request, response) => {
    const url = new URL(request.url ?? '/', 'http://indexer')
    state.hits.set(url.pathname, (state.hits.get(url.pathname) ?? 0) + 1)
    if (state.failWith) return json(response, state.failWith, { error: 'boom' })

    if (url.pathname === '/timeline') {
      const after = url.searchParams.get('after')
      const limit = Number(url.searchParams.get('limit') ?? 200)
      const [block, log] = (after ?? '').split(':')
      const from = after ? BigInt(block ?? 0) * 1_000_000n + BigInt(log ?? 0) : -1n
      const events = [...state.events]
        .sort((a, b) => Number(position(a) - position(b)))
        .filter((event) => position(event) > from)
        .slice(0, limit)
      const last = events.at(-1)
      return json(response, 200, { events, cursor: last ? `${last.blockNumber}:${last.logIndex}` : null })
    }
    const donation = /^\/donations\/(.+)$/.exec(url.pathname)
    if (donation?.[1]) {
      const track = state.tracks.get(decodeURIComponent(donation[1]))
      return track ? json(response, 200, track) : json(response, 404, { error: 'not found' })
    }
    const need = /^\/needs\/(.+)$/.exec(url.pathname)
    if (need?.[1]) {
      const detail = state.needs.get(decodeURIComponent(need[1]))
      return detail ? json(response, 200, detail) : json(response, 404, { error: 'not found' })
    }
    json(response, 404, { error: 'no route' })
  })
  return Object.assign(state, server)
}

// ─── webhook receiver / email API ───────────────────────────────────────────

export interface ReceivedRequest {
  path: string
  headers: IncomingHttpHeaders
  body: string
}

export interface FakeReceiver extends FakeServer {
  requests: ReceivedRequest[]
  status: number
}

export const startReceiver = async (status = 200): Promise<FakeReceiver> => {
  const state = { requests: [] as ReceivedRequest[], status }
  const server = await listen((request, response, body) => {
    state.requests.push({ path: request.url ?? '/', headers: request.headers, body })
    json(response, state.status, { ok: state.status < 300 })
  })
  return Object.assign(state, server)
}

// ─── fixtures ───────────────────────────────────────────────────────────────

const HASH = `0x${'ab'.repeat(32)}` as const
const TX = `0x${'cd'.repeat(32)}` as const
const NGO = '0x00000000000000000000000000000000000000a1' as const

export const needFixture = (id: string, overrides: Partial<NeedDetail> = {}): NeedDetail => ({
  id,
  ngo: NGO,
  ngoName: 'Test NGO',
  programId: '1',
  category: HASH,
  categoryLabel: 'FOOD',
  regionCode: HASH,
  regionLabel: 'ES-CM',
  country: 'ES',
  targetAmount: '5000000000',
  totalDonated: '1234560000',
  totalReleased: '0',
  totalRefunded: '0',
  fundingGap: '3765440000',
  status: 'Funding' as NeedStatus,
  custodyMode: 'OnChain',
  vault: '0x00000000000000000000000000000000000000b2',
  metadataURI: 'ipfs://need',
  verificationsRequired: 2,
  verificationCount: 2,
  fundingDeadline: null,
  executionDeadline: null,
  minFundingBps: 10_000,
  thirdPartyCostBps: 0,
  expectedOutcomeHash: HASH,
  costDisclosureHash: null,
  custodian: null,
  fundingFees: '0',
  settlementFees: '0',
  createdAt: 1_700_000_000,
  expiredAt: null,
  tranches: [],
  deliveries: [],
  donations: [],
  settlements: [],
  impactReport: null,
  ...overrides,
})

export const trackFixture = (
  ref: string,
  need: NeedDetail,
  reached: DonorStage[],
  outcome: DonationOutcome = 'InProgress',
): DonationTrack => ({
  ref,
  refKind: ref.startsWith('0x') ? 'payment' : 'receipt',
  donation: {
    id: `donation-${ref}`,
    needId: need.id,
    kind: 'DIRECT',
    donor: '0x00000000000000000000000000000000000000c3',
    donorRefHash: null,
    paymentRefHash: null,
    amount: '25000000',
    gross: null,
    fee: null,
    currency: null,
    receiptId: ref.startsWith('0x') ? null : ref,
    attestationUID: null,
    conversion: null,
    txHash: TX,
    timestamp: 1_700_000_100,
  },
  need,
  shareBps: 200,
  stages: DONOR_STAGES.map((stage) => ({
    stage,
    reached: reached.includes(stage),
    at: reached.includes(stage) ? 1_700_000_200 : null,
    txHash: reached.includes(stage) ? TX : null,
    attestationUID: reached.includes(stage) ? HASH : null,
    pending: null,
  })),
  currentStage: reached.at(-1) ?? null,
  outcome,
  releasedToNgo: '0',
  refunded: '0',
  tranches: [],
  deliveries: [],
  settlements: [],
  impactReport: null,
  deposit: null,
  updatedAt: 1_700_000_300,
})

export const eventFixture = (
  needId: string,
  blockNumber: number,
  logIndex: number,
  type: TimelineEventType,
): TimelineEvent => ({
  id: `evt-${blockNumber}-${logIndex}`,
  needId,
  type,
  data: { needId, amount: '1000000' },
  attestationUID: null,
  txHash: TX,
  blockNumber,
  logIndex,
  timestamp: 1_700_000_000 + blockNumber,
})
