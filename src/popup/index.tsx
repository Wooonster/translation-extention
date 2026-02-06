import React, { useEffect, useState } from 'react'
import ReactDOM from 'react-dom/client'
import { DEFAULT_CONFIG, getConfig, saveConfig, type AppConfig } from '../lib/config'
import '../index.css'

const Popup = () => {
  const [config, setConfig] = useState<AppConfig>(DEFAULT_CONFIG)
  const [status, setStatus] = useState<string>('')
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    getConfig().then(setConfig)
  }, [])

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

        <div>
          <label className="block text-xs font-semibold text-gray-600 mb-1">Keep-Alive Interval (sec)</label>
          <input
            type="number"
            min={15}
            max={3600}
            className="w-full text-sm border border-gray-300 p-2 rounded focus:ring-1 focus:ring-blue-500 outline-none disabled:bg-gray-100"
            value={config.keepAliveIntervalSec}
            disabled={!config.keepAliveEnabled}
            onChange={e => setConfig({ ...config, keepAliveIntervalSec: Number(e.target.value) })}
          />
        </div>

        <div>
          <label className="block text-xs font-semibold text-gray-600 mb-1">Hover Duration (ms)</label>
          <input
            type="number"
            min={500}
            max={10000}
            step={100}
            className="w-full text-sm border border-gray-300 p-2 rounded focus:ring-1 focus:ring-blue-500 outline-none"
            value={config.hoverDurationMs}
            onChange={e => setConfig({ ...config, hoverDurationMs: Number(e.target.value) })}
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
    </div>
  )
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Popup />
  </React.StrictMode>,
)
