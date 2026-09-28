import * as fs from "fs";
import * as path from "path";
import { spawn } from "child_process";
import { createHash } from "crypto";
import type { RetrievalSnapshot } from "./retrieval-snapshot";
import { mcpStdioCommand } from "./mcp-stdio-command";
import {
  RETRIEVAL_QUERY_SCHEMA_V1,
  compileRetrievalQueryV1,
  type RetrievalQueryV1,
  type RetrievalResultV1,
  type RetrievalIndexEventV1,
} from "./retrieval-contracts";
import { RetrievalIndexEventStore } from "./retrieval-index-events";

interface RetrievalEndpoint {
  pid: number;
  port: number;
  token: string;
  engine_version: string;
  configuration_hash: string;
}

export interface RetrievalWorkerStatus {
  ok: boolean;
  engine_version: string;
  configuration_hash: string;
  pid: number;
  corpus_revision: string;
  building_revision: string;
  ready_generation: number;
  building_generation: number;
  ready: boolean;
  document_count: number;
  edge_count: number;
  schema: { query: string; result: string; index_event: string };
  engine: string;
  supported_routes: string[];
  unsupported_routes: string[];
  tokenizers: string[];
  facets: string[];
  update_mode: string;
  limitations: string[];
  error: string;
}

function compareEngineVersion(left: string, right: string): number | undefined {
  const parse = (value: string): number[] | undefined => {
    const parts = String(value || "").match(/\d+/g)?.map(Number);
    return parts?.length ? parts : undefined;
  };
  const a = parse(left), b = parse(right);
  if (!a || !b) return undefined;
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const difference = (a[index] || 0) - (b[index] || 0);
    if (difference) return difference < 0 ? -1 : 1;
  }
  return 0;
}

export class RetrievalWorkerManager {
  private ensurePromise: Promise<RetrievalEndpoint> | undefined;

  constructor(
    private readonly stateDir: string,
    private readonly workerScript: string,
    private readonly python: string,
    private readonly engineVersion: string,
    private readonly configurationHash = "exact-bm25-academic-v1",
  ) {}

  private endpointPath(): string { return path.join(this.stateDir, "worker.json"); }

  private readEndpoint(): RetrievalEndpoint | undefined {
    try {
      const value = JSON.parse(fs.readFileSync(this.endpointPath(), "utf8"));
      if (Number(value.port) > 0 && Number(value.pid) > 1 && value.token) return value;
    } catch { /* worker may still be starting */ }
    return undefined;
  }

