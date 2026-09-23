import { resolve } from 'node:path'

/**
 * Where evidence files live on this server: `UPLOAD_DIR`, or `.uploads` next to the app. A local directory is
 * enough for a single server; a deployment behind several instances, or on a read-only filesystem, points this at
 * shared storage. The hashes on chain do not change either way.
 */
export const uploadDir = (): string => resolve(process.env.UPLOAD_DIR ?? '.uploads')
