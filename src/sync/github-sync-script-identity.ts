import * as fs from "fs";
import * as path from "path";

export interface SyncScriptIdentity {
  schema: "pkm.script/v1";
  knowledgeId: string;
  aliases: string[];
}

export function syncScriptAliasPath(alias: string): string | undefined {
  if (!alias.startsWith("pkm://scripts/")) return undefined;
  try {
    const parts = alias.slice("pkm://scripts/".length).split("/").map(decodeURIComponent);
    if (parts.some(part => !part || part === "." || part === ".." || /[\\/\x00-\x1f<>:"|?*]/.test(part))) return undefined;
    return `scripts/${parts.join("/")}`;
  } catch { return undefined; }
}

export function readSyncScriptIdentity(content: Buffer): SyncScriptIdentity {
  const value = JSON.parse(content.toString("utf8"));
  if (value?.schema !== "pkm.script/v1" || !/^script_[a-f0-9]{24}$/.test(value.knowledgeId)
    || Object.keys(value).some(key => !["schema", "knowledgeId", "aliases"].includes(key))
    || !Array.isArray(value.aliases) || value.aliases.length > 10000
    || value.aliases.some((alias: unknown) => typeof alias !== "string"
      || (!/^pkm:\/\/script\/script_[a-f0-9]{24}$/.test(alias) && !syncScriptAliasPath(alias)))) {
    throw new Error("Invalid Script identity metadata; synchronization requires review.");
  }
  return value;
}

export function syncScriptSidecarPath(body: string): string {
  return path.posix.join(path.posix.dirname(body), `.${path.posix.basename(body)}.pkm.json`);
}

export function mergeSyncScriptIdentities(left: Buffer, right: Buffer, itemId: string): Buffer {
  const local = readSyncScriptIdentity(left), remote = readSyncScriptIdentity(right);
  if (local.knowledgeId !== itemId || remote.knowledgeId !== itemId) throw new Error("Script identity changed during merge.");
  return Buffer.from(JSON.stringify({ ...local, aliases: [...new Set([...local.aliases, ...remote.aliases])].sort() }, null, 2) + "\n");
}

interface IdentityFile {
  path: string;
  type: string;
  itemId: string;
  member: string;
  content?: Buffer;
}

/** Resolve only exact primary IDs or unique, validated path lineage, never names or hashes. */
export function alignSyncScriptIdentities(snapshots: IdentityFile[][]): Map<string, string> {
  const claims = new Map<string, Set<string>>();
  const claim = (locator: string, id: string): void => {
    const ids = claims.get(locator) || new Set<string>();
    ids.add(id);
    claims.set(locator, ids);
  };
  for (const files of snapshots) {
    const byPath = new Map(files.map(file => [file.path, file]));
    const bodies = new Map<string, string>();
    for (const body of files.filter(file => file.type === "scripts" && !path.posix.basename(file.path).startsWith("."))) {
      const sidecar = byPath.get(syncScriptSidecarPath(body.path));
      if (!sidecar) continue;
      if (!sidecar.content) throw new Error(`Script identity has no validated content: ${sidecar.path}`);
      const identity = readSyncScriptIdentity(sidecar.content);
      if (/^script_[a-f0-9]{24}$/.test(body.itemId) && body.itemId !== identity.knowledgeId) {
        throw new Error(`Script manifest identity does not match its sidecar: ${body.path}`);
      }
      if (bodies.has(identity.knowledgeId)) throw new Error(`Ambiguous active Script identity ${identity.knowledgeId}: ${bodies.get(identity.knowledgeId)}, ${body.path}`);
      bodies.set(identity.knowledgeId, body.path);
      claim(body.path, identity.knowledgeId);
      claim(body.itemId, identity.knowledgeId);
      for (const alias of identity.aliases) {
        const locator = syncScriptAliasPath(alias);
        if (locator) { claim(locator, identity.knowledgeId); claim(locator.slice("scripts/".length), identity.knowledgeId); }
      }
      body.itemId = sidecar.itemId = identity.knowledgeId;
      body.member = "";
      sidecar.member = "identity-sidecar";
    }
  }
  const unique = new Map([...claims].filter(([, ids]) => ids.size === 1).map(([locator, ids]) => [locator, [...ids][0]]));
  for (const files of snapshots) {
    for (const body of files.filter(file => file.type === "scripts" && !path.posix.basename(file.path).startsWith("."))) {
      if (/^script_[a-f0-9]{24}$/.test(body.itemId)) continue;
      const id = unique.get(body.path) || unique.get(body.itemId);
      if (id) { body.itemId = id; body.member = ""; }
    }
  }
  return unique;
}

export interface SyncHistoricalTrashEvidence {
  trashId: string;
  originalPath: string;
  deletedAt: string;
  knowledgeId: string;
  payloadDigest: string;
}

/** Read-only evidence, deliberately not a deletion journal or an authorization. */
export function syncHistoricalScriptTrash(root: string): SyncHistoricalTrashEvidence[] {
  const trash = path.join(root, "scripts", ".trash");
  if (!fs.existsSync(trash)) return [];
  const evidence: SyncHistoricalTrashEvidence[] = [];
  const plain = (full: string): fs.Stats => {
    const stat = fs.lstatSync(full);
    if (stat.isSymbolicLink()) throw new Error("Historical Script Trash contains a symbolic link; review required.");
    return stat;
  };
  plain(trash);
  for (const id of fs.readdirSync(trash)) {
    if (!/^[0-9]+-[a-f0-9]+$/.test(id)) continue;
    const directory = path.join(trash, id), metadataPath = path.join(directory, "metadata.json");
    plain(directory); plain(metadataPath);
    const entry = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
    const original = syncScriptAliasPath(`pkm://scripts/${String(entry.originalPath || "")}`);
    if (entry.id !== id || typeof entry.originalPath !== "string" || !original || original.split("/").includes(".trash")
      || typeof entry.deletedAt !== "string" || !Number.isFinite(Date.parse(entry.deletedAt))
      || !["item", "folder"].includes(entry.kind)) throw new Error(`Invalid historical Script Trash metadata: ${id}`);
    const walk = (full: string, relative: string): void => {
      const stat = plain(full);
      if (stat.isDirectory()) {
        for (const name of fs.readdirSync(full)) if (!name.startsWith(".")) walk(path.join(full, name), `${relative}/${name}`);
      } else if (stat.isFile()) {
        const sidecar = path.join(path.dirname(full), `.${path.basename(full)}.pkm.json`);
        if (!fs.existsSync(sidecar)) return;
        plain(sidecar);
        const identity = readSyncScriptIdentity(fs.readFileSync(sidecar));
        evidence.push({ trashId: id, originalPath: relative, deletedAt: entry.deletedAt, knowledgeId: identity.knowledgeId,
          payloadDigest: require("crypto").createHash("sha256").update(fs.readFileSync(full)).digest("hex") });
      }
    };
    const payload = path.join(directory, "payload");
    const payloadStat = plain(payload);
    if (entry.kind === "folder" ? !payloadStat.isDirectory() : !payloadStat.isFile()) throw new Error(`Invalid historical Script Trash payload: ${id}`);
    walk(payload, original);
  }
  return evidence;
}
