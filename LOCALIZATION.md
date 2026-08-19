# Localization

Personal Knowledge Manager supports these panel languages:

- `en` — English
- `zh-cn` — Simplified Chinese
- `es` — Spanish

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

## Language Resolution

`personalKnowledge.uiLanguage` accepts:

- `auto` — follow VS Code (`zh*` → `zh-cn`, `es*` → `es`, otherwise `en`)
- `en`
- `zh-cn`
- `es`

Changing the language in Config updates the current panel immediately and persists globally.
