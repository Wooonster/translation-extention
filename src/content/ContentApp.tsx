import { useEffect, useRef, useState } from 'react'
import { useSelectionHover, type SelectionInfo } from './hooks/useSelectionHover'
import FloatingBox from './components/FloatingBox'
import { dlog, derr, initDebug } from '../lib/debug'
import {
  connectExtensionPort,
  ExtensionContextLost,
  extensionContextAlive,
  isInvalidatedError,
  markExtensionContextLost,
  onExtensionContextLost,
  sendExtensionMessage,
  watchExtensionStorage,
} from './extensionContext'
import {
  HOVER_DURATION_DEFAULT_MS,
  HOVER_DURATION_MAX_MS,
  HOVER_DURATION_MIN_MS,
  getConfig,
  resolveInterfaceSide,
  resolveUserLanguage,
  type InterfaceSide,
  type UserLanguage,
} from '../lib/config'
import {
  MEMORY_STORAGE_KEY,
  emptyMemory,
  loadMemory,
  sanitizeMemory,
  shouldShowReviewNotice,
  type FloatorMemory,
  type VocabEntry,
  type VocabSummary,
} from '../lib/memory'
import { shouldSkipFloatingTranslation } from '../lib/language'

export interface FollowupStreamCallbacks {
  onStart?: () => void
  onDelta?: (delta: string) => void
  onComplete?: (answer: string) => void
}

initDebug()

