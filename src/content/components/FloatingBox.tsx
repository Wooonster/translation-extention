import React, { useEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { getTranslation, getLanguageName, type LanguageCode } from '../../lib/i18n'
import { getConfig } from '../../lib/config'
import type { VocabEntry, VocabSummary } from '../../lib/memory'

interface FloatingBoxProps {
  position: { top: number; left: number }
  selectionKey?: string
  status: 'idle' | 'counting' | 'loading' | 'streaming' | 'success' | 'error'
  sourceText?: string
  sourceLang?: string
  result?: string
  progress?: number // 0-100 for countdown
  onFollowup?: (query: string, sourceText: string, translatedText: string) => Promise<string>
  onClose?: () => void
  onSaveVocab?: (input: { word: string; sourceSentence: string }) => Promise<VocabEntry>
  onEnrichVocab?: (id: string, interfaceLanguage: LanguageCode) => Promise<VocabEntry>
  onSummarizeVocab?: (interfaceLanguage: LanguageCode) => Promise<VocabSummary>
  onSnoozeReview?: () => Promise<void> | void
  reviewNotice?: { count: number } | null
}

interface OriginalToken {
  text: string
  selectable: boolean
  index: number
}

interface TokenRange {
  start: number
  end: number
}

interface SaveFeedback {
  phase: 'idle' | 'saving' | 'pending' | 'ready' | 'error'
  entryId?: string
  word?: string
  sourceSentence?: string
  detail?: string
}

const idleSaveFeedback: SaveFeedback = { phase: 'idle' }

function tokenizeOriginal(text: string): OriginalToken[] {
  if (typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function') {
    try {
      const segmenter = new Intl.Segmenter(segmenterLocale(text), { granularity: 'word' })
      return Array.from(segmenter.segment(text), (segment, index) => ({
        text: segment.segment,
        selectable: Boolean(segment.isWordLike),
        index,
      }))
    } catch {
      // Segmenter can reject an unsupported locale. Whitespace splitting still selects words.
    }
  }

  return text
    .split(/(\s+)/)
    .filter(part => part.length > 0)
    .map((part, index) => ({
      text: part,
      selectable: /\S/.test(part) && /[\p{L}\p{N}]/u.test(part),
      index,
    }))
}

function segmenterLocale(text: string): string | undefined {
  if (/[\u3040-\u30ff]/.test(text)) return 'ja'
  if (/[\uac00-\ud7af]/.test(text)) return 'ko'
  if (/[\u4e00-\u9fff]/.test(text)) return 'zh'
  return undefined
}

function clipLabel(text: string, max = 36): string {
  const trimmed = text.trim()
  if (trimmed.length <= max) return trimmed
  return `${trimmed.slice(0, Math.max(1, max - 1))}…`
}

const FloatingBox: React.FC<FloatingBoxProps> = ({
  position,
  selectionKey,
  status,
  sourceText,
  sourceLang,
  result,
  progress = 0,
  onFollowup,
  onClose,
  onSaveVocab,
  onEnrichVocab,
  onSummarizeVocab,
  onSnoozeReview,
  reviewNotice,
}) => {
  if (status === 'idle') return null

  const basePosition = useMemo(() => ({ top: position.top + 10, left: position.left }), [position.left, position.top])
  const boxRef = useRef<HTMLDivElement | null>(null)
  const dragRef = useRef<{ startX: number; startY: number; startTop: number; startLeft: number } | null>(null)
  const [pos, setPos] = useState(basePosition)
  const [isDragging, setIsDragging] = useState(false)
  const [isPinned, setIsPinned] = useState(false)
  const [copied, setCopied] = useState(false)
  const [followupInputOpen, setFollowupInputOpen] = useState(false)
  const [followupQuery, setFollowupQuery] = useState('')
  const [followupLoading, setFollowupLoading] = useState(false)
  const [followupHistory, setFollowupHistory] = useState<Array<{ query: string; answer: string }>>([])
  const [followupError, setFollowupError] = useState('')
  const [currentPage, setCurrentPage] = useState(0)
  const swipeStartXRef = useRef<number | null>(null)
  const composingRef = useRef(false)
  const [lang, setLang] = useState<LanguageCode>('en')
  const [originalOpen, setOriginalOpen] = useState(false)
  const [tokenRange, setTokenRange] = useState<TokenRange | null>(null)
  const [saveFeedback, setSaveFeedback] = useState<SaveFeedback>(idleSaveFeedback)
  const [reviewDigest, setReviewDigest] = useState('')
  const [reviewError, setReviewError] = useState('')
  const [summarizing, setSummarizing] = useState(false)
  const [noticeDismissed, setNoticeDismissed] = useState(false)
  const followupListRef = useRef<HTMLDivElement | null>(null)
  const originalBodyRef = useRef<HTMLDivElement | null>(null)
  const tokenDragRef = useRef<{ anchor: number } | null>(null)
  const saveRequestRef = useRef(0)

  useEffect(() => {
    getConfig().then(config => setLang(config.interfaceLanguage || 'en'))
  }, [])

  const t = getTranslation(lang)
  const normalizedSourceLang = String(sourceLang ?? '').trim()
  const sourceLangDisplay = normalizedSourceLang
    ? getLanguageName(normalizedSourceLang, lang)
    : lang === 'zh'
      ? '自动检测'
      : 'Auto detected'

  useEffect(() => {
    setPos(basePosition)
    setIsPinned(false)
    setIsDragging(false)
    dragRef.current = null
    setCopied(false)
    setFollowupInputOpen(false)
    setFollowupQuery('')
    setFollowupLoading(false)
    setFollowupHistory([])
    setFollowupError('')
    setCurrentPage(0)
    setOriginalOpen(false)
    setTokenRange(null)
    setSaveFeedback(idleSaveFeedback)
    setReviewDigest('')
    setReviewError('')
    setSummarizing(false)
    setNoticeDismissed(false)
    tokenDragRef.current = null
    saveRequestRef.current += 1
  }, [selectionKey])

  useEffect(() => {
    if (currentPage === 1 && followupListRef.current) {
      followupListRef.current.scrollTop = followupListRef.current.scrollHeight
    }
  }, [followupHistory, currentPage])

  useEffect(() => {
    if (isPinned || isDragging) return
    setPos(basePosition)
  }, [basePosition, isDragging, isPinned])

  useEffect(() => {
    if (!copied) return
    const t = window.setTimeout(() => setCopied(false), 1500)
    return () => window.clearTimeout(t)
  }, [copied])

  useEffect(() => {
    if (!isDragging) return

    const onMove = (e: PointerEvent) => {
      const start = dragRef.current
      if (!start) return

      const dx = e.clientX - start.startX
      const dy = e.clientY - start.startY

      const rect = boxRef.current?.getBoundingClientRect()
      const width = rect?.width ?? 0
      const height = rect?.height ?? 0

      const margin = 8
      const maxLeft = Math.max(margin, window.innerWidth - width - margin)
      const maxTop = Math.max(margin, window.innerHeight - height - margin)

      const nextLeft = Math.min(maxLeft, Math.max(margin, start.startLeft + dx))
      const nextTop = Math.min(maxTop, Math.max(margin, start.startTop + dy))

      setPos({ top: nextTop, left: nextLeft })
    }

    const onUp = () => {
      setIsDragging(false)
      dragRef.current = null
    }

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp, { once: true })

    return () => {
      window.removeEventListener('pointermove', onMove)
    }
  }, [isDragging])

  const startDrag = (e: React.PointerEvent) => {
    const target = e.target as HTMLElement | null
    if (target?.closest?.('[data-no-drag="true"]')) return
    if (e.button !== 0) return
    e.preventDefault()
    setIsPinned(true)
    setIsDragging(true)
    dragRef.current = { startX: e.clientX, startY: e.clientY, startTop: pos.top, startLeft: pos.left }
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

  const pageCount = followupHistory.length > 0 ? 2 : 1
  const canFlip = pageCount > 1

  useEffect(() => {
    if (currentPage > pageCount - 1) setCurrentPage(pageCount - 1)
  }, [currentPage, pageCount])

  useEffect(() => {
    setNoticeDismissed(false)
  }, [reviewNotice?.count])

  const originalText = String(sourceText ?? '')
  const tokens = useMemo(() => tokenizeOriginal(originalText), [originalText])
  const pickedText = useMemo(() => {
    if (!tokenRange) return ''
    if (tokenRange.start < 0 || tokenRange.end >= tokens.length) return ''
    return tokens
      .slice(tokenRange.start, tokenRange.end + 1)
      .map(token => token.text)
      .join('')
      .replace(/\s+/g, ' ')
      .trim()
  }, [tokenRange, tokens])
  const showSaveChip = Boolean(pickedText) && /[\p{L}\p{N}]/u.test(pickedText)
  const showReview = Boolean(reviewDigest) || (Boolean(reviewNotice) && !noticeDismissed)
  const reviewLabel = !reviewNotice
    ? ''
    : lang === 'en' && reviewNotice.count === 1
      ? t.floating.reviewReadyOne
      : t.floating.reviewReady.replace('{count}', String(reviewNotice.count))

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
    tokenDragRef.current = { anchor: index }
    setTokenRange({ start: index, end: index })
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  const onTokenPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const anchor = tokenDragRef.current?.anchor
    if (anchor == null) return
    const index = resolveTokenIndex(event.clientX, event.clientY)
    if (index == null) return
    setTokenRange({ start: Math.min(anchor, index), end: Math.max(anchor, index) })
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
    setTokenRange(null)

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
        const enriched = await onEnrichVocab(entry.id, lang)
        if (saveRequestRef.current !== requestId) return
        setSaveFeedback({
          phase: enriched.status === 'ready' ? 'ready' : 'error',
          entryId: enriched.id,
          word: enriched.word,
          sourceSentence: trimmedSentence,
          detail: enriched.translation,
        })
      } catch {
        if (saveRequestRef.current !== requestId) return
        setSaveFeedback({
          phase: 'error',
          entryId: entry.id,
          word: entry.word,
          sourceSentence: trimmedSentence,
        })
      }
    } catch {
      if (saveRequestRef.current !== requestId) return
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
      onEnrichVocab(entryId, lang)
        .then(enriched => {
          if (saveRequestRef.current !== requestId) return
          setSaveFeedback(prev => ({
            ...prev,
            phase: enriched.status === 'ready' ? 'ready' : 'error',
            entryId: enriched.id,
            word: enriched.word,
            detail: enriched.translation,
          }))
        })
        .catch(() => {
          if (saveRequestRef.current !== requestId) return
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
      const summary = await onSummarizeVocab(lang)
      setReviewDigest(summary.text)
    } catch {
      setReviewError(t.floating.summaryFailed)
    } finally {
      setSummarizing(false)
    }
  }

  const runLater = async () => {
    setNoticeDismissed(true)
    try {
      await onSnoozeReview?.()
    } catch {
      setNoticeDismissed(false)
    }
  }

  const startSwipe = (e: React.PointerEvent) => {
    if (!canFlip) return
    if ((e.target as HTMLElement | null)?.closest?.('[data-no-swipe="true"]')) return
    swipeStartXRef.current = e.clientX
  }

  const endSwipe = (e: React.PointerEvent) => {
    if (!canFlip || swipeStartXRef.current == null) return
    const delta = e.clientX - swipeStartXRef.current
    if (delta > 45) setCurrentPage(0)
    if (delta < -45) setCurrentPage(1)
    swipeStartXRef.current = null
  }

  const submitFollowup = async () => {
    const query = followupQuery.trim()
    const currentSource = String(sourceText ?? '').trim()
    const currentTranslated = String(result ?? '').trim()
    if (!query || !currentSource || !currentTranslated || !onFollowup) return

    // Add user query immediately for optimistic UI (optional, but good for UX)
    // For now, we'll wait for loading state
    setFollowupLoading(true)
    setFollowupError('')
    try {
      // Construct context from previous history
      // Note: We might want to pass full history to backend in the future for better context handling
      // For now, we are appending to local history
      
      const answer = await onFollowup(query, currentSource, currentTranslated)
      
      setFollowupHistory(prev => [...prev, { query, answer }])
      setFollowupQuery('')
      setCurrentPage(1)
    } catch (e: any) {
      setFollowupError(e?.message || 'Interaction failed')
    } finally {
      setFollowupLoading(false)
    }
  }

  return (
    <div 
      ref={boxRef}
      className={['fixed text-sm ai-translate-box', isDragging ? 'transition-none' : 'transition-all duration-200'].join(' ')}
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
        <div className="ai-translate-frame flex flex-col">
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
            <button 
              onClick={onClose} 
              className="ai-translate-icon" 
              data-no-drag="true"
            >
              <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          {/* Content Area */}
          <div
            className="group relative overflow-hidden bg-transparent"
            onPointerDown={startSwipe}
            onPointerUp={endSwipe}
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
                          const highlighted = Boolean(
                            tokenRange &&
                              token.index >= tokenRange.start &&
                              token.index <= tokenRange.end &&
                              !/^\s+$/.test(token.text)
                          )
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
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>
                      {result}
                    </ReactMarkdown>
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
                            <ReactMarkdown remarkPlugins={[remarkGfm]}>
                              {item.answer || ''}
                            </ReactMarkdown>
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
                {followupLoading && (
                  <div className="ai-translate-thinking mt-4 ml-9">
                    <span className="ai-translate-thinking-dot animate-bounce" style={{ animationDelay: '0ms' }}></span>
                    <span className="ai-translate-thinking-dot animate-bounce" style={{ animationDelay: '150ms' }}></span>
                    <span className="ai-translate-thinking-dot animate-bounce" style={{ animationDelay: '300ms' }}></span>
                  </div>
                )}
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
                {/* Pagination Dots */}
                <div className="ai-translate-dots">
                  {canFlip && (
                    <>
                      <div className="ai-translate-dot" data-active={currentPage === 0} />
                      <div className="ai-translate-dot" data-active={currentPage === 1} />
                    </>
                  )}
                </div>

                <div className="ai-translate-footer-actions">
                  <button
                    type="button"
                    onClick={() => setFollowupInputOpen(true)}
                    disabled={status === 'streaming'}
                    className="ai-translate-action"
                    title={t.floating.askTooltip}
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z" />
                    </svg>
                    <span>{t.floating.askAI}</span>
                  </button>

                  <div className="ai-translate-divider"></div>

                  <button
                    type="button"
                    onClick={() => void commitSave(originalText.trim(), originalText.trim())}
                    disabled={!originalText.trim() || saveFeedback.phase === 'saving' || !onSaveVocab}
                    className="ai-translate-action"
                    title={t.floating.saveToBank}
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z" />
                    </svg>
                    <span>{t.floating.saveToBank}</span>
                  </button>

                  <div className="ai-translate-divider"></div>

                  <button
                    type="button"
                    onClick={() => copyResult(result)}
                    disabled={status === 'streaming' && !result}
                    className={copied ? 'ai-translate-primary' : 'ai-translate-action'}
                  >
                    {copied ? (
                      <>
                        <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                        </svg>
                        <span>{t.floating.copied}</span>
                      </>
                    ) : (
                      <>
                        <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M8 5H6a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2v-1M8 5a2 2 0 002 2h2a2 2 0 002-2M8 5a2 2 0 012-2h2a2 2 0 012 2m0 0h2a2 2 0 012 2v3m2 4H10m0 0l3-3m-3 3l3 3" />
                        </svg>
                        <span>{t.floating.copy}</span>
                      </>
                    )}
                      </button>
                </div>
              </div>
            ) : (
              <div className="animate-in fade-in slide-in-from-bottom-2 duration-200">
                <div className="relative">
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
                  />
                  <button 
                    onClick={() => setFollowupInputOpen(false)}
                    className="ai-translate-icon absolute right-2 top-2"
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
        </div>
      )}

      {/* Error State */}
      {status === 'error' && (
        <div className="ai-translate-error" onPointerDown={startDrag}>
          <p>{result || t.floating.error}</p>
        </div>
      )}
    </div>
  )
}

export default FloatingBox
