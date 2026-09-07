import * as fs from "fs";
import * as path from "path";

export type PrivacyContentType = "skills" | "notes" | "papers" | "prompts" | "packages" | "servers" | "scripts";

interface PrivacyState {
  schema: 1;
  private: Partial<Record<PrivacyContentType, string[]>>;
}

let storeRoot = "";
const validTypes = new Set<PrivacyContentType>(["skills", "notes", "papers", "prompts", "packages", "servers", "scripts"]);

export function setPrivacyStoreRoot(root: string): void {
  storeRoot = path.resolve(root);
}

function statePath(): string {
  if (!storeRoot) throw new Error("Knowledge Root is not configured.");
  return path.join(storeRoot, ".pkm", "content-privacy.json");
}

function normalizeTopLevel(value: string): string {
  const normalized = String(value || "").trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  if (!normalized || normalized.includes("/") || normalized === "." || normalized === "..") {
    throw new Error("Privacy can only be set on a real top-level folder.");
  }
  return normalized;
}

function readState(): PrivacyState {
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath(), "utf8"));
    if (parsed?.schema !== 1 || !parsed.private || typeof parsed.private !== "object") throw new Error("Privacy metadata has an unsupported format.");
    for (const [type, values] of Object.entries(parsed.private)) {
      if (!validTypes.has(type as PrivacyContentType) || !Array.isArray(values)) throw new Error("Privacy metadata contains an invalid entry.");
    }
    return parsed;
  } catch (error: any) {
    if (error?.code === "ENOENT") return { schema: 1, private: {} };
    throw new Error(`Cannot read content privacy metadata: ${error?.message || String(error)}`);
  }
}

function writeState(state: PrivacyState): void {
  const target = statePath();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(state, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporary, target);
}

export function privateTopLevels(type: PrivacyContentType): string[] {
  if (!validTypes.has(type)) return [];
  const values = readState().private[type];
  return [...new Set((Array.isArray(values) ? values : []).map(String).filter(Boolean))].sort((left, right) => left.localeCompare(right));
}

export function isTopLevelPrivate(type: PrivacyContentType, topLevel: string): boolean {
  if (!validTypes.has(type) || !topLevel) return false;
  return privateTopLevels(type).includes(String(topLevel).split(/[\\/]/)[0]);
}

export function isContentPathPrivate(type: PrivacyContentType, contentPath: string): boolean {
  const topLevel = String(contentPath || "").replace(/\\/g, "/").split("/").filter(Boolean)[0] || "";
  return isTopLevelPrivate(type, topLevel);
}

export function isContentItemPrivate(type: PrivacyContentType, item: any): boolean {
  if (type === "packages") return isTopLevelPrivate(type, String(item?.name || ""));
  if (type === "prompts") return isTopLevelPrivate(type, String(item?.project || ""));
  const contentPath = type === "skills"
    ? String(item?.metadata?.category ?? item?.category ?? "")
    : type === "scripts"
      ? String(item?.category === "(root)" ? "" : item?.category || "")
      : String(item?.category ?? item?.topic ?? "");
  return isContentPathPrivate(type, contentPath);
}

export function setTopLevelPrivacy(type: PrivacyContentType, topLevel: string, isPrivate: boolean): void {
  if (!validTypes.has(type)) throw new Error(`Unsupported privacy content type: ${type}`);
  const normalized = normalizeTopLevel(topLevel);
  const state = readState();
  const values = new Set((state.private[type] || []).map(String));
  if (isPrivate) values.add(normalized); else values.delete(normalized);
  if (values.size) state.private[type] = [...values].sort((left, right) => left.localeCompare(right));
  else delete state.private[type];
  writeState(state);
}

export function renameTopLevelPrivacy(type: PrivacyContentType, oldName: string, newName: string): void {
  const previous = normalizeTopLevel(oldName);
  const next = normalizeTopLevel(newName);
  if (!isTopLevelPrivate(type, previous) || previous === next) return;
  const state = readState();
  const values = new Set((state.private[type] || []).map(String));
  values.delete(previous);
  values.add(next);
  state.private[type] = [...values].sort((left, right) => left.localeCompare(right));
  writeState(state);
}
