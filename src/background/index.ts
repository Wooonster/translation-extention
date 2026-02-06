import { getConfig } from '../lib/config'
import { dlog, derr, initDebug } from '../lib/debug'

initDebug()
dlog('Background service worker loaded.')

let keepAliveTimer: ReturnType<typeof setInterval> | null = null

chrome.runtime.onInstalled.addListener(() => {
  dlog('AI Translate Assistant installed.')
})

getConfig()
  .then(config => configureKeepAlive(config))
  .catch(() => {})

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'sync') return
  const next = changes.config?.newValue as any
  if (!next) return
  configureKeepAlive(next)
})

chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
  if (request.action === 'TRANSLATE') {
    handleTranslate(request.payload.text)
      .then(result => sendResponse({ status: 'success', data: result }))
      .catch(error => sendResponse({ status: 'error', error: error.message }))
    return true // Keep channel open for async response
  }
  
  if (request.action === 'PRELOAD_MODEL') {
    handlePreload()
      .then(() => sendResponse({ status: 'success' }))
      .catch(error => sendResponse({ status: 'error', error: error.message }))
    return true
  }
})

function configureKeepAlive(config: any) {
  if (keepAliveTimer) {
    clearInterval(keepAliveTimer)
    keepAliveTimer = null
  }

  const enabled = Boolean(config.keepAliveEnabled)
  if (!enabled) return

  const intervalSec = Number(config.keepAliveIntervalSec)
  const safeIntervalSec = Number.isFinite(intervalSec) ? Math.min(3600, Math.max(15, intervalSec)) : 60

  keepAliveTimer = setInterval(() => {
    dlog('[AI Translate] Sending Keep-Alive heartbeat...')
    handlePreload().catch(err => derr('[AI Translate] Keep-Alive failed:', err))
  }, safeIntervalSec * 1000)
}

async function handlePreload(): Promise<void> {
  dlog('[AI Translate] Preloading model...')
  const config = await getConfig()
  
  // Reuse logic to construct endpoint
  let baseUrl = config.apiUrl.replace(/\/$/, '')
  let endpoint = ''

  if (baseUrl.endsWith('/chat/completions')) {
      endpoint = baseUrl
  } else if (baseUrl.endsWith('/v1')) {
      endpoint = `${baseUrl}/chat/completions`
  } else {
      endpoint = `${baseUrl}/v1/chat/completions`
  }

  // Send a minimal request to trigger model loading
  // We use max_tokens: 1 to minimize generation time
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`
      },
      body: JSON.stringify({
        model: config.modelName,
        messages: [
          { role: 'user', content: 'Initialize the translation model. This is a preload request to warm up the inference engine. Please acknowledge.' }
        ],
        max_tokens: 5,
        temperature: 0
      })
    })

    if (!response.ok) {
      throw new Error(`Preload failed: ${response.status} ${response.statusText}`)
    }
    dlog('[AI Translate] Model preloaded successfully.')
  } catch (error: any) {
    derr('[AI Translate] Preload error:', error)
    throw error
  }
}

async function handleTranslate(text: string): Promise<string> {
  const config = await getConfig()
  
  // Clean up API URL (remove trailing slash)
  let baseUrl = config.apiUrl.replace(/\/$/, '')
  
  // Logic: 
  // 1. If user provides a full URL that ends in /chat/completions, trust it.
  // 2. If user provides a URL ending in /v1, append /chat/completions.
  // 3. If user provides a root URL (e.g. localhost:1234), append /v1/chat/completions (standard OpenAI/LM Studio convention).
  
  let endpoint = ''

  if (baseUrl.endsWith('/chat/completions')) {
      endpoint = baseUrl
  } else if (baseUrl.endsWith('/v1')) {
      endpoint = `${baseUrl}/chat/completions`
  } else {
      // Assume root URL, append standard path
      endpoint = `${baseUrl}/v1/chat/completions`
  }
  
  dlog(`[AI Translate] Sending request to: ${endpoint}`)


  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`
      },
      body: JSON.stringify({
        model: config.modelName,
        messages: [
          { role: 'system', content: config.prompt },
          { role: 'user', content: `Translate the following to Chinese:\n\n${text}` }
        ],
        temperature: 0.3
      })
    })

    if (!response.ok) {
      throw new Error(`API Error: ${response.status} ${response.statusText}`)
    }

    const data = await response.json()
    return data.choices?.[0]?.message?.content || 'No translation returned.'
  } catch (error: any) {
    derr('[AI Translate] Translation failed:', error)
    throw new Error(error.message || 'Network error')
  }
}
