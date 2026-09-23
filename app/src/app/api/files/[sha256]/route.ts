import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { NextResponse } from 'next/server'
import { EVIDENCE_TYPES, type EvidenceType, isSha256, safeFileName } from '@/lib/server/evidenceFiles'
import { uploadDir } from '@/lib/server/uploadDir'

/**
 * An evidence file by its SHA-256. Immutable by construction — the address is the content — so it may be cached
 * forever. It is served with the type recorded at upload, and only ever one of the four evidence types: never
 * HTML, never anything a browser would run.
 */

export const runtime = 'nodejs'

/** Header values are Latin-1: an ASCII fallback for old clients, the real name (RFC 5987) for the rest. */
const contentDisposition = (name: string): string =>
  `inline; filename="${name.replace(/[^\x20-\x7e]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name)}`

export async function GET(_request: Request, { params }: { params: { sha256: string } }) {
  const sha256 = params.sha256.toLowerCase()
  if (!isSha256(sha256)) return NextResponse.json({ error: 'not_found' }, { status: 404 })

  const path = join(uploadDir(), sha256)
  let bytes: Buffer
  let meta: { type?: string; name?: string }
  try {
    ;[bytes, meta] = await Promise.all([
      readFile(path),
      readFile(`${path}.json`, 'utf8').then((text) => JSON.parse(text) as { type?: string; name?: string }),
    ])
  } catch {
    return NextResponse.json({ error: 'not_found' }, { status: 404 })
  }

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
