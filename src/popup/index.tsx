import React, { useEffect, useRef, useState } from 'react'
import ReactDOM from 'react-dom/client'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  DEFAULT_CONFIG,
  HOVER_DURATION_DEFAULT_MS,
  HOVER_DURATION_MAX_MS,
  HOVER_DURATION_MIN_MS,
  USER_LANGUAGE_ENDONYM,
  USER_LANGUAGES,
  getConfig,
  interfaceLanguageFor,
  isUserLanguage,
  saveConfig,
  textDirectionFor,
  type ApiProvider,
  type AppConfig,
  type InterfaceSide,
  type ProviderConfig,
  type UserLanguage,
} from '../lib/config'
import { getLanguageName, getTranslation } from '../lib/i18n'
import {
  MEMORY_STORAGE_KEY,
  emptyMemory,
  isReviewThresholdMet,
  rankEntries,
  shouldShowReviewNotice,
  loadMemory,
  sanitizeMemory,
  serializeMemory,
  type FloatorMemory,
} from '../lib/memory'
import '../index.css'

const STAMP_LOCALE: Record<UserLanguage, string> = {
  en: 'en',
  zh: 'zh-CN',
  fr: 'fr',
  de: 'de',
  es: 'es',
  ar: 'ar',
  hi: 'hi',
  ru: 'ru',
  pt: 'pt',
}

const languageChoiceLabel = (code: UserLanguage, interfaceLanguage: UserLanguage) => {
  const endonym = USER_LANGUAGE_ENDONYM[code]
  const localized = getLanguageName(code, interfaceLanguage)
  return localized === endonym ? endonym : `${endonym} · ${localized}`
}

const API_PROVIDER_TABS: ApiProvider[] = ['lmApiServer', 'lmStudio', 'ollama']
const POPUP_WORKSPACE_KEY = 'popupWorkspaceV1'
const POPUP_WORKSPACE_TTL_MS = 10 * 60 * 1000

interface PopupConversationTurn {
  query: string
  answer: string
}

interface PopupWorkspace {
  needText: string
  needTargetLangCode: string
  needResult: string
  needResultSourceText: string
  needResultTargetLangCode: string
  followupQuery: string
  followupHistory: PopupConversationTurn[]
  activeResultView: 'translation' | 'conversation'
  useTranslationContext: boolean
  targetOverridden: boolean
}

interface StoredPopupWorkspace extends PopupWorkspace {
  expiresAt: number
}

const DEFAULT_POPUP_WORKSPACE: PopupWorkspace = {
  needText: '',
  needTargetLangCode: 'zh',
  needResult: '',
  needResultSourceText: '',
  needResultTargetLangCode: 'zh',
  followupQuery: '',
  followupHistory: [],
  activeResultView: 'translation',
  useTranslationContext: false,
  targetOverridden: false,
}

const sanitizePopupWorkspace = (raw: unknown, fallbackTarget: UserLanguage): PopupWorkspace => {
  const workspace = typeof raw === 'object' && raw !== null ? raw as Partial<PopupWorkspace> : {}
  const targetLanguageExists = isUserLanguage(workspace.needTargetLangCode)
  const resultLanguageExists = isUserLanguage(workspace.needResultTargetLangCode)
  const followupHistory = Array.isArray(workspace.followupHistory)
    ? workspace.followupHistory
        .filter(item => item && typeof item.query === 'string' && typeof item.answer === 'string')
        .map(item => ({ query: item.query, answer: item.answer }))
    : []

  return {
    needText: typeof workspace.needText === 'string' ? workspace.needText : '',
    needTargetLangCode: targetLanguageExists ? workspace.needTargetLangCode! : fallbackTarget,
    needResult: typeof workspace.needResult === 'string' ? workspace.needResult : '',
    needResultSourceText: typeof workspace.needResultSourceText === 'string' ? workspace.needResultSourceText : '',
    needResultTargetLangCode: resultLanguageExists ? workspace.needResultTargetLangCode! : fallbackTarget,
    followupQuery: typeof workspace.followupQuery === 'string' ? workspace.followupQuery : '',
    followupHistory,
    activeResultView: workspace.activeResultView === 'conversation' ? 'conversation' : 'translation',
    useTranslationContext: workspace.useTranslationContext === true && Boolean(workspace.needResult),
    targetOverridden: workspace.targetOverridden === true,
  }
}

const getFreshPopupWorkspace = (raw: unknown, fallbackTarget: UserLanguage): PopupWorkspace | null => {
  if (typeof raw !== 'object' || raw === null) return null
  const expiresAt = (raw as Partial<StoredPopupWorkspace>).expiresAt
  if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) return null
  return sanitizePopupWorkspace(raw, fallbackTarget)
}

const copyTextToClipboard = async (text: string): Promise<boolean> => {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {}

  const el = document.createElement('textarea')
  el.value = text
  el.setAttribute('readonly', 'true')
  el.style.position = 'fixed'
  el.style.left = '-9999px'
  document.body.appendChild(el)
  el.select()
  const ok = document.execCommand('copy')
  document.body.removeChild(el)
  return ok
}

const API_PROVIDER_PLACEHOLDERS: Record<ApiProvider, { endpoint: string; apiKey: string; modelName: string }> = {
  lmApiServer: {
    endpoint: 'https://openrouter.ai/api/v1',
    apiKey: '<your-api-key>',
    modelName: 'openrouter/free',
  },
  lmStudio: {
    endpoint: 'http://127.0.0.1:1234/v1',
    apiKey: 'lm-studio',
    modelName: 'local-model',
  },
  ollama: {
    endpoint: 'http://127.0.0.1:11434/v1',
    apiKey: 'ollama',
    modelName: 'qwen2.5:7b-instruct',
  },
}

function safeHttpUrl(value: string): string | null {
  try {
    const url = new URL(value)
    if (url.protocol === 'http:' || url.protocol === 'https:') return url.toString()
  } catch {
    return null
  }
  return null
}

