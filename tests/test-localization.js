#!/usr/bin/env node
const assert = require("assert");
const fs = require("fs");
const Module = require("module");
const path = require("path");

const root = path.join(__dirname, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "resources", "locales", "manifest.json"), "utf8"));
const locales = manifest.locales.map(locale => locale.id);
assert.strictEqual(new Set(locales).size, locales.length, "locale IDs must be unique");
assert.strictEqual(new Set(manifest.locales.map(locale => locale.label)).size, locales.length, "native locale labels must be unique");
const catalogs = Object.fromEntries(locales.map(locale => [locale, JSON.parse(fs.readFileSync(path.join(root, "resources", "locales", `${locale}.json`), "utf8"))]));
const englishKeys = Object.keys(catalogs.en.strings).sort();
const placeholders = value => [...String(value).matchAll(/\{([A-Za-z][A-Za-z0-9]*)\}/g)].map(match => match[1]).sort();
for (const locale of locales) {
  assert.strictEqual(catalogs[locale].meta.locale, locale);
  assert.deepStrictEqual(Object.keys(catalogs[locale].strings).sort(), englishKeys, `${locale} catalog keys must exactly match English`);
  for (const key of englishKeys) assert.ok(String(catalogs[locale].strings[key]).trim(), `${locale}:${key} must not be empty`);
  for (const key of englishKeys) assert.deepStrictEqual(placeholders(catalogs[locale].strings[key]), placeholders(catalogs.en.strings[key]), `${locale}:${key} placeholders must match English`);
  assert.strictEqual(catalogs[locale].meta.label, manifest.locales.find(item => item.id === locale).label);
}

const byEnglish = new Map();
for (const key of englishKeys) {
  const value = catalogs.en.strings[key];
  const previous = byEnglish.get(value);
  if (previous) {
    for (const locale of locales.filter(locale => locale !== "en")) {
      assert.strictEqual(catalogs[locale].strings[key], catalogs[locale].strings[previous], `Ambiguous English phrase "${value}" has different ${locale} translations`);
    }
  } else byEnglish.set(value, key);
}

const panel = fs.readFileSync(path.join(root, "dist", "webview", "panel.js"), "utf8");
const html = fs.readFileSync(path.join(root, "dist", "webview", "panel.html"), "utf8");
const extension = fs.readFileSync(path.join(root, "src", "extension.ts"), "utf8");
const packageManifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
for (const symbol of ["function t(", "function translateUi(", "function applyUiLanguage(", "new MutationObserver", "function changeUiLanguage("]) assert.ok(panel.includes(symbol), `missing localization runtime: ${symbol}`);
assert.ok(html.includes('meta name="pkm-i18n"'));
assert.ok(panel.includes("function languageOptionsHtml("));
assert.ok(panel.includes("document.documentElement.dir"));
assert.ok(extension.includes('case "setUiLanguage"'));
assert.ok(extension.includes("loadLocaleCatalogs"));
assert.deepStrictEqual(packageManifest.contributes.configuration.properties["personalKnowledge.uiLanguage"].enum, ["auto", ...locales]);
assert.deepStrictEqual(packageManifest.contributes.configuration.properties["personalKnowledge.uiLanguage"].enumDescriptions.slice(1), manifest.locales.map(locale => locale.label));

const packageCatalogs = Object.fromEntries(manifest.locales.map(locale => [locale.id, JSON.parse(fs.readFileSync(path.join(root, `package.nls${locale.id === "en" ? "" : `.${locale.packageNls || locale.id}`}.json`), "utf8"))]));
const packageKeys = Object.keys(packageCatalogs.en).sort();
for (const [locale, catalog] of Object.entries(packageCatalogs)) assert.deepStrictEqual(Object.keys(catalog).sort(), packageKeys, `${locale} package.nls keys must match English`);
for (const [locale, catalog] of Object.entries(packageCatalogs)) for (const key of packageKeys) assert.deepStrictEqual(placeholders(catalog[key]), placeholders(packageCatalogs.en[key]), `${locale}:${key} package.nls placeholders must match English`);
const manifestText = fs.readFileSync(path.join(root, "package.json"), "utf8");
for (const key of [...manifestText.matchAll(/%([a-z][A-Za-z0-9.]+)%/g)].map(match => match[1])) assert.ok(packageCatalogs.en[key], `manifest NLS key is missing: ${key}`);
const previewSource = fs.readFileSync(path.join(root, "scripts", "release-preview-server.js"), "utf8");
assert.match(previewSource, /localeManifest\.locales\.map/);
assert.match(previewSource, /locales: localeManifest\.locales/);
assert.doesNotMatch(previewSource, /\["en",\s*"zh-cn",\s*"es"\]/);
assert.match(fs.readFileSync(path.join(root, "src", "localization.ts"), "utf8"), /loadLocaleManifest/);
assert.strictEqual(manifest.locales.find(locale => locale.id === "ar").direction, "rtl");
for (const key of ["nav.runningPort", "nav.startingPort", "nav.stoppedPort", "config.outdatedVersion", "config.regenerateServerTransition", "config.updateSkill"]) {
  assert.match(catalogs.ar.strings[key], /\u2066.*\u2069/u, `Arabic ${key} must isolate its LTR fragment`);
}

const originalRequire = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === "vscode") return { workspace: { getConfiguration: () => ({ get: () => "auto" }) }, env: { language: "en" }, extensions: { getExtension: () => undefined } };
  return originalRequire.apply(this, arguments);
};
const localization = require(path.join(root, "dist", "localization.js"));
Module.prototype.require = originalRequire;
const expectedAutoMappings = {
  "zh-CN": "zh-hans", "zh-SG": "zh-hans", "zh-Hans": "zh-hans", "zh-HK": "en", "zh-Hant": "en", ja: "ja", ko: "ko", "fr-CA": "fr",
  de: "de", "pt-PT": "pt-br", it: "it", ru: "ru", "ar-SA": "ar", unsupported: "en",
};
for (const [language, expected] of Object.entries(expectedAutoMappings)) {
  assert.strictEqual(localization.resolveUiLanguage("auto", language, root), expected, `Auto locale mapping failed for ${language}`);
}
assert.strictEqual(localization.resolveUiLanguage("zh-cn", "en", root), "zh-hans", "Legacy zh-cn setting must migrate to zh-hans");

console.log(`localization test: ${englishKeys.length} keys aligned across ${locales.length} locales (${manifest.locales.map(locale => locale.label).join(", ")})`);
