import { randomBytes } from 'node:crypto'
import type { Address, PublicClient } from 'viem'
import { createSiweMessage, parseSiweMessage, verifySiweMessage } from 'viem/siwe'
import { hmac, safeEqual } from './crypto.js'

/**
 * Wallet authentication for the services: the caller proves control of an address with a SIWE signature, the
 * service checks that address's role **on-chain**, and issues a short-lived HMAC session token.
 * Nothing about the caller is trusted from the request body.
 */

export const SESSION_TTL_SECONDS = 60 * 60

export interface SessionPayload {
  address: Address
  /** Unix seconds. */
  exp: number
}

export const createNonce = (): string => randomBytes(16).toString('hex')

export interface SiweChallenge {
  domain: string
  uri: string
  address: Address
  chainId: number
  nonce: string
  statement: string
}

export const buildSiweMessage = (challenge: SiweChallenge): string =>
  createSiweMessage({
    domain: challenge.domain,
    address: challenge.address,
    statement: challenge.statement,
    uri: challenge.uri,
    version: '1',
    chainId: challenge.chainId,
    nonce: challenge.nonce,
    issuedAt: new Date(),
  })

export interface VerifySiweParams {
  client: PublicClient
  message: string
  signature: `0x${string}`
  domain: string
  nonce: string
}

/** Verifies a SIWE signature (EOA or ERC-1271 smart account) and returns the address that signed it. */
export const verifySiwe = async (params: VerifySiweParams): Promise<Address> => {
  const fields = parseSiweMessage(params.message)
  if (!fields.address) throw new Error('SIWE message has no address')
  const valid = await verifySiweMessage(params.client, {
    message: params.message,
    signature: params.signature,
    domain: params.domain,
    nonce: params.nonce,
  })
  if (!valid) throw new Error('invalid SIWE signature')
  return fields.address
}

const encode = (value: object): string => Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')

/** `base64url(payload).base64url(hmac)` — small, stateless, and verifiable without a session store. */
export const createSessionToken = (secret: string, address: Address, ttlSeconds = SESSION_TTL_SECONDS): string => {
  const payload: SessionPayload = { address, exp: Math.floor(Date.now() / 1000) + ttlSeconds }
  const body = encode(payload)
  return `${body}.${hmac(secret, body).toString('base64url')}`
}

export const verifySessionToken = (secret: string, token: string): SessionPayload | null => {
  const [body, signature] = token.split('.')
  if (!body || !signature) return null
  if (!safeEqual(Buffer.from(signature, 'base64url'), hmac(secret, body))) return null
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as SessionPayload
    if (typeof payload.exp !== 'number' || payload.exp < Math.floor(Date.now() / 1000)) return null
    return payload
  } catch {
    return null
  }
}

/** Verifies an HMAC webhook signature of the form `sha256=<hex>`. */
export const verifyWebhookSignature = (secret: string, rawBody: string, header: string | undefined): boolean => {
  if (!header) return false
  const expected = `sha256=${hmac(secret, rawBody).toString('hex')}`
  return safeEqual(expected, header)
}
