import assert from 'node:assert/strict'
import test from 'node:test'

import { flattenResults, normalizeStatus, projectRef, renderReport } from './generate-report.mjs'

test('projectRef exposes only the hosted project identifier', () => {
  assert.equal(projectRef('https://abc123.supabase.co'), 'abc123')
  assert.equal(projectRef(undefined), 'not provided')
})

test('flattenResults preserves pass, fail, and skip scenarios', () => {
  const report = { suites: [{ title: 'customer', specs: [
    { title: 'passes', tests: [{ projectName: 'chromium', results: [{ status: 'passed', duration: 10 }] }] },
    { title: 'skips', tests: [{ projectName: 'chromium', results: [{ status: 'skipped', duration: 0 }] }] },
    { title: 'fails', tests: [{ projectName: 'chromium', results: [{ status: 'timedOut', duration: 20, error: { message: 'timeout' } }] }] },
  ] }] }
  assert.deepEqual(flattenResults(report).map(({ status }) => status), ['passed', 'skipped', 'failed'])
  assert.equal(normalizeStatus('interrupted'), 'failed')
})

test('renderReport includes explicit status and blocker evidence', () => {
  const html = renderReport({
    scenarios: [{ title: 'onboarding', project: 'hosted', status: 'failed', duration: 3, error: '<missing>' }],
    screenshots: [],
    metadata: { status: 'failed', projectRef: 'abc', blocker: 'migration missing', environment: {} },
    generatedAt: '2026-08-16T00:00:00.000Z',
    exitCode: 1,
  })
  assert.match(html, /migration missing/)
  assert.match(html, /&lt;missing&gt;/)
  assert.match(html, /1<\/b> failed/)
})
