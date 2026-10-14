import { getConfig } from './config'

let enabled = false
let initialized = false

export const initDebug = async () => {
  if (initialized) return
  initialized = true

  try {
    if (!chrome.runtime?.id) return
    const config = await getConfig()
    enabled = Boolean((config as any).debug)
    chrome.storage.onChanged.addListener((changes, areaName) => {
      try {
        if (areaName !== 'sync') return
        const next = changes.config?.newValue as any
        if (!next) return
        enabled = Boolean(next.debug)
      } catch {
        enabled = false
      }
    })
  } catch {
    enabled = false
  }
}

export const dlog = (...args: any[]) => {
  if (!enabled) return
  console.log(...args)
}

export const derr = (...args: any[]) => {
  if (!enabled) return
  console.error(...args)
}
