import { getConfig } from '../lib/config'
import { dlog, derr, initDebug } from '../lib/debug'
import {
  applySummary,
  deleteEntry,
  entriesForSummary,
  loadMemory,
  markEntryError,
  markEntryReady,
  saveMemory,
  snoozeReview,
  upsertPendingEntry,
  type InterfaceLanguage,
  type SaveVocabInput,
  type VocabEntry,
  type VocabSummary,
} from '../lib/memory'

initDebug()
dlog('Background service worker loaded.')

let keepAliveTimer: ReturnType<typeof setInterval> | null = null
const CACHE_PREFIX = 'translationCache:'
const CACHE_TTL_MS = 1000 * 60 * 60 * 24 * 7
const CACHE_MAX_ENTRIES = 300

chrome.runtime.onInstalled.addListener(() => {
  dlog('浮译/Floator installed.')
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

  if (request.action === 'SAVE_VOCAB') {
    handleSaveVocab(request.payload)
      .then(data => sendResponse({ status: 'success', data }))
      .catch(error => sendResponse({ status: 'error', error: errorMessage(error, 'Save failed') }))
    return true
  }

  if (request.action === 'ENRICH_VOCAB') {
    handleEnrichVocab(request.payload)
      .then(data => sendResponse({ status: 'success', data }))
      .catch(error => sendResponse({ status: 'error', error: errorMessage(error, 'Enrichment failed') }))
    return true
  }

  if (request.action === 'SUMMARIZE_VOCAB') {
    handleSummarizeVocab(request.payload)
      .then(data => sendResponse({ status: 'success', data }))
      .catch(error => sendResponse({ status: 'error', error: errorMessage(error, 'Summary failed') }))
    return true
  }

  if (request.action === 'DELETE_VOCAB') {
    handleDeleteVocab(request.payload?.id)
      .then(data => sendResponse({ status: 'success', data }))
      .catch(error => sendResponse({ status: 'error', error: errorMessage(error, 'Delete failed') }))
    return true
  }

  if (request.action === 'SNOOZE_VOCAB_REVIEW') {
    handleSnoozeVocabReview()
      .then(data => sendResponse({ status: 'success', data }))
      .catch(error => sendResponse({ status: 'error', error: errorMessage(error, 'Snooze failed') }))
    return true
  }
})

chrome.runtime.onConnect.addListener(port => {
  if (port.name !== 'TRANSLATE_STREAM') return

  let disconnected = false
  let abortController: AbortController | null = null

  const postMessage = (message: Record<string, unknown>) => {
    if (disconnected) return
    try {
      port.postMessage(message)
    } catch {}
  }

  port.onDisconnect.addListener(() => {
    disconnected = true
    abortController?.abort()
    abortController = null
  })

  port.onMessage.addListener(message => {
    if (message?.action !== 'START_TRANSLATE_STREAM') return

    abortController?.abort()
    const controller = new AbortController()
    abortController = controller

    handleTranslateStream(
      message.payload?.text,
      message.payload?.targetLangCode,
      message.payload?.attempt,
      {
        signal: controller.signal,
        onStart: () => postMessage({ type: 'started' }),
        onDelta: delta => postMessage({ type: 'delta', delta }),
        onComplete: data => postMessage({ type: 'complete', data }),
      }
    ).catch((error: any) => {
      if (disconnected || controller.signal.aborted || error?.name === 'AbortError') return
      postMessage({ type: 'error', error: error?.message || 'Stream failed' })
    })
  })
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
  const endpoint = resolveChatCompletionsEndpoint(config.apiUrl)

  // Send a minimal request to trigger model loading
  // We use max_tokens: 1 to minimize generation time
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: buildRequestHeaders(config.apiKey),
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
      await throwApiError(response, 'Preload failed')
    }
    dlog('[AI Translate] Model preloaded successfully.')
  } catch (error: any) {
    derr('[AI Translate] Preload error:', error)
    throw error
  }
}

interface TranslateResponse {
  sourceLang?: string
  text: string
}

interface TranslateStreamOptions {
  signal?: AbortSignal
  onStart?: () => void
  onDelta?: (delta: string) => void
  onComplete?: (result: TranslateResponse) => void
}

