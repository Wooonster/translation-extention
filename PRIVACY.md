# Privacy Policy (Floator)

Last updated: 2026-03-17

## Summary
Floator translates text selected by the user on web pages and text entered by the user in the extension popup.
The extension sends this text to a user-configured AI API endpoint to generate translation results.

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

## How We Use Data
We use this data only to:

- Perform translation and follow-up requests you explicitly trigger.
- Authenticate requests to your configured API endpoint.
- Save your extension preferences.
- Support optional debugging and model keep-alive behavior.

## Data Sharing and Third Parties
Floator sends translation input data to the API endpoint you configure.
This endpoint may be a local service (for example, LM Studio) or a third-party provider.
How that provider handles data is governed by its own privacy policy and deployment configuration.

Floator does not sell personal data.

## Storage and Retention
Settings are stored in `chrome.storage.sync` so they can sync with your Chrome profile.
Translation responses may be cached locally by the extension to improve performance.

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
