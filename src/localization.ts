import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";

export type UiLanguageSetting = "auto" | string;
export interface LocaleCatalog { meta: { locale: string; label: string }; strings: Record<string, string>; }
export interface LocaleDefinition { id: string; label: string; aliases?: string[]; packageNls?: string; vscodePrefixes: string[]; direction?: "ltr" | "rtl"; }
export interface LocaleManifest { locales: LocaleDefinition[]; }

let cachedRoot = "";
let cachedCatalogs: Record<string, LocaleCatalog> = {};
let cachedManifest: LocaleManifest | undefined;

export function loadLocaleManifest(extensionPath: string): LocaleManifest {
  const root = path.join(extensionPath, "resources", "locales");
  if (root === cachedRoot && cachedManifest) return cachedManifest;
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8")) as LocaleManifest;
  if (!manifest.locales.some(locale => locale.id === "en")) throw new Error("Locale manifest must include English.");
  cachedRoot = root;
  cachedManifest = manifest;
  return manifest;
}

export function normalizeUiLanguage(extensionPath: string, value: string): string | undefined {
  const normalized = String(value || "").toLowerCase();
  return loadLocaleManifest(extensionPath).locales.find(locale => locale.id === normalized || locale.aliases?.includes(normalized))?.id;
}

export function isSupportedUiLanguage(extensionPath: string, value: string): boolean {
  return !!normalizeUiLanguage(extensionPath, value);
}

export function loadLocaleCatalogs(extensionPath: string): Record<string, LocaleCatalog> {
  const root = path.join(extensionPath, "resources", "locales");
  if (root === cachedRoot && Object.keys(cachedCatalogs).length) return cachedCatalogs;
  const catalogs: Record<string, LocaleCatalog> = {};
  for (const locale of loadLocaleManifest(extensionPath).locales) {
    const file = path.join(root, `${locale.id}.json`);
    catalogs[locale.id] = JSON.parse(fs.readFileSync(file, "utf8")) as LocaleCatalog;
  }
  cachedRoot = root;
  cachedCatalogs = catalogs;
  return catalogs;
}

export function uiLanguageSetting(extensionPath = vscode.extensions.getExtension("Uone.personal-knowledge")?.extensionPath || path.join(__dirname, "..")): UiLanguageSetting {
  const value = vscode.workspace.getConfiguration("personalKnowledge").get<string>("uiLanguage", "auto");
  if (value === "auto") return "auto";
  return normalizeUiLanguage(extensionPath, value) || "auto";
}

export function resolveUiLanguage(setting: UiLanguageSetting | undefined = undefined, vscodeLanguage = vscode.env.language, extensionPath = vscode.extensions.getExtension("Uone.personal-knowledge")?.extensionPath || path.join(__dirname, "..")): string {
  setting ??= uiLanguageSetting(extensionPath);
  if (setting !== "auto") return normalizeUiLanguage(extensionPath, setting) || "en";
  const language = String(vscodeLanguage || "").toLowerCase();
  const matches = loadLocaleManifest(extensionPath).locales
    .flatMap(locale => locale.vscodePrefixes.map(prefix => ({ id: locale.id, prefix: prefix.toLowerCase() })))
    .sort((left, right) => right.prefix.length - left.prefix.length);
  return matches.find(match => language === match.prefix || language.startsWith(`${match.prefix}-`))?.id || "en";
}

export function localizedText(extensionPath: string, key: string, params: Record<string, string | number> = {}): string {
  const locale = resolveUiLanguage(uiLanguageSetting(extensionPath), vscode.env.language, extensionPath);
  const catalogs = loadLocaleCatalogs(extensionPath);
  let value = catalogs[locale]?.strings[key] || catalogs.en?.strings[key] || key;
  for (const [name, replacement] of Object.entries(params)) value = value.split(`{${name}}`).join(String(replacement));
  return value;
}
