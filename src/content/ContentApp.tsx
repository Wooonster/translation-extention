import { useEffect, useState } from 'react'
import { useSelectionHover } from './hooks/useSelectionHover'
import FloatingBox from './components/FloatingBox'
import { dlog, derr, initDebug } from '../lib/debug'
import { getConfig } from '../lib/config'

initDebug()

const ContentApp = () => {
  const [hoverDurationMs, setHoverDurationMs] = useState(3000)

  useEffect(() => {
    getConfig()
      .then(cfg => setHoverDurationMs(Number(cfg.hoverDurationMs) || 3000))
      .catch(() => setHoverDurationMs(3000))

    const onChanged = (changes: { [key: string]: chrome.storage.StorageChange }, areaName: string) => {
      if (areaName !== 'sync') return
      const next = changes.config?.newValue as any
      if (!next) return
      const ms = Number(next.hoverDurationMs)
      if (Number.isFinite(ms) && ms > 0) setHoverDurationMs(ms)
    }

    chrome.storage.onChanged.addListener(onChanged)
    return () => chrome.storage.onChanged.removeListener(onChanged)
  }, [])

  const { selection, isHovering, hoverProgress, clearSelection } = useSelectionHover(
    // onTrigger callback
    (text) => {
      dlog('[AI Translate] onTrigger fired via callback!', { length: text.length })
      handleTranslate(text)
    },
    hoverDurationMs
  )
  const [status, setStatus] = useState<'idle' | 'counting' | 'loading' | 'success' | 'error'>('idle')
  const [result, setResult] = useState<string>('')

  // State machine logic
  useEffect(() => {
    if (isHovering) {
      // User request: Don't show anything while counting down
    } else if (!selection) {
      dlog('[AI Translate] Selection lost or cleared.')
      setStatus('idle')
      setResult('')
    } else {
      // Selection exists but not hovering/triggered
      if (status === 'counting') setStatus('idle')
    }
  }, [isHovering, selection])

  const handleTranslate = async (text: string) => {
    setStatus('loading')
    
    try {
      const response = await chrome.runtime.sendMessage({
        action: 'TRANSLATE',
        payload: { text }
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

  const handleClose = () => {
    setStatus('idle')
    setResult('')
    clearSelection() // Was reset() before
  }

  if (!selection || status === 'idle') return null

  return (
    <FloatingBox
      position={{ top: selection.boundingRect.bottom, left: selection.boundingRect.left }}
      status={status}
      result={result}
      progress={hoverProgress}
      onClose={handleClose}
    />
  )
}

export default ContentApp
