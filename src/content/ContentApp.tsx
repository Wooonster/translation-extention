import { useEffect, useState } from 'react'
import { useSelectionHover, type SelectionInfo } from './hooks/useSelectionHover'
import FloatingBox from './components/FloatingBox'
import { dlog, derr, initDebug } from '../lib/debug'
import { getConfig } from '../lib/config'

initDebug()

const ContentApp = () => {
  const [hoverDurationMs, setHoverDurationMs] = useState(3000)
  const [floatingEnabled, setFloatingEnabled] = useState(true)

  useEffect(() => {
    getConfig()
      .then(cfg => {
        setHoverDurationMs(Number(cfg.hoverDurationMs) || 3000)
        setFloatingEnabled(cfg.floatingEnabled !== false)
      })
      .catch(() => {
        setHoverDurationMs(3000)
        setFloatingEnabled(true)
      })

    const onChanged = (changes: { [key: string]: chrome.storage.StorageChange }, areaName: string) => {
      if (areaName !== 'sync') return
      const next = changes.config?.newValue as any
      if (!next) return
      const ms = Number(next.hoverDurationMs)
      if (Number.isFinite(ms) && ms > 0) setHoverDurationMs(ms)
      if (typeof next.floatingEnabled === 'boolean') setFloatingEnabled(next.floatingEnabled)
    }

    chrome.storage.onChanged.addListener(onChanged)
    return () => chrome.storage.onChanged.removeListener(onChanged)
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
  const [status, setStatus] = useState<'idle' | 'counting' | 'loading' | 'success' | 'error'>('idle')
  const [result, setResult] = useState<string>('')
  const [activeSelection, setActiveSelection] = useState<typeof selection>(null)

  // State machine logic
  useEffect(() => {
    if (!floatingEnabled) {
      setStatus('idle')
      setResult('')
      setActiveSelection(null)
      clearSelection()
      return
    }

    if (!selection && status === 'idle') {
      dlog('[AI Translate] Selection lost or cleared.')
      setStatus('idle')
      setResult('')
      setActiveSelection(null)
    }
  }, [selection, status, floatingEnabled])

  useEffect(() => {
    if (selection) setActiveSelection(selection)
  }, [selection])

  const handleTranslate = async (text: string, triggerSelection?: SelectionInfo) => {
    const trimmedText = text.trim()
    if (!trimmedText) return
    setStatus('loading')
    if (triggerSelection) setActiveSelection(triggerSelection)
    else if (selection) setActiveSelection(selection)
    const targetLangCode = 'zh'

    try {
      const response = await chrome.runtime.sendMessage({
        action: 'TRANSLATE',
        payload: { text: trimmedText, targetLangCode }
      })
      dlog('[AI Translate] Response from background:', { status: response?.status })

      if (response.status === 'success') {
        setResult(response.data)
        setStatus('success')
      } else {
        setResult(response.error || 'Unknown error')
        setStatus('error')
      }
    } catch (e: any) {
      derr('[AI Translate] Translation error:', e)
      setResult(e.message || 'Communication error')
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
    setStatus('idle')
    setResult('')
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
      result={result}
      progress={hoverProgress}
      onFollowup={handleFollowup}
      onClose={handleClose}
    />
  )
}

export default ContentApp
