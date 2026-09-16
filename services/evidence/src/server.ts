import { disconnect } from '@poa/shared/db'
import { buildApp } from './app.js'
import { loadConfig } from './config.js'

const config = loadConfig()
const app = await buildApp(config)

const shutdown = async (signal: string): Promise<void> => {
  app.log.info({ signal }, 'shutting down')
  await app.close()
  await disconnect()
  process.exit(0)
}

process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))

await app.listen({ port: config.port, host: config.host })
app.log.info({ docs: `http://localhost:${config.port}/docs` }, 'evidence service ready')
