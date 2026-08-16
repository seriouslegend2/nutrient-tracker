'use client'

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { type FormEvent, useEffect, useRef, useState } from 'react'

import { MealDraftReview } from '@/components/meal-draft-review'
import { BottomNav } from '@/components/nav'
import { api, type Message, type Page } from '@/lib/api-client'
import { localDateISO } from '@/lib/date'
import { parseMediaMealDraft } from '@/lib/meal-draft'

const TRACKER_INVALIDATION_KEYS = [
  ['messages'], ['day'], ['meals'], ['goals'], ['goals', 'summary'], ['water'], ['trend'],
  ['macros'], ['micros'], ['goal-vs-actual'], ['meal-patterns'], ['nutrient-series'],
]

export function AgentClient() {
  const qc = useQueryClient()
  const mediaInputRef = useRef<HTMLInputElement>(null)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const recordingStreamRef = useRef<MediaStream | null>(null)
  const recordingChunksRef = useRef<Blob[]>([])
  const discardRecordingRef = useRef(false)
  const conversationEndRef = useRef<HTMLDivElement>(null)
  const [text, setText] = useState('')
  const [aiError, setAiError] = useState('')
  const [recordingError, setRecordingError] = useState('')
  const [isRecording, setIsRecording] = useState(false)
  const [recordingSeconds, setRecordingSeconds] = useState(0)
  const [pendingMessage, setPendingMessage] = useState<Message | null>(null)
  const [attachment, setAttachment] = useState<File | null>(null)
  const [attachmentError, setAttachmentError] = useState('')

  const { data: messages, isPending: messagesPending } = useQuery({
    queryKey: ['messages'], queryFn: () => api.messages(),
  })

  const send = useMutation({
    mutationFn: async ({ body, file }: { body: string; file?: File }) => {
      const form = new FormData()
      if (body) form.set('text', body)
      if (file) form.set('file', file)
      form.set('timezone', Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC')
      const currentThread = chatMessages[0]?.thread_id
      if (currentThread) form.set('thread_id', currentThread)
      return api.sendMessage(form)
    },
    onMutate: ({ body, file }) => {
      setText('')
      setAttachment(null)
      setAttachmentError('')
      setPendingMessage({
        id: 'pending-message',
        thread_id: chatMessages[0]?.thread_id ?? 'pending-thread',
        correlation_id: 'pending-correlation',
        direction: 'inbound',
        msg_type: outgoingMessageType(file),
        msg_text: body || null,
        payload: {},
        status: 'processing',
        created_at: new Date().toISOString(),
      })
    },
    onSuccess: async (created) => {
      qc.setQueryData<Page<Message>>(['messages'], (current) => {
        const existing = current?.items ?? []
        const createdIds = new Set(created.map((message) => message.id))
        const items = [...created].reverse().concat(
          existing.filter((message) => !createdIds.has(message.id))
        )
        return current
          ? { ...current, items, total: Math.max(current.total, items.length) }
          : {
              items,
              total: items.length,
              page: 1,
              page_size: items.length,
              total_pages: 1,
              has_more: false,
              next_cursor: null,
            }
      })
      setPendingMessage(null)
      const disabled = created.find((message) =>
        message.msg_text?.toLowerCase().includes('ai features are disabled')
      )
      setAiError(disabled?.msg_text ?? '')
      await Promise.all(TRACKER_INVALIDATION_KEYS.map((queryKey) =>
        qc.invalidateQueries({ queryKey })
      ))
    },
    onError: (_error, variables) => {
      setPendingMessage(null)
      if (variables.body) setText((current) => current || variables.body)
      if (variables.file && !variables.file.type.startsWith('audio/')) {
        setAttachment(variables.file)
      }
    },
    onSettled: () => {
      if (mediaInputRef.current) mediaInputRef.current.value = ''
    },
  })

  const rows = messages?.items ?? []
  const chatMessages = rows
  const items = [...chatMessages].reverse().concat(pendingMessage ? [pendingMessage] : [])
  const latestMessageId = items.at(-1)?.id

  useEffect(() => {
    if (messagesPending || !latestMessageId) return
    let secondFrame = 0
    const firstFrame = window.requestAnimationFrame(() => {
      secondFrame = window.requestAnimationFrame(() => {
        conversationEndRef.current?.scrollIntoView({ behavior: 'auto', block: 'end' })
        document.scrollingElement?.scrollTo({
          top: document.scrollingElement.scrollHeight,
          behavior: 'auto',
        })
      })
    })
    return () => {
      window.cancelAnimationFrame(firstFrame)
      window.cancelAnimationFrame(secondFrame)
    }
  }, [latestMessageId, messagesPending, send.isPending])

  useEffect(() => {
    if (!isRecording) return
    const timer = window.setInterval(() => setRecordingSeconds((value) => value + 1), 1000)
    return () => window.clearInterval(timer)
  }, [isRecording])

  useEffect(() => () => {
    discardRecordingRef.current = true
    if (recorderRef.current?.state === 'recording') recorderRef.current.stop()
    recordingStreamRef.current?.getTracks().forEach((track) => track.stop())
  }, [])

  function submit(event: FormEvent) {
    event.preventDefault()
    sendComposedMessage()
  }

  function sendComposedMessage() {
    const body = text.trim()
    if ((body || attachment) && !send.isPending) {
      send.mutate({ body, file: attachment ?? undefined })
    }
  }

  function selectAttachment(file: File) {
    const normalized = normalizeAttachment(file)
    const error = validateAttachment(normalized)
    setAttachmentError(error)
    setAttachment(error ? null : normalized)
    if (error && mediaInputRef.current) mediaInputRef.current.value = ''
  }

  async function startRecording() {
    setRecordingError('')
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      setRecordingError('Live recording is not supported in this browser.')
      return
    }
    let stream: MediaStream | null = null
    try {
      const activeStream = await navigator.mediaDevices.getUserMedia({ audio: true })
      stream = activeStream
      const mimeType = preferredRecordingType()
      const recorder = mimeType
        ? new MediaRecorder(activeStream, { mimeType })
        : new MediaRecorder(activeStream)
      recordingStreamRef.current = activeStream
      recorderRef.current = recorder
      recordingChunksRef.current = []
      discardRecordingRef.current = false
      recorder.ondataavailable = (event) => {
        if (event.data.size) recordingChunksRef.current.push(event.data)
      }
      recorder.onstop = () => {
        activeStream.getTracks().forEach((track) => track.stop())
        recordingStreamRef.current = null
        recorderRef.current = null
        setIsRecording(false)
        if (discardRecordingRef.current) return
        const type = (recorder.mimeType || recordingChunksRef.current[0]?.type || 'audio/webm').split(';')[0]
        const blob = new Blob(recordingChunksRef.current, { type })
        if (!blob.size) {
          setRecordingError('No audio was captured. Please try again.')
          return
        }
        const extension = type.includes('mp4') ? 'm4a' : type.includes('ogg') ? 'ogg' : 'webm'
        send.mutate({ body: text.trim(), file: new File([blob], `voice-note.${extension}`, { type }) })
      }
      recorder.start(250)
      setRecordingSeconds(0)
      setIsRecording(true)
    } catch (error) {
      stream?.getTracks().forEach((track) => track.stop())
      setRecordingError(error instanceof DOMException && error.name === 'NotAllowedError'
        ? 'Microphone access was denied. Allow it in your browser settings and try again.'
        : 'The microphone could not start. Please try again.')
    }
  }

  function finishRecording(discard: boolean) {
    discardRecordingRef.current = discard
    if (recorderRef.current?.state === 'recording') recorderRef.current.stop()
  }

  return (
    <div className="agent-chat-shell app-shell flex min-h-screen flex-col px-0 pt-0">
      <header
        className="sticky top-0 z-30 flex items-center justify-between gap-3 border-b px-4 py-3 backdrop-blur-xl sm:px-6"
        style={{
          background: 'color-mix(in oklch, var(--color-bg) 90%, transparent)',
          borderColor: 'color-mix(in oklch, var(--color-line) 78%, transparent)',
        }}
      >
        <div className="flex min-w-0 items-center gap-3">
          <AgentAvatar />
          <div className="min-w-0">
            <h1 className="display-title truncate text-[21px] leading-none sm:text-[23px]">Nourish</h1>
            <p className="mt-1 truncate text-[12px] sm:text-[13px]" style={{ color: 'var(--color-tx2)' }}>Nutrition assistant</p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2 rounded-full border px-2.5 py-1.5 text-xs font-semibold" style={{ borderColor: 'var(--color-line)', color: 'var(--color-tx2)' }}>
          <span className="agent-ready-dot h-2 w-2 rounded-full" style={{ background: 'var(--color-accent-strong)' }} />
          <span className="hidden sm:inline">Ready</span>
        </div>
      </header>

      <main className="mx-auto w-full max-w-[820px] flex-1 px-4 pb-8 pt-6 sm:px-7 sm:pt-9" aria-label="Nutrition chat conversation">
        {messagesPending && <ConversationSkeleton />}
        {!messagesPending && !items.length && <EmptyConversation onSelect={setText} />}
        <div className="space-y-7" aria-live="polite">
          {items.map((message) => <Bubble key={message.id} message={message} />)}
          {send.isPending && <AgentThinking attachment={attachmentKind(send.variables?.file)} />}
          {send.error && (
            <p className="ml-10 rounded-2xl border px-4 py-3 text-sm" role="alert" style={{ color: 'var(--color-warn)', borderColor: 'color-mix(in oklch, var(--color-warn) 35%, var(--color-line))', background: 'var(--color-surface)' }}>
              I could not complete that turn. {send.error.message}
            </p>
          )}
          <div ref={conversationEndRef} aria-hidden="true" />
        </div>
      </main>

      <div className="agent-composer-wrap sticky z-40 px-3 pb-3 sm:px-6" style={{ bottom: 'calc(76px + env(safe-area-inset-bottom))' }}>
      <form onSubmit={submit} className="agent-composer mx-auto max-w-[820px] rounded-[26px] border p-2 shadow-xl" style={{ background: 'color-mix(in oklch, var(--color-surface) 96%, transparent)', borderColor: 'var(--color-line)', boxShadow: '0 16px 44px color-mix(in oklch, var(--color-tx) 12%, transparent)', backdropFilter: 'blur(18px)' }}>
        <input
          ref={mediaInputRef}
          type="file"
          accept="image/jpeg,image/png,image/webp,application/pdf,.pdf"
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0]
            if (file) selectAttachment(file)
          }}
        />
        {isRecording ? (
          <RecordingBar seconds={recordingSeconds} onCancel={() => finishRecording(true)} onSend={() => finishRecording(false)} />
        ) : (
          <>
            {attachment && <AttachmentPreview file={attachment} onRemove={() => {
              setAttachment(null)
              if (mediaInputRef.current) mediaInputRef.current.value = ''
            }} />}
            <label htmlFor="nourish-message" className="sr-only">Message Nourish</label>
            <textarea id="nourish-message" value={text} onChange={(event) => setText(event.target.value)} onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault()
                sendComposedMessage()
              }
            }} rows={1} placeholder={attachment ? 'Add a note about this attachment...' : 'Message Nourish'} className="max-h-36 min-h-[52px] w-full resize-none border-0 bg-transparent px-3 py-3 text-[15px] outline-none sm:text-base" />
        <div className="flex items-center justify-between gap-2 px-1 pb-1">
          <div className="flex items-center gap-1">
            <button type="button" aria-label="Attach meal photo or PDF" title="Attach meal photo or PDF" onClick={() => mediaInputRef.current?.click()} disabled={send.isPending} className="grid h-10 min-h-10 w-10 place-items-center rounded-full transition hover:bg-[var(--color-surface-soft)] disabled:opacity-35" style={{ color: 'var(--color-tx2)' }}><PlusIcon /></button>
            <button type="button" aria-label="Record voice message" title="Record voice message" onClick={startRecording} disabled={send.isPending || Boolean(attachment)} className="grid h-10 min-h-10 w-10 place-items-center rounded-full transition hover:bg-[var(--color-surface-soft)] disabled:opacity-35" style={{ color: 'var(--color-tx2)' }}><MicIcon /></button>
          </div>
          <button
            type="submit"
            aria-label="Send message"
            disabled={(!text.trim() && !attachment) || send.isPending}
            className="grid h-11 min-h-11 w-11 shrink-0 place-items-center rounded-full transition disabled:opacity-35"
            style={{ background: 'var(--color-accent-strong)', color: 'var(--color-on-accent)' }}
          >
            <SendIcon />
          </button>
        </div>
          </>
        )}
      </form>
      {(attachmentError || recordingError || aiError) && <p className="mx-auto mt-2 max-w-[820px] px-2 text-center text-[12px]" role="alert" style={{ color: 'var(--color-danger)' }}>{attachmentError || recordingError || aiError}</p>}
      <p className="mx-auto mt-2 max-w-[820px] text-center text-[11px]" style={{ color: 'var(--color-tx2)' }}>Explicit messages update your tracker. Photos and PDFs stay reviewable.</p>
      </div>

      <BottomNav />
    </div>
  )
}

