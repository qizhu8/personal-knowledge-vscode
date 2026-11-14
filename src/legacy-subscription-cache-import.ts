import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, realpath, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { resourcePath } from "./document-path.js";

const kinds = new Set(["skills", "notes", "papers", "prompts", "scripts", "packages", "servers", "recipes"]);
type Member = { id: string; nodeId: string; shareId: string };
export async function inspectLegacyCacheFile(path: string, sink?: FileHandle) {
  const before = await lstat(path, { bigint: true });
  const fail = (): never => { throw Object.assign(new Error("Subscription cache source changed or is unsafe."), { code: "SOURCE_CHANGED" }); };
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n) fail();
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  const same = (stat: typeof before) => stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1n
    && stat.dev === before.dev && stat.ino === before.ino && stat.size === before.size
    && stat.mtimeNs === before.mtimeNs && stat.ctimeNs === before.ctimeNs;
  try {
    if (!same(await file.stat({ bigint: true }))) fail();
    const digest = createHash("sha256"), buffer = Buffer.allocUnsafe(64 * 1024);
    let size = 0;
    for (;;) {
      const { bytesRead } = await file.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      const chunk = buffer.subarray(0, bytesRead);
      digest.update(chunk);
      if (sink) await sink.writeFile(chunk);
      size += bytesRead;
    }
    if (BigInt(size) !== before.size || !same(await file.stat({ bigint: true }))
      || !same(await lstat(path, { bigint: true }))) fail();
    return { sha256: digest.digest("hex"), size };
  } finally { await file.close(); }
}

