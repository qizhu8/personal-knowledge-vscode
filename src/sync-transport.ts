import { createHash } from "node:crypto";
import { z } from "zod";
import { parse as parseYaml } from "yaml";
import * as path from "node:path";
import { planSync, syncPlanHash } from "./sync-plan.js";
import { syncPlanManifestSchema, type SyncManifest } from "./sync-plan-contracts.js";
import { manifestJson, MANIFEST_PATH, validatePersona, portablePersonaPath } from "./domain/sync-transport-original.js";
import {
  syncTransportPinSchema, syncTransportPolicySchema, syncTransportPublicationSchema, syncTransportShaSchema,
  type SyncTransportPin, type SyncTransportPolicy, type SyncTransportPublication, type SyncTransportStatus,
} from "./sync-transport-contracts.js";
import { SyncTransportStore, type SyncTransportJournal } from "./sync-transport-store.js";
import type { LegacyGitLease } from "./legacy-github-git-lease.js";
import type { SyncNativeGitProvider } from "./sync-native-git-provider.js";
import { legacyMarkdownAssets, skillAssetPaths } from "./legacy-sync-markdown-assets.js";

type Member = SyncManifest["files"][number] | SyncManifest["deletions"][number];
type TreeEntry = { path: string; mode: "100644" | "100755"; type: "blob"; sha: string; size?: number };
const sha = syncTransportShaSchema;
const commitSchema = z.object({
  sha, tree: z.object({ sha }), parents: z.array(z.object({ sha })).max(100),
  message: z.string().max(1000),
  author: z.object({ name: z.string(), email: z.string(), date: z.string() }),
  committer: z.object({ name: z.string(), email: z.string(), date: z.string() }),
});
const treeSchema = z.object({
  sha, truncated: z.literal(false),
  tree: z.array(z.object({
    path: z.string().min(1).max(512), mode: z.enum(["100644", "100755", "040000"]),
    type: z.enum(["blob", "tree"]), sha, size: z.number().int().nonnegative().safe().optional(),
  })),
});
const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
export const syncTransportGitObjectSha = (type: "blob" | "tree" | "commit", bytes: Buffer): string =>
  createHash("sha1").update(`${type} ${bytes.length}\0`).update(bytes).digest("hex");

export class SyncTransportError extends Error {
  constructor(readonly code: "AUTH" | "DENIED" | "CANCELED" | "TIMEOUT" | "NETWORK" | "REDIRECT" | "REMOTE" | "RATE_LIMIT" | "MALFORMED" | "STALE" | "REVIEW", readonly retryAfterMs?: number) {
    super(`GitHub transport ${code.toLowerCase()}; no remote response or credentials are included.`);
    this.name = "SyncTransportError";
  }
}

export interface SyncTransportNativeHost {
  /** Configuration/approval is native authority. No caller URL, token, repository override, or environment lookup. */
  policy: SyncTransportPolicy;
  fetch: typeof fetch;
  readSecret(secretRef: string, signal: AbortSignal): Promise<{ login: string; accessToken: string }>;
  authorizeMember(member: Member, direction: "read" | "publish", policy: SyncTransportPolicy): void;
  validateDomainContent(file: SyncManifest["files"][number], bytes: Buffer, direction: "read" | "publish"): void;
  verifyStagedPublication(publication: SyncTransportPublication): void;
  assertPublicationAuthority?(): void;
  approvePublication(planHash: string, approvalId: string): Promise<boolean>;
  /** Optional native Git object backend and atomic lease; requires explicit native runtime authority. */
  nativeGit?: SyncNativeGitProvider;
  /** Also verify native Git repository identity and visibility using the existing authenticated GitHub API provider. */
  nativeGitRepositoryViaApi?: true;
  repositoryLayout?: "skills-mount";
  /** Excludes repository visibility changes for the entire private publication, not just its preflight. */
  withRepositoryVisibilityFence?<T>(policy: SyncTransportPolicy, work: () => Promise<T>): Promise<T>;
  /**
   * GitHub REST PATCH has NO expected-SHA parameter. This mandatory native boundary must enforce
   * exclude every competing writer for this repository/ref throughout the update, or provide an
   * actual atomic expected-commit update. A local lease or preflight GET cannot exclude foreign
   * GitHub writers. No default is supplied.
   */
  withExpectedCommitCAS<T>(policy: SyncTransportPolicy, expectedCommit: string, update: () => Promise<T>): Promise<T>;
}

export type SyncTransportOptions = { timeoutMs?: number; safeGetRetries?: 0 | 1 | 2; maxBackoffMs?: number };