function Bubble({ message }: { message: Message }) {
  const mine = message.direction === 'inbound'
  const draft = message.status === 'needs_confirmation' ? parseMediaMealDraft(message.payload) : null
  const messageText = stripTags(message.msg_text ?? '') || mediaMessageLabel(message.msg_type)
  const attachmentLabel = mediaMessageLabel(message.msg_type)
  const mediaStatus = message.payload.workflow === 'media' && message.status !== 'needs_confirmation'
    ? message.status === 'confirmed' ? 'Meal logged' : message.status === 'discarded' ? 'Draft discarded' : ''
    : ''

  return (
    <div className="space-y-3">
      {messageText && <div className={`flex items-start gap-3 ${mine ? 'justify-end' : 'justify-start'}`}>
        {!mine && <MiniAgentAvatar />}
        <div
          className={`text-sm leading-relaxed ${mine ? 'max-w-[84%] rounded-[22px_22px_6px_22px] px-4 py-3 sm:max-w-[72%]' : 'min-w-0 max-w-[calc(100%-44px)] pt-1'}`}
          style={{
            background: mine ? 'var(--color-surface-soft)' : 'transparent',
            color: 'var(--color-tx)',
          }}
        >
          {attachmentLabel && messageText !== attachmentLabel && <p className="mb-1 text-[12px] font-semibold opacity-65">{attachmentLabel}</p>}
          {mine
            ? <span className="whitespace-pre-wrap break-words">{messageText}</span>
            : <FormattedMessage text={messageText} />}
          <p className={`mt-1.5 text-[11px] opacity-55 ${mine ? 'text-right' : 'text-left'}`}>{formatMessageTime(message.created_at)}</p>
        </div>
      </div>}
      {draft && <div className="pl-0 sm:pl-11"><MealDraftReview messageId={message.id} payload={message.payload} initialDate={localDateISO()} initialSlot={draft.mealType} /></div>}
      {mediaStatus && <p className="ml-auto w-fit rounded-full px-3 py-1 text-[12px] font-semibold" style={{ background: 'var(--color-accent-soft)', color: 'var(--color-accent-strong)' }}>{mediaStatus}</p>}
    </div>
  )
}

