import * as net from "node:net";
import * as fs from "node:fs";
import * as path from "node:path";
import type { AutomaticActionTrustAuthority, AutomaticActionTrustContext } from "./host-services.js";

const identity = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const epochPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const digest = /^[a-f0-9]{64}$/;
const configLimit = 8192;
type BuildContext = { compiler: string; compilerSha256: string; args: string[];
  sources: { path: string; sha256: string }[]; outputs: string[]; timeoutSeconds: number;
  runtime: string; runtimeSha256?: string };
type EffectContext = ({ program: string; args: string[]; kind?: "program"; build?: BuildContext;
  artifact?: { artifactId: string; digest: string; size: number }; childAction?: { actionId: string; contentHash: string } }
  | { kind: "pipeline"; components: string[]; stepCount: number; artifact?: { artifactId: string; digest: string; size: number } }
  | { kind: "artifact-copy"; artifact: { artifactId: string; digest: string; size: number } })
  & { effects: string[]; inputDigest: string; inputPreview?: string };
function bridgeError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

interface AuthorityConfig {
  schema: "pkm.action.host-authority/v1";
  host: "127.0.0.1";
  port: number;
  token: string;
  trust_epoch: string;
  store_path: string;
}

interface AuthorityResponse {
  ok: boolean;
  trusted: boolean;
  consented?: boolean;
  trustEpoch?: string;
  reason?: string;
  error?: string;
  artifactSource?: unknown;
  artifactDestination?: unknown;
}

export interface VscodeActionTrustBridgeOptions {
  /** Fixed by the native host; never supplied by an MCP request. */
  workspaceRoot: string;
  workspaceId: string;
  actorId: string;
  nativeEndpoint?: boolean;
  requestTimeoutMs?: number;
}

function readConfig(root: string, nativeEndpoint = false): AuthorityConfig {
  const directory = nativeEndpoint ? path.join(root, ".pkm-action-authority") : path.join(root, ".pkm", "state", "actions");
  const filename = path.join(directory, "host-authority.json");
  try {
    const rootStat = fs.lstatSync(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || fs.realpathSync(root) !== root
      || process.platform !== "win32" && typeof process.getuid === "function" && rootStat.uid !== process.getuid()) {
      throw new Error();
    }
    const directories = nativeEndpoint ? [directory] : [path.join(root, ".pkm"), path.join(root, ".pkm", "state"), directory];
    for (const candidate of directories) {
      const stat = fs.lstatSync(candidate);
      if (!stat.isDirectory() || stat.isSymbolicLink()
        || process.platform !== "win32" && ((stat.mode & 0o077) !== 0
          || typeof process.getuid === "function" && stat.uid !== process.getuid())) {
        throw new Error();
      }
    }
    const stat = fs.lstatSync(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > configLimit
      || process.platform !== "win32" && ((stat.mode & 0o077) !== 0
        || typeof process.getuid === "function" && stat.uid !== process.getuid())) throw new Error();
    const text = fs.readFileSync(filename, "utf8");
    if (Buffer.byteLength(text, "utf8") > configLimit) throw new Error();
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    const config = value as Record<string, unknown>;
    if (Object.keys(config).length !== 6 || config.schema !== "pkm.action.host-authority/v1"
      || config.host !== "127.0.0.1" || !Number.isSafeInteger(config.port)
      || Number(config.port) < 1 || Number(config.port) > 65535
      || typeof config.token !== "string" || !digest.test(config.token)
      || typeof config.trust_epoch !== "string" || !epochPattern.test(config.trust_epoch)
      || config.store_path !== root) throw new Error();
    return config as unknown as AuthorityConfig;
  } catch {
    throw bridgeError("ACCESS_DENIED", "The trusted VS Code Action authority is unavailable or unsafe.");
  }
}

