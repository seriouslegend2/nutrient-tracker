// Same-origin proxy for closing a media draft without logging it.
import { NextRequest } from 'next/server'

import { API } from '@/lib/config/api'
import { proxy } from '@/lib/proxy'

type Ctx = { params: Promise<{ id: string }> }

export const POST = async (req: NextRequest, ctx: Ctx) =>
  proxy(req, `${API.paths.messages}/${(await ctx.params).id}/discard`)
