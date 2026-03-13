import { useState, useEffect, useRef } from 'react'
import { dlog, derr, initDebug } from '../../lib/debug'

initDebug()

interface Rect {
  top: number
  left: number
  right: number
  bottom: number
}

export interface SelectionInfo {
  text: string
  rects: Rect[] 
  boundingRect: Rect
}

const toRect = (rect: DOMRect): Rect => ({
  top: rect.top,
  left: rect.left,
  right: rect.right,
  bottom: rect.bottom,
})

const getDeepActiveElement = (): Element | null => {
  let active: Element | null = document.activeElement
  while (active instanceof HTMLElement && active.shadowRoot?.activeElement) {
    active = active.shadowRoot.activeElement
  }
  return active
}

const getInputSelectionInfo = (): SelectionInfo | null => {
  const active = getDeepActiveElement()
  if (!(active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement)) return null
  if (active instanceof HTMLInputElement && active.type === 'password') return null

  const start = active.selectionStart
  const end = active.selectionEnd
  if (start == null || end == null || start === end) return null

  const value = active.value ?? ''
  const selectedText = value.slice(start, end)
  if (!selectedText.trim()) return null

  // Input/Textarea does not expose per-range client rects, so fall back to control bounds.
  const rect = active.getBoundingClientRect()
  if (rect.width === 0 || rect.height === 0) return null

  return {
    text: selectedText,
    rects: [toRect(rect)],
    boundingRect: toRect(rect),
  }
}

const getWindowSelectionInfo = (): SelectionInfo | null => {
  const sel = window.getSelection()
  if (!sel || sel.isCollapsed || !sel.toString().trim()) return null

  const range = sel.getRangeAt(0)
  const boundingRect = range.getBoundingClientRect()
  if (boundingRect.width === 0 || boundingRect.height === 0) return null

  const clientRects = Array.from(range.getClientRects()).map(toRect)

  return {
    text: sel.toString(),
    rects: clientRects,
    boundingRect: toRect(boundingRect),
  }
}

