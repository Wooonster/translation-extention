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
    handleTranslate(request.payload.text, request.payload.targetLangCode, request.payload.attempt)
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

async function handleTranslate(text: string, targetLangCode?: string, attempt?: number): Promise<string> {
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
    const isTranslateGemma = isTranslateGemmaModel(config.modelName)
    const normalizedTargetLangCode = normalizeLangCode(targetLangCode)
    const isRetry = Number.isFinite(Number(attempt)) && Number(attempt) > 1
    const { temperature, top_p, top_k } = chooseSamplingParams({
      isTranslateGemma,
      isRetry,
      targetLangCode: normalizedTargetLangCode,
    })

    const messages = isTranslateGemma
      ? [
          {
            role: 'user',
            content: buildTranslateGemmaUserPrompt({
              text,
              sourceLangCode: detectTranslateGemmaSourceLangCode(text),
              targetLangCode: normalizeTranslateGemmaLangCode(normalizedTargetLangCode ?? 'zh') ?? 'zh-Hans',
            }),
          },
        ]
      : [
          {
            role: 'system',
            content: normalizedTargetLangCode
              ? 'You are a professional translation assistant. Output only the translation result, without explanations.'
              : config.prompt,
          },
          {
            role: 'user',
            content: normalizedTargetLangCode
              ? `Translate the following to ${langCodeToPromptName(normalizeTranslateGemmaLangCode(normalizedTargetLangCode ?? 'zh') ?? 'zh-Hans')}:\n\n${text}`
              : `Translate the following to Chinese:\n\n${text}`,
          },
        ]

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`
      },
      body: JSON.stringify({
        model: config.modelName,
        messages,
        temperature,
        top_p,
        top_k
      })
    })

    if (!response.ok) {
      throw new Error(`API Error: ${response.status} ${response.statusText}`)
    }

    const data = await response.json()
    const content = data.choices?.[0]?.message?.content
    if (!content) return 'No translation returned.'
    return stripEdgeNewlines(content)
  } catch (error: any) {
    derr('[AI Translate] Translation failed:', error)
    throw new Error(error.message || 'Network error')
  }
}

function isTranslateGemmaModel(modelName: string): boolean {
  return /translategemma/i.test(modelName)
}

function normalizeLangCode(langCode?: string): string | undefined {
  if (!langCode) return undefined
  const trimmed = String(langCode).trim()
  if (!trimmed) return undefined
  return trimmed.replace('_', '-')
}

function langCodeToPromptName(langCode: string): string {
  switch (langCode.toLowerCase()) {
    case 'en':
      return 'English'
    case 'zh':
    case 'zh-cn':
    case 'zh-hans':
    case 'zh-hant':
      return 'Chinese'
    case 'fr':
      return 'French'
    case 'de':
      return 'German'
    case 'es':
      return 'Spanish'
    case 'ar':
      return 'Arabic'
    case 'hi':
      return 'Hindi'
    case 'ru':
      return 'Russian'
    case 'pt':
      return 'Portuguese'
    default:
      return 'Chinese'
  }
}

function normalizeTranslateGemmaLangCode(langCode: string): string {
  const normalized = normalizeLangCode(langCode)?.toLowerCase()
  if (!normalized) return 'en'
  if (normalized === 'zh' || normalized === 'zh-cn' || normalized === 'zh-hans') return 'zh-Hans'
  if (normalized === 'zh-hant' || normalized === 'zh-tw' || normalized === 'zh-hk') return 'zh-Hant'
  if (normalized === 'pt-br') return 'pt-BR'
  if (normalized === 'en-us') return 'en-US'
  if (normalized === 'en-gb') return 'en-GB'
  return normalized
}

function detectTranslateGemmaSourceLangCode(text: string): string {
  if (/[\u4e00-\u9fff]/.test(text)) return 'zh-Hans'
  if (/[\u0400-\u04ff]/.test(text)) return 'ru'
  if (/[\u0600-\u06ff]/.test(text)) return 'ar'
  if (/[\u0900-\u097f]/.test(text)) return 'hi'
  return 'en'
}

function buildTranslateGemmaUserPrompt(params: { text: string; sourceLangCode: string; targetLangCode: string }): string {
  const sourceName = langCodeToPromptName(params.sourceLangCode)
  const targetName = langCodeToPromptName(params.targetLangCode)
  return (
    `You are a professional ${sourceName} (${params.sourceLangCode}) to ${targetName} (${params.targetLangCode}) translator. ` +
    `Your goal is to accurately convey the meaning and nuances of the original ${sourceName} text while adhering to ${targetName} grammar, vocabulary, and cultural sensitivities.\n` +
    `Produce only the ${targetName} translation, without any additional explanations or commentary. Please translate the following ${sourceName} text into ${targetName}:\n\n\n` +
    `${params.text}`
  )
}

function stripEdgeNewlines(text: string): string {
  return text.replace(/^(?:\r?\n)+/, '').replace(/(?:\r?\n)+$/, '')
}

function chooseSamplingParams(params: { isTranslateGemma: boolean; isRetry: boolean; targetLangCode?: string }): {
  temperature: number
  top_p: number
  top_k: number
} {
  if (params.isTranslateGemma) {
    if (params.isRetry) return { temperature: 0.3, top_p: 0.95, top_k: 80 }
    return { temperature: 0.05, top_p: 0.9, top_k: 40 }
  }

  const isINeedTranslate = Boolean(params.targetLangCode)
  if (!isINeedTranslate) return { temperature: 0.3, top_p: 1, top_k: 0 }
  if (params.isRetry) return { temperature: 0.6, top_p: 0.95, top_k: 80 }
  return { temperature: 0.3, top_p: 0.9, top_k: 40 }
}
