import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['e2e/**/*.scenario.test.ts'],
    // The scenarios share one stack and one set of counters. They must run one
    // at a time, in file order.
    fileParallelism: false,
    sequence: { concurrent: false },
    globalSetup: ['./e2e/globalSetup.ts'],
    testTimeout: 120_000,
    hookTimeout: 60_000,
  },
})
