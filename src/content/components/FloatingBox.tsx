import React, { useEffect, useMemo, useRef, useState } from 'react'
import { getTranslation, type LanguageCode } from '../../lib/i18n'
import { getConfig } from '../../lib/config'

interface FloatingBoxProps {
  position: { top: number; left: number }
  selectionKey?: string
  status: 'idle' | 'counting' | 'loading' | 'success' | 'error'
  sourceText?: string
  result?: string
  progress?: number // 0-100 for countdown
  onFollowup?: (query: string, sourceText: string, translatedText: string) => Promise<string>
  onClose?: () => void
}

const FloatingBox: React.FC<FloatingBoxProps> = ({ position, selectionKey, status, sourceText, result, progress = 0, onFollowup, onClose }) => {
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
  const [lang, setLang] = useState<LanguageCode>('en')
  const followupListRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    getConfig().then(config => setLang(config.interfaceLanguage || 'en'))
  }, [])

  const t = getTranslation(lang)

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

  const startSwipe = (e: React.PointerEvent) => {
    if (!canFlip) return
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
      className={[
        'fixed bg-white shadow-lg rounded-lg border border-gray-200 text-sm text-gray-800 ai-translate-box',
        isDragging ? 'transition-none' : 'transition-all duration-200',
      ].join(' ')}
      style={{ top: pos.top, left: pos.left, zIndex: 2147483647 }}
    >
      {/* Counting State: Minimal indicator */}
      {status === 'counting' && (
        <div className="p-2 flex items-center gap-2 cursor-move select-none" onPointerDown={startDrag}>
           <div className="w-4 h-4 rounded-full border-2 border-blue-500 border-t-transparent animate-spin" />
           <span className="text-xs text-gray-500">{t.floating.translating} {Math.max(0, Math.ceil((100 - progress) * 0.03))}{t.floating.seconds}</span>
        </div>
      )}

      {/* Loading State */}
      {status === 'loading' && (
        <div className="p-3 w-64 cursor-move select-none" onPointerDown={startDrag}>
          <div className="animate-pulse flex space-x-4">
            <div className="flex-1 space-y-2 py-1">
              <div className="h-4 bg-gray-200 rounded w-3/4"></div>
              <div className="h-4 bg-gray-200 rounded"></div>
            </div>
          </div>
        </div>
      )}

      {/* Success State */}
      {status === 'success' && (
        <div className="relative w-96 flex flex-col font-sans">
          {/* Header */}
          <div 
            className="flex justify-between items-center px-4 py-3 border-b border-slate-100 cursor-move select-none bg-white rounded-t-xl" 
            onPointerDown={startDrag}
          >
            <div className="flex items-center gap-2">
              <span className="w-1.5 h-1.5 rounded-full bg-blue-500"></span>
              <h3 className="font-bold text-slate-800 text-xs tracking-wide">
                {currentPage === 0 ? t.floating.titleTrans : t.floating.titleFollowup}
              </h3>
            </div>
            <button 
              onClick={onClose} 
              className="text-slate-400 hover:text-slate-600 p-1 rounded-full hover:bg-slate-100 transition-colors" 
              data-no-drag="true"
            >
              <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          {/* Content Area */}
          <div
            className="relative overflow-hidden bg-white group"
            onPointerDown={startSwipe}
            onPointerUp={endSwipe}
            data-no-drag="true"
          >
            <div
              className="flex transition-transform duration-300 ease-out"
              style={{ transform: `translateX(-${currentPage * 100}%)` }}
            >
              {/* Page 1: Translation */}
              <div className="w-full shrink-0 max-h-64 overflow-y-auto px-5 py-4 scrollbar-thin scrollbar-thumb-slate-200 scrollbar-track-transparent">
                <div className="prose prose-sm prose-slate text-slate-700 leading-relaxed text-[13px]">
                  {result}
                </div>
              </div>

              {/* Page 2: Follow-up */}
              <div 
                ref={followupListRef}
                className="w-full shrink-0 max-h-64 overflow-y-auto px-5 py-4 scrollbar-thin scrollbar-thumb-slate-200 scrollbar-track-transparent"
              >
                {followupHistory.map((item, index) => (
                  <div key={index} className="mb-6 last:mb-0">
                    <div className="flex items-start gap-2 mb-2">
                      <div className="w-5 h-5 rounded-full bg-slate-100 flex items-center justify-center shrink-0 mt-0.5">
                        <svg xmlns="http://www.w3.org/2000/svg" className="h-3 w-3 text-slate-500" viewBox="0 0 20 20" fill="currentColor">
                          <path fillRule="evenodd" d="M10 9a3 3 0 100-6 3 3 0 000 6zm-7 9a7 7 0 1114 0H3z" clipRule="evenodd" />
                        </svg>
                      </div>
                      <div className="text-xs font-medium text-slate-700 bg-slate-50 px-3 py-2 rounded-lg rounded-tl-none">
                        {item.query}
                      </div>
                    </div>
                    <div className="flex items-start gap-2 group/item">
                      <div className="w-5 h-5 rounded-full bg-blue-100 flex items-center justify-center shrink-0 mt-0.5">
                        <svg xmlns="http://www.w3.org/2000/svg" className="h-3 w-3 text-blue-600" viewBox="0 0 20 20" fill="currentColor">
                          <path d="M2 10a8 8 0 018-8v8h8a8 8 0 11-16 0z" />
                          <path d="M12 2.252A8.014 8.014 0 0117.748 8H12V2.252z" />
                        </svg>
                      </div>
                      <div className="prose prose-sm prose-slate text-slate-700 leading-relaxed text-[13px] flex-1">
                        {item.answer}
                      </div>
                      <button
                        onClick={() => copyResult(item.answer)}
                        className="p-1 rounded text-slate-300 hover:text-blue-500 hover:bg-slate-100 opacity-0 group-hover/item:opacity-100 transition-all shrink-0 self-start"
                        title={t.floating.copy}
                      >
                        <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M8 5H6a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2v-1M8 5a2 2 0 002 2h2a2 2 0 002-2M8 5a2 2 0 012-2h2a2 2 0 012 2m0 0h2a2 2 0 012 2v3m2 4H10m0 0l3-3m-3 3l3 3" />
                        </svg>
                      </button>
                    </div>
                  </div>
                ))}
                {followupLoading && (
                  <div className="flex items-center gap-2 mt-4 ml-7">
                    <span className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-bounce" style={{ animationDelay: '0ms' }}></span>
                    <span className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-bounce" style={{ animationDelay: '150ms' }}></span>
                    <span className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-bounce" style={{ animationDelay: '300ms' }}></span>
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
                  className={`absolute left-2 top-1/2 -translate-y-1/2 p-1.5 rounded-full bg-white/80 backdrop-blur-sm border border-slate-200 shadow-sm text-slate-400 hover:text-blue-600 hover:border-blue-200 transition-all opacity-0 group-hover:opacity-100 ${currentPage === 0 ? 'invisible' : ''}`}
                  data-no-drag="true"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
                    <path fillRule="evenodd" d="M12.707 5.293a1 1 0 010 1.414L9.414 10l3.293 3.293a1 1 0 01-1.414 1.414l-4-4a1 1 0 010-1.414l4-4a1 1 0 011.414 0z" clipRule="evenodd" />
                  </svg>
                </button>
                <button
                  type="button"
                  onClick={() => setCurrentPage(1)}
                  className={`absolute right-2 top-1/2 -translate-y-1/2 p-1.5 rounded-full bg-white/80 backdrop-blur-sm border border-slate-200 shadow-sm text-slate-400 hover:text-blue-600 hover:border-blue-200 transition-all opacity-0 group-hover:opacity-100 ${currentPage === 1 ? 'invisible' : ''}`}
                  data-no-drag="true"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
                    <path fillRule="evenodd" d="M7.293 14.707a1 1 0 010-1.414L10.586 10 7.293 6.707a1 1 0 011.414-1.414l4 4a1 1 0 010 1.414l-4 4a1 1 0 01-1.414 0z" clipRule="evenodd" />
                  </svg>
                </button>
              </>
            )}
          </div>

          {/* Action Bar */}
          <div className="px-4 py-3 bg-slate-50 border-t border-slate-100 rounded-b-xl flex flex-col gap-3" data-no-drag="true">
            {!followupInputOpen ? (
              <div className="flex items-center justify-between">
                {/* Pagination Dots */}
                <div className="flex items-center gap-1.5">
                  {canFlip && (
                    <>
                      <div className={`h-1.5 rounded-full transition-all duration-300 ${currentPage === 0 ? 'w-4 bg-blue-500' : 'w-1.5 bg-slate-300'}`} />
                      <div className={`h-1.5 rounded-full transition-all duration-300 ${currentPage === 1 ? 'w-4 bg-blue-500' : 'w-1.5 bg-slate-300'}`} />
                    </>
                  )}
                </div>

                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setFollowupInputOpen(true)}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium text-slate-600 hover:text-blue-600 hover:bg-white hover:shadow-sm border border-transparent hover:border-slate-200 transition-all"
                    title={t.floating.askTooltip}
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z" />
                    </svg>
                    <span>{t.floating.askAI}</span>
                  </button>
                  
                  <div className="w-px h-4 bg-slate-200 mx-1"></div>

                  <button
                    type="button"
                    onClick={() => copyResult(result)}
                    className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-all border ${
                      copied
                        ? 'text-emerald-600 bg-emerald-50 border-emerald-200'
                        : 'text-slate-600 hover:text-blue-600 hover:bg-white hover:shadow-sm border-transparent hover:border-slate-200'
                    }`}
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
                    className="w-full text-[13px] leading-relaxed border border-slate-200 rounded-lg p-3 bg-white outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 resize-none shadow-sm placeholder:text-slate-400"
                    rows={2}
                    placeholder={t.floating.followupPlaceholder}
                    value={followupQuery}
                    onChange={e => setFollowupQuery(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault()
                        submitFollowup()
                      }
                      if (e.key === 'Escape') setFollowupInputOpen(false)
                    }}
                    autoFocus
                  />
                  <button 
                    onClick={() => setFollowupInputOpen(false)}
                    className="absolute right-2 top-2 p-1 text-slate-300 hover:text-slate-500 rounded-full hover:bg-slate-100 transition-colors"
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" className="h-3 w-3" viewBox="0 0 20 20" fill="currentColor">
                      <path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd" />
                    </svg>
                  </button>
                </div>
                
                <div className="mt-2 flex items-center justify-between">
                  <span className="text-[10px] font-medium text-slate-400">
                    {followupLoading ? (
                      <span className="flex items-center gap-1.5 text-blue-600">
                        <span className="w-1.5 h-1.5 rounded-full bg-blue-600 animate-pulse"></span>
                        {t.floating.thinking}
                      </span>
                    ) : followupError ? (
                      <span className="text-red-500">{followupError}</span>
                    ) : (
                      t.floating.pressEnter
                    )}
                  </span>
                  <button
                    type="button"
                    onClick={submitFollowup}
                    disabled={followupLoading || !followupQuery.trim()}
                    className="px-3 py-1.5 text-xs font-semibold rounded-md bg-blue-600 text-white hover:bg-blue-700 disabled:bg-slate-200 disabled:text-slate-400 disabled:cursor-not-allowed transition-colors shadow-sm"
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
        <div className="p-3 w-64 bg-red-50 border-red-100 rounded-lg cursor-move select-none" onPointerDown={startDrag}>
          <p className="text-red-600">{t.floating.error}</p>
        </div>
      )}
    </div>
  )
}

export default FloatingBox