const ContentApp = () => {
  const [hoverDurationMs, setHoverDurationMs] = useState(HOVER_DURATION_DEFAULT_MS)
  const [floatingEnabled, setFloatingEnabled] = useState(false)
  const [floatingStreamEnabled, setFloatingStreamEnabled] = useState(false)
  const [configLoaded, setConfigLoaded] = useState(false)
  const [userLanguage, setUserLanguage] = useState<UserLanguage>('zh')
  const [interfaceSide, setInterfaceSide] = useState<InterfaceSide>('user')
  const streamPortRef = useRef<chrome.runtime.Port | null>(null)
  const clearSelectionRef = useRef<() => void>(() => {})
  const dismissRef = useRef<() => void>(() => {})

  const notePortClosed = () => {
    try {
      const reason = chrome.runtime.lastError
      if (reason && isInvalidatedError(reason)) markExtensionContextLost()
    } catch (error) {
      if (isInvalidatedError(error)) markExtensionContextLost()
    }
  }

  const cancelActiveStream = () => {
    const port = streamPortRef.current
    streamPortRef.current = null
    if (!port) return
    try {
      port.disconnect()
    } catch (error) {
      if (isInvalidatedError(error)) markExtensionContextLost()
    }
  }

  const dismissFloating = () => {
    cancelActiveStream()
    setFloatingEnabled(false)
    setStatus('idle')
    setResult('')
    setSourceLang('')
    setActiveSelection(null)
    clearSelectionRef.current()
  }
  dismissRef.current = dismissFloating

  const normalizeHoverDuration = (value: unknown): number => {
    const ms = Number(value)
    if (!Number.isFinite(ms)) return HOVER_DURATION_DEFAULT_MS
    return Math.min(HOVER_DURATION_MAX_MS, Math.max(HOVER_DURATION_MIN_MS, Math.round(ms)))
  }

  const parseTranslationContent = (rawContent: string): { sourceLang: string; text: string } => {
    const content = String(rawContent ?? '')
    const sourceMatch = content.match(/^\[Source:\s*([^\]]+)\]\s*([\s\S]*)$/i)
    if (sourceMatch) {
      return {
        sourceLang: sourceMatch[1].trim(),
        text: sourceMatch[2].replace(/^(?:\r?\n)+/, ''),
      }
    }

    const trimmedStart = content.trimStart()
    if (/^\[Source:/i.test(trimmedStart) && !trimmedStart.includes(']')) {
      return { sourceLang: '', text: '' }
    }

    return { sourceLang: '', text: content.replace(/^(?:\r?\n)+/, '') }
  }

  useEffect(() => {
    return onExtensionContextLost(() => dismissRef.current())
  }, [])

  useEffect(() => {
    getConfig()
      .then(cfg => {
        setHoverDurationMs(normalizeHoverDuration(cfg.hoverDurationMs))
        setFloatingEnabled(cfg.floatingEnabled !== false)
        setFloatingStreamEnabled(cfg.floatingStreamEnabled === true)
        setUserLanguage(cfg.userLanguage)
        setInterfaceSide(cfg.interfaceSide)
        setConfigLoaded(true)
      })
      .catch((error: unknown) => {
        if (isInvalidatedError(error)) {
          markExtensionContextLost()
          return
        }
        setHoverDurationMs(HOVER_DURATION_DEFAULT_MS)
        setFloatingEnabled(false)
        setFloatingStreamEnabled(false)
        setConfigLoaded(true)
      })

    const onChanged = (changes: { [key: string]: chrome.storage.StorageChange }, areaName: string) => {
      if (areaName !== 'sync') return
      const next = changes.config?.newValue as any
      if (!next) return
      setHoverDurationMs(normalizeHoverDuration(next.hoverDurationMs))
      if (typeof next.floatingEnabled === 'boolean') setFloatingEnabled(next.floatingEnabled)
      if (typeof next.floatingStreamEnabled === 'boolean') setFloatingStreamEnabled(next.floatingStreamEnabled)
      const nextUserLanguage = resolveUserLanguage(next)
      setUserLanguage(nextUserLanguage)
      setInterfaceSide(resolveInterfaceSide(next, nextUserLanguage))
      setConfigLoaded(true)
    }

    const stopWatchingConfig = watchExtensionStorage(onChanged)
    return () => {
      stopWatchingConfig()
      cancelActiveStream()
    }
  }, [])

  const { selection, hoverProgress, clearSelection } = useSelectionHover(
    // onTrigger callback
    (text, triggerSelection) => {
      dlog('[AI Translate] onTrigger fired via callback!', { length: text.length })
      if (!configLoaded || !floatingEnabled || shouldSkipFloatingTranslation(text, userLanguage)) {
        clearSelection()
        return
      }
      setActiveSelection(triggerSelection)
      void handleTranslate(text, triggerSelection).catch((error: unknown) => {
        if (isInvalidatedError(error) || !extensionContextAlive()) {
          markExtensionContextLost()
          return
        }
        derr('[AI Translate] Translation error:', error)
      })
    },
    hoverDurationMs,
    configLoaded && floatingEnabled,
    userLanguage,
  )
  clearSelectionRef.current = clearSelection
  const [status, setStatus] = useState<'idle' | 'counting' | 'loading' | 'streaming' | 'success' | 'error'>('idle')
  const [result, setResult] = useState<string>('')
  const [sourceLang, setSourceLang] = useState<string>('')
  const [activeSelection, setActiveSelection] = useState<typeof selection>(null)
  const [memory, setMemory] = useState<FloatorMemory>(emptyMemory)

  useEffect(() => {
    loadMemory()
      .then(next => {
        if (!extensionContextAlive()) return
        setMemory(next)
      })
      .catch((error: unknown) => {
        if (isInvalidatedError(error)) {
          markExtensionContextLost()
          return
        }
        setMemory(emptyMemory())
      })

    const onMemoryChanged = (changes: { [key: string]: chrome.storage.StorageChange }, areaName: string) => {
      if (areaName !== 'local' || !Object.prototype.hasOwnProperty.call(changes, MEMORY_STORAGE_KEY)) return
      setMemory(sanitizeMemory(changes[MEMORY_STORAGE_KEY]?.newValue))
    }

    return watchExtensionStorage(onMemoryChanged)
  }, [])

  // State machine logic
  useEffect(() => {
    if (!floatingEnabled) {
      cancelActiveStream()
      setStatus('idle')
      setResult('')
      setSourceLang('')
      setActiveSelection(null)
      clearSelection()
      return
    }

    if (!selection && status === 'idle') {
      dlog('[AI Translate] Selection lost or cleared.')
      setStatus('idle')
      setResult('')
      setSourceLang('')
      setActiveSelection(null)
    }
  }, [selection, status, floatingEnabled])

  useEffect(() => {
    if (selection) setActiveSelection(selection)
  }, [selection])

  const dropPort = (port: chrome.runtime.Port) => {
    if (streamPortRef.current === port) streamPortRef.current = null
    try {
      port.disconnect()
    } catch (error) {
      if (isInvalidatedError(error)) markExtensionContextLost()
    }
  }

  const handleTranslate = async (text: string, triggerSelection?: SelectionInfo) => {
    const trimmedText = text.trim()
    if (!trimmedText || !configLoaded || !floatingEnabled || shouldSkipFloatingTranslation(trimmedText, userLanguage)) return
    if (!extensionContextAlive()) return
    cancelActiveStream()
    setStatus('loading')
    setResult('')
    setSourceLang('')
    if (triggerSelection) setActiveSelection(triggerSelection)
    else if (selection) setActiveSelection(selection)
    const targetLangCode = userLanguage

    try {
      if (floatingStreamEnabled) {
        const port = connectExtensionPort('TRANSLATE_STREAM')
        if (!port || !extensionContextAlive()) return
        streamPortRef.current = port
        let rawContent = ''

        port.onMessage.addListener(message => {
          if (streamPortRef.current !== port) return

          if (message?.type === 'started') {
            setStatus('streaming')
            return
          }

          if (message?.type === 'delta') {
            rawContent += String(message.delta ?? '')
            const parsed = parseTranslationContent(rawContent)
            setSourceLang(parsed.sourceLang)
            setResult(parsed.text)
            setStatus('streaming')
            return
          }

          if (message?.type === 'complete') {
            const nextResult = typeof message.data === 'object' && message.data !== null ? message.data : {}
            setSourceLang(typeof nextResult.sourceLang === 'string' ? nextResult.sourceLang : '')
            setResult(typeof nextResult.text === 'string' ? nextResult.text : '')
            setStatus('success')
            dropPort(port)
            return
          }

          if (message?.type === 'error') {
            if (isInvalidatedError(message.error)) {
              markExtensionContextLost()
              dropPort(port)
              return
            }
            setResult(String(message.error || 'Communication error'))
            setSourceLang('')
            setStatus('error')
            dropPort(port)
          }
        })

        port.onDisconnect.addListener(() => {
          notePortClosed()
          if (streamPortRef.current === port) streamPortRef.current = null
        })

        port.postMessage({
          action: 'START_TRANSLATE_STREAM',
          payload: { text: trimmedText, targetLangCode },
        })
        return
      }

      const response = await sendExtensionMessage<{ status?: string; data?: any; error?: string }>({
        action: 'TRANSLATE',
        payload: { text: trimmedText, targetLangCode }
      })
      if (!extensionContextAlive()) return
      dlog('[AI Translate] Response from background:', { status: response?.status })

      if (response?.status === 'success') {
        if (typeof response.data === 'object' && response.data !== null) {
          setResult(response.data.text || '')
          setSourceLang(response.data.sourceLang || '')
        } else {
          setResult(String(response.data || ''))
          setSourceLang('')
        }
        setStatus('success')
      } else {
        setResult(response?.error || 'Unknown error')
        setSourceLang('')
        setStatus('error')
      }
    } catch (e: any) {
      if (isInvalidatedError(e) || !extensionContextAlive()) {
        markExtensionContextLost()
        return
      }
      cancelActiveStream()
      derr('[AI Translate] Translation error:', e)
      setResult(e.message || 'Communication error')
      setSourceLang('')
      setStatus('error')
    }
  }

  const handleFollowup = async (
    query: string,
    sourceText: string,
    translatedText: string,
    callbacks?: FollowupStreamCallbacks
  ): Promise<string> => {
    if (!extensionContextAlive()) throw new ExtensionContextLost()

    if (floatingStreamEnabled) {
      return new Promise((resolve, reject) => {
        const port = connectExtensionPort('TRANSLATE_STREAM')
        if (!port || !extensionContextAlive()) {
          reject(new ExtensionContextLost())
          return
        }
        streamPortRef.current = port
        let rawContent = ''
        let settled = false
        const settle = (finish: () => void) => {
          if (settled) return
          settled = true
          finish()
        }

        port.onMessage.addListener(message => {
          if (streamPortRef.current !== port) return

          if (message?.type === 'started') {
            callbacks?.onStart?.()
            return
          }

          if (message?.type === 'delta') {
            const delta = String(message.delta ?? '')
            rawContent += delta
            callbacks?.onDelta?.(delta)
            return
          }

          if (message?.type === 'complete') {
            const answer = String(message.data ?? rawContent)
            callbacks?.onComplete?.(answer)
            dropPort(port)
            settle(() => resolve(answer))
            return
          }

          if (message?.type === 'error') {
            dropPort(port)
            if (isInvalidatedError(message.error)) {
              markExtensionContextLost()
              settle(() => reject(new ExtensionContextLost()))
              return
            }
            settle(() => reject(new Error(String(message.error || 'Interaction failed'))))
          }
        })

        port.onDisconnect.addListener(() => {
          notePortClosed()
          if (streamPortRef.current === port) streamPortRef.current = null
          if (!extensionContextAlive()) settle(() => reject(new ExtensionContextLost()))
        })

        try {
          port.postMessage({
            action: 'START_FOLLOWUP_STREAM',
            payload: { query, sourceText, translatedText },
          })
        } catch (error) {
          dropPort(port)
          if (isInvalidatedError(error) || !extensionContextAlive()) {
            markExtensionContextLost()
            settle(() => reject(new ExtensionContextLost()))
            return
          }
          settle(() => reject(error instanceof Error ? error : new Error('Interaction failed')))
        }
      })
    }

    const response = await sendExtensionMessage<{ status?: string; data?: unknown; error?: string }>({
      action: 'FOLLOWUP',
      payload: { query, sourceText, translatedText },
    })
    if (!extensionContextAlive()) throw new ExtensionContextLost()

    if (response?.status === 'success') {
      const answer = String(response.data || '')
      callbacks?.onStart?.()
      callbacks?.onDelta?.(answer)
      callbacks?.onComplete?.(answer)
      return answer
    }
    throw new Error(response?.error || 'Interaction failed')
  }

  const handleSaveVocab = async (input: { word: string; sourceSentence: string }): Promise<VocabEntry> => {
    const response = await sendExtensionMessage<{ status?: string; data?: VocabEntry; error?: string }>({
      action: 'SAVE_VOCAB',
      payload: {
        word: input.word,
        sourceSentence: input.sourceSentence,
        sourceUrl: location.href,
        sourceTitle: document.title || '',
      },
    })
    if (!extensionContextAlive()) throw new ExtensionContextLost()
    if (response?.status !== 'success' || !response.data) throw new Error(response?.error || 'Save failed')
    return response.data
  }

  const handleEnrichVocab = async (id: string, nextUserLanguage: UserLanguage): Promise<VocabEntry> => {
    const response = await sendExtensionMessage<{ status?: string; data?: VocabEntry; error?: string }>({
      action: 'ENRICH_VOCAB',
      payload: { id, userLanguage: nextUserLanguage },
    })
    if (!extensionContextAlive()) throw new ExtensionContextLost()
    if (response?.status !== 'success' || !response.data) throw new Error(response?.error || 'Enrichment failed')
    return response.data
  }

  const handleSummarizeVocab = async (nextUserLanguage: UserLanguage): Promise<VocabSummary> => {
    const response = await sendExtensionMessage<{ status?: string; data?: VocabSummary; error?: string }>({
      action: 'SUMMARIZE_VOCAB',
      payload: { userLanguage: nextUserLanguage },
    })
    if (!extensionContextAlive()) throw new ExtensionContextLost()
    if (response?.status !== 'success' || !response.data) throw new Error(response?.error || 'Summary failed')
    return response.data
  }

  const handleSnoozeReview = async () => {
    const response = await sendExtensionMessage<{ status?: string; error?: string }>({ action: 'SNOOZE_VOCAB_REVIEW' })
    if (!extensionContextAlive()) throw new ExtensionContextLost()
    if (response?.status !== 'success') throw new Error(response?.error || 'Snooze failed')
  }

  const handleClose = () => {
    cancelActiveStream()
    setStatus('idle')
    setResult('')
    setSourceLang('')
    setActiveSelection(null)
    clearSelection() // Was reset() before
  }

  if (!configLoaded || !activeSelection || status === 'idle') return null
  const selectionKey = `${activeSelection.text}|${activeSelection.boundingRect.top},${activeSelection.boundingRect.left},${activeSelection.boundingRect.right},${activeSelection.boundingRect.bottom}`

  return (
    <FloatingBox
      position={{ top: activeSelection.boundingRect.bottom, left: activeSelection.boundingRect.left }}
      selectionKey={selectionKey}
      status={status}
      sourceText={activeSelection.text}
      sourceLang={sourceLang}
      result={result}
      progress={hoverProgress}
      onFollowup={handleFollowup}
      onClose={handleClose}
      onSaveVocab={handleSaveVocab}
      onEnrichVocab={handleEnrichVocab}
      onSummarizeVocab={handleSummarizeVocab}
      onSnoozeReview={handleSnoozeReview}
      userLanguage={userLanguage}
      interfaceSide={interfaceSide}
      reviewNotice={shouldShowReviewNotice(memory) ? { count: memory.review.newSinceSummary } : null}
    />
  )
}

export default ContentApp