const SUGGESTIONS = [
  'How am I doing on my goals today?',
  'I had 2 rotis and dal for lunch',
  'How much protein do I still need?',
  'Show my nutrition trend this week',
]

function EmptyConversation({ onSelect }: { onSelect: (value: string) => void }) {
  return <section className="mx-auto mb-8 max-w-[720px] py-5 sm:py-12">
    <div className="mx-auto max-w-xl text-center">
      <div className="flex justify-center"><AgentAvatar /></div>
      <h2 className="display-title mt-5 text-[30px] leading-tight sm:text-[36px]">What can I help with?</h2>
      <p className="mx-auto mt-3 max-w-md text-sm" style={{ color: 'var(--color-tx2)' }}>Ask about your nutrition, describe a meal, or send a photo, PDF, or voice message.</p>
    </div>
    <div className="mt-8 grid gap-2 sm:grid-cols-2">
      {SUGGESTIONS.map((suggestion) => <button key={suggestion} type="button" onClick={() => onSelect(suggestion)} className="min-h-0 rounded-2xl border px-4 py-3 text-left text-sm transition hover:bg-[var(--color-surface-soft)]" style={{ background: 'var(--color-surface)', borderColor: 'var(--color-line)' }}>{suggestion}</button>)}
    </div>
  </section>
}

