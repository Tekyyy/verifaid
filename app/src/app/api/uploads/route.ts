import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { MAX_EVIDENCE_FILES } from '@poa/shared'
import { type NextRequest, NextResponse } from 'next/server'
import { MAX_FILE_BYTES, safeFileName, sha256Hex, sniffType, stripMetadata } from '@/lib/server/evidenceFiles'
import { isCid, pinFile } from '@/lib/server/ipfs'
import { badRequest } from '@/lib/server/proxy'
import { clientIp, createRateLimiter } from '@/lib/server/rateLimit'
import { uploadDir } from '@/lib/server/uploadDir'

/**
 * Evidence uploads for deliveries: photos, receipts and bank statements. Each file is checked by its first bytes
 * (JPEG, PNG, WebP or PDF, whatever the browser says), stripped of photo metadata, and stored under its SHA-256,
 * which is what the NGO then commits to on chain. Anyone can read them back at `/api/files/<sha256>`: they are
 * shown to every donor, which is the point — so the NGO is told to redact account numbers and names first.
 *
 * With `PINATA_JWT` set, each file is also pinned to IPFS and its CID returned with it, so the manifest can name
 * where the file lives beyond this server; the file link then carries the CID too, so this server can fetch the
 * file back from IPFS if it ever loses its own copy.
 *
 * Nothing here is signed or trusted: until the NGO submits a manifest naming these hashes, a file is just bytes.
 */

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const perIp = createRateLimiter({ name: 'uploads:perIp', windowMs: 10 * 60_000, max: 60 })

export interface UploadedFile {
  name: string
  type: string
  size: number
  sha256: string
  /** IPFS content identifier, when the file was pinned. */
  cid?: string
  url: string
}

interface Sidecar {
  type: string
  name: string
  cid?: string
}

const readSidecar = async (path: string): Promise<Sidecar | null> =>
  readFile(`${path}.json`, 'utf8').then(
    (text) => JSON.parse(text) as Sidecar,
    () => null,
  )

export async function POST(request: NextRequest) {
  let form: FormData
  try {
    form = await request.formData()
  } catch {
    return badRequest('Send the files as multipart/form-data under "files".')
  }
  const files = form.getAll('files').filter((value): value is File => value instanceof File)
  if (files.length === 0) return badRequest('No files.')
  if (files.length > MAX_EVIDENCE_FILES) return badRequest(`At most ${MAX_EVIDENCE_FILES} files at once.`)
  if (await perIp(clientIp(request))) {
    return NextResponse.json(
      { error: 'rate_limited', message: 'Too many uploads; try again later.' },
      { status: 429 },
    )
  }

  const dir = uploadDir()
  await mkdir(dir, { recursive: true })

  const stored: UploadedFile[] = []
  for (const file of files) {
    if (file.size > MAX_FILE_BYTES) {
      return badRequest(`${safeFileName(file.name)} is larger than ${MAX_FILE_BYTES / 1024 / 1024} MB.`)
    }
    const raw = new Uint8Array(await file.arrayBuffer())
    const type = sniffType(raw)
    if (!type) return badRequest(`${safeFileName(file.name)} is not a JPEG, PNG, WebP or PDF file.`)

    const bytes = stripMetadata(raw, type)
    const sha256 = sha256Hex(bytes)
    const path = join(dir, sha256)
    const name = safeFileName(file.name)
    // Content-addressed: the same bytes are the same file, so an existing one is kept, and so is its CID.
    const existing = await readSidecar(path)
    let cid = existing?.cid && isCid(existing.cid) ? existing.cid : undefined
    if (!cid) cid = (await pinFile(bytes, name, type)) ?? undefined
    if (!existing || existing.cid !== cid) {
      await writeFile(path, bytes)
      await writeFile(
        `${path}.json`,
        JSON.stringify({ type, name, ...(cid ? { cid } : {}) } satisfies Sidecar),
      )
    }
    stored.push({
      name,
      type,
      size: bytes.length,
      sha256,
      ...(cid ? { cid } : {}),
      url: cid ? `/api/files/${sha256}?cid=${cid}` : `/api/files/${sha256}`,
    })
  }

  return NextResponse.json({ files: stored }, { status: 201 })
}
