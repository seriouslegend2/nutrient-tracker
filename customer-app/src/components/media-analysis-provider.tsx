'use client'

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react'

import { api, type Message, type Page } from '@/lib/api-client'
import { mediaWorkflowMessages } from '@/lib/media-analysis'
import { parseMediaMealDraft } from '@/lib/meal-draft'

type Selection = { kind: 'image' | 'pdf'; name: string }

type MediaAnalysisContextValue = {
  selection: Selection | null
  previewUrl: string | null
  processingCount: number
  draftMessages: Message[]
  captureError: string
  loggedCount: number | null
  processFile: (file: File, kind: Selection['kind']) => void
  clearCapture: () => void
  completeCapture: (count: number) => void
  resolveDraft: (messageId: string, status: 'confirmed' | 'discarded') => void
  refresh: () => Promise<unknown>
}

const MediaAnalysisContext = createContext<MediaAnalysisContextValue | null>(null)

export function MediaAnalysisProvider({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  const queryClient = useQueryClient()
  const previewRef = useRef<string | null>(null)
  const [selection, setSelection] = useState<Selection | null>(null)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [captureError, setCaptureError] = useState('')
  const [loggedCount, setLoggedCount] = useState<number | null>(null)
  const [recentMessages, setRecentMessages] = useState<Message[]>([])

  const messages = useQuery({
    queryKey: ['media-workflows'],
    queryFn: () => api.messages({ page_size: 100 }),
    enabled: !pathname.startsWith('/auth'),
    refetchOnWindowFocus: true,
    refetchInterval: (query) => {
      const rows = query.state.data?.items ?? []
      return mediaWorkflowMessages(rows).processing.length ? 1500 : 15_000
    },
  })

  const allMessages = useMemo(() => {
    const rows = messages.data?.items ?? []
    const byId = new Map(rows.map((message) => [message.id, message]))
    for (const recent of recentMessages) {
      const stored = byId.get(recent.id)
      if (!stored || !['confirmed', 'discarded', 'failed'].includes(stored.status)) {
        byId.set(recent.id, recent)
      }
    }
    return [...byId.values()]
  }, [messages.data?.items, recentMessages])
  const workflows = useMemo(() => mediaWorkflowMessages(allMessages), [allMessages])

  const capture = useMutation({
    mutationFn: (file: File) => {
      const form = new FormData()
      form.set('file', file)
      return api.sendMessage(form)
    },
    onSuccess: async (created) => {
      setRecentMessages(created)
      const failed = created.find((message) => message.status === 'failed')
      const draft = created.find((message) =>
        message.status === 'needs_confirmation' && parseMediaMealDraft(message.payload)
      )
      if (!draft) {
        const reply = [...created].reverse().find((message) => message.msg_text)
        setCaptureError(failed?.msg_text || reply?.msg_text || 'No reviewable meal items were detected. Try another file.')
      }
      await queryClient.invalidateQueries({ queryKey: ['media-workflows'] })
    },
    onError: (error) => setCaptureError(error.message),
  })

  useEffect(() => () => {
    if (previewRef.current) URL.revokeObjectURL(previewRef.current)
  }, [])

  useEffect(() => {
    if (loggedCount == null) return
    const timer = window.setTimeout(() => setLoggedCount(null), 5000)
    return () => window.clearTimeout(timer)
  }, [loggedCount])

  function replacePreview(next: string | null) {
    if (previewRef.current) URL.revokeObjectURL(previewRef.current)
    previewRef.current = next
    setPreviewUrl(next)
  }

  function processFile(file: File, kind: Selection['kind']) {
    setCaptureError('')
    setLoggedCount(null)
    setRecentMessages([])
    setSelection({ kind, name: file.name })
    replacePreview(kind === 'image' ? URL.createObjectURL(file) : null)
    capture.mutate(file)
  }

  function clearCapture() {
    setSelection(null)
    setRecentMessages([])
    replacePreview(null)
    void queryClient.invalidateQueries({ queryKey: ['media-workflows'] })
  }

  function completeCapture(count: number) {
    setLoggedCount(count)
    clearCapture()
  }

  function resolveDraft(messageId: string, status: 'confirmed' | 'discarded') {
    setRecentMessages((current) => current.filter((message) => message.id !== messageId))
    queryClient.setQueryData<Page<Message>>(['media-workflows'], (current) => current ? {
      ...current,
      items: current.items.map((message) => message.id === messageId ? { ...message, status } : message),
    } : current)
    void queryClient.invalidateQueries({ queryKey: ['media-workflows'] })
  }

  const processingCount = Math.max(workflows.processing.length, capture.isPending ? 1 : 0)
  const value: MediaAnalysisContextValue = {
    selection,
    previewUrl,
    processingCount,
    draftMessages: workflows.drafts,
    captureError,
    loggedCount,
    processFile,
    clearCapture,
    completeCapture,
    resolveDraft,
    refresh: () => messages.refetch(),
  }

  return (
    <MediaAnalysisContext.Provider value={value}>
      {children}
      <MediaAnalysisTray processingCount={processingCount} draftCount={workflows.drafts.length} />
    </MediaAnalysisContext.Provider>
  )
}

export function useMediaAnalysis() {
  const value = useContext(MediaAnalysisContext)
  if (!value) throw new Error('useMediaAnalysis must be used inside MediaAnalysisProvider')
  return value
}

function MediaAnalysisTray({ processingCount, draftCount }: {
  processingCount: number
  draftCount: number
}) {
  if (!processingCount && !draftCount) return null
  return (
    <Link href="/home#quick-capture" aria-live="polite"
      className="fixed left-3 right-3 top-3 z-[70] mx-auto flex max-w-[680px] items-center gap-3 rounded-2xl border px-4 py-3 shadow-xl"
      style={{ background: 'color-mix(in oklch, var(--color-surface) 96%, transparent)', borderColor: 'var(--color-line)', backdropFilter: 'blur(18px)' }}>
      {processingCount > 0 ? <span className="h-5 w-5 shrink-0 animate-spin rounded-full border-2" style={{ borderColor: 'var(--color-line)', borderTopColor: 'var(--color-accent-strong)' }} aria-hidden="true" />
        : <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full font-bold" style={{ background: 'var(--color-accent-soft)', color: 'var(--color-accent-strong)' }} aria-hidden="true">✓</span>}
      <span className="min-w-0 flex-1">
        <span className="block font-bold">{processingCount > 0 ? `Analyzing ${processingCount} upload${processingCount === 1 ? '' : 's'}` : `${draftCount} meal draft${draftCount === 1 ? '' : 's'} ready`}</span>
        <span className="block truncate text-xs" style={{ color: 'var(--color-tx2)' }}>{processingCount > 0 ? 'Analysis continues while you use other pages.' : 'Open Today to review before logging.'}</span>
      </span>
      <span className="text-sm font-bold" style={{ color: 'var(--color-accent-strong)' }}>{draftCount ? 'Review' : 'View'}</span>
    </Link>
  )
}
