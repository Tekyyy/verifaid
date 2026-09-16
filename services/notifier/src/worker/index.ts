import type { FastifyBaseLogger } from 'fastify'
import type { NotifierDeps } from '../deps.js'
import { dispatchDue } from './dispatcher.js'
import { pollOnce } from './poller.js'

/**
 * The background loop: poll the timeline, then dispatch due deliveries, then sleep `NOTIFIER_POLL_MS`. Ticks never
 * overlap; `kick()` asks for an extra tick as soon as the current one ends (used right after a subscription queues
 * its confirmation email). `stop()` waits for an in-flight tick, so a SIGTERM never abandons a half-sent batch.
 */

export interface Worker {
  start(): void
  stop(): Promise<void>
  kick(): void
  /** One poll + dispatch cycle, for tests and scripts. */
  tick(): Promise<void>
}

export const createWorker = (deps: NotifierDeps, log: FastifyBaseLogger): Worker => {
  let stopped = true
  let timer: NodeJS.Timeout | undefined
  let running: Promise<void> | undefined
  let rerun = false
  const lastError = { poll: undefined as string | undefined, dispatch: undefined as string | undefined }

  /** Logs a failure once per distinct message, not every interval while the indexer or database is down. */
  const failed = (step: 'poll' | 'dispatch', error: unknown, message: string): void => {
    const reason = error instanceof Error ? error.message : String(error)
    if (reason !== lastError[step]) log.warn({ err: reason }, message)
    lastError[step] = reason
  }
  const recovered = (step: 'poll' | 'dispatch'): void => {
    if (lastError[step]) log.info(`${step} recovered`)
    lastError[step] = undefined
  }

  const tick = async (): Promise<void> => {
    try {
      const polled = await pollOnce({ config: deps.config, indexer: deps.indexer, log })
      recovered('poll')
      if (polled.events > 0) log.info(polled, 'timeline polled')
    } catch (error) {
      failed('poll', error, 'timeline poll failed; cursor not advanced')
    }
    try {
      const dispatched = await dispatchDue({ ...deps, log })
      recovered('dispatch')
      if (dispatched.sent + dispatched.retrying + dispatched.failed > 0) {
        log.info(dispatched, 'deliveries dispatched')
      }
    } catch (error) {
      failed('dispatch', error, 'dispatch failed')
    }
  }

  const schedule = (delay: number): void => {
    if (stopped) return
    clearTimeout(timer)
    timer = setTimeout(run, delay)
  }

  const run = (): void => {
    if (running) {
      rerun = true
      return
    }
    running = tick().finally(() => {
      running = undefined
      const again = rerun
      rerun = false
      schedule(again ? 0 : deps.config.pollMs)
    })
  }

  return {
    start: () => {
      if (!stopped) return
      stopped = false
      schedule(0)
    },
    stop: async () => {
      stopped = true
      clearTimeout(timer)
      await running
    },
    kick: () => {
      if (stopped) return
      if (running) rerun = true
      else schedule(0)
    },
    tick,
  }
}
