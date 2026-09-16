import { disconnect } from '@poa/shared/db'
import { buildApp } from './app.js'
import { loadConfig } from './config.js'
import { createDeps } from './deps.js'
import { createWorker } from './worker/index.js'

const config = loadConfig()
const deps = createDeps(config)
const app = await buildApp(deps)
const worker = createWorker(deps, app.log.child({ component: 'worker' }))
deps.onEnqueued = () => worker.kick()

let shuttingDown = false
const shutdown = async (signal: string): Promise<void> => {
  if (shuttingDown) return
  shuttingDown = true
  app.log.info({ signal }, 'shutting down')
  await worker.stop()
  await app.close()
  await disconnect()
  process.exit(0)
}

process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))

await app.listen({ port: config.port, host: config.host })
if (config.workerEnabled) {
  worker.start()
  app.log.info({ indexer: config.indexerUrl, pollMs: config.pollMs }, 'worker started')
} else {
  app.log.warn('NOTIFIER_WORKER=off: no timeline polling and no deliveries are sent by this process')
}
app.log.info({ docs: `http://localhost:${config.port}/docs` }, 'notifier service ready')
