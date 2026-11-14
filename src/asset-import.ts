import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { basename, join, posix } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { isDeepStrictEqual } from "node:util";
import { CoreError, documentId, type StorageRequest } from "./contracts.js";
import { checkedDocumentPath, checkedResourcePath, documentPath, knowledgeArea, resourcePath } from "./document-path.js";
import { isMarkdownAssetDirectory, localAssetReference, markdownAssetDirectory, markdownReferences } from "./domain/markdown-assets.js";
import { atomicFileCreateNoReplace, sha256 } from "./file-write.js";
import { decodeMarkdown, encodeMarkdown, readMarkdown, scanMarkdown } from "./markdown.js";
import { compileKnowledgeIdentityV1, compileKnowledgeLinksV1, KNOWLEDGE_SCHEMA_V1, legacyKnowledgeAlias } from "./domain/knowledge-contracts.js";

// Internal Storage.request operation: deliberately absent from the public capability registry, so Core cannot dispatch it.
export const assetImportOperation = "knowledge.upload.bundle-import.internal";
export const assetImportLimits = Object.freeze({ documents: 4096, assets: 2048, fileBytes: 16_777_216, totalBytes: 67_108_864 });
const assetDigest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const hex = z.string().regex(/^[a-f0-9]{64}$/);
const prefixSchema = z.string().max(200).regex(/^(?:[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*)?$/);
const importMetadata = z.strictObject({
  name: z.string().optional(), description: z.string().optional(), type: z.string().optional(),
  tags: z.array(z.string()).optional(), source_project: z.string().optional(), created: z.string().optional(),
  pinned: z.boolean().optional(), authors: z.array(z.string()).optional(), year: z.number().int().nullable().optional(),
  topic: z.string().optional(), publisher: z.string().optional(), url: z.string().optional(), file: z.string().optional(),
  conclusions: z.array(z.string()).optional(), implementation: z.array(z.string()).optional(),
  assumptions: z.array(z.string()).optional(), kind: z.string().optional(), group: z.string().optional(),
  links: z.array(z.unknown()).optional(), cites: z.array(z.unknown()).optional(),
});
const sourceIdentity = z.strictObject({
  schema: z.literal(KNOWLEDGE_SCHEMA_V1).optional(),
  knowledgeId: z.string().regex(/^knowledge_[a-f0-9]{24}$/).optional(),
  revision: z.number().int().positive().safe().optional(), aliases: z.array(z.string()).optional(),
}).refine(value => (value.schema === undefined) === (value.knowledgeId === undefined));
const inputSchema = z.strictObject({
  operationId: z.string().uuid(), prefix: prefixSchema.default(""),
  documents: z.array(z.strictObject({ area: knowledgeArea, path: documentPath, content: z.string(), title: z.string().min(1).max(500).optional(), metadata: importMetadata.optional(), identity: sourceIdentity.optional() })).max(assetImportLimits.documents),
  assets: z.array(z.strictObject({ type: knowledgeArea, path: resourcePath, data: z.string().max(22_369_624), digest: assetDigest })).max(assetImportLimits.assets),
});
const receiptSchema = z.strictObject({
  operationId: z.string().uuid(), prefix: prefixSchema,
  documents: z.array(z.strictObject({ area: knowledgeArea, path: documentPath, id: documentId, sha256: hex, created: z.boolean() })).max(assetImportLimits.documents),
  resources: z.array(z.strictObject({ area: knowledgeArea, path: resourcePath, digest: assetDigest, size: z.number().int().min(0).max(assetImportLimits.fileBytes) })).max(assetImportLimits.assets),
  created: z.number().int().min(0).max(assetImportLimits.assets),
});
const journalSchema = z.strictObject({
  root: z.string().min(1), prefix: prefixSchema,
  documents: z.array(z.strictObject({
    area: knowledgeArea, path: documentPath, id: documentId, sha256: hex, write: z.boolean(), raw: z.string().nullable(),
  })).max(assetImportLimits.documents),
  assets: z.array(z.strictObject({ area: knowledgeArea, source: resourcePath, destination: resourcePath, data: z.string(), digest: assetDigest })).max(assetImportLimits.assets),
  citationTargets: z.array(z.strictObject({ path: documentPath, id: documentId, sha256: hex })).max(20_000).default([]),
});
type Journal = z.infer<typeof journalSchema>;
export type AssetBundleImportResult = z.infer<typeof receiptSchema>;
export const assetImportDefinition = { id: assetImportOperation, readOnly: false, input: inputSchema, output: receiptSchema } as const;

function fail(code: string, message: string): never { throw new CoreError(code, message); }
const joined = (prefix: string, path: string) => prefix ? `${prefix}/${path}` : path;

function existingBytes(full: string) {
  let stat;
  try { stat = lstatSync(full); }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > assetImportLimits.fileBytes) fail("INVALID_DOCUMENT", "Resource destination must be a regular file under 16 MiB.");
  return readFileSync(full);
}

