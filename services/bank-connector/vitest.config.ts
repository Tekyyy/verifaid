import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // The suites drive one chain with the same role wallets (the provider's hot wallet above all): running files
    // in parallel would collide on nonces and on shared need state.
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 180_000,
  },
})