function FormattedMessage({ text }: { text: string }) {
  return <div className="space-y-2 break-words">
    {text.split('\n').map((rawLine, index) => {
      const line = rawLine.trim()
      if (!line) return <div key={index} className="h-1" aria-hidden="true" />
      const bullet = line.match(/^[-*]\s+(.+)$/)
      if (bullet) {
        return <div key={index} className="flex items-start gap-2 pl-1">
          <span aria-hidden="true">•</span>
          <span className="min-w-0">{formatInlineMarkdown(bullet[1])}</span>
        </div>
      }
      const numbered = line.match(/^(\d+)\.\s+(.+)$/)
      if (numbered) {
        return <div key={index} className="flex items-start gap-2 pl-1">
          <span className="shrink-0 tabular-nums">{numbered[1]}.</span>
          <span className="min-w-0">{formatInlineMarkdown(numbered[2])}</span>
        </div>
      }
      return <p key={index}>{formatInlineMarkdown(line)}</p>
    })}
  </div>
}

function formatInlineMarkdown(text: string) {
  return text.split(/(\*\*[^*]+\*\*)/g).map((part, index) =>
    part.startsWith('**') && part.endsWith('**')
      ? <strong key={index}>{part.slice(2, -2)}</strong>
      : part
  )
}

function AgentThinking({ attachment }: { attachment: 'voice' | 'media' | 'text' }) {
  const stages = attachment === 'voice'
    ? ['Transcribing your voice message', 'Checking your tracker', 'Preparing an answer']
    : attachment === 'media'
      ? ['Reading your upload', 'Resolving meal items', 'Preparing your review']
      : ['Reading your message', 'Checking your tracker', 'Preparing an answer']
  const [stage, setStage] = useState(0)

  useEffect(() => {
    const timer = window.setInterval(() => setStage((current) => (current + 1) % stages.length), 1400)
    return () => window.clearInterval(timer)
  }, [stages.length])

  return <div className="flex items-end gap-2" role="status" aria-live="polite">
    <MiniAgentAvatar active />
    <div className="min-w-[210px] pt-1">
      <div className="flex items-center gap-3">
        <span className="agent-thinking-orbit relative grid h-8 w-8 shrink-0 place-items-center rounded-full" style={{ background: 'var(--color-accent-soft)' }} aria-hidden="true">
          <span className="h-2 w-2 rounded-full" style={{ background: 'var(--color-accent-strong)' }} />
        </span>
        <div>
          <p className="text-sm font-semibold">{stages[stage]}</p>
          <div className="mt-1 flex gap-1" aria-hidden="true">
            {[0, 1, 2].map((index) => <span key={index} className="agent-thinking-dot h-1.5 w-1.5 rounded-full" style={{ background: 'var(--color-accent-strong)', animationDelay: `${index * 160}ms` }} />)}
          </div>
        </div>
      </div>
    </div>
    <span className="sr-only">Nourish is working. Please wait.</span>
  </div>
}

