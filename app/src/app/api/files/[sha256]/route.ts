import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { NextResponse } from 'next/server'
import {
  EVIDENCE_TYPES,
  type EvidenceType,
  isSha256,
  safeFileName,
  sniffType,
} from '@/lib/server/evidenceFiles'
import { fetchPinned } from '@/lib/server/ipfs'
import { uploadDir } from '@/lib/server/uploadDir'

/**
 * An evidence file by its SHA-256. Immutable by construction — the address is the content — so it may be cached
 * forever. It is served with the type recorded at upload, and only ever one of the four evidence types: never
 * HTML, never anything a browser would run.
 *
 * When this server does not have the file (a new server, a lost disk) and the link names its IPFS CID, the file is
 * fetched from IPFS, checked against the SHA-256 the chain committed to, kept again, and served.
 */

export const runtime = 'nodejs'

/** Header values are Latin-1: an ASCII fallback for old clients, the real name (RFC 5987) for the rest. */
const contentDisposition = (name: string): string =>
  `inline; filename="${name.replace(/[^\x20-\x7e]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name)}`

const readLocal = async (path: string) => {
  try {
    const [bytes, meta] = await Promise.all([
      readFile(path),
      readFile(`${path}.json`, 'utf8').then((text) => JSON.parse(text) as { type?: string; name?: string }),
    ])
    return { bytes: new Uint8Array(bytes), meta }
  } catch {
    return null
  }
}

/** The file from IPFS, only if it is the one the chain committed to, kept here again for next time. */
const recoverFromIpfs = async (path: string, sha256: string, cid: string) => {
  const bytes = await fetchPinned(cid, sha256)
  const type = bytes ? sniffType(bytes) : null
  if (!bytes || !type) return null
  const meta = { type, name: sha256, cid }
  await mkdir(uploadDir(), { recursive: true })
  await writeFile(path, bytes).catch(() => undefined)
  await writeFile(`${path}.json`, JSON.stringify(meta)).catch(() => undefined)
  return { bytes, meta }
}

export async function GET(request: Request, { params }: { params: { sha256: string } }) {
  const sha256 = params.sha256.toLowerCase()
  if (!isSha256(sha256)) return NextResponse.json({ error: 'not_found' }, { status: 404 })

  const path = join(uploadDir(), sha256)
  const cid = new URL(request.url).searchParams.get('cid')
  const found = (await readLocal(path)) ?? (cid ? await recoverFromIpfs(path, sha256, cid) : null)
  if (!found) return NextResponse.json({ error: 'not_found' }, { status: 404 })
  const { bytes, meta } = found

  const type = EVIDENCE_TYPES.includes(meta.type as EvidenceType)
    ? (meta.type as string)
    : 'application/octet-stream'
  return new NextResponse(new Uint8Array(bytes), {
    headers: {
      'content-type': type,
      'content-length': String(bytes.length),
      'content-disposition': contentDisposition(safeFileName(meta.name ?? sha256)),
      'cache-control': 'public, max-age=31536000, immutable',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
    },
  })
}
