import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // Hosted Windows runners can spend more than 5 seconds on SQLite file I/O.
    testTimeout: process.env.CI && process.platform === 'win32' ? 30_000 : 5_000
  },
  resolve: {
    alias: {
      '@core': resolve(__dirname, 'src/core')
    }
  }
})