function markdownText(value: string): string {
  return value.replace(/[\\`*_{}[\]()#+\-!|>]/g, match => `\\${match}`)
}

function pronunciation(ipa: string): string {
  const bare = ipa.trim().replace(/^\/+|\/+$/g, '')
  return bare ? `/${bare}/` : ''
}

function markdownLink(label: string, href: string): string {
  return `[${markdownText(label)}](${href.replace(/\)/g, '%29')})`
}

function buildReviewMarkdown(input: {
  title: string
  date: string
  memoryHeading: string
  originalLabel: string
  userLabel: string
  summary: NonNullable<FloatorMemory['review']['latestSummary']>
  entries: FloatorMemory['entries']
}): string {
  const byId = new Map(input.entries.map(entry => [entry.id, entry]))
  const sections = input.summary.entryIds.flatMap(id => {
    const entry = byId.get(id)
    if (!entry) return []
    const lines = [`## ${markdownText(entry.word)}`, '']
    const spoken = pronunciation(entry.ipa)
    if (spoken) lines.push(markdownText(spoken), '')
    if (entry.partOfSpeech) lines.push(markdownText(entry.partOfSpeech), '')
    if (entry.translation) lines.push(`**${markdownText(input.originalLabel)}**`, '', markdownText(entry.translation), '')
    if (entry.userTranslation) lines.push(`**${markdownText(input.userLabel)}**`, '', markdownText(entry.userTranslation), '')
    if (entry.sourceSentence) lines.push(`> ${markdownText(entry.sourceSentence).replace(/\n/g, '\n> ')}`, '')
    const links = (entry.sources ?? []).flatMap(source => {
      const href = safeHttpUrl(source.url)
      if (!href) return []
      return [markdownLink(source.title || source.url, href)]
    })
    if (links.length) lines.push(links.map(link => `- ${link}`).join('\n'), '')
    return [lines.join('\n').trim()]
  })

  const parts = [`# ${markdownText(input.title)}`, '', input.date]
  if (sections.length) parts.push('', sections.join('\n\n'))
  parts.push('', '---', '', `## ${markdownText(input.memoryHeading)}`, '', input.summary.text.trim(), '')
  return parts.join('\n')
}

function formatStamp(iso: string, lang: UserLanguage): string {
  const time = Date.parse(iso)
  if (!Number.isFinite(time)) return ''
  return new Date(time).toLocaleString(STAMP_LOCALE[lang])
}

