import * as fs from "fs";
import * as path from "path";
import { createHash } from "crypto";
import { withCrossProcessLockSync } from "../runtime/cross-process-lock";
import { recordKnowledgeResourceMutation } from "./knowledge-deletion-journal";

export type MarkdownAssetArea = "skills" | "notes" | "papers";

export interface MarkdownAsset {
  area: MarkdownAssetArea;
  path: string;
  fullPath: string;
  content: Buffer;
  digest: string;
}

export function withMarkdownAssetMutation<T>(root: string, action: () => T): T {
  return withCrossProcessLockSync(path.join(root, ".pkm", "state", "markdown-assets.lock"), "Markdown resource mutation", action);
}

export interface MarkdownAssetDocument { area: MarkdownAssetArea; path: string; content: string; }

export function importMarkdownAssetBundle(
  root: string, value: unknown, documents: MarkdownAssetDocument[], prefix = "",
): void {
  return withMarkdownAssetMutation(root, () => importMarkdownAssetBundleUnlocked(root, value, documents, prefix));
}

function importMarkdownAssetBundleUnlocked(root: string, value: unknown, documents: MarkdownAssetDocument[], prefix: string): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) throw new Error("Markdown bundle assets must be an array.");
  const writes: Array<{ destination: string; content: Buffer }> = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || typeof entry.type !== "string" || !["skills", "notes", "papers"].includes(entry.type)
      || typeof entry.path !== "string" || typeof entry.data !== "string" || typeof entry.digest !== "string") {
      throw new Error("Invalid Markdown bundle resource.");
    }
    const areaRoot = path.resolve(root, entry.type);
    const original = checkedMarkdownPath(areaRoot, entry.path);
    const allowed = documents.filter(document => document.area === entry.type).some(document =>
      entry.path.startsWith(markdownAssetDirectory(document.path) + "/")
      || markdownReferences(document.content).some(reference => {
        const local = localAssetReference(reference.value);
        return local && path.resolve(areaRoot, path.posix.dirname(document.path), local) === original;
      }));
    if (!allowed || !entry.path.split("/").some(isMarkdownAssetDirectory)) throw new Error("Bundle resource is not owned or referenced by an imported document.");
    const content = Buffer.from(entry.data, "base64");
    if (content.toString("base64") !== entry.data || `sha256:${createHash("sha256").update(content).digest("hex")}` !== entry.digest) {
      throw new Error(`Markdown bundle resource checksum mismatch: ${entry.path}`);
    }
    const destination = checkedMarkdownPath(areaRoot, [prefix, entry.path].filter(Boolean).join("/"));
    if (fs.existsSync(destination) && !fs.readFileSync(destination).equals(content)) throw new Error(`Import would overwrite a different resource: ${entry.path}`);
    const previous = writes.find(write => write.destination === destination);
    if (previous && !previous.content.equals(content)) throw new Error(`Conflicting resource duplicates: ${entry.path}`);
    writes.push({ destination, content });
  }
  recordKnowledgeResourceMutation(root, [], writes.map(write => path.relative(root, write.destination).replace(/\\/g, "/")), () => {
    for (const write of writes) {
      fs.mkdirSync(path.dirname(write.destination), { recursive: true });
      if (!fs.existsSync(write.destination)) fs.writeFileSync(write.destination, write.content, { flag: "wx" });
      else if (!fs.readFileSync(write.destination).equals(write.content)) throw new Error("Import resource changed while applying the bundle. Existing bytes were preserved.");
    }
  });
}

export function markdownBundleDocuments(bundle: {
  skills?: Array<{ name: string; content?: string; metadata?: { category?: string } }>;
  notes?: Array<{ slug: string; title?: string; category?: string; content?: string }>;
  papers?: Array<{ slug?: string; title: string; category?: string; content?: string; file?: string }>;
}): MarkdownAssetDocument[] {
  return [
    ...(bundle.skills || []).map(item => ({ area: "skills" as const, path: [item.metadata?.category, item.name + ".md"].filter(Boolean).join("/"), content: item.content || "" })),
    ...(bundle.notes || []).map(item => ({ area: "notes" as const, path: `${item.slug}.md`, content: item.content || "" })),
    ...(bundle.papers || []).map(item => ({ area: "papers" as const, path: `${item.slug || [item.category, item.title].filter(Boolean).join("/")}.md`, content: `${item.file ? `file: ${JSON.stringify(item.file)}\n` : ""}${item.content || ""}` })),
  ];
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

function encodeSegment(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, character => "%" + character.charCodeAt(0).toString(16).toUpperCase());
}

