export interface AppConfig {
  apiUrl: string
  apiKey: string
  modelName: string
  prompt: string
  debug: boolean
  keepAliveEnabled: boolean
  keepAliveIntervalSec: number
  hoverDurationMs: number
}

export const DEFAULT_CONFIG: AppConfig = {
  apiUrl: 'http://localhost:1234/v1',
  apiKey: 'lm-studio',
  modelName: 'local-model',
  prompt: '你是一个专业的翻译助手。请将用户提供的文本翻译成中文。直接输出翻译结果，不要包含任何解释、拼音或其他无关内容。',
  debug: false,
  keepAliveEnabled: false,
  keepAliveIntervalSec: 60,
  hoverDurationMs: 3000,
}

export const saveConfig = (config: AppConfig): Promise<void> => {
  return chrome.storage.sync.set({ config })
}

export const getConfig = async (): Promise<AppConfig> => {
  const result = await chrome.storage.sync.get('config')
  const storedConfig = result.config || {}
  return { ...DEFAULT_CONFIG, ...storedConfig }
}
