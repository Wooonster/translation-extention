import React, { useEffect, useRef, useState } from 'react'
import ReactDOM from 'react-dom/client'
import {
  DEFAULT_CONFIG,
  HOVER_DURATION_DEFAULT_MS,
  HOVER_DURATION_MAX_MS,
  HOVER_DURATION_MIN_MS,
  getConfig,
  saveConfig,
  type ApiProvider,
  type AppConfig,
  type ProviderConfig,
} from '../lib/config'
import { getTranslation } from '../lib/i18n'
import '../index.css'

const LANGUAGE_OPTIONS: Array<{ label: string; value: string }> = [
  { label: 'English | 英语', value: 'en' },
  { label: '中文 | 中文', value: 'zh' },
  { label: 'Français | 法语', value: 'fr' },
  { label: 'Deutsch | 德语', value: 'de' },
  { label: 'Español | 西班牙语', value: 'es' },
  { label: 'العربية | 阿拉伯语', value: 'ar' },
  { label: 'हिन्दी | 印地语', value: 'hi' },
  { label: 'Русский | 俄语', value: 'ru' },
  { label: 'Português | 葡萄牙语', value: 'pt' },
]

const API_PROVIDER_TABS: ApiProvider[] = ['lmStudio', 'lmApiServer', 'ollama']

