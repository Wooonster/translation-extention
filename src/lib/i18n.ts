
export const i18n = {
  en: {
    popup: {
      title: 'AI Translate',
      tabTranslator: 'Translator',
      tabSettings: 'Settings',
      inputPlaceholder: 'Enter text to translate...',
      transButton: 'Translate',
      transLoading: 'Trans',
      toLabel: 'To:',
      copyTitle: 'Copy result',
      retranslateTitle: 'Retranslate',
      resultPlaceholder: 'Translation result will appear here',
      loadingPlaceholder: 'Translating...',
      preferencesTitle: 'Preferences',
      floatingTransTitle: 'Floating Translation',
      floatingTransDesc: 'Show popup on text selection',
      hoverDelayTitle: 'Hover Delay',
      hoverDelayDesc: 'Wait time before trigger (ms)',
      keepWarmTitle: 'Keep Model Warm',
      keepWarmDesc: 'Reduce first-request latency',
      apiConfigTitle: 'API Configuration',
      apiEndpoint: 'API Endpoint',
      apiKey: 'API Key',
      modelName: 'Model Name',
      systemPrompt: 'System Prompt',
      saveButton: 'Save Changes',
      preloadButton: 'Preload Model',
      preloading: 'Preloading...',
      debugLogs: 'Debug Logs',
      interfaceLanguage: 'Interface Language',
      interfaceLanguageDesc: 'Switch between English and Chinese',
      statusSaved: 'Saved!',
      statusReady: 'Ready!',
      statusPreloading: 'Preloading...',
    },
    floating: {
      translating: 'Translating in',
      seconds: 's...',
      titleTrans: 'TRANSLATION',
      titleFollowup: 'FOLLOW-UP',
      askAI: 'Ask AI',
      copy: 'Copy',
      copied: 'Copied',
      followupPlaceholder: 'Ask follow-up question...',
      thinking: 'AI is thinking...',
      pressEnter: 'Press Enter to send',
      send: 'Send',
      error: 'Translation failed. Please try again.',
      askTooltip: 'Ask AI about this translation',
      sourceLabel: 'SOURCE: ',
    }
  },
  zh: {
    popup: {
      title: 'AI 翻译',
      tabTranslator: '翻译',
      tabSettings: '设置',
      inputPlaceholder: '输入要翻译的文本...',
      transButton: '翻译',
      transLoading: '翻译中',
      toLabel: '目标语言:',
      copyTitle: '复制结果',
      retranslateTitle: '重新翻译',
      resultPlaceholder: '翻译结果将显示在这里',
      loadingPlaceholder: '正在翻译...',
      preferencesTitle: '偏好设置',
      floatingTransTitle: '悬浮翻译',
      floatingTransDesc: '划词后自动显示翻译框',
      hoverDelayTitle: '悬停延迟',
      hoverDelayDesc: '触发前的等待时间 (毫秒)',
      keepWarmTitle: '模型保活',
      keepWarmDesc: '减少首次请求延迟',
      apiConfigTitle: 'API 配置',
      apiEndpoint: 'API 地址',
      apiKey: 'API Key',
      modelName: '模型名称',
      systemPrompt: '系统提示词',
      saveButton: '保存更改',
      preloadButton: '预加载模型',
      preloading: '加载中...',
      debugLogs: '调试日志',
      interfaceLanguage: '界面语言',
      interfaceLanguageDesc: '切换中英文界面',
      statusSaved: '已保存!',
      statusReady: '就绪!',
      statusPreloading: '加载中...',
    },
    floating: {
      translating: '翻译倒计时',
      seconds: '秒...',
      titleTrans: '翻译结果',
      titleFollowup: '追问',
      askAI: '追问 AI',
      copy: '复制',
      copied: '已复制',
      followupPlaceholder: '继续提问...',
      thinking: 'AI 思考中...',
      pressEnter: '按回车发送',
      send: '发送',
      error: '翻译失败，请重试。',
      askTooltip: '针对此翻译结果进行提问',
      sourceLabel: '原文：',
    }
  }
}

export type LanguageCode = 'en' | 'zh'

export const getTranslation = (lang: LanguageCode) => {
  return i18n[lang] || i18n.en
}

export const getLanguageName = (langCode: string, interfaceLang: LanguageCode): string => {
  const map: Record<string, { en: string; zh: string }> = {
    'en': { en: 'English', zh: '英语' },
    'zh': { en: 'Chinese', zh: '中文' },
    'zh-hans': { en: 'Chinese (Simplified)', zh: '简体中文' },
    'zh-hant': { en: 'Chinese (Traditional)', zh: '繁体中文' },
    'fr': { en: 'French', zh: '法语' },
    'de': { en: 'German', zh: '德语' },
    'ja': { en: 'Japanese', zh: '日语' },
    'ko': { en: 'Korean', zh: '韩语' },
    'ru': { en: 'Russian', zh: '俄语' },
    'es': { en: 'Spanish', zh: '西班牙语' },
    'pt': { en: 'Portuguese', zh: '葡萄牙语' },
    'it': { en: 'Italian', zh: '意大利语' },
    'ar': { en: 'Arabic', zh: '阿拉伯语' },
    'hi': { en: 'Hindi', zh: '印地语' },
  }
  
  const normalized = langCode.toLowerCase().trim()
  const entry = map[normalized]
  if (entry) return entry[interfaceLang] || entry.en
  return langCode // Fallback to raw code if not found
}