async function handleTranslate(text: string, targetLangCode?: string, attempt?: number): Promise<TranslateResponse> {
  const config = await getConfig()
  const normalizedText = String(text ?? '').trim()
  if (!normalizedText) return { text: '' }
  const baseUrl = config.apiUrl.replace(/\/$/, '')
  const endpoint = resolveChatCompletionsEndpoint(config.apiUrl)
  
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
    if (cached) {
      try {
        const parsed = JSON.parse(cached)
        if (parsed.text) return parsed
      } catch {
        return { text: cached }
      }
    }
    const isRetry = Number.isFinite(Number(attempt)) && Number(attempt) > 1
    const { temperature, top_p } = chooseSamplingParams({
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
              ? 'You are a professional translation assistant. First detect the language of the source text. Then output the detected source language in the format "[Source: LanguageName]" followed by a newline, and then the translation result. Do not include any other explanations.'
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
      headers: buildRequestHeaders(config.apiKey),
      body: JSON.stringify({
        model: config.modelName,
        messages,
        temperature,
        top_p
      })
    })

    if (!response.ok) {
      await throwApiError(response)
    }

    const data = await response.json()
    const content = extractAssistantContent(data)
    if (!content) return { text: 'No translation returned.' }
    
    const result = parseTranslateResponse(content)
    await setCachedTranslation(cacheKey, JSON.stringify(result))
    return result
  } catch (error: any) {
    derr('[AI Translate] Translation failed:', error)
    throw new Error(error.message || 'Network error')
  }
}

async function handleTranslateStream(
  text: string,
  targetLangCode: string | undefined,
  attempt: number | undefined,
  options: TranslateStreamOptions = {}
): Promise<void> {
  const config = await getConfig()
  const normalizedText = String(text ?? '').trim()
  if (!normalizedText) {
    options.onStart?.()
    options.onComplete?.({ text: '' })
    return
  }

  const baseUrl = config.apiUrl.replace(/\/$/, '')
  const endpoint = resolveChatCompletionsEndpoint(config.apiUrl)
  const isTranslateGemma = isTranslateGemmaModel(config.modelName)
  const normalizedTargetLangCode = normalizeLangCode(targetLangCode)
  const cacheKey = buildTranslationCacheKey({
    text: normalizedText,
    modelName: config.modelName,
    apiUrl: baseUrl,
    targetLangCode: normalizedTargetLangCode,
  })
  const cached = await getCachedTranslation(cacheKey)
  if (cached) {
    const parsedCached = parseCachedTranslation(cached)
    options.onStart?.()
    if (parsedCached.text) options.onDelta?.(parsedCached.text)
    options.onComplete?.(parsedCached)
    return
  }

  const isRetry = Number.isFinite(Number(attempt)) && Number(attempt) > 1
  const { temperature, top_p } = chooseSamplingParams({
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
            ? 'You are a professional translation assistant. First detect the language of the source text. Then output the detected source language in the format "[Source: LanguageName]" followed by a newline, and then the translation result. Do not include any other explanations.'
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
    headers: buildRequestHeaders(config.apiKey),
    body: JSON.stringify({
      model: config.modelName,
      messages,
      temperature,
      top_p,
      stream: true,
    }),
    signal: options.signal,
  })

  if (!response.ok) {
    await throwApiError(response)
  }

  options.onStart?.()

  const contentType = response.headers.get('content-type') || ''
  if (contentType.includes('application/json')) {
    const data = await response.json()
    const result = parseTranslateResponse(extractAssistantContent(data))
    if (result.text) options.onDelta?.(result.text)
    options.onComplete?.(result)
    await setCachedTranslation(cacheKey, JSON.stringify(result))
    return
  }

  const reader = response.body?.getReader()
  if (!reader) throw new Error('Streaming response body unavailable')

  const decoder = new TextDecoder()
  let buffer = ''
  let rawContent = ''

  while (true) {
    const { value, done } = await reader.read()
    if (done) break

    buffer += decoder.decode(value, { stream: true })
    const consumed = consumeSseEvents(buffer)
    buffer = consumed.rest

    for (const event of consumed.events) {
      if (event === '[DONE]') {
        buffer = ''
        break
      }

      const delta = extractStreamDelta(event)
      if (!delta) continue
      rawContent += delta
      options.onDelta?.(delta)
    }
  }

  buffer += decoder.decode()
  const remaining = consumeSseEvents(buffer)
  for (const event of remaining.events) {
    if (event === '[DONE]') continue
    const delta = extractStreamDelta(event)
    if (!delta) continue
    rawContent += delta
    options.onDelta?.(delta)
  }

  const result = parseTranslateResponse(rawContent)
  options.onComplete?.(result)
  await setCachedTranslation(cacheKey, JSON.stringify(result))
}