function markdownReferences(markdown: string): Reference[] {
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

export function saveMarkdownAsset(root: string, area: MarkdownAssetArea, documentPath: string, name: string, content: Buffer): string {
  return withMarkdownAssetMutation(root, () => saveMarkdownAssetUnlocked(root, area, documentPath, name, content));
}

function saveMarkdownAssetUnlocked(root: string, area: MarkdownAssetArea, documentPath: string, name: string, content: Buffer): string {
  if (!content.length) throw new Error("A Markdown asset cannot be empty.");
  if (!name || path.basename(name) !== name || /[\\/:*?"<>|\u0000-\u001f]/.test(name) || name.startsWith(".")) {
    throw new Error("Choose a resource filename without path separators or reserved characters.");
  }
  const relative = `${markdownAssetDirectory(documentPath)}/${name}`;
  const full = checkedMarkdownPath(path.resolve(root, area), relative);
  if (fs.existsSync(full) && !fs.readFileSync(full).equals(content)) throw new Error(`Resource already exists: ${relative}`);
  recordKnowledgeResourceMutation(root, [], [`${area}/${relative}`], () => {
    fs.mkdirSync(path.dirname(full), { recursive: true });
    if (!fs.existsSync(full)) fs.writeFileSync(full, content, { flag: "wx" });
  });
  return encodeSegment(path.posix.basename(markdownAssetDirectory(documentPath))) + "/" + encodeSegment(name);
}

export interface MarkdownAssetMigration {
  schema: "pkm.markdown-assets.migration/v1";
  area: MarkdownAssetArea;
  documentPath: string;
  documentDigest: string;
  candidate: string;
  copies: Array<{ source: string; target: string; digest: string }>;
  removals: string[];
  sourceOverrides?: Record<string, string>;
}

export function missingLegacyMarkdownAssets(root: string, area: MarkdownAssetArea, documentPath: string, markdown: string): string[] {
  const areaRoot = path.resolve(root, area);
  const directory = path.dirname(checkedMarkdownPath(areaRoot, documentPath));
  return [...new Set(markdownReferences(markdown).flatMap(item => {
    const reference = localAssetReference(item.value);
    if (!reference) return [];
    const relative = path.relative(areaRoot, path.resolve(directory, reference)).replace(/\\/g, "/");
    if (!relative.split("/").includes("_assets")) return [];
    const full = checkedMarkdownPath(areaRoot, relative);
    return fs.existsSync(full) ? [] : [relative];
  }))];
}

export function previewMarkdownAssetMigration(root: string, area: MarkdownAssetArea, documentPath: string, sourceOverrides?: Record<string, string>): MarkdownAssetMigration {
  const areaRoot = path.resolve(root, area);
  const document = checkedMarkdownPath(areaRoot, documentPath);
  const markdown = fs.readFileSync(document, "utf8");
  const copies = new Map<string, MarkdownAssetMigration["copies"][number]>();
  const candidate = rewriteMarkdownAssetReferences(markdown, reference => {
    const source = path.resolve(path.dirname(document), reference);
    const relative = path.relative(areaRoot, source).replace(/\\/g, "/");
    if (!relative.split("/").includes("_assets")) return reference;
    const expected = checkedMarkdownPath(areaRoot, relative);
    const replacement = sourceOverrides?.[relative];
    if (replacement && !replacement.split("/").some(isMarkdownAssetDirectory)) {
      throw new Error("A missing resource can only be recovered from an existing Markdown resource directory.");
    }
    if (replacement && fs.existsSync(expected)) throw new Error(`The missing resource now exists: ${relative}. Preview again without a source override.`);
    const checked = replacement ? checkedMarkdownPath(areaRoot, replacement) : expected;
    const content = fs.readFileSync(checked);
    const digest = createHash("sha256").update(content).digest("hex");
    const target = `${markdownAssetDirectory(documentPath)}/${digest.slice(0, 16)}${path.extname(checked).toLowerCase()}`;
    const sourcePath = path.relative(areaRoot, checked).replace(/\\/g, "/");
    copies.set(sourcePath, { source: sourcePath, target, digest });
    const destination = checkedMarkdownPath(areaRoot, target);
    if (fs.existsSync(destination) && !fs.readFileSync(destination).equals(content)) throw new Error(`Resource collision: ${target}`);
    return path.relative(path.dirname(document), destination).replace(/\\/g, "/");
  });
  return {
    schema: "pkm.markdown-assets.migration/v1", area, documentPath,
    documentDigest: createHash("sha256").update(markdown).digest("hex"), candidate,
    copies: [...copies.values()],
    removals: [...copies.keys()].filter(source => !markdownResourceReferrer(areaRoot, source, documentPath)),
    ...(sourceOverrides ? { sourceOverrides: { ...sourceOverrides } } : {}),
  };
}

export function migrateMarkdownAssetsForLifecycleUnlocked(root: string, area: MarkdownAssetArea, documentPath: string, content?: string): string {
  const preview = previewMarkdownAssetMigration(root, area, documentPath);
  if (preview.copies.length) applyMarkdownAssetMigrationUnlocked(root, preview);
  if (content === undefined) return preview.candidate;
  const areaRoot = path.resolve(root, area);
  const directory = path.dirname(checkedMarkdownPath(areaRoot, documentPath));
  const destinations = new Map(preview.copies.map(copy => [path.resolve(areaRoot, copy.source), copy.target]));
  return rewriteMarkdownAssetReferences(content, reference => {
    const target = destinations.get(path.resolve(directory, reference));
    return target ? path.relative(directory, checkedMarkdownPath(areaRoot, target)).replace(/\\/g, "/") : reference;
  });
}

export function applyMarkdownAssetMigration(root: string, preview: MarkdownAssetMigration): void {
  return withMarkdownAssetMutation(root, () => applyMarkdownAssetMigrationUnlocked(root, preview));
}

function applyMarkdownAssetMigrationUnlocked(root: string, preview: MarkdownAssetMigration): void {
  const current = previewMarkdownAssetMigration(root, preview.area, preview.documentPath, preview.sourceOverrides);
  if (JSON.stringify(current) !== JSON.stringify(preview)) throw new Error("Document or resources changed after migration preview. Preview again; nothing was migrated.");
  for (const copy of current.copies) {
    const source = checkedMarkdownPath(path.resolve(root, current.area), copy.source);
    saveMarkdownAssetUnlocked(root, current.area, current.documentPath, path.posix.basename(copy.target), fs.readFileSync(source));
  }
  if (JSON.stringify(previewMarkdownAssetMigration(root, preview.area, preview.documentPath, preview.sourceOverrides)) !== JSON.stringify(preview)) {
    throw new Error("Document or sources changed during migration. Original references are retained; preview again.");
  }
  const document = checkedMarkdownPath(path.resolve(root, current.area), current.documentPath);
  const originals = current.removals.map(source => ({
    path: checkedMarkdownPath(path.resolve(root, current.area), source),
    content: fs.readFileSync(checkedMarkdownPath(path.resolve(root, current.area), source)),
  }));
  const originalDocument = fs.readFileSync(document);
  recordKnowledgeResourceMutation(root, current.removals.map(source => `${current.area}/${source}`), [], () => {
    const temporary = document + ".assets-migration.tmp";
    fs.writeFileSync(temporary, current.candidate, { flag: "wx" });
    try {
      fs.renameSync(temporary, document);
      for (const source of originals) fs.unlinkSync(source.path);
    } catch (error) {
      try {
        for (const source of originals) if (!fs.existsSync(source.path)) fs.writeFileSync(source.path, source.content, { flag: "wx" });
        fs.writeFileSync(document, originalDocument);
      } catch (rollback) { throw new Error(`Resource migration failed: ${String(error)}. Rollback failed: ${String(rollback)}. Inspect ${document}.`); }
      throw error;
    } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
  });
}

export function editMarkdownAsset(
  root: string, area: MarkdownAssetArea, documentPath: string, assetPath: string, newName?: string,
): void {
  return withMarkdownAssetMutation(root, () => editMarkdownAssetUnlocked(root, area, documentPath, assetPath, newName));
}

function editMarkdownAssetUnlocked(root: string, area: MarkdownAssetArea, documentPath: string, assetPath: string, newName?: string): void {
  const areaRoot = path.resolve(root, area);
  const owned = markdownAssetDirectory(documentPath);
  if (!assetPath.startsWith(owned + "/")) throw new Error("Legacy or shared resources require an explicit migration preview.");
  const source = checkedMarkdownPath(areaRoot, assetPath);
  const document = checkedMarkdownPath(areaRoot, documentPath);
  const original = fs.readFileSync(document, "utf8");
  assertMarkdownAssetsUnshared(areaRoot, documentPath);
  if (!newName) {
    if (markdownReferences(original).some(reference => {
      const local = localAssetReference(reference.value);
      return local && path.resolve(path.dirname(document), local) === source;
    })) throw new Error("This resource is referenced by the document. Remove its Markdown reference before deleting it.");
    recordKnowledgeResourceMutation(root, [`${area}/${assetPath}`], [], () => fs.unlinkSync(source));
    return;
  }
  if (path.basename(newName) !== newName || /[\\/:*?"<>|\u0000-\u001f]/.test(newName) || newName.startsWith(".")) {
    throw new Error("Choose a resource filename without path separators or reserved characters.");
  }
  const destination = checkedMarkdownPath(areaRoot, `${path.posix.dirname(assetPath)}/${newName}`);
  if (fs.existsSync(destination)) throw new Error("The resource rename target already exists.");
  const content = rewriteMarkdownAssetReferences(original, reference =>
    path.resolve(path.dirname(document), reference) === source ? path.relative(path.dirname(document), destination).replace(/\\/g, "/") : reference);
  recordKnowledgeResourceMutation(root, [`${area}/${assetPath}`], [`${area}/${path.relative(areaRoot, destination).replace(/\\/g, "/")}`], () => {
    fs.renameSync(source, destination);
    try { fs.writeFileSync(document, content); }
    catch (error) {
      try { fs.renameSync(destination, source); }
      catch (rollback) { throw new Error(`Resource rename failed: ${String(error)}. Rollback failed: ${String(rollback)}. Resource remains at ${destination}.`); }
      throw error;
    }
  });
}

function localAssetReference(value: string): string | undefined {
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
