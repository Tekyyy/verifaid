import createNextIntlPlugin from 'next-intl/plugin'

const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts')

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Biome lints the whole monorepo from the root; Next's own ESLint pass is not configured here.
  eslint: { ignoreDuringBuilds: true },
  webpack: (config, { isServer, webpack }) => {
    // `wagmi/connectors` is a barrel that also pulls in the Base Account connector, whose dependency chain
    // (@base-org/account → @coinbase/cdp-sdk → @x402/*) is not installed. This app only uses the Coinbase
    // Smart Wallet and injected connectors, so the unused branch is stubbed out rather than installed.
    config.resolve.alias = {
      ...config.resolve.alias,
      '@base-org/account': false,
      '@coinbase/cdp-sdk': false,
    }

    if (!isServer) {
      // `@poa/shared` re-exports a Node-only auth module (`node:crypto`) that the browser never calls, and
      // snarkjs references Node built-ins on code paths the browser build never takes. Rewriting the `node:`
      // scheme lets the usual `resolve.fallback` stubs apply to both.
      config.plugins.push(
        new webpack.NormalModuleReplacementPlugin(/^node:/, (resource) => {
          resource.request = resource.request.replace(/^node:/, '')
        }),
      )
      config.resolve.fallback = {
        ...config.resolve.fallback,
        crypto: false,
        fs: false,
        path: false,
        readline: false,
        constants: false,
        worker_threads: false,
      }
    }
    return config
  },
}

export default withNextIntl(nextConfig)
