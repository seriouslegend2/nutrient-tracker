import { spawnSync } from 'node:child_process'
import path from 'node:path'

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const playwrightCli = path.join(root, 'node_modules/@playwright/test/cli.js')
const config = path.join(root, 'e2e/playwright.config.ts')
const reportScript = path.join(root, 'e2e/report/generate-report.mjs')

const run = spawnSync(process.execPath, [playwrightCli, 'test', `--config=${config}`, ...process.argv.slice(2)], {
  cwd: root,
  env: process.env,
  stdio: 'inherit',
})
const testExit = run.status ?? 1

const report = spawnSync(process.execPath, [reportScript], {
  cwd: root,
  env: { ...process.env, E2E_EXIT_CODE: String(testExit) },
  stdio: 'inherit',
})
const reportExit = report.status ?? 1

if (testExit !== 0) console.error(`Hosted E2E failed with exit code ${testExit}; a failure evidence report was still attempted.`)
if (reportExit !== 0) console.error(`Evidence report generation failed with exit code ${reportExit}.`)
process.exitCode = testExit || reportExit