function destination(root: string, area: z.infer<typeof knowledgeArea>, path: string, create: boolean) {
  try { return checkedResourcePath(root, path, create, area); }
  catch (error) {
    if (!create && error instanceof Error && "code" in error && error.code === "ENOENT") return join(root, area, path);
    throw new CoreError("INVALID_DOCUMENT", error instanceof Error ? error.message : String(error));
  }
}

// The workspace scanner rejects a *.assets directory without its Markdown owner, so owners are always published before resources.
function assertScannableOwner(root: string, area: z.infer<typeof knowledgeArea>, path: string, batch?: Set<string>) {
  const parts = path.split("/"), index = parts.findIndex(part => /\.assets$/i.test(part));
  if (index < 0) return;
  const owner = parts.slice(0, index).concat(parts[index]!.replace(/\.assets$/i, ".md")).join("/");
  if (batch?.has(`${area}\0${owner}`)) return;
  let stat;
  try { stat = lstatSync(join(root, area, owner)); }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") fail("CONFLICT", `Owning document is missing: ${area}/${owner}`);
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) fail("INVALID_DOCUMENT", "Resource owner must be a regular Markdown file.");
}

// Same default identity the workspace scanner assigns, so the explicit documentId is stable and predictable.
function importedDocumentId(area: string, path: string) {
  const filename = path.split("/").at(-1)!.replace(/\.md$/i, "");
  return area === "notes" && !path.includes("/") && documentId.safeParse(filename).success ? filename
    : `legacy_${sha256(area === "notes" ? path : `${area}/${path}`).slice(0, 32)}`;
}

function owned(documents: { area: string; path: string; content: string; metadata?: { file?: string } }[], area: string, path: string) {
  return documents.some(document => document.area === area && (path.startsWith(`${markdownAssetDirectory(document.path)}/`)
    || markdownReferences(`${document.metadata?.file ? `file: ${JSON.stringify(document.metadata.file)}\n` : ""}${document.content}`).some(reference => {
      const local = localAssetReference(reference.value);
      return local !== undefined && posix.normalize(posix.join(posix.dirname(document.path), local)) === path;
    })));
}

function verifiedBytes(entry: { data: string; digest: string }, code: string) {
  const bytes = Buffer.from(entry.data, "base64");
  if (bytes.toString("base64") !== entry.data || bytes.length > assetImportLimits.fileBytes || `sha256:${sha256(bytes)}` !== entry.digest) {
    fail(code, "Bundle resource must be canonical base64 within 16 MiB and match its SHA256 digest.");
  }
  return bytes;
}

function receiptFor(operationId: string, journal: Journal, created: number): AssetBundleImportResult {
  return receiptSchema.parse({
    operationId, prefix: journal.prefix, created,
    documents: journal.documents.map(document => ({ area: document.area, path: document.path, id: document.id, sha256: document.sha256, created: document.write })),
    resources: journal.assets.map(entry => ({ area: entry.area, path: entry.destination, digest: entry.digest, size: Buffer.from(entry.data, "base64").length })),
  });
}

