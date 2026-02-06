import { useState, useEffect, useRef } from 'react'
import { dlog, derr, initDebug } from '../../lib/debug'

initDebug()

interface Rect {
  top: number
  left: number
  right: number
  bottom: number
}

interface SelectionInfo {
  text: string
  rects: Rect[] 
  boundingRect: Rect
}

export const useSelectionHover = (onTrigger: (text: string) => void, hoverDuration = 3000) => {
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

    const rectBuffer = 20
    const insideAnyRect = sel.rects.some(rect => {
      return (
        clientX >= rect.left - rectBuffer &&
        clientX <= rect.right + rectBuffer &&
        clientY >= rect.top - rectBuffer &&
        clientY <= rect.bottom + rectBuffer
      )
    })

    const boundingBuffer = 30
    const insideBoundingRect =
      clientX >= sel.boundingRect.left - boundingBuffer &&
      clientX <= sel.boundingRect.right + boundingBuffer &&
      clientY >= sel.boundingRect.top - boundingBuffer &&
      clientY <= sel.boundingRect.bottom + boundingBuffer

    return {
      isInside: insideAnyRect || insideBoundingRect,
      insideAnyRect,
      insideBoundingRect,
    }
  }

  useEffect(() => {
    const handleSelectionChange = () => {
      const sel = window.getSelection()
      if (!sel || sel.isCollapsed || !sel.toString().trim()) {
        setSelection(null)
        selectionRef.current = null
        setIsHovering(false)
        setHoverProgress(0)
        clearTimers()
        resetHoverState()
        return
      }

      const range = sel.getRangeAt(0)
      const boundingRect = range.getBoundingClientRect()
      // Convert DOMRectList to simple Rect objects to ensure state persistence
      const clientRects = Array.from(range.getClientRects()).map(r => ({
        top: r.top, left: r.left, right: r.right, bottom: r.bottom
      }))
      
      // Ignore zero-width rects (invisible)
      if (boundingRect.width === 0 || boundingRect.height === 0) return

      const newSelection = {
        text: sel.toString(),
        rects: clientRects,
        boundingRect: {
          top: boundingRect.top,
          left: boundingRect.left,
          right: boundingRect.right,
          bottom: boundingRect.bottom
        },
      }
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
    const handleMouseUp = (e: MouseEvent) => {
      lastMousePosRef.current = { x: e.clientX, y: e.clientY }
      handleSelectionChange()
    }
    document.addEventListener('mouseup', handleMouseUp)
    document.addEventListener('keyup', handleSelectionChange) // Shift+Arrow selection

    return () => {
      document.removeEventListener('mouseup', handleMouseUp)
      document.removeEventListener('keyup', handleSelectionChange)
    }
  }, [])

  useEffect(() => {
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
  }, [])

  useEffect(() => {
    if (!selection) {
      clearTimers()
      resetHoverState()
      return
    }

    const handleMouseMove = (e: MouseEvent) => {
      const { clientX, clientY } = e
      lastMousePosRef.current = { x: clientX, y: clientY }
      
      // Check if point is inside ANY of the selection rects
      const rectBuffer = 20
      const insideAnyRect = selection.rects.some(rect => {
        return (
          clientX >= rect.left - rectBuffer &&
          clientX <= rect.right + rectBuffer &&
          clientY >= rect.top - rectBuffer &&
          clientY <= rect.bottom + rectBuffer
        )
      })
      const boundingBuffer = 30
      const insideBoundingRect =
        clientX >= selection.boundingRect.left - boundingBuffer &&
        clientX <= selection.boundingRect.right + boundingBuffer &&
        clientY >= selection.boundingRect.top - boundingBuffer &&
        clientY <= selection.boundingRect.bottom + boundingBuffer

      const isInside = insideAnyRect || insideBoundingRect
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
  }, [selection, isHovering])

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
        if (currentSelection) onTriggerRef.current(currentSelection.text)
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
