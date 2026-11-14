import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";

export type MarkdownAssetArea = "skills" | "notes" | "papers";

export interface MarkdownAsset {
  area: MarkdownAssetArea;
  path: string;
  fullPath: string;
  content: Buffer;
  digest: string;
}

export function isMarkdownAssetDirectory(name: string): boolean {
  return name === "_assets" || name.toLowerCase().endsWith(".assets");
}

export function markdownAssetDirectory(documentPath: string): string {
  if (!/\.md$/i.test(documentPath)) throw new Error("A Markdown document path is required.");
  return documentPath.replace(/\.md$/i, ".assets");
}

export function checkedMarkdownPath(root: string, relative: string): string {
  const parts = relative.replace(/\\/g, "/").split("/");
  if (parts.some(part => !part || part === "." || part === ".." || part.startsWith("."))) {
    throw new Error(`Invalid Markdown resource path: ${relative}`);
  }
  const full = path.resolve(root, ...parts);
  for (let current = full; current !== path.resolve(root); current = path.dirname(current)) {
    try {
      if (fs.lstatSync(current).isSymbolicLink()) throw new Error(`Symbolic links cannot be mutated as Markdown resources: ${relative}`);
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
    }
  }
  return full;
}

interface Reference { start: number; end: number; value: string; quoted?: boolean; }

export function encodeSegment(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, character => "%" + character.charCodeAt(0).toString(16).toUpperCase());
}

export function markdownReferences(markdown: string): Reference[] {
  const source = markdown.replace(/```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`/g, value => value.replace(/[^\n]/g, " "));
  const references: Reference[] = [];
  for (const match of source.matchAll(/!?\[/g)) {
    if ((source.slice(0, match.index).match(/\\+$/)?.[0].length || 0) % 2) continue;
    let cursor = match.index! + match[0].length, depth = 1;
    for (; cursor < source.length && source[cursor] !== "\n" && depth; cursor++) {
      if (source[cursor] === "\\") cursor++;
      else if (source[cursor] === "[") depth++;
      else if (source[cursor] === "]") depth--;
    }
    if (depth || source[cursor] !== "(") continue;
    cursor++;
    while (/\s/.test(source[cursor] || "") && cursor < source.length) cursor++;
    const angle = source[cursor] === "<", start = cursor + (angle ? 1 : 0);
    cursor = start; depth = 0;
    for (; cursor < source.length && source[cursor] !== "\n"; cursor++) {
      const character = source[cursor];
      if (character === "\\") { cursor++; continue; }
      if (angle) { if (character === ">") break; }
      else if (character === "(") depth++;
      else if (character === ")") { if (!depth) break; depth--; }
      else if (/\s/.test(character) && !depth) break;
    }
    if (cursor > start && !depth) references.push({ start, end: cursor, value: source.slice(start, cursor) });
  }
  for (const match of source.matchAll(/<(?:img|a|source)\b[^>]*?\b(?:src|href)\s*=\s*["']([^"']+)["']|^\s{0,3}\[[^\]\n]+\]:\s*(?:<([^>\n]+)>|([^\s]+))|^file:\s*("(?:\\.|[^"\\])*"|[^\r\n]+)/gim)) {
    const value = match.slice(1).find(value => value !== undefined);
    if (value === undefined) continue;
    const start = match.index! + match[0].lastIndexOf(value);
    const quoted = match[4]?.startsWith('"');
    references.push({ start, end: start + value.length, value: quoted ? JSON.parse(value) : value, quoted });
  }
  return references.sort((left, right) => left.start - right.start);
}

export function rewriteMarkdownAssetReferences(markdown: string, transform: (reference: string) => string): string {
  for (const reference of markdownReferences(markdown).reverse()) {
    const local = localAssetReference(reference.value);
    if (!local) continue;
    const replacement = transform(local);
    if (replacement === local) continue;
    const suffix = /[?#].*$/.exec(reference.value)?.[0] || "";
    const encoded = replacement.split("/").map(part => part === ".." ? part : encodeSegment(part)).join("/") + suffix;
    markdown = markdown.slice(0, reference.start) + (reference.quoted ? JSON.stringify(encoded) : encoded) + markdown.slice(reference.end);
  }
  return markdown;
}

export function ownedMarkdownAssetPaths(areaRoot: string, documentPath: string): string[] {
  const relative = markdownAssetDirectory(documentPath);
  const full = checkedMarkdownPath(areaRoot, relative);
  const files: string[] = [];
  const walk = (directory: string, prefix: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw new Error(`Symbolic links are not allowed in ${relative}.`);
      const child = `${prefix}/${entry.name}`;
      if (entry.isDirectory()) walk(path.join(directory, entry.name), child);
      else if (entry.isFile()) files.push(child);
    }
  };
  if (fs.existsSync(full)) walk(full, relative);
  return files;
}

export function assertMarkdownAssetsUnshared(areaRoot: string, documentPath: string, container?: string): void {
  assertMarkdownResourceTreeUnshared(areaRoot, markdownAssetDirectory(documentPath), documentPath, container);
}

export function assertMarkdownResourceTreeUnshared(areaRoot: string, resourcePath: string, documentPath = "", container?: string): void {
  if (path.posix.basename(resourcePath).toLowerCase() === "pkm-todo-board.json") {
    throw new Error("Todo Board authority is managed with its document, not as an editable/deletable asset.");
  }
  const reference = markdownResourceReferrer(areaRoot, resourcePath, documentPath, container);
  if (reference) throw new Error(`Resource is shared by ${reference}. Update its references before moving or deleting ${resourcePath}.`);
}