function pathCheck(path: string): void {
  if (path !== path.normalize("NFC") || path.includes("\\") || path.startsWith("/") || /[\x00-\x1f\x7f]/.test(path)
    || path.split("/").some(part => !part || part === "." || part === ".." || part.toLowerCase() === ".git")
    || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(path)) {
    throw new SyncTransportError("MALFORMED");
  }
}

function versionOrder(left: string, right: string): number {
  if (!/^\d+\.\d+\.\d+$/.test(left) || !/^\d+\.\d+\.\d+$/.test(right)) throw new SyncTransportError("MALFORMED");
  const a = left.split(".").map(Number), b = right.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  return 0;
}

function flattenedTreeSha(entries: readonly TreeEntry[]): string {
  type Directory = Map<string, Directory | TreeEntry>;
  const root: Directory = new Map();
  for (const entry of entries) {
    const parts = entry.path.split("/");
    let directory = root;
    for (const part of parts.slice(0, -1)) {
      const prior = directory.get(part);
      if (prior && !(prior instanceof Map)) throw new SyncTransportError("MALFORMED");
      if (!prior) directory.set(part, new Map());
      directory = directory.get(part) as Directory;
    }
    if (directory.has(parts.at(-1)!)) throw new SyncTransportError("MALFORMED");
    directory.set(parts.at(-1)!, entry);
  }
  const hash = (directory: Directory): string => {
    const entries = [...directory].map(([name, value]) => ({
      name, sortName: name + (value instanceof Map ? "/" : ""),
      mode: value instanceof Map ? "40000" : value.mode,
      sha: value instanceof Map ? hash(value) : value.sha,
    })).sort((a, b) => Buffer.compare(Buffer.from(a.sortName), Buffer.from(b.sortName)));
    return syncTransportGitObjectSha("tree", Buffer.concat(entries.map(entry =>
      Buffer.concat([Buffer.from(`${entry.mode} ${entry.name}\0`), Buffer.from(entry.sha, "hex")]))));
  };
  return hash(root);
}

export class GitHubSyncTransport {
  private readonly policy: SyncTransportPolicy;
  private readonly prefix: string;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly backoffMs: number;

  constructor(private readonly host: SyncTransportNativeHost, private readonly store: SyncTransportStore, options: SyncTransportOptions = {},
    private readonly gitLease?: LegacyGitLease) {
    this.policy = Object.freeze(syncTransportPolicySchema.parse(host.policy));
    this.prefix = `/repos/${encodeURIComponent(this.policy.owner)}/${encodeURIComponent(this.policy.repository)}`;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.retries = options.safeGetRetries ?? 0;
    this.backoffMs = options.maxBackoffMs ?? 1000;
    if (!host.fetch || this.timeoutMs < 1 || this.timeoutMs > 30_000 || ![0, 1, 2].includes(this.retries)
      || this.backoffMs < 0 || this.backoffMs > 30_000) throw new SyncTransportError("DENIED");
  }

