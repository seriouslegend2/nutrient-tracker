import { describe, expect, it } from 'vitest'

import type { Message } from '../src/lib/api-client'
import { mediaWorkflowMessages } from '../src/lib/media-analysis'

function message(id: string, status: string, overrides: Partial<Message> = {}): Message {
  return {
    id,
    thread_id: 'thread-1',
    correlation_id: `correlation-${id}`,
    direction: 'inbound',
    msg_type: 'image',
    msg_text: null,
    payload: {},
    status,
    created_at: '2026-08-17T10:00:00Z',
    ...overrides,
  }
}

const draftPayload = {
  meal_date: '2026-08-17',
  meal_type: 'lunch',
  source_metadata: { kind: 'food_photo' },
  items: [{
    evidence_id: 'evidence-1',
    name: 'dal',
    resolved_name: 'Dal Tadka',
    food_id: 'dish-1',
    servings: 1,
    portion_metadata: { portion_unit: 'katori', portion_grams: 160, fixed: true },
    nutrients: { calories_kcal: 220 },
  }],
}

describe('persisted media analysis lifecycle', () => {
  it('recovers processing uploads and review drafts from stored messages', () => {
    const result = mediaWorkflowMessages([
      message('processing', 'processing'),
      message('received', 'received', { msg_type: 'pdf' }),
      message('draft', 'needs_confirmation', { payload: draftPayload }),
      message('confirmed', 'confirmed', { payload: draftPayload }),
    ])

    expect(result.processing.map((item) => item.id)).toEqual(['processing', 'received'])
    expect(result.drafts.map((item) => item.id)).toEqual(['draft'])
  })

  it('ignores chat rows and malformed drafts', () => {
    const result = mediaWorkflowMessages([
      message('chat', 'processing', { msg_type: 'text' }),
      message('outbound', 'processing', { direction: 'outbound' }),
      message('malformed', 'needs_confirmation', { payload: { items: [] } }),
    ])

    expect(result).toEqual({ processing: [], drafts: [] })
  })
})
