import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";

export type UiLanguageSetting = "auto" | "en" | "zh-cn" | "es";
export interface LocaleCatalog { meta: { locale: string; label: string }; strings: Record<string, string>; }

let cachedRoot = "";
let cachedCatalogs: Record<string, LocaleCatalog> = {};

export function loadLocaleCatalogs(extensionPath: string): Record<string, LocaleCatalog> {
  const root = path.join(extensionPath, "resources", "locales");
  if (root === cachedRoot && Object.keys(cachedCatalogs).length) return cachedCatalogs;
  const catalogs: Record<string, LocaleCatalog> = {};
  for (const locale of ["en", "zh-cn", "es"]) {
    const file = path.join(root, `${locale}.json`);
    catalogs[locale] = JSON.parse(fs.readFileSync(file, "utf8")) as LocaleCatalog;
  }
  cachedRoot = root;
  cachedCatalogs = catalogs;
  return catalogs;
}

export function uiLanguageSetting(): UiLanguageSetting {
  const value = vscode.workspace.getConfiguration("personalKnowledge").get<string>("uiLanguage", "auto");
  return value === "en" || value === "zh-cn" || value === "es" ? value : "auto";
}

export function resolveUiLanguage(setting = uiLanguageSetting(), vscodeLanguage = vscode.env.language): "en" | "zh-cn" | "es" {
  if (setting !== "auto") return setting;
  const language = String(vscodeLanguage || "").toLowerCase();
  if (language.startsWith("zh")) return "zh-cn";
  if (language.startsWith("es")) return "es";
  return "en";
}

export function localizedText(extensionPath: string, key: string, params: Record<string, string | number> = {}): string {
  const locale = resolveUiLanguage();
  const catalogs = loadLocaleCatalogs(extensionPath);
  let value = catalogs[locale]?.strings[key] || catalogs.en?.strings[key] || key;
  for (const [name, replacement] of Object.entries(params)) value = value.split(`{${name}}`).join(String(replacement));
  return value;
}
