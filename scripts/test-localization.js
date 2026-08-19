#!/usr/bin/env node
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const locales = ["en", "zh-cn", "es"];
const catalogs = Object.fromEntries(locales.map(locale => [locale, JSON.parse(fs.readFileSync(path.join(root, "resources", "locales", `${locale}.json`), "utf8"))]));
const englishKeys = Object.keys(catalogs.en.strings).sort();
for (const locale of locales) {
  assert.strictEqual(catalogs[locale].meta.locale, locale);
  assert.deepStrictEqual(Object.keys(catalogs[locale].strings).sort(), englishKeys, `${locale} catalog keys must exactly match English`);
  for (const key of englishKeys) assert.ok(String(catalogs[locale].strings[key]).trim(), `${locale}:${key} must not be empty`);
}

const byEnglish = new Map();
for (const key of englishKeys) {
  const value = catalogs.en.strings[key];
  const previous = byEnglish.get(value);
  if (previous) {
    for (const locale of ["zh-cn", "es"]) {
      assert.strictEqual(catalogs[locale].strings[key], catalogs[locale].strings[previous], `Ambiguous English phrase "${value}" has different ${locale} translations`);
    }
  } else byEnglish.set(value, key);
}

const panel = fs.readFileSync(path.join(root, "dist", "webview", "panel.js"), "utf8");
const html = fs.readFileSync(path.join(root, "dist", "webview", "panel.html"), "utf8");
const extension = fs.readFileSync(path.join(root, "src", "extension.ts"), "utf8");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
for (const symbol of ["function t(", "function translateUi(", "function applyUiLanguage(", "new MutationObserver", "function changeUiLanguage("]) assert.ok(panel.includes(symbol), `missing localization runtime: ${symbol}`);
assert.ok(html.includes('meta name="pkm-i18n"'));
assert.ok(panel.includes('<option value="es"'));
assert.ok(extension.includes('case "setUiLanguage"'));
assert.ok(extension.includes("loadLocaleCatalogs"));
assert.deepStrictEqual(manifest.contributes.configuration.properties["personalKnowledge.uiLanguage"].enum, ["auto", "en", "zh-cn", "es"]);

const packageCatalogs = Object.fromEntries(["", ".zh-cn", ".es"].map(suffix => [suffix || ".en", JSON.parse(fs.readFileSync(path.join(root, `package.nls${suffix}.json`), "utf8"))]));
const packageKeys = Object.keys(packageCatalogs[".en"]).sort();
for (const [locale, catalog] of Object.entries(packageCatalogs)) assert.deepStrictEqual(Object.keys(catalog).sort(), packageKeys, `${locale} package.nls keys must match English`);
const manifestText = fs.readFileSync(path.join(root, "package.json"), "utf8");
for (const key of [...manifestText.matchAll(/%([a-z][A-Za-z0-9.]+)%/g)].map(match => match[1])) assert.ok(packageCatalogs[".en"][key], `manifest NLS key is missing: ${key}`);
assert.match(fs.readFileSync(path.join(root, "src", "localization.ts"), "utf8"), /language\.startsWith\("es"\)/);

console.log(`localization test: ${englishKeys.length} keys aligned across English, Simplified Chinese, and Spanish`);