export const useSelectionHover = (onTrigger: (text: string, selection: SelectionInfo) => void, hoverDuration = 3000, enabled = true) => {
  const [selection, setSelection] = useState<SelectionInfo | null>(null)
  const [isHovering, setIsHovering] = useState(false)
  const [hoverProgress, setHoverProgress] = useState(0) // 0-100
  
  // Ref to hold the latest onTrigger callback to avoid stale closures in setTimeout
  const onTriggerRef = useRef(onTrigger)
  const selectionRef = useRef<SelectionInfo | null>(null) // Ref for latest selection
  
  useEffect(() => {
    onTriggerRef.current = onTrigger
  }, [onTrigger])

  const hoverTimerRef = useRef<NodeJS.Timeout | null>(null)
  const stopDebounceRef = useRef<NodeJS.Timeout | null>(null)
  const progressIntervalRef = useRef<NodeJS.Timeout | null>(null)
  const monitorIntervalRef = useRef<NodeJS.Timeout | null>(null)
  const isInsideRef = useRef(false)
  const isTriggeredRef = useRef(false)
  const lastMousePosRef = useRef<{ x: number; y: number } | null>(null)
  const activeInsideStartMsRef = useRef<number | null>(null)
  const accumulatedMsRef = useRef(0)
  const outsideSinceMsRef = useRef<number | null>(null)
  const lastDebugSecondRef = useRef<number | null>(null)

  const computeIsInside = (pos: { x: number; y: number }, sel: SelectionInfo) => {
    const { x: clientX, y: clientY } = pos

    const rectBuffer = 12
    const insideAnyRect = sel.rects.some(rect => {
      return (
        clientX >= rect.left - rectBuffer &&
        clientX <= rect.right + rectBuffer &&
        clientY >= rect.top - rectBuffer &&
        clientY <= rect.bottom + rectBuffer
      )
    })

    const nearestDistance = sel.rects.reduce((minDist, rect) => {
      const dx = Math.max(rect.left - clientX, 0, clientX - rect.right)
      const dy = Math.max(rect.top - clientY, 0, clientY - rect.bottom)
      const dist = Math.hypot(dx, dy)
      return Math.min(minDist, dist)
    }, Number.POSITIVE_INFINITY)
    const insideBoundingRect = nearestDistance <= 16

    return {
      isInside: insideAnyRect || insideBoundingRect,
      insideAnyRect,
      insideBoundingRect,
    }
  }

  const shouldSkipSelection = (text: string) => {
    const trimmed = text.trim()
    if (!trimmed) return true
    const hasCjk = /[\u4e00-\u9fff]/.test(trimmed)
    const hasLatin = /[A-Za-z]/.test(trimmed)
    return hasCjk && !hasLatin
  }

  useEffect(() => {
    if (!enabled) return

    const handleSelectionChange = () => {
      const nextSelection = getInputSelectionInfo() ?? getWindowSelectionInfo()
      if (!nextSelection) {
        setSelection(null)
        selectionRef.current = null
        setIsHovering(false)
        setHoverProgress(0)
        clearTimers()
        resetHoverState()
        return
      }

      const selectedText = nextSelection.text
      if (shouldSkipSelection(selectedText)) {
        setSelection(null)
        selectionRef.current = null
        setIsHovering(false)
        setHoverProgress(0)
        clearTimers()
        resetHoverState()
        dlog('[AI Translate] Skip Chinese selection.')
        return
      }

      const newSelection = nextSelection
      setSelection(newSelection)
      selectionRef.current = newSelection
      resetHoverState()

      const pos = lastMousePosRef.current
      if (pos) {
        const { isInside, insideAnyRect, insideBoundingRect } = computeIsInside(pos, newSelection)
        isInsideRef.current = isInside
        dlog('[AI Translate] Selection set. Mouse position check:', { isInside, insideAnyRect, insideBoundingRect })
        if (isInside && !monitorIntervalRef.current) {
          dlog('[AI Translate] Mouse already over selection. Starting timer.')
          startHoverMonitor()
        }
      } else {
        dlog('[AI Translate] Selection set. No mouse position yet; wait for mousemove to start timer.')
      }
    }

    // Use mouseup for stable selection end, selectionchange fires too often during drag
    let selectionChangeRaf: number | null = null
    const handleMouseUp = (e: MouseEvent) => {
      lastMousePosRef.current = { x: e.clientX, y: e.clientY }
      handleSelectionChange()
    }
    const handleSelectionChangeEvent = () => {
      if (selectionChangeRaf != null) cancelAnimationFrame(selectionChangeRaf)
      selectionChangeRaf = requestAnimationFrame(() => {
        selectionChangeRaf = null
        handleSelectionChange()
      })
    }
    document.addEventListener('mouseup', handleMouseUp, true)
    document.addEventListener('keyup', handleSelectionChange, true) // Shift+Arrow selection
    document.addEventListener('selectionchange', handleSelectionChangeEvent)

    return () => {
      document.removeEventListener('mouseup', handleMouseUp, true)
      document.removeEventListener('keyup', handleSelectionChange, true)
      document.removeEventListener('selectionchange', handleSelectionChangeEvent)
      if (selectionChangeRaf != null) cancelAnimationFrame(selectionChangeRaf)
    }
  }, [enabled])

  useEffect(() => {
    if (!enabled) return

    const handleMouseMove = (e: MouseEvent) => {
      lastMousePosRef.current = { x: e.clientX, y: e.clientY }

      const sel = selectionRef.current
      if (!sel || monitorIntervalRef.current) return

      const { isInside } = computeIsInside(lastMousePosRef.current, sel)
      isInsideRef.current = isInside
      if (isInside) {
        dlog('[AI Translate] Mouse moved into selection. Starting timer.')
        startHoverMonitor()
      }
    }

    document.addEventListener('mousemove', handleMouseMove)
    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
    }
  }, [enabled])

  useEffect(() => {
    if (!enabled) {
      setSelection(null)
      selectionRef.current = null
      clearTimers()
      resetHoverState()
      return
    }

    if (!selection) {
      clearTimers()
      resetHoverState()
      return
    }

    const handleMouseMove = (e: MouseEvent) => {
      const { clientX, clientY } = e
      lastMousePosRef.current = { x: clientX, y: clientY }
      const { isInside, insideAnyRect, insideBoundingRect } = computeIsInside(lastMousePosRef.current, selection)
      isInsideRef.current = isInside

      // Debug log every 500ms to avoid spamming
      if (Math.random() < 0.05) {
        dlog('[AI Translate] Hover Check:', { isInside, insideAnyRect, insideBoundingRect, isHovering, stopPending: !!stopDebounceRef.current })
      }

      if (isInside) {
        // If we were about to stop, cancel the stop debounce
        if (stopDebounceRef.current) {
          clearTimeout(stopDebounceRef.current)
          stopDebounceRef.current = null
        }

        if (!isHovering && !monitorIntervalRef.current) {
          dlog('[AI Translate] Mouse entered selection area. Starting timer.')
          startHoverMonitor()
        }
      } else {
        // Don't stop immediately. Debounce to handle jitter or quick movements.
        if (isHovering && !stopDebounceRef.current) {
          stopDebounceRef.current = setTimeout(() => {
            dlog('[AI Translate] Mouse left selection area (debounced). Stopping timer.')
            stopHoverMonitor()
          }, 900) // more forgiving for multi-line / large selections
        }
      }
    }

    document.addEventListener('mousemove', handleMouseMove)

    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      clearTimers()
      resetHoverState()
    }
  }, [selection, isHovering, enabled])

  const startHoverMonitor = () => {
    setIsHovering(true)
    setHoverProgress(0)

    isTriggeredRef.current = false
    accumulatedMsRef.current = 0
    outsideSinceMsRef.current = null
    activeInsideStartMsRef.current = isInsideRef.current ? Date.now() : null
    lastDebugSecondRef.current = null

    if (monitorIntervalRef.current) clearInterval(monitorIntervalRef.current)
    monitorIntervalRef.current = setInterval(() => {
      const now = Date.now()

      if (isTriggeredRef.current) return

      if (isInsideRef.current) {
        if (outsideSinceMsRef.current) outsideSinceMsRef.current = null
        if (activeInsideStartMsRef.current == null) activeInsideStartMsRef.current = now
      } else {
        if (activeInsideStartMsRef.current != null) {
          accumulatedMsRef.current += now - activeInsideStartMsRef.current
          activeInsideStartMsRef.current = null
        }
        if (outsideSinceMsRef.current == null) outsideSinceMsRef.current = now
      }

      const insideExtra = activeInsideStartMsRef.current ? now - activeInsideStartMsRef.current : 0
      const effectiveMs = accumulatedMsRef.current + insideExtra
      const progress = Math.min(100, (effectiveMs / hoverDuration) * 100)
      setHoverProgress(progress)

      const debugSecond = Math.floor(effectiveMs / 1000)
      if (debugSecond !== lastDebugSecondRef.current) {
        lastDebugSecondRef.current = debugSecond
        dlog('[AI Translate] Hover Accumulate:', {
          effectiveMs,
          accumulatedMs: accumulatedMsRef.current,
          inside: isInsideRef.current,
          outsideMs: outsideSinceMsRef.current ? now - outsideSinceMsRef.current : 0,
        })
      }

      if (effectiveMs >= hoverDuration) {
        isTriggeredRef.current = true
        dlog('[AI Translate] Hover reached duration. Calling onTrigger.')
        stopHoverMonitor()
        const currentSelection = selectionRef.current
        if (currentSelection) onTriggerRef.current(currentSelection.text, currentSelection)
        else derr('[AI Translate] Triggered but selectionRef is null')
      }
    }, 50)
  }

  const stopHoverMonitor = () => {
    setIsHovering(false)
    setHoverProgress(0)
    clearTimers()
    resetHoverState()
  }

  const clearTimers = () => {
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current)
    if (stopDebounceRef.current) clearTimeout(stopDebounceRef.current)
    if (progressIntervalRef.current) clearInterval(progressIntervalRef.current)
    if (monitorIntervalRef.current) clearInterval(monitorIntervalRef.current)
    hoverTimerRef.current = null
    stopDebounceRef.current = null
    progressIntervalRef.current = null
    monitorIntervalRef.current = null
  }

  const resetHoverState = () => {
    isInsideRef.current = false
    isTriggeredRef.current = false
    activeInsideStartMsRef.current = null
    accumulatedMsRef.current = 0
    outsideSinceMsRef.current = null
    lastDebugSecondRef.current = null
  }

  return {
    selection,
    isHovering,
    hoverProgress,
    clearSelection: () => {
      setSelection(null)
      selectionRef.current = null
      stopHoverMonitor()
    }
  }
}
