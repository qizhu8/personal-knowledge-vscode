import * as net from "node:net";
import * as fs from "node:fs";
import * as path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import type { SelectedActionArtifact, SelectedActionDestination } from "./action-artifact-picker";

export interface AutomaticActionTrustRequest {
  operation: "status" | "prepare" | "authorize" | "effect_consent" | "revoke" | "artifact_pick" | "artifact_export_pick";
  storePath: string;
  actionId?: string;
  contentHash?: string;
  proposalId?: string;
  trustEpoch?: string;
  artifact?: { artifactId: string; digest: string; size: number };
  effectContext?: ({ program: string; args: string[]; kind?: "program"; artifact?: { artifactId: string; digest: string; size: number };
    childAction?: { actionId: string; contentHash: string }; build?: {
    compiler: string; compilerSha256: string; args: string[];
    sources: { path: string; sha256: string }[]; outputs: string[]; timeoutSeconds: number;
    runtime: string; runtimeSha256?: string;
  } }
    | { kind: "pipeline"; components: string[]; stepCount: number; artifact?: { artifactId: string; digest: string; size: number } }
    | { kind: "artifact-copy"; artifact: { artifactId: string; digest: string; size: number } })
    & { effects: string[]; inputDigest: string; inputPreview?: string };
}

export interface AutomaticActionTrustResult {
  ok: boolean;
  trusted: boolean;
  consented?: boolean;
  trustEpoch?: string;
  state?: string;
  reason?: string;
  error?: string;
  artifactSource?: SelectedActionArtifact;
  artifactDestination?: SelectedActionDestination;
}

interface AuthorityOptions {
  storePath(): string;
  nativeEndpoint?: boolean;
  isTrusted(): boolean;
  enabled(): boolean;
  prepare(actionId: string, contentHash: string, proposalId: string | undefined, trustEpoch: string): Promise<Record<string, unknown>>;
  authorizeEffects?(actionId: string, contentHash: string, context?: AutomaticActionTrustRequest["effectContext"]): Promise<boolean>;
  pickArtifact?(): Promise<SelectedActionArtifact | undefined>;
  pickArtifactDestination?(artifact: Readonly<{ artifactId: string; digest: string; size: number }>): Promise<SelectedActionDestination | undefined>;
}

export class AutomaticActionTrustAuthority {
  private readonly server: net.Server;
  private readonly token = randomBytes(32).toString("hex");
  private trustEpoch = randomUUID();
  private readonly sockets = new Set<net.Socket>();
  private readonly options: AuthorityOptions;
  private configPath = "";
  private rootPath = "";
  private disposed = false;
  private started = false;
  private trustWasActive = false;
  private revoked = false;
  private epochPersistenceFailed = false;

  constructor(options: AuthorityOptions) {
    this.options = options;
    this.server = net.createServer(socket => {
      this.sockets.add(socket);
      socket.once("close", () => this.sockets.delete(socket));
      socket.setTimeout(300000, () => socket.destroy());
      let input = "";
      let handled = false;
      socket.setEncoding("utf8");
      socket.on("data", chunk => {
        if (handled) {
          socket.destroy();
          return;
        }
        input += chunk;
        if (Buffer.byteLength(input, "utf8") > 65536) {
          socket.destroy();
          return;
        }
        const newline = input.indexOf("\n");
        if (newline < 0) return;
        handled = true;
        const line = input.slice(0, newline);
        input = "";
        void this.handle(line).then(
          result => socket.end(`${JSON.stringify(result)}\n`),
          error => socket.end(`${JSON.stringify({ ok: false, trusted: false, reason: "HOST_AUTHORITY_UNAVAILABLE",
            error: error instanceof Error ? error.message.slice(0, 2048) : "Trusted Action authority failed." })}\n`),
        );
      });
    });
    this.server.on("error", () => {
      for (const socket of this.sockets) socket.destroy();
    });
  }

