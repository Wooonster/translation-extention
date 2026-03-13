export type ApiProvider = 'lmStudio' | 'lmApiServer' | 'ollama'

export interface ProviderConfig {
  apiUrl: string
  apiKey: string
  modelName: string
  prompt: string
}

export interface AppConfig {
  floatingEnabled: boolean
  floatingStreamEnabled: boolean
  apiUrl: string
  apiKey: string
  modelName: string
  prompt: string
  activeApiProvider: ApiProvider
  providers: Record<ApiProvider, ProviderConfig>
  debug: boolean
  keepAliveEnabled: boolean
  keepAliveIntervalSec: number
  hoverDurationMs: number
  interfaceLanguage: 'en' | 'zh'
}

export const HOVER_DURATION_MIN_MS = 200
export const HOVER_DURATION_MAX_MS = 5000
export const HOVER_DURATION_DEFAULT_MS = 3000

const DEFAULT_PROVIDER_CONFIGS: Record<ApiProvider, ProviderConfig> = {
  lmStudio: {
    apiUrl: 'http://127.0.0.1:1234/v1',
    apiKey: 'lm-studio',
    modelName: 'local-model',
    prompt: '你是一个专业的翻译助手。请将用户提供的文本翻译成中文。直接输出翻译结果，不要包含任何解释、拼音或其他无关内容。',
  },
  lmApiServer: {
    apiUrl: 'http://127.0.0.1:8000/v1',
    apiKey: '',
    modelName: 'your-model-name',
    prompt: '你是一个专业的翻译助手。请将用户提供的文本翻译成中文。直接输出翻译结果，不要包含任何解释、拼音或其他无关内容。',
  },
  ollama: {
    apiUrl: 'http://127.0.0.1:11434/v1',
    apiKey: 'ollama',
    modelName: 'qwen2.5:7b-instruct',
    prompt: '你是一个专业的翻译助手。请将用户提供的文本翻译成中文。直接输出翻译结果，不要包含任何解释、拼音或其他无关内容。',
  },
}

export const DEFAULT_CONFIG: AppConfig = {
  floatingEnabled: true,
  floatingStreamEnabled: false,
  apiUrl: 'https://openrouter.ai/api/v1',
  apiKey: 'sk-or-your-openrouter-key',
  modelName: 'openrouter/free',
  prompt: '你是一个专业的翻译助手。请将用户提供的文本翻译成中文。直接输出翻译结果，不要包含任何解释、拼音或其他无关内容。',
  activeApiProvider: 'lmApiServer',
  providers: DEFAULT_PROVIDER_CONFIGS,
  debug: false,
  keepAliveEnabled: false,
  keepAliveIntervalSec: 60,
  hoverDurationMs: HOVER_DURATION_DEFAULT_MS,
  interfaceLanguage: 'en',
}

const clampHoverDuration = (value: unknown): number => {
  const ms = Number(value)
  if (!Number.isFinite(ms)) return HOVER_DURATION_DEFAULT_MS
  return Math.min(HOVER_DURATION_MAX_MS, Math.max(HOVER_DURATION_MIN_MS, Math.round(ms)))
}

const sanitizeProviderConfig = (raw: unknown, fallback: ProviderConfig): ProviderConfig => {
  const obj = typeof raw === 'object' && raw !== null ? (raw as Partial<ProviderConfig>) : {}
  return {
    apiUrl: typeof obj.apiUrl === 'string' && obj.apiUrl.trim() ? obj.apiUrl : fallback.apiUrl,
    apiKey: typeof obj.apiKey === 'string' ? obj.apiKey : fallback.apiKey,
    modelName: typeof obj.modelName === 'string' && obj.modelName.trim() ? obj.modelName : fallback.modelName,
    prompt: typeof obj.prompt === 'string' && obj.prompt.trim() ? obj.prompt : fallback.prompt,
  }
}

