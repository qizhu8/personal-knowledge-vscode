import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { isMap, parseDocument, type Node } from "yaml";
import { z } from "zod";
import { CoreError } from "./contracts.js";
import { checkedDocumentPath, documentPath, knowledgeArea, resourcePath, type KnowledgeArea } from "./document-path.js";
import { assertEditableDocument } from "./metadata.js";
import { atomicFileWrite, sha256 } from "./file-write.js";
import { decodeMarkdown, scanMarkdown, type MarkdownRecord } from "./markdown.js";
import { compileKnowledgeIdentityV1, compileKnowledgeLinksV1, createKnowledgeId, legacyKnowledgeAlias, type KnowledgeKind } from "./domain/knowledge-contracts.js";
import { canonicalCites, categoryOf, fail, leafOf, type MutationKind } from "./domain/knowledge-mutations-model.js";
import { knowledgeMutationDefinitions, type KnowledgeMutationRequest } from "./knowledge-mutations-contracts.js";
import {
  applyDocumentLifecycleUpdate, deserializeDocumentLifecyclePlan, inspectDocumentLifecycleUpdate,
  planDocumentLifecycle, readDocumentLifecycle, readDocumentLifecycleUpdateSources, serializeDocumentLifecyclePlan,
} from "./document-lifecycle.js";
import { rebaseMarkdownAssets } from "./domain/document-lifecycle-original.js";

export { knowledgeMutationDefinitions } from "./knowledge-mutations-contracts.js";
export type { KnowledgeMutationOperation, KnowledgeMutationRequest } from "./knowledge-mutations-contracts.js";

const UUID = z.string().uuid();
const pinSchema = z.strictObject({ area: knowledgeArea, path: documentPath, sha256: z.string().regex(/^[a-f0-9]{64}$/) });
const changeSchema = z.strictObject({
  area: knowledgeArea, path: documentPath, beforeSha256: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  afterSha256: z.string().regex(/^[a-f0-9]{64}$/), before: z.string().nullable(),
  after: z.string(),
});

export interface KnowledgeMutationFileChange {
  area: KnowledgeArea; path: string; beforeSha256: string | null; afterSha256: string;
  before: Buffer | null; after: Buffer;
}
export interface KnowledgeMutationPlan {
  kind: "knowledge-mutation";
  operationId: string;
  actorId: string;
  operation: KnowledgeMutationRequest["operation"];
  expectedScanRevision: string;
  sourcePins: Array<{ area: KnowledgeArea; path: string; sha256: string }>;
  change: KnowledgeMutationFileChange;
  requiresCompoundJournal: true;
  receipt: z.infer<(typeof knowledgeMutationDefinitions)[number]["output"]>;
  relocation?: string;
  preserveIdentity?: true;
}

const wireSchema = z.strictObject({
  kind: z.literal("knowledge-mutation"), operationId: UUID, actorId: z.string().min(1).max(500),
  operation: z.enum(knowledgeMutationDefinitions.map(item => item.id) as [string, ...string[]]),
  expectedScanRevision: z.string().regex(/^[a-f0-9]{64}$/), sourcePins: z.array(pinSchema),
  change: changeSchema, requiresCompoundJournal: z.literal(true),
  receipt: knowledgeMutationDefinitions[0].output,
  relocation: z.string().max(16_000_000).optional(),
  preserveIdentity: z.literal(true).optional(),
});

function checkedRoot(root: string) {
  const full = resolve(root);
  for (let current = full; ; current = dirname(current)) {
    const stat = lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail("INVALID_WORKSPACE", "Knowledge mutation root and ancestors must be real directories.");
    if (dirname(current) === current) break;
  }
  return full;
}

function scanned(root: string): MarkdownRecord[] {
  return scanMarkdown(root);
}

function pinsFor(records: readonly MarkdownRecord[]) {
  return records.map(({ record }) => ({ area: record.area, path: record.path, sha256: record.sha256 }))
    .sort((a, b) => `${a.area}/${a.path}`.localeCompare(`${b.area}/${b.path}`));
}

export function knowledgeMutationScanRevision(records: readonly MarkdownRecord[]): string {
  return sha256(JSON.stringify(pinsFor(records)));
}

function ensureScan(root: string, expected: string) {
  const records = scanned(root);
  if (knowledgeMutationScanRevision(records) !== expected) fail("CONFLICT", "Knowledge collection changed; refresh the mutation preview.");
  return records;
}

