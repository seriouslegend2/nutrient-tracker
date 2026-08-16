import type { Message } from '@/lib/api-client'
import { parseMediaMealDraft } from '@/lib/meal-draft'

export function isMediaMessage(message: Message): boolean {
  return message.direction === 'inbound' && (message.msg_type === 'image' || message.msg_type === 'pdf')
}

export function mediaWorkflowMessages(messages: Message[]) {
  const media = messages.filter(isMediaMessage)
  return {
    processing: media.filter((message) => message.status === 'received' || message.status === 'processing'),
    drafts: media.filter((message) =>
      message.status === 'needs_confirmation' && parseMediaMealDraft(message.payload) !== null
    ),
  }
}