type IdentityRecord = { key: string; id: string; knowledgeId?: string; aliases: string[] };
function identityRecord(item: ReturnType<typeof decodeMarkdown>, code: string): IdentityRecord {
  const metadata = item.metadata.toJS({ maxAliasCount: 0 }) as Record<string, unknown>;
  const aliases = metadata.aliases === undefined ? [] : metadata.aliases;
  if (!Array.isArray(aliases) || aliases.some(alias => typeof alias !== "string"))
    fail(code, `Cannot safely assess aliases in ${item.record.area}/${item.record.path}.`);
  const probe = compileKnowledgeIdentityV1({ schema: KNOWLEDGE_SCHEMA_V1, knowledgeId: "knowledge_000000000000000000000000", revision: 1, aliases });
  if (!probe.ok) fail(code, `Invalid aliases in ${item.record.area}/${item.record.path}.`);
  const knowledgeId = metadata.knowledgeId;
  if (knowledgeId !== undefined && (typeof knowledgeId !== "string" || !/^knowledge_[a-f0-9]{24}$/.test(knowledgeId)))
    fail(code, `Invalid Knowledge identity in ${item.record.area}/${item.record.path}.`);
  return { key: `${item.record.area}\0${item.record.path}`, id: item.record.id,
    ...(typeof knowledgeId === "string" ? { knowledgeId } : {}), aliases: probe.model.aliases };
}
function assertIdentitySet(records: IdentityRecord[], code: string) {
  const addresses = new Map<string, string>(), aliases = new Map<string, string>();
  for (const item of records) {
    for (const address of [item.id, ...(item.knowledgeId ? [item.knowledgeId] : [])]) {
      if (addresses.has(address) && addresses.get(address) !== item.key) fail(code, `Document or Knowledge identity collision: ${address}`);
      addresses.set(address, item.key);
    }
    for (const alias of item.aliases) {
      if (aliases.has(alias) && aliases.get(alias) !== item.key) fail(code, `Knowledge alias collision: ${alias}`);
      aliases.set(alias, item.key);
    }
  }
}

function normalizedCites(cites: unknown[]) {
  const result: { paper: string; note: string }[] = [];
  for (const cite of cites) {
    if (typeof cite === "string") {
      if (cite.trim()) result.push({ paper: cite.trim(), note: "" });
    } else if (cite && typeof cite === "object" && !Array.isArray(cite)) {
      const item = cite as Record<string, unknown>;
      const paper = String(item.paper ?? item.key ?? item.target ?? "").trim();
      if (paper) result.push({ paper, note: String(item.note ?? item.comment ?? "") });
    }
  }
  return result;
}

function prepareDocuments(documents: z.infer<typeof inputSchema>["documents"], prefix: string, current: ReturnType<typeof scanMarkdown>) {
  const papers = current.filter(item => item.record.area === "papers").map(item => ({
    slug: item.record.path.replace(/\.md$/i, ""), title: item.record.title,
  }));
  const incoming = documents.filter(item => item.area === "papers").map(item => ({
    source: item.path.replace(/\.md$/i, ""), slug: joined(prefix, item.path).replace(/\.md$/i, ""),
    title: item.title ?? basename(item.path).replace(/\.md$/i, ""),
  }));
  const paperMap = new Map(papers.map(item => [item.slug, item]));
  for (const item of incoming) paperMap.set(item.slug, item);
  const bySlug = new Map<string, string>(), byTitle = new Map<string, string>(), bySource = new Map<string, string>();
  for (const item of [...paperMap.values()].sort((a, b) => a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0)) {
    bySlug.set(item.slug.toLowerCase(), item.slug);
    byTitle.set(item.title.toLowerCase(), item.slug);
  }
  for (const item of [...incoming].sort((a, b) => a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0))
    bySource.set(item.source.toLowerCase(), item.slug);
  return documents.map(document => {
    const metadata = document.metadata ? { ...document.metadata } : undefined;
    if (metadata?.links !== undefined) {
      const links = compileKnowledgeLinksV1(metadata.links);
      if (!links.ok) fail("INVALID_ARGUMENT", `Invalid Knowledge links: ${links.diagnostics.map(item => `${item.pointer} ${item.message}`).join("; ")}`);
      metadata.links = links.links;
    }
    if (metadata?.cites !== undefined) {
      if (document.area !== "papers") fail("INVALID_ARGUMENT", "Paper citations are only allowed for Paper documents.");
      const self = joined(prefix, document.path).replace(/\.md$/i, "");
      metadata.cites = normalizedCites(metadata.cites).flatMap(cite => {
        const key = cite.paper.toLowerCase().replace(/\.md$/i, "");
        const target = bySource.get(key) ?? bySlug.get(key) ?? byTitle.get(key);
        return target && target !== self ? [{ paper: target, note: cite.note }] : [];
      });
    }
    return { ...document, metadata };
  });
}