function ConversationSkeleton() {
  return <div className="space-y-4" aria-label="Loading conversation" role="status">
    <div className="agent-skeleton ml-auto h-14 w-[58%] rounded-[20px_20px_6px_20px]" />
    <div className="flex items-end gap-2"><div className="agent-skeleton h-8 w-8 rounded-full" /><div className="agent-skeleton h-20 w-[72%] rounded-[20px_20px_20px_6px]" /></div>
  </div>
}

function AttachmentPreview({ file, onRemove }: { file: File; onRemove: () => void }) {
  const [previewUrl, setPreviewUrl] = useState('')

  useEffect(() => {
    if (!file.type.startsWith('image/')) return
    const url = URL.createObjectURL(file)
    setPreviewUrl(url)
    return () => URL.revokeObjectURL(url)
  }, [file])

  return <div className="mx-1 mt-1 flex items-center gap-3 rounded-2xl border p-2" style={{ borderColor: 'var(--color-line)', background: 'var(--color-surface-soft)' }}>
    {previewUrl ? (
      // The preview is a local object URL and is never fetched from another origin.
      // eslint-disable-next-line @next/next/no-img-element
      <img src={previewUrl} alt="Selected meal attachment" className="h-14 w-14 rounded-xl object-cover" />
    ) : (
      <span className="grid h-14 w-14 shrink-0 place-items-center rounded-xl text-xs font-bold" style={{ background: 'var(--color-surface)', color: 'var(--color-accent-strong)' }}>PDF</span>
    )}
    <div className="min-w-0 flex-1">
      <p className="truncate text-sm font-semibold">{file.name}</p>
      <p className="text-[12px]" style={{ color: 'var(--color-tx2)' }}>{formatFileSize(file.size)} · Ready to send</p>
    </div>
    <button type="button" onClick={onRemove} aria-label={`Remove ${file.name}`} className="grid h-10 min-h-10 w-10 shrink-0 place-items-center rounded-full" style={{ color: 'var(--color-tx2)' }}><CloseIcon /></button>
  </div>
}

