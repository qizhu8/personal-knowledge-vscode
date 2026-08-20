# Localization

Personal Knowledge Manager supports these panel languages:

- `en` — English
- `zh-hans` — 简体中文 (`zh-cn` is accepted as a compatibility alias)
- `es` — Español
- `ja` — 日本語
- `ko` — 한국어
- `fr` — Français
- `de` — Deutsch
- `pt-br` — Português (Brasil)
- `it` — Italiano
- `ru` — Русский
- `ar` — العربية

## Catalogs

Runtime panel/navigation strings and locale registration live in:

```text
resources/locales/manifest.json
resources/locales/<locale>.json
```

All catalogs must contain exactly the same keys. English is the source language and fallback.

VS Code-owned surfaces such as Command Palette titles and the Activity Bar view name use:

```text
package.nls.json
package.nls.<locale>.json
```

These follow the VS Code display language. The Config language selector controls the PKM webview and dynamic navigation without reloading the panel.

## Adding UI Text

1. Add a semantic key to every runtime catalog.
2. Use `t('key')` in dynamic webview templates.
3. For static HTML, use `data-i18n="key"`.
4. For attributes, use `data-i18n-title`, `data-i18n-placeholder`, or `data-i18n-aria-label`.
5. For extension-native dynamic text, use `localizedText(context.extensionPath, 'key', params)`.
6. For manifest text, use `%key%` and add the key to every `package.nls*.json` file.
7. Run `npm run test:localization`.

The runtime translator also maps cataloged English phrases in legacy templates and observes dynamic DOM updates. New UI should prefer explicit keys so translations do not depend on exact English phrasing.

## Adding a Language

1. Copy `resources/locales/en.json`, set its locale and native label, and translate every string value without changing keys.
2. Add one entry to `resources/locales/manifest.json`, including native label, VS Code language prefixes, and `direction: "rtl"` when applicable.
3. Add the locale ID and native label to the `personalKnowledge.uiLanguage` enum. The Config selector and runtime catalog loading are generated from the locale manifest.
4. Add the corresponding `package.nls.<locale>.json` for VS Code-owned surfaces.
5. Run `tests/test-localization.js`; it discovers locales from the manifest and enforces catalog/NLS key parity, placeholders, labels, Settings alignment, Auto resolution, and RTL metadata.
6. Run `npm run test:localization` and exercise live switching without reloading the panel.

Language choices must always use native names, such as `English`, `简体中文`, `日本語`, and `العربية`, so users can recognize their language before changing the UI.

## Language Resolution

`personalKnowledge.uiLanguage` accepts:

- `auto` — follow the longest matching `vscodePrefixes` entry in `resources/locales/manifest.json`, otherwise use `en`
- any locale ID registered in the manifest

Changing the language in Config updates the current panel immediately and persists globally.
