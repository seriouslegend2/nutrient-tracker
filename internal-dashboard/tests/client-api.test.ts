import { afterEach, describe, expect, it, vi } from 'vitest'

import { ApiError, getJson } from '../src/lib/client-api'

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })

describe('dashboard JSON client', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('prefixes API paths and disables browser caching', async () => {
    const page = { items: [], page: 2, total_pages: 4 }
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(page))
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      getJson('/admin/users?page=2&page_size=20')
    ).resolves.toEqual(page)
    expect(fetchMock).toHaveBeenCalledWith('/api/admin/users?page=2&page_size=20', {
      cache: 'no-store',
    })
  })

  it('preserves backend error status and code', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse({ detail: 'Admin required', code: 'FORBIDDEN' }, 403))
    )

    const error = await getJson('/admin/users').catch((reason: unknown) => reason)

    expect(error).toBeInstanceOf(ApiError)
    expect(error).toMatchObject({
      message: 'Admin required',
      status: 403,
      code: 'FORBIDDEN',
    })
  })

  it('uses a stable fallback when an error body is not JSON', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('upstream unavailable', { status: 502 }))
    )

    await expect(getJson('/admin/metrics')).rejects.toMatchObject({
      message: 'Request failed',
      status: 502,
    })
  })
})