function request(config: AuthorityConfig, operation: "status" | "authorize" | "revoke" | "effect_consent" | "artifact_pick" | "artifact_export_pick",
  options: { actionId?: string; contentHash?: string; trustEpoch?: string;
    effectContext?: EffectContext; artifact?: { artifactId: string; digest: string; size: number } }, timeoutMs: number): Promise<AuthorityResponse> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: config.host, port: config.port });
    let input = "";
    let settled = false;
    const finish = (error?: Error, value?: AuthorityResponse) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error);
      else if (!value) reject(new Error("Empty trusted Action authority response."));
      else resolve(value);
    };
    socket.setTimeout(timeoutMs, () => finish(new Error("Trusted Action authority timed out.")));
    socket.on("error", error => finish(error));
    socket.setEncoding("utf8");
    socket.on("data", chunk => {
      input += chunk;
      if (Buffer.byteLength(input, "utf8") > configLimit) return finish(new Error("Trusted Action authority response exceeded its limit."));
      const newline = input.indexOf("\n");
      if (newline < 0) return;
      try {
        const value: unknown = JSON.parse(input.slice(0, newline));
        if (!value || typeof value !== "object" || Array.isArray(value)
          || typeof (value as Record<string, unknown>).ok !== "boolean"
          || typeof (value as Record<string, unknown>).trusted !== "boolean") {
          throw new Error();
        }
        finish(undefined, value as AuthorityResponse);
      } catch { finish(new Error("Invalid trusted Action authority response.")); }
    });
    socket.once("connect", () => {
      socket.write(`${JSON.stringify({
        operation, storePath: config.store_path, token: config.token, ...options,
      })}\n`);
    });
  });
}

