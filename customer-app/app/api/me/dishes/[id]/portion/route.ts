import { NextRequest } from 'next/server'

import { API } from '@/lib/config/api'
import { proxy } from '@/lib/proxy'

type Ctx = { params: Promise<{ id: string }> }

export const PUT = async (req: NextRequest, ctx: Ctx) =>
  proxy(req, API.paths.myDishPortion((await ctx.params).id))
