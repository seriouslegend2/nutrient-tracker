const DEFAULT_AUTH_REDIRECT = '/home'

/** Return only an application-relative path on this origin. */
export function safeRedirectPath(value: string | null, fallback = DEFAULT_AUTH_REDIRECT) {
  if (!value || !value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) {
    return fallback
  }

  try {
    const parsed = new URL(value, 'https://app.invalid')
    if (parsed.origin !== 'https://app.invalid') return fallback
    return `${parsed.pathname}${parsed.search}${parsed.hash}`
  } catch {
    return fallback
  }
}

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

export const authCookieOptions = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax' as const,
  path: '/',
}
