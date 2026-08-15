import { describe, expect, it } from 'vitest'

import { safeRedirectPath, validateAuthCredentials } from '../src/lib/auth'

describe('safeRedirectPath', () => {
  it('keeps relative application destinations including query and hash', () => {
    expect(safeRedirectPath('/meals?date=2026-08-16#dinner')).toBe(
      '/meals?date=2026-08-16#dinner'
    )
  })

  it.each([
    null,
    '',
    'meals',
    'https://attacker.example/steal',
    '//attacker.example/steal',
    '/\\attacker.example/steal',
  ])('rejects a non-relative or ambiguous destination: %s', (value) => {
    expect(safeRedirectPath(value)).toBe('/home')
  })

  it('uses the caller fallback for unsafe input', () => {
    expect(safeRedirectPath('//attacker.example', '/onboarding')).toBe('/onboarding')
  })
})

describe('validateAuthCredentials', () => {
  it('trims the email and preserves the password', () => {
    expect(validateAuthCredentials({ email: ' person@example.com ', password: 'secret' })).toEqual({
      credentials: { email: 'person@example.com', password: 'secret' },
    })
  })

  it.each([
    null,
    {},
    { email: 'not-an-email', password: 'secret' },
    { email: 'person@example.com', password: 'short' },
  ])('rejects invalid credentials: %j', (value) => {
    expect(validateAuthCredentials(value)).toHaveProperty('error')
  })
})
