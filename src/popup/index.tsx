import React, { useEffect, useRef, useState } from 'react'
import ReactDOM from 'react-dom/client'
import { DEFAULT_CONFIG, getConfig, saveConfig, type AppConfig } from '../lib/config'
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

  useEffect(() => {
    getConfig().then(setConfig)
  }, [])

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
        setNeedResult(response.data || '')
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
    <div className="w-[360px] min-h-[480px] bg-slate-50 flex flex-col font-sans text-slate-800">
      {/* Header */}
      <div className="bg-white px-4 py-3 border-b border-slate-200 flex justify-between items-center shadow-sm sticky top-0 z-10">
        <h1 className="text-base font-bold flex items-center gap-2 text-slate-800">
          <span className="w-5 h-5 bg-blue-600 rounded text-white flex items-center justify-center text-[10px] font-black">AI</span>
          {t.popup.title}
        </h1>
        {status && (
          <span className={`text-[10px] font-medium px-2 py-0.5 rounded-full transition-all ${status.includes('Failed') || status.includes('Error') ? 'bg-red-100 text-red-600' : 'bg-green-100 text-green-600'}`}>
            {status}
          </span>
        )}
      </div>

      {/* Tabs */}
      <div className="flex bg-white border-b border-slate-200 px-1">
        <button
          onClick={() => setActiveTab('translate')}
          className={`flex-1 py-2 text-xs font-semibold border-b-2 transition-colors ${
            activeTab === 'translate'
              ? 'border-blue-600 text-blue-600'
              : 'border-transparent text-slate-500 hover:text-slate-700'
          }`}
        >
          {t.popup.tabTranslator}
        </button>
        <button
          onClick={() => setActiveTab('settings')}
          className={`flex-1 py-2 text-xs font-semibold border-b-2 transition-colors ${
            activeTab === 'settings'
              ? 'border-blue-600 text-blue-600'
              : 'border-transparent text-slate-500 hover:text-slate-700'
          }`}
        >
          {t.popup.tabSettings}
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        {activeTab === 'translate' ? (
          <div className="p-4 space-y-4">
            {/* Input Area */}
            <div className="relative">
              <textarea
                ref={needTextareaRef}
                className="w-full text-sm p-3 pb-12 rounded-lg border border-slate-200 shadow-sm outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 bg-white resize-none transition-all placeholder:text-slate-400"
                placeholder={t.popup.inputPlaceholder}
                value={needText}
                onChange={e => setNeedText(e.target.value)}
                onKeyDown={e => {
                  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') handleNeedTranslate()
                }}
              />
              <div className="absolute bottom-3 right-3">
                <button
                  type="button"
                  onClick={handleNeedTranslate}
                  disabled={needLoading || !needText.trim()}
                  className="bg-blue-600 text-white text-xs font-medium px-3 py-1.5 rounded-md hover:bg-blue-700 disabled:bg-slate-300 disabled:cursor-not-allowed transition-colors shadow-sm flex items-center gap-1"
                >
                  {needLoading ? (
                    <>
                      <div className="w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                      <span>{t.popup.transLoading}</span>
                    </>
                  ) : (
                    t.popup.transButton
                  )}
                </button>
              </div>
            </div>

            {/* Target Language */}
            <div className="flex items-center gap-2">
              <span className="text-xs font-medium text-slate-500">{t.popup.toLabel}</span>
              <select
                className="flex-1 text-xs py-1.5 px-2 rounded-md border border-slate-200 bg-white focus:border-blue-500 outline-none cursor-pointer hover:border-slate-300 transition-colors"
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

            {/* Result Area */}
            {(needResult || needLoading) && (
              <div className="relative group">
                <div className={`w-full min-h-[100px] text-sm p-3 rounded-lg border ${needError ? 'border-red-200 bg-red-50' : 'border-slate-200 bg-white'} shadow-sm`}>
                  {needLoading ? (
                    <div className="space-y-2 animate-pulse">
                      <div className="h-2 bg-slate-100 rounded w-3/4"></div>
                      <div className="h-2 bg-slate-100 rounded w-1/2"></div>
                    </div>
                  ) : needError ? (
                    <span className="text-red-600 text-xs">{needError}</span>
                  ) : (
                    <div className="prose prose-sm text-slate-700 leading-relaxed whitespace-pre-wrap">
                      {needResult || t.popup.resultPlaceholder}
                    </div>
                  )}
                </div>
                
                {needResult && !needLoading && !needError && (
                  <button
                    type="button"
                    onClick={handleNeedCopy}
                    className="absolute top-2 right-2 p-1.5 rounded-md text-slate-400 hover:text-blue-600 hover:bg-blue-50 transition-colors opacity-0 group-hover:opacity-100 focus:opacity-100"
                    title={t.popup.copyTitle}
                  >
                    {needCopied ? (
                      <svg className="w-4 h-4 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                      </svg>
                    ) : (
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                      </svg>
                    )}
                  </button>
                )}
              </div>
            )}
          </div>
        ) : (
          <div className="p-4 space-y-5">
            {/* General Settings */}
            <section className="space-y-3">
              <h2 className="text-xs font-bold text-slate-400 uppercase tracking-wider">{t.popup.preferencesTitle}</h2>
              
              <div className="bg-white rounded-lg border border-slate-200 shadow-sm divide-y divide-slate-100 overflow-hidden">
                <div className="p-3 flex items-center justify-between hover:bg-slate-50 transition-colors">
                  <div className="flex flex-col">
                    <span className="text-sm font-medium text-slate-700">{t.popup.interfaceLanguage}</span>
                    <span className="text-[10px] text-slate-400">{t.popup.interfaceLanguageDesc}</span>
                  </div>
                  <div className="flex bg-slate-100 rounded-lg p-0.5">
                    <button
                      type="button"
                      onClick={() => setConfig({ ...config, interfaceLanguage: 'en' })}
                      className={`px-2 py-0.5 text-xs font-medium rounded-md transition-all ${
                        config.interfaceLanguage === 'en'
                          ? 'bg-white text-blue-600 shadow-sm'
                          : 'text-slate-500 hover:text-slate-700'
                      }`}
                    >
                      EN
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfig({ ...config, interfaceLanguage: 'zh' })}
                      className={`px-2 py-0.5 text-xs font-medium rounded-md transition-all ${
                        config.interfaceLanguage === 'zh'
                          ? 'bg-white text-blue-600 shadow-sm'
                          : 'text-slate-500 hover:text-slate-700'
                      }`}
                    >
                      中
                    </button>
                  </div>
                </div>

                <div className="p-3 flex items-center justify-between hover:bg-slate-50 transition-colors">
                  <div className="flex flex-col">
                    <span className="text-sm font-medium text-slate-700">{t.popup.floatingTransTitle}</span>
                    <span className="text-[10px] text-slate-400">{t.popup.floatingTransDesc}</span>
                  </div>
                  <button
                    type="button"
                    onClick={handleToggleFloatingEnabled}
                    className={`w-9 h-5 rounded-full p-0.5 transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-blue-500/20 ${config.floatingEnabled ? 'bg-blue-600' : 'bg-slate-300'}`}
                  >
                    <div className={`w-4 h-4 rounded-full bg-white shadow-sm transform transition-transform duration-200 ${config.floatingEnabled ? 'translate-x-4' : 'translate-x-0'}`} />
                  </button>
                </div>

                <div className="p-3 flex items-center justify-between hover:bg-slate-50 transition-colors">
                  <div className="flex flex-col">
                    <span className="text-sm font-medium text-slate-700">{t.popup.hoverDelayTitle}</span>
                    <span className="text-[10px] text-slate-400">{t.popup.hoverDelayDesc}</span>
                  </div>
                  <input
                    type="number"
                    min={200}
                    max={5000}
                    step={100}
                    className="w-16 text-xs text-right p-1 rounded border border-slate-200 outline-none focus:border-blue-500"
                    value={config.hoverDurationMs}
                    disabled={!config.floatingEnabled}
                    onChange={e => setConfig({ ...config, hoverDurationMs: Number(e.target.value) })}
                  />
                </div>

                <div className="p-3 flex items-center justify-between hover:bg-slate-50 transition-colors">
                  <div className="flex flex-col">
                    <span className="text-sm font-medium text-slate-700">{t.popup.keepWarmTitle}</span>
                    <span className="text-[10px] text-slate-400">{t.popup.keepWarmDesc}</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => setConfig({ ...config, keepAliveEnabled: !config.keepAliveEnabled })}
                    className={`w-9 h-5 rounded-full p-0.5 transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-blue-500/20 ${config.keepAliveEnabled ? 'bg-blue-600' : 'bg-slate-300'}`}
                  >
                    <div className={`w-4 h-4 rounded-full bg-white shadow-sm transform transition-transform duration-200 ${config.keepAliveEnabled ? 'translate-x-4' : 'translate-x-0'}`} />
                  </button>
                </div>
              </div>
            </section>

            {/* API Configuration */}
            <section className="space-y-3">
              <h2 className="text-xs font-bold text-slate-400 uppercase tracking-wider">{t.popup.apiConfigTitle}</h2>
              
              <div className="bg-white rounded-lg border border-slate-200 shadow-sm p-3 space-y-3">
                <div>
                  <label className="block text-xs font-medium text-slate-600 mb-1">{t.popup.apiEndpoint}</label>
                  <input 
                    type="text" 
                    className="w-full text-xs p-2 rounded border border-slate-200 outline-none focus:border-blue-500 bg-slate-50 focus:bg-white transition-colors"
                    placeholder="http://localhost:1234/v1" 
                    value={config.apiUrl}
                    onChange={e => setConfig({ ...config, apiUrl: e.target.value })}
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-600 mb-1">{t.popup.apiKey}</label>
                  <input 
                    type="password" 
                    className="w-full text-xs p-2 rounded border border-slate-200 outline-none focus:border-blue-500 bg-slate-50 focus:bg-white transition-colors"
                    placeholder="sk-..." 
                    value={config.apiKey}
                    onChange={e => setConfig({ ...config, apiKey: e.target.value })}
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-600 mb-1">{t.popup.modelName}</label>
                  <input 
                    type="text" 
                    className="w-full text-xs p-2 rounded border border-slate-200 outline-none focus:border-blue-500 bg-slate-50 focus:bg-white transition-colors"
                    placeholder="local-model" 
                    value={config.modelName}
                    onChange={e => setConfig({ ...config, modelName: e.target.value })}
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-600 mb-1">{t.popup.systemPrompt}</label>
                  <textarea 
                    className="w-full text-xs p-2 rounded border border-slate-200 outline-none focus:border-blue-500 bg-slate-50 focus:bg-white transition-colors resize-none h-16"
                    value={config.prompt}
                    onChange={e => setConfig({ ...config, prompt: e.target.value })}
                  />
                </div>
              </div>
            </section>

            {/* Actions */}
            <div className="flex gap-2 pt-2">
              <button 
                onClick={handleSave}
                className="flex-1 bg-slate-800 text-white text-xs font-semibold py-2 rounded-md hover:bg-slate-900 transition-colors shadow-sm active:scale-[0.98]"
              >
                {t.popup.saveButton}
              </button>
              <button 
                onClick={handlePreload}
                disabled={loading}
                className={`flex-1 text-xs font-semibold py-2 rounded-md transition-colors shadow-sm active:scale-[0.98] border ${loading ? 'bg-slate-100 text-slate-400 border-slate-200 cursor-not-allowed' : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-50 hover:text-blue-600'}`}
              >
                {loading ? t.popup.preloading : t.popup.preloadButton}
              </button>
            </div>
            
            <div className="text-center pt-2">
               <button
                  type="button"
                  onClick={() => setConfig({ ...config, debug: !config.debug })}
                  className={`text-[10px] ${config.debug ? 'text-blue-600 font-medium' : 'text-slate-400 hover:text-slate-600'}`}
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
