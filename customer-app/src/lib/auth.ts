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

export const authCookieOptions = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax' as const,
  path: '/',
}