  async start(): Promise<void> {
    if (this.disposed || this.started || !this.options.isTrusted() || !this.options.enabled()) return;
    const root = path.resolve(this.options.storePath());
    if (!root || !path.isAbsolute(root)) throw new Error("INVALID_ACTION_TRUST_ROOT");
    this.rootPath = root;
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      this.server.once("error", onError);
      this.server.listen(0, "127.0.0.1", () => {
        this.server.removeListener("error", onError);
        resolve();
      });
    });
    this.started = true;
    const address = this.server.address();
    if (!address || typeof address === "string") throw new Error("INVALID_ACTION_TRUST_ENDPOINT");
    const directory = this.options.nativeEndpoint ? path.join(root, ".pkm-action-authority")
      : path.join(root, ".pkm", "state", "actions");
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const directories = this.options.nativeEndpoint ? [root, directory]
      : [root, path.join(root, ".pkm"), path.join(root, ".pkm", "state"), directory];
    for (const candidate of directories) {
      const stat = fs.lstatSync(candidate);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("UNSAFE_ACTION_TRUST_DIRECTORY");
    }
    this.configPath = path.join(directory, "host-authority.json");
    this.publishConfig();
    this.trustWasActive = true;
  }

  private publishConfig(): void {
    const address = this.server.address();
    if (!address || typeof address === "string" || !this.configPath || !this.rootPath)
      throw new Error("INVALID_ACTION_TRUST_ENDPOINT");
    const temporary = `${this.configPath}.${randomUUID()}.tmp`;
    const config = {
      schema: "pkm.action.host-authority/v1",
      host: "127.0.0.1",
      port: address.port,
      token: this.token,
      trust_epoch: this.trustEpoch,
      store_path: this.rootPath,
    };
    const fd = fs.openSync(temporary, "wx", 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(config)); }
    finally { fs.closeSync(fd); }
    fs.renameSync(temporary, this.configPath);
  }

  status(): AutomaticActionTrustResult {
    const trusted = this.refreshTrustState();
    return {
      ok: trusted || (!this.epochPersistenceFailed && !this.disposed && this.started),
      trusted,
      trustEpoch: this.trustEpoch,
      ...(this.epochPersistenceFailed ? { reason: "HOST_AUTHORITY_CONFIG_ERROR" } : {}),
    };
  }

  private refreshTrustState(): boolean {
    if (this.revoked) return false;
    const trusted = !this.disposed && this.started && this.options.isTrusted() && this.options.enabled();
    if (!trusted) {
      this.trustWasActive = false;
      return false;
    }
    if (!this.trustWasActive) {
      this.trustEpoch = randomUUID();
      try {
        this.publishConfig();
        this.epochPersistenceFailed = false;
      } catch {
        this.epochPersistenceFailed = true;
        return false;
      }
    }
    this.trustWasActive = true;
    return !this.epochPersistenceFailed;
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    for (const socket of this.sockets) socket.destroy();
    await new Promise<void>(resolve => this.server.close(() => resolve()));
    if (this.configPath) {
      try {
        const config = JSON.parse(fs.readFileSync(this.configPath, "utf8")) as { token?: unknown };
        if (config.token === this.token) fs.unlinkSync(this.configPath);
      } catch { /* The host may have replaced or removed its endpoint record. */ }
    }
  }

  private async handle(line: string): Promise<AutomaticActionTrustResult> {
    if (!this.refreshTrustState())
      return { ok: false, trusted: false, reason: "WORKSPACE_NOT_TRUSTED" };
    let request: AutomaticActionTrustRequest & { token?: unknown };
    try { request = JSON.parse(line) as typeof request; }
    catch { return { ok: false, trusted: false, reason: "INVALID_REQUEST" }; }
    const allowed = new Set(["operation", "storePath", "token", "actionId", "contentHash", "proposalId", "trustEpoch", "effectContext", "artifact"]);
    if (Object.keys(request).some(key => !allowed.has(key)))
      return { ok: false, trusted: false, reason: "INVALID_REQUEST" };
    const root = path.resolve(this.options.storePath());
    if (request.token !== this.token || request.storePath !== root
      || !["status", "prepare", "authorize", "effect_consent", "revoke", "artifact_pick", "artifact_export_pick"].includes(request.operation)) {
      return { ok: false, trusted: false, reason: "HOST_AUTHORITY_MISMATCH" };
    }
    if (request.operation !== "artifact_export_pick" && request.artifact !== undefined)
      return { ok: false, trusted: false, reason: "INVALID_REQUEST" };
    if (request.operation === "status") return { ok: true, trusted: true, trustEpoch: this.trustEpoch };
    if (request.operation === "artifact_pick") {
      if (!this.options.nativeEndpoint || !this.options.pickArtifact || request.trustEpoch !== this.trustEpoch
        || request.actionId !== undefined || request.contentHash !== undefined || request.proposalId !== undefined
        || request.effectContext !== undefined)
        return { ok: false, trusted: false, reason: "INVALID_ARTIFACT_PICK" };
      const epoch = this.trustEpoch;
      const artifactSource = await this.options.pickArtifact();
      if (!this.refreshTrustState() || this.trustEpoch !== epoch || path.resolve(this.options.storePath()) !== root)
        return { ok: false, trusted: false, reason: "TRUST_EPOCH_CHANGED" };
      return artifactSource
        ? { ok: true, trusted: true, trustEpoch: epoch, artifactSource }
        : { ok: false, trusted: true, trustEpoch: epoch, reason: "ARTIFACT_PICK_CANCELLED" };
    }
    if (request.operation === "artifact_export_pick") {
      const artifact = request.artifact;
      if (!this.options.nativeEndpoint || !this.options.pickArtifactDestination || request.trustEpoch !== this.trustEpoch
        || request.actionId !== undefined || request.contentHash !== undefined || request.proposalId !== undefined
        || request.effectContext !== undefined || !artifact || typeof artifact !== "object" || Array.isArray(artifact)
        || Object.keys(artifact).sort().join(",") !== "artifactId,digest,size"
        || !/^artifact_[a-f0-9]{32}$/.test(artifact.artifactId) || !/^[a-f0-9]{64}$/.test(artifact.digest)
        || !Number.isSafeInteger(artifact.size) || artifact.size < 0 || artifact.size > 32 * 1024 * 1024)
        return { ok: false, trusted: false, reason: "INVALID_ARTIFACT_PICK" };
      const epoch = this.trustEpoch;
      const artifactDestination = await this.options.pickArtifactDestination(Object.freeze({ ...artifact }));
      if (!this.refreshTrustState() || this.trustEpoch !== epoch || path.resolve(this.options.storePath()) !== root)
        return { ok: false, trusted: false, reason: "TRUST_EPOCH_CHANGED" };
      return artifactDestination
        ? { ok: true, trusted: true, trustEpoch: epoch, artifactDestination }
        : { ok: false, trusted: true, trustEpoch: epoch, reason: "ARTIFACT_PICK_CANCELLED" };
    }
    if (request.operation === "revoke") {
      if (request.trustEpoch !== this.trustEpoch) {
        return { ok: false, trusted: false, reason: "TRUST_EPOCH_CHANGED" };
      }
      this.revoked = true;
      this.trustWasActive = false;
      this.trustEpoch = randomUUID();
      try {
        this.publishConfig();
        this.epochPersistenceFailed = false;
      } catch {
        this.epochPersistenceFailed = true;
        return { ok: false, trusted: false, reason: "HOST_AUTHORITY_CONFIG_ERROR" };
      }
      return { ok: true, trusted: false, trustEpoch: this.trustEpoch };
    }
    if (!/^[a-z][a-z0-9_.-]{2,100}$/.test(request.actionId ?? "")
      || !/^[a-f0-9]{64}$/.test(request.contentHash ?? "")) {
      return { ok: false, trusted: false, reason: "INVALID_ACTION_REVISION" };
    }
    if (request.operation === "authorize") {
      return request.trustEpoch === this.trustEpoch
        ? { ok: true, trusted: true, trustEpoch: this.trustEpoch }
        : { ok: false, trusted: false, reason: "TRUST_EPOCH_CHANGED" };
    }
    if (request.operation === "effect_consent") {
      if (request.trustEpoch !== this.trustEpoch)
        return { ok: false, trusted: false, consented: false, reason: "TRUST_EPOCH_CHANGED" };
      const context = request.effectContext;
      if (context !== undefined && (!context || typeof context !== "object" || Array.isArray(context)
        || Object.keys(context).some(key => !["kind", "args", "effects", "inputDigest", "inputPreview", "program", "components", "stepCount", "build", "artifact", "childAction"].includes(key))
        || (context.kind === "artifact-copy"
          ? request.actionId !== "core.artifact.copy" || !context.artifact || typeof context.artifact !== "object"
            || Object.keys(context.artifact).some(key => !["artifactId", "digest", "size"].includes(key))
            || !/^artifact_[a-f0-9]{32}$/.test(context.artifact.artifactId)
            || !/^[a-f0-9]{64}$/.test(context.artifact.digest)
            || !Number.isSafeInteger(context.artifact.size) || context.artifact.size < 0 || context.artifact.size > 32 * 1024 * 1024
            || ["program", "args", "components", "stepCount", "build", "childAction"].some(key => Object.prototype.hasOwnProperty.call(context, key))
            || JSON.stringify(context.effects) !== JSON.stringify(["local-read", "local-write"])
          : context.kind === "pipeline"
          ? !Array.isArray(context.components) || context.components.length < 1 || context.components.length > 4
            || context.components.some(value => !["core.constant", "core.math-expression", "core.cast", "core.lookup"].includes(value))
            || !Number.isSafeInteger(context.stepCount) || context.stepCount < 1 || context.stepCount > 1024
            || Object.prototype.hasOwnProperty.call(context, "program") || Object.prototype.hasOwnProperty.call(context, "args")
            || Object.prototype.hasOwnProperty.call(context, "build") || Object.prototype.hasOwnProperty.call(context, "childAction")
            || context.artifact !== undefined && (!context.artifact || typeof context.artifact !== "object"
              || Object.keys(context.artifact).some(key => !["artifactId", "digest", "size"].includes(key))
              || !/^artifact_[a-f0-9]{32}$/.test(context.artifact.artifactId)
              || !/^[a-f0-9]{64}$/.test(context.artifact.digest)
              || !Number.isSafeInteger(context.artifact.size) || context.artifact.size < 0 || context.artifact.size > 32 * 1024 * 1024)
          : (context.kind !== undefined && context.kind !== "program")
            || typeof context.program !== "string" || !context.program || context.program.length > 4096
            || !Array.isArray(context.args) || context.args.length > 128 || context.args.some(value => typeof value !== "string")
            || Buffer.byteLength(JSON.stringify(context.args), "utf8") > 32768
            || context.build !== undefined && (!context.build || typeof context.build !== "object"
              || Object.keys(context.build).some(key => !["compiler", "compilerSha256", "args", "sources", "outputs", "timeoutSeconds", "runtime", "runtimeSha256"].includes(key))
              || typeof context.build.compiler !== "string" || !path.isAbsolute(context.build.compiler)
              || !/^[a-f0-9]{64}$/.test(context.build.compilerSha256)
              || !Array.isArray(context.build.args) || context.build.args.length > 128
              || context.build.args.some(value => typeof value !== "string")
              || !Array.isArray(context.build.sources) || context.build.sources.length < 1 || context.build.sources.length > 16
              || context.build.sources.some(source => !source || typeof source.path !== "string"
                || !path.isAbsolute(source.path) || !/^[a-f0-9]{64}$/.test(source.sha256))
              || !Array.isArray(context.build.outputs) || context.build.outputs.length < 1 || context.build.outputs.length > 16
              || context.build.outputs.some(value => typeof value !== "string")
              || !Number.isSafeInteger(context.build.timeoutSeconds) || context.build.timeoutSeconds < 1 || context.build.timeoutSeconds > 300
              || typeof context.build.runtime !== "string"
              || context.build.runtimeSha256 !== undefined && !/^[a-f0-9]{64}$/.test(context.build.runtimeSha256)
              || Buffer.byteLength(JSON.stringify(context.build), "utf8") > 32768)
            || Object.prototype.hasOwnProperty.call(context, "components") || Object.prototype.hasOwnProperty.call(context, "stepCount")
            || (context.artifact !== undefined || context.childAction !== undefined)
              && (!context.artifact || !context.childAction || typeof context.artifact !== "object" || typeof context.childAction !== "object"
                || Object.keys(context.artifact).sort().join(",") !== "artifactId,digest,size"
                || Object.keys(context.childAction).sort().join(",") !== "actionId,contentHash"
                || !/^artifact_[a-f0-9]{32}$/.test(context.artifact.artifactId)
                || !/^[a-f0-9]{64}$/.test(context.artifact.digest)
                || !Number.isSafeInteger(context.artifact.size) || context.artifact.size < 0 || context.artifact.size > 32 * 1024 * 1024
                || context.childAction.actionId !== "core.artifact.copy" || !/^[a-f0-9]{64}$/.test(context.childAction.contentHash)))
        || !Array.isArray(context.effects) || context.effects.length > 32 || context.effects.some(value => typeof value !== "string" || value.length > 128)
        || context.inputPreview !== undefined && (typeof context.inputPreview !== "string" || context.inputPreview.length > 512)
        || !/^[a-f0-9]{64}$/.test(context.inputDigest)))
        return { ok: false, trusted: false, reason: "INVALID_EFFECT_CONTEXT" };
      const consented = this.options.authorizeEffects
        ? await this.options.authorizeEffects(request.actionId!, request.contentHash!, context)
        : false;
      const trusted = this.refreshTrustState() && request.trustEpoch === this.trustEpoch
        && path.resolve(this.options.storePath()) === root;
      return {
        ok: trusted && consented,
        trusted,
        consented: trusted && consented,
        trustEpoch: this.trustEpoch,
        ...(!trusted ? { reason: "TRUST_EPOCH_CHANGED" } : consented ? {} : { reason: "EFFECT_CONSENT_DENIED" }),
      };
    }
    if (request.trustEpoch !== this.trustEpoch
      || (request.proposalId !== undefined && !/^proposal_[a-f0-9]{32}$/.test(request.proposalId))) {
      return { ok: false, trusted: false, reason: "INVALID_PROPOSAL_AUTHORITY" };
    }
    const prepared = await this.options.prepare(
      request.actionId!, request.contentHash!, request.proposalId!, this.trustEpoch);
    return {
      ok: prepared.ok === true && ["tested", "environment_checked", "succeeded"].includes(String(prepared.state)),
      trusted: true,
      trustEpoch: this.trustEpoch,
      state: String(prepared.state ?? "blocked"),
      ...(prepared.reason ? { reason: String(prepared.reason) } : {}),
    };
  }
}
