export const MEAL_SLOT_OPTIONS = [
  { value: 'breakfast', label: 'Breakfast' },
  { value: 'brunch', label: 'Brunch' },
  { value: 'lunch', label: 'Lunch' },
  { value: 'snacks', label: 'Snacks' },
  { value: 'dinner', label: 'Dinner' },
  { value: 'misc', label: 'Other' },
] as const

export type MealSlot = typeof MEAL_SLOT_OPTIONS[number]['value']

export function isMealSlot(value: string | null | undefined): value is MealSlot {
  return MEAL_SLOT_OPTIONS.some((option) => option.value === value)
}

export function suggestedMealSlot(at = new Date()): MealSlot {
  const hour = at.getHours()
  if (hour < 11) return 'breakfast'
  if (hour < 15) return 'lunch'
  if (hour < 18) return 'snacks'
  return 'dinner'
}
