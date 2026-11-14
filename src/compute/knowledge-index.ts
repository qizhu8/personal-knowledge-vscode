import { lstat, mkdir, open, readFile, realpath, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { ChatMemoryWorker, type ComputeOptions } from "./chat-memory-worker.js";
import { knowledgeSnapshot } from "../knowledge-snapshot.js";
import { decodeMarkdown, readMarkdown, type MarkdownRecord } from "../markdown.js";
import { readKnowledgeMetadata } from "../metadata.js";
import { buildKnowledgeLinksSnapshot } from "../links.js";
import {
  KNOWLEDGE_INDEX_LIMITS, KNOWLEDGE_INDEX_SCHEMA, KnowledgeIndexError,
  knowledgeIndexCanonical, knowledgeIndexDigest, knowledgeIndexHash, knowledgeIndexScope, knowledgeIndexWellFormed, planKnowledgeIndex,
  type KnowledgeIndexPin, type KnowledgeIndexPlan, type KnowledgeIndexScope, type KnowledgeIndexSource,
} from "../domain/knowledge-index.js";

export * from "../domain/knowledge-index.js";

/** Authorized host-injected service boundary only. No raw RPC, SQL, model or public capability dispatch. */
export type KnowledgeIndexWorker = Pick<ChatMemoryWorker,
  "healthy" | "ready" | "close" | "createPiece" | "appendStatement" | "linkPieces" |
  "readPiece" | "sources" | "neighbors" | "usage" | "listPieces">;

export interface RebuildKnowledgeIndexOptions {
  /** Existing canonical absolute isolated Markdown root; never inferred from environment. */
  root: string;
  /** Exact, bounded set to index. Copied and validated on submission; no implicit root scan. */
  documents: readonly MarkdownRecord[];
  scope: KnowledgeIndexScope;
  /**
   * runtimeDirectory MUST NOT EXIST and must be outside root, below an existing real parent.
   * database must be its direct child. identity MUST equal knowledgeIndexScope(root, scope).workerIdentity.
   * Successful runs preserve this staging directory; no live file is opened, deleted or swapped.
   */
  worker: ComputeOptions;
  /** Optional trusted factory for a NEW exclusively owned client, opened with exactly these staging options. */
  openWorker?: (options: ComputeOptions) => Promise<KnowledgeIndexWorker>;
  signal?: AbortSignal;
  /**
   * Optional host snapshot-membership fence (e.g. pinned workspace revision).
   * If absent, only the explicitly supplied sources are fenced; additions elsewhere are outside this rebuild.
   * Called before and after the build; compareDigest must describe the same explicit source set.
   */
  recheckDocuments?: () => readonly MarkdownRecord[] | Promise<readonly MarkdownRecord[]>;
}
export interface KnowledgeIndexArtifact {
  schema: typeof KNOWLEDGE_INDEX_SCHEMA;
  state: "validated-staging";
  mode: "rebuild-only";
  authority: "markdown";
  scope: string;
  workerIdentity: string;
  root: string;
  database: string;
  databaseSha256: string;
  sourceDigest: string;
  contentDigest: string;
  counts: KnowledgeIndexPlan["counts"];
  sourcePins: KnowledgeIndexPin[];
  warnings: string[];
  limitations: readonly string[];
}
export interface KnowledgeIndexRebuildResult {
  /** Closed, persisted staging DB + durable result artifact. Host must explicitly recheck and integrate. */
  artifact: KnowledgeIndexArtifact;
  artifactPath: string;
  /** Explicit trusted configuration for later reopening by the host; not a public capability. */
  worker: ComputeOptions;
}
export const KNOWLEDGE_INDEX_DEPENDENCY_LIMITS = Object.freeze([
  "Python >=3.10 standard library; existing captured pkm-memory-engine schema 2 and ChatMemoryWorker only.",
  "128 explicitly selected documents, uncapped source bytes, 512 supported explicit edges; no partial rebuilds.",
  "No embeddings, generated summaries, inferred topics/projects, Chat replay, explicit-memory mutations or network/model calls.",
  "Rebuild-only: no safe replacement/delete-source API exists; operation receipts alone do not qualify incremental updates.",
  "Source fences are point-in-time; host must recheck sources and optional membership fence again before any separately authorized activation.",
  "Semantic content/source digests are deterministic; SQLite physical bytes/timestamps are not promised reproducible.",
  "Exclusive staging directory and injected worker are trusted host boundaries; concurrent untrusted filesystem writers are unsupported.",
] as const);

function cancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new KnowledgeIndexError("CANCELLED", "Knowledge index rebuild cancelled; no mutation was replayed.");
}
function validation(condition: unknown, message: string): asserts condition {
  if (!condition) throw new KnowledgeIndexError("VALIDATION_FAILED", message);
}
function object(value: unknown): Record<string, unknown> {
  validation(value !== null && typeof value === "object" && !Array.isArray(value), "Invalid worker object response.");
  return value as Record<string, unknown>;
}
function array(value: unknown): Record<string, unknown>[] {
  validation(Array.isArray(value), "Invalid worker array response.");
  return value.map(object);
}
function same(left: unknown, right: unknown): boolean { return knowledgeIndexCanonical(left) === knowledgeIndexCanonical(right); }
function inside(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return !path || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`));
}
function copyDocuments(documents: readonly MarkdownRecord[]): MarkdownRecord[] {
  if (!Array.isArray(documents) || documents.length > KNOWLEDGE_INDEX_LIMITS.documents) {
    throw new KnowledgeIndexError("LIMIT", "Expected an explicit snapshot of at most 128 Markdown documents.");
  }
  let bytes = 0;
  const ids = new Set<string>(), addresses = new Set<string>(), identities = new Set<string>();
  return documents.map(document => {
    if (!document || typeof document.raw !== "string" ||
      Buffer.byteLength(document.raw) > KNOWLEDGE_INDEX_LIMITS.documentBytes ||
      (bytes += Buffer.byteLength(document.raw)) > KNOWLEDGE_INDEX_LIMITS.rawBytes || !knowledgeIndexWellFormed(document.raw)) {
      throw new KnowledgeIndexError("LIMIT", "Snapshot exceeds valid UTF-8 or the supported numeric byte range.");
    }
    if (!document.record || !["notes", "skills", "papers"].includes(document.record.area)) {
      throw new KnowledgeIndexError("INVALID_ARGUMENT", "Expected Note, Skill or Paper Markdown.");
    }
    let parsed: MarkdownRecord;
    try { parsed = decodeMarkdown(document.record.id, document.raw, document.record.path, document.record.area); }
    catch (error) { throw new KnowledgeIndexError("INVALID_ARGUMENT", "Snapshot is not valid bounded Markdown.", { cause: error }); }
    if (!same(parsed.record, document.record) || !same(readKnowledgeMetadata(parsed).metadata, readKnowledgeMetadata(document).metadata)) {
      throw new KnowledgeIndexError("STALE_SOURCE", "Snapshot raw bytes disagree with supplied body/metadata/record pins.");
    }
    const address = `${parsed.record.area}/${parsed.record.path}`, identity = parsed.metadata.get("knowledgeId");
    if (ids.has(parsed.record.id) || addresses.has(address) || (typeof identity === "string" && identities.has(identity))) {
      throw new KnowledgeIndexError("INVALID_ARGUMENT", "Duplicate explicit document identity or address.");
    }
    ids.add(parsed.record.id); addresses.add(address);
    if (typeof identity === "string") identities.add(identity);
    return parsed;
  });
}
function captureSources(root: string, documents: MarkdownRecord[]): KnowledgeIndexSource[] {
  try { return captureCheckedSources(root, documents); }
  catch (error) {
    if (error instanceof KnowledgeIndexError) throw error;
    throw new KnowledgeIndexError("STALE_SOURCE", "Explicit source paths/metadata are unavailable or invalid.", { cause: error });
  }
}
function captureCheckedSources(root: string, documents: MarkdownRecord[]): KnowledgeIndexSource[] {
  // Reuse the domain snapshot's source ordering, JSON metadata and checked regular-file paths.
  const notes = knowledgeSnapshot(root, documents, "notes", "Knowledge compute rebuild");
  const skills = knowledgeSnapshot(root, documents, "skills", "Knowledge compute rebuild");
  const research = knowledgeSnapshot(root, documents, "papers", "Knowledge compute rebuild");
  const linkRevisions = new Map(buildKnowledgeLinksSnapshot({ notes, skills, research }).sources.map(source =>
    [source.uri, source.sourceRevision]));
  const snapshots = [...notes, ...skills, ...research];
  const sources: KnowledgeIndexSource[] = [];
  for (const { document, rel, fm, body } of snapshots) {
    const current = readMarkdown(root, document.record.id, rel, document.record.area);
    if (!current || current.raw !== document.raw) throw new KnowledgeIndexError("STALE_SOURCE", "Explicit Markdown source changed or disappeared.");
    sources.push({
      area: document.record.area, path: rel, documentId: document.record.id, title: document.record.title,
      revision: document.record.revision, rawSha256: knowledgeIndexHash(current.raw), body, metadata: fm,
      linkRevision: linkRevisions.get(`pkm://knowledge/${String(fm.knowledgeId)}`) ?? String(document.record.revision),
    });
  }
  return sources;
}
async function sourceFence(options: RebuildKnowledgeIndexOptions, documents: MarkdownRecord[], plan: KnowledgeIndexPlan): Promise<void> {
  cancelled(options.signal);
  const current = planKnowledgeIndex(options.root, options.scope, captureSources(options.root, documents));
  if (current.sourceDigest !== plan.sourceDigest || current.contentDigest !== plan.contentDigest) {
    throw new KnowledgeIndexError("STALE_SOURCE", "Source pins changed during rebuild.");
  }
  if (options.recheckDocuments) {
    const fresh = copyDocuments(await options.recheckDocuments());
    const membership = planKnowledgeIndex(options.root, options.scope, captureSources(options.root, fresh));
    if (membership.sourceDigest !== plan.sourceDigest) throw new KnowledgeIndexError("STALE_SOURCE", "Explicit snapshot membership changed during rebuild.");
  }
  cancelled(options.signal);
}
async function checkPaths(options: RebuildKnowledgeIndexOptions): Promise<void> {
  const { root, worker } = options;
  if (typeof root !== "string" || !isAbsolute(root) || resolve(root) !== root || await realpath(root) !== root ||
    !(await lstat(root)).isDirectory()) throw new KnowledgeIndexError("INVALID_ARGUMENT", "Root must be an existing canonical absolute directory.");
  if (!worker || typeof worker.runtimeDirectory !== "string" || typeof worker.database !== "string" ||
    !isAbsolute(worker.runtimeDirectory) || resolve(worker.runtimeDirectory) !== worker.runtimeDirectory ||
    !isAbsolute(worker.database) || resolve(worker.database) !== worker.database ||
    dirname(worker.database) !== worker.runtimeDirectory || inside(root, worker.runtimeDirectory) || inside(worker.runtimeDirectory, root)) {
    throw new KnowledgeIndexError("INVALID_ARGUMENT", "A new isolated staging directory outside Markdown root and direct-child database are required.");
  }
  if (await realpath(dirname(worker.runtimeDirectory)) !== dirname(worker.runtimeDirectory)) {
    throw new KnowledgeIndexError("INVALID_ARGUMENT", "Staging parent must exist without symbolic links.");
  }
  if (worker.identity !== knowledgeIndexScope(root, options.scope).workerIdentity) {
    throw new KnowledgeIndexError("INVALID_ARGUMENT", "Worker identity does not match the explicit account/root/namespace partition.");
  }
  if (worker.database === join(worker.runtimeDirectory, "knowledge-index-artifact.json")) {
    throw new KnowledgeIndexError("INVALID_ARGUMENT", "Database and result artifact paths must differ.");
  }
}
function operation(method: string, params: unknown): string { return `ki:${knowledgeIndexDigest([method, params])}`; }

