/**
 * The BFF proxy. Every browser request lands here and is forwarded to FastAPI.
 *
 * THE RULE: the browser has no Supabase client, no backend URL and no
 * credentials. It calls same-origin /api/* and nothing else, so the
 * assignment's "frontend communicates with the backend exclusively through
 * APIs" is satisfied structurally rather than argued.
 *
 * The BFF validates its Supabase session and signs a backend service JWT whose
 * payload identifies that user. FastAPI still loads roles and enforces RBAC.
 */

import { NextRequest, NextResponse } from 'next/server'

import { API, buildUrl, createBackendToken } from '@/lib/config/api'
import { getUser } from '@/lib/supabase/server'

type ProxyOptions = {
  /** Timeout tier. Defaults to `default` (2 minutes). */
  timeout?: number
}

export async function proxy(
  req: NextRequest,
  backendPath: string,
  opts: ProxyOptions = {}
): Promise<NextResponse> {
  const user = await getUser()
  if (!user) {
    return NextResponse.json(
      { detail: 'Not authenticated', code: 'NO_SESSION' },
      { status: 401 }
    )
  }
  if (!API.jwtSecret) {
    return NextResponse.json(
      { detail: 'Backend JWT secret is not configured', code: 'BACKEND_AUTH_CONFIG' },
      { status: 500 }
    )
  }

  const url = buildUrl(backendPath, req.nextUrl.search)

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${createBackendToken(user.id)}`,
  }

  const init: RequestInit = {
    method: req.method,
    headers,
    cache: 'no-store',
    signal: AbortSignal.timeout(opts.timeout ?? API.timeouts.default),
  }

  if (req.method !== 'GET' && req.method !== 'DELETE') {
    const contentType = req.headers.get('content-type') ?? ''
    if (contentType.includes('multipart/form-data')) {
      // Let fetch set the multipart boundary itself.
      delete headers['Content-Type']
      init.body = await req.formData()
    } else {
      init.body = await req.text()
    }
  }

  try {
    const res = await fetch(url, init)
    if (res.status === 204) return new NextResponse(null, { status: 204 })

    const text = await res.text()
    return new NextResponse(text, {
      status: res.status,
      headers: {
        'Content-Type': res.headers.get('content-type') ?? 'application/json',
      },
    })
  } catch (err) {
    const isTimeout = err instanceof Error && err.name === 'TimeoutError'
    // Log the path, never the headers - the service token lives in there.
    console.error('[proxy] failed', { path: backendPath, error: String(err) })
    return NextResponse.json(
      {
        detail: isTimeout ? 'The server took too long to respond' : 'Upstream error',
        code: isTimeout ? 'UPSTREAM_TIMEOUT' : 'UPSTREAM_ERROR',
      },
      { status: isTimeout ? 504 : 502 }
    )
  }
}

/** Build the four HTTP verbs for a fixed backend path. */
export function proxyRoute(backendPath: string, opts?: ProxyOptions) {
  const handler = (req: NextRequest) => proxy(req, backendPath, opts)
  return { GET: handler, POST: handler, PUT: handler, PATCH: handler, DELETE: handler }
}