function safeLeaf(value: string) {
  const leaf = value.replace(/[/\\:*?"<>|\u0000-\u001f]/g, "").trim();
  if (!leaf || leaf === "." || leaf === "..") fail("INVALID_ARGUMENT", "Name must produce a safe portable Markdown filename.");
  return leaf;
}

function safeCategory(value: string | undefined) {
  const category = (value ?? "").trim();
  if (!category) return "";
  const segments = category.split("/").map(segment => segment.trim()).filter(Boolean).map(safeLeaf);
  if (segments.length > 32 || segments.some(segment => !/^(?!\.)(?!.*[. ]$)[^/\\:*?"<>|\u0000-\u001f]+$/.test(segment))) {
    fail("INVALID_ARGUMENT", "Category must be a bounded portable relative folder path.");
  }
  return segments.join("/");
}

function targetPath(kind: MutationKind, args: Record<string, unknown>) {
  const name = kind === "skill" ? String(args.name ?? "") : String(args.title ?? "");
  const leaf = safeLeaf(name);
  const category = safeCategory(typeof args.category === "string" ? args.category : undefined);
  const area: KnowledgeArea = kind === "note" ? "notes" : kind === "skill" ? "skills" : "papers";
  const path = `${category ? `${category}/` : ""}${leaf}.md`;
  if (!documentPath.safeParse(path).success) fail("INVALID_ARGUMENT", "Name/category exceeds portable path limits.");
  return { area, path, leaf, category, name };
}

function rootEntry(root: string, area: KnowledgeArea, path: string) {
  let full: string;
  try {
    full = checkedDocumentPath(root, path, false, area);
    const stat = lstatSync(full);
    return { full, stat };
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

function assertNoAssetCollision(root: string, area: KnowledgeArea, path: string) {
  const assetPath = join(root, area, path.replace(/\.md$/i, ".assets"));
  try {
    const stat = lstatSync(assetPath);
    if (stat.isSymbolicLink() || !stat.isDirectory()) fail("CONFLICT", "The Markdown resource path is occupied; preserve it and choose another name.");
    fail("CONFLICT", "A resource directory already exists for this document path; preserve opaque resources.");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
}

function assertPortableAddress(root: string, area: KnowledgeArea, path: string, records: readonly MarkdownRecord[]) {
  const key = (value: string) => value.normalize("NFC").toLocaleLowerCase("en-US");
  if (records.some(record => record.record.area === area && key(record.record.path) === key(path))) {
    fail("CONFLICT", `A case-insensitive portable path already exists: ${area}/${path}`);
  }
  let directory = join(root, area);
  const parts = path.split("/");
  for (const [index, part] of parts.entries()) {
    let names: string[];
    try { names = readdirSync(directory); }
    catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
      throw error;
    }
    const collision = names.find(name => key(name) === key(part) && name !== part);
    if (collision) fail("CONFLICT", `Path component collides by portable case-folding: ${area}/${parts.slice(0, index).concat(collision).join("/")}`);
    if (index < parts.length - 1) {
      const current = join(directory, part);
      try {
        const stat = lstatSync(current);
        if (!stat.isDirectory() || stat.isSymbolicLink()) fail("INVALID_DOCUMENT", "Mutation path parents must be real directories.");
        directory = current;
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
        throw error;
      }
    }
  }
}

function documentKind(operation: string): MutationKind {
  return operation.includes(".note.") ? "note" : operation.includes(".skill.") ? "skill" : "research";
}

function areaFor(kind: MutationKind): KnowledgeArea {
  return kind === "note" ? "notes" : kind === "skill" ? "skills" : "papers";
}

function existingByPath(records: readonly MarkdownRecord[], area: KnowledgeArea, path: string) {
  return records.find(record => record.record.area === area && record.record.path === path);
}

function stableKnowledgeIdentity(record: MarkdownRecord, kind: MutationKind, preserveIdentity = false) {
  const values = record.metadata.toJS({ maxAliasCount: 0 }) as Record<string, unknown>;
  let compiled = compileKnowledgeIdentityV1({
    schema: values.schema, knowledgeId: values.knowledgeId, revision: values.revision, aliases: values.aliases,
  });
  if (!compiled.ok && preserveIdentity) {
    if (values.schema !== undefined && values.schema !== "pkm.knowledge/v1")
      fail("UNSUPPORTED_OPERATION", "An unrelated existing schema cannot be replaced by identity migration.");
    compiled = compileKnowledgeIdentityV1({
      schema: "pkm.knowledge/v1", knowledgeId: values.knowledgeId === undefined
        ? `knowledge_${sha256(`${record.record.area}:${record.record.id}`).slice(0, 24)}` : values.knowledgeId,
      revision: record.record.revision, aliases: values.aliases === undefined ? [] : values.aliases,
    });
  }
  if (!compiled.ok || !preserveIdentity && record.record.id !== compiled.model.knowledgeId
    && values.documentId !== record.record.id) {
    fail("UNSUPPORTED_OPERATION", "Legacy/path-only Knowledge identity needs an explicit identity migration before specialized updates.");
  }
  const expectedKind: KnowledgeKind = kind === "research" ? "research" : kind;
  if (!compiled.model.aliases.includes(legacyKnowledgeAlias(expectedKind, record.record.path.replace(/\.md$/i, "")))) {
    return {
      ...compiled.model,
      aliases: [...new Set([...compiled.model.aliases, legacyKnowledgeAlias(expectedKind, record.record.path.replace(/\.md$/i, ""))])].sort(),
    };
  }
  return compiled.model;
}

function assertEditable(root: string, record: MarkdownRecord) {
  assertEditableDocument(root, record);
  if (record.record.deleted || record.record.path.split("/").some(part => part.toLowerCase() === "system")
    || record.metadata.has("memory")
    || (record.record.area === "notes" && basename(record.record.path).toLowerCase() === "todo board.md")) {
    fail("ACCESS_DENIED", "System, Todo Board and deleted descriptors require their dedicated lifecycle operations.");
  }
}

function assertUniqueName(kind: MutationKind, name: string, records: readonly MarkdownRecord[], current?: MarkdownRecord) {
  if (kind !== "skill") return;
  const normalized = name.toLocaleLowerCase("en-US");
  const duplicate = records.find(record => record.record.area === "skills" && record.record.id !== current?.record.id
    && String(record.metadata.get("name") ?? leafOf(record.record.path)).toLocaleLowerCase("en-US") === normalized);
  if (duplicate) fail("CONFLICT", `A Skill named "${name}" already exists; use its existing stable identity.`);
}

function papersFor(records: readonly MarkdownRecord[]) {
  return records.filter(record => record.record.area === "papers").map(record => ({
    slug: record.record.path.replace(/\.md$/i, ""),
    title: String(record.metadata.get("title") ?? leafOf(record.record.path)),
  }));
}

function linksValue(value: unknown) {
  if (value === undefined) return undefined;
  const checked = compileKnowledgeLinksV1(value);
  if (!checked.ok) fail("INVALID_ARGUMENT", `Invalid Knowledge links: ${checked.diagnostics.map(item => `${item.pointer} ${item.message}`).join("; ")}`);
  return checked.links;
}

function metadataChanges(kind: MutationKind, args: Record<string, unknown>, existing?: MarkdownRecord, papers: ReturnType<typeof papersFor> = []) {
  const metadata: Record<string, unknown> = {};
  const put = (key: string, value: unknown, fallback?: unknown) => {
    if (value !== undefined) metadata[key] = value;
    else if (!existing && fallback !== undefined) metadata[key] = fallback;
  };
  put("description", args.description, "");
  put("tags", args.tags, []);
  const links = linksValue(args.links);
  put("links", links, []);
  if (kind === "note") {
    put("title", args.title);
    put("type", args.type, "general");
    put("pinned", args.pinned);
  } else if (kind === "skill") {
    put("name", args.name);
    for (const key of ["source_project", "recipe_required", "recipe_hint", "related_skills", "priority", "pinned"]) put(key, args[key]);
  } else {
    put("title", args.title);
    for (const key of ["authors", "topic", "publisher", "url", "file", "conclusions", "implementation", "assumptions", "kind", "group", "pinned"]) {
      put(key, args[key]);
    }
    if (args.year !== undefined) metadata.year = paperYear(args.year);
    if (typeof args.file === "string" && args.file !== "" && !resourcePath.safeParse(args.file).success) {
      fail("INVALID_ARGUMENT", "Paper file references must be portable relative resource paths.");
    }
    if (args.cites !== undefined || !existing) {
      metadata.cites = canonicalCites(args.cites ?? [], papers, existing?.record.path.replace(/\.md$/i, "") ?? "");
    }

    function paperYear(value: unknown): number | null {
      if (typeof value === "number") return value;
      if (value == null || value === "") return null;
      const parsed = Number.parseInt(String(value), 10);
      return Number.isFinite(parsed) ? parsed : null;
    }
  }
  if (!existing && kind === "research") {
    metadata.authors ??= [];
    metadata.year ??= null;
    metadata.topic ??= "";
    metadata.publisher ??= "";
    metadata.url ??= "";
    metadata.file ??= "";
    metadata.conclusions ??= [];
    metadata.implementation ??= [];
    metadata.assumptions ??= [];
  }
  return metadata;
}

function yamlMap(raw: string, path: string) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(raw);
  if (!match) fail("INVALID_DOCUMENT", `Document ${path} has no valid frontmatter.`);
  const document = parseDocument(match[1]!, { uniqueKeys: true });
  if (document.errors.length || !isMap(document.contents)) fail("INVALID_DOCUMENT", `Document ${path} has invalid YAML frontmatter.`);
  const values = document.toJS({ maxAliasCount: 0 });
  if (!values || typeof values !== "object" || Array.isArray(values)) fail("INVALID_DOCUMENT", `Document ${path} frontmatter must be a mapping.`);
  return { match, document, yaml: match[1]! };
}

function containsYamlComment(node: unknown, root = true): boolean {
  if (!node || typeof node !== "object") return false;
  const value = node as Record<string, unknown>;
  if (!root && (typeof value.comment === "string" && value.comment.length > 0
    || typeof value.commentBefore === "string" && value.commentBefore.length > 0)) return true;
  if (Array.isArray(value.items) && value.items.some(item => containsYamlComment(item, false))) return true;
  return ("key" in value && containsYamlComment(value.key, false)) || ("value" in value && containsYamlComment(value.value, false));
}

function losslessFrontmatterWrite(before: MarkdownRecord, changes: Record<string, unknown>, content?: string) {
  if (!/^---\r?\n/.test(before.raw)) {
    const yaml = Object.entries(changes).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join("\n");
    return Buffer.from(`---\n${yaml}\n---\n${content === undefined ? before.raw : content}`, "utf8");
  }
  const { match, document, yaml } = yamlMap(before.raw, before.record.path);
  const flowMap = isMap(document.contents) && document.contents.flow === true ? document.contents : undefined;
  const flow = flowMap !== undefined;
  if (flow && containsYamlComment(document.contents, false))
    fail("UNSUPPORTED_OPERATION", "Flow frontmatter with comments cannot be updated losslessly.");
  const edits: Array<{ start: number; end: number; value: string }> = [];
  const additions: string[] = [];
  for (const [key, value] of Object.entries(changes)) {
    const node = document.get(key, true) as Node | undefined;
    const text = JSON.stringify(value);
    if (text === undefined) fail("INVALID_ARGUMENT", `Metadata ${key} cannot be represented as JSON.`);
    if (node) {
      if (!node.range) fail("UNSUPPORTED_OPERATION", `Metadata ${key} cannot be updated without changing its original YAML structure.`);
      if (containsYamlComment(node)) fail("UNSUPPORTED_OPERATION", `Metadata ${key} contains comments that this update cannot preserve losslessly.`);
      const [start, end] = node.range;
      if (start === undefined || end === undefined) fail("INVALID_DOCUMENT", `Could not safely preserve the ${key} frontmatter node.`);
      const suffix = yaml.slice(end);
      const separator = !flow && suffix.length > 0 && !/^[ \t]*(?:#|\r?\n|$)/.test(suffix) ? "\n" : "";
      edits.push({ start, end, value: text + separator });
    } else {
      additions.push(`${flow ? JSON.stringify(key) : key}: ${text}`);
    }
  }
  if (flow && additions.length) {
    const end = flowMap?.range?.[1];
    if (end === undefined || yaml[end - 1] !== "}") fail("UNSUPPORTED_OPERATION", "Flow frontmatter boundary cannot be preserved.");
    edits.push({ start: end - 1, end: end - 1, value: `${flowMap!.items.length ? "," : ""} ${additions.join(", ")}` });
  }
  edits.sort((a, b) => b.start - a.start);
  let nextYaml = yaml;
  for (const edit of edits) nextYaml = nextYaml.slice(0, edit.start) + edit.value + nextYaml.slice(edit.end);
  if (!flow && additions.length) nextYaml += `${nextYaml.endsWith("\n") || !nextYaml ? "" : "\n"}${additions.join("\n")}\n`;
  const body = content === undefined ? before.raw.slice(match.index + match[0].length) : content;
  const raw = before.raw.slice(0, match.index) + `---${match[0].slice(3, match[0].indexOf("\n") + 1)}${nextYaml}${match[0].includes("\r\n") ? "\r\n" : "\n"}---${match[0].endsWith("\r\n") ? "\r\n" : "\n"}`
    + body;
  return Buffer.from(raw, "utf8");
}

function createRaw(kind: MutationKind, id: string, path: string, args: Record<string, unknown>, updates: Record<string, unknown>) {
  const knowledgeKind: KnowledgeKind = kind === "research" ? "research" : kind;
  const identity = {
    schema: "pkm.knowledge/v1",
    knowledgeId: id,
    revision: 1,
    aliases: [legacyKnowledgeAlias(knowledgeKind, path.replace(/\.md$/i, ""))],
  };
  const fields: Record<string, unknown> = { ...identity, ...updates };
  const yaml = Object.entries(fields).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join("\n");
  const content = typeof args.content === "string" ? args.content : "";
  const eol = "\n";
  return Buffer.from(`---${eol}${yaml}${eol}---${eol}${content}`, "utf8");
}

function receiptFor(operationId: string, action: "create" | "update", area: KnowledgeArea, path: string,
  id: string, bytes: Buffer) {
  const record = decodeMarkdown(id, bytes.toString("utf8"), path, area);
  const values = record.metadata.toJS({ maxAliasCount: 0 }) as Record<string, unknown>;
  const name = String(values.name ?? values.title ?? leafOf(path));
  return knowledgeMutationDefinitions[0].output.parse({
    operationId, action, area, path, id, knowledgeId: values.knowledgeId, revision: record.record.revision,
    sha256: sha256(bytes), category: categoryOf(path), name,
  });
}

function planFrom(root: string, request: KnowledgeMutationRequest): KnowledgeMutationPlan {
  const def = knowledgeMutationDefinitions.find(item => item.id === request.operation);
  if (!def) fail("NOT_FOUND", "Unknown specialized Knowledge mutation.");
  const parsedArgs = def.input.safeParse(request.args);
  if (!parsedArgs.success) fail("INVALID_ARGUMENT", "Specialized Knowledge mutation arguments violate the public contract.");
  const args = parsedArgs.data as Record<string, unknown>;
  const operationId = String(args.operationId);
  if (!UUID.safeParse(operationId).success || !request.actorId || request.actorId.length > 500) fail("INVALID_ARGUMENT", "A UUID operationId and bounded actorId are required.");
  root = checkedRoot(root);
  const records = ensureScan(root, String(args.expectedScanRevision));
  const kind = documentKind(request.operation);
  const creating = request.operation.endsWith(".create");
  const target = creating ? targetPath(kind, args) : undefined;
  let existing: MarkdownRecord | undefined;
  let area: KnowledgeArea, path: string, name: string;
  if (creating) {
    area = target!.area; path = target!.path; name = target!.name;
    if (area === "notes" && basename(path).toLowerCase() === "todo board.md") {
      fail("ACCESS_DENIED", "Todo Boards require their dedicated create/lifecycle operation.");
    }
    if (path.split("/").some(part => part.toLowerCase() === "system")
      || path.split("/").some(part => part.toLowerCase() === "_assets")) {
      fail("ACCESS_DENIED", "System and resource-tree paths are not writable specialized Knowledge destinations.");
    }
    if (existingByPath(records, area, path) || rootEntry(root, area, path)) fail("CONFLICT", `Knowledge document already exists: ${area}/${path}`);
    assertPortableAddress(root, area, path, records);
    assertNoAssetCollision(root, area, path);
    assertUniqueName(kind, name, records);
  } else {
    const expectedId = String(args.id);
    const expectedRevision = Number(args.expectedRevision), expectedSha = String(args.expectedSha256);
    existing = records.find(record => record.record.id === expectedId
      && record.record.area === (kind === "note" ? "notes" : kind === "skill" ? "skills" : "papers"));
    if (!existing || existing.record.revision !== expectedRevision || existing.record.sha256 !== expectedSha) {
      fail("CONFLICT", "The selected source identity/revision/SHA is stale; refresh before updating.");
    }
    area = existing.record.area; path = existing.record.path;
    assertEditable(root, existing);
    stableKnowledgeIdentity(existing, kind, args.preserveIdentity === true);
    name = String(args.name ?? args.title ?? existing.metadata.get(kind === "skill" ? "name" : "title") ?? leafOf(path));
    if (kind === "skill") assertUniqueName(kind, name, records, existing);
    const storedName = String(existing.metadata.get(kind === "skill" ? "name" : "title") ?? leafOf(path));
    if (!args.moveTo && (kind === "skill" && args.name !== undefined || kind !== "skill" && args.title !== undefined)
      && name !== storedName && safeLeaf(name) !== leafOf(path)) {
      fail("UNSUPPORTED_OPERATION", "Name/title changes require the dedicated document lifecycle path operation.");
    }
    if (!args.moveTo && args.category !== undefined && safeCategory(String(args.category)) !== categoryOf(path)) {
      fail("UNSUPPORTED_OPERATION", "Category/path changes require the dedicated lifecycle move operation.");
    }
  }

  const fields = metadataChanges(kind, args, existing, papersFor(records));
  if (existing && args.preserveIdentity && !existing.metadata.has(kind === "skill" ? "name" : "title"))
    fields[kind === "skill" ? "name" : "title"] = name;
  const destination = typeof args.moveTo === "string" ? args.moveTo : path;
  if (args.moveTo && (!existing || destination === path
    || targetPath(kind, { ...args, [kind === "skill" ? "name" : "title"]: name,
      category: args.category ?? categoryOf(path) }).path !== destination)) {
    fail("INVALID_ARGUMENT", "Combined Knowledge move must match its canonical title/name/category destination.");
  }
  if (existing && kind === "skill" && args.name !== undefined) fields.name = name;
  if (existing && (kind === "note" || kind === "research") && args.title !== undefined) fields.title = name;
  let after: Buffer;
  let id: string, revision: number;
  if (existing) {
    const identity = stableKnowledgeIdentity(existing, kind, args.preserveIdentity === true);
    if (records.some(record => record.record.id !== existing.record.id && record.metadata.get("knowledgeId") === identity.knowledgeId))
      fail("CONFLICT", "The retained or promoted Knowledge identity is already owned by another source.");
    id = existing.record.id;
    revision = identity.revision + 1;
    fields.schema = identity.schema;
    fields.knowledgeId = identity.knowledgeId;
    fields.revision = revision;
    fields.aliases = [...new Set([...identity.aliases,
      legacyKnowledgeAlias(kind, destination.replace(/\.md$/i, ""))])];
    if (args.preserveIdentity && existing.record.id !== identity.knowledgeId) fields.documentId = existing.record.id;
    after = losslessFrontmatterWrite(existing, fields, typeof args.content === "string" ? args.content : undefined);
  } else {
    id = createKnowledgeId().replace(/^knowledge_/, "knowledge_");
    revision = 1;
    const updates = metadataChanges(kind, args, undefined, papersFor(records));
    after = createRaw(kind, id, path, args, updates);
  }
  const decoded = decodeMarkdown(id, after.toString("utf8"), path, area);
  if (decoded.record.revision !== revision) fail("INVALID_DOCUMENT", "Specialized identity revision did not match the Markdown projection.");
  let relocation: string | undefined;
  if (existing && args.moveTo) {
    const address = { area, path, id: existing.record.id, expectedRevision: existing.record.revision,
      expectedSha256: existing.record.sha256, destinationPath: destination };
    const preview = readDocumentLifecycle(root, records, { operation: "knowledge.document.lifecycle.preview",
      actorId: request.actorId, args: address }, args.preserveIdentity === true);
    relocation = serializeDocumentLifecyclePlan(planDocumentLifecycle(root, records, {
      operation: "knowledge.document.move", actorId: request.actorId, args: { ...address, operationId,
        expectedScanRevision: preview.scanRevision, expectedPairedTreeDigest: preview.pairedAssets.digest,
        expectedDestinationSha256: null, expectedDestinationTreeDigest: null },
    }, args.preserveIdentity === true));
  }
  const finalBytes = relocation ? Buffer.from(rebaseMarkdownAssets(join(root, area), path, destination, after.toString("utf8"))) : after;
  const receipt = receiptFor(operationId, creating ? "create" : "update", area, destination, id, finalBytes);
  const before = existing?.raw === undefined ? null : Buffer.from(existing.raw, "utf8");
  const change = {
    area, path, beforeSha256: before ? sha256(before) : null, afterSha256: sha256(after), before, after,
  };
  const plan: KnowledgeMutationPlan = {
    kind: "knowledge-mutation", operationId, actorId: request.actorId, operation: request.operation,
    expectedScanRevision: String(args.expectedScanRevision), sourcePins: pinsFor(records), change,
    requiresCompoundJournal: true, receipt, ...(relocation ? { relocation } : {}),
    ...(args.preserveIdentity === true ? { preserveIdentity: true as const } : {}),
  };
  validatePlan(plan);
  return plan;
}

export function planKnowledgeMutation(root: string, request: KnowledgeMutationRequest): KnowledgeMutationPlan {
  return planFrom(root, request);
}

function wire(plan: KnowledgeMutationPlan) {
  return wireSchema.parse({
    ...plan,
    change: { ...plan.change, before: plan.change.before?.toString("base64") ?? null, after: plan.change.after.toString("base64") },
  });
}

function validatePlan(plan: KnowledgeMutationPlan) {
  wire(plan);
  const change = plan.change;
  const addresses = plan.sourcePins.map(pin => `${pin.area}/${pin.path}`);
  const sortedAddresses = [...addresses].sort((a, b) => a.localeCompare(b));
  if (new Set(addresses).size !== addresses.length || JSON.stringify(addresses) !== JSON.stringify(sortedAddresses)
    || sha256(JSON.stringify(plan.sourcePins)) !== plan.expectedScanRevision
    || (change.before === null) !== (change.beforeSha256 === null)
    || (change.before && sha256(change.before) !== change.beforeSha256)
    || sha256(change.after) !== change.afterSha256) fail("INVALID_WORKSPACE", "Knowledge mutation plan bytes, pins or digests are inconsistent.");
  const kind = documentKind(plan.operation);
  const creating = plan.operation.endsWith(".create");
  const relocation = plan.relocation ? deserializeDocumentLifecyclePlan(plan.relocation) : undefined;
  const destination = relocation?.result.document.afterPath ?? change.path;
  if (relocation && (creating || relocation.actorId !== plan.actorId || relocation.operationId !== plan.operationId
    || relocation.documentCas.path !== change.path || relocation.documentCas.area !== change.area
    || relocation.documentCas.sha256 !== change.beforeSha256 || relocation.documentCas.id !== plan.receipt.id
    || !relocation.changes[1]!.before?.equals(change.before!))) {
    fail("INVALID_WORKSPACE", "Combined Knowledge move lost its exact source, actor or operation binding.");
  }
  const targetPins = plan.sourcePins.filter(pin => pin.area === change.area && pin.path === change.path);
  if (change.area !== areaFor(kind) || plan.receipt.area !== change.area || plan.receipt.path !== destination
    || plan.receipt.operationId !== plan.operationId || plan.receipt.action !== (creating ? "create" : "update")
    || plan.receipt.category !== categoryOf(destination) || (creating ? change.before !== null || targetPins.length !== 0
      : change.before === null || targetPins.length !== 1 || targetPins[0]!.sha256 !== change.beforeSha256)) {
    fail("INVALID_WORKSPACE", "Knowledge mutation operation, area, receipt and file intent are inconsistent.");
  }
  if (change.path.split("/").some(part => ["system", "_assets"].includes(part.toLowerCase()))) {
    fail("ACCESS_DENIED", "System and resource-tree paths cannot be specialized mutation targets.");
  }
  const after = decodeMarkdown(plan.receipt.id, change.after.toString("utf8"), change.path, change.area);
  if (after.record.revision !== plan.receipt.revision) fail("INVALID_WORKSPACE", "Knowledge mutation receipt revision does not match the Markdown.");
  const finalBytes = relocation ? Buffer.from(rebaseMarkdownAssets(resolve("next-server/tests/knowledge-move-virtual", change.area),
    change.path, destination, after.raw)) : change.after;
  if (sha256(finalBytes) !== plan.receipt.sha256) fail("INVALID_WORKSPACE", "Knowledge mutation receipt SHA does not match the Markdown.");
  if (after.metadata.get("knowledgeId") !== plan.receipt.knowledgeId) fail("INVALID_WORKSPACE", "Knowledge mutation receipt identity does not match the Markdown.");
  if ((kind === "skill" ? after.metadata.get("name") : after.metadata.get("title")) !== plan.receipt.name) {
    fail("INVALID_WORKSPACE", "Knowledge mutation receipt name does not match the Markdown.");
  }
  const afterIdentity = compileKnowledgeIdentityV1({
    schema: after.metadata.get("schema"), knowledgeId: after.metadata.get("knowledgeId"),
    revision: after.metadata.get("revision"), aliases: after.metadata.toJS({ maxAliasCount: 0 }).aliases,
  });
  if (!afterIdentity.ok || after.record.id !== afterIdentity.model.knowledgeId && after.metadata.get("documentId") !== after.record.id
    || afterIdentity.model.revision !== after.record.revision
    || !afterIdentity.model.aliases.includes(legacyKnowledgeAlias(kind === "research" ? "research" : kind, change.path.replace(/\.md$/i, "")))) {
    fail("INVALID_WORKSPACE", "Knowledge mutation identity, revision and canonical path alias are inconsistent.");
  }
  if (relocation && !afterIdentity.model.aliases.includes(legacyKnowledgeAlias(kind, destination.replace(/\.md$/i, ""))))
    fail("INVALID_WORKSPACE", "Combined Knowledge move must retain the old alias and add its new path alias.");
  if (after.metadata.has("memory") || after.metadata.get("documentKind") === "todo-board"
    || (kind === "note" && basename(change.path).toLowerCase() === "todo board.md")) {
    fail("ACCESS_DENIED", "Todo and explicit-memory descriptors cannot be specialized Markdown mutations.");
  }
  if (after.metadata.has("links")) {
    const links = compileKnowledgeLinksV1(after.metadata.toJS({ maxAliasCount: 0 }).links);
    if (!links.ok) fail("INVALID_WORKSPACE", "Knowledge mutation contains invalid Knowledge links.");
  }
  if (change.before) {
    const before = decodeMarkdown(plan.receipt.id, change.before.toString("utf8"), change.path, change.area);
    const identity = stableKnowledgeIdentity(before, kind, plan.preserveIdentity);
    if (before.record.revision + 1 !== after.record.revision
      || identity.knowledgeId !== after.metadata.get("knowledgeId")) {
      fail("INVALID_WORKSPACE", "Knowledge update must preserve stable identity and increment its revision exactly once.");
    }
    if (before.metadata.has("memory") || before.metadata.get("documentKind") === "todo-board"
      || (kind === "note" && basename(change.path).toLowerCase() === "todo board.md")) {
      fail("ACCESS_DENIED", "Todo and explicit-memory descriptors cannot be specialized Markdown mutations.");
    }
  } else if (after.record.revision !== 1 || safeLeaf(plan.receipt.name) !== leafOf(change.path)) {
    fail("INVALID_WORKSPACE", "Knowledge creation must start at revision one with a portable matching filename.");
  }
  return plan;
}

export function serializeKnowledgeMutationPlan(plan: KnowledgeMutationPlan): string {
  validatePlan(plan);
  const json = JSON.stringify(wire(plan));
  if (Buffer.byteLength(json) > 16_000_000) fail("INVALID_WORKSPACE", "Knowledge mutation intent exceeds its serialized size bound.");
  return json;
}

export function deserializeKnowledgeMutationPlan(json: string): KnowledgeMutationPlan {
  if (typeof json !== "string" || Buffer.byteLength(json) > 16_000_000) fail("INVALID_WORKSPACE", "Knowledge mutation intent exceeds its serialized size bound.");
  let value: z.infer<typeof wireSchema>;
  try { value = wireSchema.parse(JSON.parse(json)); }
  catch { fail("INVALID_WORKSPACE", "Knowledge mutation intent is malformed or violates its strict schema."); }
  const before = value.change.before === null ? null : Buffer.from(value.change.before, "base64");
  const after = Buffer.from(value.change.after, "base64");
  if ((before && before.toString("base64") !== value.change.before) || after.toString("base64") !== value.change.after) {
    fail("INVALID_WORKSPACE", "Knowledge mutation intent contains non-canonical base64 bytes.");
  }
  const plan: KnowledgeMutationPlan = {
    ...value,
    operation: value.operation as KnowledgeMutationRequest["operation"],
    change: {
      ...value.change,
      before,
      after,
    },
  };
  validatePlan(plan);
  return plan;
}

function currentPhase(root: string, plan: KnowledgeMutationPlan) {
  const actual = scanned(root);
  const target = plan.change;
  const otherPins = plan.sourcePins.filter(pin => !(pin.area === target.area && pin.path === target.path));
  const actualOtherPins = pinsFor(actual).filter(pin => !(pin.area === target.area && pin.path === target.path));
  if (JSON.stringify(otherPins) !== JSON.stringify(actualOtherPins)) fail("RECOVERY_CONFLICT", "Knowledge source references changed outside this mutation intent.");
  const plannedAfter = decodeMarkdown(plan.receipt.id, target.after.toString("utf8"), target.path, target.area);
  const kind = documentKind(plan.operation);
  const plannedName = String(plannedAfter.metadata.get(kind === "skill" ? "name" : "title") ?? leafOf(target.path));
  assertUniqueName(kind, plannedName, actual, plannedAfter);
  if (kind === "research") {
    const submitted = (plannedAfter.metadata.toJS({ maxAliasCount: 0 }) as Record<string, unknown>).cites ?? [];
    const paperSnapshot = actual.filter(record => record.record.area !== "papers" || record.record.path !== target.path)
      .concat(plannedAfter);
    const normalized = canonicalCites(submitted, papersFor(paperSnapshot), target.path.replace(/\.md$/i, ""));
    if (JSON.stringify(normalized) !== JSON.stringify(submitted)) fail("RECOVERY_CONFLICT", "Research citations no longer resolve to the pinned canonical source set.");
  }
  const found = rootEntry(root, target.area, target.path);
  const staging = join(root, target.area, dirname(target.path), `.pkm-write-${plan.operationId}`);
  try {
    const stat = lstatSync(staging);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== target.after.length
      || !readFileSync(staging).equals(target.after)) {
      fail("RECOVERY_CONFLICT", "Mutation staging path is not its exact planned after image; preserve it.");
    }
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  const currentRecord = actual.find(record => record.record.area === target.area && record.record.path === target.path);
  if (currentRecord) assertEditable(root, currentRecord);
  if (found && (!found.stat.isFile() || found.stat.isSymbolicLink())) {
    fail("RECOVERY_CONFLICT", "Mutation target is no longer a regular file.");
  }
  const current = found ? readFileSync(found.full) : undefined;
  const digest = current ? sha256(current) : null;
  if (digest === target.beforeSha256) {
    if (target.beforeSha256 === null) {
      assertPortableAddress(root, target.area, target.path, actual);
      assertNoAssetCollision(root, target.area, target.path);
    }
    return 0;
  }
  if (digest === target.afterSha256) {
    return 1;
  }
  fail("RECOVERY_CONFLICT", "Mutation target is neither its exact before nor exact after image; preserve it for reconciliation.");
}

function finish(root: string, plan: KnowledgeMutationPlan, operationId: string, recovering: boolean) {
  let effects = false;
  try {
    validatePlan(plan);
    if (operationId !== plan.operationId) fail("INVALID_WORKSPACE", "Knowledge mutation operationId does not match the durable intent.");
    root = checkedRoot(root);
    if (plan.relocation) {
      applyDocumentLifecycleUpdate(root, deserializeDocumentLifecyclePlan(plan.relocation), plan.change.after, operationId, recovering);
      return plan.receipt;
    }
    let phase = currentPhase(root, plan);
    if (phase === 1) return plan.receipt;
    if (phase !== 0) fail("RECOVERY_CONFLICT", "Knowledge mutation cannot be safely resumed.");
    const destination = checkedDocumentPath(root, plan.change.path, true, plan.change.area);
    if (plan.change.beforeSha256 === null) assertNoAssetCollision(root, plan.change.area, plan.change.path);
    effects = true;
    atomicFileWrite(destination, plan.change.after, plan.change.beforeSha256, operationId);
    phase = currentPhase(root, plan);
    if (phase !== 1) fail("RECOVERY_CONFLICT", "Knowledge mutation did not reach its exact after image.");
    return plan.receipt;
  } catch (error) {
    if (error instanceof CoreError) throw new CoreError(error.code, error.message, effects || recovering ? "unknown" : error.effect);
    throw new CoreError("RECOVERY_CONFLICT", "Knowledge mutation was interrupted; preserve the durable intent for reconciliation.", "unknown");
  }
}

/** Persist this exact intent in shared SQLite and acquire the writer lock before calling apply.
 * Commit the global receipt, Markdown index and intent completion together after success. */
export function applyKnowledgeMutation(root: string, plan: KnowledgeMutationPlan, operationId: string) {
  return finish(root, plan, operationId, false);
}

/** Reconcile only exact before/after images before normal indexing resumes. */
export function recoverKnowledgeMutation(root: string, plan: KnowledgeMutationPlan, operationId: string) {
  return finish(root, plan, operationId, true);
}

export function inspectKnowledgeMutationRecovery(root: string, plan: KnowledgeMutationPlan): number {
  validatePlan(plan);
  if (plan.relocation) return inspectDocumentLifecycleUpdate(root, deserializeDocumentLifecyclePlan(plan.relocation), plan.change.after);
  return currentPhase(checkedRoot(root), plan);
}

export function assertKnowledgeMutationRequestPlan(root: string, plan: KnowledgeMutationPlan, request: KnowledgeMutationRequest): void {
  validatePlan(plan);
  const definition = knowledgeMutationDefinitions.find(item => item.id === request.operation);
  const parsed = definition?.input.safeParse(request.args);
  if (!parsed?.success || request.operation !== plan.operation || request.actorId !== plan.actorId
    || parsed.data.operationId !== plan.operationId || parsed.data.expectedScanRevision !== plan.expectedScanRevision
    || (parsed.data as Record<string, unknown>).preserveIdentity !== plan.preserveIdentity) {
    fail("RECOVERY_CONFLICT", "Knowledge plan does not match its immutable request.");
  }
  const args = parsed.data as Record<string, unknown>, kind = documentKind(request.operation);
  const { area, path } = plan.change;
  const before = plan.change.before ? decodeMarkdown(plan.receipt.id, plan.change.before.toString("utf8"), path, area) : undefined;
  const destination = plan.receipt.path;
  const observed = plan.relocation
    ? readDocumentLifecycleUpdateSources(checkedRoot(root), deserializeDocumentLifecyclePlan(plan.relocation), plan.change.after)
    : scanned(checkedRoot(root));
  const records = observed.filter(item => item.record.area !== area
    || item.record.path !== path && (!plan.relocation || item.record.path !== destination));
  if (before) records.push(before);
  if (knowledgeMutationScanRevision(records) !== plan.expectedScanRevision) {
    fail("RECOVERY_CONFLICT", "Knowledge request no longer has its exact pinned before-source set.");
  }
  if (before) {
    const storedName = String(before.metadata.get(kind === "skill" ? "name" : "title") ?? leafOf(path));
    const submittedName = args.name ?? args.title;
    if (request.operation.endsWith(".create") || before.record.id !== args.id
      || before.record.revision !== args.expectedRevision || before.record.sha256 !== args.expectedSha256
      || !args.moveTo && submittedName !== undefined && submittedName !== storedName && safeLeaf(String(submittedName)) !== leafOf(path)
      || !args.moveTo && args.category !== undefined && safeCategory(String(args.category)) !== categoryOf(path)
      || (args.moveTo ?? path) !== destination
      || !!args.moveTo !== !!plan.relocation) {
      fail("RECOVERY_CONFLICT", "Knowledge update request changes its pinned identity, name or category.");
    }
    if (args.moveTo && targetPath(kind, { ...args,
      [kind === "skill" ? "name" : "title"]: submittedName ?? storedName,
      category: args.category ?? categoryOf(path) }).path !== destination)
      fail("RECOVERY_CONFLICT", "Knowledge move request does not derive its exact canonical destination.");
  } else {
    const target = targetPath(kind, args);
    if (!request.operation.endsWith(".create") || target.area !== area || target.path !== path) {
      fail("RECOVERY_CONFLICT", "Knowledge create request does not own its planned address.");
    }
  }
  const fields = metadataChanges(kind, args, before, papersFor(records));
  if (before && args.preserveIdentity && !before.metadata.has(kind === "skill" ? "name" : "title"))
    fields[kind === "skill" ? "name" : "title"] = args.name ?? args.title ?? leafOf(path);
  let expected: Buffer;
  if (before) {
    const identity = stableKnowledgeIdentity(before, kind, args.preserveIdentity === true);
    fields.schema = identity.schema;
    fields.knowledgeId = identity.knowledgeId;
    fields.revision = identity.revision + 1;
    fields.aliases = [...new Set([...identity.aliases, legacyKnowledgeAlias(kind, destination.replace(/\.md$/i, ""))])];
    if (args.preserveIdentity && before.record.id !== identity.knowledgeId) fields.documentId = before.record.id;
    expected = losslessFrontmatterWrite(before, fields, typeof args.content === "string" ? args.content : undefined);
  } else expected = createRaw(kind, plan.receipt.id, path, args, fields);
  if (!expected.equals(plan.change.after)) {
    fail("RECOVERY_CONFLICT", "Knowledge after-image is not derived from its exact immutable request and before bytes.");
  }
}