function BankPanel({
  memory,
  userLanguage,
  interfaceLanguage,
  t,
}: {
  memory: FloatorMemory
  userLanguage: UserLanguage
  interfaceLanguage: UserLanguage
  t: ReturnType<typeof getTranslation>
}) {
  const [busyId, setBusyId] = useState<string | null>(null)
  const [summaryBusy, setSummaryBusy] = useState(false)
  const [clearingSummary, setClearingSummary] = useState(false)
  const [message, setMessage] = useState('')
  const [summaryExpanded, setSummaryExpanded] = useState(false)
  const [askedVisible, setAskedVisible] = useState(false)
  const [sessionHidden, setSessionHidden] = useState(false)
  const summaryEpisode = memory.review.oldestUnreviewedAt
  const episodeRef = useRef(summaryEpisode)
  useEffect(() => {
    if (episodeRef.current === summaryEpisode) return
    episodeRef.current = summaryEpisode
    setSessionHidden(false)
  }, [summaryEpisode])

  const downloadJson = () => {
    const blob = new Blob([serializeMemory(memory)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = 'floator-memory.json'
    document.body.appendChild(link)
    link.click()
    link.remove()
    window.setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  const downloadSummaryMarkdown = (summary: FloatorMemory['review']['latestSummary']) => {
    if (!summary) return
    const markdown = buildReviewMarkdown({
      title: t.popup.bankReviewTitle,
      date: formatStamp(summary.createdAt, interfaceLanguage),
      memoryHeading: t.popup.bankReviewMemory,
      originalLabel: t.popup.bankOriginalMeaning,
      userLabel: t.popup.bankUserMeaning,
      summary,
      entries: memory.entries,
    })
    const day = summary.createdAt.slice(0, 10).replace(/[^\d-]/g, '') || 'review'
    const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `floator-review-${day}.md`
    document.body.appendChild(link)
    link.click()
    link.remove()
    window.setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  const retryEntry = async (id: string) => {
    setBusyId(id)
    setMessage('')
    try {
      const response = await chrome.runtime.sendMessage({
        action: 'ENRICH_VOCAB',
        payload: { id, userLanguage },
      })
      if (response?.status !== 'success') setMessage(response?.error || t.popup.bankError)
    } catch (error: unknown) {
      setMessage(error instanceof Error ? error.message : t.popup.bankError)
    } finally {
      setBusyId(null)
    }
  }

  const removeEntry = async (id: string) => {
    setBusyId(id)
    setMessage('')
    try {
      const response = await chrome.runtime.sendMessage({
        action: 'DELETE_VOCAB',
        payload: { id },
      })
      if (response?.status !== 'success') setMessage(response?.error || t.popup.bankDelete)
    } catch (error: unknown) {
      setMessage(error instanceof Error ? error.message : t.popup.bankDelete)
    } finally {
      setBusyId(null)
    }
  }

  const summarize = async () => {
    if (!memory.entries.length) {
      setMessage(t.popup.bankEmptySummary)
      return
    }
    setSummaryBusy(true)
    setMessage('')
    try {
      const response = await chrome.runtime.sendMessage({
        action: 'SUMMARIZE_VOCAB',
        payload: { userLanguage },
      })
      if (response?.status !== 'success') setMessage(response?.error || t.popup.bankSummaryFailed)
      else {
        setAskedVisible(true)
        setSessionHidden(false)
        setSummaryExpanded(true)
      }
    } catch (error: unknown) {
      setMessage(error instanceof Error ? error.message : t.popup.bankSummaryFailed)
    } finally {
      setSummaryBusy(false)
    }
  }

  const deleteSummary = async () => {
    if (!memory.review.latestSummary) return
    setClearingSummary(true)
    setMessage('')
    try {
      const response = await chrome.runtime.sendMessage({ action: 'CLEAR_VOCAB_SUMMARY' })
      if (response?.status !== 'success') setMessage(response?.error || t.popup.bankDeleteSummaryFailed)
    } catch (error: unknown) {
      setMessage(error instanceof Error ? error.message : t.popup.bankDeleteSummaryFailed)
    } finally {
      setClearingSummary(false)
    }
  }

  const summary = memory.review.latestSummary
  const summaryWhen = summary ? formatStamp(summary.createdAt, interfaceLanguage) : ''
  const summaryLocked = summaryBusy || clearingSummary
  const reminderDue = shouldShowReviewNotice(memory)
  const dismissedEpisode = Boolean(summaryEpisode && memory.review.summaryDismissedFor === summaryEpisode)
  const showSummary = Boolean(summary) && !sessionHidden && (askedVisible || (reminderDue && !dismissedEpisode))

  const dismissSummary = async () => {
    setSessionHidden(true)
    setAskedVisible(false)
    setSummaryExpanded(false)
    try {
      await chrome.runtime.sendMessage({ action: 'DISMISS_VOCAB_SUMMARY' })
    } catch {
      setMessage(t.popup.bankSummaryDismiss)
    }
  }

  const ranked = rankEntries(memory.entries)

  return (
    <div className="popup-bank">
      <header className="popup-bank-overview">
        <h2 className="popup-bank-count">{t.popup.bankSavedCount.replace('{count}', String(ranked.length))}</h2>
        <div className="popup-bank-toolbar">
          <button type="button" className="popup-action-primary" onClick={() => void summarize()} disabled={summaryLocked}>
            {summaryBusy ? t.popup.bankSummarizing : t.popup.bankSummarize}
          </button>
          <button type="button" className="popup-action-secondary" onClick={downloadJson}>
            {t.popup.bankDownload}
          </button>
        </div>
      </header>
      {message && <p className="popup-bank-message">{message}</p>}

      {showSummary && summary && (
        <div className="popup-bank-reminder">
          <button
            type="button"
            className="popup-bank-reminder-line"
            aria-expanded={summaryExpanded}
            onClick={() => setSummaryExpanded(open => !open)}
          >
            <span>{t.popup.bankSummaryRemind}</span>
            {summaryWhen && <time dateTime={summary.createdAt}>{summaryWhen}</time>}
          </button>
          <span className="popup-bank-reminder-actions">
            <button type="button" className="popup-action-secondary popup-bank-mini" onClick={() => downloadSummaryMarkdown(summary)}>
              {t.popup.bankSummaryMarkdown}
            </button>
            <button type="button" className="popup-bank-quiet" onClick={() => void dismissSummary()}>
              {t.popup.bankSummaryDismiss}
            </button>
          </span>
          {summaryExpanded && (
            <div className="popup-bank-reminder-body">
              <div className="popup-bank-summary">{summary.text}</div>
              <button
                type="button"
                className="popup-bank-quiet"
                onClick={() => void deleteSummary()}
                disabled={summaryLocked}
              >
                {t.popup.bankDeleteSummary}
              </button>
            </div>
          )}
        </div>
      )}

      {ranked.length === 0 ? (
        <p className="popup-bank-empty">{t.popup.bankEmpty}</p>
      ) : (
        <ol className="popup-bank-list">
          {ranked.map(entry => (
            <li key={entry.id} className="popup-bank-row">
              <div className="popup-bank-row-title">
                <h3 className="popup-bank-word">
                  {entry.word}
                  {pronunciation(entry.ipa) ? <span className="popup-bank-ipa">{pronunciation(entry.ipa)}</span> : null}
                  {entry.partOfSpeech ? <span className="popup-bank-pos">{entry.partOfSpeech}</span> : null}
                </h3>
                <span className="popup-bank-times">{t.popup.bankAddCount.replace('{count}', String(entry.addCount || 1))}</span>
                {entry.status !== 'ready' && (
                  <span className="popup-bank-status" data-status={entry.status}>
                    {entry.status === 'error' ? t.popup.bankError : t.popup.bankPending}
                  </span>
                )}
              </div>
              <p className="popup-bank-meaning">
                <span>{t.popup.bankOriginalMeaning}</span>
                {entry.translation || '—'}
              </p>
              <p className="popup-bank-meaning popup-bank-meaning--user">
                <span>{t.popup.bankUserMeaning}</span>
                {entry.userTranslation || '—'}
              </p>
              {(entry.sources ?? []).length > 0 && (
                <ul className="popup-bank-sources">
                  {(entry.sources ?? []).map((source, index) => {
                    const href = safeHttpUrl(source.url)
                    const label = source.title || source.url
                    return (
                      <li key={`${source.url}|${source.addedAt}|${index}`}>
                        {href && label ? (
                          <a className="popup-bank-link" href={href} target="_blank" rel="noreferrer noopener">
                            {label}
                          </a>
                        ) : null}
                        {source.sentence && source.sentence !== label && (
                          <span className="popup-bank-sentence">{source.sentence}</span>
                        )}
                      </li>
                    )
                  })}
                </ul>
              )}
              <div className="popup-bank-row-actions">
                {(entry.status === 'error' || entry.status === 'pending') && (
                  <button
                    type="button"
                    className="popup-bank-quiet"
                    onClick={() => void retryEntry(entry.id)}
                    disabled={busyId === entry.id}
                  >
                    {t.popup.bankRetry}
                  </button>
                )}
                <button
                  type="button"
                  className="popup-bank-quiet"
                  onClick={() => void removeEntry(entry.id)}
                  disabled={busyId === entry.id}
                >
                  {t.popup.bankDelete}
                </button>
              </div>
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}

const Popup = () => {
  const [config, setConfig] = useState<AppConfig>(DEFAULT_CONFIG)
  const [activeTab, setActiveTab] = useState<'translate' | 'bank' | 'settings'>('translate')
  const [memory, setMemory] = useState<FloatorMemory>(emptyMemory())
  const [status, setStatus] = useState<string>('')
  
  // Translation State
  const [needText, setNeedText] = useState(DEFAULT_POPUP_WORKSPACE.needText)
  const [needTargetLangCode, setNeedTargetLangCode] = useState(DEFAULT_POPUP_WORKSPACE.needTargetLangCode)
  const [needResult, setNeedResult] = useState('')
  const [needResultSourceText, setNeedResultSourceText] = useState('')
  const [needResultTargetLangCode, setNeedResultTargetLangCode] = useState(DEFAULT_POPUP_WORKSPACE.needResultTargetLangCode)
  const [needError, setNeedError] = useState('')
  const [needLoading, setNeedLoading] = useState(false)
  const [needCopied, setNeedCopied] = useState(false)
  const [needAttempt, setNeedAttempt] = useState(0)
  const [workspaceLoaded, setWorkspaceLoaded] = useState(false)
  const [activeResultView, setActiveResultView] = useState<PopupWorkspace['activeResultView']>('translation')
  const [followupQuery, setFollowupQuery] = useState('')
  const [pendingFollowupQuery, setPendingFollowupQuery] = useState('')
  const [followupHistory, setFollowupHistory] = useState<PopupConversationTurn[]>([])
  const [followupLoading, setFollowupLoading] = useState(false)
  const [followupError, setFollowupError] = useState('')
  const [copiedTurnIndex, setCopiedTurnIndex] = useState<number | null>(null)
  const [useTranslationContext, setUseTranslationContext] = useState(false)
  const needTextareaRef = useRef<HTMLTextAreaElement | null>(null)
  const followupTextareaRef = useRef<HTMLTextAreaElement | null>(null)
  const conversationRef = useRef<HTMLDivElement | null>(null)
  const composingRef = useRef(false)
  const followupInFlightRef = useRef(false)
  const persistenceTimerRef = useRef<number | null>(null)
  const skipNextPersistenceRef = useRef(false)
  const targetOverrideRef = useRef(false)

  // Settings State
  const [loading, setLoading] = useState(false)

  const interfaceLanguage = interfaceLanguageFor(config.userLanguage, config.interfaceSide)
  const direction = textDirectionFor(interfaceLanguage)
  const t = getTranslation(interfaceLanguage)
  const activeProviderConfig: ProviderConfig = config.providers[config.activeApiProvider]
  const activePlaceholders = API_PROVIDER_PLACEHOLDERS[config.activeApiProvider]

  const providerLabelMap: Record<ApiProvider, string> = {
    lmStudio: t.popup.providerLmStudio,
    lmApiServer: t.popup.providerLmApiServer,
    ollama: t.popup.providerOllama,
  }
  const hasNeedOutput = needLoading || Boolean(needResult) || Boolean(needError)
  const reviewDue = isReviewThresholdMet(memory)
  const isStatusError = status.includes('Failed') || status.includes('Error')
  const activeTargetLanguage = isUserLanguage(needResultTargetLangCode)
    ? languageChoiceLabel(needResultTargetLangCode, interfaceLanguage)
    : needResultTargetLangCode
  const canAskFollowup = !needLoading && !followupLoading

  const normalizeHoverDuration = (value: number) => {
    if (!Number.isFinite(value)) return HOVER_DURATION_DEFAULT_MS
    return Math.min(HOVER_DURATION_MAX_MS, Math.max(HOVER_DURATION_MIN_MS, Math.round(value)))
  }

  const extractTranslateText = (data: unknown): string => {
    if (typeof data === 'string') return data
    if (typeof data === 'object' && data !== null) {
      const text = (data as { text?: unknown }).text
      if (typeof text === 'string') return text
    }
    return ''
  }

  useEffect(() => {
    let cancelled = false
    Promise.all([
      getConfig(),
      chrome.storage.local.get(POPUP_WORKSPACE_KEY).catch(() => ({}) as Record<string, unknown>),
    ])
      .then(([cfg, result]) => {
        if (cancelled) return
        setConfig(cfg)
        const storedWorkspace = result[POPUP_WORKSPACE_KEY]
        const fresh = getFreshPopupWorkspace(storedWorkspace, cfg.userLanguage)
        if (storedWorkspace !== undefined && !fresh) {
          chrome.storage.local.remove(POPUP_WORKSPACE_KEY).catch(() => {})
        }
        const workspace = fresh ?? {
          ...DEFAULT_POPUP_WORKSPACE,
          needTargetLangCode: cfg.userLanguage,
          needResultTargetLangCode: cfg.userLanguage,
        }
        const targetOverridden = workspace.targetOverridden
        targetOverrideRef.current = targetOverridden
        setNeedText(workspace.needText)
        setNeedTargetLangCode(targetOverridden ? workspace.needTargetLangCode : cfg.userLanguage)
        setNeedResult(workspace.needResult)
        setNeedResultSourceText(workspace.needResultSourceText)
        setNeedResultTargetLangCode(workspace.needResultTargetLangCode)
        setFollowupQuery(workspace.followupQuery)
        setFollowupHistory(workspace.followupHistory)
        setActiveResultView(workspace.activeResultView)
        setUseTranslationContext(workspace.useTranslationContext)
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setWorkspaceLoaded(true)
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    loadMemory()
      .then(setMemory)
      .catch(() => setMemory(emptyMemory()))

    const onChanged = (changes: { [key: string]: chrome.storage.StorageChange }, areaName: string) => {
      if (areaName !== 'local' || !Object.prototype.hasOwnProperty.call(changes, MEMORY_STORAGE_KEY)) return
      setMemory(sanitizeMemory(changes[MEMORY_STORAGE_KEY]?.newValue))
    }

    chrome.storage.onChanged.addListener(onChanged)
    return () => chrome.storage.onChanged.removeListener(onChanged)
  }, [])

  useEffect(() => {
    if (!workspaceLoaded) return
    if (skipNextPersistenceRef.current) {
      skipNextPersistenceRef.current = false
      return
    }
    persistenceTimerRef.current = window.setTimeout(() => {
      const workspace: StoredPopupWorkspace = {
        needText,
        needTargetLangCode,
        needResult,
        needResultSourceText,
        needResultTargetLangCode,
        followupQuery,
        followupHistory,
        activeResultView,
        useTranslationContext,
        targetOverridden: targetOverrideRef.current,
        expiresAt: Date.now() + POPUP_WORKSPACE_TTL_MS,
      }
      chrome.storage.local.set({ [POPUP_WORKSPACE_KEY]: workspace }).catch(() => {})
      persistenceTimerRef.current = null
    }, 120)
    return () => {
      if (persistenceTimerRef.current !== null) {
        window.clearTimeout(persistenceTimerRef.current)
        persistenceTimerRef.current = null
      }
    }
  }, [
    activeResultView,
    followupHistory,
    followupQuery,
    needResult,
    needResultSourceText,
    needResultTargetLangCode,
    needTargetLangCode,
    needText,
    useTranslationContext,
    workspaceLoaded,
  ])

  useEffect(() => {
    document.title = t.popup.title
    document.documentElement.lang = interfaceLanguage
    document.documentElement.dir = direction
  }, [direction, interfaceLanguage, t.popup.title])

  useEffect(() => {
    setNeedAttempt(0)
  }, [needText, needTargetLangCode])

  useEffect(() => {
    const el = needTextareaRef.current
    if (!el) return
    el.style.height = 'auto'
    const maxHeightPx = 160
    const next = Math.min(el.scrollHeight, maxHeightPx)
    el.style.height = `${Math.max(80, next)}px`
    el.style.overflowY = el.scrollHeight > maxHeightPx ? 'auto' : 'hidden'
  }, [needText, activeTab])

  useEffect(() => {
    if (activeResultView !== 'conversation') return
    const el = conversationRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [activeResultView, followupHistory, followupLoading])

  const handleSave = async () => {
    await saveConfig(config)
    setStatus(t.popup.statusSaved)
    setTimeout(() => setStatus(''), 2000)
  }

  const handlePreload = async () => {
    setLoading(true)
    setStatus(t.popup.statusPreloading)
    try {
      await saveConfig(config)
      const response = await chrome.runtime.sendMessage({ action: 'PRELOAD_MODEL' })
      if (response.status === 'success') {
        setStatus(t.popup.statusReady)
      } else {
        setStatus(`Failed: ${response.error}`)
      }
    } catch (e: any) {
      setStatus(`Error: ${e.message}`)
    }
    setLoading(false)
    setTimeout(() => setStatus(''), 3000)
  }

  const handleToggleFloatingEnabled = async () => {
    const nextConfig = { ...config, floatingEnabled: !config.floatingEnabled }
    setConfig(nextConfig)
    await saveConfig(nextConfig)
  }

  const handleToggleFloatingStreamEnabled = async () => {
    const nextConfig = { ...config, floatingStreamEnabled: !config.floatingStreamEnabled }
    setConfig(nextConfig)
    await saveConfig(nextConfig)
  }

  const commitLanguage = async (patch: { userLanguage?: UserLanguage; interfaceSide?: InterfaceSide }) => {
    const nextLanguage = patch.userLanguage ?? config.userLanguage
    const nextConfig = { ...config, ...patch, userLanguage: nextLanguage }
    setConfig(nextConfig)
    if (patch.userLanguage && patch.userLanguage !== config.userLanguage && !targetOverrideRef.current) {
      setNeedTargetLangCode(patch.userLanguage)
      if (!needResult.trim()) setNeedResultTargetLangCode(patch.userLanguage)
    }
    await saveConfig(nextConfig)
  }

  const updateActiveProviderConfig = (patch: Partial<ProviderConfig>) => {
    const nextProviderConfig = { ...activeProviderConfig, ...patch }
    setConfig({
      ...config,
      providers: {
        ...config.providers,
        [config.activeApiProvider]: nextProviderConfig,
      },
      apiUrl: nextProviderConfig.apiUrl,
      apiKey: nextProviderConfig.apiKey,
      modelName: nextProviderConfig.modelName,
      prompt: nextProviderConfig.prompt,
    })
  }

  const handleProviderTabChange = (provider: ApiProvider) => {
    const nextProviderConfig = config.providers[provider]
    setConfig({
      ...config,
      activeApiProvider: provider,
      apiUrl: nextProviderConfig.apiUrl,
      apiKey: nextProviderConfig.apiKey,
      modelName: nextProviderConfig.modelName,
      prompt: nextProviderConfig.prompt,
    })
  }

  const handleNeedTranslate = async () => {
    const text = needText.trim()
    if (!text) return

    const nextAttempt = needAttempt + 1
    setNeedAttempt(nextAttempt)
    setNeedLoading(true)
    setNeedCopied(false)
    setNeedError('')
    setFollowupError('')
    setActiveResultView('translation')
    setNeedResult('')
    
    try {
      const response = await chrome.runtime.sendMessage({
        action: 'TRANSLATE',
        payload: { text, targetLangCode: needTargetLangCode, attempt: nextAttempt },
      })

      if (response.status === 'success') {
        setNeedResult(extractTranslateText(response.data))
        setNeedResultSourceText(text)
        setNeedResultTargetLangCode(needTargetLangCode)
        setFollowupQuery('')
        setPendingFollowupQuery('')
        setFollowupHistory([])
      } else {
        setNeedError(response.error || 'Unknown error')
      }
    } catch (e: any) {
      setNeedError(e.message || 'Communication error')
    } finally {
      setNeedLoading(false)
    }
  }

  const handleNeedCopy = async () => {
    const text = needResult.trim()
    if (!text) return

    if (await copyTextToClipboard(text)) {
      setNeedCopied(true)
      setTimeout(() => setNeedCopied(false), 1500)
    }
  }

  const openFollowup = (withTranslationContext = false) => {
    setFollowupError('')
    setUseTranslationContext(withTranslationContext && Boolean(needResult.trim() && needResultSourceText.trim()))
    setActiveResultView('conversation')
    window.requestAnimationFrame(() => followupTextareaRef.current?.focus())
  }

  const openDirectConversation = () => openFollowup(false)

  const handleNeedFollowup = async () => {
    const draft = followupQuery
    const query = draft.trim()
    if (followupInFlightRef.current || !query || !canAskFollowup) return

    followupInFlightRef.current = true
    setFollowupLoading(true)
    setFollowupError('')
    setCopiedTurnIndex(null)
    setPendingFollowupQuery(query)
    setFollowupQuery('')
    try {
      const response = await chrome.runtime.sendMessage({
        action: 'FOLLOWUP',
        payload: {
          query,
          sourceText: useTranslationContext ? needResultSourceText : '',
          translatedText: useTranslationContext ? needResult : '',
          history: followupHistory,
        },
      })

      if (response?.status !== 'success') {
        throw new Error(response?.error || 'Interaction failed')
      }

      setFollowupHistory(prev => [...prev, { query, answer: String(response.data || '') }])
    } catch (error) {
      setFollowupQuery(draft)
      setFollowupError(error instanceof Error ? error.message : 'Interaction failed')
    } finally {
      followupInFlightRef.current = false
      setPendingFollowupQuery('')
      setFollowupLoading(false)
    }
  }

  const handleCopyTurn = async (answer: string, index: number) => {
    if (!answer.trim()) return
    if (await copyTextToClipboard(answer.trim())) {
      setCopiedTurnIndex(index)
      window.setTimeout(() => setCopiedTurnIndex(current => current === index ? null : current), 1500)
    }
  }

  const handleClearWorkspace = () => {
    if (needLoading || followupLoading) return
    if (persistenceTimerRef.current !== null) {
      window.clearTimeout(persistenceTimerRef.current)
      persistenceTimerRef.current = null
    }
    skipNextPersistenceRef.current = true
    targetOverrideRef.current = false
    setNeedText(DEFAULT_POPUP_WORKSPACE.needText)
    setNeedTargetLangCode(config.userLanguage)
    setNeedResult(DEFAULT_POPUP_WORKSPACE.needResult)
    setNeedResultSourceText(DEFAULT_POPUP_WORKSPACE.needResultSourceText)
    setNeedResultTargetLangCode(config.userLanguage)
    setFollowupQuery(DEFAULT_POPUP_WORKSPACE.followupQuery)
    setPendingFollowupQuery('')
    setFollowupHistory([])
    setActiveResultView(DEFAULT_POPUP_WORKSPACE.activeResultView)
    setUseTranslationContext(DEFAULT_POPUP_WORKSPACE.useTranslationContext)
    setNeedError('')
    setFollowupError('')
    setNeedCopied(false)
    setCopiedTurnIndex(null)
    setNeedAttempt(0)
    chrome.storage.local.remove(POPUP_WORKSPACE_KEY).catch(() => {})
  }

  return (
    <div className="popup-shell" dir={direction} lang={interfaceLanguage} data-tab={activeTab} data-loading={needLoading ? 'true' : 'false'}>
      <div className="popup-topbar popup-reveal popup-reveal--1">
        <div className="popup-header">
          <div>
            <span className="popup-kicker">{providerLabelMap[config.activeApiProvider]}</span>
            <h1 className="popup-title">{t.popup.title}</h1>
            <p className="popup-subtitle">
              {activeTab === 'translate' ? t.popup.inputPlaceholder : activeTab === 'bank' ? t.popup.bankSubtitle : t.popup.apiConfigTitle}
            </p>
          </div>
          <div className="popup-header-side">
            <span className="popup-chip">{config.userLanguage.toUpperCase()}</span>
            {status && (
              <span className="popup-status" data-tone={isStatusError ? 'error' : 'success'}>
                {status}
              </span>
            )}
          </div>
        </div>

        <div className="popup-tabs">
          <button
            onClick={() => setActiveTab('translate')}
            className="popup-tab"
            data-active={activeTab === 'translate'}
          >
            {t.popup.tabTranslator}
          </button>
          <button
            onClick={() => setActiveTab('bank')}
            className="popup-tab"
            data-active={activeTab === 'bank'}
          >
            <span className="popup-tab-label">
              {t.popup.tabBank}
              {reviewDue && <span className="popup-tab-badge">{memory.review.newSinceSummary}</span>}
            </span>
          </button>
          <button
            onClick={() => setActiveTab('settings')}
            className="popup-tab"
            data-active={activeTab === 'settings'}
          >
            {t.popup.tabSettings}
          </button>
        </div>
      </div>

      <div className="popup-scroll">
        {activeTab === 'translate' && (
          <div className="popup-stack">
            <section className="popup-panel popup-panel--workspace popup-reveal popup-reveal--2" data-mode={activeResultView}>
              <div className="popup-workspace-toolbar">
                <div className="popup-workspace-modes" role="tablist">
                  <button
                    type="button"
                    role="tab"
                    aria-selected={activeResultView === 'translation'}
                    data-active={activeResultView === 'translation'}
                    onClick={() => setActiveResultView('translation')}
                  >
                    {t.popup.resultTab}
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={activeResultView === 'conversation'}
                    data-active={activeResultView === 'conversation'}
                    onClick={openDirectConversation}
                  >
                    {t.popup.conversationTab}
                    {followupHistory.length > 0 && <span>{followupHistory.length}</span>}
                  </button>
                </div>

                <div className="popup-workspace-controls">
                  {activeResultView === 'translation' && (
                    <label className="popup-target-control">
                      <span>{t.popup.toLabel}</span>
                      <select
                        value={needTargetLangCode}
                        onChange={event => {
                          targetOverrideRef.current = true
                          setNeedTargetLangCode(event.target.value)
                        }}
                      >
                        {USER_LANGUAGES.map(value => (
                          <option key={value} value={value}>{languageChoiceLabel(value, interfaceLanguage)}</option>
                        ))}
                      </select>
                    </label>
                  )}
                  <button
                    type="button"
                    className="popup-clear-button"
                    onClick={handleClearWorkspace}
                    disabled={needLoading || followupLoading}
                    title={t.popup.clearWorkspaceTitle}
                    aria-label={t.popup.clearWorkspaceTitle}
                  >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M4 7h16M9 7V4h6v3m-8 0 1 13h8l1-13M10 11v5m4-5v5" />
                    </svg>
                  </button>
                </div>
              </div>

              {activeResultView === 'translation' ? (
                <div className="popup-translate-workspace">
                  <div className="popup-workspace-section popup-workspace-section--source">
                    <div className="popup-workspace-label">{t.popup.sourceTextLabel}</div>
                    <textarea
                      ref={needTextareaRef}
                      className="popup-workspace-editor"
                      placeholder={t.popup.inputPlaceholder}
                      value={needText}
                      onChange={event => setNeedText(event.target.value)}
                      onKeyDown={event => {
                        if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') handleNeedTranslate()
                      }}
                    />
                    <div className="popup-workspace-actions">
                      <span>Ctrl/Cmd + Enter</span>
                      <button
                        type="button"
                        onClick={handleNeedTranslate}
                        disabled={needLoading || !needText.trim()}
                        className="popup-action-primary"
                      >
                        {needLoading ? <span className="popup-spinner" /> : null}
                        {needLoading ? t.popup.transLoading : t.popup.transButton}
                      </button>
                    </div>
                  </div>

                  <div className="popup-workspace-divider" aria-hidden="true"><span /></div>

                  <div className="popup-workspace-section popup-workspace-section--result">
                    <div className="popup-workspace-result-head">
                      <div>
                        <div className="popup-workspace-label">{t.popup.translatedTextLabel}</div>
                        <div className="popup-workspace-language">{activeTargetLanguage}</div>
                      </div>
                      {needResult && !needLoading && !needError && (
                        <div className="popup-result-actions">
                          <button
                            type="button"
                            onClick={() => openFollowup(true)}
                            className="popup-chat-button"
                            title={t.popup.askAI}
                          >
                            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z" />
                            </svg>
                            <span>{t.popup.askAI}</span>
                          </button>
                          <button
                            type="button"
                            onClick={handleNeedCopy}
                            className={`popup-icon-button ${needCopied ? 'is-copied' : ''}`}
                            title={t.popup.copyTitle}
                            aria-label={t.popup.copyTitle}
                          >
                            {needCopied ? (
                              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                              </svg>
                            ) : (
                              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                              </svg>
                            )}
                          </button>
                        </div>
                      )}
                    </div>

                    <div className="popup-workspace-output" aria-live="polite">
                      {needLoading ? (
                        <div className="popup-skeleton"><span /><span /></div>
                      ) : needError ? (
                        <div className="popup-error">{needError}</div>
                      ) : hasNeedOutput ? (
                        <div className="popup-markdown">
                          <ReactMarkdown remarkPlugins={[remarkGfm]}>{needResult}</ReactMarkdown>
                        </div>
                      ) : (
                        <div className="popup-workspace-placeholder">
                          <span className="popup-empty-dot" aria-hidden="true" />
                          {t.popup.resultPlaceholder}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              ) : (
                <div className="popup-conversation">
                  <div className="popup-conversation-context">
                    <button
                      type="button"
                      data-active={useTranslationContext}
                      disabled={!needResult.trim() || !needResultSourceText.trim()}
                      onClick={() => setUseTranslationContext(current => !current)}
                    >
                      <span className="popup-context-dot" />
                      {useTranslationContext ? t.popup.useTranslationContext : t.popup.directConversation}
                    </button>
                  </div>

                  <div ref={conversationRef} className="popup-conversation-scroll" aria-live="polite">
                    {followupHistory.length === 0 && !followupLoading && (
                      <div className="popup-conversation-empty">
                        <span className="popup-conversation-mark" aria-hidden="true">
                          <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.7} d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z" />
                          </svg>
                        </span>
                        <strong>{t.popup.conversationEmptyTitle}</strong>
                        <span>{t.popup.conversationEmptyDesc}</span>
                      </div>
                    )}

                    {followupHistory.map((turn, index) => (
                      <div key={`${turn.query}-${index}`} className="popup-chat-turn">
                        <div className="popup-chat-role">{t.popup.userLabel}</div>
                        <div className="popup-chat-query">{turn.query}</div>
                        <div className="popup-chat-answer-head">
                          <span>{t.popup.aiLabel}</span>
                          <button
                            type="button"
                            onClick={() => handleCopyTurn(turn.answer, index)}
                            className="popup-chat-copy"
                            aria-label={t.popup.copyTitle}
                            title={t.popup.copyTitle}
                          >
                            {copiedTurnIndex === index ? (
                              <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                              </svg>
                            ) : (
                              <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                              </svg>
                            )}
                          </button>
                        </div>
                        <div className="popup-chat-answer popup-markdown">
                          <ReactMarkdown remarkPlugins={[remarkGfm]}>{turn.answer}</ReactMarkdown>
                        </div>
                      </div>
                    ))}

                    {followupLoading && (
                      <div className="popup-chat-turn popup-chat-turn--pending">
                        <div className="popup-chat-role">{t.popup.userLabel}</div>
                        <div className="popup-chat-query">{pendingFollowupQuery}</div>
                        <div className="popup-chat-answer-head">{t.popup.aiLabel}</div>
                        <div className="popup-chat-thinking">
                          <span /><span /><span />
                          {t.popup.followupThinking}
                        </div>
                      </div>
                    )}
                  </div>

                  <div className="popup-composer">
                    <textarea
                      ref={followupTextareaRef}
                      rows={2}
                      value={followupQuery}
                      placeholder={t.popup.followupPlaceholder}
                      disabled={followupLoading}
                      onChange={event => setFollowupQuery(event.target.value)}
                      onCompositionStart={() => { composingRef.current = true }}
                      onCompositionEnd={() => { composingRef.current = false }}
                      onKeyDown={event => {
                        const native = event.nativeEvent as KeyboardEvent
                        const isComposing = composingRef.current || native.isComposing || native.keyCode === 229
                        if (event.key === 'Enter' && !event.shiftKey && !isComposing) {
                          event.preventDefault()
                          handleNeedFollowup()
                        }
                      }}
                    />
                    <div className="popup-composer-footer">
                      <span className={followupError ? 'popup-composer-error' : ''}>
                        {followupError || t.popup.followupHint}
                      </span>
                      <button
                        type="button"
                        onClick={handleNeedFollowup}
                        disabled={!canAskFollowup || !followupQuery.trim()}
                        aria-label={t.popup.followupSend}
                        title={t.popup.followupSend}
                      >
                        {followupLoading ? <span className="popup-spinner" /> : (
                          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.9} d="M5 12h14m-6-6 6 6-6 6" />
                          </svg>
                        )}
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </section>
          </div>
        )}

        {activeTab === 'bank' && (
          <BankPanel memory={memory} userLanguage={config.userLanguage} interfaceLanguage={interfaceLanguage} t={t} />
        )}

        {activeTab === 'settings' && (
          <div className="popup-stack">
            <section className="popup-section popup-reveal popup-reveal--2">
              <h2 className="popup-section-title">{t.popup.preferencesTitle}</h2>

              <div className="popup-card">
                <div className="popup-setting-row">
                  <div className="popup-setting-main">
                    <span className="popup-setting-title">{t.popup.userLanguage}</span>
                    <span className="popup-setting-description">{t.popup.userLanguageDesc}</span>
                  </div>
                  <div className="popup-lang-switch" role="radiogroup" aria-label={t.popup.userLanguage}>
                    <button
                      type="button"
                      className="popup-lang-option"
                      role="radio"
                      aria-checked={config.interfaceSide === 'en'}
                      aria-label={t.popup.interfaceEnglish}
                      title={t.popup.interfaceEnglish}
                      data-active={config.interfaceSide === 'en'}
                      onClick={() => void commitLanguage({ interfaceSide: 'en' })}
                    >
                      En
                    </button>
                    <div className="popup-lang-user" data-active={config.interfaceSide === 'user'}>
                      <button
                        type="button"
                        className="popup-lang-option popup-lang-option--user"
                        role="radio"
                        aria-checked={config.interfaceSide === 'user'}
                        title={USER_LANGUAGE_ENDONYM[config.userLanguage]}
                        data-active="false"
                        onClick={() => void commitLanguage({ interfaceSide: 'user' })}
                      >
                        {USER_LANGUAGE_ENDONYM[config.userLanguage]}
                      </button>
                      <label className="popup-lang-caret">
                        <select
                          aria-label={t.popup.userLanguagePick}
                          value={config.userLanguage}
                          onChange={event => {
                            const nextLanguage = event.target.value
                            if (!isUserLanguage(nextLanguage)) return
                            void commitLanguage({ userLanguage: nextLanguage })
                          }}
                        >
                          {USER_LANGUAGES.map(value => (
                            <option key={value} value={value}>{USER_LANGUAGE_ENDONYM[value]}</option>
                          ))}
                        </select>
                        <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                          <path fillRule="evenodd" d="M5.23 7.21a.75.75 0 011.06.02L10 11.17l3.71-3.94a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z" clipRule="evenodd" />
                        </svg>
                      </label>
                    </div>
                  </div>
                </div>

                <div className="popup-setting-row">
                  <div className="popup-setting-main">
                    <span className="popup-setting-title">{t.popup.floatingTransTitle}</span>
                    <span className="popup-setting-description">{t.popup.floatingTransDesc}</span>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="popup-helper min-w-[44px] text-right">
                      {config.floatingEnabled ? t.popup.floatingTransEnabledState : t.popup.floatingTransDisabledState}
                    </span>
                    <button
                      type="button"
                      onClick={handleToggleFloatingEnabled}
                      className="popup-action-secondary !h-[38px] !px-4 !py-0"
                    >
                      {config.floatingEnabled ? t.popup.floatingTransDisable : t.popup.floatingTransEnable}
                    </button>
                  </div>
                </div>

                <div className="popup-setting-row">
                  <div className="popup-setting-main">
                    <span className="popup-setting-title">{t.popup.floatingStreamTitle}</span>
                    <span className="popup-setting-description">{t.popup.floatingStreamDesc}</span>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="popup-helper min-w-[42px] text-right">
                      {config.floatingStreamEnabled ? t.popup.floatingModeStream : t.popup.floatingModeInstant}
                    </span>
                    <button
                      type="button"
                      onClick={handleToggleFloatingStreamEnabled}
                      className="popup-toggle"
                      data-on={config.floatingStreamEnabled}
                      disabled={!config.floatingEnabled}
                    >
                      <span className="popup-toggle__thumb" />
                    </button>
                  </div>
                </div>

                <div className="popup-setting-row">
                  <div className="popup-setting-main">
                    <span className="popup-setting-title">{t.popup.hoverDelayTitle}</span>
                    <span className="popup-setting-description">{t.popup.hoverDelayDesc}</span>
                  </div>
                  <div className="popup-range-wrap">
                    <input
                      type="range"
                      min={HOVER_DURATION_MIN_MS}
                      max={HOVER_DURATION_MAX_MS}
                      step={100}
                      className="popup-range"
                      value={config.hoverDurationMs}
                      disabled={!config.floatingEnabled}
                      onChange={e => setConfig({ ...config, hoverDurationMs: normalizeHoverDuration(Number(e.target.value)) })}
                    />
                    <div className="popup-range-row">
                      <input
                        type="number"
                        min={HOVER_DURATION_MIN_MS}
                        max={HOVER_DURATION_MAX_MS}
                        step={100}
                        className="popup-input !h-[38px] !w-[78px] !px-3 text-right disabled:opacity-50"
                        value={config.hoverDurationMs}
                        disabled={!config.floatingEnabled}
                        onChange={e => setConfig({ ...config, hoverDurationMs: normalizeHoverDuration(Number(e.target.value)) })}
                      />
                      <span className="popup-range-unit">ms</span>
                    </div>
                  </div>
                </div>

                <div className="popup-setting-row">
                  <div className="popup-setting-main">
                    <span className="popup-setting-title">{t.popup.keepWarmTitle}</span>
                    <span className="popup-setting-description">{t.popup.keepWarmDesc}</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => setConfig({ ...config, keepAliveEnabled: !config.keepAliveEnabled })}
                    className="popup-toggle"
                    data-on={config.keepAliveEnabled}
                  >
                    <span className="popup-toggle__thumb" />
                  </button>
                </div>
              </div>
            </section>

            <section className="popup-section popup-reveal popup-reveal--3">
              <h2 className="popup-section-title">{t.popup.apiConfigTitle}</h2>

              <div className="popup-provider-tabs">
                {API_PROVIDER_TABS.map(provider => (
                  <button
                    key={provider}
                    type="button"
                    onClick={() => handleProviderTabChange(provider)}
                    className="popup-provider-tab"
                    data-active={config.activeApiProvider === provider}
                  >
                    {providerLabelMap[provider]}
                  </button>
                ))}
              </div>

              <div className="popup-card">
                <div className="popup-form">
                  <label className="popup-field">
                    <span className="popup-field-label">{t.popup.apiEndpoint}</span>
                    <input
                      type="text"
                      className="popup-input"
                      placeholder={activePlaceholders.endpoint}
                      value={activeProviderConfig.apiUrl}
                      onChange={e => updateActiveProviderConfig({ apiUrl: e.target.value })}
                    />
                  </label>

                  <label className="popup-field">
                    <span className="popup-field-label">{t.popup.apiKey}</span>
                    <input
                      type="password"
                      className="popup-input"
                      placeholder={activePlaceholders.apiKey}
                      value={activeProviderConfig.apiKey}
                      onChange={e => updateActiveProviderConfig({ apiKey: e.target.value })}
                    />
                  </label>

                  <label className="popup-field">
                    <span className="popup-field-label">{t.popup.modelName}</span>
                    <input
                      type="text"
                      className="popup-input"
                      placeholder={activePlaceholders.modelName}
                      value={activeProviderConfig.modelName}
                      onChange={e => updateActiveProviderConfig({ modelName: e.target.value })}
                    />
                  </label>

                  <label className="popup-field">
                    <span className="popup-field-label">{t.popup.systemPrompt}</span>
                    <textarea
                      className="popup-textarea min-h-[120px]"
                      value={activeProviderConfig.prompt}
                      onChange={e => updateActiveProviderConfig({ prompt: e.target.value })}
                    />
                  </label>
                </div>
              </div>
            </section>

            <div className="popup-actions popup-reveal popup-reveal--4">
              <button onClick={handleSave} className="popup-action-primary flex-1">
                {t.popup.saveButton}
              </button>
              <button onClick={handlePreload} disabled={loading} className="popup-action-secondary flex-1">
                {loading ? t.popup.preloading : t.popup.preloadButton}
              </button>
            </div>

            <div className="popup-debug-wrap popup-reveal popup-reveal--5">
              <button
                type="button"
                onClick={() => setConfig({ ...config, debug: !config.debug })}
                className="popup-debug"
                data-active={config.debug}
              >
                {t.popup.debugLogs}: {config.debug ? 'ON' : 'OFF'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Popup />
  </React.StrictMode>,
)
