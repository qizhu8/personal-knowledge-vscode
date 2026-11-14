import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { CoreError, type StorageRequest } from "./contracts.js";
import { resourcePath } from "./document-path.js";
import { isMarkdownAssetDirectory, listedMarkdownAssets, localAssetReference, markdownAssetDirectory, markdownReferences } from "./domain/markdown-assets.js";
import type { KnowledgeDiagnostic } from "./domain/knowledge-contracts.js";
import { sha256, type MarkdownRecord } from "./markdown.js";

const fileLimit = 16_777_216;
function checkedResource(areaRoot: string, path: string) {
  if (!resourcePath.safeParse(path).success) throw new CoreError("INVALID_DOCUMENT", `Unsupported Markdown resource path: ${path}`);
  const parts = path.split("/");
  let full = areaRoot;
  for (let index = -1; index < parts.length; index++) {
    if (index >= 0) full = join(full, parts[index]!);
    let stat;
    try { stat = lstatSync(full); }
    catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
      throw error;
    }
    if (stat.isSymbolicLink() || !(stat.isFile() || stat.isDirectory())) throw new CoreError("INVALID_DOCUMENT", `Resources must be regular files/directories, not links: ${path}`);
    if (index < parts.length - 1 && !stat.isDirectory()) throw new CoreError("INVALID_DOCUMENT", `A resource parent is not a directory: ${path}`);
    if (index === parts.length - 1) return { full, stat };
  }
  throw new CoreError("INVALID_DOCUMENT", "Resource path has no destination.");
}

function catalog(root: string, document: MarkdownRecord) {
  const areaRoot = join(root, document.record.area);
  const roots = new Set([markdownAssetDirectory(document.record.path)]);
  const diagnostics: KnowledgeDiagnostic[] = [];
  for (const reference of markdownReferences(document.raw)) {
    const local = localAssetReference(reference.value);
    if (!local) continue;
    const path = relative(areaRoot, resolve(areaRoot, dirname(document.record.path), local)).replaceAll("\\", "/");
    if (path === ".." || path.startsWith("../") || isAbsolute(path)) {
      diagnostics.push({ code: "outside-area", pointer: reference.value, message: "Local reference escapes the knowledge area and was not accessed." });
      continue;
    }
    const parts = path.split("/"), index = parts.findIndex(isMarkdownAssetDirectory);
    if (index < 0) continue;
    roots.add(parts.slice(0, index + 1).join("/"));
    const target = checkedResource(areaRoot, path);
    if (!target) diagnostics.push({ code: "missing-resource", pointer: path, message: "Referenced Markdown resource is missing; the document was not rewritten." });
    else if (!target.stat.isFile()) diagnostics.push({ code: "not-a-file", pointer: path, message: "Reference identifies a resource directory, not a readable file." });
  }
  const visited = new Set<string>();
  let bytes = 0;
  function guard(path: string, depth: number) {
    if (visited.has(path)) return;
    visited.add(path);
    if (visited.size > 2048) throw new CoreError("INVALID_DOCUMENT", "Resource catalog exceeds 2048 entries.");
    const entry = checkedResource(areaRoot, path);
    if (!entry) return;
    if (entry.stat.isDirectory()) {
      if (depth > 32) throw new CoreError("INVALID_DOCUMENT", "Resource catalog exceeds 32 directory levels.");
      for (const name of readdirSync(entry.full).sort()) guard(`${path}/${name}`, depth + 1);
    } else {
      bytes += entry.stat.size;
      if (entry.stat.size > fileLimit || bytes > 67_108_864) throw new CoreError("INVALID_DOCUMENT", "Resource read limits are 16 MiB per file and 64 MiB per catalog.");
    }
  }
  for (const path of roots) guard(path, 0);
  let observedBytes = 0;
  const assets = listedMarkdownAssets(root, document.record.area, document.record.path, document.raw).map(asset => {
    const entry = checkedResource(areaRoot, asset.path);
    if (!entry || !entry.stat.isFile()) throw new CoreError("CONFLICT", "Resource changed while reading its catalog; retry discovery.");
    const content = readFileSync(entry.full);
    observedBytes += content.length;
    if (content.length > fileLimit || observedBytes > 67_108_864) throw new CoreError("CONFLICT", "Resources grew beyond the read limits during discovery.");
    return { area: asset.area, path: asset.path, digest: `sha256:${sha256(content)}`, size: content.length };
  });
  return { assets, diagnostics, areaRoot };
}

export function readDocumentAssets(root: string, document: MarkdownRecord, { operation, args }: StorageRequest) {
  if (operation === "knowledge.asset.get" && args.expectedDocumentSha256 !== document.record.sha256) throw new CoreError("CONFLICT", "Document changed; rediscover resources before reading chunks.");
  const { assets, diagnostics, areaRoot } = catalog(root, document);
  if (operation === "knowledge.asset.list") {
    const revision = sha256(JSON.stringify([document.record.sha256, assets]));
    if (args.revision !== undefined && args.revision !== revision) throw new CoreError("CONFLICT", "Resources changed; restart resource pagination.");
    const items = assets.slice(Number(args.offset), Number(args.offset) + Number(args.limit));
    const next = Number(args.offset) + items.length;
    return {
      id: document.record.id, area: document.record.area, documentSha256: document.record.sha256,
      revision, items, total: assets.length, nextOffset: next < assets.length ? next : null, diagnostics,
    };
  }
  if (String(args.path).split("/").at(-1)?.toLowerCase() === "pkm-todo-board.json") throw new CoreError("ACCESS_DENIED", "Todo backing data must be read through Board operations, not the resource API.");
  const asset = assets.find(item => item.path === args.path);
  if (!asset) throw new CoreError("NOT_FOUND", "Resource is not owned by or referenced from this document.");
  if (asset.digest !== args.expectedDigest) throw new CoreError("CONFLICT", "Resource digest changed; rediscover before reading chunks.");
  const entry = checkedResource(areaRoot, asset.path);
  if (!entry || !entry.stat.isFile() || entry.stat.size > fileLimit) throw new CoreError("CONFLICT", "Resource changed after discovery.");
  const content = readFileSync(entry.full);
  if (content.length > fileLimit || `sha256:${sha256(content)}` !== args.expectedDigest) throw new CoreError("CONFLICT", "Resource digest changed; rediscover before reading chunks.");
  const offset = Number(args.offset);
  if (offset > content.length) throw new CoreError("INVALID_ARGUMENT", "Resource offset exceeds its byte length.");
  const end = Math.min(content.length, offset + Number(args.length));
  return {
    ...asset, id: document.record.id, documentSha256: document.record.sha256,
    offset, data: content.subarray(offset, end).toString("base64"), nextOffset: end < content.length ? end : null,
  };
}
