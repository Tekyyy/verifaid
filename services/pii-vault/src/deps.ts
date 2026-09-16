import type { Chain } from './chain.js'
import type { VaultConfig } from './config.js'

/** Everything a route group needs: configuration, chain access and the master key records are sealed under. */
export interface RouteDeps {
  config: VaultConfig
  chain: Chain
  masterKey: Buffer
}
