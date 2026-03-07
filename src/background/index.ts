import { getConfig } from '../lib/config'
import { dlog, derr, initDebug } from '../lib/debug'

initDebug()
dlog('Background service worker loaded.')

let keepAliveTimer: ReturnType<typeof setInterval> | null = null
const CACHE_PREFIX = 'translationCache:'
const CACHE_TTL_MS = 1000 * 60 * 60 * 24 * 7
const CACHE_MAX_ENTRIES = 300

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

  if (request.action === 'FOLLOWUP') {
    handleFollowup(request.payload.query, request.payload.sourceText, request.payload.translatedText)
      .then(result => sendResponse({ status: 'success', data: result }))
      .catch(error => sendResponse({ status: 'error', error: error.message }))
    return true
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
  const normalizedText = String(text ?? '').trim()
  if (!normalizedText) return ''
  
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
    const cacheKey = buildTranslationCacheKey({
      text: normalizedText,
      modelName: config.modelName,
      apiUrl: baseUrl,
      targetLangCode: normalizedTargetLangCode,
    })
    const cached = await getCachedTranslation(cacheKey)
    if (cached) return cached
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
              text: normalizedText,
              sourceLangCode: detectTranslateGemmaSourceLangCode(normalizedText),
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
              ? `Translate the following to ${langCodeToPromptName(normalizeTranslateGemmaLangCode(normalizedTargetLangCode ?? 'zh') ?? 'zh-Hans')}:\n\n${normalizedText}`
              : `Translate the following to Chinese:\n\n${normalizedText}`,
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
    const translated = stripEdgeNewlines(content)
    await setCachedTranslation(cacheKey, translated)
    return translated
  } catch (error: any) {
    derr('[AI Translate] Translation failed:', error)
    throw new Error(error.message || 'Network error')
  }
}

async function handleFollowup(query: string, sourceText: string, translatedText: string): Promise<string> {
  const normalizedQuery = String(query ?? '').trim()
  const normalizedSourceText = String(sourceText ?? '').trim()
  const normalizedTranslatedText = String(translatedText ?? '').trim()
  if (!normalizedQuery) throw new Error('Query is empty')
  if (!normalizedSourceText || !normalizedTranslatedText) throw new Error('Context is empty')

  const config = await getConfig()
  const baseUrl = config.apiUrl.replace(/\/$/, '')
  let endpoint = ''

  if (baseUrl.endsWith('/chat/completions')) endpoint = baseUrl
  else if (baseUrl.endsWith('/v1')) endpoint = `${baseUrl}/chat/completions`
  else endpoint = `${baseUrl}/v1/chat/completions`

  const isTranslateGemma = isTranslateGemmaModel(config.modelName)
  const prompt = buildFollowupPrompt({
    query: normalizedQuery,
    sourceText: normalizedSourceText,
    translatedText: normalizedTranslatedText,
  })
  const messages = isTranslateGemma
    ? [{ role: 'user', content: prompt }]
    : [
        { role: 'system', content: 'You are a helpful bilingual assistant. Use the provided source and translation context to answer user follow-up questions.' },
        { role: 'user', content: prompt },
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
      temperature: 0.3,
      top_p: 0.95,
      top_k: 60
    })
  })

  if (!response.ok) {
    throw new Error(`API Error: ${response.status} ${response.statusText}`)
  }

  const data = await response.json()
  const content = data.choices?.[0]?.message?.content
  if (!content) return 'No response returned.'
  return stripEdgeNewlines(content)
}

function buildTranslationCacheKey(params: {
  text: string
  modelName: string
  apiUrl: string
  targetLangCode?: string
}): string {
  const normalizedText = params.text.replace(/\s+/g, ' ').trim().toLowerCase()
  const normalizedTarget = normalizeLangCode(params.targetLangCode) ?? ''
  const source = `${params.modelName}|${params.apiUrl}|${normalizedTarget}|${normalizedText}`
  return `${CACHE_PREFIX}${hashString(source)}`
}

async function getCachedTranslation(cacheKey: string): Promise<string | null> {
  const result = await chrome.storage.local.get(cacheKey)
  const entry = result[cacheKey] as { value?: string; expiresAt?: number } | undefined
  if (!entry?.value || !entry.expiresAt) return null
  if (Date.now() > entry.expiresAt) {
    await chrome.storage.local.remove(cacheKey)
    return null
  }
  return entry.value
}

async function setCachedTranslation(cacheKey: string, value: string): Promise<void> {
  await chrome.storage.local.set({
    [cacheKey]: {
      value,
      expiresAt: Date.now() + CACHE_TTL_MS,
      updatedAt: Date.now(),
    },
  })
  if (Math.random() < 0.08) {
    await pruneTranslationCache()
  }
}

async function pruneTranslationCache(): Promise<void> {
  const all = await chrome.storage.local.get(null)
  const entries = Object.entries(all)
    .filter(([key]) => key.startsWith(CACHE_PREFIX))
    .map(([key, val]) => ({
      key,
      expiresAt: Number((val as any)?.expiresAt) || 0,
      updatedAt: Number((val as any)?.updatedAt) || 0,
    }))

  if (!entries.length) return

  const now = Date.now()
  const expiredKeys = entries.filter(e => e.expiresAt <= now).map(e => e.key)
  if (expiredKeys.length) await chrome.storage.local.remove(expiredKeys)

  const validEntries = entries.filter(e => e.expiresAt > now)
  if (validEntries.length <= CACHE_MAX_ENTRIES) return

  const toRemove = validEntries
    .sort((a, b) => a.updatedAt - b.updatedAt)
    .slice(0, validEntries.length - CACHE_MAX_ENTRIES)
    .map(e => e.key)
  if (toRemove.length) await chrome.storage.local.remove(toRemove)
}

function hashString(input: string): string {
  let h = 2166136261
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i)
    h += (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24)
  }
  return (h >>> 0).toString(36)
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

function buildFollowupPrompt(params: { query: string; sourceText: string; translatedText: string }): string {
  return (
    `User follow-up question:\n${params.query}\n\n` +
    `Original source text:\n${params.sourceText}\n\n` +
    `Translation result:\n${params.translatedText}\n\n` +
    'Please answer the follow-up question using both the source and the translation context. Keep the answer concise and practical.'
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