export async function inspectLegacySubscriptionCache(root: string, state: Record<string, unknown>, io: {
  read(path: string): Promise<Buffer>;
  json(bytes: Buffer): Record<string, unknown>;
  fail(code: string, message: string): never;
  emptyStagingFor?: { nodeId: string; shareId: string };
}) {
  const { fail } = io;
  const members = new Map<string, Member>();
  const ids = new Set<string>();
  if (!Array.isArray(state.subscriptions)) fail("INVALID_STATE", "Subscription cache requires its exact original subscriber array.");
  for (const value of state.subscriptions as unknown[]) {
    if (!value || typeof value !== "object" || Array.isArray(value)) fail("INVALID_STATE", "Subscription member must be an object.");
    const member = value as Member;
    if (![member.id, member.nodeId, member.shareId].every(value => typeof value === "string" && value.length > 0
      && resourcePath.safeParse(value).success && !value.includes("/") && !value.includes("\\"))
      || ids.has(member.id) || members.has(`${member.nodeId}/${member.shareId}`)) {
      fail("INVALID_STATE", "Subscription cache requires unique safe current member identities.");
    }
    ids.add(member.id);
    members.set(`${member.nodeId}/${member.shareId}`, member);
  }
  const files: Array<{ source: string; relative: string; sha256: string; size: number }> = [];
  const directories: string[] = [];
  const emptyStaging: string[] = [];
  const folded = new Set<string>();
  async function walk(relative: string): Promise<void> {
    const parts = relative.split("/");
    const recovery = io.emptyStagingFor;
    const recoveryStaging = !!recovery && parts.length === 3 && parts[1] === recovery.nodeId
      && parts[2]!.startsWith(`.${recovery.shareId}.`)
      && /^[a-f0-9]{10}\.staging$/.test(parts[2]!.slice(recovery.shareId.length + 2));
    if (!recoveryStaging && !resourcePath.safeParse(relative).success)
      fail("UNSAFE_PATH", "Subscription cache path is not portable.");
    const fold = relative.normalize("NFC").toLowerCase();
    if (folded.has(fold)) fail("COLLISION", "Subscription cache has case/Unicode-colliding paths.");
    folded.add(fold);
    const path = join(root, ...relative.split("/"));
    const stat = await lstat(path, { bigint: true });
    if (await realpath(path) !== path || stat.isSymbolicLink() || !stat.isDirectory() && (!stat.isFile() || stat.nlink !== 1n)) {
      fail("UNSAFE_SOURCE", "Subscription cache contains linked or special state.");
    }
    if (recoveryStaging) {
      if (!stat.isDirectory() || (await readdir(path)).length !== 0)
        fail("UNKNOWN_STATE", "Subscription staging contains unknown data.");
      const after = await lstat(path, { bigint: true });
      if (!after.isDirectory() || after.isSymbolicLink() || after.dev !== stat.dev || after.ino !== stat.ino
        || after.mtimeNs !== stat.mtimeNs || after.ctimeNs !== stat.ctimeNs)
        fail("SOURCE_CHANGED", "Subscription staging changed while inspecting.");
      emptyStaging.push(relative);
      return;
    }
    if (parts.length >= 3) {
      const member = members.get(`${parts[1]}/${parts[2]}`);
      if (!member) fail("UNKNOWN_STATE", "Cache requires exact current subscriber membership.");
    }
    if (stat.isDirectory()) {
      if (parts.length === 2 && ![...members.values()].some(member => member.nodeId === parts[1])
        || parts.length === 4 && parts[3] !== "content"
        || parts.length >= 5 && !kinds.has(parts[4]!)) fail("UNKNOWN_STATE", "Unknown subscription cache directory.");
      directories.push(`subscriptions/${relative}`);
      for (const name of (await readdir(path)).sort()) await walk(`${relative}/${name}`);
      const after = await lstat(path, { bigint: true });
      if (!after.isDirectory() || after.isSymbolicLink() || after.dev !== stat.dev || after.ino !== stat.ino
        || after.mtimeNs !== stat.mtimeNs || after.ctimeNs !== stat.ctimeNs) {
        fail("SOURCE_CHANGED", "Subscription cache directory changed while inspecting.");
      }
    } else {
      if (parts.length < 4 || parts.length === 4 && !["_subscription.json", "summary.json", "bundle.json"].includes(parts[3]!)
        || parts.length === 5 || parts.length >= 6 && (parts[3] !== "content" || !kinds.has(parts[4]!))) {
        fail("UNKNOWN_STATE", "Unknown subscription cache file or pending state.");
      }
      const pin = await inspectLegacyCacheFile(path);
      if (parts.length === 4 || relative.endsWith(".pkm-source.json")) {
        const bytes = await io.read(path);
        if (bytes.length !== pin.size || createHash("sha256").update(bytes).digest("hex") !== pin.sha256) fail("SOURCE_CHANGED", "Cache metadata changed while reading.");
        const value = io.json(bytes);
        const member = members.get(`${parts[1]}/${parts[2]}`)!;
        if (parts[3] === "_subscription.json" && (
          value.nodeId !== undefined && value.nodeId !== member.nodeId || value.shareId !== undefined && value.shareId !== member.shareId
          || value.id !== undefined && value.id !== member.id
          || value.subscriptionId !== undefined && value.subscriptionId !== member.id)) {
          fail("INVALID_STATE", "Cache provenance does not match exact current subscription membership.");
        }
        if (relative.endsWith(".pkm-source.json") && (
          value.nodeId !== undefined && value.nodeId !== member.nodeId
          || value.shareId !== undefined && value.shareId !== member.shareId
          || value.subscriptionId !== undefined && value.subscriptionId !== member.id)) {
          fail("INVALID_STATE", "Cached source provenance claims a foreign subscriber.");
        }
      }
      files.push({ source: path, relative, ...pin });
    }
  }
  await walk("cache");
  const known = new Set(files.map(file => file.relative));
  for (const file of files) {
    if (file.relative.endsWith(".pkm-source.json") && !known.has(file.relative.slice(0, -".pkm-source.json".length))) {
      fail("INVALID_STATE", "Cached source provenance has no exact content owner.");
    }
  }
  return { files, directories, emptyStaging };
}