function RecordingBar({ seconds, onCancel, onSend }: { seconds: number; onCancel: () => void; onSend: () => void }) {
  return <div className="flex min-h-[104px] items-center gap-3 px-2 py-2" role="status">
    <span className="agent-recording-dot h-3 w-3 shrink-0 rounded-full" style={{ background: 'var(--color-danger)' }} />
    <div className="min-w-0 flex-1">
      <p className="text-sm font-semibold">Recording voice message</p>
      <p className="font-mono text-xs tabular-nums" style={{ color: 'var(--color-tx2)' }}>{formatDuration(seconds)}</p>
    </div>
    <button type="button" onClick={onCancel} className="min-h-10 rounded-full px-3 text-sm font-semibold" style={{ color: 'var(--color-danger)' }}>Cancel</button>
    <button type="button" onClick={onSend} aria-label="Send voice message" className="grid h-11 min-h-11 w-11 shrink-0 place-items-center rounded-full" style={{ background: 'var(--color-accent-strong)', color: 'var(--color-on-accent)' }}><SendIcon /></button>
  </div>
}

function AgentAvatar() {
  return <span className="relative grid h-12 w-12 shrink-0 place-items-center rounded-[16px]" style={{ background: 'var(--color-accent-strong)', color: 'var(--color-on-accent)', boxShadow: '0 8px 22px color-mix(in oklch, var(--color-accent-strong) 24%, transparent)' }} aria-hidden="true">
    <NourishMark />
    <span className="absolute -bottom-0.5 -right-0.5 h-3.5 w-3.5 rounded-full border-2" style={{ background: 'oklch(0.72 0.17 150)', borderColor: 'var(--color-bg)' }} />
  </span>
}

