export const DEFAULT_NEXT = '/users'

/** Return a same-origin relative destination, never an absolute or protocol-relative URL. */
export function safeNext(value: string | null | undefined): string {
  if (!value || !value.startsWith('/') || value.startsWith('//') || value.includes('\\')) {
    return DEFAULT_NEXT
  }

  try {
    const base = new URL('https://dashboard.invalid')
    const destination = new URL(value, base)
    if (destination.origin !== base.origin) return DEFAULT_NEXT
    return `${destination.pathname}${destination.search}${destination.hash}`
  } catch {
    return DEFAULT_NEXT
  }
}