  private async request(method: "GET" | "POST" | "PATCH", path: string, body: unknown, signal?: AbortSignal,
    apiRepository = false): Promise<unknown> {
    if (this.host.nativeGit && !apiRepository) {
      if (!this.gitLease) throw new SyncTransportError("DENIED");
      try { return await this.host.nativeGit.request(method, path, body, signal); }
      catch { throw new SyncTransportError(signal?.aborted ? "CANCELED" : "REMOTE"); }
    }
    for (let attempt = 0; ; attempt++) {
      if (signal?.aborted) throw new SyncTransportError("CANCELED");
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const cancel = () => controller.abort();
      signal?.addEventListener("abort", cancel, { once: true });
      try {
        const result = await Promise.race([
          (async () => {
            let secret: { login: string; accessToken: string };
            try { secret = await this.host.readSecret(this.policy.secretRef, controller.signal); }
            catch { throw new SyncTransportError("AUTH"); }
            if (controller.signal.aborted) throw new SyncTransportError("CANCELED");
            if (!secret || secret.login.toLowerCase() !== this.policy.expectedLogin.toLowerCase()
              || !secret.accessToken || /[\x00-\x20\x7f]/.test(secret.accessToken)) throw new SyncTransportError("AUTH");
            let response: Response;
            try {
              response = await this.host.fetch(`https://api.github.com${this.prefix}${path}`, {
                method, redirect: "manual", signal: controller.signal,
                headers: { Authorization: `Bearer ${secret.accessToken}`, Accept: "application/vnd.github+json",
                  "X-GitHub-Api-Version": "2022-11-28", "Content-Type": "application/json" },
                ...(body === undefined ? {} : { body: JSON.stringify(body) }),
              });
            } catch { throw new SyncTransportError(signal?.aborted ? "CANCELED" : "NETWORK"); }
            if (response.status >= 300 && response.status < 400) { await response.body?.cancel(); throw new SyncTransportError("REDIRECT"); }
            if (!response.ok) {
              await response.body?.cancel();
              const rateLimited = response.status === 429 || response.status === 403
                && (response.headers.get("x-ratelimit-remaining") === "0" || response.headers.has("retry-after"));
              const retryAfter = response.headers.get("retry-after");
              const reset = response.headers.get("x-ratelimit-reset");
              const delay = retryAfter === null ? reset === null ? undefined : Math.max(0, Number(reset) * 1000 - Date.now())
                : /^\d+$/.test(retryAfter) ? Number(retryAfter) * 1000 : Math.max(0, Date.parse(retryAfter) - Date.now());
              throw new SyncTransportError(rateLimited ? "RATE_LIMIT" : response.status === 409 || response.status === 422 ? "STALE" : "REMOTE",
                delay !== undefined && Number.isFinite(delay) ? delay : undefined);
            }
            const reader = response.body?.getReader();
            if (!reader) throw new SyncTransportError("MALFORMED");
            const chunks: Uint8Array[] = [];
            let size = 0, warnedLargeResponse = false;
            try {
              while (true) {
                const chunk = await reader.read();
                if (chunk.done) break;
                size += chunk.value.length;
                if (size > 12_000_000 && !warnedLargeResponse) {
                  console.warn("PKM sync transport: response exceeds 12 MB; continuing without an application size limit.");
                  warnedLargeResponse = true;
                }
                chunks.push(chunk.value);
              }
            } finally { await reader.cancel().catch(() => {}); }
            try { return JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(Buffer.concat(chunks))); }
            catch { throw new SyncTransportError("MALFORMED"); }
          })(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => { controller.abort(); reject(new SyncTransportError("TIMEOUT")); }, this.timeoutMs);
            controller.signal.addEventListener("abort", () => reject(new SyncTransportError(signal?.aborted ? "CANCELED" : "TIMEOUT")), { once: true });
          }),
        ]);
        return result;
      } catch (error) {
        const safe = error instanceof SyncTransportError ? error : new SyncTransportError("MALFORMED");
        if (method !== "GET" || attempt >= this.retries || !["NETWORK", "TIMEOUT", "RATE_LIMIT"].includes(safe.code)
          || safe.code === "RATE_LIMIT" && (safe.retryAfterMs === undefined || safe.retryAfterMs > this.backoffMs)) throw safe;
        await new Promise<void>((resolve, reject) => {
          const abort = () => { clearTimeout(wait); reject(new SyncTransportError("CANCELED")); };
          const wait = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); },
            safe.retryAfterMs ?? Math.min(this.backoffMs, 100 * 2 ** attempt));
          signal?.addEventListener("abort", abort, { once: true });
          if (signal?.aborted) abort();
        });
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", cancel);
      }
    }
  }

  private parse<T>(schema: z.ZodType<T>, value: unknown): T {
    const result = schema.safeParse(value);
    if (!result.success) throw new SyncTransportError("MALFORMED");
    return result.data;
  }

  private async ref(signal?: AbortSignal): Promise<string> {
    const result = this.parse(z.object({ ref: z.literal(`refs/heads/${this.policy.branch}`), object: z.object({ type: z.literal("commit"), sha }) }),
      await this.request("GET", `/git/ref/heads/${this.policy.branch.split("/").map(encodeURIComponent).join("/")}`, undefined, signal));
    return result.object.sha;
  }

  private async tree(treeSha: string, signal?: AbortSignal): Promise<TreeEntry[]> {
    const result = this.parse(treeSchema, await this.request("GET", `/git/trees/${sha.parse(treeSha)}?recursive=1`, undefined, signal));
    if (result.sha !== treeSha) throw new SyncTransportError("MALFORMED");
    const seen = new Set<string>();
    for (const entry of result.tree) {
      pathCheck(entry.path);
      if (seen.has(entry.path.normalize("NFC").toLowerCase())) throw new SyncTransportError("MALFORMED");
      seen.add(entry.path.normalize("NFC").toLowerCase());
      if ((entry.mode === "040000") !== (entry.type === "tree")) throw new SyncTransportError("MALFORMED");
    }
    const blobs = result.tree.filter((entry): entry is TreeEntry => entry.type === "blob" && entry.mode !== "040000");
    if (flattenedTreeSha(blobs) !== treeSha) throw new SyncTransportError("MALFORMED");
    return blobs;
  }

  private async blob(blobSha: string, signal?: AbortSignal): Promise<Buffer> {
    const result = this.parse(z.object({ sha, encoding: z.literal("base64"), content: z.string(), size: z.number().int().min(0).safe() }),
      await this.request("GET", `/git/blobs/${sha.parse(blobSha)}`, undefined, signal));
    const encoded = result.content.replace(/\n/g, "");
    const bytes = Buffer.from(encoded, "base64");
    if (result.sha !== blobSha || bytes.length !== result.size || bytes.toString("base64") !== encoded
      || syncTransportGitObjectSha("blob", bytes) !== blobSha) throw new SyncTransportError("MALFORMED");
    return bytes;
  }

  private async repository(signal?: AbortSignal): Promise<void> {
    if (this.host.nativeGit) {
      try { await this.host.nativeGit.verifyRepository(this.policy); }
      catch { throw new SyncTransportError("DENIED"); }
      if (!this.host.nativeGitRepositoryViaApi) return;
    }
    const result = this.parse(z.object({ full_name: z.string(), private: z.boolean() }),
      await this.request("GET", "", undefined, signal, !!this.host.nativeGit));
    if (result.full_name.toLowerCase() !== `${this.policy.owner}/${this.policy.repository}`.toLowerCase()
      || result.private !== (this.policy.visibility === "private")) throw new SyncTransportError("DENIED");
  }

  private managedPath(relative: string): string {
    if (this.host.repositoryLayout !== "skills-mount") return relative;
    if (!relative.startsWith("skills/")) throw new SyncTransportError("DENIED");
    const mapped = `Skills/${relative.slice("skills/".length)}`;
    pathCheck(mapped);
    return mapped;
  }

  private async initialSkillsMount(entries: TreeEntry[], signal?: AbortSignal): Promise<SyncManifest> {
    const skills = entries.filter(entry => entry.path.startsWith("Skills/"));
    if (skills.length > 10_000) throw new SyncTransportError("DENIED");
    const files: SyncManifest["files"] = [], names = new Set<string>(), identities = new Set<string>();
    const contents = new Map<string, Buffer>(), owned = new Set<string>();
    const retained = legacyMarkdownAssets();
    let bytesTotal = 0;
    for (const entry of skills) {
      const relative = `skills/${entry.path.slice("Skills/".length)}`;
      const bytes = await this.blob(entry.sha, signal);
      bytesTotal += bytes.length;
      if (bytesTotal > 64 * 1024 * 1024) throw new SyncTransportError("DENIED");
      contents.set(relative, bytes);
    }
    for (const [relative, bytes] of contents) {
      if (!/\.md$/.test(relative) || relative.split("/").slice(1, -1).some(retained.isMarkdownAssetDirectory)) continue;
      if (!/^skills\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.md$/.test(relative)
        || !Buffer.from(bytes.toString("utf8")).equals(bytes)) throw new SyncTransportError("DENIED");
      const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(bytes.toString("utf8"));
      let frontmatter: unknown;
      try { frontmatter = match ? parseYaml(match[1]) : undefined; } catch { throw new SyncTransportError("MALFORMED"); }
      const itemId = path.posix.basename(relative, ".md");
      if (!frontmatter || typeof frontmatter !== "object" || Array.isArray(frontmatter)
        || (frontmatter as { name?: unknown }).name !== itemId || names.has(itemId.toLowerCase()))
        throw new SyncTransportError("DENIED");
      names.add(itemId.toLowerCase());
      const identity = (frontmatter as { knowledgeId?: unknown }).knowledgeId;
      if (identity !== undefined && (typeof identity !== "string" || !/^knowledge_[a-f0-9]{24}$/.test(identity)
        || identities.has(identity))) throw new SyncTransportError("DENIED");
      if (typeof identity === "string") identities.add(identity);
      const category = path.posix.dirname(relative).slice("skills".length).replace(/^\//, "");
      const document = { path: relative, type: "skills" as const, itemId, category, member: "", privacy: "public" as const,
        digest: sha256(bytes), contentBase64: bytes.toString("base64") };
      files.push(document); owned.add(relative);
      let assets: Set<string>;
      try { assets = skillAssetPaths(relative, bytes.toString("utf8"), contents.keys()); }
      catch { throw new SyncTransportError("DENIED"); }
      for (const asset of assets) {
        if (owned.has(asset)) throw new SyncTransportError("DENIED");
        const content = contents.get(asset)!;
        files.push({ ...document, path: asset, member: asset, digest: sha256(content), contentBase64: content.toString("base64") });
        owned.add(asset);
      }
    }
    if (owned.size !== contents.size) throw new SyncTransportError("DENIED");
    return syncPlanManifestSchema.parse({ schema: 3, capabilities: { storage: "pkm.github.publication/v1",
      required: ["explicit-deletions", "stable-entity-identity", "entity-partial-progress"] }, files, deletions: [] });
  }

  private validateManifest(manifest: SyncManifest, direction: "read" | "publish"): void {
    const snapshot = { manifest, sha256: syncPlanHash(manifest) };
    try { planSync({ base: snapshot, local: snapshot, remote: snapshot }); }
    catch { throw new SyncTransportError("MALFORMED"); }
    if (manifest.minimumExtensionVersion && versionOrder(this.policy.extensionVersion, manifest.minimumExtensionVersion) < 0) throw new SyncTransportError("DENIED");
    for (const member of [...manifest.files, ...manifest.deletions]) {
      if (member.privacy === "private" && (!this.policy.allowPrivate || this.policy.visibility !== "private")
        || member.type === "profiles" && !this.policy.profileConsentScope) throw new SyncTransportError("DENIED");
      try { this.host.authorizeMember(member, direction, this.policy); }
      catch { throw new SyncTransportError("DENIED"); }
    }
    for (const file of manifest.files) {
      if (file.contentBase64 === undefined) throw new SyncTransportError("MALFORMED");
      const bytes = Buffer.from(file.contentBase64, "base64");
      if (file.type === "profiles" && (bytes.length > 32_000 || !Buffer.from(bytes.toString("utf8")).equals(bytes))) throw new SyncTransportError("MALFORMED");
      if (file.type === "profiles") {
        try {
          const record: unknown = JSON.parse(bytes.toString("utf8"));
          validatePersona(record);
          if (portablePersonaPath(record) !== file.path || file.itemId !== `${record.kind}/${record.id}`) throw new Error("Profile identity mismatch");
        } catch { throw new SyncTransportError("MALFORMED"); }
      }
      if (direction === "publish" && /^(?:<<<<<<<(?: .*)?|>>>>>>>(?: .*)?)\r?$/m.test(bytes.toString("utf8"))) throw new SyncTransportError("DENIED");
      try { this.host.validateDomainContent(file, bytes, direction); }
      catch { throw new SyncTransportError("DENIED"); }
    }
  }

  /** Only configured native policy is used. Ref, tree, manifest and all managed blobs are immutable pins. */
  async readPin(commit?: string, signal?: AbortSignal): Promise<SyncTransportPin> {
    await this.repository(signal);
    const commitSha = commit === undefined ? await this.ref(signal) : sha.parse(commit);
    const object = this.parse(commitSchema, await this.request("GET", `/git/commits/${commitSha}`, undefined, signal));
    if (object.sha !== commitSha) throw new SyncTransportError("MALFORMED");
    const entries = await this.tree(object.tree.sha, signal);
    const manifestPath = this.host.repositoryLayout === "skills-mount" ? `Skills/${MANIFEST_PATH}` : MANIFEST_PATH;
    const manifestEntry = entries.find(entry => entry.path === manifestPath);
    if (!manifestEntry && this.host.repositoryLayout === "skills-mount") {
      const manifest = await this.initialSkillsMount(entries, signal);
      this.validateManifest(manifest, "read");
      return syncTransportPinSchema.parse({ schema: "pkm.sync-transport-pin/v1", policyId: this.policy.policyId,
        commit: commitSha, tree: object.tree.sha, manifestBlob: null, initialSkillsMount: true,
        manifest, manifestHash: syncPlanHash(manifest) });
    }
    if (!manifestEntry || manifestEntry.mode !== "100644") throw new SyncTransportError("MALFORMED");
    let manifest: SyncManifest;
    try { manifest = syncPlanManifestSchema.parse(JSON.parse((await this.blob(manifestEntry.sha, signal)).toString("utf8"))); }
    catch (error) { if (error instanceof SyncTransportError) throw error; throw new SyncTransportError("MALFORMED"); }
    // Publication metadata cannot inject staged content; only exact repository blobs may supply it.
    if (manifest.files.some(file => file.contentBase64 !== undefined)) throw new SyncTransportError("MALFORMED");
    if (this.host.repositoryLayout === "skills-mount" && [...manifest.files, ...manifest.deletions].some(file => file.type !== "skills"))
      throw new SyncTransportError("DENIED");
    for (const file of manifest.files) {
      const entry = entries.find(candidate => candidate.path === this.managedPath(file.path));
      if (!entry) throw new SyncTransportError("MALFORMED");
      try { this.host.authorizeMember(file, "read", this.policy); }
      catch { throw new SyncTransportError("DENIED"); }
      if (file.privacy === "private" && (!this.policy.allowPrivate || this.policy.visibility !== "private")
        || file.type === "profiles" && !this.policy.profileConsentScope) throw new SyncTransportError("DENIED");
      const content = await this.blob(entry.sha, signal);
      if (sha256(content) !== file.digest) throw new SyncTransportError("MALFORMED");
      file.contentBase64 = content.toString("base64");
    }
    this.validateManifest(manifest, "read");
    return syncTransportPinSchema.parse({
      schema: "pkm.sync-transport-pin/v1", policyId: this.policy.policyId, commit: commitSha,
      tree: object.tree.sha, manifestBlob: manifestEntry.sha, manifest, manifestHash: syncPlanHash(manifest),
    });
  }

  status(operationId: string, actorId: string): SyncTransportStatus | undefined {
    return this.store.read(operationId, actorId)?.status;
  }

  private async post(journal: SyncTransportJournal, pending: NonNullable<SyncTransportJournal["pending"]>, state: SyncTransportStatus["state"], signal?: AbortSignal): Promise<{ journal: SyncTransportJournal; response: unknown }> {
    const prepared = this.store.transition(journal, state, { pending });
    // Never retry a POST/PATCH, including rejected/rate-limited or canceled operations.
    const response = await this.request(pending.method, pending.path, pending.body, signal);
    return { journal: prepared, response };
  }

  private async publicationTree(plan: SyncTransportPublication, signal?: AbortSignal) {
    const base = await this.readPin(plan.expectedCommit, signal);
    if (base.tree !== plan.expectedTree || base.manifestHash !== plan.sourcePins.remote) throw new SyncTransportError("DENIED");
    const entries = await this.tree(plan.expectedTree, signal);
    const previous = new Map(base.manifest.files.map(file => [file.path, file]));
    const next = new Map(plan.manifest.files.map(file => [file.path, file]));
    const changed = new Map<string, Buffer | null>();
    for (const file of base.manifest.files) if (!next.has(file.path)) {
      const retainedEntity = plan.manifest.files.some(candidate => candidate.type === file.type && candidate.itemId === file.itemId);
      const deletion = plan.manifest.deletions.some(candidate => candidate.type === file.type && candidate.itemId === file.itemId);
      if (!retainedEntity && !deletion) throw new SyncTransportError("DENIED");
      changed.set(this.managedPath(file.path), null);
    }
    for (const file of plan.manifest.files) {
      const physical = this.managedPath(file.path);
      const occupied = entries.find(entry => entry.path === physical);
      if (occupied && !previous.has(file.path)) throw new SyncTransportError("DENIED");
      if (previous.get(file.path)?.digest !== file.digest) changed.set(physical, Buffer.from(file.contentBase64!, "base64"));
    }
    const wireFiles = plan.manifest.files.map(({ contentBase64: _content, ...file }) => file);
    const manifestBytes = Buffer.from(manifestJson(wireFiles, plan.manifest.deletions));
    const wireManifest = syncPlanManifestSchema.parse(JSON.parse(manifestBytes.toString("utf8")));
    if (wireManifest.minimumExtensionVersion && versionOrder(this.policy.extensionVersion, wireManifest.minimumExtensionVersion) < 0) throw new SyncTransportError("DENIED");
    changed.set(this.host.repositoryLayout === "skills-mount" ? `Skills/${MANIFEST_PATH}` : MANIFEST_PATH, manifestBytes);
    const desired = new Map(entries.map(entry => [entry.path, entry]));
    for (const [path, bytes] of changed) {
      if (bytes === null) desired.delete(path);
      else desired.set(path, { path, mode: desired.get(path)?.mode ?? "100644", type: "blob", sha: syncTransportGitObjectSha("blob", bytes) });
    }
    return { entries, changed, desired, expectedTree: flattenedTreeSha([...desired.values()]) };
  }

  async publish(raw: SyncTransportPublication, signal?: AbortSignal): Promise<SyncTransportStatus> {
    const publication = syncTransportPublicationSchema.parse(raw);
    if (this.host.nativeGit && this.host.nativeGitRepositoryViaApi
      && [...publication.manifest.files, ...publication.manifest.deletions].some(member => member.privacy === "private")) {
      if (!this.host.withRepositoryVisibilityFence) throw new SyncTransportError("DENIED");
      return this.host.withRepositoryVisibilityFence(this.policy, () => this.publishFenced(publication, signal));
    }
    return this.publishFenced(publication, signal);
  }

  private async publishFenced(raw: SyncTransportPublication, signal?: AbortSignal): Promise<SyncTransportStatus> {
    if (!this.gitLease && typeof this.host.withExpectedCommitCAS !== "function") throw new SyncTransportError("DENIED");
    const plan = syncTransportPublicationSchema.parse(raw);
    const { planHash, ...unsigned } = plan;
    if (plan.policyId !== this.policy.policyId || syncPlanHash(unsigned) !== planHash
      || plan.manifestHash !== syncPlanHash(plan.manifest)) throw new SyncTransportError("DENIED");
    this.validateManifest(plan.manifest, "publish");
    try {
      this.host.verifyStagedPublication(plan);
      if (!await this.host.approvePublication(planHash, this.policy.approvalId)) throw new SyncTransportError("DENIED");
    } catch { throw new SyncTransportError("DENIED"); }
    if (signal?.aborted) throw new SyncTransportError("CANCELED");
    let journal: SyncTransportJournal;
    try { journal = this.store.prepare(plan); }
    catch { throw new SyncTransportError("REVIEW"); }
    if (journal.status.state !== "prepared") return journal.status;
    await this.repository(signal);
    if (await this.ref(signal) !== plan.expectedCommit) return this.store.transition(journal, "stale").status;
    const { entries, changed, desired, expectedTree } = await this.publicationTree(plan, signal);
    try {
      for (const [path, bytes] of changed) {
        if (bytes === null) continue;
        const expectedSha = syncTransportGitObjectSha("blob", bytes);
        const posted = await this.post(journal, { method: "POST", path: "/git/blobs", body: { content: bytes.toString("base64"), encoding: "base64" }, expectedSha }, "tree-pending", signal);
        journal = posted.journal;
        if (this.parse(z.object({ sha }), posted.response).sha !== expectedSha) throw new SyncTransportError("MALFORMED");
        if (!(await this.blob(expectedSha, signal)).equals(bytes)) throw new SyncTransportError("MALFORMED");
        journal = this.store.transition(journal, "blobs-created", { pending: undefined });
        if (!desired.has(path)) throw new SyncTransportError("MALFORMED");
      }
      const treeBody = {
        base_tree: plan.expectedTree,
        tree: [...changed].map(([path, bytes]) => ({ path, mode: desired.get(path)?.mode ?? entries.find(entry => entry.path === path)?.mode ?? "100644", type: "blob", sha: bytes === null ? null : syncTransportGitObjectSha("blob", bytes) })),
      };
      const treePost = await this.post(journal, { method: "POST", path: "/git/trees", body: treeBody, expectedSha: expectedTree }, "tree-pending", signal);
      journal = treePost.journal;
      if (this.parse(z.object({ sha }), treePost.response).sha !== expectedTree) throw new SyncTransportError("MALFORMED");
      await this.tree(expectedTree, signal);
      journal = this.store.transition(journal, "tree-created", { pending: undefined, status: { ...journal.status, tree: expectedTree } });
      const date = plan.message.slice("PKM sync ".length);
      // Git commit timestamps have second precision; the original message retains its ISO milliseconds.
      const identity = { name: "Personal Knowledge Manager", email: "pkm@localhost",
        date: new Date(Math.floor(Date.parse(date) / 1000) * 1000).toISOString() };
      const commitBody = { message: plan.message, tree: expectedTree, parents: [plan.expectedCommit], author: identity, committer: identity };
      const commitPost = await this.post(journal, { method: "POST", path: "/git/commits", body: commitBody }, "commit-pending", signal);
      journal = commitPost.journal;
      const commit = this.parse(commitSchema, commitPost.response);
      this.verifyCommit(commit, journal);
      const inspect = this.parse(commitSchema, await this.request("GET", `/git/commits/${commit.sha}`, undefined, signal));
      this.verifyCommit(inspect, journal);
      if (inspect.sha !== commit.sha) throw new SyncTransportError("MALFORMED");
      journal = this.store.transition(journal, "commit-created", { pending: undefined, status: { ...journal.status, commit: commit.sha } });
      if (this.gitLease) return await this.gitLease.push(plan.operationId, plan.actorId, signal);
      journal = await this.host.withExpectedCommitCAS(this.policy, plan.expectedCommit, async () => {
        if (await this.ref(signal) !== plan.expectedCommit) return this.store.transition(journal, "stale");
        const refPost = await this.post(journal, {
          method: "PATCH", path: `/git/refs/heads/${this.policy.branch.split("/").map(encodeURIComponent).join("/")}`,
          body: { sha: commit.sha, force: false }, expectedSha: commit.sha,
        }, "ref-pending", signal);
        journal = refPost.journal;
        const response = this.parse(z.object({ ref: z.literal(`refs/heads/${this.policy.branch}`), object: z.object({ type: z.literal("commit"), sha }) }), refPost.response);
        if (response.object.sha !== commit.sha || await this.ref(signal) !== commit.sha) throw new SyncTransportError("REVIEW");
        return this.store.transition(journal, "published", { pending: undefined });
      });
      return journal.status;
    } catch (error) {
      // The write-ahead state remains pending if a response was lost, malformed, canceled or not durably receipted.
      // Subsequent publish calls return that state and never issue another POST/PATCH.
      if (error instanceof SyncTransportError) throw error;
      throw new SyncTransportError("REVIEW");
    }
  }

  private verifyCommit(commit: z.infer<typeof commitSchema>, journal: SyncTransportJournal): void {
    const plan = journal.publication;
    const date = plan.message.slice("PKM sync ".length);
    if (commit.tree.sha !== journal.status.tree || commit.parents.length !== 1 || commit.parents[0].sha !== plan.expectedCommit
      || commit.message !== plan.message || [commit.author, commit.committer].some(identity =>
        identity.name !== "Personal Knowledge Manager" || identity.email !== "pkm@localhost"
          || Date.parse(identity.date) !== Math.floor(Date.parse(date) / 1000) * 1000)) {
      throw new SyncTransportError("MALFORMED");
    }
  }

  /** Read-only reconciliation. An unknown/dangling commit requires an explicit native-supplied candidate SHA. */
  async reconcile(operationId: string, actorId: string, candidateCommit?: string, signal?: AbortSignal): Promise<SyncTransportStatus> {
    let journal = this.store.read(operationId, actorId);
    if (!journal || journal.publication.policyId !== this.policy.policyId) throw new SyncTransportError("DENIED");
    if (["published", "stale", "needs-review"].includes(journal.status.state)) return journal.status;
    if (this.gitLease && journal.status.state === "ref-pending") {
      this.validateManifest(journal.publication.manifest, "publish");
      const tree = await this.publicationTree(journal.publication, signal);
      if (tree.expectedTree !== journal.status.tree) throw new SyncTransportError("DENIED");
      try { return await this.gitLease.reconcile(operationId, actorId, signal); }
      catch { throw new SyncTransportError("REVIEW"); }
    }
    await this.repository(signal);
    if (journal.pending?.path === "/git/blobs" && journal.pending.expectedSha) {
      const bytes = await this.blob(journal.pending.expectedSha, signal);
      const body = this.parse(z.object({ content: z.string(), encoding: z.literal("base64") }), journal.pending.body);
      if (!bytes.equals(Buffer.from(body.content, "base64"))) throw new SyncTransportError("MALFORMED");
      return this.store.transition(journal, "needs-review").status;
    }
    if (journal.pending?.path === "/git/trees" && journal.pending.expectedSha) {
      await this.tree(journal.pending.expectedSha, signal);
      return this.store.transition(journal, "needs-review", { status: { ...journal.status, tree: journal.pending.expectedSha } }).status;
    }
    const commitSha = journal.status.commit ?? (candidateCommit === undefined ? await this.ref(signal) : sha.parse(candidateCommit));
    if (commitSha === journal.publication.expectedCommit) return this.store.transition(journal, "needs-review").status;
    const commit = this.parse(commitSchema, await this.request("GET", `/git/commits/${commitSha}`, undefined, signal));
    if (commit.sha !== commitSha) throw new SyncTransportError("MALFORMED");
    this.verifyCommit(commit, journal);
    await this.tree(commit.tree.sha, signal);
    const atRef = await this.ref(signal);
    journal = this.store.transition(journal, atRef === commitSha ? "published" : "needs-review", {
      status: { ...journal.status, commit: commitSha }, pending: undefined,
    });
    return journal.status;
  }
}
