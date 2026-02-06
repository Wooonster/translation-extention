import { getConfig } from './config'

let enabled = false
let initialized = false

export const initDebug = async () => {
  if (initialized) return
  initialized = true

  try {
    const config = await getConfig()
    enabled = Boolean((config as any).debug)
  } catch {
    enabled = false
  }

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'sync') return
    const next = changes.config?.newValue as any
    if (!next) return
    enabled = Boolean(next.debug)
  })
}

export const dlog = (...args: any[]) => {
  if (!enabled) return
  console.log(...args)
}

export const derr = (...args: any[]) => {
  if (!enabled) return
  console.error(...args)
}
