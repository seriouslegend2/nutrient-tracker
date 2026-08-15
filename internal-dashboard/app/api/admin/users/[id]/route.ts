// Auto-generated BFF proxy for a dynamic segment.
import { NextRequest } from 'next/server'

import { API } from '@/lib/config/api'
import { proxy } from '@/lib/proxy'

type Ctx = { params: Promise<{ id: string }> }

const handler = async (req: NextRequest, ctx: Ctx) =>
  proxy(req, API.paths.user((await ctx.params).id))

export { handler as GET, handler as POST, handler as PUT, handler as PATCH, handler as DELETE }
