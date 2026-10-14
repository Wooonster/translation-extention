import { getConfig, isUserLanguage, type UserLanguage } from '../lib/config'
import { isSingleVocabularyWord } from '../lib/language'
import { dlog, derr, initDebug } from '../lib/debug'
import {
  applySummary,
  clearSummary,
  deleteEntry,
  dismissSummaryNotice,
  entriesForSummary,
  loadMemory,
  markEntryError,
  markEntryReady,
  saveMemory,
  snoozeReview,
  upsertPendingEntry,
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
const TRANSIENT_FETCH_RETRY_LIMIT = 1

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
    handleFollowup(request.payload.query, request.payload.sourceText, request.payload.translatedText, request.payload.history)
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

  if (request.action === 'CLEAR_VOCAB_SUMMARY') {
    handleClearVocabSummary()
      .then(data => sendResponse({ status: 'success', data }))
      .catch(error => sendResponse({ status: 'error', error: errorMessage(error, 'Delete failed') }))
    return true
  }

  if (request.action === 'DISMISS_VOCAB_SUMMARY') {
    handleDismissVocabSummary()
      .then(data => sendResponse({ status: 'success', data }))
      .catch(error => sendResponse({ status: 'error', error: errorMessage(error, 'Dismiss failed') }))
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
    abortController?.abort()
    const controller = new AbortController()
    abortController = controller

    const streamHandlers = {
      signal: controller.signal,
      onStart: () => postMessage({ type: 'started' }),
      onDelta: (delta: string) => postMessage({ type: 'delta', delta }),
    }

    if (message?.action === 'START_TRANSLATE_STREAM') {
      handleTranslateStream(
        message.payload?.text,
        message.payload?.targetLangCode,
        message.payload?.attempt,
        {
          ...streamHandlers,
          onComplete: data => postMessage({ type: 'complete', data }),
        }
      ).catch((error: any) => {
        if (disconnected || controller.signal.aborted || error?.name === 'AbortError') return
        postMessage({ type: 'error', error: error?.message || 'Stream failed' })
      })
      return
    }

    if (message?.action === 'START_FOLLOWUP_STREAM') {
      handleFollowupStream(
        message.payload?.query,
        message.payload?.sourceText,
        message.payload?.translatedText,
        message.payload?.history,
        {
          ...streamHandlers,
          onComplete: data => postMessage({ type: 'complete', data }),
        }
      ).catch((error: any) => {
        if (disconnected || controller.signal.aborted || error?.name === 'AbortError') return
        postMessage({ type: 'error', error: error?.message || 'Stream failed' })
      })
      return
    }

    abortController = null
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
    const response = await fetchWithRetry(endpoint, {
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
    }, 'Preload request')

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

interface TextStreamOptions {
  signal?: AbortSignal
  onStart?: () => void
  onDelta?: (delta: string) => void
  onComplete?: (result: string) => void
}

interface ConversationTurn {
  query: string
  answer: string
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

    const response = await fetchWithRetry(endpoint, {
      method: 'POST',
      headers: buildRequestHeaders(config.apiKey),
      body: JSON.stringify({
        model: config.modelName,
        messages,
        temperature,
        top_p
      })
    }, 'Translation request')

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

  const response = await fetchWithRetry(endpoint, {
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
  }, 'Streaming translation request')

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

async function handleFollowup(
  query: string,
  sourceText: string,
  translatedText: string,
  history?: ConversationTurn[]
): Promise<string> {
  const normalizedQuery = String(query ?? '').trim()
  const normalizedSourceText = String(sourceText ?? '').trim()
  const normalizedTranslatedText = String(translatedText ?? '').trim()
  if (!normalizedQuery) throw new Error('Query is empty')

  const config = await getConfig()
  const endpoint = resolveChatCompletionsEndpoint(config.apiUrl)

  const isTranslateGemma = isTranslateGemmaModel(config.modelName)
  const hasTranslationContext = Boolean(normalizedSourceText && normalizedTranslatedText)
  const prompt = hasTranslationContext
    ? buildFollowupPrompt({
        query: normalizedQuery,
        sourceText: normalizedSourceText,
        translatedText: normalizedTranslatedText,
      })
    : normalizedQuery
  const historyMessages = buildConversationHistory(history)
  const messages = isTranslateGemma
    ? [...historyMessages, { role: 'user', content: prompt }]
    : [
        {
          role: 'system',
          content: hasTranslationContext
            ? 'You are a helpful bilingual assistant. Use the provided source and translation context to answer user follow-up questions.'
            : 'You are a concise, helpful assistant. Respond in the language used by the user unless they ask otherwise.',
        },
        ...historyMessages,
        { role: 'user', content: prompt },
      ]

  const response = await fetchWithRetry(endpoint, {
    method: 'POST',
    headers: buildRequestHeaders(config.apiKey),
    body: JSON.stringify({
      model: config.modelName,
      messages,
      temperature: 0.3,
      top_p: 0.95
    })
  }, 'Follow-up request')

  if (!response.ok) {
    await throwApiError(response)
  }

  const data = await response.json()
  const content = extractAssistantContent(data)
  if (!content) return 'No response returned.'
  return stripEdgeNewlines(content)
}

async function handleFollowupStream(
  query: string,
  sourceText: string,
  translatedText: string,
  history: ConversationTurn[] | undefined,
  options: TextStreamOptions = {}
): Promise<void> {
  const normalizedQuery = String(query ?? '').trim()
  const normalizedSourceText = String(sourceText ?? '').trim()
  const normalizedTranslatedText = String(translatedText ?? '').trim()
  if (!normalizedQuery) throw new Error('Query is empty')

  const config = await getConfig()
  const endpoint = resolveChatCompletionsEndpoint(config.apiUrl)
  const isTranslateGemma = isTranslateGemmaModel(config.modelName)
  const hasTranslationContext = Boolean(normalizedSourceText && normalizedTranslatedText)
  const prompt = hasTranslationContext
    ? buildFollowupPrompt({
        query: normalizedQuery,
        sourceText: normalizedSourceText,
        translatedText: normalizedTranslatedText,
      })
    : normalizedQuery
  const historyMessages = buildConversationHistory(history)
  const messages = isTranslateGemma
    ? [...historyMessages, { role: 'user', content: prompt }]
    : [
        {
          role: 'system',
          content: hasTranslationContext
            ? 'You are a helpful bilingual assistant. Use the provided source and translation context to answer user follow-up questions.'
            : 'You are a concise, helpful assistant. Respond in the language used by the user unless they ask otherwise.',
        },
        ...historyMessages,
        { role: 'user', content: prompt },
      ]

  const response = await fetchWithRetry(endpoint, {
    method: 'POST',
    headers: buildRequestHeaders(config.apiKey),
    body: JSON.stringify({
      model: config.modelName,
      messages,
      temperature: 0.3,
      top_p: 0.95,
      stream: true,
    }),
    signal: options.signal,
  }, 'Streaming follow-up request')

  if (!response.ok) {
    await throwApiError(response)
  }

  options.onStart?.()

  const contentType = response.headers.get('content-type') || ''
  if (contentType.includes('application/json')) {
    const data = await response.json()
    const result = stripEdgeNewlines(extractAssistantContent(data))
    if (result) options.onDelta?.(result)
    options.onComplete?.(result)
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

  options.onComplete?.(stripEdgeNewlines(rawContent))
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

async function handleClearVocabSummary(): Promise<{ cleared: true }> {
  await withMemoryLock(async () => {
    const memory = await loadMemory()
    await saveMemory(clearSummary(memory))
  })
  return { cleared: true }
}

async function handleDismissVocabSummary(): Promise<{ dismissed: true }> {
  await withMemoryLock(async () => {
    const memory = await loadMemory()
    await saveMemory(dismissSummaryNotice(memory))
  })
  return { dismissed: true }
}

async function handleEnrichVocab(payload: any): Promise<VocabEntry> {
  dlog('[Vocab] Enrich request')
  const config = await getConfig()
  const userLanguage = resolveRequestUserLanguage(payload?.userLanguage, config.userLanguage)
  const entry = await withMemoryLock(() => resolveEnrichEntry(payload))

  try {
    const endpoint = resolveChatCompletionsEndpoint(config.apiUrl)
    const prompt = buildEnrichPrompt({
      word: entry.word,
      sourceSentence: entry.sourceSentence,
      userLanguage,
    })
    const isTranslateGemma = isTranslateGemmaModel(config.modelName)
    const messages = isTranslateGemma
      ? [{ role: 'user', content: prompt }]
      : [
          { role: 'system', content: enrichSystemPrompt(userLanguage) },
          { role: 'user', content: prompt },
        ]

    const response = await fetchWithRetry(endpoint, {
      method: 'POST',
      headers: buildRequestHeaders(config.apiKey),
      body: JSON.stringify({
        model: config.modelName,
        messages,
        temperature: 0.1,
        top_p: 0.9,
      }),
    }, 'Enrichment request')

    if (!response.ok) await throwApiError(response, 'Enrichment failed')

    const data = await response.json()
    const parsed = parseEnrichmentJson(extractAssistantContent(data))
    if (!parsed.ipa && !parsed.translation && !parsed.userTranslation && !parsed.explanation) {
      throw new Error('Enrichment failed')
    }
    if (!isSingleVocabularyWord(entry.word)) parsed.partOfSpeech = ''

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
  const userLanguage = resolveRequestUserLanguage(payload?.userLanguage, config.userLanguage)
  const memory = await loadMemory()
  const picked = entriesForSummary(memory, 50)
  if (!picked.length) throw new Error('Vocabulary bank is empty')

  const endpoint = resolveChatCompletionsEndpoint(config.apiUrl)
  const prompt = buildSummaryPrompt({
    entries: picked,
    userLanguage,
    hasNewWords: memory.review.newSinceSummary > 0,
  })
  const isTranslateGemma = isTranslateGemmaModel(config.modelName)
  const messages = isTranslateGemma
    ? [{ role: 'user', content: prompt }]
    : [
        { role: 'system', content: summarySystemPrompt(userLanguage) },
        { role: 'user', content: prompt },
      ]

  const response = await fetchWithRetry(endpoint, {
    method: 'POST',
    headers: buildRequestHeaders(config.apiKey),
    body: JSON.stringify({
      model: config.modelName,
      messages,
      temperature: 0.3,
      top_p: 0.95,
    }),
  }, 'Summary request')

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

function resolveRequestUserLanguage(value: unknown, fallback: UserLanguage): UserLanguage {
  if (isUserLanguage(value)) return value
  return fallback
}

function enrichSystemPrompt(userLanguage: UserLanguage): string {
  if (userLanguage === 'zh') return '你是词汇助手。只输出严格 JSON，不要附加说明。'
  return 'You are a vocabulary assistant. Output strict JSON only, with no extra commentary.'
}

function summarySystemPrompt(userLanguage: UserLanguage): string {
  const languageName = langCodeToPromptName(userLanguage)
  if (userLanguage === 'zh') {
    return (
      '你帮助用户记住他们保存的词。这是记忆辅助，不是泛泛的内容摘要。' +
      '每个词都要给出三样东西：从原句抽出的简短回忆线索、该词在其原语言中的意思、以及中文意思。' +
      '摘要必须同时用原语言和中文书写，每个词用成对的两行，或明确标注的两半。' +
      '保持简短。这次总结里的每一个词都要能被认出来，不要写成把词埋进去的短文。'
    )
  }
  return (
    'You help the user remember words they saved. This is a memory aid, not a generic digest. ' +
    `For each word, give a short recall cue taken from its source sentence, the meaning in the word's original language, and the meaning in ${languageName}. ` +
    `Write the summary in both the original language and ${languageName}, as paired lines or clearly labeled halves. ` +
    'Stay brief. Every saved word in the summarized set must stay recognizable, not buried in an essay.'
  )
}

function buildEnrichPrompt(params: {
  word: string
  sourceSentence: string
  userLanguage: UserLanguage
}): string {
  const sentence = clipPromptText(params.sourceSentence, 1000)
  const languageName = langCodeToPromptName(params.userLanguage)
  const singleWord = isSingleVocabularyWord(params.word)
  if (params.userLanguage === 'zh') {
    const keys = singleWord
      ? '"ipa"、"translation"、"userTranslation"、"explanation"、"partOfSpeech"'
      : '"ipa"、"translation"、"userTranslation"、"explanation"'
    const partLine = singleWord
      ? '- partOfSpeech：这个单词的词性，用简短中文，例如名词、动词、形容词。\n'
      : ''
    return (
      '只输出严格 JSON，不要使用 markdown 代码块，不要附加任何其他文字。\n' +
      `JSON 必须只包含这些键：${keys}。\n` +
      `- ipa：国际音标读音。${singleWord ? '给这个单词的读音。' : '给整段词组的读音。'}\n` +
      '- translation：用该词自己的语言写一句简短释义，不要写成中文译文。\n' +
      '- userTranslation：将该词翻译成中文。\n' +
      '- explanation：结合原句，用中文简要解释这个词。\n' +
      partLine +
      '用户语言是中文。\n\n' +
      `${singleWord ? '单词' : '词条'}：${params.word}\n` +
      `原句：${sentence}`
    )
  }

  const keys = singleWord
    ? '"ipa", "translation", "userTranslation", "explanation", "partOfSpeech"'
    : '"ipa", "translation", "userTranslation", "explanation"'
  const partLine = singleWord
    ? `- partOfSpeech: a short part-of-speech label for this single word, such as noun, verb, or adjective, written in ${languageName}.\n`
    : ''
  return (
    'Reply with strict JSON only. Do not use markdown fences. Do not add any other text.\n' +
    `The JSON object must have exactly these keys: ${keys}.\n` +
    `- ipa: IPA pronunciation. ${singleWord ? 'Pronounce this single word.' : 'Pronounce the whole phrase.'}\n` +
    "- translation: a short gloss in the word's own language. Do not translate this field into the user language.\n" +
    `- userTranslation: translate the word into ${languageName}.\n` +
    `- explanation: a short explanation of the word in this sentence, written in ${languageName}.\n` +
    partLine +
    `The user language is ${languageName}.\n\n` +
    `${singleWord ? 'Word' : 'Phrase'}: ${params.word}\n` +
    `Source sentence: ${sentence}`
  )
}

function buildSummaryPrompt(params: {
  entries: VocabEntry[]
  userLanguage: UserLanguage
  hasNewWords: boolean
}): string {
  const languageName = langCodeToPromptName(params.userLanguage)
  const lines = params.entries.map((entry, index) => formatSummaryEntry(entry, index)).join('\n')
  if (params.userLanguage === 'zh') {
    const scope = params.hasNewWords
      ? '下面这些词是上次总结之后保存的。'
      : '下面是要记住的词，即使上次总结后没有新保存的词。'
    return (
      `${scope}\n` +
      '为每一个词写记忆提示，不要漏掉任何一个。每个词用成对的两行：一行用该词的原语言，一行用中文。' +
      '每行包含从原句抽出的简短回忆线索、原语言释义，以及中文释义。' +
      '条目里的 originalMeaning 是原语言释义，userMeaning 是用户语言译文；有内容时优先使用。' +
      '纯文本，不要表格，不要写成短文。\n\n' +
      `词条：\n${lines}`
    )
  }

  const scope = params.hasNewWords
    ? 'These words were saved since the last summary.'
    : 'These are the words to remember, even if nothing new was saved since the last summary.'
  return (
    `${scope}\n` +
    `The user language is ${languageName}. Write a memory aid that includes every word below. ` +
    `For each word, use paired lines or clearly labeled halves: one in the word's original language and one in ${languageName}. ` +
    `Each half gives a short recall cue from the source sentence, the original-language meaning, and the ${languageName} meaning. ` +
    'originalMeaning is the gloss in the word\'s own language, and userMeaning is the translation into the user language. Prefer them when present. ' +
    'Plain text, no tables, and no essay. Every word must stay recognizable.\n\n' +
    `Entries:\n${lines}`
  )
}

function formatSummaryEntry(entry: VocabEntry, index: number): string {
  const parts = [`word: ${entry.word}`]
  if (entry.ipa) parts.push(`ipa: ${entry.ipa}`)
  if (entry.translation) parts.push(`originalMeaning: ${entry.translation}`)
  if (entry.userTranslation) parts.push(`userMeaning: ${entry.userTranslation}`)
  if (entry.partOfSpeech) parts.push(`partOfSpeech: ${entry.partOfSpeech}`)
  if (entry.explanation) parts.push(`note: ${clipPromptText(entry.explanation, 180)}`)
  const sentence = clipPromptText(entry.sourceSentence.replace(/\s+/g, ' '), 280)
  if (sentence) parts.push(`sourceSentence: ${sentence}`)
  const otherSentences = (entry.sources ?? [])
    .map(source => clipPromptText(source.sentence.replace(/\s+/g, ' '), 280))
    .filter(text => text && text !== sentence)
  if (otherSentences.length) parts.push(`otherSentences: ${otherSentences.join(' / ')}`)
  return `${index + 1}. ${parts.join(' | ')}`
}

function clipPromptText(value: string, max: number): string {
  const trimmed = String(value ?? '').replace(/^\s+/, '').replace(/\s+$/, '')
  if (trimmed.length <= max) return trimmed
  return `${trimmed.slice(0, Math.max(0, max - 1))}…`
}

function parseEnrichmentJson(raw: string): { ipa: string; translation: string; userTranslation: string; explanation: string; partOfSpeech: string } {
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
    userTranslation: readJsonString(obj, ['userTranslation']),
    explanation: readJsonString(obj, ['explanation']),
    partOfSpeech: readJsonString(obj, ['partOfSpeech', 'part_of_speech', 'pos']),
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

function buildConversationHistory(
  history: ConversationTurn[] | undefined
): Array<{ role: 'user' | 'assistant'; content: string }> {
  if (!Array.isArray(history)) return []

  return history
    .filter(turn => turn && typeof turn.query === 'string' && typeof turn.answer === 'string')
    .slice(-12)
    .flatMap(turn => {
      const query = turn.query.trim()
      const answer = turn.answer.trim()
      if (!query || !answer) return []
      return [
        { role: 'user' as const, content: query },
        { role: 'assistant' as const, content: answer },
      ]
    })
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

async function fetchWithRetry(endpoint: string, init: RequestInit, requestLabel: string): Promise<Response> {
  let lastError: unknown

  for (let attempt = 0; attempt <= TRANSIENT_FETCH_RETRY_LIMIT; attempt += 1) {
    try {
      return await fetch(endpoint, init)
    } catch (error) {
      if (init.signal?.aborted) throw error
      lastError = error
      if (!isTransientFetchError(error) || attempt >= TRANSIENT_FETCH_RETRY_LIMIT) break
      await delay(250 * (attempt + 1))
    }
  }

  throw createReadableFetchError(endpoint, requestLabel, lastError)
}

function isTransientFetchError(error: unknown): boolean {
  const message = String((error as { message?: unknown })?.message ?? '')
  return /failed to fetch/i.test(message) || /networkerror/i.test(message)
}

function createReadableFetchError(endpoint: string, requestLabel: string, error: unknown): Error {
  const message = String((error as { message?: unknown })?.message ?? '').trim() || 'Failed to fetch'
  if (/failed to fetch/i.test(message) || /networkerror/i.test(message)) {
    return new Error(
      `${requestLabel} failed: unable to reach ${endpoint}. Check the API endpoint, model service, and network connection.`
    )
  }
  return new Error(`${requestLabel} failed: ${message}`)
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
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