async function handleFollowup(query: string, sourceText: string, translatedText: string): Promise<string> {
  const normalizedQuery = String(query ?? '').trim()
  const normalizedSourceText = String(sourceText ?? '').trim()
  const normalizedTranslatedText = String(translatedText ?? '').trim()
  if (!normalizedQuery) throw new Error('Query is empty')
  if (!normalizedSourceText || !normalizedTranslatedText) throw new Error('Context is empty')

  const config = await getConfig()
  const endpoint = resolveChatCompletionsEndpoint(config.apiUrl)

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
    headers: buildRequestHeaders(config.apiKey),
    body: JSON.stringify({
      model: config.modelName,
      messages,
      temperature: 0.3,
      top_p: 0.95
    })
  })

  if (!response.ok) {
    await throwApiError(response)
  }

  const data = await response.json()
  const content = extractAssistantContent(data)
  if (!content) return 'No response returned.'
  return stripEdgeNewlines(content)
}

let memoryQueue: Promise<void> = Promise.resolve()

function withMemoryLock<T>(task: () => Promise<T>): Promise<T> {
  const run = memoryQueue.then(task, task)
  memoryQueue = run.then(
    () => undefined,
    () => undefined
  )
  return run
}

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) return error.message
  return fallback
}

async function handleSaveVocab(payload: Partial<SaveVocabInput> | null | undefined): Promise<VocabEntry> {
  const saved = await withMemoryLock(async () => {
    const memory = await loadMemory()
    const next = upsertPendingEntry(memory, {
      word: typeof payload?.word === 'string' ? payload.word : '',
      sourceSentence: typeof payload?.sourceSentence === 'string' ? payload.sourceSentence : '',
      sourceUrl: typeof payload?.sourceUrl === 'string' ? payload.sourceUrl : '',
      sourceTitle: typeof payload?.sourceTitle === 'string' ? payload.sourceTitle : '',
    })
    if (!next) throw new Error('Word is empty')
    await saveMemory(next.memory)
    return next.entry
  })
  return saved
}

async function handleDeleteVocab(id: unknown): Promise<{ id: string }> {
  const entryId = typeof id === 'string' ? id : ''
  if (!entryId) throw new Error('Vocabulary entry not found')
  await withMemoryLock(async () => {
    const memory = await loadMemory()
    await saveMemory(deleteEntry(memory, entryId))
  })
  return { id: entryId }
}

async function handleSnoozeVocabReview() {
  return withMemoryLock(async () => {
    const memory = await loadMemory()
    const next = snoozeReview(memory)
    await saveMemory(next)
    return next.review
  })
}

async function handleEnrichVocab(payload: any): Promise<VocabEntry> {
  dlog('[Vocab] Enrich request')
  const config = await getConfig()
  const interfaceLanguage = resolveInterfaceLanguage(payload?.interfaceLanguage, config.interfaceLanguage)
  const entry = await withMemoryLock(() => resolveEnrichEntry(payload))

  try {
    const endpoint = resolveChatCompletionsEndpoint(config.apiUrl)
    const prompt = buildEnrichPrompt({
      word: entry.word,
      sourceSentence: entry.sourceSentence,
      interfaceLanguage,
    })
    const isTranslateGemma = isTranslateGemmaModel(config.modelName)
    const messages = isTranslateGemma
      ? [{ role: 'user', content: prompt }]
      : [
          { role: 'system', content: enrichSystemPrompt(interfaceLanguage) },
          { role: 'user', content: prompt },
        ]

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: buildRequestHeaders(config.apiKey),
      body: JSON.stringify({
        model: config.modelName,
        messages,
        temperature: 0.1,
        top_p: 0.9,
      }),
    })

    if (!response.ok) await throwApiError(response, 'Enrichment failed')

    const data = await response.json()
    const parsed = parseEnrichmentJson(extractAssistantContent(data))
    if (!parsed.ipa && !parsed.translation && !parsed.explanation) {
      throw new Error('Enrichment failed')
    }

    const updated = await withMemoryLock(async () => {
      const memory = await loadMemory()
      const next = markEntryReady(memory, entry.id, parsed)
      if (!next.entry) throw new Error('Vocabulary entry not found')
      await saveMemory(next.memory)
      return next.entry
    })
    return updated
  } catch (error) {
    derr('[Vocab] Enrichment failed')
    await withMemoryLock(async () => {
      const memory = await loadMemory()
      const next = markEntryError(memory, entry.id)
      if (!next.entry) return
      await saveMemory(next.memory)
    }).catch(() => {})
    throw error
  }
}

