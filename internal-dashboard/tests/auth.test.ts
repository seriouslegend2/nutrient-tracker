import { describe, expect, it } from 'vitest'

import { DEFAULT_NEXT, safeNext } from '../src/lib/auth'

describe('safeNext', () => {
  it('keeps a relative dashboard destination including query and hash', () => {
    expect(safeNext('/users?page=3#account')).toBe('/users?page=3#account')
  })

  it.each([
    undefined,
    null,
    '',
    'users',
    'https://attacker.example/steal',
    '//attacker.example/steal',
    '/\\attacker.example/steal',
    '/users\\attacker',
  ])('rejects a non-relative or ambiguous destination: %s', (value) => {
    expect(safeNext(value)).toBe(DEFAULT_NEXT)
  })
})
