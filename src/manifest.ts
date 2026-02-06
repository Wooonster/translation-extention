import { defineManifest } from '@crxjs/vite-plugin'

export default defineManifest({
  name: 'AI Translate Assistant',
  description: 'Translate text on hover using local LLM or OpenAI',
  version: '1.0.1',
  manifest_version: 3,
  permissions: ['storage'],
  host_permissions: ['<all_urls>'],
  icons: {
    16: 'src/assets/icons/icon16.png',
    48: 'src/assets/icons/icon48.png',
    128: 'src/assets/icons/icon128.png',
  },
  action: {
    default_popup: 'src/popup/index.html',
    default_icon: {
      16: 'src/assets/icons/icon16.png',
      48: 'src/assets/icons/icon48.png',
      128: 'src/assets/icons/icon128.png',
    },
  },
  // options_ui: {
  //   page: 'src/options/index.html',
  //   open_in_tab: true,
  // },
  background: {
    service_worker: 'src/background/index.ts',
    type: 'module',
  },
  content_scripts: [
    {
      matches: ['<all_urls>'],
      js: ['src/content/index.tsx'],
    },
  ],
})
