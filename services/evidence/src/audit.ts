import type { FastifyBaseLogger } from 'fastify'
import type { Address } from 'viem'

/**
 * Access audit (spec §8.2). Every read of an evidence bundle is recorded as one structured line: who, which
 * content address, when, and on what authority. Deliberately field-by-field rather than a free-form message so
 * a payload can never be appended by accident — the whole point of the log is that it contains no evidence.
 */

export type AuditEvent =
  | 'evidence.uploaded'
  | 'evidence.accessed'
  | 'evidence.access_denied'
  | 'evidence.grant_created'
  | 'evidence.meta_read'

export interface AuditEntry {
  event: AuditEvent
  cid: string
  actor: Address
  role?: string
  deliveryId?: string
  reason?: string
}

export const audit = (log: FastifyBaseLogger, entry: AuditEntry): void => {
  log.info({ ...entry, at: new Date().toISOString(), audit: true }, entry.event)
}
