export function normalizeMealServings(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0.5
  return Math.max(0.5, Math.floor(value * 2 + 0.5) / 2)
}

export function hasPositiveMealServings(value: string | number): boolean {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0
}
