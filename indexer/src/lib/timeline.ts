import type { Context } from 'ponder:registry'
import schema from 'ponder:schema'
import type { TimelineEventType } from '@poa/shared'
import type { Hex } from 'viem'

/** The subset of a Ponder event every handler in this project has, whatever contract it came from. */
export interface EventMeta {
  block: { number: bigint; timestamp: bigint }
  transaction: { hash: Hex }
  log: { logIndex: number }
}

export type TimelineData = Record<string, string | number | boolean | null>

/** (txHash, logIndex) is unique across the chain, so it doubles as a stable primary key. */
export const eventId = (event: EventMeta): string => `${event.transaction.hash}-${event.log.logIndex}`

export const seconds = (event: EventMeta): number => Number(event.block.timestamp)

/**
 * Appends one row to the need's story. Every state change calls this, which is what makes
 * `/needs/:id/timeline` a single ordered read instead of a join across eight tables.
 */
export const appendTimeline = async (
  context: Context,
  event: EventMeta,
  entry: {
    needId: bigint
    type: TimelineEventType
    data: TimelineData
    attestationUID?: Hex | null
  },
): Promise<void> => {
  await context.db
    .insert(schema.timelineEvent)
    .values({
      id: eventId(event),
      needId: entry.needId,
      type: entry.type,
      data: entry.data,
      attestationUID: entry.attestationUID ?? null,
      txHash: event.transaction.hash,
      blockNumber: event.block.number,
      logIndex: event.log.logIndex,
      timestamp: seconds(event),
    })
    .onConflictDoNothing()
}
