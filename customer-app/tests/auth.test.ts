import { describe, expect, it } from 'vitest'

import { safeRedirectPath } from '../src/lib/auth'

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
