import path from 'node:path'

import { defineConfig, devices } from '@playwright/test'

const root = path.resolve(__dirname, '..')

export default defineConfig({
  testDir: path.join(__dirname, 'tests'),
  globalSetup: path.join(__dirname, 'global-setup.ts'),
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 12_000 },
  outputDir: path.join(root, 'artifacts/e2e/runtime/test-results'),
  preserveOutput: 'always',
  reporter: [
    ['line'],
    ['json', { outputFile: path.join(root, 'artifacts/e2e/runtime/results.json') }],
  ],
  use: {
    ...devices['Desktop Chrome'],
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
    screenshot: 'off',
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
  },
  projects: [{ name: 'hosted-chromium', use: { browserName: 'chromium' } }],
})