const buildProviders = (storedConfig: Partial<AppConfig>): Record<ApiProvider, ProviderConfig> => {
  const rawProviders = (storedConfig.providers || {}) as Partial<Record<ApiProvider, ProviderConfig>>
  const providers: Record<ApiProvider, ProviderConfig> = {
    lmStudio: sanitizeProviderConfig(rawProviders.lmStudio, DEFAULT_PROVIDER_CONFIGS.lmStudio),
    lmApiServer: sanitizeProviderConfig(rawProviders.lmApiServer, DEFAULT_PROVIDER_CONFIGS.lmApiServer),
    ollama: sanitizeProviderConfig(rawProviders.ollama, DEFAULT_PROVIDER_CONFIGS.ollama),
  }

  if (storedConfig.apiUrl || storedConfig.modelName || storedConfig.prompt || typeof storedConfig.apiKey === 'string') {
    providers.lmApiServer = {
      apiUrl: typeof storedConfig.apiUrl === 'string' && storedConfig.apiUrl.trim() ? storedConfig.apiUrl : providers.lmApiServer.apiUrl,
      apiKey: typeof storedConfig.apiKey === 'string' ? storedConfig.apiKey : providers.lmApiServer.apiKey,
      modelName: typeof storedConfig.modelName === 'string' && storedConfig.modelName.trim() ? storedConfig.modelName : providers.lmApiServer.modelName,
      prompt: typeof storedConfig.prompt === 'string' && storedConfig.prompt.trim() ? storedConfig.prompt : providers.lmApiServer.prompt,
    }
  }

  return providers
}

const detectSystemInterfaceLanguage = (): AppConfig['interfaceLanguage'] => {
  try {
    const ui = chrome.i18n.getUILanguage().toLowerCase()
    return ui.startsWith('zh') ? 'zh' : 'en'
  } catch {
    return 'en'
  }
}

export const saveConfig = async (config: AppConfig): Promise<void> => {
  const current = config.providers?.[config.activeApiProvider] || DEFAULT_PROVIDER_CONFIGS[config.activeApiProvider]
  const next: AppConfig = {
    ...config,
    providers: {
      lmStudio: sanitizeProviderConfig(config.providers?.lmStudio, DEFAULT_PROVIDER_CONFIGS.lmStudio),
      lmApiServer: sanitizeProviderConfig(config.providers?.lmApiServer, DEFAULT_PROVIDER_CONFIGS.lmApiServer),
      ollama: sanitizeProviderConfig(config.providers?.ollama, DEFAULT_PROVIDER_CONFIGS.ollama),
    },
    apiUrl: current.apiUrl,
    apiKey: current.apiKey,
    modelName: current.modelName,
    prompt: current.prompt,
  }
  await chrome.storage.sync.set({ config: next })
}

export const getConfig = async (): Promise<AppConfig> => {
  const result = await chrome.storage.sync.get('config')
  const storedConfig = (result.config || {}) as Partial<AppConfig>

  const activeApiProvider: ApiProvider =
    storedConfig.activeApiProvider === 'lmStudio' || storedConfig.activeApiProvider === 'lmApiServer' || storedConfig.activeApiProvider === 'ollama'
      ? storedConfig.activeApiProvider
      : 'lmApiServer'

  const providers = buildProviders(storedConfig)
  const activeProviderConfig = providers[activeApiProvider]
  const interfaceLanguage =
    storedConfig.interfaceLanguage === 'en' || storedConfig.interfaceLanguage === 'zh'
      ? storedConfig.interfaceLanguage
      : detectSystemInterfaceLanguage()

  const merged = {
    ...DEFAULT_CONFIG,
    ...storedConfig,
    floatingStreamEnabled: storedConfig.floatingStreamEnabled === true,
    interfaceLanguage,
    activeApiProvider,
    providers,
    apiUrl: activeProviderConfig.apiUrl,
    apiKey: activeProviderConfig.apiKey,
    modelName: activeProviderConfig.modelName,
    prompt: activeProviderConfig.prompt,
  } as AppConfig

  merged.hoverDurationMs = clampHoverDuration(merged.hoverDurationMs)
  return merged
}
