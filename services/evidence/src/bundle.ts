import { createHash } from 'node:crypto'
import { z } from 'zod'
import { type ImageFormat, stripImageMetadata } from './metadata.js'

/**
 * One delivery's evidence is a single JSON document — manifest plus files — encrypted as one blob. Encrypting
 * the whole bundle rather than each file keeps exactly one DEK per delivery, which is what a key grant shares
 * and what crypto-shredding destroys, and hides the file count and sizes from anyone holding the ciphertext.
 */

export const BUNDLE_VERSION = 1

export const ManifestSchema = z.object({
  /** Decimal delivery id, matching `DeliveryManager.getDelivery`. */
  deliveryId: z.string().regex(/^\d+$/, 'deliveryId must be a decimal integer'),
  itemsDelivered: z.coerce.number().int().positive().max(4_294_967_295),
  /** Coarse ISO 3166-2 subdivision, never GPS (spec §8.1). */
  regionCode: z.string().min(1).max(31),
  notes: z.string().max(4000).optional(),
})

export type Manifest = z.infer<typeof ManifestSchema>

export interface BundleFileInput {
  name: string
  contentType: string
  data: Buffer
}

/** Non-personal per-file record. Kept in the database so `/meta` can answer without touching the ciphertext. */
export interface BundleFileMeta {
  name: string
  contentType: string
  size: number
  /** sha256 of the stripped bytes, so a decrypted file can be checked against the manifest. */
  sha256: string
  format: ImageFormat
  removedMetadata: string[]
}

export interface StoredManifest {
  deliveryId: string
  itemsDelivered: number
  regionCode: string
  files: BundleFileMeta[]
  bundleVersion: number
}

export interface BuiltBundle {
  /** The plaintext that gets envelope-encrypted. */
  payload: Buffer
  /** What is safe to keep in the database and return from `/meta` — no notes, no file contents. */
  storedManifest: StoredManifest
  removedMetadata: string[]
}

const sanitizeFileName = (name: string): string =>
  name
    .replace(/[\\/]/g, '_')
    .replace(/[^\w.\- ]/g, '')
    .slice(0, 120) || 'file'

/**
 * Strips image metadata, then serialises manifest + files into the payload that will be sealed.
 *
 * `notes` stay inside the encrypted payload and never reach `storedManifest`: free text written in the field is
 * the most likely place for a beneficiary's name to appear, and the database copy is the one that is queried,
 * backed up and shown in `/meta`.
 */
export const buildBundle = (manifest: Manifest, files: BundleFileInput[]): BuiltBundle => {
  const removedMetadata: string[] = []
  const bundleFiles = files.map((file) => {
    const stripped = stripImageMetadata(file.data)
    const name = sanitizeFileName(file.name)
    for (const marker of stripped.removed) removedMetadata.push(`${name}:${marker}`)
    return {
      meta: {
        name,
        contentType: file.contentType,
        size: stripped.data.length,
        sha256: createHash('sha256').update(stripped.data).digest('hex'),
        format: stripped.format,
        removedMetadata: stripped.removed,
      } satisfies BundleFileMeta,
      data: stripped.data,
    }
  })

  const storedManifest: StoredManifest = {
    deliveryId: manifest.deliveryId,
    itemsDelivered: manifest.itemsDelivered,
    regionCode: manifest.regionCode,
    files: bundleFiles.map((file) => file.meta),
    bundleVersion: BUNDLE_VERSION,
  }

  const payload = Buffer.from(
    JSON.stringify({
      version: BUNDLE_VERSION,
      manifest: { ...manifest, files: storedManifest.files },
      files: bundleFiles.map((file) => ({ ...file.meta, data: file.data.toString('base64') })),
    }),
    'utf8',
  )

  return { payload, storedManifest, removedMetadata }
}

export interface DecodedBundle {
  version: number
  manifest: Manifest & { files: BundleFileMeta[] }
  files: (BundleFileMeta & { data: string })[]
}

export const decodeBundle = (payload: Buffer): DecodedBundle =>
  JSON.parse(payload.toString('utf8')) as DecodedBundle
