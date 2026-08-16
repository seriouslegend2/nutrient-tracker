'use client'

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useSearchParams } from 'next/navigation'
import { useRef, useState } from 'react'

import { MealDraftReview } from '@/components/meal-draft-review'
import { BottomNav } from '@/components/nav'
import { api, type Message } from '@/lib/api-client'
import { isISODate, localDateISO } from '@/lib/date'

/**
 * Text runs through the nutrition agent. Photos and voice notes run through
 * extraction first and then enter the same conversation.
 */
export function AgentClient() {
  const params = useSearchParams()
  const qc = useQueryClient()
  const fileRef = useRef<HTMLInputElement>(null)
  const pdfRef = useRef<HTMLInputElement>(null)
  const cameraRef = useRef<HTMLInputElement>(null)
  const [text, setText] = useState('')
  const [aiError, setAiError] = useState('')
  const requestedDate = params.get('date')
  const mealDate = isISODate(requestedDate) ? requestedDate : localDateISO()

  const { data: messages } = useQuery({
    queryKey: ['messages'], queryFn: () => api.messages(),
  })

  const send = useMutation({
    mutationFn: async ({ body, file }: { body: string; file?: File }) => {
      const form = new FormData()
      if (body) form.set('text', body)
      if (file) form.set('file', file)
      const currentThread = messages?.items[0]?.thread_id
      if (currentThread) form.set('thread_id', currentThread)
      return api.sendMessage(form)
    },
    onSuccess: (created) => {
      setText('')
      const disabled = created.find((message) =>
        message.msg_text?.toLowerCase().includes('ai features are disabled')
      )
      setAiError(disabled?.msg_text ?? '')
      qc.invalidateQueries({ queryKey: ['messages'] })
    },
    onSettled: () => {
      if (fileRef.current) fileRef.current.value = ''
      if (pdfRef.current) pdfRef.current.value = ''
      if (cameraRef.current) cameraRef.current.value = ''
    },
  })

  const items = [...(messages?.items ?? [])].reverse()

  return (
    <div className="app-shell flex min-h-screen flex-col px-4 pt-6 sm:px-6">
      <p className="mb-1 text-base font-semibold" style={{ color: 'var(--color-accent-strong)' }}>Nourish</p>
      <h1 className="display-title mb-1 text-[38px] leading-none">Log anything</h1>
      <p className="mb-5 mt-2 text-sm" style={{ color: 'var(--color-tx2)' }}>
        Describe a meal, upload a photo, or ask about today’s nutrition.
      </p>

      <div className="flex-1 space-y-3 pb-4">
        {!items.length && (
          <div className="card p-5 text-sm" style={{ color: 'var(--color-tx2)' }}>
            <p className="eyebrow mb-3">Try saying</p>
            <ul className="space-y-3">
              <li className="rounded-xl p-3" style={{ background: 'var(--color-surface-soft)' }}>&ldquo;2 rotis and a katori of dal for lunch&rdquo;</li>
              <li className="rounded-xl p-3" style={{ background: 'var(--color-surface-soft)' }}>Upload a photo of your plate</li>
              <li className="rounded-xl p-3" style={{ background: 'var(--color-surface-soft)' }}>&ldquo;How much protein have I had today?&rdquo;</li>
            </ul>
          </div>
        )}
        <div className="card p-3 text-xs" style={{ color: 'var(--color-tx2)' }}>
          AI logging requires the server AI service. If it is disabled, you can still{' '}
          <a href={`/meals?date=${mealDate}`} style={{ color: 'var(--color-accent)' }}>log meals manually</a>.
        </div>
        {items.map((m) => <Bubble key={m.id} message={m} slot={params.get('slot')} date={mealDate} />)}
        {send.isPending && (
          <p className="text-sm" style={{ color: 'var(--color-tx2)' }}>Nutrition agent is thinking…</p>
        )}
        {send.error && (
          <p className="text-sm" style={{ color: 'var(--color-warn)' }}>
            {send.error.message}
          </p>
        )}
        {aiError && <p className="text-sm" role="alert" style={{ color: 'var(--color-danger)' }}>{aiError}</p>}
      </div>

      <div
        className="sticky bottom-[96px] rounded-[22px] border p-3 shadow-xl"
        style={{ background: 'var(--color-surface)', borderColor: 'var(--color-line)', boxShadow: '0 12px 32px color-mix(in oklch, var(--color-tx) 10%, transparent)' }}
      >
        <input
          ref={fileRef}
          type="file"
          accept="image/*,audio/*"
          hidden
          onChange={(e) => {
            const file = e.target.files?.[0]
            if (file) send.mutate({ body: text, file })
          }}
        />
        <input ref={cameraRef} type="file" accept="image/*" capture="environment" hidden
          onChange={(e) => {
            const file = e.target.files?.[0]
            if (file) send.mutate({ body: text, file })
          }} />
        <input ref={pdfRef} type="file" accept="application/pdf" hidden
          onChange={(e) => {
            const file = e.target.files?.[0]
            if (file) send.mutate({ body: text, file })
          }} />
        <div className="flex items-end gap-2">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                if (text.trim()) send.mutate({ body: text })
              }
            }}
            rows={2}
            placeholder="Describe what you ate…"
            className="input min-h-[56px] flex-1 resize-none"
          />
          <button
            onClick={() => text.trim() && send.mutate({ body: text })}
            disabled={!text.trim() || send.isPending}
            className="btn-primary shrink-0 px-5 disabled:opacity-40"
          >
            Send
          </button>
        </div>
        <div className="mt-2 grid grid-cols-2 gap-2">
          <button onClick={() => cameraRef.current?.click()} disabled={send.isPending} className="action-button-secondary disabled:opacity-40">
            Take photo
          </button>
          <button onClick={() => pdfRef.current?.click()} disabled={send.isPending} className="action-button-secondary disabled:opacity-40">
            Upload PDF
          </button>
          <button onClick={() => fileRef.current?.click()} disabled={send.isPending} className="action-button-secondary col-span-2 disabled:opacity-40">
            Attach image or audio
          </button>
        </div>
      </div>

      <BottomNav />
    </div>
  )
}

function Bubble({ message, slot, date }: { message: Message; slot: string | null; date: string }) {
  const mine = message.direction === 'inbound'

  return (
    <div className="space-y-3">
      <div className={mine ? 'flex justify-end' : 'flex justify-start'}>
        <div
          className="max-w-[88%] rounded-2xl px-4 py-3 text-sm"
          style={{
            background: mine ? 'var(--color-accent)' : 'var(--color-surface)',
            color: mine ? 'var(--color-bg)' : 'var(--color-tx)',
            border: mine ? 'none' : '1px solid var(--color-line)',
          }}
        >
          {message.status === 'failed' ? (
            <span>{message.msg_text}</span>
          ) : (
            <span>{stripTags(message.msg_text ?? '')}</span>
          )}
        </div>
      </div>
      {message.status === 'needs_confirmation' && (
        <MealDraftReview messageId={message.id} payload={message.payload} initialSlot={slot} initialDate={date} />
      )}
    </div>
  )
}

/** The backend splices captions in as tags; the UI shows the content. */
function stripTags(text: string): string {
  return text
    .replace(/<\/?(image|audio|document)>/g, '')
    .replace(/\[auto-video-caption\]:\s*/g, '')
    .replace(/User sent an image, description above/g, '')
    .trim()
}
