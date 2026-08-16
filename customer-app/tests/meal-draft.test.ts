import { describe, expect, it } from 'vitest'

import {
  buildMealDraftConfirmRequest,
  calculateMealDraftTotals,
  parseMediaMealDraft,
} from '../src/lib/meal-draft'
import { suggestedMealSlot } from '../src/lib/meal-slots'

describe('media meal drafts', () => {
  it('parses photo estimates and scales only resolved nutrition with gram edits', () => {
    const draft = parseMediaMealDraft({
      source_metadata: { kind: 'food_photo' },
      items: [
        {
          name: 'Dal',
          estimated_mass_g: 180,
          mass_range_g: { low: 150, high: 220 },
          confidence: { identity: 'high', mass: 'medium' },
          count: 1,
          container: 'katori',
          nutrients: { calories_kcal: 220, protein_g: 12 },
        },
        { name: 'Chutney', estimated_mass_g: 20 },
      ],
    })

    expect(draft).not.toBeNull()
    expect(draft?.items[0]).toMatchObject({
      amount: 180,
      measurement: 'grams',
      range: { low: 150, high: 220 },
      confidence: 'medium',
      householdAmount: 1,
      householdUnit: 'katori',
    })

    const edited = draft!.items.map((item, index) => index === 0 ? { ...item, amount: 90 } : item)
    expect(calculateMealDraftTotals(edited)).toEqual({
      nutrients: { calories_kcal: 110, protein_g: 6 },
      unresolvedItems: 1,
    })
  })

  it('preserves PDF quantity and unit when a row cannot be converted to grams', () => {
    const draft = parseMediaMealDraft({
      items: [{
        name: 'Poha',
        estimated_mass_g: null,
        quantity: 1.5,
        unit: 'bowl',
        source_metadata: { row: { calories_kcal: 280 } },
      }],
    })

    expect(draft?.items[0]).toMatchObject({
      amount: 1.5,
      measurement: 'portions',
      unit: 'bowl',
      nutrients: {},
    })
    expect(buildMealDraftConfirmRequest(draft!.items, '2026-08-16', 'breakfast')).toEqual({
      meal_date: '2026-08-16',
      meal_type: 'breakfast',
      items: [{
        dish_name: 'Poha',
        grams: null,
        portions: 1.5,
        portion_unit: 'bowl',
      }],
    })
  })

  it('uses resolved grams and household metadata from enriched drafts', () => {
    const draft = parseMediaMealDraft({
      items: [{
        name: 'model display name',
        resolved_name: 'Dal Tadka',
        estimated_mass_g: null,
        total_grams: 240,
        food_id: 'dish-1',
        portion_metadata: { portion_count: 1.5, portion_unit: 'katori', portion_grams: 160 },
        nutrients: { calories_kcal: 396, protein_g: 24 },
      }],
    })

    expect(draft?.items[0]).toMatchObject({
      resolvedName: 'Dal Tadka',
      amount: 1.5,
      measurement: 'portions',
      gramsPerUnit: 160,
      householdAmount: 1.5,
      householdUnit: 'katori',
    })
    expect(buildMealDraftConfirmRequest(draft!.items, '2026-08-16', 'dinner').items[0]).toEqual({
      dish_name: 'Dal Tadka',
      grams: 240,
      portions: 1.5,
      portion_unit: 'katori',
      food_id: 'dish-1',
    })
  })

  it('rejects old or malformed payloads without inventing draft items', () => {
    expect(parseMediaMealDraft(null)).toBeNull()
    expect(parseMediaMealDraft({ items: [{ estimated_mass_g: 100 }] })).toBeNull()
    expect(parseMediaMealDraft({ tool_calls: [] })).toBeNull()
  })
})

describe('meal slot suggestion', () => {
  it('uses the shared Home and Chat time boundaries', () => {
    expect(suggestedMealSlot(new Date(2026, 7, 16, 10, 59))).toBe('breakfast')
    expect(suggestedMealSlot(new Date(2026, 7, 16, 11, 0))).toBe('lunch')
    expect(suggestedMealSlot(new Date(2026, 7, 16, 15, 0))).toBe('snacks')
    expect(suggestedMealSlot(new Date(2026, 7, 16, 18, 0))).toBe('dinner')
  })
})
