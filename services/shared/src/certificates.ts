import { type Address, getAddress, type Hex, isAddress, isHex } from 'viem'

/**
 * The EIP-712 certificate behind `BeneficiaryRegistry.createNeed`: an NGO certifies one wallet, within one of its
 * programmes, for a limited time. The NGO signs it off chain and hands it to the beneficiary — usually as a link —
 * and nothing reaches the chain until the beneficiary uses it to post a need. The contract rebuilds exactly this
 * message, so every signer (the NGO's browser, the demo) and every reader must use this one definition.
 */

/** Mirrors the `EIP712("VerifAid Beneficiaries", "1")` domain of BeneficiaryRegistry. */
export const CERTIFICATION_DOMAIN_NAME = 'VerifAid Beneficiaries'
export const CERTIFICATION_DOMAIN_VERSION = '1'

export const CERTIFICATION_TYPES = {
  Certification: [
    { name: 'beneficiary', type: 'address' },
    { name: 'ngo', type: 'address' },
    { name: 'programId', type: 'uint256' },
    { name: 'issuedAt', type: 'uint64' },
    { name: 'expiresAt', type: 'uint64' },
  ],
} as const

/** What the NGO app offers by default: long enough to write a need, short enough that a lost link expires. */
export const DEFAULT_CERTIFICATE_DAYS = 30
/** The longest the NGO app lets a certificate run. Revoking before expiry makes the wallet public; expiry does not. */
export const MAX_CERTIFICATE_DAYS = 365

export interface Certification {
  beneficiary: Address
  ngo: Address
  programId: bigint
  issuedAt: bigint
  expiresAt: bigint
}

/** A certificate as the beneficiary receives it: the message, the NGO's signature and where it can be used. */
export interface SignedCertificate {
  certification: Certification
  signature: Hex
  chainId: number
  /** The BeneficiaryRegistry the signature is bound to (its EIP-712 verifying contract). */
  registry: Address
}

export const certificationTypedData = (options: { chainId: number; registry: Address } & Certification) =>
  ({
    domain: {
      name: CERTIFICATION_DOMAIN_NAME,
      version: CERTIFICATION_DOMAIN_VERSION,
      chainId: options.chainId,
      verifyingContract: options.registry,
    },
    types: CERTIFICATION_TYPES,
    primaryType: 'Certification',
    message: {
      beneficiary: options.beneficiary,
      ngo: options.ngo,
      programId: options.programId,
      issuedAt: options.issuedAt,
      expiresAt: options.expiresAt,
    },
  }) as const

/** The certificate as `BeneficiaryRegistry.createNeed` takes it (a tuple in the ABI). */
export const certificationArgs = (c: Certification) => ({
  beneficiary: c.beneficiary,
  ngo: c.ngo,
  programId: c.programId,
  issuedAt: c.issuedAt,
  expiresAt: c.expiresAt,
})

// ─── sharing ────────────────────────────────────────────────────────────────

/** Version tag of the encoded form, so a link issued today still decodes after the format changes. */
const ENCODING_VERSION = 1

const toBase64Url = (text: string): string => {
  const base64 = typeof btoa === 'function' ? btoa(text) : Buffer.from(text, 'binary').toString('base64')
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

const fromBase64Url = (encoded: string): string => {
  const base64 = encoded.replace(/-/g, '+').replace(/_/g, '/')
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4)
  return typeof atob === 'function' ? atob(padded) : Buffer.from(padded, 'base64').toString('binary')
}

/**
 * A compact, URL-safe form of a signed certificate, for a link or a QR code. It holds no secret — only the
 * certified wallet can use it — but it does say which NGO certified that wallet, so it is for the beneficiary
 * alone, not for publishing.
 */
export const encodeCertificate = (signed: SignedCertificate): string => {
  const c = signed.certification
  const payload = [
    ENCODING_VERSION,
    signed.chainId,
    signed.registry,
    c.beneficiary,
    c.ngo,
    c.programId.toString(),
    c.issuedAt.toString(),
    c.expiresAt.toString(),
    signed.signature,
  ]
  return toBase64Url(JSON.stringify(payload))
}

const DECIMAL = /^\d+$/

/** Reads back `encodeCertificate`'s output, or explains why it cannot. Checks shape only; the chain checks the rest. */
export const decodeCertificate = (
  encoded: string,
): { ok: true; value: SignedCertificate } | { ok: false; error: string } => {
  let payload: unknown
  try {
    payload = JSON.parse(fromBase64Url(encoded.trim()))
  } catch {
    return { ok: false, error: 'This is not a certificate link.' }
  }
  if (!Array.isArray(payload) || payload[0] !== ENCODING_VERSION || payload.length !== 9) {
    return { ok: false, error: 'This certificate was made by a different version of the app.' }
  }
  const [, chainId, registry, beneficiary, ngo, programId, issuedAt, expiresAt, signature] = payload
  if (
    typeof chainId !== 'number' ||
    !isAddress(registry) ||
    !isAddress(beneficiary) ||
    !isAddress(ngo) ||
    typeof programId !== 'string' ||
    !DECIMAL.test(programId) ||
    typeof issuedAt !== 'string' ||
    !DECIMAL.test(issuedAt) ||
    typeof expiresAt !== 'string' ||
    !DECIMAL.test(expiresAt) ||
    !isHex(signature)
  ) {
    return { ok: false, error: 'This certificate link is damaged.' }
  }
  return {
    ok: true,
    value: {
      chainId,
      registry: getAddress(registry),
      signature,
      certification: {
        beneficiary: getAddress(beneficiary),
        ngo: getAddress(ngo),
        programId: BigInt(programId),
        issuedAt: BigInt(issuedAt),
        expiresAt: BigInt(expiresAt),
      },
    },
  }
}
