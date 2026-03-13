import { useEffect, useRef, useState } from 'react'
import { useSelectionHover, type SelectionInfo } from './hooks/useSelectionHover'
import FloatingBox from './components/FloatingBox'
import { dlog, derr, initDebug } from '../lib/debug'
import {
  HOVER_DURATION_DEFAULT_MS,
  HOVER_DURATION_MAX_MS,
  HOVER_DURATION_MIN_MS,
  getConfig,
} from '../lib/config'

initDebug()

const ContentApp = () => {
  const [hoverDurationMs, setHoverDurationMs] = useState(HOVER_DURATION_DEFAULT_MS)
  const [floatingEnabled, setFloatingEnabled] = useState(true)
  const [floatingStreamEnabled, setFloatingStreamEnabled] = useState(false)
  const streamPortRef = useRef<chrome.runtime.Port | null>(null)

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

  const cancelActiveStream = () => {
    streamPortRef.current?.disconnect()
    streamPortRef.current = null
  }

  useEffect(() => {
    getConfig()
      .then(cfg => {
        setHoverDurationMs(normalizeHoverDuration(cfg.hoverDurationMs))
        setFloatingEnabled(cfg.floatingEnabled !== false)
        setFloatingStreamEnabled(cfg.floatingStreamEnabled === true)
      })
      .catch(() => {
        setHoverDurationMs(HOVER_DURATION_DEFAULT_MS)
        setFloatingEnabled(true)
        setFloatingStreamEnabled(false)
      })

    const onChanged = (changes: { [key: string]: chrome.storage.StorageChange }, areaName: string) => {
      if (areaName !== 'sync') return
      const next = changes.config?.newValue as any
      if (!next) return
      setHoverDurationMs(normalizeHoverDuration(next.hoverDurationMs))
      if (typeof next.floatingEnabled === 'boolean') setFloatingEnabled(next.floatingEnabled)
      if (typeof next.floatingStreamEnabled === 'boolean') setFloatingStreamEnabled(next.floatingStreamEnabled)
    }

    chrome.storage.onChanged.addListener(onChanged)
    return () => {
      chrome.storage.onChanged.removeListener(onChanged)
      cancelActiveStream()
    }
  }, [])

  const { selection, hoverProgress, clearSelection } = useSelectionHover(
    // onTrigger callback
    (text, triggerSelection) => {
      dlog('[AI Translate] onTrigger fired via callback!', { length: text.length })
      setActiveSelection(triggerSelection)
      handleTranslate(text, triggerSelection)
    },
    hoverDurationMs,
    floatingEnabled
  )
  const [status, setStatus] = useState<'idle' | 'counting' | 'loading' | 'streaming' | 'success' | 'error'>('idle')
  const [result, setResult] = useState<string>('')
  const [sourceLang, setSourceLang] = useState<string>('')
  const [activeSelection, setActiveSelection] = useState<typeof selection>(null)

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

  const handleTranslate = async (text: string, triggerSelection?: SelectionInfo) => {
    const trimmedText = text.trim()
    if (!trimmedText) return
    cancelActiveStream()
    setStatus('loading')
    setResult('')
    setSourceLang('')
    if (triggerSelection) setActiveSelection(triggerSelection)
    else if (selection) setActiveSelection(selection)
    const targetLangCode = 'zh'

    if (floatingStreamEnabled) {
      const port = chrome.runtime.connect({ name: 'TRANSLATE_STREAM' })
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
          if (streamPortRef.current === port) streamPortRef.current = null
          port.disconnect()
          return
        }

        if (message?.type === 'error') {
          setResult(String(message.error || 'Communication error'))
          setSourceLang('')
          setStatus('error')
          if (streamPortRef.current === port) streamPortRef.current = null
          port.disconnect()
        }
      })

      port.onDisconnect.addListener(() => {
        if (streamPortRef.current === port) streamPortRef.current = null
      })

      port.postMessage({
        action: 'START_TRANSLATE_STREAM',
        payload: { text: trimmedText, targetLangCode },
      })
      return
    }

    try {
      const response = await chrome.runtime.sendMessage({
        action: 'TRANSLATE',
        payload: { text: trimmedText, targetLangCode }
      })
      dlog('[AI Translate] Response from background:', { status: response?.status })

      if (response.status === 'success') {
        if (typeof response.data === 'object' && response.data !== null) {
          setResult(response.data.text || '')
          setSourceLang(response.data.sourceLang || '')
        } else {
          // Fallback for legacy response format or simple string
          setResult(String(response.data || ''))
          setSourceLang('')
        }
        setStatus('success')
      } else {
        setResult(response.error || 'Unknown error')
        setSourceLang('')
        setStatus('error')
      }
    } catch (e: any) {
      derr('[AI Translate] Translation error:', e)
      setResult(e.message || 'Communication error')
      setSourceLang('')
      setStatus('error')
    }
  }

  const handleFollowup = async (query: string, sourceText: string, translatedText: string): Promise<string> => {
    const response = await chrome.runtime.sendMessage({
      action: 'FOLLOWUP',
      payload: { query, sourceText, translatedText },
    })

    if (response?.status === 'success') return String(response.data || '')
    throw new Error(response?.error || 'Interaction failed')
  }

  const handleClose = () => {
    cancelActiveStream()
    setStatus('idle')
    setResult('')
    setSourceLang('')
    setActiveSelection(null)
    clearSelection() // Was reset() before
  }

  if (!activeSelection || status === 'idle') return null
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
    />
  )
}

export default ContentApp
