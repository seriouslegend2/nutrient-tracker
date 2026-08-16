import { describe, expect, it } from 'vitest'

import {
  buildMealDraftConfirmRequest,
  calculateMealDraftTotals,
  mealDraftItemGrams,
  parseMediaMealDraft,
} from '../src/lib/meal-draft'
import { suggestedMealSlot } from '../src/lib/meal-slots'
import { normalizeMealServings } from '../src/lib/servings'

describe('resolved media meal drafts', () => {
  const payload = {
    meal_date: '2026-08-16',
    meal_type: 'lunch',
    source_metadata: { kind: 'food_photo' },
    items: [{
      evidence_id: 'evidence-1',
      name: 'paneer dish',
      resolved_name: 'Paneer Butter Masala',
      food_id: 'dish-1',
      servings: 1.25,
      total_grams: 200,
      portion_unit: 'katori',
      portion_metadata: {
        portion_unit: 'katori',
        portion_grams: 160,
        fixed: true,
      },
      amount_source: 'agent1_user_stated',
      mass_range_g: { low: 180, high: 220 },
      confidence: 'high',
      nutrients: { calories_kcal: 330, protein_g: 20, sodium_mg: 240, vitamin_b12_ug: 1.5 },
    }],
  }

  it('parses a completed catalog dish and automatic date and slot', () => {
    const draft = parseMediaMealDraft(payload)

    expect(draft).toMatchObject({
      mealDate: '2026-08-16',
      mealType: 'lunch',
      sourceKind: 'food_photo',
    })
    expect(draft?.items[0]).toMatchObject({
      evidenceId: 'evidence-1',
      resolvedName: 'Paneer Butter Masala',
      foodId: 'dish-1',
      servings: 1.5,
      servingUnit: 'katori',
      gramsPerServing: 160,
      amountSource: 'agent1_user_stated',
    })
  })

  it('rounds meal servings half-up to the nearest half unit', () => {
    expect(normalizeMealServings(0.1)).toBe(0.5)
    expect(normalizeMealServings(1.24)).toBe(1)
    expect(normalizeMealServings(1.25)).toBe(1.5)
    expect(normalizeMealServings(1.74)).toBe(1.5)
    expect(normalizeMealServings(1.75)).toBe(2)
  })

  it('edits servings while deriving grams and nutrition from the fixed serving', () => {
    const draft = parseMediaMealDraft(payload)!
    const edited = [{ ...draft.items[0], servings: 2 }]

    expect(mealDraftItemGrams(edited[0])).toBe(320)
    expect(calculateMealDraftTotals(edited)).toEqual({
      nutrients: { calories_kcal: 528, protein_g: 32, sodium_mg: 384, vitamin_b12_ug: 2.4 },
      totalGrams: 320,
    })
    expect(buildMealDraftConfirmRequest(edited, draft.mealDate!, draft.mealType!)).toEqual({
      meal_date: '2026-08-16',
      meal_type: 'lunch',
      items: [{
        evidence_id: 'evidence-1',
        dish_name: 'Paneer Butter Masala',
        food_id: 'dish-1',
        grams: 320,
        portions: 2,
        portion_unit: 'katori',
        confidence: 'high',
      }],
    })
  })

  it('rejects unresolved and old drafts without a fixed serving contract', () => {
    expect(parseMediaMealDraft(null)).toBeNull()
    expect(parseMediaMealDraft({ items: [{ name: 'Unknown', total_grams: 100 }] })).toBeNull()
    expect(parseMediaMealDraft({
      items: [{
        evidence_id: 'evidence-1',
        name: 'Dal',
        resolved_name: 'Dal Tadka',
        food_id: 'dish-1',
        portion_metadata: { portion_unit: 'katori' },
      }],
    })).toBeNull()
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
