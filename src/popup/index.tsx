import React, { useEffect, useRef, useState } from 'react'
import ReactDOM from 'react-dom/client'
import { DEFAULT_CONFIG, getConfig, saveConfig, type AppConfig } from '../lib/config'
import '../index.css'

const LANGUAGE_OPTIONS: Array<{ label: string; value: string }> = [
  { label: 'English ｜ 英语', value: 'en' },
  { label: '中文 ｜ 中文', value: 'zh' },
  { label: 'Français ｜ 法语', value: 'fr' },
  { label: 'Deutsch ｜ 德语', value: 'de' },
  { label: 'Español ｜ 西班牙语', value: 'es' },
  { label: 'العربية ｜ 阿拉伯语', value: 'ar' },
  { label: 'हिन्दी ｜ 印地语', value: 'hi' },
  { label: 'Русский ｜ 俄语', value: 'ru' },
  { label: 'Português ｜ 葡萄牙语', value: 'pt' },
]

const Popup = () => {
  const [config, setConfig] = useState<AppConfig>(DEFAULT_CONFIG)
  const [status, setStatus] = useState<string>('')
  const [loading, setLoading] = useState(false)
  const [isApiSettingsOpen, setIsApiSettingsOpen] = useState(false)
  const [isSettingsOpen, setIsSettingsOpen] = useState(false)
  const [isINeedOpen, setIsINeedOpen] = useState(false)
  const [needText, setNeedText] = useState('')
  const [needTargetLangCode, setNeedTargetLangCode] = useState('en')
  const [needResult, setNeedResult] = useState('')
  const [needError, setNeedError] = useState('')
  const [needLoading, setNeedLoading] = useState(false)
  const [needCopied, setNeedCopied] = useState(false)
  const [needAttempt, setNeedAttempt] = useState(0)
  const [needTransGlow, setNeedTransGlow] = useState(false)
  const needTextareaRef = useRef<HTMLTextAreaElement | null>(null)

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
    const maxHeightPx = 200
    const next = Math.min(el.scrollHeight, maxHeightPx)
    el.style.height = `${next}px`
    el.style.overflowY = el.scrollHeight > maxHeightPx ? 'auto' : 'hidden'
  }, [needText, isINeedOpen])

  const handleSave = async () => {
    await saveConfig(config)
    setStatus('Saved!')
    setTimeout(() => setStatus(''), 2000)
  }

  const handlePreload = async () => {
    setLoading(true)
    setStatus('Preloading...')
    try {
      await saveConfig(config)
      const response = await chrome.runtime.sendMessage({ action: 'PRELOAD_MODEL' })
      if (response.status === 'success') {
        setStatus('Ready!')
      } else {
        setStatus(`Failed: ${response.error}`)
      }
    } catch (e: any) {
      setStatus(`Error: ${e.message}`)
    }
    setLoading(false)
    setTimeout(() => setStatus(''), 3000)
  }

  const handleNeedTranslate = async (opts?: { glow?: boolean }) => {
    const text = needText.trim()
    if (!text) return

    const nextAttempt = needAttempt + 1
    setNeedAttempt(nextAttempt)
    setNeedLoading(true)
    setNeedCopied(false)
    setNeedError('')
    if (opts?.glow) {
      setNeedTransGlow(true)
      setTimeout(() => setNeedTransGlow(false), 220)
    }
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
    <div className="w-[400px] p-4 bg-gray-50">
      <div className="flex justify-between items-center mb-4 border-b pb-2">
        <h1 className="text-lg font-bold text-gray-800 flex items-center gap-2">
          AI Translate
        </h1>
        {status && (
          <span className={`text-xs font-medium px-2 py-1 rounded ${status.includes('Failed') || status.includes('Error') ? 'bg-red-100 text-red-700' : 'bg-green-100 text-green-700'}`}>
            {status}
          </span>
        )}
      </div>
      
      <div className="space-y-3">
        <div className="border border-gray-200 rounded-lg overflow-hidden">
          <button
            onClick={() => setIsApiSettingsOpen(!isApiSettingsOpen)}
            className="w-full flex items-center justify-between p-3 bg-gray-100 hover:bg-gray-200 transition-colors"
          >
            <span className="text-sm font-semibold text-gray-700">API Configuration</span>
            <svg
              className={`w-4 h-4 text-gray-500 transform transition-transform ${isApiSettingsOpen ? 'rotate-180' : ''}`}
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          </button>
          
          {isApiSettingsOpen && (
            <div className="p-3 space-y-3 bg-white border-t border-gray-200">
              <div>
                <label className="block text-xs font-semibold text-gray-600 mb-1">API Endpoint</label>
                <input 
                  type="text" 
                  className="w-full text-sm border border-gray-300 p-2 rounded focus:ring-1 focus:ring-blue-500 outline-none"
                  placeholder="http://localhost:1234/v1" 
                  value={config.apiUrl}
                  onChange={e => setConfig({ ...config, apiUrl: e.target.value })}
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-gray-600 mb-1">API Key</label>
                <input 
                  type="password" 
                  className="w-full text-sm border border-gray-300 p-2 rounded focus:ring-1 focus:ring-blue-500 outline-none"
                  placeholder="sk-..." 
                  value={config.apiKey}
                  onChange={e => setConfig({ ...config, apiKey: e.target.value })}
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-gray-600 mb-1">Model Name</label>
                <input 
                  type="text" 
                  className="w-full text-sm border border-gray-300 p-2 rounded focus:ring-1 focus:ring-blue-500 outline-none"
                  placeholder="local-model" 
                  value={config.modelName}
                  onChange={e => setConfig({ ...config, modelName: e.target.value })}
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-gray-600 mb-1">System Prompt</label>
                <textarea 
                  className="w-full text-xs border border-gray-300 p-2 rounded h-20 focus:ring-1 focus:ring-blue-500 outline-none resize-none"
                  value={config.prompt}
                  onChange={e => setConfig({ ...config, prompt: e.target.value })}
                />
              </div>

              <div className="pt-2 flex gap-2">
                <button 
                  onClick={handleSave}
                  className="flex-1 bg-blue-600 text-white text-sm font-medium py-2 rounded hover:bg-blue-700 transition"
                >
                  Save
                </button>
                <button 
                  onClick={handlePreload}
                  disabled={loading}
                  className={`flex-1 text-white text-sm font-medium py-2 rounded transition ${loading ? 'bg-purple-400 cursor-not-allowed' : 'bg-purple-600 hover:bg-purple-700'}`}
                  title="Warm up model to reduce first-translation latency"
                >
                  {loading ? 'Loading...' : 'Preload Model'}
                </button>
              </div>
            </div>
          )}
        </div>

        <div className="border border-gray-200 rounded-lg overflow-hidden">
          <button
            onClick={() => setIsINeedOpen(!isINeedOpen)}
            className="w-full flex items-center justify-between p-3 bg-gray-100 hover:bg-gray-200 transition-colors"
          >
            <span className="text-sm font-semibold text-gray-700">i need...</span>
            <svg
              className={`w-4 h-4 text-gray-500 transform transition-transform ${isINeedOpen ? 'rotate-180' : ''}`}
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          </button>

          {isINeedOpen && (
            <div className="p-3 space-y-3 bg-white border-t border-gray-200">
              <div>
                <label className="block text-xs font-semibold text-gray-600 mb-1">需要翻译的文本</label>
                <div className="relative">
                  <textarea
                    ref={needTextareaRef}
                    className="w-full text-sm border border-gray-300 p-2 rounded min-h-[80px] max-h-[200px] focus:ring-1 focus:ring-blue-500 outline-none resize-none pb-12"
                    placeholder="输入要翻译的内容（Ctrl/Cmd + Enter 重新翻译）"
                    value={needText}
                    onChange={e => setNeedText(e.target.value)}
                    onKeyDown={e => {
                      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') handleNeedTranslate()
                    }}
                  />
                  <button
                    type="button"
                    onClick={() => handleNeedTranslate({ glow: true })}
                    disabled={needLoading || !needText.trim()}
                    className={`absolute bottom-2 right-2 bg-blue-600 text-white text-xs font-semibold px-3 py-1 rounded hover:bg-blue-700 disabled:bg-blue-300 disabled:cursor-not-allowed transition active:ring-2 active:ring-white focus-visible:ring-2 focus-visible:ring-white ${
                      needTransGlow ? 'ring-2 ring-white' : ''
                    }`}
                  >
                    Trans
                  </button>
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-gray-600 mb-1">目标语言</label>
                <select
                  className="w-full text-sm border border-gray-300 p-2 rounded focus:ring-1 focus:ring-blue-500 outline-none bg-white"
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

              <div className="relative">
                <label className="block text-xs font-semibold text-gray-600 mb-1">翻译结果</label>
                <textarea
                  className="w-full text-sm border border-gray-300 p-2 rounded h-24 focus:ring-1 focus:ring-blue-500 outline-none resize-none pr-14 pb-10"
                  value={needResult}
                  readOnly
                  placeholder={needLoading ? '翻译中…' : '这里显示翻译结果'}
                />
                <div className="absolute bottom-2 right-2 flex items-center gap-2">
                  <button
                    type="button"
                    onClick={handleNeedCopy}
                    disabled={!needResult.trim()}
                    title="复制"
                    className={`p-1 rounded transition ${
                      needCopied ? 'text-gray-400' : 'text-gray-600 hover:text-gray-800'
                    } disabled:text-gray-300`}
                  >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" className="w-5 h-5">
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M9 9h10v10H9V9zM5 15H4a1 1 0 01-1-1V4a1 1 0 011-1h10a1 1 0 011 1v1"
                      />
                    </svg>
                  </button>
                  <button
                    type="button"
                    onClick={() => handleNeedTranslate()}
                    disabled={needLoading || !needText.trim()}
                    title="重新翻译"
                    className="p-1 rounded text-gray-600 hover:text-gray-800 disabled:text-gray-300 transition"
                  >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" className="w-5 h-5">
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M4 4v6h6M20 20v-6h-6M20 9a8 8 0 00-14.9-3M4 15a8 8 0 0014.9 3"
                      />
                    </svg>
                  </button>
                </div>
              </div>

              {needError && <div className="text-xs text-red-600">{needError}</div>}
            </div>
          )}
        </div>

        {/* Collapsible Settings */}
        <div className="border border-gray-200 rounded-lg overflow-hidden">
          <button
            onClick={() => setIsSettingsOpen(!isSettingsOpen)}
            className="w-full flex items-center justify-between p-3 bg-gray-100 hover:bg-gray-200 transition-colors"
          >
            <span className="text-sm font-semibold text-gray-700">Settings</span>
            <svg
              className={`w-4 h-4 text-gray-500 transform transition-transform ${isSettingsOpen ? 'rotate-180' : ''}`}
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          </button>
          
          {isSettingsOpen && (
            <div className="p-3 space-y-3 bg-white border-t border-gray-200">
              <div className="flex items-center justify-between pt-1">
                <span className="text-xs font-semibold text-gray-600">Debug Logs</span>
                <button
                  type="button"
                  onClick={() => setConfig({ ...config, debug: !config.debug })}
                  className={`w-10 h-6 flex items-center rounded-full p-1 transition ${config.debug ? 'bg-blue-600' : 'bg-gray-300'}`}
                  aria-pressed={config.debug}
                  aria-label="Toggle debug logs"
                >
                  <span className={`bg-white w-4 h-4 rounded-full shadow transform transition ${config.debug ? 'translate-x-4' : ''}`} />
                </button>
              </div>

              <div className="flex items-center justify-between pt-1">
                <span className="text-xs font-semibold text-gray-600">Keep Model Warm</span>
                <button
                  type="button"
                  onClick={() => setConfig({ ...config, keepAliveEnabled: !config.keepAliveEnabled })}
                  className={`w-10 h-6 flex items-center rounded-full p-1 transition ${config.keepAliveEnabled ? 'bg-blue-600' : 'bg-gray-300'}`}
                  aria-pressed={config.keepAliveEnabled}
                  aria-label="Toggle keep-alive"
                >
                  <span className={`bg-white w-4 h-4 rounded-full shadow transform transition ${config.keepAliveEnabled ? 'translate-x-4' : ''}`} />
                </button>
              </div>

              <div className="flex items-center justify-between">
                <label className="text-xs font-semibold text-gray-600">Keep-Alive Interval (sec)</label>
                <input
                  type="number"
                  min={15}
                  max={3600}
                  className="w-20 text-sm border-b border-gray-300 focus:border-blue-500 outline-none text-right bg-transparent transition-colors disabled:text-gray-400"
                  value={config.keepAliveIntervalSec}
                  disabled={!config.keepAliveEnabled}
                  onChange={e => setConfig({ ...config, keepAliveIntervalSec: Number(e.target.value) })}
                />
              </div>

              <div className="flex items-center justify-between">
                <label className="text-xs font-semibold text-gray-600">Hover Duration (ms)</label>
                <input
                  type="number"
                  min={500}
                  max={10000}
                  step={100}
                  className="w-20 text-sm border-b border-gray-300 focus:border-blue-500 outline-none text-right bg-transparent transition-colors"
                  value={config.hoverDurationMs}
                  onChange={e => setConfig({ ...config, hoverDurationMs: Number(e.target.value) })}
                />
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Popup />
  </React.StrictMode>,
)
