type ContextListener = () => void

const listeners = new Set<ContextListener>()
let invalidated = false

export class ExtensionContextLost extends Error {
  constructor() {
    super('Extension context invalidated')
    this.name = 'ExtensionContextLost'
  }
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string') {
    return error.message
  }
  return ''
}

export function isInvalidatedError(error: unknown): boolean {
  if (error instanceof ExtensionContextLost) return true
  return errorText(error).includes('Extension context invalidated')
}

export function extensionContextAlive(): boolean {
  if (invalidated) return false
  try {
    if (chrome.runtime?.id) return true
  } catch (error) {
    if (!isInvalidatedError(error)) return false
  }
  markExtensionContextLost()
  return false
}

export function markExtensionContextLost(): void {
  if (invalidated) return
  invalidated = true
  listeners.forEach(listener => {
    try {
      listener()
    } catch {
      // A teardown listener must not surface another console error.
    }
  })
}

export function onExtensionContextLost(listener: ContextListener): () => void {
  listeners.add(listener)
  if (invalidated) listener()
  return () => listeners.delete(listener)
}

function lose(error: unknown): boolean {
  if (!extensionContextAlive() || isInvalidatedError(error)) {
    markExtensionContextLost()
    return true
  }
  return false
}

export async function sendExtensionMessage<T>(message: unknown): Promise<T | undefined> {
  if (!extensionContextAlive()) return undefined
  try {
    return await chrome.runtime.sendMessage(message) as T
  } catch (error) {
    if (lose(error)) return undefined
    throw error
  }
}

export function connectExtensionPort(name: string): chrome.runtime.Port | null {
  if (!extensionContextAlive()) return null
  try {
    const port = chrome.runtime.connect({ name })
    port.onDisconnect.addListener(() => {
      try {
        const reason = chrome.runtime.lastError
        if (reason && isInvalidatedError(reason)) markExtensionContextLost()
      } catch (error) {
        lose(error)
      }
    })
    return port
  } catch (error) {
    if (lose(error)) return null
    throw error
  }
}

export function watchExtensionStorage(
  listener: (changes: { [key: string]: chrome.storage.StorageChange }, areaName: string) => void,
): () => void {
  if (!extensionContextAlive()) return () => {}
  try {
    chrome.storage.onChanged.addListener(listener)
  } catch (error) {
    lose(error)
    return () => {}
  }
  return () => {
    try {
      if (!extensionContextAlive()) return
      chrome.storage.onChanged.removeListener(listener)
    } catch (error) {
      lose(error)
    }
  }
}
