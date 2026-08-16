import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { chromium } from '@playwright/test'

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..')
const runtimeDir = path.join(root, 'artifacts/e2e/runtime')
const screenshotsDir = path.join(root, 'artifacts/e2e/screenshots')
const htmlFile = path.join(root, 'artifacts/e2e-report.html')
const pdfFile = path.join(root, 'artifacts/e2e-report.pdf')

export function projectRef(value) {
  if (!value) return 'not provided'
  try {
    const hostname = new URL(value).hostname
    return hostname.endsWith('.supabase.co') ? hostname.split('.')[0] : hostname
  } catch {
    return 'invalid URL'
  }
}

export function flattenResults(report) {
  const scenarios = []
  const visit = (suite, parents = []) => {
    const titles = [...parents, suite.title].filter(Boolean)
    for (const spec of suite.specs ?? []) {
      for (const entry of spec.tests ?? []) {
        const attempts = entry.results ?? []
        const last = attempts.at(-1)
        scenarios.push({
          title: [...titles, spec.title].join(' / '),
          project: entry.projectName ?? 'unknown',
          status: normalizeStatus(last?.status ?? (entry.status === 'skipped' ? 'skipped' : 'unknown')),
          duration: attempts.reduce((total, result) => total + (result.duration ?? 0), 0),
          error: last?.error?.message ?? last?.errors?.map((error) => error.message).filter(Boolean).join('\n') ?? '',
        })
      }
    }
    for (const child of suite.suites ?? []) visit(child, titles)
  }
  for (const suite of report?.suites ?? []) visit(suite)
  return scenarios
}

export function normalizeStatus(value) {
  if (value === 'passed') return 'passed'
  if (value === 'skipped') return 'skipped'
  return 'failed'
}

