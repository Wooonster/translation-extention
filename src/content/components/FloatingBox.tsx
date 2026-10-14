import React, { useEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { getTranslation, getLanguageName } from '../../lib/i18n'
import { interfaceLanguageFor, textDirectionFor, type InterfaceSide, type UserLanguage } from '../../lib/config'
import { phraseFromTokenSelection, segmentVocabularyText, type VocabularyToken } from '../../lib/language'
import type { VocabEntry, VocabSummary } from '../../lib/memory'
import { isInvalidatedError } from '../extensionContext'

interface FloatingBoxProps {
  position: { top: number; left: number }
  selectionKey?: string
  status: 'idle' | 'counting' | 'loading' | 'streaming' | 'success' | 'error'
  sourceText?: string
  sourceLang?: string
  result?: string
  progress?: number // 0-100 for countdown
  onFollowup?: (
    query: string,
    sourceText: string,
    translatedText: string,
    callbacks?: {
      onStart?: () => void
      onDelta?: (delta: string) => void
      onComplete?: (answer: string) => void
    }
  ) => Promise<string>
  onClose?: () => void
  onSaveVocab?: (input: { word: string; sourceSentence: string }) => Promise<VocabEntry>
  onEnrichVocab?: (id: string, userLanguage: UserLanguage) => Promise<VocabEntry>
  onSummarizeVocab?: (userLanguage: UserLanguage) => Promise<VocabSummary>
  onSnoozeReview?: () => Promise<void> | void
  userLanguage?: UserLanguage
  interfaceSide?: InterfaceSide
  reviewNotice?: { count: number } | null
}

const DEFAULT_BOX_WIDTH = 376
const DEFAULT_BOX_HEIGHT = 300
const MIN_BOX_WIDTH = 320
const MIN_BOX_HEIGHT = 248
const VIEWPORT_MARGIN = 12

type ResizeDirection = 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'nw'

const RESIZE_DIRECTIONS: ResizeDirection[] = ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw']

const RESIZE_CURSOR: Record<ResizeDirection, string> = {
  n: 'n-resize',
  ne: 'ne-resize',
  e: 'e-resize',
  se: 'se-resize',
  s: 's-resize',
  sw: 'sw-resize',
  w: 'w-resize',
  nw: 'nw-resize',
}

const getMinBoxWidth = () => Math.min(MIN_BOX_WIDTH, Math.max(0, window.innerWidth - VIEWPORT_MARGIN * 2))

const getMinBoxHeight = () => Math.min(MIN_BOX_HEIGHT, Math.max(0, window.innerHeight - VIEWPORT_MARGIN * 2))

const getDefaultBoxSize = () => ({
  width: Math.min(DEFAULT_BOX_WIDTH, Math.max(getMinBoxWidth(), window.innerWidth - VIEWPORT_MARGIN * 2)),
  height: Math.min(DEFAULT_BOX_HEIGHT, Math.max(getMinBoxHeight(), window.innerHeight - VIEWPORT_MARGIN * 2)),
})

const markdownRemarkPlugins = [remarkGfm]
const canUseKatex = typeof document !== 'undefined' && document.compatMode === 'CSS1Compat'

type KatexPlugins = {
  remarkPlugins: any[]
  rehypePlugins: any[]
}

let katexPluginsPromise: Promise<KatexPlugins | null> | null = null

function loadKatexPlugins(): Promise<KatexPlugins | null> {
  if (!canUseKatex) return Promise.resolve(null)
  if (!katexPluginsPromise) {
    katexPluginsPromise = Promise.all([
      import('remark-math'),
      import('rehype-katex'),
    ]).then(([remarkMath, rehypeKatex]) => ({
      remarkPlugins: [remarkGfm, remarkMath.default],
      rehypePlugins: [[rehypeKatex.default, { output: 'mathml', throwOnError: false, strict: false }]],
    })).catch(() => null)
  }
  return katexPluginsPromise
}

const MarkdownFallback: React.FC<{ content: string }> = ({ content }) => (
  <div className="whitespace-pre-wrap break-words text-[13px] leading-6 text-slate-700">
    {content}
  </div>
)

class MarkdownErrorBoundary extends React.Component<
  { content: string; children: React.ReactNode },
  { hasError: boolean }
> {
  constructor(props: { content: string; children: React.ReactNode }) {
    super(props)
    this.state = { hasError: false }
  }

  static getDerivedStateFromError(): { hasError: boolean } {
    return { hasError: true }
  }

  componentDidUpdate(prevProps: Readonly<{ content: string; children: React.ReactNode }>) {
    if (prevProps.content !== this.props.content && this.state.hasError) {
      this.setState({ hasError: false })
    }
  }

  componentDidCatch() {}

  render() {
    if (this.state.hasError) {
      return <MarkdownFallback content={this.props.content} />
    }
    return this.props.children
  }
}

const SafeMarkdown: React.FC<{ content: string; enableMath?: boolean }> = ({ content, enableMath = false }) => {
  const [katexPlugins, setKatexPlugins] = useState<KatexPlugins | null>(null)

  useEffect(() => {
    if (!enableMath || !canUseKatex) return
    let cancelled = false
    loadKatexPlugins().then(plugins => {
      if (!cancelled) setKatexPlugins(plugins)
    })
    return () => {
      cancelled = true
    }
  }, [enableMath])

  const mathReady = Boolean(enableMath && canUseKatex && katexPlugins)
  return (
    <MarkdownErrorBoundary content={content}>
      <ReactMarkdown
        remarkPlugins={mathReady ? katexPlugins!.remarkPlugins : markdownRemarkPlugins}
        rehypePlugins={mathReady ? katexPlugins!.rehypePlugins : []}
      >
        {content}
      </ReactMarkdown>
    </MarkdownErrorBoundary>
  )
}

interface SaveFeedback {
  phase: 'idle' | 'saving' | 'pending' | 'ready' | 'error'
  entryId?: string
  word?: string
  sourceSentence?: string
  detail?: string
}

const idleSaveFeedback: SaveFeedback = { phase: 'idle' }

function selectableTokenRange(tokens: VocabularyToken[], from: number, to: number): number[] {
  const start = Math.min(from, to)
  const end = Math.max(from, to)
  return tokens.filter(token => token.selectable && token.index >= start && token.index <= end).map(token => token.index)
}

function clipLabel(text: string, max = 36): string {
  const trimmed = text.trim()
  if (trimmed.length <= max) return trimmed
  return `${trimmed.slice(0, Math.max(1, max - 1))}…`
}

const FloatingBox: React.FC<FloatingBoxProps> = ({ position, selectionKey, status, sourceText, sourceLang, result, progress = 0, onFollowup, onClose, onSaveVocab, onEnrichVocab, onSummarizeVocab, onSnoozeReview, userLanguage = 'zh', interfaceSide, reviewNotice }) => {
  if (status === 'idle') return null

  const basePosition = useMemo(() => ({ top: position.top + 10, left: position.left }), [position.left, position.top])
  const boxRef = useRef<HTMLDivElement | null>(null)
  const dragRef = useRef<{
    startX: number
    startY: number
    startTop: number
    startLeft: number
    boxWidth: number
    boxHeight: number
  } | null>(null)
  const resizeRef = useRef<{
    direction: ResizeDirection
    startX: number
    startY: number
    startWidth: number
    startHeight: number
    startTop: number
    startLeft: number
  } | null>(null)
  const [pos, setPos] = useState(basePosition)
  const [size, setSize] = useState(getDefaultBoxSize)
  const [isDragging, setIsDragging] = useState(false)
  const [resizeDirection, setResizeDirection] = useState<ResizeDirection | null>(null)
  const isResizing = resizeDirection !== null
  const [isPinned, setIsPinned] = useState(false)
  const [copied, setCopied] = useState(false)
  const [followupInputOpen, setFollowupInputOpen] = useState(false)
  const [followupQuery, setFollowupQuery] = useState('')
  const [followupLoading, setFollowupLoading] = useState(false)
  const [followupHistory, setFollowupHistory] = useState<Array<{ query: string; answer: string }>>([])
  const [followupError, setFollowupError] = useState('')
  const [currentPage, setCurrentPage] = useState(0)
  const swipeRef = useRef<{ startX: number; startY: number; pointerId: number } | null>(null)
  const composingRef = useRef(false)
  const followupListRef = useRef<HTMLDivElement | null>(null)
  const [originalOpen, setOriginalOpen] = useState(false)
  const [selectedTokens, setSelectedTokens] = useState<number[]>([])
  const [saveFeedback, setSaveFeedback] = useState<SaveFeedback>(idleSaveFeedback)
  const [reviewDigest, setReviewDigest] = useState('')
  const [reviewError, setReviewError] = useState('')
  const [summarizing, setSummarizing] = useState(false)
  const [noticeDismissed, setNoticeDismissed] = useState(false)
  const originalBodyRef = useRef<HTMLDivElement | null>(null)
  const tokenDragRef = useRef<{ anchor: number } | null>(null)
  const tokenAnchorRef = useRef<number | null>(null)
  const saveRequestRef = useRef(0)
  const followupInFlightRef = useRef(false)
  const followupRequestRef = useRef(0)

  const lang = interfaceLanguageFor(userLanguage, interfaceSide ?? (userLanguage === 'zh' ? 'user' : 'en'))
  const t = getTranslation(lang)
  const enableMathRendering = canUseKatex && status !== 'streaming'
  const normalizedSourceLang = String(sourceLang ?? '').trim()
  const sourceLangDisplay = normalizedSourceLang
    ? getLanguageName(normalizedSourceLang, lang)
    : t.floating.autoDetected

  useEffect(() => {
    setPos(basePosition)
    setIsPinned(false)
    setIsDragging(false)
    setResizeDirection(null)
    dragRef.current = null
    resizeRef.current = null
    setCopied(false)
    setFollowupInputOpen(false)
    setFollowupQuery('')
    setFollowupLoading(false)
    setFollowupHistory([])
    setFollowupError('')
    setCurrentPage(0)
    setOriginalOpen(false)
    setSelectedTokens([])
    tokenAnchorRef.current = null
    setSaveFeedback(idleSaveFeedback)
    setReviewDigest('')
    setReviewError('')
    setSummarizing(false)
    setNoticeDismissed(false)
    tokenDragRef.current = null
    saveRequestRef.current += 1
    followupRequestRef.current += 1
    followupInFlightRef.current = false
  }, [selectionKey])

  useEffect(() => {
    if (currentPage === 1 && followupListRef.current) {
      followupListRef.current.scrollTop = followupListRef.current.scrollHeight
    }
  }, [followupHistory, currentPage])

  useEffect(() => {
    if (isPinned || isDragging || isResizing) return
    setPos(basePosition)
  }, [basePosition, isDragging, isPinned, isResizing])

  useEffect(() => {
    if (!copied) return
    const t = window.setTimeout(() => setCopied(false), 1500)
    return () => window.clearTimeout(t)
  }, [copied])

  useEffect(() => {
    setNoticeDismissed(false)
  }, [reviewNotice?.count])

  const originalText = String(sourceText ?? '')
  const tokens = useMemo(() => segmentVocabularyText(originalText), [originalText])
  const selectedTokenSet = useMemo(() => new Set(selectedTokens), [selectedTokens])
  const pickedText = useMemo(
    () => phraseFromTokenSelection(tokens, selectedTokenSet),
    [selectedTokenSet, tokens]
  )
  const showSaveChip = Boolean(pickedText) && /[\p{L}\p{N}]/u.test(pickedText)
  const showReview = Boolean(reviewDigest) || (Boolean(reviewNotice) && !noticeDismissed)
  const reviewLabel = !reviewNotice
    ? ''
    : reviewNotice.count === 1
      ? t.floating.reviewReadyOne
      : t.floating.reviewReady.replace('{count}', String(reviewNotice.count))

  useEffect(() => {
    if (!isDragging && !isResizing) return

    const root = document.documentElement
    const previousCursor = root.style.cursor
    const previousUserSelect = root.style.userSelect
    root.style.cursor = resizeDirection ? RESIZE_CURSOR[resizeDirection] : 'grabbing'
    root.style.userSelect = 'none'

    const onMove = (e: PointerEvent) => {
      const dragStart = dragRef.current
      if (dragStart) {
        e.preventDefault()

        const dx = e.clientX - dragStart.startX
        const dy = e.clientY - dragStart.startY
        const maxLeft = Math.max(VIEWPORT_MARGIN, window.innerWidth - dragStart.boxWidth - VIEWPORT_MARGIN)
        const maxTop = Math.max(VIEWPORT_MARGIN, window.innerHeight - dragStart.boxHeight - VIEWPORT_MARGIN)

        const nextLeft = Math.min(maxLeft, Math.max(VIEWPORT_MARGIN, dragStart.startLeft + dx))
        const nextTop = Math.min(maxTop, Math.max(VIEWPORT_MARGIN, dragStart.startTop + dy))

        setPos({ top: nextTop, left: nextLeft })
        return
      }

      const resizeStart = resizeRef.current
      if (!resizeStart) return
      e.preventDefault()

      const dx = e.clientX - resizeStart.startX
      const dy = e.clientY - resizeStart.startY
      const startRight = resizeStart.startLeft + resizeStart.startWidth
      const startBottom = resizeStart.startTop + resizeStart.startHeight
      const minWidth = getMinBoxWidth()
      const minHeight = getMinBoxHeight()
      let nextLeft = resizeStart.startLeft
      let nextTop = resizeStart.startTop
      let nextRight = startRight
      let nextBottom = startBottom

      if (resizeStart.direction.includes('e')) {
        nextRight = Math.min(
          window.innerWidth - VIEWPORT_MARGIN,
          Math.max(resizeStart.startLeft + minWidth, startRight + dx)
        )
      }
      if (resizeStart.direction.includes('w')) {
        nextLeft = Math.max(
          VIEWPORT_MARGIN,
          Math.min(startRight - minWidth, resizeStart.startLeft + dx)
        )
      }
      if (resizeStart.direction.includes('s')) {
        nextBottom = Math.min(
          window.innerHeight - VIEWPORT_MARGIN,
          Math.max(resizeStart.startTop + minHeight, startBottom + dy)
        )
      }
      if (resizeStart.direction.includes('n')) {
        nextTop = Math.max(
          VIEWPORT_MARGIN,
          Math.min(startBottom - minHeight, resizeStart.startTop + dy)
        )
      }

      setPos({ top: nextTop, left: nextLeft })
      setSize({ width: nextRight - nextLeft, height: nextBottom - nextTop })
    }

    const onUp = () => {
      setIsDragging(false)
      setResizeDirection(null)
      dragRef.current = null
      resizeRef.current = null
    }

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp, { once: true })
    window.addEventListener('pointercancel', onUp, { once: true })

    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
      root.style.cursor = previousCursor
      root.style.userSelect = previousUserSelect
    }
  }, [isDragging, isResizing, resizeDirection])

  const startDrag = (e: React.PointerEvent) => {
    const target = e.target as HTMLElement | null
    if (target?.closest?.('[data-no-drag="true"]')) return
    if (e.button !== 0) return
    e.preventDefault()
    setIsPinned(true)
    setIsDragging(true)
    dragRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      startTop: pos.top,
      startLeft: pos.left,
      boxWidth: size.width,
      boxHeight: size.height,
    }
  }

  const startResize = (e: React.PointerEvent, direction: ResizeDirection) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    setIsPinned(true)
    resizeRef.current = {
      direction,
      startX: e.clientX,
      startY: e.clientY,
      startWidth: size.width,
      startHeight: size.height,
      startTop: pos.top,
      startLeft: pos.left,
    }
    setResizeDirection(direction)
  }

  const copyResult = async (textToCopy?: string | React.MouseEvent) => {
    // If called from onClick event, textToCopy will be the event object
    const content = typeof textToCopy === 'string' ? textToCopy : result
    const text = String(content ?? '').trimEnd()
    if (!text) return

    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      return
    } catch {}

    try {
      const el = document.createElement('textarea')
      el.value = text
      el.style.position = 'fixed'
      el.style.top = '0'
      el.style.left = '0'
      el.style.width = '1px'
      el.style.height = '1px'
      el.style.opacity = '0'
      document.body.appendChild(el)
      el.focus()
      el.select()
      const ok = document.execCommand('copy')
      document.body.removeChild(el)
      if (ok) setCopied(true)
    } catch {}
  }

  const resolveTokenIndex = (clientX: number, clientY: number): number | null => {
    const root = originalBodyRef.current?.getRootNode()
    const hit = root instanceof ShadowRoot ? root.elementFromPoint(clientX, clientY) : document.elementFromPoint(clientX, clientY)
    const tokenEl = hit?.closest?.('[data-token-index]')
    if (!tokenEl) return null
    const index = Number(tokenEl.getAttribute('data-token-index'))
    return Number.isInteger(index) ? index : null
  }

  const onTokenPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    const index = resolveTokenIndex(event.clientX, event.clientY)
    if (index == null || !tokens[index]?.selectable) return
    event.preventDefault()

    if (event.metaKey || event.ctrlKey) {
      tokenAnchorRef.current = index
      tokenDragRef.current = null
      setSelectedTokens(current => current.includes(index) ? current.filter(item => item !== index) : [...current, index].sort((a, b) => a - b))
      return
    }

    if (!event.shiftKey) tokenAnchorRef.current = index
    else if (tokenAnchorRef.current == null) tokenAnchorRef.current = index
    const anchor = tokenAnchorRef.current ?? index
    tokenDragRef.current = { anchor }
    setSelectedTokens(selectableTokenRange(tokens, anchor, index))
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  const onTokenPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const anchor = tokenDragRef.current?.anchor
    if (anchor == null) return
    const index = resolveTokenIndex(event.clientX, event.clientY)
    if (index == null) return
    setSelectedTokens(selectableTokenRange(tokens, anchor, index))
  }

  const onTokenPointerUp = () => {
    tokenDragRef.current = null
  }

  const commitSave = async (word: string, sourceSentence: string) => {
    const trimmedWord = word.trim()
    const trimmedSentence = sourceSentence.trim() || trimmedWord
    if (!trimmedWord || !onSaveVocab || !onEnrichVocab) return

    const requestId = saveRequestRef.current + 1
    saveRequestRef.current = requestId
    setSaveFeedback({ phase: 'saving', word: trimmedWord, sourceSentence: trimmedSentence })
    setSelectedTokens([])
    tokenAnchorRef.current = null

    try {
      const entry = await onSaveVocab({ word: trimmedWord, sourceSentence: trimmedSentence })
      if (saveRequestRef.current !== requestId) return
      setSaveFeedback({
        phase: 'pending',
        entryId: entry.id,
        word: entry.word,
        sourceSentence: trimmedSentence,
      })

      try {
        const enriched = await onEnrichVocab(entry.id, userLanguage)
        if (saveRequestRef.current !== requestId) return
        setSaveFeedback({
          phase: enriched.status === 'ready' ? 'ready' : 'error',
          entryId: enriched.id,
          word: enriched.word,
          sourceSentence: trimmedSentence,
          detail: enriched.userTranslation || enriched.translation,
        })
      } catch (error) {
        if (saveRequestRef.current !== requestId || isInvalidatedError(error)) return
        setSaveFeedback({
          phase: 'error',
          entryId: entry.id,
          word: entry.word,
          sourceSentence: trimmedSentence,
        })
      }
    } catch (error) {
      if (saveRequestRef.current !== requestId || isInvalidatedError(error)) return
      setSaveFeedback({ phase: 'error', word: trimmedWord, sourceSentence: trimmedSentence })
    }
  }

  const retrySave = () => {
    if (saveFeedback.phase === 'saving') return
    if (saveFeedback.entryId && onEnrichVocab) {
      const requestId = saveRequestRef.current + 1
      saveRequestRef.current = requestId
      const entryId = saveFeedback.entryId
      setSaveFeedback(prev => ({ ...prev, phase: 'pending' }))
      onEnrichVocab(entryId, userLanguage)
        .then(enriched => {
          if (saveRequestRef.current !== requestId) return
          setSaveFeedback(prev => ({
            ...prev,
            phase: enriched.status === 'ready' ? 'ready' : 'error',
            entryId: enriched.id,
            word: enriched.word,
            detail: enriched.userTranslation || enriched.translation,
          }))
        })
        .catch((error: unknown) => {
          if (saveRequestRef.current !== requestId || isInvalidatedError(error)) return
          setSaveFeedback(prev => ({ ...prev, phase: 'error', entryId }))
        })
      return
    }
    if (saveFeedback.word) {
      void commitSave(saveFeedback.word, saveFeedback.sourceSentence || originalText.trim())
    }
  }

  const runSummary = async () => {
    if (!onSummarizeVocab || summarizing) return
    setSummarizing(true)
    setReviewError('')
    try {
      const summary = await onSummarizeVocab(userLanguage)
      setReviewDigest(summary.text)
    } catch (error) {
      if (isInvalidatedError(error)) return
      setReviewError(t.floating.summaryFailed)
    } finally {
      setSummarizing(false)
    }
  }

  const runLater = async () => {
    setNoticeDismissed(true)
    try {
      await onSnoozeReview?.()
    } catch (error) {
      if (isInvalidatedError(error)) return
      setNoticeDismissed(false)
    }
  }


  const canFlip = status === 'success' && Boolean(String(result ?? '').trim())

  const startSwipe = (e: React.PointerEvent) => {
    const target = e.target as HTMLElement | null
    if (!canFlip || e.pointerType === 'mouse' || e.button !== 0) return
    if (target?.closest?.('button, input, textarea, a, [data-no-swipe="true"]')) return
    swipeRef.current = { startX: e.clientX, startY: e.clientY, pointerId: e.pointerId }
  }

  const endSwipe = (e: React.PointerEvent) => {
    const swipe = swipeRef.current
    swipeRef.current = null
    if (!canFlip || !swipe || swipe.pointerId !== e.pointerId) return

    const selection = boxRef.current?.ownerDocument.getSelection()
    if (selection && !selection.isCollapsed && selection.toString().trim()) return

    const deltaX = e.clientX - swipe.startX
    const deltaY = e.clientY - swipe.startY
    if (Math.abs(deltaX) < 48 || Math.abs(deltaX) <= Math.abs(deltaY) * 1.25) return
    setCurrentPage(deltaX > 0 ? 0 : 1)
  }

  const cancelSwipe = () => {
    swipeRef.current = null
  }

  const openFollowup = () => {
    if (!canFlip) return
    setCurrentPage(1)
    setFollowupInputOpen(true)
  }

  const submitFollowup = async () => {
    const draft = followupQuery
    const query = draft.trim()
    const currentSource = String(sourceText ?? '').trim()
    const currentTranslated = String(result ?? '').trim()
    if (followupInFlightRef.current || !query || !currentSource || !currentTranslated || !onFollowup) return

    const requestId = followupRequestRef.current + 1
    followupRequestRef.current = requestId
    followupInFlightRef.current = true
    setFollowupLoading(true)
    setFollowupError('')
    setFollowupHistory(prev => [...prev, { query, answer: '' }])
    setFollowupQuery('')
    setCurrentPage(1)
    try {
      let completedAnswer = ''
      const answer = await onFollowup(query, currentSource, currentTranslated, {
        onDelta: delta => {
          completedAnswer += delta
          setFollowupHistory(prev => {
            if (!prev.length) return prev
            const next = [...prev]
            next[next.length - 1] = { ...next[next.length - 1], answer: completedAnswer }
            return next
          })
        },
        onComplete: finalAnswer => {
          const normalizedAnswer = String(finalAnswer ?? completedAnswer)
          completedAnswer = normalizedAnswer
          setFollowupHistory(prev => {
            if (!prev.length) return prev
            const next = [...prev]
            next[next.length - 1] = { ...next[next.length - 1], answer: normalizedAnswer }
            return next
          })
        },
      })

      if (answer && !completedAnswer) {
        setFollowupHistory(prev => {
          if (!prev.length) return prev
          const next = [...prev]
          next[next.length - 1] = { ...next[next.length - 1], answer }
          return next
        })
      }
    } catch (e: any) {
      if (followupRequestRef.current !== requestId || isInvalidatedError(e)) return
      setFollowupHistory(prev => prev.slice(0, -1))
      setFollowupQuery(current => (current.trim() ? current : draft))
      setFollowupError(e?.message || 'Interaction failed')
    } finally {
      if (followupRequestRef.current !== requestId) return
      followupInFlightRef.current = false
      setFollowupLoading(false)
    }
  }

  return (
    <div 
      ref={boxRef}
      dir={textDirectionFor(lang)}
      lang={lang}
      className={['fixed text-sm ai-translate-box', isDragging || isResizing ? 'transition-none' : 'transition-all duration-200'].join(' ')}
      style={{ top: pos.top, left: pos.left, zIndex: 2147483647 }}
    >
      {/* Counting State: Minimal indicator */}
      {status === 'counting' && (
        <div className="ai-translate-compact ai-translate-mini" onPointerDown={startDrag}>
          <div className="ai-translate-spinner" />
          <span className="ai-translate-mini-label">
            {t.floating.translating} <span className="ai-translate-mini-count">{Math.max(0, Math.ceil((100 - progress) * 0.03))}</span>
            {t.floating.seconds}
          </span>
        </div>
      )}

      {/* Loading State */}
      {status === 'loading' && (
        <div className="ai-translate-loading cursor-move select-none" onPointerDown={startDrag}>
          <div className="ai-translate-skeleton">
            <span className="ai-translate-skeleton-line" />
            <span className="ai-translate-skeleton-line" />
          </div>
        </div>
      )}

      {/* Success State */}
      {(status === 'success' || status === 'streaming') && (
        <div
          className="ai-translate-frame"
          data-resizing={resizeDirection ?? undefined}
          style={{ width: size.width, height: size.height }}
        >
          {/* Header */}
          <div 
            className="ai-translate-header cursor-move select-none" 
            onPointerDown={startDrag}
          >
            <div className="ai-translate-header-title">
              <span className="ai-translate-seal"></span>
              <h3 className="ai-translate-eyebrow">
                {currentPage === 0 ? t.floating.titleTrans : t.floating.titleFollowup}
              </h3>
            </div>
            <div className="ai-translate-header-tools" data-no-drag="true">
              <div className="ai-translate-view-tabs" role="tablist">
                <button
                  type="button"
                  role="tab"
                  aria-selected={currentPage === 0}
                  data-active={currentPage === 0}
                  onClick={() => setCurrentPage(0)}
                >
                  {t.floating.viewTranslation}
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={currentPage === 1}
                  data-active={currentPage === 1}
                  disabled={!canFlip}
                  onClick={() => setCurrentPage(1)}
                >
                  {t.floating.viewConversation}
                </button>
              </div>
              <button
                type="button"
                onClick={onClose}
                className="ai-translate-icon"
                aria-label={t.floating.close}
              >
                <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 ai-translate-glyph ai-translate-glyph--close" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
          </div>

          {/* Content Area */}
          <div
            className="group ai-translate-swipe-surface relative flex-1 min-h-0 overflow-hidden bg-transparent"
            onPointerDown={startSwipe}
            onPointerUp={endSwipe}
            onPointerCancel={cancelSwipe}
            data-no-drag="true"
          >
            <div
              className="ai-translate-pages"
              style={{ transform: `translateX(-${currentPage * 100}%)` }}
            >
              {/* Page 1: Translation */}
              <div className="ai-translate-scroll shrink-0">
                <div className="ai-translate-overline">
                  {t.floating.sourceLabel}{sourceLangDisplay}
                </div>
                {status === 'streaming' && (
                  <div className="ai-translate-pill">
                    <span className="ai-translate-pill-dot animate-pulse"></span>
                    {t.floating.streaming}
                  </div>
                )}
                {originalText.trim() && (
                  <div
                    className="ai-translate-original"
                    data-no-drag="true"
                    data-no-swipe="true"
                    onPointerDown={event => event.stopPropagation()}
                  >
                    <button
                      type="button"
                      className="ai-translate-original-toggle"
                      data-open={originalOpen}
                      aria-expanded={originalOpen}
                      onClick={() => setOriginalOpen(open => !open)}
                    >
                      <span>{t.floating.original}</span>
                      <span className="ai-translate-original-caret" aria-hidden="true" />
                    </button>
                    {originalOpen && (
                      <div
                        ref={originalBodyRef}
                        className="ai-translate-original-body"
                        onPointerDown={onTokenPointerDown}
                        onPointerMove={onTokenPointerMove}
                        onPointerUp={onTokenPointerUp}
                        onPointerCancel={onTokenPointerUp}
                      >
                        {tokens.map(token => {
                          const highlighted = token.selectable && selectedTokenSet.has(token.index)
                          return (
                            <span
                              key={token.index}
                              data-token-index={token.index}
                              data-selectable={token.selectable ? 'true' : 'false'}
                              data-selected={highlighted ? 'true' : 'false'}
                              className="ai-translate-token"
                            >
                              {token.text}
                            </span>
                          )
                        })}
                        {showSaveChip && (
                          <div>
                            <button
                              type="button"
                              className="ai-translate-save-chip"
                              disabled={saveFeedback.phase === 'saving' || !onSaveVocab}
                              onClick={() => void commitSave(pickedText, originalText.trim())}
                            >
                              {t.floating.saveChip.replace('{word}', clipLabel(pickedText))}
                            </button>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}
                <div className="ai-translate-markdown prose prose-sm max-w-none">
                  {result ? (
                    <SafeMarkdown content={result} enableMath={enableMathRendering} />
                  ) : (
                    <div className="ai-translate-thinking">
                      <span className="ai-translate-thinking-dot animate-pulse"></span>
                      <span>{t.floating.thinking}</span>
                    </div>
                  )}
                </div>
              </div>

              {/* Page 2: Follow-up */}
              <div 
                ref={followupListRef}
                className="ai-translate-scroll shrink-0"
              >
                <div className="ai-translate-thread">
                  {followupHistory.length === 0 && !followupLoading && (
                    <div className="ai-translate-chat-empty">
                      <span className="ai-translate-chat-empty-icon" aria-hidden="true">
                        <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.7} d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z" />
                        </svg>
                      </span>
                      <strong>{t.floating.conversationEmptyTitle}</strong>
                      <span>{t.floating.conversationEmptyDesc}</span>
                    </div>
                  )}
                  {followupHistory.map((item, index) => (
                    <div key={index} className="ai-translate-thread-item">
                      <div className="ai-translate-message">
                        <div className="ai-translate-avatar ai-translate-avatar--user">
                          <svg xmlns="http://www.w3.org/2000/svg" className="h-3 w-3" viewBox="0 0 20 20" fill="currentColor">
                            <path fillRule="evenodd" d="M10 9a3 3 0 100-6 3 3 0 000 6zm-7 9a7 7 0 1114 0H3z" clipRule="evenodd" />
                          </svg>
                        </div>
                        <div className="ai-translate-bubble ai-translate-bubble--user">{item.query}</div>
                      </div>
                      <div className="ai-translate-message group/item">
                        <div className="ai-translate-avatar ai-translate-avatar--assistant">
                          <svg xmlns="http://www.w3.org/2000/svg" className="h-3 w-3" viewBox="0 0 20 20" fill="currentColor">
                            <path d="M2 10a8 8 0 018-8v8h8a8 8 0 11-16 0z" />
                            <path d="M12 2.252A8.014 8.014 0 0117.748 8H12V2.252z" />
                          </svg>
                        </div>
                        <div className="ai-translate-bubble ai-translate-bubble--assistant">
                          <div className="ai-translate-markdown prose prose-sm max-w-none">
                            {item.answer ? (
                              <SafeMarkdown content={item.answer} enableMath={canUseKatex} />
                            ) : (
                              <div className="ai-translate-thinking">
                                <span className="ai-translate-thinking-dot animate-pulse" />
                                <span>{t.floating.thinking}</span>
                              </div>
                            )}
                          </div>
                        </div>
                        <button
                          onClick={() => copyResult(item.answer)}
                          className="ai-translate-icon ai-translate-copy-answer self-start"
                          title={t.floating.copy}
                        >
                          <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M8 5H6a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2v-1M8 5a2 2 0 002 2h2a2 2 0 002-2M8 5a2 2 0 012-2h2a2 2 0 012 2m0 0h2a2 2 0 012 2v3m2 4H10m0 0l3-3m-3 3l3 3" />
                          </svg>
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {/* Pagination Controls - Hover to show */}
            {canFlip && (
              <>
                <button
                  type="button"
                  onClick={() => setCurrentPage(0)}
                  className={`ai-translate-nav absolute left-2 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 ${currentPage === 0 ? 'invisible' : ''}`}
                  data-no-drag="true"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
                    <path fillRule="evenodd" d="M12.707 5.293a1 1 0 010 1.414L9.414 10l3.293 3.293a1 1 0 01-1.414 1.414l-4-4a1 1 0 010-1.414l4-4a1 1 0 011.414 0z" clipRule="evenodd" />
                  </svg>
                </button>
                <button
                  type="button"
                  onClick={() => setCurrentPage(1)}
                  className={`ai-translate-nav absolute right-2 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 ${currentPage === 1 ? 'invisible' : ''}`}
                  data-no-drag="true"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
                    <path fillRule="evenodd" d="M7.293 14.707a1 1 0 010-1.414L10.586 10 7.293 6.707a1 1 0 011.414-1.414l4 4a1 1 0 010 1.414l-4 4a1 1 0 01-1.414 0z" clipRule="evenodd" />
                  </svg>
                </button>
              </>
            )}
          </div>

          {showReview && (
            <div className={`ai-translate-review${reviewDigest ? ' ai-translate-review--digest' : ''}`} data-no-drag="true">
              {reviewDigest ? (
                <>
                  <div className="ai-translate-review-kicker">{t.floating.summaryReady}</div>
                  <div className="ai-translate-review-summary">{reviewDigest}</div>
                </>
              ) : (
                <>
                  <span>{reviewError || reviewLabel}</span>
                  <span className="ai-translate-review-actions">
                    <button
                      type="button"
                      className="ai-translate-review-button"
                      onClick={() => void runSummary()}
                      disabled={summarizing || !onSummarizeVocab}
                    >
                      {summarizing ? t.floating.summarizing : t.floating.summarize}
                    </button>
                    <button type="button" className="ai-translate-review-button" onClick={() => void runLater()} disabled={summarizing}>
                      {t.floating.later}
                    </button>
                  </span>
                </>
              )}
            </div>
          )}

          {/* Action Bar */}
          <div className="ai-translate-footer" data-no-drag="true">
            {saveFeedback.phase !== 'idle' && (
              <div
                className="ai-translate-memory-status"
                data-status={saveFeedback.phase === 'saving' || saveFeedback.phase === 'pending' ? 'pending' : saveFeedback.phase}
              >
                <span>
                  {saveFeedback.phase === 'saving' && t.floating.saving}
                  {saveFeedback.phase === 'pending' && t.floating.saved}
                  {saveFeedback.phase === 'ready' &&
                    (saveFeedback.detail ? `${t.floating.saved} · ${clipLabel(saveFeedback.detail, 48)}` : t.floating.saved)}
                  {saveFeedback.phase === 'error' && t.floating.enrichError}
                </span>
                {saveFeedback.phase === 'error' && (
                  <button type="button" className="ai-translate-text-button" onClick={retrySave}>
                    {t.floating.retry}
                  </button>
                )}
              </div>
            )}
            {!followupInputOpen ? (
              <div className="ai-translate-footer-row">
                {canFlip && (
                  <div className="ai-translate-dots" aria-hidden="true">
                    <div className="ai-translate-dot" data-active={currentPage === 0} />
                    <div className="ai-translate-dot" data-active={currentPage === 1} />
                  </div>
                )}

                <div className="ai-translate-footer-actions">
                  <button
                    type="button"
                    onClick={openFollowup}
                    disabled={status === 'streaming'}
                    className="ai-translate-action"
                    title={t.floating.askAI}
                    aria-label={t.floating.askAI}
                    data-no-swipe="true"
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 ai-translate-glyph ai-translate-glyph--chat" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z" />
                    </svg>
                  </button>
                  <button
                    type="button"
                    onClick={() => void commitSave(originalText.trim(), originalText.trim())}
                    disabled={!originalText.trim() || saveFeedback.phase === 'saving' || !onSaveVocab}
                    className="ai-translate-action"
                    title={t.floating.saveToBank}
                    aria-label={t.floating.saveToBank}
                    data-no-swipe="true"
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 ai-translate-glyph ai-translate-glyph--save" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z" />
                    </svg>
                  </button>
                  {currentPage === 0 && (
                    <button
                      type="button"
                      onClick={() => copyResult(result)}
                      disabled={status === 'streaming' && !result}
                      className={copied ? 'ai-translate-primary' : 'ai-translate-action'}
                      title={copied ? t.floating.copied : t.floating.copy}
                      aria-label={copied ? t.floating.copied : t.floating.copy}
                      data-no-swipe="true"
                    >
                      {copied ? (
                        <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 ai-translate-glyph ai-translate-glyph--check" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                        </svg>
                      ) : (
                        <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 ai-translate-glyph ai-translate-glyph--copy" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M8 5H6a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2v-1M8 5a2 2 0 002 2h2a2 2 0 002-2M8 5a2 2 0 012-2h2a2 2 0 012 2m0 0h2a2 2 0 012 2v3m2 4H10m0 0l3-3m-3 3l3 3" />
                        </svg>
                      )}
                    </button>
                  )}
                </div>
              </div>
            ) : (
              <div className="ai-translate-composer-card animate-in fade-in slide-in-from-bottom-2 duration-200">
                <div className="ai-translate-composer">
                  <textarea
                    className="ai-translate-input"
                    rows={2}
                    placeholder={t.floating.followupPlaceholder}
                    value={followupQuery}
                    onChange={e => setFollowupQuery(e.target.value)}
                    onCompositionStart={() => {
                      composingRef.current = true
                    }}
                    onCompositionEnd={() => {
                      composingRef.current = false
                    }}
                    onKeyDown={e => {
                      const native = e.nativeEvent as KeyboardEvent
                      const isComposing = composingRef.current || native.isComposing || native.keyCode === 229
                      if (e.key === 'Enter' && !e.shiftKey) {
                        if (isComposing) return
                        e.preventDefault()
                        submitFollowup()
                      }
                      if (e.key === 'Escape' && !isComposing) setFollowupInputOpen(false)
                    }}
                    autoFocus
                    data-no-swipe="true"
                  />
                  <button 
                    onClick={() => setFollowupInputOpen(false)}
                    className="ai-translate-icon ai-translate-composer-close"
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" className="h-3 w-3" viewBox="0 0 20 20" fill="currentColor">
                      <path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd" />
                    </svg>
                  </button>
                </div>
                
                <div className="mt-3 flex items-center justify-between gap-3">
                  <span className={`ai-translate-meta ${followupError ? 'ai-translate-meta--error' : ''}`}>
                    {followupLoading ? (
                      <span className="inline-flex items-center gap-1.5 text-[inherit]">
                        <span className="ai-translate-thinking-dot animate-pulse"></span>
                        {t.floating.thinking}
                      </span>
                    ) : followupError ? (
                      <span>{followupError}</span>
                    ) : (
                      t.floating.pressEnter
                    )}
                  </span>
                  <button
                    type="button"
                    onClick={submitFollowup}
                    disabled={followupLoading || !followupQuery.trim()}
                    className="ai-translate-primary"
                  >
                    {t.floating.send}
                  </button>
                </div>
              </div>
            )}
          </div>
          <div className="ai-translate-resize-handles" aria-hidden="true">
            {RESIZE_DIRECTIONS.map(direction => (
              <span
                key={direction}
                className="ai-translate-resize-handle"
                data-resize-direction={direction}
                onPointerDown={event => startResize(event, direction)}
              />
            ))}
          </div>
        </div>
      )}

      {/* Error State */}
      {status === 'error' && (
        <div className="ai-translate-error" onPointerDown={startDrag}>
          <MarkdownFallback content={String(result ?? '').trim() || t.floating.error} />
        </div>
      )}
    </div>
  )
}

export default FloatingBox
