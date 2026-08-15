import { describe, expect, it } from 'vitest'

import { PANEL_BY_ID, PANELS } from '../src/lib/panels'

describe('dashboard panel registry', () => {
  it('has unique IDs and an exact lookup entry for every panel', () => {
    expect(new Set(PANELS.map(({ id }) => id)).size).toBe(PANELS.length)

    for (const panel of PANELS) {
      expect(PANEL_BY_ID[panel.id]).toBe(panel)
    }
  })

  it('keeps only overview local and gives remote panels safe path segments', () => {
    expect(PANEL_BY_ID.overview.endpoint).toBeNull()

    for (const panel of PANELS.filter(({ id }) => id !== 'overview')) {
      expect(panel.endpoint).toMatch(/^[a-z]+(?:-[a-z]+)*$/)
    }
  })
})
