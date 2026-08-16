import fs from 'node:fs/promises'
import path from 'node:path'

import type { Page, TestInfo } from '@playwright/test'

const screenshotDir = path.resolve(__dirname, '../../artifacts/e2e/screenshots')

export async function evidence(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  await fs.mkdir(screenshotDir, { recursive: true })
  const safeName = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  const file = path.join(screenshotDir, `${safeName}.png`)
  await page.screenshot({ path: file, fullPage: true, animations: 'disabled' })
  await testInfo.attach(safeName, { path: file, contentType: 'image/png' })
}