async function verifyWorker(worker: KnowledgeIndexWorker, plan: KnowledgeIndexPlan, signal?: AbortSignal): Promise<void> {
  const allEdges = new Map<string, unknown>();
  const expectedEdges = new Map(plan.edges.map(edge => [knowledgeIndexCanonical(edge), edge]));
  let statements = 0, bytes = 0, sources = 0;
  const usage = object(await worker.usage());
  validation(usage.pieces === plan.counts.pieces && usage.bytes === plan.counts.bytes, "Global worker counts/bytes mismatch.");
  for (const kind of ["piece", "message", "topic", "project"] as const) {
    cancelled(signal);
    const listed = array(await worker.listPieces({ scope: plan.scope, kind, limit: 200 }));
    validation(listed.length === (kind === "piece" ? plan.counts.pieces : 0), "Worker kind counts mismatch.");
    if (kind === "piece") validation(same(listed.map(item => item.id).sort(), plan.pieces.map(item => item.create.piece).sort()), "Worker piece identities mismatch.");
  }
  for (const planned of plan.pieces) {
    cancelled(signal);
    let after = 0, found = 0;
    for (let pageNumber = 0; ; pageNumber++) {
      validation(pageNumber <= planned.statements.length, "Unbounded worker statement pagination.");
      const page = object(await worker.readPiece({ piece_id: planned.create.piece, after, limit: 100 }));
      const piece = object(page.piece);
      validation(page.status === "ready" && page.summary === null && piece.id === planned.create.piece &&
        piece.scope === plan.scope && piece.kind === "piece" && piece.label === planned.create.label && piece.evicted === 0,
      "Worker source piece scope/content metadata mismatch.");
      const rows = array(page.statements);
      if (!rows.length) {
        validation(found === planned.statements.length, "Missing worker statements.");
        break;
      }
      for (const row of rows) {
        const expected = planned.statements[found++];
        validation(expected && row.id === expected.statement_id && row.piece === expected.piece &&
          row.sequence === found && row.status === expected.status && row.body === expected.body, "Worker projected content/digest mismatch.");
        const references = array(await worker.sources({ statement_id: expected.statement_id, limit: 50 }));
        validation(same(references, expected.sources), "Worker exact source pins mismatch.");
        statements++; bytes += Buffer.byteLength(expected.body);
      }
      validation(typeof page.next === "number" && page.next > after && page.next === found, "Invalid worker statement cursor.");
      after = page.next;
    }
    sources++;
    let cursor = "";
    for (let pageNumber = 0; ; pageNumber++) {
      cancelled(signal);
      validation(pageNumber <= Math.ceil(KNOWLEDGE_INDEX_LIMITS.edges / 100), "Unbounded worker edge pagination.");
      const edges = array(await worker.neighbors({ piece_id: planned.create.piece, after: cursor, limit: 100 }));
      if (!edges.length) break;
      for (const edge of edges) {
        const key = knowledgeIndexCanonical(edge);
        validation(expectedEdges.has(key), "Unexpected or cross-partition worker edge.");
        allEdges.set(key, edge);
      }
      const last = edges.at(-1)!;
      const next = `${last.parent}\u001f${last.child}\u001f${last.relation}`;
      validation(next > cursor, "Invalid worker edge cursor.");
      cursor = next;
    }
  }
  validation(statements === plan.counts.statements && bytes === plan.counts.bytes && sources === plan.counts.sources &&
    allEdges.size === plan.counts.edges, "Verified source/statement/edge counts mismatch.");
}

