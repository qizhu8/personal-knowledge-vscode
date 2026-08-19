# Localization

Personal Knowledge Manager supports these panel languages:

- `en` — English
- `zh-cn` — 简体中文
- `es` — Español

## Catalogs

Runtime panel/navigation strings live in:

```text
resources/locales/en.json
resources/locales/zh-cn.json
resources/locales/es.json
```

All catalogs must contain exactly the same keys. English is the source language and fallback.

VS Code-owned surfaces such as Command Palette titles and the Activity Bar view name use:

```text
package.nls.json
package.nls.zh-cn.json
package.nls.es.json
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
2. Register the locale in `src/localization.ts`, including Auto language resolution when applicable.
3. Add its native-name option to the Config selector and `personalKnowledge.uiLanguage` enum.
4. Add the corresponding `package.nls.<locale>.json` for VS Code-owned surfaces.
5. Add the locale to `tests/test-localization.js`; key parity and non-empty values are then enforced automatically.
6. Run `npm run test:localization` and exercise live switching without reloading the panel.

Language choices must always use native names, such as `English`, `简体中文`, and `Español`, so users can recognize their language before changing the UI.

## Language Resolution

`personalKnowledge.uiLanguage` accepts:

- `auto` — follow VS Code (`zh*` → `zh-cn`, `es*` → `es`, otherwise `en`)
- `en`
- `zh-cn`
- `es`

Changing the language in Config updates the current panel immediately and persists globally.
