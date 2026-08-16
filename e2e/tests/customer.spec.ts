import type { BrowserContext, Page, Response } from '@playwright/test'
import { expect, test } from '@playwright/test'

import { evidence } from '../support/evidence'
import { CUSTOMER_URL, required } from '../support/environment'
import { installCustomerSession } from '../support/customer-auth'

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

  test('Google login rejects an unsafe continuation and requires onboarding', async ({}, testInfo) => {
    await page.goto(`${CUSTOMER_URL}/home`)
    await expect(page).toHaveURL(/\/auth\/login\?next=%2Fhome/)

    await page.goto(`${CUSTOMER_URL}/auth/login?next=${encodeURIComponent('https://example.invalid/escape')}`)
    await expect(page.getByRole('link', { name: 'Continue with Google' }))
      .toHaveAttribute('href', '/api/auth/google?next=%2Fhome')
    await installCustomerSession(context, required('E2E_EMAIL'), required('E2E_PASSWORD'))
    await page.goto(`${CUSTOMER_URL}/home`)

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

    await expect(page.getByRole('heading', { name: 'Your usual portions' })).toBeVisible()
    await page.getByText('1 katori', { exact: true }).first().click()
    await page.getByText('1 bowl', { exact: true }).click()
    await page.getByRole('button', { name: 'Continue' }).click()

    await expect(page.getByRole('heading', { name: 'Goal safety' })).toBeVisible()
    await page.getByRole('button', { name: 'Save and set a goal' }).click()
    await expect(page.getByRole('heading', { name: 'Set your first goal' })).toBeVisible()
    await evidence(page, testInfo, 'customer-02-onboarding-complete')
  })

  test('goal preview and creation reach the home dashboard', async ({}, testInfo) => {
    await page.getByRole('radio', { name: /Weight/ }).click()
    await page.getByLabel('Direction').selectOption('lose')
    await page.getByLabel('Amount (kg)').fill('3')
    await page.getByRole('button', { name: 'Preview goal' }).click()
    await expect(page.getByRole('heading', { name: 'Goal preview' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Add a goal' })).toBeEnabled()
    await evidence(page, testInfo, 'customer-03-goal-preview')

    await page.getByRole('button', { name: 'Add a goal' }).click()
    await expect(page).toHaveURL(`${CUSTOMER_URL}/home`)
    await expect(page.getByRole('heading', { name: 'Today', exact: true })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Turn a plate into a draft' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Take meal photo' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Upload PDF' })).toBeVisible()
    await expect(page.locator('input[type="file"][capture="environment"]')).toHaveAttribute('accept', 'image/*')
    await expect(page.locator('input[type="file"][accept="application/pdf"]')).toHaveCount(1)
    const todayNutrition = page.getByRole('region', { name: "Today's nutrition" })
    await expect(todayNutrition.getByText('consumed today')).toBeVisible()
    await expect(todayNutrition).not.toContainText('left today')
    await expect(page.getByRole('heading', { name: 'Goals' })).toBeVisible()
    await expect(page.getByRole('tab', { name: /Lose 3 kg/ })).toBeVisible()
    const goalPanel = page.getByRole('tabpanel')
    await expect(goalPanel.getByRole('heading', { name: 'Calories', exact: true })).toBeVisible()
    await expect(goalPanel.getByRole('heading', { name: 'Protein', exact: true })).toBeVisible()
    await expect(goalPanel.getByRole('heading', { name: 'Carbs', exact: true })).toBeVisible()
    await expect(goalPanel.getByRole('heading', { name: 'Fat', exact: true })).toBeVisible()
    await expect(goalPanel.getByRole('progressbar')).toHaveCount(8)
    await expect(goalPanel.getByText('Today', { exact: true }).first()).toBeVisible()
    await expect(goalPanel.getByText('Period', { exact: true }).first()).toBeVisible()
    await evidence(page, testInfo, 'customer-04-home-with-goal')
  })

  test('multiple safe goals and explicit training check-ins stay independent', async ({}, testInfo) => {
    const dailyNutrients = [
      { type: /Calories/, field: 'Calories (kcal per day)', value: '2100', tab: 'Daily calories' },
      { type: /Protein/, field: 'Protein (grams per day)', value: '20', tab: 'Daily protein' },
      { type: /Carbs/, field: 'Carbs (grams per day)', value: '250', tab: 'Daily carbs' },
      { type: /Fat/, field: 'Fat (grams per day)', value: '65', tab: 'Daily fat' },
    ]
    for (const nutrient of dailyNutrients) {
      await page.goto(`${CUSTOMER_URL}/goals/new`)
      await page.getByRole('radio', { name: nutrient.type }).click()
      await page.getByLabel(nutrient.field).fill(nutrient.value)
      await page.getByRole('button', { name: 'Preview goal' }).click()
      await expect(page.getByRole('heading', { name: 'Goal preview' })).toBeVisible()
      await page.getByRole('button', { name: 'Add a goal' }).click()
      await expect(page.getByRole('tab', { name: nutrient.tab })).toBeVisible()
    }

    await page.goto(`${CUSTOMER_URL}/goals/new`)
    await page.getByRole('radio', { name: /Hydration/ }).click()
    await page.getByLabel('Water (ml per day)').fill('10000')
    await expect(page.getByRole('button', { name: 'Preview goal' })).toBeDisabled()
    await page.getByLabel('Water (ml per day)').fill('2000')
    await page.getByRole('button', { name: 'Preview goal' }).click()
    await page.getByRole('button', { name: 'Add a goal' }).click()
    const hydrationTab = page.getByRole('tab', { name: 'Daily hydration' })
    await expect(hydrationTab).toBeVisible()
    await hydrationTab.click()
    const hydrationPanel = page.getByRole('tabpanel')
    await expect(hydrationPanel.getByRole('heading', { name: 'Daily goal calendar' })).toBeVisible()
    await expect(hydrationPanel.getByText(/elapsed days reached/)).toBeVisible()

    await page.goto(`${CUSTOMER_URL}/goals/new`)
    await page.getByRole('radio', { name: /Training/ }).click()
    await page.getByLabel('Evaluation period').selectOption('weekly')
    await page.getByLabel('Training days per week').fill('3')
    await page.getByRole('button', { name: 'Preview goal' }).click()
    await page.getByRole('button', { name: 'Add a goal' }).click()

    const trainingTab = page.getByRole('tab', { name: 'Training days' })
    await expect(trainingTab).toBeVisible()
    await trainingTab.click()
    await page.getByRole('button', { name: 'I trained today' }).click()
    await expect(page.getByRole('button', { name: 'Training checked in today' })).toBeDisabled()
    await expect(page.getByText(/weeks? streak/)).toBeVisible()
    await evidence(page, testInfo, 'customer-05-multiple-goals-training-check-in')
  })

  test('paneer servings support create, portion edit, and delete', async ({}, testInfo) => {
    const response = await context.request.get(`${CUSTOMER_URL}/api/dishes/search?q=paneer%20butter&page=1`)
    expect(response.ok(), await response.text()).toBeTruthy()
    const search = await response.json() as { items?: { name: string }[] }
    const dish = search.items?.find((item) => item.name === 'Paneer butter masala')?.name
    test.skip(!dish, 'Optional curated Paneer butter masala seed is not installed.')
    const selectedDish = dish!

    await page.goto(`${CUSTOMER_URL}/meals`)
    await expect(page.getByRole('heading', { name: 'Meals' })).toBeVisible()
    await page.getByRole('button', { name: '+ Add lunch' }).click()
    const form = page.getByRole('region', { name: 'Add manually' })
    await form.getByLabel('Dish').fill('paneer butter')
    await form.getByRole('button', { name: selectedDish, exact: false }).first().click()
    await expect(form.getByText(/100 g per serving/)).toBeVisible()
    await form.getByLabel('Servings').fill('1.5')
    const createResponse = waitForMealMutation(page, 'POST')
    await form.getByRole('button', { name: 'Add meal', exact: true }).click()

    const createdId = await successfulMealId(await createResponse)
    let row = page.locator(`[data-meal-id="${createdId}"]`)
    await expect(row).toBeVisible()
    await evidence(page, testInfo, 'customer-05-paneer-serving-created')
    let rowButton = row.getByRole('button', { name: new RegExp(selectedDish) })
    await rowButton.click()
    await row.getByRole('button', { name: 'Edit this meal', exact: true }).click()
    await row.getByLabel('Servings').fill('2')
    const updateResponse = waitForMealMutation(page, 'PATCH')
    await row.getByRole('button', { name: 'Save', exact: true }).click()
    const updatedId = await successfulMealId(await updateResponse)
    row = page.locator(`[data-meal-id="${updatedId}"]`)
    rowButton = row.getByRole('button', { name: new RegExp(selectedDish) })
    await expect(rowButton).toContainText('200 g')

    await rowButton.click()
    page.once('dialog', (dialog) => dialog.accept())
    await row.getByRole('button', { name: 'Remove' }).click()
    await expect(rowButton).toHaveCount(0)
  })

  test('seeded dish search and category portion work when seed data exists', async ({}, testInfo) => {
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
    await form.getByLabel('Servings').fill('1')
    const createResponse = waitForMealMutation(page, 'POST')
    await form.getByRole('button', { name: 'Add meal', exact: true }).click()

    const createdId = await successfulMealId(await createResponse)
    let row = page.locator(`[data-meal-id="${createdId}"]`)
    await expect(row).toBeVisible()
    let rowButton = row.getByRole('button', { name: new RegExp(escapeRegex(selected)) })
    await rowButton.click()
    await row.getByRole('button', { name: 'Edit this meal', exact: true }).click()
    await row.getByLabel('Servings').fill('2')
    const updateResponse = waitForMealMutation(page, 'PATCH')
    await row.getByRole('button', { name: 'Save', exact: true }).click()
    const updatedId = await successfulMealId(await updateResponse)
    row = page.locator(`[data-meal-id="${updatedId}"]`)
    rowButton = row.getByRole('button', { name: new RegExp(escapeRegex(selected)) })
    await expect(rowButton).toContainText('400 g')
    await evidence(page, testInfo, 'customer-06-seeded-dish-and-portion')

    await rowButton.click()
    page.once('dialog', (dialog) => dialog.accept())
    await row.getByRole('button', { name: 'Remove' }).click()
    await expect(rowButton).toHaveCount(0)
  })

  test('unmatched manual food remains servings-only', async ({}, testInfo) => {
    const dishName = 'E2E free text serving-only'
    await page.goto(`${CUSTOMER_URL}/meals`)
    await page.getByRole('button', { name: '+ Add snacks' }).click()
    const form = page.getByRole('region', { name: 'Add manually' })
    await form.getByLabel('Dish').fill(dishName)
    await expect(form.getByText(/No matching food found/)).toBeVisible()
    await expect(form.getByLabel(/grams/i)).toHaveCount(0)
    await form.getByLabel('Servings').fill('1.25')

    const createResponse = waitForMealMutation(page, 'POST')
    await form.getByRole('button', { name: 'Add meal', exact: true }).click()
    const createdId = await successfulMealId(await createResponse)
    const row = page.locator(`[data-meal-id="${createdId}"]`)

    await expect(row).toContainText(dishName)
    await expect(row).toContainText('1.25 serving')
    await evidence(page, testInfo, 'customer-unmatched-serving-only')
  })

  test('water logging updates Today', async ({}, testInfo) => {
    await page.goto(`${CUSTOMER_URL}/home`)
    const water = page.getByRole('region', { name: 'Water' })
    await water.getByRole('button', { name: '+250 ml' }).click()
    await expect(water.getByRole('status')).toHaveText('250 ml added.')
    await expect(water.getByRole('heading', { name: '0.3 L' })).toBeVisible()
    await evidence(page, testInfo, 'customer-07-water-history')
  })

  test('analytics renders day, week, and month non-agent reports', async ({}, testInfo) => {
    await page.goto(`${CUSTOMER_URL}/analytics`)
    await expect(page.getByRole('heading', { name: 'Trends' })).toBeVisible()
    for (const heading of [
      'Calorie intake', 'Goal vs actual', 'Meal slots and timing', 'Macros',
      'Fiber and sodium', 'Micronutrients', 'Water recorded', 'Weight and waist',
      'Data quality and sources',
    ]) {
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
    await expect(portionButton).toContainText('Fixed category unit: 1 katori = 200 g')
    await portionButton.click()
    const portionRow = portionButton.locator('..')
    await expect(portionRow.getByLabel(/Grams/)).toHaveCount(0)
    const count = portionRow.getByLabel('Usual serving count (katori)')
    const current = Number(await count.inputValue())
    await count.fill(String(current + 0.5))
    await portionRow.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(portionButton).toContainText('Your count')
    await expect(portionButton).toContainText(`Your usual amount: ${current + 0.5} katori = ${(current + 0.5) * 200} g`)

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