/** Bridges a separately running native Action host to VS Code's host-owned authority endpoint. */
export function createVscodeActionTrustBridge(options: VscodeActionTrustBridgeOptions): AutomaticActionTrustAuthority & {
  refresh(): Promise<AutomaticActionTrustContext>;
  authorize(actionId: string, contentHash: string, epoch: string): Promise<boolean>;
  authorizeEffects(actionId: string, contentHash: string, epoch: string,
    effectContext: EffectContext): Promise<boolean>;
  pickArtifactSource(epoch: string): Promise<{ path: string; selectedRoot: string; expectedSha256: string; size: number } | undefined>;
  pickArtifactDestination(epoch: string, artifact: { artifactId: string; digest: string; size: number }):
    Promise<{ path: string; selectedRoot: string } | undefined>;
} {
  const root = path.resolve(options.workspaceRoot);
  if (!path.isAbsolute(options.workspaceRoot) || root !== options.workspaceRoot
    || fs.realpathSync(root) !== root || !identity.test(options.workspaceId) || !identity.test(options.actorId)) {
    throw bridgeError("INVALID_CONFIGURATION", "The native host must bind Action trust to its canonical workspace and actor.");
  }
  const timeoutMs = options.requestTimeoutMs ?? 3000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 10_000) {
    throw bridgeError("INVALID_CONFIGURATION", "The trusted Action authority timeout is invalid.");
  }
  let context: AutomaticActionTrustContext = {
    workspaceId: options.workspaceId, actorId: options.actorId, trustedWorkspace: false, epoch: "unavailable",
  };
  let disposed = false;

  async function refresh(): Promise<AutomaticActionTrustContext> {
    if (disposed) return context = { ...context, trustedWorkspace: false };
    try {
      let config = readConfig(root, options.nativeEndpoint);
      let status = await request(config, "status", {}, timeoutMs);
      if (status.trusted && status.trustEpoch !== config.trust_epoch) {
        config = readConfig(root, options.nativeEndpoint);
        status = await request(config, "status", {}, timeoutMs);
      }
      context = {
        workspaceId: options.workspaceId,
        actorId: options.actorId,
        trustedWorkspace: status.ok && status.trusted && status.trustEpoch === config.trust_epoch,
        epoch: status.trustEpoch && epochPattern.test(status.trustEpoch) ? status.trustEpoch : config.trust_epoch,
      };
    } catch {
      context = { ...context, trustedWorkspace: false };
    }
    return context;
  }

  return Object.freeze({
    current: () => ({ ...context }),
    refresh,
    async authorize(actionId: string, contentHash: string, epoch: string) {
      if (disposed || !identity.test(actionId) || !digest.test(contentHash) || !epochPattern.test(epoch)) return false;
      try {
        const config = readConfig(root, options.nativeEndpoint);
        if (config.trust_epoch !== epoch) return false;
        const response = await request(config, "authorize", { actionId, contentHash, trustEpoch: epoch }, timeoutMs);
        return response.ok && response.trusted && response.trustEpoch === epoch;
      } catch { return false; }
    },
    async authorizeEffects(actionId: string, contentHash: string, epoch: string,
      effectContext: EffectContext) {
      if (disposed || !identity.test(actionId) || !digest.test(contentHash) || !epochPattern.test(epoch))
        throw bridgeError("ACCESS_DENIED", "The trusted Action consent binding is invalid.");
      const config = readConfig(root, options.nativeEndpoint);
      if (config.trust_epoch !== epoch) throw bridgeError("ACCESS_DENIED", "Action trust changed before consent.");
      const response = await request(config, "effect_consent", { actionId, contentHash, trustEpoch: epoch, effectContext }, 300_000);
      if (response.reason === "EFFECT_CONSENT_DENIED" && response.trusted && response.trustEpoch === epoch) return false;
      if (response.reason === "HOST_AUTHORITY_UNAVAILABLE" && typeof response.error === "string")
        throw new Error(response.error);
      if (!response.ok || !response.trusted || response.consented !== true || response.trustEpoch !== epoch)
        throw bridgeError("ACCESS_DENIED", `Trusted Action consent service failed: ${response.reason ?? "INVALID_RESPONSE"}.`);
      return true;
    },
    async pickArtifactSource(epoch: string) {
      if (disposed || !epochPattern.test(epoch)) throw bridgeError("ACCESS_DENIED", "Action artifact trust is unavailable.");
      const config = readConfig(root, options.nativeEndpoint);
      if (config.trust_epoch !== epoch) throw bridgeError("ACCESS_DENIED", "Action trust changed before file selection.");
      const response = await request(config, "artifact_pick", { trustEpoch: epoch }, 300_000);
      if (response.reason === "ARTIFACT_PICK_CANCELLED" && response.trusted && response.trustEpoch === epoch) return undefined;
      if (response.reason === "HOST_AUTHORITY_UNAVAILABLE" && typeof response.error === "string")
        throw new Error(response.error);
      const source = response.artifactSource;
      if (!response.ok || !response.trusted || response.trustEpoch !== epoch || !source || typeof source !== "object"
        || Array.isArray(source)) throw bridgeError("ACCESS_DENIED", "The Action artifact picker did not approve a source.");
      const value = source as Record<string, unknown>;
      if (Object.keys(value).sort().join(",") !== "expectedSha256,path,selectedRoot,size"
        || typeof value.path !== "string" || !path.isAbsolute(value.path) || path.resolve(value.path) !== value.path
        || typeof value.selectedRoot !== "string" || path.dirname(value.path) !== value.selectedRoot
        || typeof value.expectedSha256 !== "string" || !digest.test(value.expectedSha256)
        || !Number.isSafeInteger(value.size) || Number(value.size) < 0 || Number(value.size) > 32 * 1024 * 1024)
        throw bridgeError("ACCESS_DENIED", "The Action artifact picker returned an invalid source.");
      return value as unknown as { path: string; selectedRoot: string; expectedSha256: string; size: number };
    },
    async pickArtifactDestination(epoch: string, artifact: { artifactId: string; digest: string; size: number }) {
      if (disposed || !epochPattern.test(epoch)) throw bridgeError("ACCESS_DENIED", "Action artifact trust is unavailable.");
      const config = readConfig(root, options.nativeEndpoint);
      if (config.trust_epoch !== epoch) throw bridgeError("ACCESS_DENIED", "Action trust changed before destination selection.");
      const response = await request(config, "artifact_export_pick", { trustEpoch: epoch, artifact }, 300_000);
      if (response.reason === "ARTIFACT_PICK_CANCELLED" && response.trusted && response.trustEpoch === epoch) return undefined;
      if (response.reason === "HOST_AUTHORITY_UNAVAILABLE" && typeof response.error === "string")
        throw new Error(response.error);
      const selected = response.artifactDestination;
      if (!response.ok || !response.trusted || response.trustEpoch !== epoch || !selected || typeof selected !== "object"
        || Array.isArray(selected)) throw bridgeError("ACCESS_DENIED", "The Action artifact picker did not approve a destination.");
      const value = selected as Record<string, unknown>;
      if (Object.keys(value).sort().join(",") !== "path,selectedRoot"
        || typeof value.path !== "string" || !path.isAbsolute(value.path) || path.resolve(value.path) !== value.path
        || typeof value.selectedRoot !== "string" || path.dirname(value.path) !== value.selectedRoot)
        throw bridgeError("ACCESS_DENIED", "The Action artifact picker returned an invalid destination.");
      return value as { path: string; selectedRoot: string };
    },
    async revoke() {
      if (disposed) throw bridgeError("CLOSED", "Trusted Action authority bridge is closed.");
      const config = readConfig(root, options.nativeEndpoint);
      const previousEpoch = context.epoch;
      const response = await request(config, "revoke", { trustEpoch: config.trust_epoch }, timeoutMs);
      if (!response.ok || response.trusted || !response.trustEpoch || response.trustEpoch === previousEpoch) {
        throw bridgeError("ACCESS_DENIED", "The VS Code host did not revoke Action trust.");
      }
      context = {
        workspaceId: options.workspaceId, actorId: options.actorId,
        trustedWorkspace: false, epoch: response.trustEpoch,
      };
    },
    async close() {
      disposed = true;
      context = { ...context, trustedWorkspace: false };
    },
  });
}
