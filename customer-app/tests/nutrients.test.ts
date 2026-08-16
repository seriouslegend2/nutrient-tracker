import { describe, expect, it } from 'vitest'

import { otherNutrients, primaryNutrients, scaleNutrients } from '../src/lib/nutrients'

describe('dish nutrient display', () => {
  it('scales per-100g values to the selected serving and recomputes energy', () => {
    expect(scaleNutrients({ protein_g: 18, carbs_g: 4, fat_g: 10, iron_mg: 1.2 }, 150)).toEqual({
      protein_g: 27,
      carbs_g: 6,
      fat_g: 15,
      iron_mg: 1.8,
      calories_kcal: 267,
    })
  })

  it('shows available macros first and preserves available micronutrients', () => {
    const nutrients = { protein_g: 27, iron_mg: 1.8, vitamin_b12_ug: 0.6 }
    expect(primaryNutrients(nutrients).map((item) => item.label)).toEqual(['Protein'])
    expect(otherNutrients(nutrients).map((item) => item.label)).toEqual(['Iron', 'Vitamin B12'])
  })
})
