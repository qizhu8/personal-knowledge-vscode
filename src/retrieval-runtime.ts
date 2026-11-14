import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  RETRIEVAL_RUNTIME_LIMITS as L, retrievalAssert, retrievalDigest, retrievalLimit, retrievalModel,
  retrievalRank, retrievalScope, retrievalSections, retrievalSources, retrievalText, retrievalVector,
  type RetrievalChunk, type RetrievalModelPin, type RetrievalRanked, type RetrievalScope, type RetrievalSource,
} from "./domain/retrieval-runtime.js";
export * from "./domain/retrieval-runtime.js";

export interface RetrievalEmbedder {
  readonly model: RetrievalModelPin;
  encodeDocuments(texts: readonly string[]): Promise<readonly (readonly number[])[]>;
  encodeQueries(texts: readonly string[]): Promise<readonly (readonly number[])[]>;
}
export interface RetrievalRuntimeOptions {
  /** Existing owner connection only. Never opens a database or reads host environment/files. */
  database: DatabaseSync;
  embedder: RetrievalEmbedder;
  /** Synchronous authoritative shared-DB snapshot, including membership/deletion and immutable source pins.
   * Called inside read/write transactions. Must not return cached filesystem observations. */
  readSources: (scope: Readonly<RetrievalScope>) => readonly RetrievalSource[];
  /** Trusted authorization boundary, applied before encoding and before candidate truncation. */
  authorize: (scope: Readonly<RetrievalScope>, source: Readonly<RetrievalSource>, action: "index" | "search") => boolean;
}
export interface RetrievalCheckpoint {
  indexId: string; sourceDigest: string; contentDigest: string; model: RetrievalModelPin;
  state: "staged" | "qualified" | "active"; sourceCount: number; chunkCount: number;
}
export interface RetrievalHit extends RetrievalRanked {
  sourceRevision: string; sourceSha256: string; indexId: string; model: RetrievalModelPin;
}
interface StoredIndex {
  id: string; state: RetrievalCheckpoint["state"]; sources: RetrievalSource[];
  chunks: RetrievalChunk[]; model: RetrievalModelPin; sourceDigest: string; contentDigest: string;
}
type Row = { id: string; state: StoredIndex["state"]; payload: string; digest: string };

