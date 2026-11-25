import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

type RetainedAssets = {
  listedMarkdownAssets(root: string, area: "skills" | "notes" | "papers", document: string, markdown: string): Array<{ path: string }>;
  rewriteMarkdownAssetReferences(markdown: string, transform: (reference: string) => string): string;
  isMarkdownAssetDirectory(name: string): boolean;
};

let retained: RetainedAssets | undefined;
export function legacyMarkdownAssets(): RetainedAssets {
  if (retained) return retained;
  const candidates = [
    new URL("../legacy/dist/knowledge/markdown-assets.js", import.meta.url),
    new URL("../legacy/dist/knowledge/markdown-assets.js", import.meta.url),
  ];
  const source = candidates.find(candidate => existsSync(candidate));
  if (!source) throw new Error("Retained Markdown asset implementation is unavailable.");
  retained = createRequire(import.meta.url)(fileURLToPath(source)) as RetainedAssets;
  if (typeof retained.listedMarkdownAssets !== "function" || typeof retained.rewriteMarkdownAssetReferences !== "function"
    || typeof retained.isMarkdownAssetDirectory !== "function") throw new Error("Retained Markdown asset implementation is invalid.");
  return retained;
}

export function skillAssetPaths(document: string, markdown: string, paths: Iterable<string>): Set<string> {
  const assets = legacyMarkdownAssets(), all = new Set(paths);
  const owned = new Set([...all].filter(file => file.startsWith(document.replace(/\.md$/i, ".assets/"))));
  assets.rewriteMarkdownAssetReferences(markdown, reference => {
    const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(document), reference));
    if (!resolved.startsWith("skills/")) throw new Error("Skill reference escapes the Skills area.");
    if (all.has(resolved) && resolved.split("/").slice(1, -1).some(assets.isMarkdownAssetDirectory)) owned.add(resolved);
    return reference;
  });
  return owned;
}
