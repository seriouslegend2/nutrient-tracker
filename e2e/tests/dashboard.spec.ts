import type { BrowserContext, Page } from '@playwright/test'
import { expect, test } from '@playwright/test'

import { evidence } from '../support/evidence'
import { DASHBOARD_URL, nonAdminEmail, required } from '../support/environment'

test.describe.serial('dashboard non-agent journey', () => {
  let context: BrowserContext
  let page: Page

  test.beforeAll(async ({ browser }) => {
    context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
    page = await context.newPage()
  })

  test.afterEach(async ({}, testInfo) => {
    if (testInfo.status !== testInfo.expectedStatus && page && !page.isClosed()) {
      await evidence(page, testInfo, `dashboard-failure-${testInfo.title}`).catch(() => undefined)
    }
  })

  test.afterAll(async () => context?.close())

  test('admin email login enforces the gate and rejects an unsafe continuation', async ({}, testInfo) => {
    await page.goto(`${DASHBOARD_URL}/users`)
    await expect(page).toHaveURL(/\/auth\/login\?next=%2Fusers/)
    await page.goto(`${DASHBOARD_URL}/auth/login?next=${encodeURIComponent('//example.invalid/escape')}`)
    await page.getByLabel('Email address').fill(required('E2E_EMAIL'))
    await page.getByLabel('Password').fill(required('E2E_PASSWORD'))
    await page.getByRole('button', { name: 'Sign in' }).click()
    await expect(page).toHaveURL(`${DASHBOARD_URL}/users`)
    await expect(page.getByRole('heading', { name: 'Users' })).toBeVisible()
    expect(new URL(page.url()).origin).toBe(new URL(DASHBOARD_URL).origin)
    await evidence(page, testInfo, 'dashboard-01-admin-users')
  })

  test('metrics and user pagination controls load from the real admin API', async ({}, testInfo) => {
    await expect(page.getByText(/\d+ users/).first()).toBeVisible()
    await expect(page.getByText(/active meals \/ 7d/)).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Accounts' })).toBeVisible()
    await page.getByLabel('Per page').selectOption('20')
    await expect(page.getByText(/Page 1 of \d+/)).toBeVisible()

    const next = page.getByRole('button', { name: 'Next' }).first()
    if (await next.isEnabled()) {
      await next.click()
      await expect(page.getByText(/Page 2 of \d+/)).toBeVisible()
      await page.getByRole('button', { name: 'Previous' }).first().click()
      await expect(page.getByText(/Page 1 of \d+/)).toBeVisible()
    }
    await evidence(page, testInfo, 'dashboard-02-metrics-pagination')
  })

  test('overview and every non-agent user panel load', async ({}, testInfo) => {
    const email = required('E2E_EMAIL')
    await page.getByText(email, { exact: true }).first().click()
    await expect(page.getByText('Meal rows')).toBeVisible()
    await evidence(page, testInfo, 'dashboard-03-user-overview')

    for (const panel of [
      { label: 'Meal log', endpoint: '/meals', shot: 'dashboard-04-meal-panel' },
      { label: 'Goals', endpoint: '/goals', shot: 'dashboard-05-goals-panel' },
      { label: 'Preferences', endpoint: '/preferences', shot: 'dashboard-06-preferences-panel' },
    ]) {
      const response = page.waitForResponse((value) => value.url().includes('/api/admin/users/') && value.url().includes(panel.endpoint))
      await page.getByRole('button', { name: panel.label, exact: true }).click()
      expect((await response).ok()).toBeTruthy()
      await expect(page.getByText(new RegExp(`\\d+ ${panel.label.toLowerCase()} / Page`))).toBeVisible()
      await evidence(page, testInfo, panel.shot)
    }
  })

  test('dashboard logout clears the admin session', async () => {
    await page.getByRole('button', { name: 'Sign out' }).click()
    await expect(page).toHaveURL(`${DASHBOARD_URL}/auth/login`)
  })

  test('generated customer-only user is denied dashboard access', async ({ browser }, testInfo) => {
    const deniedContext = await browser.newContext({ viewport: { width: 900, height: 800 } })
    const deniedPage = await deniedContext.newPage()
    try {
      await deniedPage.goto(`${DASHBOARD_URL}/auth/login`)
      await deniedPage.getByLabel('Email address').fill(nonAdminEmail(required('E2E_EMAIL')))
      await deniedPage.getByLabel('Password').fill(required('E2E_PASSWORD'))
      await deniedPage.getByRole('button', { name: 'Sign in' }).click()
      await expect(deniedPage).toHaveURL(`${DASHBOARD_URL}/auth/denied`)
      await expect(deniedPage.getByRole('heading', { name: 'Administrator account required' })).toBeVisible()
      await evidence(deniedPage, testInfo, 'dashboard-07-non-admin-denied')
    } finally {
      await deniedContext.close()
    }
  })
})
