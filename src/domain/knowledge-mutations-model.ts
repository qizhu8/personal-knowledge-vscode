import { basename } from "node:path";
import { CoreError } from "../contracts.js";

export type MutationKind = "note" | "skill" | "research";
export interface Citation { paper: string; note: string }

export function fail(code: string, message: string): never { throw new CoreError(code, message); }

export function categoryOf(path: string): string {
  const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
  return parent;
}

export function leafOf(path: string): string {
  return basename(path).replace(/\.md$/i, "");
}

export function canonicalCites(value: unknown, papers: readonly { slug: string; title: string }[], selfSlug: string): Citation[] {
  if (!Array.isArray(value)) return [];
  const byKey = new Map<string, string>();
  const byTitle = new Map<string, string>();
  for (const paper of papers) {
    byKey.set(paper.slug.toLowerCase(), paper.slug);
    byTitle.set(paper.title.toLowerCase(), paper.slug);
  }
  const output: Citation[] = [];
  for (const item of value) {
    let ref = "", note = "";
    if (typeof item === "string") ref = item.trim();
    else if (item && typeof item === "object" && !Array.isArray(item)) {
      const citation = item as Record<string, unknown>;
      ref = String(citation.paper ?? citation.key ?? citation.target ?? "").trim();
      note = String(citation.note ?? citation.comment ?? "");
    }
    if (!ref) continue;
    const key = ref.toLowerCase().replace(/\.md$/i, "");
    const target = byKey.get(key) ?? byTitle.get(key);
    if (target && target !== selfSlug) output.push({ paper: target, note });
  }
  return output;
}

export function assertMetadataValue(value: unknown, key: string): void {
  if (value === undefined) return;
  if (key === "links" && !Array.isArray(value)) fail("INVALID_ARGUMENT", "Knowledge links must be an array.");
}