// Compound equivalent of the original bundle import: relocated documents (stable ids/knowledge identity) and resources in one journal.
export function planAssetImport(db: DatabaseSync, root: string, request: StorageRequest): { result: AssetBundleImportResult } | { pending: true } {
  const parsed = inputSchema.safeParse(request.args);
  if (!parsed.success) fail("INVALID_ARGUMENT", "Bundle import arguments do not match the internal import contract.");
  const args = parsed.data;
  const unique = new Map<string, Journal["assets"][number]>();
  const planned: Journal["documents"] = [], batch = new Set<string>();
  const current = scanMarkdown(root);
  const documents = prepareDocuments(args.documents, args.prefix, current);
  const identities = current.map(item => identityRecord(item, "CONFLICT"));
  let total = 0, creates = 0;
  for (const document of documents) {
    const path = joined(args.prefix, document.path), key = `${document.area}\0${path}`;
    if (!documentPath.safeParse(path).success) fail("INVALID_ARGUMENT", `Relocated document path is not portable: ${path}`);
    if (path.split("/")[0]!.toLowerCase() === "system") fail("ACCESS_DENIED", "System documents are read-only.");
    if (batch.has(key) || [...batch].some(item => item.toLowerCase() === key.toLowerCase())) fail("CONFLICT", `Conflicting document duplicates: ${path}`);
    batch.add(key);
    const id = importedDocumentId(document.area, path);
    const existing = current.find(item => item.record.area === document.area && item.record.path === path);
    if (!existing) {
      if (readMarkdown(root, id, path, document.area) !== undefined) fail("CONFLICT", `Document path already exists, including platform case aliases: ${path}`);
      if (current.some(item => item.record.id === id)) fail("CONFLICT", `Document identity already exists: ${id}`);
      let raw = encodeMarkdown(id, document.title ?? path.split("/").at(-1)!.replace(/\.md$/i, ""), document.content, 1, false, undefined, path, document.area);
      {
        const parsed = decodeMarkdown(id, raw, path, document.area);
        for (const [key, value] of Object.entries(document.metadata ?? {})) if (value !== undefined) parsed.metadata.set(key, value);
        const identity = compileKnowledgeIdentityV1({
          schema: document.identity?.schema ?? KNOWLEDGE_SCHEMA_V1,
          knowledgeId: document.identity?.knowledgeId ?? parsed.metadata.get("knowledgeId"),
          revision: document.identity?.revision ?? 1,
          aliases: [...(parsed.metadata.toJS().aliases as string[]),
            legacyKnowledgeAlias(document.area === "skills" ? "skill" : document.area === "papers" ? "research" : "note", document.path),
            ...(document.identity?.aliases ?? [])],
        });
        if (!identity.ok) fail("INVALID_ARGUMENT", `Invalid source Knowledge identity: ${identity.diagnostics.map(item => item.message).join("; ")}`);
        for (const [key, value] of Object.entries(identity.model)) parsed.metadata.set(key, value);
        raw = `---\n${parsed.metadata.toString()}---\n${document.content}`;
      }
      identities.push(identityRecord(decodeMarkdown(id, raw, path, document.area), "INVALID_ARGUMENT"));
      if (Buffer.byteLength(raw) > assetImportLimits.fileBytes) fail("INVALID_ARGUMENT", "Bundle document exceeds the 16 MiB per-file limit.");
      total += Buffer.byteLength(raw);
      planned.push({ area: document.area, path, id, sha256: sha256(raw), write: true, raw });
      continue;
    }
    if (existing.record.deleted || existing.record.content !== document.content
      || (document.metadata !== undefined && document.title !== undefined && existing.record.title !== document.title)
      || Object.entries(document.metadata ?? {}).some(([key, value]) => value !== undefined && !isDeepStrictEqual((existing.metadata.toJS() as Record<string, unknown>)[key], value)))
      fail("CONFLICT", `Incoming document already exists: ${path}`);
    if (document.identity) {
      const actual = existing.metadata.toJS({ maxAliasCount: 0 }) as Record<string, unknown>;
      const expected = compileKnowledgeIdentityV1({ schema: document.identity.schema ?? KNOWLEDGE_SCHEMA_V1,
        knowledgeId: document.identity.knowledgeId ?? "knowledge_000000000000000000000000",
        revision: document.identity.revision ?? 1, aliases: document.identity.aliases ?? [] });
      if (!expected.ok) fail("INVALID_ARGUMENT", "Invalid source Knowledge identity.");
      if ((document.identity.schema !== undefined && actual.schema !== document.identity.schema)
        || (document.identity.knowledgeId !== undefined && actual.knowledgeId !== document.identity.knowledgeId)
        || (document.identity.revision !== undefined && actual.revision !== document.identity.revision)
        || expected.model.aliases.some(alias => !identityRecord(existing, "CONFLICT").aliases.includes(alias)))
        fail("CONFLICT", `Existing document has different Knowledge identity: ${path}`);
    }
    planned.push({ area: document.area, path, id: existing.record.id, sha256: existing.record.sha256, write: false, raw: null });
  }
  assertIdentitySet(identities, "CONFLICT");
  if (total > assetImportLimits.totalBytes) fail("INVALID_ARGUMENT", "Bundle exceeds the 64 MiB per-import journal limit.");
  for (const entry of args.assets) {
    if (basename(entry.path).toLowerCase() === "pkm-todo-board.json") fail("ACCESS_DENIED", "Todo Board authority must be imported as an explicit Board document, not a generic asset.");
    if (!owned(args.documents, entry.type, entry.path) || !entry.path.split("/").some(isMarkdownAssetDirectory)) fail("INVALID_ARGUMENT", "Bundle resource is not owned or referenced by an imported document.");
    const bytes = verifiedBytes(entry, "INVALID_ARGUMENT");
    const target = joined(args.prefix, entry.path);
    if (!resourcePath.safeParse(target).success) fail("INVALID_ARGUMENT", `Relocated resource path is not portable: ${target}`);
    const key = `${entry.type}\0${target}`, previous = unique.get(key);
    if (previous) {
      if (previous.digest !== entry.digest) fail("CONFLICT", `Conflicting resource duplicates: ${entry.path}`);
      continue;
    }
    total += bytes.length;
    if (total > assetImportLimits.totalBytes) fail("INVALID_ARGUMENT", "Bundle resources exceed the 64 MiB per-import journal limit.");
    assertScannableOwner(root, entry.type, target, batch);
    const existing = existingBytes(destination(root, entry.type, target, false));
    if (existing && `sha256:${sha256(existing)}` !== entry.digest) fail("CONFLICT", `Import would overwrite a different resource: ${entry.path}`);
    if (!existing) creates++;
    unique.set(key, { area: entry.type, source: entry.path, destination: target, data: entry.data, digest: entry.digest });
  }
  const papersBySlug = new Map<string, { path: string; id: string; sha256: string }>();
  for (const item of current.filter(item => item.record.area === "papers")) {
    papersBySlug.set(item.record.path.replace(/\.md$/i, "").toLowerCase(), {
      path: item.record.path, id: item.record.id, sha256: item.record.sha256,
    });
  }
  for (const document of planned.filter(item => item.area === "papers")) {
    papersBySlug.set(document.path.replace(/\.md$/i, "").toLowerCase(), {
      path: document.path, id: document.id, sha256: document.sha256,
    });
  }
  const citationTargets = new Map<string, { path: string; id: string; sha256: string }>();
  for (const document of documents.filter(item => item.area === "papers")) {
    const cites = document.metadata?.cites;
    if (!Array.isArray(cites)) continue;
    for (const cite of cites) {
      if (!cite || typeof cite !== "object" || Array.isArray(cite) || typeof (cite as { paper?: unknown }).paper !== "string") continue;
      const target = papersBySlug.get((cite as { paper: string }).paper.toLowerCase());
      if (!target) fail("CONFLICT", `Resolved Paper citation target disappeared during planning: ${(cite as { paper: string }).paper}`);
      citationTargets.set(target.path, target);
      if (citationTargets.size > 20_000) fail("BUSY", "Bundle citations exceed 20,000 distinct Paper targets.");
    }
  }
  const journal: Journal = {
    root: realpathSync(root), prefix: args.prefix, assets: [...unique.values()], documents: planned,
    citationTargets: [...citationTargets.values()].sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0),
  };
  const result = receiptFor(args.operationId, journal, creates);
  if (!creates && !planned.some(document => document.write)) return { result };
  db.prepare("INSERT INTO pending_asset VALUES(1,?,?,?,?,?,?,?)").run(
    args.operationId, sha256(JSON.stringify({ operation: request.operation, actorId: request.actorId, args: request.args })),
    request.actorId, assetImportOperation, `import:${args.operationId}`, Buffer.from(JSON.stringify(journal)), JSON.stringify(result),
  );
  return { pending: true };
}

