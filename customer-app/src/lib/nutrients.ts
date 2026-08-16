const PRIMARY_NUTRIENTS = [
  ['calories_kcal', 'Calories', 'kcal'],
  ['protein_g', 'Protein', 'g'],
  ['carbs_g', 'Carbs', 'g'],
  ['fat_g', 'Fat', 'g'],
  ['fiber_g', 'Fiber', 'g'],
] as const

const LABELS: Record<string, string> = {
  calcium_mg: 'Calcium',
  iron_mg: 'Iron',
  magnesium_mg: 'Magnesium',
  phosphorus_mg: 'Phosphorus',
  potassium_mg: 'Potassium',
  sodium_mg: 'Sodium',
  zinc_mg: 'Zinc',
  sugar_g: 'Sugar',
  saturated_fat_g: 'Saturated fat',
  trans_fat_g: 'Trans fat',
  cholesterol_mg: 'Cholesterol',
  vitamin_a_ug: 'Vitamin A',
  vitamin_b1_mg: 'Vitamin B1',
  vitamin_b2_mg: 'Vitamin B2',
  vitamin_b3_mg: 'Vitamin B3',
  vitamin_b6_mg: 'Vitamin B6',
  vitamin_b12_ug: 'Vitamin B12',
  vitamin_c_mg: 'Vitamin C',
  vitamin_d_iu: 'Vitamin D',
  vitamin_e_mg: 'Vitamin E',
  vitamin_k_ug: 'Vitamin K',
  folate_ug: 'Folate',
  iodine_ug: 'Iodine',
  selenium_ug: 'Selenium',
  copper_mg: 'Copper',
  manganese_mg: 'Manganese',
}

export type NutrientDisplay = {
  key: string
  label: string
  value: number
  unit: string
}

export function scaleNutrients(nutrientsPerUnit: Record<string, number>, units: number): Record<string, number> {
  if (!Number.isFinite(units) || units <= 0) return {}

  const scaled: Record<string, number> = {}
  for (const [key, value] of Object.entries(nutrientsPerUnit)) {
    if (key === 'calories_kcal' || !Number.isFinite(value)) continue
    scaled[key] = Math.round(value * units * 100) / 100
  }
  scaled.calories_kcal = Math.round(
    (scaled.protein_g ?? 0) * 4 +
    (scaled.carbs_g ?? 0) * 4 +
    (scaled.fat_g ?? 0) * 9 +
    (scaled.fiber_g ?? 0) * 2
  )
  return scaled
}

export function primaryNutrients(nutrients: Record<string, number>): NutrientDisplay[] {
  return PRIMARY_NUTRIENTS.flatMap(([key, label, unit]) => {
    const value = nutrients[key]
    return Number.isFinite(value) ? [{ key, label, value, unit }] : []
  })
}

export function otherNutrients(nutrients: Record<string, number>): NutrientDisplay[] {
  const primary = new Set(PRIMARY_NUTRIENTS.map(([key]) => key))
  return Object.entries(nutrients)
    .filter(([key, value]) => !primary.has(key as typeof PRIMARY_NUTRIENTS[number][0]) && Number.isFinite(value))
    .map(([key, value]) => ({
      key,
      label: LABELS[key] ?? titleCase(key.replace(/_(g|mg|ug|iu|kcal)$/, '')),
      value,
      unit: key.match(/_(kcal|mg|ug|iu|g)$/)?.[1] ?? '',
    }))
    .sort((a, b) => a.label.localeCompare(b.label))
}

export function formatNutrientValue(value: number): string {
  if (Math.abs(value) >= 10 || Number.isInteger(value)) return String(Math.round(value))
  return value.toFixed(1)
}

function titleCase(value: string): string {
  return value.replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase())
}
