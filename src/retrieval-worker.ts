import * as fs from "fs";
import * as path from "path";
import { spawn } from "child_process";
import { createHash } from "crypto";
import type { RetrievalSnapshot } from "./retrieval-snapshot";

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
  ready: boolean;
  document_count: number;
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

  private async request<T>(endpoint: RetrievalEndpoint, route: string, method = "GET", body?: unknown): Promise<T> {
    const response = await fetch(`http://127.0.0.1:${endpoint.port}${route}`, {
      method,
      headers: { "X-PKM-Retrieval-Token": endpoint.token, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(route === "/index" ? 30_000 : 5_000),
    });
    const value = await response.json() as any;
    if (!response.ok) throw new Error(value?.error || `Retrieval worker returned ${response.status}.`);
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
    const child = spawn(this.python, [this.workerScript, this.stateDir, this.configurationHash], {
      detached: true,
      stdio: "ignore",
      windowsHide: process.platform === "win32",
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
    const hashes = Object.fromEntries(snapshot.documents.map(document => [document.skill_id,
      createHash("sha256").update(JSON.stringify(document)).digest("hex")]));
    let previous: { corpus_revision?: string; hashes?: Record<string, string> } = {};
    try { previous = JSON.parse(fs.readFileSync(manifestPath, "utf8")); } catch { /* first full submission */ }
    const endpoint = await this.ensure();
    if (previous.corpus_revision === snapshot.corpus_revision) {
      const status = await this.request<RetrievalWorkerStatus>(endpoint, "/status");
      if (status.ready && status.corpus_revision === snapshot.corpus_revision) {
        return { mode: "reused", upserts: 0, deletes: 0 };
      }
      previous = {};
    }
    const previousHashes = previous.hashes || {};
    const upserts = snapshot.documents.filter(document => previousHashes[document.skill_id] !== hashes[document.skill_id]);
    const deletes = Object.keys(previousHashes).filter(skillId => hashes[skillId] === undefined);
    const mode = Object.keys(previousHashes).length ? "delta" : "full";
    if (mode === "full") await this.request(endpoint, "/index", "POST", snapshot);
    else await this.request(endpoint, "/update", "POST", { corpus_revision: snapshot.corpus_revision, upserts, deletes });
    const temporary = `${manifestPath}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify({ corpus_revision: snapshot.corpus_revision, hashes }), { mode: 0o600 });
    fs.renameSync(temporary, manifestPath);
    return { mode, upserts: upserts.length, deletes: deletes.length };
  }

  async status(): Promise<RetrievalWorkerStatus> {
    return this.request(await this.ensure(), "/status");
  }

  async search(query: string, limit = 5, contentTypeFilter?: string[], requestId = ""): Promise<any> {
    return this.request(await this.ensure(), "/search", "POST", {
      query, limit, content_type_filter: contentTypeFilter, request_id: requestId,
    });
  }
}