async function executeRebuild(options: RebuildKnowledgeIndexOptions, documents: MarkdownRecord[]): Promise<KnowledgeIndexRebuildResult> {
  let owned = false, client: KnowledgeIndexWorker | undefined;
  const onAbort = () => { void client?.close().catch(() => undefined); };
  try {
    cancelled(options.signal);
    await checkPaths(options);
    const plan = planKnowledgeIndex(options.root, options.scope, captureSources(options.root, documents));
    await sourceFence(options, documents, plan);
    try { await mkdir(options.worker.runtimeDirectory, { mode: 0o700 }); owned = true; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new KnowledgeIndexError("STAGING_EXISTS", "Staging directory already exists; no files were opened or replaced.");
      throw error;
    }
    cancelled(options.signal);
    client = await (options.openWorker ?? ChatMemoryWorker.open)(Object.freeze({ ...options.worker }));
    options.signal?.addEventListener("abort", onAbort, { once: true });
    cancelled(options.signal);
    validation(client.healthy && client.ready?.identity === plan.workerIdentity && client.ready.schema === 2,
      "Worker handshake does not match this staging partition.");
    const empty = object(await client.usage());
    validation(empty.pieces === 0 && empty.bytes === 0, "Injected staging worker is not empty.");
    // Exactly one request at a time: bounded adapter queue, no retries or uncertain mutation replay.
    for (const piece of plan.pieces) {
      cancelled(options.signal);
      await client.createPiece(operation("create", piece.create), piece.create);
      for (const statement of piece.statements) {
        cancelled(options.signal);
        await client.appendStatement(operation("append", statement), statement);
      }
    }
    for (const edge of plan.edges) {
      cancelled(options.signal);
      await client.linkPieces(operation("link", edge), edge);
    }
    await verifyWorker(client, plan, options.signal);
    await sourceFence(options, documents, plan);
    await client.close();
    cancelled(options.signal);
    // close checkpoints the persistent DB. Read only the bounded staging output, never live SQLite.
    const info = await lstat(options.worker.database);
    validation(info.isFile() && !info.isSymbolicLink() && info.size > 0 && info.size <= 64 * 1024 * 1024, "Invalid staging database artifact.");
    const databaseSha256 = knowledgeIndexHashBytes(await readFile(options.worker.database));
    await sourceFence(options, documents, plan);
    const artifact: KnowledgeIndexArtifact = {
      schema: KNOWLEDGE_INDEX_SCHEMA, state: "validated-staging", mode: "rebuild-only", authority: "markdown",
      root: options.root, database: options.worker.database, databaseSha256,
      scope: plan.scope, workerIdentity: plan.workerIdentity, sourceDigest: plan.sourceDigest, contentDigest: plan.contentDigest,
      counts: plan.counts, sourcePins: plan.pieces.map(piece => piece.pin), warnings: plan.warnings,
      limitations: KNOWLEDGE_INDEX_DEPENDENCY_LIMITS,
    };
    const artifactPath = join(options.worker.runtimeDirectory, "knowledge-index-artifact.json");
    const descriptor = await open(artifactPath, "wx", 0o600);
    try { await descriptor.writeFile(`${JSON.stringify(artifact, null, 2)}\n`); await descriptor.sync(); }
    finally { await descriptor.close(); }
    if (process.platform !== "win32") {
      const directory = await open(options.worker.runtimeDirectory, "r");
      try { await directory.sync(); } finally { await directory.close(); }
    }
    cancelled(options.signal);
    return { artifact, artifactPath, worker: { ...options.worker } };
  } catch (error) {
    try {
      await client?.close();
      if (owned) await rm(options.worker.runtimeDirectory, { recursive: true, force: true });
    } catch (cleanupError) {
      throw new KnowledgeIndexError("CLEANUP_FAILED", `Unpublished staging cleanup failed at ${options.worker.runtimeDirectory}; no replay or activation occurred.`,
        { cause: new AggregateError([error, cleanupError]) });
    }
    if (options.signal?.aborted) throw new KnowledgeIndexError("CANCELLED", "Rebuild cancelled; owned staging discarded and no mutations replayed.", { cause: error });
    if (error instanceof KnowledgeIndexError) throw error;
    throw new KnowledgeIndexError("WORKER_FAILED", "Rebuild failed; owned staging discarded, live index untouched, no mutation replayed.", { cause: error });
  } finally { options.signal?.removeEventListener("abort", onAbort); }
}

