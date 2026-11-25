import { createHash } from "node:crypto";
import { githubSyncIgnoredPath, githubSyncSafeRelativePath } from "./sync-storage-boundary.js";
import {
  syncNoteFileHasUnlimitedText, syncPlanInputSchema, syncPlanLimits,
  type SyncManifest, type SyncPlanInput,
} from "./sync-plan-contracts.js";

type File = SyncManifest["files"][number];
type Deletion = SyncManifest["deletions"][number];
type State = { kind: "live"; files: File[] } | { kind: "deleted"; deletion: Deletion } | { kind: "absent" };
export type SyncPlanConflict = {
  id: string; type: File["type"]; itemId: string; reason: string;
  base: State; local: State; remote: State;
};
export type SyncPlan = {
  schema: "pkm.sync-plan/v1"; pins: { base: string; local: string; remote: string };
  proposals: { type: File["type"]; itemId: string; source: "local" | "remote" | "both"; state: State }[];
  conflicts: SyncPlanConflict[];
  deletionHistory: { source: "base" | "local" | "remote"; deletion: Deletion }[];
};

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj).sort().filter(key => obj[key] !== undefined).map(key => `${JSON.stringify(key)}:${stable(obj[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
export function syncPlanHash(value: unknown): string {
  return createHash("sha256").update(stable(value)).digest("hex");
}
const keyOf = (value: { type: string; itemId: string }) => JSON.stringify([value.type, value.itemId]);
const portable = (path: string) => path.normalize("NFC").toLocaleLowerCase("en-US");
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const pathCheck = (path: string): void => {
  if (path !== path.normalize("NFC") || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(path)
    || path.startsWith("/") || path.includes("\\") || githubSyncSafeRelativePath(path) !== path
    || path.split("/").some(part => portable(part) === ".git") || githubSyncIgnoredPath(path) || githubSyncIgnoredPath(portable(path))) {
    throw new Error(`Unsafe or ignored path: ${path}`);
  }
};

function validate(manifest: SyncManifest): Map<string, State> {
  const required = manifest.capabilities.required;
  if (new Set(required).size !== required.length || !required.includes("explicit-deletions") || !required.includes("stable-entity-identity")) throw new Error("Missing or duplicate required capabilities");
  const paths = new Set<string>();
  const members = new Set<string>();
  const entities = new Map<string, State>();
  let nonNoteBytes = 0;
  for (const file of manifest.files) {
    pathCheck(file.path);
    if (file.member) pathCheck(file.member);
    if (file.path.split("/")[0] !== file.type || (file.type === "recipes" && file.path.split("/").includes(".trash"))) throw new Error("Manifest path/type mismatch");
    if (file.type === "profiles" && (!required.includes("profile-cards") || file.privacy !== "private" || !/^profiles\/(user|agent)\/[a-f0-9-]{36}\.json$/.test(file.path) || file.itemId !== file.path.slice(9, -5) || file.category !== file.itemId.split("/")[0] || file.member)) throw new Error("Invalid profile identity");
    const path = portable(file.path);
    if (paths.has(path)) throw new Error("Duplicate portable path");
    paths.add(path);
    const key = keyOf(file);
    const member = JSON.stringify([key, file.member]);
    if (members.has(member)) throw new Error("Duplicate member identity");
    members.add(member);
    if (file.contentBase64 !== undefined) {
      const content = Buffer.from(file.contentBase64, "base64");
      if (content.toString("base64") !== file.contentBase64 || createHash("sha256").update(content).digest("hex") !== file.digest) throw new Error("Content digest or encoding mismatch");
      if (!syncNoteFileHasUnlimitedText(file)) {
        if (file.type === "notes") {
          if (content.length > syncPlanLimits.noteAssetBytes) throw new Error("Note asset exceeds its resource limit");
        } else {
          if (content.length > syncPlanLimits.markdownBytes) throw new Error("Non-Notes sync file exceeds its file limit");
          nonNoteBytes += content.length;
          if (nonNoteBytes > syncPlanLimits.totalBytes) throw new Error("Non-Notes sync content exceeds its aggregate limit");
        }
      }
    }
    const previous = entities.get(key);
    if (previous?.kind === "live") {
      if (previous.files[0].category !== file.category || previous.files[0].privacy !== file.privacy) throw new Error("Inconsistent entity metadata");
      previous.files.push(file);
    } else entities.set(key, { kind: "live", files: [file] });
  }
  for (const path of paths) {
    const parts = path.split("/");
    for (let i = 1; i < parts.length; i++) if (paths.has(parts.slice(0, i).join("/"))) throw new Error("File/directory path collision");
  }
  for (const deletion of manifest.deletions) {
    if (!Number.isFinite(Date.parse(deletion.deletedAt))) throw new Error("Invalid deletion timestamp");
    if (deletion.type === "profiles" && (!required.includes("profile-cards") || deletion.privacy !== "private" || !/^(user|agent)\/[a-f0-9-]{36}$/.test(deletion.itemId) || deletion.category !== deletion.itemId.split("/")[0])) throw new Error("Invalid profile deletion");
    const key = keyOf(deletion);
    if (entities.has(key)) throw new Error("Duplicate deletion or live tombstone");
    entities.set(key, { kind: "deleted", deletion });
  }
  for (const state of entities.values()) if (state.kind === "live") state.files.sort((a, b) => compare(a.member, b.member));
  return entities;
}

function stateComparable(state: State): unknown {
  if (state.kind !== "live") return state;
  return { kind: state.kind, files: state.files.map(({ contentBase64: _content, ...file }) => file) };
}
const same = (a: State, b: State) => stable(stateComparable(a)) === stable(stateComparable(b));
const absent: State = { kind: "absent" };
function moved(a: State, b: State): boolean {
  if (a.kind !== "live" || b.kind !== "live") return false;
  const paths = new Map(a.files.map(file => [file.member, file.path]));
  return b.files.some(file => paths.has(file.member) && paths.get(file.member) !== file.path);
}
function missingMember(a: State, b: State): boolean {
  if (a.kind !== "live" || b.kind !== "live") return false;
  const members = new Set(b.files.map(file => file.member));
  return a.files.some(file => !members.has(file.member));
}

/** A remote restore must cover the whole known entity, not just its missing body. */
export function syncRemoteRestoreMembers(conflict: SyncPlanConflict): File[] | undefined {
  if (conflict.remote.kind !== "live"
    || (conflict.local.kind === "live" && !missingMember(conflict.base, conflict.local))) return undefined;
  const members = new Set(conflict.remote.files.map(file => file.member));
  for (const state of [conflict.base, conflict.local]) if (state.kind === "live") {
    for (const file of state.files) if (!members.has(file.member)) {
      throw new Error(`Remote entity member is unavailable; review the move or deletion: ${file.path}`);
    }
  }
  return conflict.remote.files;
}

export function planSync(input: SyncPlanInput): SyncPlan {
  const parsed = syncPlanInputSchema.parse(input);
  const names = ["base", "local", "remote"] as const;
  const maps = names.map(name => {
    const snapshot = parsed[name];
    if (syncPlanHash(snapshot.manifest) !== snapshot.sha256) throw new Error(`${name} manifest pin mismatch`);
    return validate(snapshot.manifest);
  });
  const [base, local, remote] = maps;
  const pins = { base: parsed.base.sha256, local: parsed.local.sha256, remote: parsed.remote.sha256 };
  const ownership = new Map<string, Set<string>>();
  const spellings = new Map<string, Set<string>>();
  for (const map of maps) for (const [key, state] of map) if (state.kind === "live") for (const file of state.files) {
    const folded = portable(file.path);
    const owners = ownership.get(folded) ?? new Set<string>(); owners.add(key); ownership.set(folded, owners);
    const variants = spellings.get(folded) ?? new Set<string>(); variants.add(file.path); spellings.set(folded, variants);
  }
  const colliding = new Set<string>();
  for (const [path, owners] of ownership) if (owners.size > 1 || spellings.get(path)!.size > 1) for (const owner of owners) colliding.add(owner);
  // Cross-snapshot file/directory collisions can otherwise make independently valid proposals incompatible.
  const paths = [...ownership.keys()].sort(compare);
  for (let i = 0; i < paths.length; i++) for (let j = i + 1; j < paths.length && paths[j].startsWith(paths[i]); j++) {
    if (paths[j].startsWith(`${paths[i]}/`)) for (const owner of [...ownership.get(paths[i])!, ...ownership.get(paths[j])!]) colliding.add(owner);
  }
  const keys = [...new Set(maps.flatMap(map => [...map.keys()]))].sort(compare);
  const proposals: SyncPlan["proposals"] = [];
  const conflicts: SyncPlanConflict[] = [];
  for (const key of keys) {
    const b = base.get(key) ?? absent, l = local.get(key) ?? absent, r = remote.get(key) ?? absent;
    const [type, itemId] = JSON.parse(key) as [File["type"], string];
    let reason: string | undefined;
    if (colliding.has(key)) reason = "path-collision";
    else if (b.kind === "live" && (l.kind === "absent" || r.kind === "absent")) reason = "unrecorded-absence";
    else if (b.kind === "deleted" && (l.kind === "absent" || r.kind === "absent")) reason = "missing-deletion-history";
    else if (moved(b, l) || moved(b, r)) reason = "move-review";
    else if (missingMember(b, l) || missingMember(b, r)) reason = "unrecorded-member-absence";
    else if (!same(l, r) && !same(b, l) && !same(b, r)) reason = "concurrent-change";
    if (reason) conflicts.push({ id: syncPlanHash({ pins, key }), type, itemId, reason, base: b, local: l, remote: r });
    else if (same(l, r)) {
      if (!same(b, l)) proposals.push({ type, itemId, source: "both", state: l });
    } else if (same(b, l)) proposals.push({ type, itemId, source: "remote", state: r });
    else proposals.push({ type, itemId, source: "local", state: l });
  }
  return {
    schema: "pkm.sync-plan/v1", pins, proposals, conflicts,
    deletionHistory: names.flatMap(source => parsed[source].manifest.deletions.map(deletion => ({ source, deletion })))
      .sort((a, b) => compare(stable(a), stable(b))),
  };
}