/** Host-only service; public handlers must accept schema-only requests, never this options object. */
export class RetrievalRuntime {
  private readonly model: RetrievalModelPin;
  constructor(private readonly options: RetrievalRuntimeOptions) {
    retrievalAssert(options?.database && options.embedder && typeof options.embedder.encodeDocuments === "function"
      && typeof options.embedder.encodeQueries === "function" && typeof options.readSources === "function"
      && typeof options.authorize === "function", "UNAVAILABLE", "Explicit shared database, embedder, sources and authorizer required.");
    this.model = Object.freeze(retrievalModel(options.embedder.model));
    options.database.exec(`
      CREATE TABLE IF NOT EXISTS retrieval_runtime_indexes (
        scope TEXT NOT NULL, id TEXT NOT NULL, state TEXT NOT NULL,
        payload TEXT NOT NULL, digest TEXT NOT NULL, PRIMARY KEY(scope,id));
      CREATE TABLE IF NOT EXISTS retrieval_runtime_active (
        scope TEXT PRIMARY KEY, index_id TEXT NOT NULL);
    `);
  }
  private transaction<T>(write: boolean, work: () => T): T {
    const db = this.options.database;
    db.exec(write ? "BEGIN IMMEDIATE" : "BEGIN");
    try { const result = work(); db.exec("COMMIT"); return result; }
    catch (error) { db.exec("ROLLBACK"); throw error; }
  }
  private scope(value: RetrievalScope): { scope: RetrievalScope; key: string } {
    const scope = Object.freeze(retrievalScope(value));
    return { scope, key: JSON.stringify(scope) };
  }
  private snapshot(scope: RetrievalScope): RetrievalSource[] {
    retrievalAssert(retrievalDigest(retrievalModel(this.options.embedder.model)) === retrievalDigest(this.model),
      "CONFLICT", "Embedding model pin changed.");
    return retrievalSources(this.options.readSources(scope));
  }
  private authorized(scope: RetrievalScope, source: RetrievalSource, action: "index" | "search"): boolean {
    return this.options.authorize(scope, Object.freeze({ ...source }), action) === true;
  }
  private active(key: string): string | null {
    const row = this.options.database.prepare("SELECT index_id FROM retrieval_runtime_active WHERE scope=?").get(key) as { index_id: string } | undefined;
    return row?.index_id ?? null;
  }
  private load(key: string, id: string, requireModel = true): StoredIndex {
    retrievalText(id, 256);
    const row = this.options.database.prepare("SELECT id,state,payload,digest FROM retrieval_runtime_indexes WHERE scope=? AND id=?").get(key, id) as Row | undefined;
    retrievalAssert(row, "UNAVAILABLE", "Explicit scoped index unavailable.");
    retrievalAssert(Buffer.byteLength(row.payload) <= L.totalBytes + L.vectorValues * 32, "INTEGRITY", "Persisted index exceeds bounds.");
    let value: StoredIndex;
    try { value = JSON.parse(row.payload) as StoredIndex; }
    catch { retrievalAssert(false, "INTEGRITY", "Corrupt retrieval index JSON."); }
    retrievalAssert(value && value.id === row.id && value.state === row.state
      && retrievalDigest(value) === row.digest, "INTEGRITY", "Persisted checkpoint digest mismatch.");
    const storedModel = retrievalModel(value.model);
    retrievalAssert(!requireModel || retrievalDigest(storedModel) === retrievalDigest(this.model), "CONFLICT", "Index/model pin mismatch.");
    const sources = retrievalSources(value.sources);
    retrievalAssert(retrievalDigest(sources) === value.sourceDigest, "INTEGRITY", "Source checkpoint mismatch.");
    retrievalAssert(Array.isArray(value.chunks) && value.chunks.length <= L.chunks
      && value.chunks.length * storedModel.dimensions <= L.vectorValues, "INTEGRITY", "Invalid persisted chunk bounds.");
    const planned = this.plan(sources, storedModel.dimensions);
    retrievalAssert(value.chunks.length === planned.length, "INTEGRITY", "Incomplete persisted chunks.");
    value.chunks.forEach((chunk, index) => {
      retrievalAssert(chunk && retrievalDigest({ id: chunk.id, sourceId: chunk.sourceId, ordinal: chunk.ordinal, text: chunk.text })
        === retrievalDigest(planned[index]), "INTEGRITY", "Chunk/source checkpoint mismatch.");
      retrievalVector(chunk.vector, storedModel.dimensions);
    });
    retrievalAssert(this.contentDigest(value) === value.contentDigest, "INTEGRITY", "Vector checkpoint digest mismatch.");
    return value;
  }
  private contentDigest(value: Pick<StoredIndex, "sources" | "chunks" | "model">): string {
    return retrievalDigest({ sources: value.sources, chunks: value.chunks, model: value.model });
  }
  private save(key: string, value: StoredIndex): void {
    this.options.database.prepare(`INSERT INTO retrieval_runtime_indexes(scope,id,state,payload,digest) VALUES(?,?,?,?,?)
      ON CONFLICT(scope,id) DO UPDATE SET state=excluded.state,payload=excluded.payload,digest=excluded.digest`)
      .run(key, value.id, value.state, JSON.stringify(value), retrievalDigest(value));
  }
  private checkSources(scope: RetrievalScope, index: StoredIndex): void {
    retrievalAssert(retrievalDigest(this.snapshot(scope)) === index.sourceDigest, "STALE_SOURCE", "Source membership, revision or content changed; rebuild required.");
  }
  private checkpoint(value: StoredIndex): RetrievalCheckpoint {
    return { indexId: value.id, state: value.state, model: { ...value.model },
      sourceDigest: value.sourceDigest, contentDigest: value.contentDigest,
      sourceCount: value.sources.length, chunkCount: value.chunks.length };
  }
  private plan(sources: RetrievalSource[], dimensions = this.model.dimensions): Omit<RetrievalChunk, "vector">[] {
    const chunks = sources.flatMap(source => retrievalSections(source).map((text, ordinal) => ({
      id: retrievalDigest([source.id, source.revision, source.sha256, ordinal, text]),
      sourceId: source.id, ordinal, text,
    })));
    retrievalAssert(chunks.length <= L.chunks && chunks.length * dimensions <= L.vectorValues, "LIMIT", "Chunk/vector bound exceeded.");
    return chunks;
  }
  async stage(value: RetrievalScope, publication?: {
    indexId: string; onCommit?: (checkpoint: RetrievalCheckpoint) => void;
  }): Promise<RetrievalCheckpoint> {
    const { scope, key } = this.scope(value);
    if (publication) retrievalText(publication.indexId, 256);
    const existing = publication && this.transaction(false, () => {
      const row = this.options.database.prepare("SELECT id FROM retrieval_runtime_indexes WHERE scope=? AND id=?").get(key, publication.indexId);
      if (!row) return undefined;
      const index = this.load(key, publication.indexId);
      this.checkSources(scope, index);
      retrievalAssert(index.sources.every(source => this.authorized(scope, source, "index")), "FORBIDDEN", "Indexing authorization changed.");
      return this.checkpoint(index);
    });
    if (existing) return this.transaction(true, () => { publication?.onCommit?.(existing); return existing; });
    const sources = this.transaction(false, () => {
      const current = this.snapshot(scope);
      retrievalAssert(current.every(source => this.authorized(scope, source, "index")), "FORBIDDEN", "Source indexing is not authorized.");
      return current;
    });
    const planned = this.plan(sources), chunks: RetrievalChunk[] = [];
    for (let offset = 0; offset < planned.length; offset += L.batch) {
      const batch = planned.slice(offset, offset + L.batch);
      const vectors = await this.options.embedder.encodeDocuments(batch.map(chunk => chunk.text));
      retrievalAssert(Array.isArray(vectors) && vectors.length === batch.length, "INVALID_ARGUMENT", "Embedder returned invalid vector count.");
      batch.forEach((chunk, index) => chunks.push({ ...chunk, vector: retrievalVector(vectors[index], this.model.dimensions) }));
    }
    const index: StoredIndex = {
      id: publication?.indexId ?? randomUUID(), state: "staged", sources, chunks, model: this.model,
      sourceDigest: retrievalDigest(sources), contentDigest: this.contentDigest({ sources, chunks, model: this.model }),
    };
    return this.transaction(true, () => {
      this.checkSources(scope, index);
      retrievalAssert(sources.every(source => this.authorized(scope, source, "index")), "FORBIDDEN", "Indexing authorization changed.");
      const count = this.options.database.prepare("SELECT count(*) AS count FROM retrieval_runtime_indexes WHERE scope=?").get(key) as { count: number };
      retrievalAssert(count.count < L.checkpoints, "LIMIT", "Checkpoint capacity reached; explicitly discard inactive checkpoints.");
      this.save(key, index);
      const checkpoint = this.checkpoint(index);
      publication?.onCommit?.(checkpoint);
      return checkpoint;
    });
  }
  qualify(value: RetrievalScope, indexId: string, onCommit?: (checkpoint: RetrievalCheckpoint) => void): RetrievalCheckpoint {
    const { scope, key } = this.scope(value);
    return this.transaction(true, () => {
      const index = this.load(key, indexId);
      retrievalAssert(index.state === "staged" || index.state === "qualified", "CONFLICT", "Only staged indexes can qualify.");
      this.checkSources(scope, index);
      retrievalAssert(index.sources.every(source => this.authorized(scope, source, "index")), "FORBIDDEN", "Indexing authorization changed.");
      index.state = "qualified"; this.save(key, index);
      const checkpoint = this.checkpoint(index); onCommit?.(checkpoint); return checkpoint;
    });
  }
  activate(value: RetrievalScope, indexId: string, expectedActiveIndexId: string | null, onCommit?: (checkpoint: RetrievalCheckpoint) => void): RetrievalCheckpoint {
    const { scope, key } = this.scope(value);
    if (expectedActiveIndexId !== null) retrievalText(expectedActiveIndexId, 256);
    return this.transaction(true, () => {
      retrievalAssert(this.active(key) === expectedActiveIndexId, "CONFLICT", "Active index compare-and-swap failed.");
      const index = this.load(key, indexId);
      retrievalAssert(index.state === "qualified", "CONFLICT", "Checkpoint has not qualified.");
      this.checkSources(scope, index);
      retrievalAssert(index.sources.every(source => this.authorized(scope, source, "index")), "FORBIDDEN", "Indexing authorization changed.");
      if (expectedActiveIndexId !== null) {
        const old = this.load(key, expectedActiveIndexId, false);
        old.state = "qualified"; this.save(key, old);
      }
      index.state = "active"; this.save(key, index);
      this.options.database.prepare(`INSERT INTO retrieval_runtime_active(scope,index_id) VALUES(?,?)
        ON CONFLICT(scope) DO UPDATE SET index_id=excluded.index_id`).run(key, indexId);
      const checkpoint = this.checkpoint(index); onCommit?.(checkpoint); return checkpoint;
    });
  }
  discard(value: RetrievalScope, indexId: string): void {
    const { key } = this.scope(value); retrievalText(indexId, 256);
    this.transaction(true, () => {
      retrievalAssert(this.active(key) !== indexId, "CONFLICT", "Cannot discard the active index.");
      this.options.database.prepare("DELETE FROM retrieval_runtime_indexes WHERE scope=? AND id=?").run(key, indexId);
    });
  }
  availability(value: RetrievalScope): { available: false } | { available: true; indexId: string; model: RetrievalModelPin } {
    const { scope, key } = this.scope(value);
    return this.transaction(false, () => {
      const id = this.active(key);
      if (!id) return { available: false };
      const index = this.load(key, id);
      retrievalAssert(index.state === "active", "INTEGRITY", "Active index checkpoint is not active.");
      this.checkSources(scope, index);
      return { available: true, indexId: id, model: { ...this.model } };
    });
  }
  async search(value: RetrievalScope, request: { query: string; limit?: number; expectedIndexId?: string; sourceIds?: readonly string[] }): Promise<{
    indexId: string; sourceDigest: string; model: RetrievalModelPin; hits: RetrievalHit[];
  }> {
    const { scope, key } = this.scope(value);
    retrievalText(request.query, L.queryBytes); const limit = retrievalLimit(request.limit ?? 5);
    let filter: Set<string> | undefined;
    if (request.sourceIds !== undefined) {
      retrievalAssert(Array.isArray(request.sourceIds) && request.sourceIds.length <= L.sources, "LIMIT", "Source filter bound exceeded.");
      request.sourceIds.forEach(id => retrievalText(id, 256));
      filter = new Set(request.sourceIds);
      retrievalAssert(filter.size === request.sourceIds.length, "INVALID_ARGUMENT", "Duplicate source filter identity.");
    }
    const startingId = this.transaction(false, () => {
      const id = this.active(key);
      retrievalAssert(id, "UNAVAILABLE", "No explicitly activated embedding index.");
      if (request.expectedIndexId !== undefined) retrievalAssert(id === request.expectedIndexId, "CONFLICT", "Requested index pin is stale.");
      const index = this.load(key, id); this.checkSources(scope, index);
      return id;
    });
    const vectors = await this.options.embedder.encodeQueries([request.query]);
    retrievalAssert(Array.isArray(vectors) && vectors.length === 1, "INVALID_ARGUMENT", "Embedder returned invalid query vector count.");
    const queryVector = retrievalVector(vectors[0], this.model.dimensions);
    return this.transaction(false, () => {
      retrievalAssert(this.active(key) === startingId, "CONFLICT", "Active index changed during query embedding.");
      const index = this.load(key, startingId);
      retrievalAssert(index.state === "active", "INTEGRITY", "Active index checkpoint is not active.");
      this.checkSources(scope, index);
      const admitted = new Map(index.sources.filter(source => (!filter || filter.has(source.id))
        && this.authorized(scope, source, "search")).map(source => [source.id, source]));
      const hits = retrievalRank(index.chunks.filter(chunk => admitted.has(chunk.sourceId)), queryVector, limit).map(hit => {
        const source = admitted.get(hit.sourceId)!;
        return { ...hit, sourceRevision: source.revision, sourceSha256: source.sha256, indexId: startingId, model: { ...this.model } };
      });
      return { indexId: startingId, sourceDigest: index.sourceDigest, model: { ...this.model }, hits };
    });
  }
}
