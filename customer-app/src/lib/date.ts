export function localDateISO(date = new Date()): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

export function isISODate(value: string | null): value is string {
  return Boolean(value && /^\d{4}-\d{2}-\d{2}$/.test(value))
}

export function shiftISODate(value: string, days: number): string {
  const date = new Date(`${value}T12:00:00`)
  date.setDate(date.getDate() + days)
  return localDateISO(date)
}

export function startOfWeekISO(value: string): string {
  const date = new Date(`${value}T12:00:00`)
  const mondayOffset = (date.getDay() + 6) % 7
  return shiftISODate(value, -mondayOffset)
}

export function inclusiveDateRange(start: string, end: string): string[] {
  if (!isISODate(start) || !isISODate(end) || start > end) return []

  const dates: string[] = []
  for (let value = start; value <= end; value = shiftISODate(value, 1)) {
    dates.push(value)
  }
  return dates
}
