# Privacy Policy (Floator)

Last updated: 2026-10-13

## Summary
Floator translates text selected by the user on web pages and text entered by the user in the extension popup.
The extension sends this text to a user-configured AI API endpoint to generate translation results.
The local vocabulary bank stores saved words, source sentences, and page URLs on this device only.
Enrichment and summary text is sent to the user-configured API only when the user saves a word or asks for a summary.

## Data We Process
Floator may process the following data when you use the extension:

- Website content:
  - Text you select on a page for in-page translation.
  - Text you type or paste into the popup translator.
- Authentication information:
  - API key you provide for your chosen AI endpoint.
- Extension settings:
  - API endpoint URL, model name, prompt, interface language, hover duration, keep-alive settings, and related preferences.
- Optional diagnostics:
  - If you enable debug logs, runtime status messages may appear in the console.
- Vocabulary bank, stored on this device only:
  - Words you choose to save, the source sentence, the page URL, and the page title.
  - Pronunciation, translation, explanation, and review summaries produced for those saved words.

## How We Use Data
We use this data only to:

- Perform translation and follow-up requests you explicitly trigger.
- Save vocabulary entries you explicitly add.
- Request a pronunciation, translation, and short explanation only when you save a word, and a review summary only when you ask for one.
- Authenticate requests to your configured API endpoint.
- Save your extension preferences.
- Support optional debugging and model keep-alive behavior.

## Data Sharing and Third Parties
Floator sends translation input data to the API endpoint you configure.
When you save a word, Floator also sends that word and its source sentence so the API can return pronunciation, a translation, and a short explanation.
When you ask for a vocabulary summary, Floator sends recent saved entries to that API.
Page URLs and titles in the vocabulary bank stay on the device and are not sent for enrichment or summary.
This endpoint may be a local service (for example, LM Studio) or a third-party provider.
How that provider handles data is governed by its own privacy policy and deployment configuration.

Floator does not sell personal data.

## Storage and Retention
Settings are stored in `chrome.storage.sync` so they can sync with your Chrome profile.
Translation responses may be cached locally by the extension to improve performance.
The vocabulary bank is stored only in `chrome.storage.local` on this device, under the key `floatorMemory`. It is not synced. It holds saved words, source sentences, and page URLs, along with enrichment and summary text.

You can clear or change settings at any time in the popup.
Uninstalling the extension removes its local extension data from your browser profile.

## What We Do Not Intentionally Collect
Floator does not intentionally collect account profiles, payment details, or device identifiers.
Floator does not track unrelated browsing behavior for advertising purposes.

## Your Controls
You can:

- Update or remove your API endpoint and API key at any time.
- Disable keep-alive and debug logs in settings.
- Stop all extension processing by disabling or uninstalling the extension.

## Security
Data is transmitted only when you trigger extension actions.
You are responsible for the security and trustworthiness of the API endpoint you configure.

## Contact
For questions about this policy, please open an issue in this repository.