export function isAssetImportJournal(pending: Record<string, unknown>) {
  return pending.operation === assetImportOperation;
}

export function recoverAssetImport(db: DatabaseSync, root: string, pending: Record<string, unknown>) {
  if (!isAssetImportJournal(pending) || pending.upload_id !== `import:${String(pending.operation_id)}` || !(pending.content instanceof Uint8Array)) {
    fail("INVALID_WORKSPACE", "Pending asset import identity is invalid; preserve the journal.");
  }
  let journal: Journal, stored: AssetBundleImportResult;
  try {
    journal = journalSchema.parse(JSON.parse(Buffer.from(pending.content).toString("utf8")));
    stored = receiptSchema.parse(JSON.parse(String(pending.result)));
  } catch { fail("INVALID_WORKSPACE", "Pending asset import state violates its durable contract; preserve the journal."); }
  const operationId = String(pending.operation_id);
  if (journal.root !== realpathSync(root)) fail("RECOVERY_CONFLICT", "Pending asset import belongs to a different workspace root; preserve the journal.");
  const bytes = journal.assets.map(entry => verifiedBytes(entry, "INVALID_WORKSPACE"));
  const targets = new Set(journal.assets.map(entry => `${entry.area}\0${entry.destination}`));
  const documentKeys = new Set(journal.documents.map(document => `${document.area}\0${document.path}`));
  const documentBytes = journal.documents.reduce((sum, document) => sum + (document.raw === null ? 0 : Buffer.byteLength(document.raw)), 0);
  if (documentKeys.size !== journal.documents.length || documentBytes + bytes.reduce((sum, item) => sum + item.length, 0) > assetImportLimits.totalBytes
    || journal.documents.some(document => (document.raw === null) === document.write || document.raw !== null && sha256(document.raw) !== document.sha256
      || document.id !== importedDocumentId(document.area, document.path) && document.write
      || (journal.prefix && !document.path.startsWith(`${journal.prefix}/`)) || document.path.split("/")[0]!.toLowerCase() === "system")) {
    fail("INVALID_WORKSPACE", "Pending asset import documents do not match their journaled bytes.");
  }
  if (targets.size !== journal.assets.length || bytes.reduce((sum, item) => sum + item.length, 0) > assetImportLimits.totalBytes
    || journal.assets.some(entry => entry.destination !== joined(journal.prefix, entry.source) || basename(entry.destination).toLowerCase() === "pkm-todo-board.json"
      || !entry.source.split("/").some(isMarkdownAssetDirectory))
    || stored.operationId !== operationId || JSON.stringify({ ...stored, created: 0 }) !== JSON.stringify(receiptFor(operationId, journal, 0))) {
    fail("INVALID_WORKSPACE", "Pending asset import result does not match its journaled bytes.");
  }
  const current = scanMarkdown(root);
  const projected = current.map(item => identityRecord(item, "RECOVERY_CONFLICT"));
  const citationPaths = new Set(journal.citationTargets.map(item => item.path));
  if (citationPaths.size !== journal.citationTargets.length) fail("INVALID_WORKSPACE", "Pending asset import has duplicate Paper citation targets.");
  for (const target of journal.citationTargets) {
    const imported = journal.documents.find(document => document.area === "papers" && document.path === target.path);
    if (imported && (imported.id !== target.id || imported.sha256 !== target.sha256))
      fail("INVALID_WORKSPACE", "Pending Paper citation target does not match its imported document pin.");
    const present = current.find(item => item.record.area === "papers" && item.record.path === target.path);
    if (present && (present.record.id !== target.id || present.record.sha256 !== target.sha256)
      || !present && (!imported || !imported.write)) {
      fail("RECOVERY_CONFLICT", `Paper citation target changed or disappeared before recovery: ${target.path}`);
    }
  }
  for (const document of journal.documents) {
    const present = current.find(item => item.record.area === document.area && item.record.path === document.path);
    if (present && (present.record.sha256 !== document.sha256 || present.record.id !== document.id))
      fail("RECOVERY_CONFLICT", "Imported document changed before recovery; preserve the pending journal.");
    if (!document.write && !present) fail("RECOVERY_CONFLICT", "Existing imported document disappeared before recovery; preserve the pending journal.");
    if (document.raw !== null) {
      const decoded = decodeMarkdown(document.id, document.raw, document.path, document.area);
      const metadata = decoded.metadata.toJS({ maxAliasCount: 0 }) as Record<string, unknown>;
      if (metadata.documentId !== document.id || !compileKnowledgeIdentityV1({
        schema: metadata.schema, knowledgeId: metadata.knowledgeId, revision: metadata.revision, aliases: metadata.aliases,
      }).ok) fail("INVALID_WORKSPACE", "Pending asset import has invalid Knowledge identity; preserve the journal.");
      if (!present) projected.push(identityRecord(decoded, "INVALID_WORKSPACE"));
    }
  }
  assertIdentitySet(projected, "RECOVERY_CONFLICT");
  // Owners first: every intermediate state keeps the workspace scannable.
  for (const document of journal.documents) {
    if (!document.write) {
      const current = readMarkdown(root, document.id, document.path, document.area);
      if (!current || current.record.sha256 !== document.sha256) fail("RECOVERY_CONFLICT", "Existing imported document changed before recovery; preserve the pending journal.");
      continue;
    }
    let full: string;
    try { full = checkedDocumentPath(root, document.path, false, document.area); }
    catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw new CoreError("INVALID_DOCUMENT", error instanceof Error ? error.message : String(error));
      full = "";
    }
    const existing = full ? existingBytes(full) : undefined;
    if (existing) {
      if (sha256(existing) !== document.sha256) fail("RECOVERY_CONFLICT", "Document changed outside the server. No recovery write was made; preserve the pending journal.");
      continue;
    }
    const beforeWrite = scanMarkdown(root).map(item => identityRecord(item, "RECOVERY_CONFLICT"));
    beforeWrite.push(identityRecord(decodeMarkdown(document.id, document.raw!, document.path, document.area), "INVALID_WORKSPACE"));
    assertIdentitySet(beforeWrite, "RECOVERY_CONFLICT");
    atomicFileCreateNoReplace(checkedDocumentPath(root, document.path, true, document.area), document.raw!, operationId);
  }
  journal.assets.forEach((entry, index) => {
    assertScannableOwner(root, entry.area, entry.destination);
    const existing = existingBytes(destination(root, entry.area, entry.destination, false));
    if (existing) {
      if (!existing.equals(bytes[index]!)) fail("RECOVERY_CONFLICT", "Resource changed outside the server. No recovery write was made; preserve the pending journal.");
      return;
    }
    atomicFileCreateNoReplace(destination(root, entry.area, entry.destination, true), bytes[index]!, operationId);
  });
  db.prepare("INSERT INTO receipts VALUES(?,?,?,?,?,?)").run(
    operationId, String(pending.fingerprint), String(pending.result), String(pending.actor_id), assetImportOperation, new Date().toISOString(),
  );
  db.prepare("DELETE FROM pending_asset WHERE singleton=1").run();
}
