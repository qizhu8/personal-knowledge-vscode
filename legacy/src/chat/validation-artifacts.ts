import * as fs from "fs";
import * as path from "path";
import { createHash } from "crypto";
import { hostname } from "os";
import { relativeToolPath } from "./tool-paths";

export interface ValidationArtifactPath { path: string; workspace: number; }
export interface ValidationArtifactVersion extends ValidationArtifactPath {
  schema: "pkm.validation.file/v1";
  host: string;
  root: string;
  resolvedPath: string;
  sha256: string;
  bytes: number;
  stamp: string;
}
export interface ValidationArtifactState {
  status: "unchanged" | "stale" | "unavailable" | "unchecked";
  files: Array<{ path: string; sha256?: string; status: string; reason: string }>;
}

const maxFiles = 16, maxFileBytes = 4 * 1024 * 1024, maxTotalBytes = 16 * 1024 * 1024;
const stamp = (stat: fs.BigIntStats) => [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(":");
const within = (root: string, file: string) => {
  const relative = path.relative(root, file);
  return !!relative && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};

export function validationArtifactPaths(value: unknown): ValidationArtifactPath[] {
  if (!Array.isArray(value) || !value.length || value.length > maxFiles) throw new Error("artifactPaths requires 1-16 workspace files.");
  const paths = value.map(item => {
    if (!item || typeof item !== "object" || Object.keys(item).some(key => !["path", "workspace"].includes(key))
      || typeof item.path !== "string" || !item.path || item.path.length > 1024
      || !Number.isSafeInteger(item.workspace ?? 0) || (item.workspace ?? 0) < 0) {
      throw new Error("Each artifact requires a workspace-relative path and an optional nonnegative workspace index; never supply a hash.");
    }
    return { path:item.path, workspace:item.workspace ?? 0 };
  });
  if (new Set(paths.map(item => JSON.stringify(item))).size !== paths.length) throw new Error("Artifact paths must not be duplicated.");
  return paths;
}

export async function captureValidationArtifacts(files: ValidationArtifactPath[], roots: readonly string[], signal: AbortSignal,
  guard: (relative: unknown) => string): Promise<ValidationArtifactVersion[]> {
  files = validationArtifactPaths(files);
  const active = () => { if (signal.aborted) throw new Error("Request cancelled."); };
  const versions: ValidationArtifactVersion[] = [];
  let total = 0;
  for (const file of files) {
    active();
    const relative = guard(file.path);
    if (!roots[file.workspace]) throw new Error("Choose an existing artifact workspace index.");
    const root = await fs.promises.realpath(roots[file.workspace]);
    const requested = path.resolve(root, relative);
    const resolvedPath = await fs.promises.realpath(requested);
    if (!within(root, resolvedPath)) throw new Error("Validation artifacts must remain inside their workspace.");
    guard(path.relative(root, resolvedPath).replace(/\\/g, "/"));
    if (versions.some(version => version.resolvedPath === resolvedPath)) throw new Error("Artifact paths resolve to the same file.");
    const handle = await fs.promises.open(resolvedPath, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | (fs.constants.O_NOFOLLOW || 0));
    try {
      const before = await handle.stat({ bigint:true });
      if (!before.isFile() || before.size > BigInt(maxFileBytes) || total + Number(before.size) > maxTotalBytes) {
        throw new Error("Validation artifacts require regular files up to 4 MiB each and 16 MiB total.");
      }
      const hash = createHash("sha256");
      const buffer = Buffer.alloc(64 * 1024);
      let bytes = 0;
      while (true) {
        active();
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
        if (!bytesRead) break;
        bytes += bytesRead;
        if (bytes > maxFileBytes || total + bytes > maxTotalBytes) throw new Error("Validation artifact byte limit exceeded while reading.");
        hash.update(buffer.subarray(0, bytesRead));
      }
      const after = await handle.stat({ bigint:true });
      const current = await fs.promises.stat(requested, { bigint:true });
      active();
      if (stamp(before) !== stamp(after) || stamp(after) !== stamp(current)
        || await fs.promises.realpath(requested) !== resolvedPath || bytes !== Number(after.size)) {
        throw new Error("Validation artifact changed while hashing; retry the check against a stable file.");
      }
      total += bytes;
      versions.push({ ...file, path:relative, schema:"pkm.validation.file/v1", host:hostname(), root, resolvedPath,
        sha256:hash.digest("hex"), bytes, stamp:stamp(after) });
    } finally { await handle.close(); }
  }
  return versions;
}

export function validationArtifactState(versions: ValidationArtifactVersion[] | undefined): ValidationArtifactState | undefined {
  if (versions === undefined) return undefined;
  if (!Array.isArray(versions) || !versions.length || versions.length > maxFiles) return { status:"unavailable", files:[] };
  const files = versions.map(version => {
    const name = version?.path || "Artifact";
    if (!version || version.schema !== "pkm.validation.file/v1" || version.host !== hostname()
      || typeof version.root !== "string" || !path.isAbsolute(version.root)
      || typeof version.resolvedPath !== "string" || !within(version.root, version.resolvedPath)
      || typeof name !== "string" || !name || path.isAbsolute(name)
      || name.replace(/\\/g, "/").split("/").some(part => !part || part.startsWith(".") || part === "node_modules")
      || !/^[a-f0-9]{64}$/.test(version.sha256) || typeof version.stamp !== "string") {
      return { path:name, status:"unavailable", reason:"Invalid receipt or another host; validate locally again." };
    }
    try {
      relativeToolPath(name);
      const requested = path.resolve(version.root, name);
      if (!within(version.root, requested) || fs.realpathSync(requested) !== version.resolvedPath) {
        return { path:name, status:"stale", reason:"Artifact path changed." };
      }
      const current = fs.statSync(requested, { bigint:true });
      return current.isFile() && stamp(current) === version.stamp
        ? { path:name, sha256:version.sha256, status:"unchecked", reason:"Metadata matches; asynchronous content-hash verification is required." }
        : { path:name, sha256:version.sha256, status:"stale", reason:"Artifact changed since validation; validate again." };
    } catch (error) {
      return { path:name, status:"unavailable", reason:`Artifact inspection failed: ${error instanceof Error ? error.message : String(error)}` };
    }
  });
  return { status:files.every(file => file.status === "unchecked") ? "unchecked" : "stale", files };
}

export async function verifyValidationArtifacts(versions: ValidationArtifactVersion[], signal: AbortSignal, allowedRoots: readonly string[]): Promise<ValidationArtifactState> {
  const preflight = validationArtifactState(versions);
  if (!preflight || preflight.status !== "unchecked") return preflight || { status:"unavailable", files:[] };
  try {
    const allowed = await Promise.all(allowedRoots.map(root => fs.promises.realpath(root)));
    const roots: string[] = [];
    for (const version of versions) {
      if (!allowed.includes(version.root)) throw new Error("Artifact workspace is not open and trusted on this Host; open its workspace to validate.");
      if (!Number.isSafeInteger(version.workspace) || version.workspace < 0 || version.workspace >= 128
        || roots[version.workspace] && roots[version.workspace] !== version.root) throw new Error("Invalid artifact workspace binding.");
      roots[version.workspace] = version.root;
    }
    const current = await captureValidationArtifacts(versions.map(({ path, workspace }) => ({ path, workspace })), roots, signal, relativeToolPath);
    const files = current.map((version, index) => {
      const unchanged = version.sha256 === versions[index].sha256 && version.resolvedPath === versions[index].resolvedPath;
      return { path:version.path, sha256:versions[index].sha256, status:unchanged ? "unchanged" : "stale",
        reason:unchanged ? "Saved bytes match the Host-recorded SHA-256." : "Saved bytes changed since validation; validate again." };
    });
    return { status:files.every(file => file.status === "unchanged") ? "unchanged" : "stale", files };
  } catch (error) {
    if (signal.aborted) throw error;
    return { status:"unavailable", files:versions.map(version => ({ path:version.path, status:"unavailable",
      reason:`Artifact hash verification failed: ${error instanceof Error ? error.message : String(error)}` })) };
  }
}