async function resolveEnrichEntry(payload: any): Promise<VocabEntry> {
  const memory = await loadMemory()
  const id = typeof payload?.id === 'string' ? payload.id : ''
  if (id) {
    const found = memory.entries.find(item => item.id === id)
    if (found) return found
  }

  const word = typeof payload?.word === 'string' ? payload.word : ''
  const saved = upsertPendingEntry(memory, {
    word,
    sourceSentence: typeof payload?.sourceSentence === 'string' ? payload.sourceSentence : word,
    sourceUrl: typeof payload?.sourceUrl === 'string' ? payload.sourceUrl : '',
    sourceTitle: typeof payload?.sourceTitle === 'string' ? payload.sourceTitle : '',
  })
  if (!saved) throw new Error('Vocabulary entry not found')
  await saveMemory(saved.memory)
  return saved.entry
}

async function handleSummarizeVocab(payload: any): Promise<VocabSummary> {
  dlog('[Vocab] Summary request')
  const config = await getConfig()
  const interfaceLanguage = resolveInterfaceLanguage(payload?.interfaceLanguage, config.interfaceLanguage)
  const memory = await loadMemory()
  const picked = entriesForSummary(memory, 50)
  if (!picked.length) throw new Error('Vocabulary bank is empty')

  const endpoint = resolveChatCompletionsEndpoint(config.apiUrl)
  const prompt = buildSummaryPrompt({
    entries: picked,
    interfaceLanguage,
    hasNewWords: memory.review.newSinceSummary > 0,
  })
  const isTranslateGemma = isTranslateGemmaModel(config.modelName)
  const messages = isTranslateGemma
    ? [{ role: 'user', content: prompt }]
    : [
        { role: 'system', content: summarySystemPrompt(interfaceLanguage) },
        { role: 'user', content: prompt },
      ]

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: buildRequestHeaders(config.apiKey),
    body: JSON.stringify({
      model: config.modelName,
      messages,
      temperature: 0.3,
      top_p: 0.95,
    }),
  })

  if (!response.ok) await throwApiError(response, 'Summary failed')

  const data = await response.json()
  const text = parseSummaryText(extractAssistantContent(data))
  if (!text) throw new Error('Summary failed')

  const stored = await withMemoryLock(async () => {
    const latest = await loadMemory()
    const next = applySummary(latest, text, picked.map(entry => entry.id))
    await saveMemory(next.memory)
    return next.summary
  })
  return stored
}

function resolveInterfaceLanguage(value: unknown, fallback: InterfaceLanguage): InterfaceLanguage {
  if (value === 'zh' || value === 'en') return value
  return fallback === 'zh' ? 'zh' : 'en'
}

function enrichSystemPrompt(interfaceLanguage: InterfaceLanguage): string {
  if (interfaceLanguage === 'zh') return '你是词汇助手。只输出严格 JSON，不要附加说明。'
  return 'You are a vocabulary assistant. Output strict JSON only, with no extra commentary.'
}

function summarySystemPrompt(interfaceLanguage: InterfaceLanguage): string {
  if (interfaceLanguage === 'zh') return '你是词汇复习助手。用中文写一段简短、可执行的复习摘要。'
  return 'You are a vocabulary review assistant. Write a short, practical study digest.'
}

