export const DEFAULT_NEXT = '/users'

/** Railway terminates TLS at its edge and proxies plain HTTP internally, so
 * request.url / request.nextUrl.origin can resolve to the internal http://
 * address instead of the public https:// one - trust the forwarded headers
 * the edge sets instead. */
export function publicOrigin(request: Request) {
  const headers = request.headers
  const proto = headers.get('x-forwarded-proto') ?? new URL(request.url).protocol.replace(':', '')
  const host = headers.get('x-forwarded-host') ?? headers.get('host') ?? new URL(request.url).host
  return `${proto}://${host}`
}

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
