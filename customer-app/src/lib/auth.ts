const DEFAULT_AUTH_REDIRECT = '/home'

export const MIN_PASSWORD_LENGTH = 6

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

type AuthCredentials = {
  email: string
  password: string
}

export function validateAuthCredentials(value: unknown):
  | { credentials: AuthCredentials }
  | { error: string } {
  if (!value || typeof value !== 'object') return { error: 'Email and password are required.' }

  const { email, password } = value as Record<string, unknown>
  const normalizedEmail = typeof email === 'string' ? email.trim() : ''

  if (!/^\S+@\S+\.\S+$/.test(normalizedEmail)) {
    return { error: 'Enter a valid email address.' }
  }
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    return { error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.` }
  }

  return { credentials: { email: normalizedEmail, password } }
}

export const authCookieOptions = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax' as const,
  path: '/',
}