function MiniAgentAvatar({ active = false }: { active?: boolean }) {
  return <span className={`grid h-8 w-8 shrink-0 place-items-center rounded-xl ${active ? 'agent-avatar-active' : ''}`} style={{ background: 'var(--color-accent-soft)', color: 'var(--color-accent-strong)' }} aria-hidden="true"><NourishMark small /></span>
}

function NourishMark({ small = false }: { small?: boolean }) {
  return <svg width={small ? 16 : 23} height={small ? 16 : 23} viewBox="0 0 24 24" fill="none"><path d="M7 15.5c0-5.2 3.7-8.3 10-9.5.3 5.9-2.8 10-8.2 10.2" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /><path d="M7.2 16c1.8-2.6 4-4.6 7-6.2M7 12.2c-1.5-.8-2.8-2.1-3.7-3.9C6 7.6 8.1 8 9.7 9.2" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /><path d="M7 12v7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>
}

function MicIcon() {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="8.5" y="3.5" width="7" height="12" rx="3.5" stroke="currentColor" strokeWidth="1.8" /><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3M8.5 21h7" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>
}

function PlusIcon() {
  return <svg width="21" height="21" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>
}

function CloseIcon() {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m7 7 10 10M17 7 7 17" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>
}

function SendIcon() {
  return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m5 12 14-7-4.7 14-2.6-5.1L5 12Z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /><path d="m11.7 13.9 3-3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>
}

function formatMessageTime(value: string): string {
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return ''
  return parsed.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

function preferredRecordingType(): string {
  return ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus']
    .find((type) => MediaRecorder.isTypeSupported(type)) ?? ''
}

function attachmentKind(file?: File): 'voice' | 'media' | 'text' {
  if (!file) return 'text'
  return file.type.startsWith('audio/') ? 'voice' : 'media'
}

function outgoingMessageType(file?: File): string {
  if (!file) return 'text'
  if (file.type.startsWith('audio/')) return 'audio'
  if (file.type === 'application/pdf') return 'pdf'
  return 'image'
}

function normalizeAttachment(file: File): File {
  if (/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') {
    return new File([file], file.name, { type: 'application/pdf', lastModified: file.lastModified })
  }
  return file
}

function validateAttachment(file: File): string {
  const limits: Record<string, number> = {
    'image/jpeg': 10 * 1024 * 1024,
    'image/png': 10 * 1024 * 1024,
    'image/webp': 10 * 1024 * 1024,
    'application/pdf': 20 * 1024 * 1024,
  }
  const limit = limits[file.type]
  if (!limit) return 'Choose a JPG, PNG, WebP, or PDF file.'
  if (file.size > limit) {
    return `${file.type === 'application/pdf' ? 'PDF' : 'Image'} must be ${limit / (1024 * 1024)} MB or smaller.`
  }
  if (!file.size) return 'That attachment is empty.'
  return ''
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function mediaMessageLabel(type: Message['msg_type']): string {
  if (type === 'audio') return 'Voice message'
  if (type === 'image') return 'Meal photo'
  if (type === 'pdf') return 'Meal PDF'
  return ''
}

function formatDuration(seconds: number): string {
  const minutes = Math.floor(seconds / 60)
  return `${minutes}:${String(seconds % 60).padStart(2, '0')}`
}

/** The backend splices captions in as tags; the UI shows the content. */
function stripTags(text: string): string {
  return text
    .replace(/<\/?(image|audio|document)>/g, '')
    .replace(/\[auto-video-caption\]:\s*/g, '')
    .replace(/User sent an image, description above/g, '')
    .trim()
}
