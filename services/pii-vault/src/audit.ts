import type { FastifyBaseLogger } from 'fastify'
import type { Address } from 'viem'

/**
 * Access audit for the records that actually contain people (spec §8.2). Every line names the actor, the record
 * id and the action — never a field of the record itself, because a log is the easiest place for personal data
 * to escape an encrypted store.
 */

export type AuditEvent =
  | 'beneficiary.created'
  | 'beneficiary.read'
  | 'beneficiary.listed'
  | 'beneficiary.shredded'
  | 'dossier.created'
  | 'dossier.read'
  | 'access.denied'

export interface AuditEntry {
  event: AuditEvent
  actor: Address
  /** Record id, program id or dossier hash — an identifier, never content. */
  subject?: string
  role?: string
  reason?: string
}

export const audit = (log: FastifyBaseLogger, entry: AuditEntry): void => {
  log.info({ ...entry, at: new Date().toISOString(), audit: true }, entry.event)
}