export function renderReport({ scenarios, screenshots, metadata, generatedAt, exitCode }) {
  const counts = scenarios.reduce((result, scenario) => {
    result[scenario.status] += 1
    return result
  }, { passed: 0, failed: 0, skipped: 0 })
  const setup = metadata.status ?? 'not run'
  const runStatus = scenarios.length > 0 && exitCode === 0 && counts.failed === 0 && setup === 'ready'
    ? 'passed'
    : setup === 'failed' || exitCode !== 0 ? 'failed' : 'not run'
  const environment = metadata.environment ?? {}

  const rows = scenarios.map((scenario) => `
    <tr>
      <td><strong>${escapeHtml(scenario.title)}</strong><small>${escapeHtml(scenario.project)} / ${(scenario.duration / 1000).toFixed(1)}s</small></td>
      <td><span class="status ${scenario.status}">${scenario.status}</span></td>
      <td>${scenario.error ? `<pre>${escapeHtml(scenario.error)}</pre>` : '<span class="muted">No error recorded</span>'}</td>
    </tr>`).join('')

  const gallery = screenshots.length
    ? screenshots.map((shot) => `<figure><img src="data:${shot.mime};base64,${shot.data}" alt="${escapeHtml(shot.name)}"><figcaption>${escapeHtml(shot.name)}</figcaption></figure>`).join('')
    : '<p class="empty">No stage screenshots were captured. A setup failure may have occurred before Chromium reached the product.</p>'

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Nutrient Tracker E2E Evidence</title><style>
@page{size:A4;margin:14mm}*{box-sizing:border-box}body{margin:0;color:#17211b;background:#f2f5ef;font:13px/1.5 Inter,ui-sans-serif,system-ui,sans-serif}main{max-width:1100px;margin:auto;padding:42px}.hero{padding:34px;border-radius:18px;background:#172c21;color:#f4f7f0}.eyebrow{margin:0;color:#a9cfaa;font-size:11px;font-weight:700;letter-spacing:.14em;text-transform:uppercase}h1{margin:8px 0 10px;font:700 34px/1.1 Georgia,serif}.lede{max-width:760px;color:#d2ded2}.meta,.counts{display:flex;flex-wrap:wrap;gap:8px;margin-top:20px}.pill,.count{padding:7px 10px;border:1px solid #456050;border-radius:999px;font-size:11px}.run{color:#17211b;background:#a9cfaa;border-color:#a9cfaa}.section{margin-top:26px;padding:24px;border:1px solid #d5ddd1;border-radius:14px;background:#fff}h2{margin:0 0 14px;font:700 22px/1.2 Georgia,serif}.blocker{padding:12px;border-left:4px solid #b14334;background:#fff1ee;color:#7d291e;white-space:pre-wrap}.count{border-color:#d5ddd1}.count b{font-size:16px}.passed{color:#246b3d}.failed{color:#a43d30}.skipped{color:#866319}table{width:100%;border-collapse:collapse}th,td{padding:10px;border-bottom:1px solid #e2e7df;text-align:left;vertical-align:top}th{font-size:10px;letter-spacing:.1em;text-transform:uppercase}.status{font-weight:700;text-transform:uppercase;font-size:10px}.muted,small{display:block;color:#6f786f}pre{max-width:520px;margin:0;white-space:pre-wrap;color:#8b3026;font:10px/1.4 ui-monospace,monospace}.gallery{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}figure{break-inside:avoid;margin:0;padding:8px;border:1px solid #d5ddd1;border-radius:10px}img{display:block;width:100%;max-height:520px;object-fit:contain;object-position:top;background:#eef2eb}figcaption{padding:8px 2px 2px;color:#596459;font-size:11px}.empty{color:#6f786f}@media(max-width:700px){main{padding:16px}.gallery{grid-template-columns:1fr}}@media print{body{background:#fff}main{padding:0}.section{break-inside:auto}.hero{break-inside:avoid}}
</style></head><body><main>
<header class="hero"><p class="eyebrow">Hosted browser evidence</p><h1>Nutrient Tracker E2E</h1><p class="lede">Real Chromium journeys through the customer application, internal dashboard, FastAPI BFF path, Supabase Auth, and hosted PostgREST. Agent and media surfaces are intentionally outside this report.</p>
<div class="meta"><span class="pill run">Run ${runStatus}</span><span class="pill">Setup ${escapeHtml(setup)}</span><span class="pill">Project ${escapeHtml(metadata.projectRef ?? 'not provided')}</span><span class="pill">Generated ${escapeHtml(generatedAt)}</span></div></header>
<section class="section"><h2>Environment</h2><p>Customer: <code>${escapeHtml(environment.customer ?? process.env.E2E_CUSTOMER_URL ?? 'http://127.0.0.1:3000')}</code><br>Dashboard: <code>${escapeHtml(environment.dashboard ?? process.env.E2E_DASHBOARD_URL ?? 'http://127.0.0.1:3001')}</code><br>Backend: <code>${escapeHtml(environment.backend ?? process.env.E2E_BACKEND_URL ?? 'http://127.0.0.1:8000')}</code><br>Playwright exit code: <code>${escapeHtml(String(exitCode))}</code></p>${metadata.blocker ? `<div class="blocker"><strong>Hosted blocker</strong>\n${escapeHtml(metadata.blocker)}</div>` : ''}</section>
<section class="section"><h2>Scenario Results</h2><div class="counts"><span class="count passed"><b>${counts.passed}</b> passed</span><span class="count failed"><b>${counts.failed}</b> failed</span><span class="count skipped"><b>${counts.skipped}</b> skipped</span></div><table><thead><tr><th>Scenario</th><th>Status</th><th>Evidence / failure</th></tr></thead><tbody>${rows || '<tr><td>Hosted suite did not begin</td><td><span class="status failed">failed</span></td><td>See setup blocker above.</td></tr>'}</tbody></table></section>
<section class="section"><h2>Stage Screenshots</h2><div class="gallery">${gallery}</div></section>
</main></body></html>`
}

export async function generate() {
  await fs.mkdir(runtimeDir, { recursive: true })
  const [rawResults, rawMetadata, screenshots] = await Promise.all([
    readJson(path.join(runtimeDir, 'results.json'), { suites: [] }),
    readJson(path.join(runtimeDir, 'run-metadata.json'), {}),
    readScreenshots(screenshotsDir),
  ])
  const exitCode = Number(process.env.E2E_EXIT_CODE ?? (rawMetadata.status === 'failed' ? 1 : 0))
  let scenarios = flattenResults(rawResults)
  if (!scenarios.length && exitCode !== 0) {
    scenarios = [{ title: 'Hosted setup and service readiness', project: 'global setup', status: 'failed', duration: 0, error: rawMetadata.blocker ?? 'The Playwright process exited before scenarios were recorded.' }]
  }
  const secrets = [process.env.SUPABASE_SERVICE_ROLE_KEY, process.env.E2E_PASSWORD].filter(Boolean)
  const sanitizedMetadata = JSON.parse(redact(JSON.stringify(rawMetadata), secrets))
  const sanitizedScenarios = scenarios.map((scenario) => ({ ...scenario, error: redact(scenario.error, secrets) }))
  const html = renderReport({ scenarios: sanitizedScenarios, screenshots, metadata: sanitizedMetadata, generatedAt: new Date().toISOString(), exitCode })
  await fs.writeFile(htmlFile, html)

  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage()
    await page.setContent(html, { waitUntil: 'load' })
    await page.pdf({ path: pdfFile, format: 'A4', printBackground: true, displayHeaderFooter: true,
      headerTemplate: '<span></span>', footerTemplate: '<div style="width:100%;font-size:8px;color:#687268;text-align:center"><span class="pageNumber"></span> / <span class="totalPages"></span></div>' })
  } finally {
    await browser.close()
  }
  console.log(`Evidence report: ${htmlFile}`)
  console.log(`Evidence PDF:    ${pdfFile}`)
}

async function readJson(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')) } catch { return fallback }
}

async function readScreenshots(directory) {
  try {
    const names = (await fs.readdir(directory)).filter((name) => name.endsWith('.png')).sort()
    return Promise.all(names.map(async (name) => ({ name, mime: 'image/png', data: (await fs.readFile(path.join(directory, name))).toString('base64') })))
  } catch { return [] }
}

function redact(value, secrets) {
  return secrets.reduce((result, secret) => result.replaceAll(secret, '[REDACTED]'), value)
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character])
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  generate().catch((error) => {
    console.error(`Report generation failed: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  })
}