function buildEnrichPrompt(params: {
  word: string
  sourceSentence: string
  interfaceLanguage: InterfaceLanguage
}): string {
  const sentence = clipPromptText(params.sourceSentence, 1000)
  if (params.interfaceLanguage === 'zh') {
    return (
      '只输出严格 JSON，不要使用 markdown 代码块，不要附加任何其他文字。\n' +
      'JSON 必须只包含这三个键："ipa"、"translation"、"explanation"。\n' +
      '- ipa：所保存单词本身的国际音标读音。\n' +
      '- translation：将该词翻译成中文。\n' +
      '- explanation：结合原句，用中文简要解释这个词。\n\n' +
      `单词：${params.word}\n` +
      `原句：${sentence}`
    )
  }

  return (
    'Reply with strict JSON only. Do not use markdown fences. Do not add any other text.\n' +
    'The JSON object must have exactly these keys: "ipa", "translation", "explanation".\n' +
    '- ipa: IPA pronunciation of the saved word itself.\n' +
    '- translation: translate the word into English.\n' +
    '- explanation: a short English explanation of the word in this sentence.\n\n' +
    `Word: ${params.word}\n` +
    `Source sentence: ${sentence}`
  )
}

function buildSummaryPrompt(params: {
  entries: VocabEntry[]
  interfaceLanguage: InterfaceLanguage
  hasNewWords: boolean
}): string {
  const lines = params.entries.map((entry, index) => formatSummaryEntry(entry, index)).join('\n')
  if (params.interfaceLanguage === 'zh') {
    const scope = params.hasNewWords
      ? '下面这些词是上次总结之后保存的。'
      : '用户希望总结整本词库，即使上次总结后没有新词。'
    return (
      `${scope}\n` +
      '请用中文写一段简短的复习摘要：把相关的词放在一起，点出易混之处，并建议接下来复习什么。纯文本，不要表格，控制在 180 字以内。\n\n' +
      `词条：\n${lines}`
    )
  }

  const scope = params.hasNewWords
    ? 'These entries were saved since the last summary.'
    : 'The learner asked for a summary of the whole bank, even if nothing new was saved since the last summary.'
  return (
    `${scope}\n` +
    'Write a short study digest: group related words, note easy mix-ups, and suggest what to review next. Plain text, no tables, under 180 words.\n\n' +
    `Entries:\n${lines}`
  )
}

function formatSummaryEntry(entry: VocabEntry, index: number): string {
  const parts = [entry.word]
  if (entry.ipa) parts.push(entry.ipa)
  if (entry.translation) parts.push(entry.translation)
  if (entry.explanation) parts.push(clipPromptText(entry.explanation, 180))
  const sentence = clipPromptText(entry.sourceSentence.replace(/\s+/g, ' '), 280)
  if (sentence) parts.push(sentence)
  return `${index + 1}. ${parts.join(' — ')}`
}

function clipPromptText(value: string, max: number): string {
  const trimmed = String(value ?? '').replace(/^\s+/, '').replace(/\s+$/, '')
  if (trimmed.length <= max) return trimmed
  return `${trimmed.slice(0, Math.max(0, max - 1))}…`
}

function parseEnrichmentJson(raw: string): { ipa: string; translation: string; explanation: string } {
  const text = extractJsonObject(stripJsonFences(raw))
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('Enrichment failed')
  }
  if (Array.isArray(parsed)) {
    parsed = parsed.find(item => item && typeof item === 'object' && !Array.isArray(item))
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Enrichment failed')
  const obj = parsed as Record<string, unknown>
  return {
    ipa: readJsonString(obj, ['ipa']),
    translation: readJsonString(obj, ['translation']),
    explanation: readJsonString(obj, ['explanation']),
  }
}

function parseSummaryText(raw: string): string {
  const stripped = stripJsonFences(raw).trim()
  if (stripped.startsWith('{') && stripped.endsWith('}')) {
    try {
      const parsed = JSON.parse(stripped) as Record<string, unknown>
      const value = parsed.text || parsed.summary || parsed.digest
      if (typeof value === 'string' && value.trim()) return value.trim()
    } catch {
      // The model returned prose that only looks like a brace-wrapped block.
    }
  }
  return stripped
}

function stripJsonFences(raw: string): string {
  let text = String(raw ?? '').trim()
  const fenced = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)
  if (fenced) return fenced[1].trim()
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '')
  return text.trim()
}

function extractJsonObject(text: string): string {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start >= 0 && end > start) return text.slice(start, end + 1)
  return text
}

