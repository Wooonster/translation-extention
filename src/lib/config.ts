export type ApiProvider = 'lmStudio' | 'lmApiServer' | 'ollama'

export const USER_LANGUAGES = ['en', 'zh', 'fr', 'de', 'es', 'ar', 'hi', 'ru', 'pt'] as const

export type UserLanguage = (typeof USER_LANGUAGES)[number]

export type InterfaceSide = 'en' | 'user'

export type InterfaceLanguage = UserLanguage

export const USER_LANGUAGE_ENDONYM: Record<UserLanguage, string> = {
  en: 'English',
  zh: '中文',
  fr: 'Français',
  de: 'Deutsch',
  es: 'Español',
  ar: 'العربية',
  hi: 'हिन्दी',
  ru: 'Русский',
  pt: 'Português',
}

const USER_LANGUAGE_SET = new Set<string>(USER_LANGUAGES)

export const isUserLanguage = (value: unknown): value is UserLanguage =>
  typeof value === 'string' && USER_LANGUAGE_SET.has(value)

export const isInterfaceSide = (value: unknown): value is InterfaceSide =>
  value === 'en' || value === 'user'

export const textDirectionFor = (language: UserLanguage): 'ltr' | 'rtl' =>
  language === 'ar' ? 'rtl' : 'ltr'

export const interfaceLanguageFor = (userLanguage: UserLanguage, interfaceSide: InterfaceSide): InterfaceLanguage =>
  interfaceSide === 'en' ? 'en' : userLanguage

export const resolveUserLanguage = (stored: { userLanguage?: unknown; interfaceLanguage?: unknown } | null | undefined): UserLanguage => {
  if (isUserLanguage(stored?.userLanguage)) return stored.userLanguage
  const legacy = stored?.interfaceLanguage
  if (legacy === 'en' || legacy === 'zh') return legacy
  return 'zh'
}

export const resolveInterfaceSide = (
  stored: { interfaceSide?: unknown } | null | undefined,
  userLanguage: UserLanguage,
): InterfaceSide => {
  if (isInterfaceSide(stored?.interfaceSide)) return stored.interfaceSide
  return userLanguage === 'zh' ? 'user' : 'en'
}

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
  userLanguage: UserLanguage
  interfaceSide: InterfaceSide
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
    apiUrl: 'https://openrouter.ai/api/v1',
    apiKey: '',
    modelName: 'openrouter/free',
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
  apiKey: '',
  modelName: 'openrouter/free',
  prompt: '你是一个专业的翻译助手。请将用户提供的文本翻译成中文。直接输出翻译结果，不要包含任何解释、拼音或其他无关内容。',
  activeApiProvider: 'lmApiServer',
  providers: DEFAULT_PROVIDER_CONFIGS,
  debug: false,
  keepAliveEnabled: false,
  keepAliveIntervalSec: 60,
  hoverDurationMs: HOVER_DURATION_DEFAULT_MS,
  userLanguage: 'zh',
  interfaceSide: 'user',
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
  const storedConfig = (result.config || {}) as Partial<AppConfig> & { interfaceLanguage?: unknown }

  const activeApiProvider: ApiProvider =
    storedConfig.activeApiProvider === 'lmStudio' || storedConfig.activeApiProvider === 'lmApiServer' || storedConfig.activeApiProvider === 'ollama'
      ? storedConfig.activeApiProvider
      : 'lmApiServer'

  const providers = buildProviders(storedConfig)
  const activeProviderConfig = providers[activeApiProvider]
  const userLanguage = resolveUserLanguage(storedConfig)
  const interfaceSide = resolveInterfaceSide(storedConfig, userLanguage)
  const storedWithoutLegacy = { ...storedConfig }
  delete storedWithoutLegacy.interfaceLanguage

  const merged = {
    ...DEFAULT_CONFIG,
    ...storedWithoutLegacy,
    floatingStreamEnabled: storedConfig.floatingStreamEnabled === true,
    userLanguage,
    interfaceSide,
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
