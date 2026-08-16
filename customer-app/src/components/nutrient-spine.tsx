export function NutrientSpine({ nutrients }: { nutrients?: Record<string, number> | null }) {
  const protein = (nutrients?.protein_g ?? 0) * 4
  const carbs = (nutrients?.carbs_g ?? 0) * 4
  const fat = (nutrients?.fat_g ?? 0) * 9
  const total = protein + carbs + fat

  if (!total) {
    return <span className="h-12 w-1.5 shrink-0 rounded-full border border-dashed" style={{ borderColor: 'var(--color-tx2)' }} aria-label="Nutrition unavailable" />
  }

  const proteinEnd = (protein / total) * 100
  const carbsEnd = proteinEnd + (carbs / total) * 100
  return (
    <span
      className="h-12 w-1.5 shrink-0 rounded-full"
      style={{
        background: `linear-gradient(to bottom, var(--color-protein) 0 ${proteinEnd}%, var(--color-carbs) ${proteinEnd}% ${carbsEnd}%, var(--color-fat) ${carbsEnd}% 100%)`,
      }}
      aria-label="Meal nutrient mix"
    />
  )
}