function readJsonString(obj: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = obj[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  const lowered = new Map(Object.entries(obj).map(([key, value]) => [key.toLowerCase(), value]))
  for (const key of keys) {
    const value = lowered.get(key.toLowerCase())
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
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

function parseTranslateResponse(content: string): TranslateResponse {
  const sourceMatch = content.match(/^\[Source:\s*([^\]]+)\]\s*([\s\S]*)$/i)
  if (sourceMatch) {
    return {
      sourceLang: sourceMatch[1].trim(),
      text: stripEdgeNewlines(sourceMatch[2]),
    }
  }
  return { sourceLang: '', text: stripEdgeNewlines(content) }
}

function parseCachedTranslation(cached: string): TranslateResponse {
  try {
    const parsed = JSON.parse(cached)
    if (parsed && typeof parsed === 'object') {
      return {
        sourceLang: typeof parsed.sourceLang === 'string' ? parsed.sourceLang : '',
        text: typeof parsed.text === 'string' ? parsed.text : '',
      }
    }
  } catch {}
  return { text: cached }
}

function chooseSamplingParams(params: { isTranslateGemma: boolean; isRetry: boolean; targetLangCode?: string }): {
  temperature: number
  top_p: number
} {
  if (params.isTranslateGemma) {
    if (params.isRetry) return { temperature: 0.3, top_p: 0.95 }
    return { temperature: 0.05, top_p: 0.9 }
  }

  const isINeedTranslate = Boolean(params.targetLangCode)
  if (!isINeedTranslate) return { temperature: 0.3, top_p: 1 }
  if (params.isRetry) return { temperature: 0.6, top_p: 0.95 }
  return { temperature: 0.3, top_p: 0.9 }
}

function resolveChatCompletionsEndpoint(apiUrl: string): string {
  const baseUrl = String(apiUrl ?? '').trim().replace(/\/$/, '')
  if (!baseUrl) return '/v1/chat/completions'
  if (baseUrl.endsWith('/chat/completions')) return baseUrl
  if (/\/v\d+(?:\.\d+)?$/i.test(baseUrl)) return `${baseUrl}/chat/completions`
  return `${baseUrl}/v1/chat/completions`
}

function buildRequestHeaders(apiKey?: string): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  const normalizedKey = String(apiKey || '').trim()
  if (normalizedKey) headers.Authorization = `Bearer ${normalizedKey}`
  return headers
}

async function throwApiError(response: Response, prefix = 'API Error'): Promise<never> {
  let detail = ''

  try {
    const data = await response.json()
    detail = data?.error?.message || data?.message || data?.msg || ''
  } catch {
    try {
      detail = (await response.text()).trim()
    } catch {
      detail = ''
    }
  }

  const suffix = detail ? ` - ${detail}` : ''
  throw new Error(`${prefix}: ${response.status} ${response.statusText}${suffix}`)
}

function extractAssistantContent(data: any): string {
  const content = data?.choices?.[0]?.message?.content
  if (typeof content === 'string') return stripEdgeNewlines(content)

  if (Array.isArray(content)) {
    const merged = content
      .map(part => {
        if (typeof part === 'string') return part
        if (typeof part?.text === 'string') return part.text
        return ''
      })
      .filter(Boolean)
      .join('\n')
      .trim()
    if (merged) return stripEdgeNewlines(merged)
  }

  const fallback =
    data?.choices?.[0]?.text ||
    data?.output_text ||
    data?.data?.output_text ||
    ''
  return typeof fallback === 'string' ? stripEdgeNewlines(fallback) : ''
}

function consumeSseEvents(buffer: string): { events: string[]; rest: string } {
  const events: string[] = []
  let rest = buffer

  while (true) {
    const match = rest.match(/\r?\n\r?\n/)
    if (!match || match.index == null) break

    const rawEvent = rest.slice(0, match.index)
    rest = rest.slice(match.index + match[0].length)

    const data = rawEvent
      .split(/\r?\n/)
      .filter(line => line.startsWith('data:'))
      .map(line => line.slice(5).trimStart())
      .join('\n')

    if (data) events.push(data)
  }

  return { events, rest }
}

function extractStreamDelta(event: string): string {
  try {
    const data = JSON.parse(event)
    const content = data?.choices?.[0]?.delta?.content
    if (typeof content === 'string') return content

    if (Array.isArray(content)) {
      return content
        .map((part: any) => {
          if (typeof part === 'string') return part
          if (typeof part?.text === 'string') return part.text
          return ''
        })
        .join('')
    }

    const fallback =
      data?.choices?.[0]?.text ||
      data?.output_text ||
      data?.data?.output_text ||
      ''
    return typeof fallback === 'string' ? fallback : ''
  } catch {
    return ''
  }
}
