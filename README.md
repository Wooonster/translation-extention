# 浮译 / Floator

Floating translation for the page you are already reading.

Select a sentence, rest the pointer, and a card appears beside it. Ask a follow-up, copy the result, or save the word. Longer passages go in the popup, next to a vocabulary bank that stays on this device.

[![Version 1.2.0](https://img.shields.io/badge/version-1.2.0-3d7a72)](CHANGELOG.md)
[![Chrome Manifest V3](https://img.shields.io/badge/Chrome-Manifest%20V3-555555)](src/manifest.ts)
[![MIT License](https://img.shields.io/badge/license-MIT-8aa)](LICENSE)

Floator is for anyone who reads the web in another language and wants the meaning without leaving the sentence. The Chinese name is 浮译. The English name is Floator.

## Features

**On the page**

- Hover a selection to translate. The wait is a setting, from 200 ms to 5 s.
- Show the result all at once, or stream it into the card.
- Keep the source language visible. When it is unknown, the card says it was auto-detected.
- Render Markdown, and math with KaTeX on standards-mode pages.
- Ask about wording, tone, or context in the same card. The draft clears when you send it, and returns if the request fails.
- Drag and resize the card.
- Save the selection. Command-click or Ctrl-click toggles words. Shift-click extends a phrase. One save stores the phrase you picked.
- A single word can keep a part of speech. A phrase keeps a pronunciation for the whole phrase.

**In the popup**

- Translator, Bank, and Settings.
- Paste a longer text, choose a target language, translate, retranslate, and copy.
- Continue in AI chat from the current translation, or start a direct conversation.
- Your language is a two-part control: English on the left, and 中文, Français, Deutsch, Español, العربية, हिन्दी, Русский, or Português on the right. The right-hand language stays the default translation target. Arabic lays out the popup and the floating card from right to left.
- The bank lists words saved on this device, ranked by how often you saved them. A reminder appears when a review is due. Summarize those words, dismiss the reminder, or delete the summary text.
- Download the bank as JSON, or the review as a Markdown sheet.

**API**

- Any OpenAI-compatible Chat Completions endpoint.
- Three saved providers: an LLM server (OpenRouter by default), LM Studio, and Ollama.
- Preload a model, optionally keep it warm, and optionally print debug logs.
- When the model name contains `translategemma`, Floator uses a TranslateGemma prompt and normalizes language codes.

## Screenshots

![Floating card on the Harbor page, with the Chinese translation, the original sentence unfolded, and icon-only ask, save, and copy actions](docs/store/screenshots/floating-card.png)

![The same Harbor page and card on the chat page, with a short follow-up and its answer](docs/store/screenshots/floating-chat.png)

![Popup on the Harbor page with the Bank still open. En is selected beside 中文, and the provider control shows LLM Server API, LM Studio, and Ollama. The list has pronunciation, part of speech on the single words, an English gloss, a Chinese translation, and an add count. The phrase at anchor has no part of speech.](docs/store/screenshots/popup-bank.png)

## Install

Build the extension, then load the `dist/` folder.

```bash
npm install
npm run build
```

1. Open `chrome://extensions`.
2. Turn on Developer mode.
3. Choose **Load unpacked** and select `dist/`.

After later source changes, run `npm run build` again and reload the extension on that page.

## API setup

Open the popup, then **Settings**. Pick a provider and save.

| Provider | Typical endpoint | Model |
| --- | --- | --- |
| LLM Server API | `https://openrouter.ai/api/v1` | `openrouter/free` |
| LM Studio | `http://127.0.0.1:1234/v1` | the model loaded in LM Studio |
| Ollama | `http://127.0.0.1:11434/v1` | for example `qwen2.5:7b-instruct` |

The API key is whatever that server expects. Local LM Studio and Ollama installs often accept a placeholder. OpenRouter needs a real key. The key is stored in Chrome sync storage and is sent only to the endpoint you configure.

Floator posts to `{endpoint}/chat/completions`, and fills in a missing path:

- an endpoint that already ends in `/chat/completions` is used as written
- an endpoint that ends in `/v1` or `/v4` gets `/chat/completions` appended
- anything else gets `/v1/chat/completions` appended

**Preload Model** warms the selected model. **Keep Model Warm** repeats that on an interval you set. Both are optional. Debug logs are off until you enable them.

## Development

The extension is a Manifest V3 project: React and TypeScript, bundled with Vite and the CRXJS plugin.

```bash
npm install
npm run dev      # Vite on port 5173
npm run lint
npm run build    # tsc -b && vite build
```

Load `dist/` as an unpacked extension while you work, and reload it after a build. Source lives in `src/`: the content script under `src/content`, the popup under `src/popup`, and the service worker under `src/background`. Shared config, memory, and interface strings are in `src/lib`.

## Package a release

```bash
npm run release
```

That builds `dist/` and writes `floator-<version>.zip` in the repo root. Zip files are gitignored. Upload that archive to the Chrome Web Store, or share it directly.

## Privacy and license

What leaves the browser, and what stays in local storage, is described in [PRIVACY.md](PRIVACY.md).

Floator is [MIT](LICENSE) licensed.

## Milestones

- **2026-02-06** — 1.0.1, first release
- **2026-03-13** — 1.1.0, Floator / 浮译 brand
- **2026-10-13** — 1.2.0, local vocabulary bank

History of each version is in [CHANGELOG.md](CHANGELOG.md).