  private async request<T>(
    endpoint: RetrievalEndpoint,
    route: string,
    method = "GET",
    body?: unknown,
    options: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error(`Retrieval ${route} timed out.`)), options.timeoutMs ?? (route === "/index" ? 30_000 : 5_000));
    const abort = () => controller.abort(options.signal?.reason);
    if (options.signal?.aborted) abort();
    else options.signal?.addEventListener("abort", abort, { once: true });
    let response: Response;
    try {
      response = await fetch(`http://127.0.0.1:${endpoint.port}${route}`, {
        method,
        headers: { "X-PKM-Retrieval-Token": endpoint.token, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", abort);
    }
    const value = await response.json() as unknown;
    if (!response.ok) {
      const message = value && typeof value === "object" && "error" in value ? String((value as { error?: unknown }).error || "") : "";
      throw new Error(message || `Retrieval worker returned ${response.status}.`);
    }
    return value as T;
  }

  async ensure(): Promise<RetrievalEndpoint> {
    if (this.ensurePromise) return this.ensurePromise;
    this.ensurePromise = this.ensureInner();
    try { return await this.ensurePromise; }
    finally { this.ensurePromise = undefined; }
  }

  private async ensureInner(): Promise<RetrievalEndpoint> {
    fs.mkdirSync(this.stateDir, { recursive: true });
    return this.withTransitionLock(() => this.ensureLocked());
  }

  private async ensureLocked(): Promise<RetrievalEndpoint> {
    const current = this.readEndpoint();
    if (current) {
      try {
        const status = await this.request<RetrievalWorkerStatus>(current, "/status");
        if (status.engine_version === this.engineVersion && status.configuration_hash === this.configurationHash) return current;
        const order = compareEngineVersion(status.engine_version, this.engineVersion);
        if (order === 1) {
          if (status.configuration_hash === this.configurationHash) return current;
          throw new Error(`A newer PKM retrieval worker ${status.engine_version} is active with a different configuration. Reload this VS Code window.`);
        }
        await this.request(current, "/shutdown", "POST", {});
      } catch (error) {
        if (error instanceof Error && error.message.includes("newer PKM retrieval worker")) throw error;
        /* stale endpoint */
      }
    }
    try { fs.rmSync(this.endpointPath(), { force: true }); } catch { /* ignore */ }
    const launch = mcpStdioCommand(this.python, [this.workerScript, this.stateDir, this.configurationHash]);
    const child = spawn(launch.command, launch.args, {
      detached: true,
      env: { ...process.env, ...launch.env },
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const endpoint = this.readEndpoint();
      if (endpoint) {
        try {
          const status = await this.request<RetrievalWorkerStatus>(endpoint, "/status");
          if (status.engine_version === this.engineVersion && status.configuration_hash === this.configurationHash) return endpoint;
        } catch { /* keep waiting */ }
      }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error("Retrieval worker did not become ready within 10 seconds.");
  }

  private async withTransitionLock<T>(action: () => Promise<T>): Promise<T> {
    const lockPath = path.join(this.stateDir, "worker-transition.lock");
    const deadline = Date.now() + 12_000;
    let owned = false;
    while (!owned) {
      try {
        const fd = fs.openSync(lockPath, "wx", 0o600);
        try { fs.writeFileSync(fd, String(process.pid)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
        owned = true;
      } catch (error: any) {
        if (error?.code !== "EEXIST") throw error;
        let pid = 0;
        try { pid = Number(fs.readFileSync(lockPath, "utf8")); } catch { /* recover below */ }
        let alive = false;
        try { if (pid > 1) { process.kill(pid, 0); alive = true; } } catch (processError: any) { alive = processError?.code === "EPERM"; }
        if (!alive) { try { fs.unlinkSync(lockPath); } catch { /* another waiter recovered it */ } }
        else if (Date.now() >= deadline) throw new Error("Retrieval worker transition lock timed out.");
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    }
    try { return await action(); }
    finally { try { fs.unlinkSync(lockPath); } catch { /* ownership already recovered */ } }
  }

  async index(snapshot: RetrievalSnapshot): Promise<void> {
    const endpoint = await this.ensure();
    await this.request(endpoint, "/index", "POST", snapshot);
  }

  async sync(snapshot: RetrievalSnapshot): Promise<{ mode: "full" | "delta" | "reused"; upserts: number; deletes: number }> {
    const manifestPath = path.join(this.stateDir, "client-index.json");
    const normalizedDocuments = snapshot.documents.map(document => {
      const hash = createHash("sha256").update(JSON.stringify(document)).digest("hex");
      return {
        ...document,
        source_id: document.source_id || document.source_uri || document.skill_id,
        source_revision: document.source_revision || hash,
        visibility: document.visibility || "available" as const,
        links: document.links || [],
      };
    });
    const normalizedSnapshot = { ...snapshot, documents: normalizedDocuments };
    const hashes = Object.fromEntries(normalizedDocuments.map(document => [document.skill_id,
      createHash("sha256").update(JSON.stringify(document)).digest("hex")]));
    let previous: {
      corpus_revision?: string;
      hashes?: Record<string, string>;
      generation?: number;
      revisions?: Record<string, string>;
      source_ids?: Record<string, string>;
    } = {};
    try { previous = JSON.parse(fs.readFileSync(manifestPath, "utf8")); } catch { /* first full submission */ }
    const endpoint = await this.ensure();
    let retryGeneration: number | undefined;
    if (previous.corpus_revision === snapshot.corpus_revision) {
      const status = await this.request<RetrievalWorkerStatus>(endpoint, "/status");
      if (status.ready && status.corpus_revision === snapshot.corpus_revision) {
        return { mode: "reused", upserts: 0, deletes: 0 };
      }
      if (status.building_revision === snapshot.corpus_revision) {
        return { mode: "reused", upserts: 0, deletes: 0 };
      }
      retryGeneration = Number(previous.generation || 1);
    }
    const previousHashes = previous.hashes || {};
    const upserts = normalizedDocuments.filter(document => previousHashes[document.skill_id] !== hashes[document.skill_id]);
    const deletes = Object.keys(previousHashes).filter(skillId => hashes[skillId] === undefined);
    const mode = retryGeneration !== undefined || !Object.keys(previousHashes).length ? "full" : "delta";
    const generation = retryGeneration ?? Number(previous.generation || 0) + 1;
    const events: RetrievalIndexEventV1[] = upserts.map(document => ({
      schema: "pkm.retrieval.index-event/v1",
      kind: "upsert",
      eventId: createHash("sha256").update(`upsert:${document.source_id}:${document.source_revision}:${hashes[document.skill_id]}`).digest("hex"),
      sourceId: document.source_id,
      sourceRevision: document.source_revision,
      source: {
        sourceId: document.source_id,
        sourceRevision: document.source_revision,
        contentHash: hashes[document.skill_id],
        contentType: document.content_type,
        sourceUri: document.source_uri,
        title: document.title,
        description: document.description,
        body: document.body,
        metadata: document.metadata,
        provenance: document.provenance,
        readOnly: document.read_only,
        visibility: document.visibility,
        links: document.links,
      },
    }));
    for (const skillId of deletes) {
      const sourceId = previous.source_ids?.[skillId] || skillId;
      events.push({
        schema: "pkm.retrieval.index-event/v1",
        kind: "delete",
        eventId: createHash("sha256").update(`delete:${sourceId}:${generation}`).digest("hex"),
        sourceId,
        sourceRevision: `delete-${generation}`,
      });
    }
    events.push({
      schema: "pkm.retrieval.index-event/v1",
      kind: "rebuild-barrier",
      eventId: createHash("sha256").update(`barrier:${generation}:${snapshot.corpus_revision}`).digest("hex"),
      sourceId: "__rebuild_barrier__",
      sourceRevision: String(generation),
      generation,
    });
    new RetrievalIndexEventStore(path.join(this.stateDir, "index-events.json")).apply(events);
    const submitted = { ...normalizedSnapshot, generation };
    if (mode === "full") await this.request(endpoint, "/index", "POST", submitted);
    else await this.request(endpoint, "/update", "POST", { corpus_revision: snapshot.corpus_revision, generation, upserts, deletes });
    const temporary = `${manifestPath}.${process.pid}.tmp`;
    const revisions = Object.fromEntries(normalizedDocuments.map(document => [document.skill_id, document.source_revision]));
    const source_ids = Object.fromEntries(normalizedDocuments.map(document => [document.skill_id, document.source_id]));
    fs.writeFileSync(temporary, JSON.stringify({ corpus_revision: snapshot.corpus_revision, hashes, generation, revisions, source_ids }), { mode: 0o600 });
    fs.renameSync(temporary, manifestPath);
    return { mode, upserts: upserts.length, deletes: deletes.length };
  }

  async status(): Promise<RetrievalWorkerStatus> {
    return this.request(await this.ensure(), "/status");
  }

  async search(query: string, limit = 5, contentTypeFilter?: string[], requestId = ""): Promise<any> {
    const result = await this.query({
      schema: RETRIEVAL_QUERY_SCHEMA_V1,
      requestId: requestId || `compat-${Date.now()}`,
      text: query,
      contentTypeFilter: contentTypeFilter as RetrievalQueryV1["contentTypeFilter"],
      scope: { capabilityId: "legacy-search" },
      topK: limit,
      route: "lexical",
      generation: { mode: "latest-ready" },
      diagnostics: "summary",
    });
    return requestId ? result : { ...result, request_id: "", requestId: "" };
  }

  async query(input: RetrievalQueryV1, signal?: AbortSignal): Promise<RetrievalResultV1 & Record<string, any>> {
    const compiled = compileRetrievalQueryV1(input);
    if (!compiled.ok) throw new Error(`Invalid retrieval query: ${compiled.diagnostics.map(item => `${item.pointer} ${item.message}`).join("; ")}`);
    if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Retrieval query cancelled.");
    const startedAt = Date.now();
    const deadlineAt = startedAt + (input.deadlineMs || 5_000);
    let status = await this.status();
    const matchesGeneration = (): boolean => input.generation.mode === "latest-ready"
      || (input.generation.mode === "exact" && status.ready_generation === input.generation.generation)
      || (input.generation.mode === "minimum" && status.ready_generation >= input.generation.generation);
    while (!matchesGeneration() && Date.now() < deadlineAt) {
      if (input.generation.mode === "exact" && status.ready_generation > input.generation.generation) {
        throw new Error(`Exact retrieval generation ${input.generation.generation} is unavailable; ready generation is ${status.ready_generation}.`);
      }
      await new Promise<void>((resolve, reject) => {
        const complete = () => {
          signal?.removeEventListener("abort", abort);
          resolve();
        };
        const timer = setTimeout(complete, 25);
        const abort = () => { clearTimeout(timer); reject(signal?.reason || new Error("Retrieval query cancelled.")); };
        if (signal?.aborted) abort();
        else signal?.addEventListener("abort", abort, { once: true });
      });
      status = await this.status();
    }
    if (!matchesGeneration()) throw new Error(`Retrieval generation policy was not satisfied before the deadline.`);
    const waitFinishedAt = Date.now();
    const result = await this.request<any>(await this.ensure(), "/search", "POST", {
      query: input.text,
      limit: input.topK,
      content_type_filter: input.contentTypeFilter,
      request_id: input.requestId,
      route: input.route,
      generation: input.generation,
      scope: {
        capability_id: input.scope.capabilityId,
        source_ids: input.scope.sourceIds,
        include_read_only: input.scope.includeReadOnly,
      },
      graph: input.graph ? {
        max_depth: input.graph.maxDepth,
        max_nodes: input.graph.maxNodes,
        max_edges: input.graph.maxEdges,
        relations: input.graph.relations,
        direction: input.graph.direction,
      } : undefined,
      diagnostics: input.diagnostics,
      deadline_at_ms: deadlineAt,
    }, { signal, timeoutMs: Math.max(1, deadlineAt - Date.now()) });
    const completedAt = Date.now();
    return {
      ...result,
      schema: "pkm.retrieval.result/v1",
      requestId: result.request_id,
      readyGeneration: result.ready_generation,
      corpusRevision: result.corpus_revision,
      intent: result.query_intent,
      timingsMs: {
        wait: waitFinishedAt - startedAt,
        search: completedAt - waitFinishedAt,
        total: completedAt - startedAt,
      },
      hits: (result.hits || []).map((hit: any) => ({
        ...hit,
        scoreComponents: hit.score_components || { lexical: hit.score || 0, semantic: 0, graph: 0, priority: 1 },
        sourceId: hit.source_id || hit.skill_id,
        sourceRevision: hit.source_revision || hit.content_hash,
        contentHash: hit.content_hash,
        contentType: hit.content_type,
        sourceUri: hit.source_uri,
        readOnly: !!hit.read_only,
        route: input.route,
      })),
      diagnostics: result.diagnostics || [],
      stale: !!result.stale,
      incomplete: !!result.incomplete,
    };
  }
}