function markdownResourceReferrer(areaRoot: string, resourcePath: string, documentPath = "", container?: string): string | undefined {
  const owned = checkedMarkdownPath(areaRoot, resourcePath);
  if (!fs.existsSync(owned)) return undefined;
  const segments = resourcePath.split("/");
  const ownedIndex = segments.findIndex(segment => segment.toLowerCase().endsWith(".assets"));
  if (ownedIndex >= 0) {
    const owner = [...segments.slice(0, ownedIndex), segments[ownedIndex].slice(0, -7) + ".md"].join("/");
    if (owner !== documentPath && !(container && (owner === container || owner.startsWith(container + "/")))
      && fs.existsSync(checkedMarkdownPath(areaRoot, owner))) return owner;
  }
  const walk = (directory: string): string | undefined => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.name.startsWith(".") || entry.isSymbolicLink() || isMarkdownAssetDirectory(entry.name)) continue;
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        const found = walk(full);
        if (found) return found;
      }
      else if (/\.md$/i.test(entry.name) && full !== path.resolve(areaRoot, documentPath)
        && !(container && full.startsWith(path.resolve(areaRoot, container) + path.sep))) {
        const content = fs.readFileSync(full, "utf8");
        for (const { value } of markdownReferences(content)) {
          const reference = localAssetReference(value);
          if (!reference) continue;
          const target = path.resolve(path.dirname(full), reference);
          if (target === owned || target.startsWith(owned + path.sep)) {
            try { fs.statSync(target); }
            catch (error) {
              if (error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR")) continue;
              throw error;
            }
            return path.relative(areaRoot, full);
          }
        }
      }
    }
  };
  return walk(areaRoot);
}

export function rebaseMarkdownAssets(areaRoot: string, from: string, to: string, markdown: string, container?: { from: string; to: string }): string {
  const previous = checkedMarkdownPath(areaRoot, from);
  const next = checkedMarkdownPath(areaRoot, to);
  const previousAssets = checkedMarkdownPath(areaRoot, markdownAssetDirectory(from));
  const nextAssets = checkedMarkdownPath(areaRoot, markdownAssetDirectory(to));
  return rewriteMarkdownAssetReferences(markdown, reference => {
    const original = path.resolve(path.dirname(previous), reference);
    const relative = path.relative(areaRoot, original);
    if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Markdown resource escapes its content root.");
    if (!relative.split(path.sep).some(isMarkdownAssetDirectory)) return reference;
    const containerRoot = container ? path.resolve(areaRoot, container.from) : undefined;
    const target = containerRoot && original.startsWith(containerRoot + path.sep)
      ? path.resolve(areaRoot, container!.to, path.relative(containerRoot, original))
      : original.startsWith(previousAssets + path.sep) ? path.join(nextAssets, path.relative(previousAssets, original)) : original;
    return path.relative(path.dirname(next), target).replace(/\\/g, "/");
  });
}

export function localAssetReference(value: string): string | undefined {
  let reference = value.trim().replace(/&amp;/g, "&").replace(/[?#].*$/, "");
  if (!reference || reference.startsWith("/") || reference.startsWith("\\")
    || reference.startsWith("//") || /^[a-z][a-z0-9+.-]*:/i.test(reference)) return undefined;
  try { reference = decodeURIComponent(reference); } catch { return undefined; }
  return reference.replace(/\\([()[\] ])/g, "$1").replace(/\\/g, "/");
}

export function listedMarkdownAssets(
  knowledgeRoot: string,
  area: MarkdownAssetArea,
  documentPath: string,
  markdown: string,
): Array<Pick<MarkdownAsset, "area" | "path" | "fullPath">> {
  const areaRoot = path.resolve(knowledgeRoot, area);
  const realAreaRoot = fs.existsSync(areaRoot) ? fs.realpathSync(areaRoot) : areaRoot;
  const documentDirectory = path.dirname(path.resolve(areaRoot, documentPath));
  const assets = new Map<string, Pick<MarkdownAsset, "area" | "path" | "fullPath">>();
  const references = markdownReferences(markdown).map(reference => reference.value);
  for (const rawReference of [...references, ...ownedMarkdownAssetPaths(areaRoot, documentPath).map(file =>
    path.relative(documentDirectory, path.resolve(areaRoot, file)).split(path.sep).map(encodeSegment).join("/"))]) {
    const reference = localAssetReference(rawReference);
    if (!reference) continue;
    const fullPath = path.resolve(documentDirectory, reference);
    const relativePath = path.relative(areaRoot, fullPath).replace(/\\/g, "/");
    if (path.posix.basename(relativePath).toLowerCase() === "pkm-todo-board.json") continue;
    if (!relativePath || relativePath.startsWith("../") || path.isAbsolute(relativePath)
      || !relativePath.split("/").some(isMarkdownAssetDirectory)) continue;
    if (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile()) continue;
    const realPath = fs.realpathSync(fullPath);
    if (realPath !== realAreaRoot && !realPath.startsWith(`${realAreaRoot}${path.sep}`)) continue;
    assets.set(relativePath, {
      area,
      path: relativePath,
      fullPath: realPath,
    });
  }

  return [...assets.values()].sort((left, right) => left.path.localeCompare(right.path));
}

export function referencedMarkdownAssets(knowledgeRoot: string, area: MarkdownAssetArea, documentPath: string, markdown: string): MarkdownAsset[] {
  return listedMarkdownAssets(knowledgeRoot, area, documentPath, markdown).map(asset => {
    const content = fs.readFileSync(asset.fullPath);
    return { ...asset, content, digest: `sha256:${createHash("sha256").update(content).digest("hex")}` };
  });
}
