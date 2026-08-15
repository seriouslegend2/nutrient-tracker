'use client'

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useSearchParams } from 'next/navigation'
import { useRef, useState } from 'react'

import { BottomNav } from '@/components/nav'
import { api, type Message } from '@/lib/api-client'

/**
 * Text runs through the nutrition agent. Photos and voice notes run through
 * extraction first and then enter the same conversation.
 */
export function AgentClient() {
  const params = useSearchParams()
  const qc = useQueryClient()
  const fileRef = useRef<HTMLInputElement>(null)
  const cameraRef = useRef<HTMLInputElement>(null)
  const [text, setText] = useState('')
  const [aiError, setAiError] = useState('')
  const mealDate = params.get('date') ?? new Date().toISOString().slice(0, 10)

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
      if (fileRef.current) fileRef.current.value = ''
      qc.invalidateQueries({ queryKey: ['messages'] })
    },
  })

  const items = [...(messages?.items ?? [])].reverse()

  return (
    <div className="app-shell flex min-h-screen flex-col px-4 pt-6">
      <h1 className="mb-1 text-2xl font-semibold tracking-tight">Log anything</h1>
      <p className="mb-4 text-sm" style={{ color: 'var(--color-tx2)' }}>
        Type it, photograph it, or say it.
      </p>

      <div className="flex-1 space-y-3 pb-4">
        {!items.length && (
          <div className="card p-4 text-sm" style={{ color: 'var(--color-tx2)' }}>
            <p className="mb-2">Try:</p>
            <ul className="space-y-1">
              <li>&ldquo;2 rotis and a katori of dal for lunch&rdquo;</li>
              <li>A photo of your plate</li>
              <li>&ldquo;how much protein have I had today?&rdquo;</li>
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
        className="sticky bottom-[84px] flex items-end gap-2 rounded-xl border p-2"
        style={{ background: 'var(--color-surface)', borderColor: 'var(--color-line)' }}
      >
        <input
          ref={fileRef}
          type="file"
          accept="image/*,audio/*,application/pdf"
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
        <button
          onClick={() => fileRef.current?.click()}
          disabled={send.isPending}
          aria-label="Attach a photo, voice note, or PDF"
          className="grid h-9 w-9 shrink-0 place-items-center rounded-lg text-lg disabled:opacity-40"
          style={{ background: 'var(--color-line)' }}
        >
          ＋
        </button>
        <button onClick={() => cameraRef.current?.click()} disabled={send.isPending}
          aria-label="Take a meal photo" className="grid h-9 w-9 shrink-0 place-items-center rounded-lg text-sm disabled:opacity-40"
          style={{ background: 'var(--color-line)' }}>Photo</button>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              if (text.trim()) send.mutate({ body: text })
            }
          }}
          rows={1}
          placeholder="What did you eat?"
          className="flex-1 resize-none bg-transparent py-2 text-sm outline-none"
        />
        <button
          onClick={() => text.trim() && send.mutate({ body: text })}
          disabled={!text.trim() || send.isPending}
          className="rounded-lg px-3 py-2 text-sm font-medium disabled:opacity-40"
          style={{ background: 'var(--color-accent)', color: 'var(--color-bg)' }}
        >
          Send
        </button>
      </div>

      <BottomNav />
    </div>
  )
}

function Bubble({ message, slot, date }: { message: Message; slot: string | null; date: string }) {
  const mine = message.direction === 'inbound'
  const draft = message.payload?.items as
    | { name: string; estimated_mass_g: number; mass_range_g?: { low: number; high: number } }[]
    | undefined

  return (
    <div className={mine ? 'flex justify-end' : 'flex justify-start'}>
      <div
        className="max-w-[85%] rounded-xl px-3 py-2 text-sm"
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

        {message.status === 'needs_confirmation' && draft && (
          <ConfirmCard messageId={message.id} items={draft} slot={slot} date={date} />
        )}
      </div>
    </div>
  )
}

/**
 * The confirm step. Ranges, not point values - the published evidence says
 * photo estimates run ~33% low, driven almost entirely by invisible fat, so a
 * single number would be a confident lie.
 */
function ConfirmCard({ messageId, items, slot, date }: {
  messageId: string
  items: { name: string; estimated_mass_g: number; mass_range_g?: { low: number; high: number } }[]
  slot: string | null
  date: string
}) {
  const qc = useQueryClient()
  const [edited, setEdited] = useState(items)

  const confirm = useMutation({
    mutationFn: () =>
      api.confirmMessage(messageId, {
        meal_date: date,
        meal_type: slot ?? 'misc',
        items: edited.map((i) => ({
          dish_name: i.name, grams: i.estimated_mass_g, portion_unit: 'g',
        })),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['messages'] })
      qc.invalidateQueries({ queryKey: ['day'] })
    },
  })

  return (
    <div className="mt-2 space-y-2 rounded-lg p-2" style={{ background: 'var(--color-bg)' }}>
      {edited.map((item, i) => (
        <div key={i} className="text-xs">
          <div className="flex items-center justify-between gap-2">
            <span style={{ color: 'var(--color-tx)' }}>{item.name}</span>
            <input
              type="number"
              value={item.estimated_mass_g}
              onChange={(e) => {
                const next = [...edited]
                next[i] = { ...item, estimated_mass_g: Number(e.target.value) }
                setEdited(next)
              }}
              className="w-16 rounded border bg-transparent px-1 py-0.5 text-right tabular-nums"
              style={{ borderColor: 'var(--color-line)', color: 'var(--color-tx)' }}
            />
          </div>
          {item.mass_range_g && (
            <p style={{ color: 'var(--color-tx2)' }}>
              likely {item.mass_range_g.low}-{item.mass_range_g.high} g
            </p>
          )}
        </div>
      ))}
      <button
        onClick={() => confirm.mutate()}
        disabled={confirm.isPending}
        className="w-full rounded-lg py-1.5 text-xs font-medium"
        style={{ background: 'var(--color-accent)', color: 'var(--color-bg)' }}
      >
        {confirm.isPending ? 'Logging…' : 'Log it'}
      </button>
      {confirm.error && <p style={{ color: 'var(--color-danger)' }}>{confirm.error.message}</p>}
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
