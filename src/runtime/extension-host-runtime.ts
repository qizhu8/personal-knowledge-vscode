import * as fs from "fs";
import * as path from "path";
import { randomUUID } from "crypto";

export interface ExtensionBuild { version: string; buildId: string; builtAt: string; }
export interface ExtensionHostIdentity extends ExtensionBuild {
  hostId: string; slotId: string; scope: string; pid: number; vscodeVersion: string;
}
export type HostMigrationState = "pending" | "ready" | "failed" | "action-required";
interface HostRecord extends ExtensionHostIdentity {
  updatedAt: number; busy: boolean; phase: "ready" | "blocked" | "reloading" | "failed";
  migration?: HostMigrationState;
}
interface ReloadRequest { id: string; buildId: string; createdAt: number; targets: Array<{ hostId: string; slotId: string }>; }

export function readExtensionBuild(directory: string): ExtensionBuild | undefined {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(directory, "dist", "build-info.json"), "utf8"));
    if (value.schema === "pkm.extension-build/v1" && typeof value.version === "string" && /^[a-f0-9]{64}$/.test(value.buildId) && typeof value.builtAt === "string") {
      return { version: value.version, buildId: value.buildId, builtAt: value.builtAt };
    }
  } catch {}
  return undefined;
}

export const loadedExtensionBuild = readExtensionBuild(path.resolve(require("path").resolve(__dirname, ".."), ".."));

export function readInstalledExtensionBuild(extensionPath: string, extensionId: string): ExtensionBuild | undefined {
  const root = path.dirname(extensionPath);
  const filename = path.join(root, "extensions.json");
  if (!fs.existsSync(filename)) return readExtensionBuild(extensionPath);
  try {
    if (fs.statSync(filename).size > 4 * 1024 * 1024) return undefined;
    const entries = JSON.parse(fs.readFileSync(filename, "utf8"));
    if (!Array.isArray(entries)) return undefined;
    const matches = entries.filter(entry => entry?.identifier?.id?.toLowerCase() === extensionId.toLowerCase());
    if (matches.length !== 1 || matches[0].location?.scheme !== "file") return undefined;
    let location = matches[0].location.fsPath || matches[0].location.path;
    if (typeof location !== "string") return undefined;
    if (process.platform === "win32") location = location.replace(/^\/([A-Za-z]:\/)/, "$1");
    if (!path.isAbsolute(location) || path.resolve(path.dirname(location)) !== path.resolve(root)) return undefined;
    const build = readExtensionBuild(location);
    return build?.version === matches[0].version ? build : undefined;
  } catch { return undefined; }
}

export class ExtensionHostRegistry {
  private handledRequest?: string;
  constructor(readonly directory: string, readonly identity: ExtensionHostIdentity, private readonly now = Date.now) {}

  heartbeat(busy: boolean, phase: HostRecord["phase"] = "ready", migration: HostMigrationState = "pending"): void {
    this.write(`${this.identity.hostId}.json`, { ...this.identity, updatedAt: this.now(), busy, phase, migration });
    const request = this.request();
    if (migration === "ready" && phase === "ready" && request?.buildId === this.identity.buildId && !request.targets.some(target => target.hostId === this.identity.hostId)) {
      for (const target of request.targets.filter(target => target.slotId === this.identity.slotId && target.hostId !== this.identity.hostId)) {
        this.write(`ack-${target.hostId}.json`, { requestId: request.id, hostId: this.identity.hostId, buildId: this.identity.buildId });
      }
    }
  }

  hosts(): HostRecord[] {
    let filenames: string[];
    try { filenames = fs.readdirSync(this.directory); } catch { return []; }
    return filenames.filter(name => /^[a-f0-9-]{36}\.json$/.test(name)).flatMap(name => {
      const value = this.read(name) as HostRecord | undefined;
      return value?.scope === this.identity.scope && value.hostId === name.slice(0, -5)
        && Number.isSafeInteger(value.pid) && value.pid > 0 && typeof value.slotId === "string"
        && /^[a-f0-9]{64}$/.test(value.buildId) && typeof value.busy === "boolean"
        && Number.isFinite(value.updatedAt) && value.updatedAt <= this.now() + 1_000 && this.now() - value.updatedAt < 15_000 ? [value] : [];
    });
  }

  requestReload(buildId: string): ReloadRequest {
    if (!/^[a-f0-9]{64}$/.test(buildId)) throw new Error("Installed build identity is unavailable.");
    const previous = this.progress();
    if (previous && previous.pending.length) throw new Error("A coordinated reload is already pending. View Host status or wait for it to expire.");
    const request = { id: randomUUID(), buildId, createdAt: this.now(), targets: this.hosts().map(({ hostId, slotId }) => ({ hostId, slotId })) };
    if (!request.targets.length) throw new Error("No registered PKM hosts are online.");
    this.write("reload-request.json", request);
    return request;
  }

  poll(installedBuildId: string | undefined, busy: boolean): boolean {
    const request = this.request();
    if (!request || this.handledRequest === request.id || !request.targets.some(target => target.hostId === this.identity.hostId)) return false;
    if (installedBuildId !== request.buildId) { this.heartbeat(busy, "failed"); return false; }
    if (busy) { this.heartbeat(true, "blocked"); return false; }
    this.handledRequest = request.id;
    this.heartbeat(false, "reloading");
    return true;
  }

  progress(): { requestId: string; buildId: string; pending: string[]; verified: string[] } | undefined {
    const request = this.request();
    if (!request) return undefined;
    const verified = request.targets.filter(target => {
      const ack = this.read(`ack-${target.hostId}.json`);
      return ack?.requestId === request.id && ack.buildId === request.buildId
        && this.hosts().some(host => host.hostId === ack.hostId && host.slotId === target.slotId && host.buildId === request.buildId
          && host.phase === "ready" && host.migration === "ready");
    }).map(target => target.hostId);
    return { requestId: request.id, buildId: request.buildId, verified, pending: request.targets.map(target => target.hostId).filter(hostId => !verified.includes(hostId)) };
  }

  dispose(): void { fs.rmSync(path.join(this.directory, `${this.identity.hostId}.json`), { force: true }); }

  private request(): ReloadRequest | undefined {
    const value = this.read("reload-request.json");
    if (typeof value?.id !== "string" || !/^[a-f0-9]{64}$/.test(value.buildId) || !Number.isFinite(value.createdAt)
      || value.createdAt > this.now() + 1_000 || this.now() - value.createdAt > 300_000 || !Array.isArray(value.targets) || value.targets.length > 500
      || !value.targets.every((target: any) => typeof target?.slotId === "string" && /^[a-f0-9-]{36}$/.test(target.hostId))) return undefined;
    return value as ReloadRequest;
  }

  private read(name: string): Record<string, any> | undefined {
    try {
      const filename = path.join(this.directory, name);
      if (fs.statSync(filename).size > 256_000) return undefined;
      return JSON.parse(fs.readFileSync(filename, "utf8"));
    } catch { return undefined; }
  }

  private write(name: string, value: object): void {
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const filename = path.join(this.directory, name);
    const temporary = `${filename}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 });
      fs.renameSync(temporary, filename);
    } finally { fs.rmSync(temporary, { force: true }); }
  }
}