// Keep file-byte hashing distinct from UTF-8 source hashing.
function knowledgeIndexHashBytes(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }

/** Single rebuild, without background work or automatic integration. */
export function rebuildKnowledgeIndex(options: RebuildKnowledgeIndexOptions): Promise<KnowledgeIndexRebuildResult> {
  return new KnowledgeIndexRebuilder({ maxPendingRebuilds: 1 }).rebuild(options);
}
interface Job {
  options: RebuildKnowledgeIndexOptions;
  documents: MarkdownRecord[];
  accept: (result: KnowledgeIndexRebuildResult) => void;
  reject: (error: unknown) => void;
  onAbort: () => void;
}
/** Host-owned serial scheduler; the bound includes the active rebuild and queued snapshots. */
export class KnowledgeIndexRebuilder {
  readonly #limit: number;
  #active = false;
  #queue: Job[] = [];
  constructor(options: { maxPendingRebuilds?: number } = {}) {
    this.#limit = options.maxPendingRebuilds ?? 2;
    if (!Number.isSafeInteger(this.#limit) || this.#limit < 1 || this.#limit > KNOWLEDGE_INDEX_LIMITS.pendingRebuilds) {
      throw new KnowledgeIndexError("INVALID_ARGUMENT", "maxPendingRebuilds must be between 1 and 8.");
    }
  }
  rebuild(options: RebuildKnowledgeIndexOptions): Promise<KnowledgeIndexRebuildResult> {
    try {
      cancelled(options.signal);
      if (this.#queue.length + Number(this.#active) >= this.#limit) throw new KnowledgeIndexError("BUSY", "Bounded rebuild queue is full; nothing was submitted.");
      const documents = copyDocuments(options.documents);
      const copied = { ...options, scope: { ...options.scope }, worker: { ...options.worker }, documents };
      return new Promise((accept, reject) => {
        const job: Job = { options: copied, documents, accept, reject, onAbort: () => {
          const index = this.#queue.indexOf(job);
          if (index >= 0) {
            this.#queue.splice(index, 1);
            reject(new KnowledgeIndexError("CANCELLED", "Queued rebuild cancelled before worker submission."));
          }
        } };
        this.#queue.push(job);
        copied.signal?.addEventListener("abort", job.onAbort, { once: true });
        this.#pump();
      });
    } catch (error) { return Promise.reject(error); }
  }
  #pump(): void {
    if (this.#active) return;
    const job = this.#queue.shift();
    if (!job) return;
    job.options.signal?.removeEventListener("abort", job.onAbort);
    this.#active = true;
    void executeRebuild(job.options, job.documents).then(job.accept, job.reject).finally(() => {
      this.#active = false;
      this.#pump();
    });
  }
}

/**
 * Host integration fence for a previously returned artifact. No DB activation or raw RPC.
 * The host must additionally apply its own workspace-membership/authorization transaction.
 */
export async function recheckKnowledgeIndexSources(artifact: KnowledgeIndexArtifact): Promise<void> {
  for (const pin of artifact.sourcePins) {
    let current: MarkdownRecord | undefined;
    try { current = readMarkdown(artifact.root, pin.documentId, pin.path, pin.area); }
    catch (error) { throw new KnowledgeIndexError("STALE_SOURCE", "Staging source is unavailable.", { cause: error }); }
    if (!current || current.record.deleted || knowledgeIndexHash(current.raw) !== pin.rawSha256) {
      throw new KnowledgeIndexError("STALE_SOURCE", "Staging source pins are stale; activation is not qualified.");
    }
  }
}