const Popup = () => {
  const [config, setConfig] = useState<AppConfig>(DEFAULT_CONFIG)
  const [activeTab, setActiveTab] = useState<'translate' | 'settings'>('translate')
  const [status, setStatus] = useState<string>('')
  
  // Translation State
  const [needText, setNeedText] = useState('')
  const [needTargetLangCode, setNeedTargetLangCode] = useState('en')
  const [needResult, setNeedResult] = useState('')
  const [needError, setNeedError] = useState('')
  const [needLoading, setNeedLoading] = useState(false)
  const [needCopied, setNeedCopied] = useState(false)
  const [needAttempt, setNeedAttempt] = useState(0)
  const needTextareaRef = useRef<HTMLTextAreaElement | null>(null)

  // Settings State
  const [loading, setLoading] = useState(false)

  const t = getTranslation(config.interfaceLanguage)
  const activeProviderConfig: ProviderConfig = config.providers[config.activeApiProvider]

  const providerLabelMap: Record<ApiProvider, string> = {
    lmStudio: t.popup.providerLmStudio,
    lmApiServer: t.popup.providerLmApiServer,
    ollama: t.popup.providerOllama,
  }
  const hasNeedOutput = needLoading || Boolean(needResult) || Boolean(needError)
  const isStatusError = status.includes('Failed') || status.includes('Error')
  const activeTargetLanguage = LANGUAGE_OPTIONS.find(option => option.value === needTargetLangCode)?.label ?? needTargetLangCode

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
    getConfig().then(setConfig)
  }, [])

  useEffect(() => {
    document.title = t.popup.title
  }, [t.popup.title])

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
    
    try {
      const response = await chrome.runtime.sendMessage({
        action: 'TRANSLATE',
        payload: { text, targetLangCode: needTargetLangCode, attempt: nextAttempt },
      })

      if (response.status === 'success') {
        setNeedResult(extractTranslateText(response.data))
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

    try {
      await navigator.clipboard.writeText(text)
      setNeedCopied(true)
      setTimeout(() => setNeedCopied(false), 1500)
      return
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
    if (ok) {
      setNeedCopied(true)
      setTimeout(() => setNeedCopied(false), 1500)
    }
  }

  return (
    <div className="popup-shell" data-tab={activeTab} data-loading={needLoading ? 'true' : 'false'}>
      <div className="popup-topbar popup-reveal popup-reveal--1">
        <div className="popup-header">
          <div>
            <span className="popup-kicker">{providerLabelMap[config.activeApiProvider]}</span>
            <h1 className="popup-title">{t.popup.title}</h1>
            <p className="popup-subtitle">
              {activeTab === 'translate' ? t.popup.inputPlaceholder : t.popup.apiConfigTitle}
            </p>
          </div>
          <div className="popup-header-side">
            <span className="popup-chip">{config.interfaceLanguage.toUpperCase()}</span>
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
            onClick={() => setActiveTab('settings')}
            className="popup-tab"
            data-active={activeTab === 'settings'}
          >
            {t.popup.tabSettings}
          </button>
        </div>
      </div>

      <div className="popup-scroll">
        {activeTab === 'translate' ? (
          <div className="popup-stack">
            <section className="popup-panel popup-panel--hero popup-reveal popup-reveal--2">
              <div className="popup-row">
                <span className="popup-caption">{t.popup.toLabel}</span>
                <select
                  className="popup-select max-w-[190px]"
                  value={needTargetLangCode}
                  onChange={e => setNeedTargetLangCode(e.target.value)}
                >
                  {LANGUAGE_OPTIONS.map(opt => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </div>

              <textarea
                ref={needTextareaRef}
                className="popup-textarea"
                placeholder={t.popup.inputPlaceholder}
                value={needText}
                onChange={e => setNeedText(e.target.value)}
                onKeyDown={e => {
                  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') handleNeedTranslate()
                }}
              />

              <div className="popup-panel-actions mt-4">
                <span className="popup-helper">Ctrl/Cmd + Enter</span>
                <button
                  type="button"
                  onClick={handleNeedTranslate}
                  disabled={needLoading || !needText.trim()}
                  className="popup-action-primary"
                >
                  {needLoading ? (
                    <>
                      <div className="popup-spinner" />
                      <span>{t.popup.transLoading}</span>
                    </>
                  ) : (
                    t.popup.transButton
                  )}
                </button>
              </div>

            </section>

            <section className="popup-panel popup-panel--result popup-reveal popup-reveal--3">
              <div className="popup-result-card">
                <div className="popup-result-header">
                  <div>
                    <div className="popup-caption">{t.popup.tabTranslator}</div>
                    <div className="popup-result-label">{activeTargetLanguage}</div>
                  </div>

                  {needResult && !needLoading && !needError && (
                    <button
                      type="button"
                      onClick={handleNeedCopy}
                      className={`popup-icon-button ${needCopied ? 'is-copied' : ''}`}
                      title={t.popup.copyTitle}
                    >
                      {needCopied ? (
                        <svg className="h-4 w-4 text-emerald-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                        </svg>
                      ) : (
                        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                        </svg>
                      )}
                    </button>
                  )}
                </div>

                {needLoading ? (
                  <div className="popup-skeleton">
                    <span />
                    <span />
                  </div>
                ) : needError ? (
                  <div className="popup-result-copy popup-error">{needError}</div>
                ) : hasNeedOutput ? (
                  <div className="popup-result-copy">{needResult}</div>
                ) : (
                  <div className="popup-empty-state">
                    <span className="popup-empty-dot" aria-hidden="true" />
                    {t.popup.resultPlaceholder}
                  </div>
                )}
              </div>
            </section>
          </div>
        ) : (
          <div className="popup-stack">
            <section className="popup-section popup-reveal popup-reveal--2">
              <h2 className="popup-section-title">{t.popup.preferencesTitle}</h2>

              <div className="popup-card">
                <div className="popup-setting-row">
                  <div className="popup-setting-main">
                    <span className="popup-setting-title">{t.popup.interfaceLanguage}</span>
                    <span className="popup-setting-description">{t.popup.interfaceLanguageDesc}</span>
                  </div>
                  <div className="popup-lang-switch">
                    <button
                      type="button"
                      onClick={() => setConfig({ ...config, interfaceLanguage: 'en' })}
                      className="popup-lang-option"
                      data-active={config.interfaceLanguage === 'en'}
                    >
                      EN
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfig({ ...config, interfaceLanguage: 'zh' })}
                      className="popup-lang-option"
                      data-active={config.interfaceLanguage === 'zh'}
                    >
                      中
                    </button>
                  </div>
                </div>

                <div className="popup-setting-row">
                  <div className="popup-setting-main">
                    <span className="popup-setting-title">{t.popup.floatingTransTitle}</span>
                    <span className="popup-setting-description">{t.popup.floatingTransDesc}</span>
                  </div>
                  <button type="button" onClick={handleToggleFloatingEnabled} className="popup-toggle" data-on={config.floatingEnabled}>
                    <span className="popup-toggle__thumb" />
                  </button>
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
                      placeholder="http://localhost:1234/v1"
                      value={activeProviderConfig.apiUrl}
                      onChange={e => updateActiveProviderConfig({ apiUrl: e.target.value })}
                    />
                  </label>

                  <label className="popup-field">
                    <span className="popup-field-label">{t.popup.apiKey}</span>
                    <input
                      type="password"
                      className="popup-input"
                      placeholder="sk-..."
                      value={activeProviderConfig.apiKey}
                      onChange={e => updateActiveProviderConfig({ apiKey: e.target.value })}
                    />
                  </label>

                  <label className="popup-field">
                    <span className="popup-field-label">{t.popup.modelName}</span>
                    <input
                      type="text"
                      className="popup-input"
                      placeholder="local-model"
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
