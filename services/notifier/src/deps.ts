import type { NotifierConfig } from './config.js'
import { type KekSource, loadKek } from './crypto.js'
import { createEmailDriver, type EmailDriver } from './email.js'
import { createIndexerClient, type IndexerClient } from './indexer.js'

/** Everything the routes and the worker share. Tests replace individual pieces (indexer, email driver, fetch). */
export interface NotifierDeps {
  config: NotifierConfig
  kek: Buffer
  kekSource: KekSource
  indexer: IndexerClient
  email: EmailDriver
  /** Used for outbound webhooks. */
  fetch: typeof fetch
  /** Called after a route queues a delivery, so the worker can send it without waiting for the next poll. */
  onEnqueued: () => void
}

export const createDeps = (config: NotifierConfig, overrides: Partial<NotifierDeps> = {}): NotifierDeps => {
  const kek = overrides.kek ? { key: overrides.kek, source: overrides.kekSource ?? 'env' } : loadKek(config)
  return {
    config,
    kek: kek.key,
    kekSource: kek.source,
    indexer:
      overrides.indexer ?? createIndexerClient(config.indexerUrl, { timeoutMs: config.indexerTimeoutMs }),
    email: overrides.email ?? createEmailDriver(config),
    fetch: overrides.fetch ?? fetch,
    onEnqueued: overrides.onEnqueued ?? (() => {}),
  }
}
