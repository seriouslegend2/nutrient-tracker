import type { BrowserContext, Page, Response } from '@playwright/test'
import { expect, test } from '@playwright/test'

import { evidence } from '../support/evidence'
import { CUSTOMER_URL, required } from '../support/environment'

test.describe.serial('customer non-agent journey', () => {
  let context: BrowserContext
  let page: Page

  test.beforeAll(async ({ browser }) => {
    context = await browser.newContext({ viewport: { width: 430, height: 900 } })
    page = await context.newPage()
  })

  test.afterEach(async ({}, testInfo) => {
    if (testInfo.status !== testInfo.expectedStatus && page && !page.isClosed()) {
      await evidence(page, testInfo, `customer-failure-${testInfo.title}`).catch(() => undefined)
    }
  })

  test.afterAll(async () => context?.close())

  test('email login rejects an unsafe continuation and requires onboarding', async ({}, testInfo) => {
    await page.goto(`${CUSTOMER_URL}/home`)
    await expect(page).toHaveURL(/\/auth\/login\?next=%2Fhome/)

    await page.goto(`${CUSTOMER_URL}/auth/login?next=${encodeURIComponent('https://example.invalid/escape')}`)
    await page.getByLabel('Email').fill(required('E2E_EMAIL'))
    await page.getByLabel('Password').fill(required('E2E_PASSWORD'))
    await page.locator('form').getByRole('button', { name: 'Log in', exact: true }).click()

    await expect(page).toHaveURL(`${CUSTOMER_URL}/onboarding`)
    await expect(page.getByRole('heading', { name: 'About you' })).toBeVisible()
    expect(new URL(page.url()).origin).toBe(new URL(CUSTOMER_URL).origin)
    await evidence(page, testInfo, 'customer-01-login-onboarding-required')
  })

  test('onboarding validates required fields and completes the profile', async ({}, testInfo) => {
    await page.getByRole('button', { name: 'Continue' }).click()
    await expect(page.getByText('Select your sex to continue.', { exact: true })).toBeVisible()
    await page.getByText('Male', { exact: true }).click()
    await page.getByRole('button', { name: 'Continue' }).click()
    await expect(page.getByText('Enter your date of birth to continue.', { exact: true })).toBeVisible()
    await page.getByLabel('Date of birth (required)').fill('1990-06-15')
    await page.getByRole('button', { name: 'Continue' }).click()

    await expect(page.getByRole('heading', { name: 'Your body' })).toBeVisible()
    await page.getByRole('button', { name: 'Continue' }).click()
    await expect(page.getByText('Enter a height between 50 and 275 cm.', { exact: true })).toBeVisible()
    await page.getByLabel('Height (cm, required)').fill('175')
    await page.getByRole('button', { name: 'Continue' }).click()
    await expect(page.getByText('Enter a weight between 20 and 400 kg.', { exact: true })).toBeVisible()
    await page.getByLabel('Weight (kg, required)').fill('72')
    await page.getByLabel('Waist (cm, optional)').fill('82')
    await page.getByRole('button', { name: 'Continue' }).click()

    await expect(page.getByRole('heading', { name: 'How you eat' })).toBeVisible()
    await page.getByText('Vegetarian', { exact: true }).click()
    await page.getByLabel('Anything you avoid?').fill('peanuts')
    await page.getByRole('button', { name: 'Continue' }).click()

    await expect(page.getByRole('heading', { name: 'Your portions' })).toBeVisible()
    await page.getByText('1 katori', { exact: true }).first().click()
    await page.getByText('1 bowl', { exact: true }).click()
    await page.getByRole('button', { name: 'Continue' }).click()

    await expect(page.getByRole('heading', { name: 'Goal safety' })).toBeVisible()
    await page.getByRole('button', { name: 'Save and set a goal' }).click()
    await expect(page.getByRole('heading', { name: 'Set your first goal' })).toBeVisible()
    await evidence(page, testInfo, 'customer-02-onboarding-complete')
  })

  test('goal preview and creation reach the home dashboard', async ({}, testInfo) => {
    await page.getByLabel('Direction').selectOption('lose')
    await page.getByLabel('Amount (kg)').fill('3')
    await page.getByRole('button', { name: 'Preview goal' }).click()
    await expect(page.getByRole('heading', { name: 'Daily preview' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Create goal' })).toBeEnabled()
    await evidence(page, testInfo, 'customer-03-goal-preview')

    await page.getByRole('button', { name: 'Create goal' }).click()
    await expect(page).toHaveURL(`${CUSTOMER_URL}/home`)
    await expect(page.getByRole('heading', { name: 'Today' })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Macros' })).toBeVisible()
    await expect(page.getByText('Your goal')).toBeVisible()
    await evidence(page, testInfo, 'customer-04-home-with-goal')
  })

  test('manual free-text meal supports create, edit, and delete', async ({}, testInfo) => {
    const dish = `E2E free text ${Date.now()}`
    await page.goto(`${CUSTOMER_URL}/meals`)
    await expect(page.getByRole('heading', { name: 'Meals' })).toBeVisible()
    await page.getByRole('button', { name: '+ Add lunch' }).click()
    const form = page.getByRole('region', { name: 'Add manually' })
    await form.getByLabel('Dish').fill(dish)
    await form.getByLabel('Portions').fill('1.5')
    await form.getByLabel('Exact grams (optional)').fill('150')
    const createResponse = waitForMealMutation(page, 'POST')
    await form.getByRole('button', { name: 'Add meal', exact: true }).click()

    const createdId = await successfulMealId(await createResponse)
    let row = page.locator(`[data-meal-id="${createdId}"]`)
    await expect(row).toBeVisible()
    await evidence(page, testInfo, 'customer-05-free-text-meal-created')
    let rowButton = row.getByRole('button', { name: new RegExp(dish) })
    await rowButton.click()
    await row.getByRole('button', { name: 'Edit portion' }).click()
    await row.getByLabel('Portions').fill('2')
    await row.getByLabel('Exact grams').fill('200')
    const updateResponse = waitForMealMutation(page, 'PATCH')
    await row.getByRole('button', { name: 'Save', exact: true }).click()
    const updatedId = await successfulMealId(await updateResponse)
    row = page.locator(`[data-meal-id="${updatedId}"]`)
    rowButton = row.getByRole('button', { name: new RegExp(dish) })
    await expect(rowButton).toContainText('200 g')

    await rowButton.click()
    page.once('dialog', (dialog) => dialog.accept())
    await row.getByRole('button', { name: 'Remove' }).click()
    await expect(rowButton).toHaveCount(0)
  })

  test('seeded dish search and saved dish portion work when seed data exists', async ({}, testInfo) => {
    const response = await context.request.get(`${CUSTOMER_URL}/api/dishes/search?q=dal&page=1`)
    expect(response.ok(), await response.text()).toBeTruthy()
    const search = await response.json() as { items?: { name: string }[] }
    test.skip(!search.items?.length, 'Optional curated dish seed is not installed in the hosted project.')
    const selected = search.items![0].name

    await page.goto(`${CUSTOMER_URL}/meals`)
    await page.getByRole('button', { name: '+ Add dinner' }).click()
    const form = page.getByRole('region', { name: 'Add manually' })
    await form.getByLabel('Dish').fill('dal')
    await form.getByRole('button', { name: selected, exact: false }).first().click()
    await expect(form.getByText(/Your resolved portion:/)).toBeVisible()
    await form.getByLabel('Exact grams (optional)').fill('180')
    const createResponse = waitForMealMutation(page, 'POST')
    await form.getByRole('button', { name: 'Add meal', exact: true }).click()

    const createdId = await successfulMealId(await createResponse)
    let row = page.locator(`[data-meal-id="${createdId}"]`)
    await expect(row).toBeVisible()
    let rowButton = row.getByRole('button', { name: new RegExp(escapeRegex(selected)) })
    await rowButton.click()
    await row.getByRole('button', { name: 'Edit portion' }).click()
    await row.getByLabel('Exact grams').fill('200')
    await row.getByLabel(/Save these grams/).check()
    const updateResponse = waitForMealMutation(page, 'PATCH')
    await row.getByRole('button', { name: 'Save', exact: true }).click()
    const updatedId = await successfulMealId(await updateResponse)
    row = page.locator(`[data-meal-id="${updatedId}"]`)
    rowButton = row.getByRole('button', { name: new RegExp(escapeRegex(selected)) })
    await expect(rowButton).toContainText('200 g')
    await evidence(page, testInfo, 'customer-06-seeded-dish-and-portion')

    await rowButton.click()
    page.once('dialog', (dialog) => dialog.accept())
    await row.getByRole('button', { name: 'Remove' }).click()
    await expect(rowButton).toHaveCount(0)
  })

  test('water logging exposes recent history', async ({}, testInfo) => {
    await page.goto(`${CUSTOMER_URL}/home`)
    const water = page.getByRole('region', { name: 'Water' })
    await water.getByRole('button', { name: '+250 ml' }).click()
    await expect(water.getByText('Recent history')).toBeVisible()
    await water.getByText('Recent history').click()
    await expect(water.getByText(new Date().toISOString().slice(0, 10))).toBeVisible()
    await evidence(page, testInfo, 'customer-07-water-history')
  })

  test('analytics renders day, week, and month non-agent reports', async ({}, testInfo) => {
    await page.goto(`${CUSTOMER_URL}/analytics`)
    await expect(page.getByRole('heading', { name: 'Trends' })).toBeVisible()
    for (const heading of ['Calorie intake', 'Macros', 'Micronutrients']) {
      await expect(page.getByRole('heading', { name: heading })).toBeVisible()
    }
    await page.getByRole('button', { name: 'week' }).click()
    await page.getByRole('button', { name: 'month' }).click()
    await page.getByRole('button', { name: 'day' }).click()
    await evidence(page, testInfo, 'customer-08-analytics')
  })

  test('profile, weight, and category portion controls persist', async ({}, testInfo) => {
    await page.goto(`${CUSTOMER_URL}/about`)
    await expect(page.getByRole('heading', { name: 'You', exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Edit profile' }).click()
    await page.getByLabel('Diet', { exact: true }).fill('vegetarian')
    await page.getByLabel('Allergies, comma separated').fill('peanuts, sesame')
    await page.getByRole('button', { name: 'Save profile' }).click()
    await expect(page.getByText('vegetarian', { exact: true })).toBeVisible()

    await page.getByPlaceholder("Log today's weight (kg)").fill('71.5')
    await page.getByPlaceholder("Log today's weight (kg)").locator('..').getByRole('button', { name: 'Save' }).click()
    await expect(page.getByPlaceholder("Log today's weight (kg)")).toHaveValue('')

    const portionButton = page.getByRole('button', { name: /Dal \/ gravy/ }).first()
    await portionButton.click()
    const portionRow = portionButton.locator('..')
    const grams = portionRow.getByLabel('Grams')
    const current = Number(await grams.inputValue())
    await grams.fill(String(current + 1))
    await portionRow.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(portionButton).toContainText('yours')

    const deactivate = page.getByRole('button', { name: 'Deactivate' }).first()
    await expect(deactivate).toBeVisible()
    await deactivate.click()
    const activate = page.getByRole('button', { name: 'Activate' }).first()
    await expect(activate).toBeVisible()
    await activate.click()
    await expect(page.getByRole('button', { name: 'Deactivate' }).first()).toBeVisible()
    await expect(page.getByText(/Account export and account deletion are currently unavailable/)).toBeVisible()
    await evidence(page, testInfo, 'customer-09-profile-weight-portions')
  })

  test('logout clears the customer session', async () => {
    await page.getByRole('button', { name: 'Sign out' }).click()
    await expect(page).toHaveURL(`${CUSTOMER_URL}/auth/login`)
    await page.goto(`${CUSTOMER_URL}/home`)
    await expect(page).toHaveURL(/\/auth\/login\?next=%2Fhome/)
  })
})

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function waitForMealMutation(page: Page, method: 'POST' | 'PATCH'): Promise<Response> {
  return page.waitForResponse((response) => {
    const path = new URL(response.url()).pathname
    return response.request().method() === method &&
      (path === '/api/meals' || path.startsWith('/api/meals/'))
  })
}

async function successfulMealId(response: Response): Promise<string> {
  expect(response.ok(), `Meal mutation returned HTTP ${response.status()}`).toBeTruthy()
  const body = await response.json() as { id?: string }
  expect(body.id, 'Meal mutation did not return an id').toBeTruthy()
  return body.id!
}
