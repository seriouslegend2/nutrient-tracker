import { describe, expect, it } from 'vitest'

import { otherNutrients, primaryNutrients, scaleNutrients } from '../src/lib/nutrients'

describe('dish nutrient display', () => {
  it('scales one fixed-unit value by selected units and recomputes energy', () => {
    expect(scaleNutrients({ protein_g: 27, carbs_g: 6, fat_g: 15, iron_mg: 1.8 }, 2)).toEqual({
      protein_g: 54,
      carbs_g: 12,
      fat_g: 30,
      iron_mg: 3.6,
      calories_kcal: 534,
    })
  })

  it('shows available macros first and preserves available micronutrients', () => {
    const nutrients = { protein_g: 27, iron_mg: 1.8, vitamin_b12_ug: 0.6 }
    expect(primaryNutrients(nutrients).map((item) => item.label)).toEqual(['Protein'])
    expect(otherNutrients(nutrients).map((item) => item.label)).toEqual(['Iron', 'Vitamin B12'])
  })
})
