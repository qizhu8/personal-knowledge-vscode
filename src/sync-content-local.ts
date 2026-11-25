import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { githubSyncIgnoredPath, githubSyncSafeRelativePath } from "./sync-storage-boundary.js";
import { validateSyncContentState } from "./sync-content.js";
import { syncNoteFileHasUnlimitedText, syncPlanLimits, type SyncManifest } from "./sync-plan-contracts.js";
import { legacyMarkdownAssets } from "./legacy-sync-markdown-assets.js";
import { legacySyncScriptIdentity } from "./legacy-sync-script-identity.js";

type Type = SyncManifest["files"][number]["type"];
export type SyncContentSelection = Record<"public" | "private", Partial<Record<Type, { items: string[]; folders: string[] }>>>;
export function syncMemberSelected(selection: SyncContentSelection,
  member: SyncManifest["files"][number] | SyncManifest["deletions"][number]): boolean {
  if (member.privacy === undefined || member.category === undefined) {
    if (!selection.public[member.type] && !selection.private[member.type]) return false;
    throw new Error("Selected Sync source requires classified identity.");
  }
  const scope = selection[member.privacy][member.type];
  return !!scope && (scope.items.includes(member.itemId) || scope.folders.some(folder =>
    !folder || member.category === folder || member.category!.startsWith(`${folder}/`)));
}
export const syncSelectedTypes = (selection: SyncContentSelection): Set<Type> =>
  new Set((["public", "private"] as const).flatMap(privacy =>
    Object.entries(selection[privacy]).filter(([, value]) => value.items.length || value.folders.length).map(([type]) => type as Type)));

export function readSyncContentFile(root: string, relative: string): Buffer {
  const safe = githubSyncSafeRelativePath(relative);
  if (safe !== relative) throw new Error("Sync source path is not canonical.");
  const rootInfo = fs.lstatSync(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || fs.realpathSync(root) !== root
    || process.getuid !== undefined && rootInfo.uid !== process.getuid()) throw new Error("Unsafe Sync source root.");
  let current = root;
  const parents: Array<{ path: string; dev: number; ino: number }> = [{ path: root, dev: rootInfo.dev, ino: rootInfo.ino }];
  for (const part of safe.split("/").slice(0, -1)) {
    current = path.join(current, part);
    const info = fs.lstatSync(current);
    if (!info.isDirectory() || info.isSymbolicLink() || process.getuid !== undefined && info.uid !== process.getuid())
      throw new Error("Unsafe Sync source parent.");
    parents.push({ path: current, dev: info.dev, ino: info.ino });
  }
  const target = path.join(root, safe), before = fs.lstatSync(target);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1
    || process.getuid !== undefined && before.uid !== process.getuid()) throw new Error("Sync source is not an exclusively owned regular file.");
  const type = relative.split("/")[0];
  if (!syncNoteFileHasUnlimitedText({ type, path: relative })
    && before.size > (type === "notes" ? syncPlanLimits.noteAssetBytes : syncPlanLimits.markdownBytes))
    throw new Error("Sync source exceeds its existing bounded file contract.");
  const fd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const opened = fs.fstatSync(fd), bytes = fs.readFileSync(fd), after = fs.fstatSync(fd), entry = fs.lstatSync(target);
    if (opened.dev !== before.dev || opened.ino !== before.ino || entry.dev !== opened.dev || entry.ino !== opened.ino
      || opened.nlink !== 1 || after.nlink !== 1 || entry.nlink !== 1
      || opened.size !== after.size || opened.mtimeMs !== after.mtimeMs || opened.ctimeMs !== after.ctimeMs
      || opened.size !== bytes.length || entry.mtimeMs !== after.mtimeMs || entry.ctimeMs !== after.ctimeMs)
      throw new Error("Sync source changed while being read.");
    for (const parent of parents) {
      const now = fs.lstatSync(parent.path);
      if (!now.isDirectory() || now.isSymbolicLink() || now.dev !== parent.dev || now.ino !== parent.ino
        || process.getuid !== undefined && now.uid !== process.getuid())
        throw new Error("Sync source parent changed while being read.");
    }
    return bytes;
  } finally { fs.closeSync(fd); }
}
const read = readSyncContentFile;
function paths(root: string, prefix: string): string[] {
  const result: string[] = [];
  const walk = (relative: string) => {
    let info: fs.Stats;
    try { info = fs.lstatSync(path.join(root, relative)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    if (info.isSymbolicLink()) throw new Error("Symlink in native Sync source.");
    if (info.isFile()) { result.push(relative); return; }
    if (!info.isDirectory()) throw new Error("Unsupported native Sync source.");
    const names = fs.readdirSync(path.join(root, relative)).sort();
    for (const name of names) {
      const child = relative + "/" + name;
      if (name === ".trash" || githubSyncIgnoredPath(child)) continue;
      walk(child);
    }
    const after = fs.lstatSync(path.join(root, relative));
    if (after.dev !== info.dev || after.ino !== info.ino || after.mtimeMs !== info.mtimeMs || after.ctimeMs !== info.ctimeMs)
      throw new Error("Native Sync directory changed while being read.");
  };
  walk(prefix);
  return result;
}
export function validateSelectedSyncManifest(manifest: SyncManifest, selection: SyncContentSelection): void {
  const groups = new Map<string, SyncManifest["files"]>();
  for (const file of manifest.files.filter(file => syncMemberSelected(selection, file))) {
    const key = JSON.stringify([file.type, file.itemId]), files = groups.get(key) ?? [];
    files.push(file); groups.set(key, files);
  }
  for (const files of groups.values()) validateSyncContentState(files);
  for (const deletion of manifest.deletions.filter(file => syncMemberSelected(selection, file))) validateSyncContentState([], deletion);
}

/** Materializes inert original root-owned source bytes only; no execution, SDK state or private profile search. */
export function snapshotSelectedSyncContent(root: string, remote: SyncManifest, selection: SyncContentSelection,
  privateFolders: Partial<Record<Type, string[]>>, nativeTombstones: SyncManifest["deletions"] = []): SyncManifest {
  const files: SyncManifest["files"] = [], types = syncSelectedTypes(selection), assets = legacyMarkdownAssets();
  const add = (relative: string, type: Type, itemId: string, category: string, member: string, privacy: "public" | "private") => {
    const bytes = read(root, relative);
    files.push({ path: relative, type, itemId, member, category, privacy,
      digest: createHash("sha256").update(bytes).digest("hex"), contentBase64: bytes.toString("base64") });
  };
  for (const type of types) {
    if (type === "skills") continue;
    if (type === "agentSnapshots") throw new Error("Agent Snapshot Sync requires a current portable encrypted producer, not local-obfuscated historical SDK state.");
    const all = paths(root, type);
    if (type === "notes" || type === "papers" || type === "scripts") {
      for (const relative of all) {
        if (relative.split("/").some(part => part.endsWith(".assets")) || path.posix.basename(relative).startsWith(".")) continue;
        if (type !== "scripts" && !relative.endsWith(".md")) continue;
        const source = relative.slice(type.length + 1), category = path.posix.dirname(source).replace(/^\.$/, "");
        let itemId = source.replace(/\.[^.]+$/, "");
        let sidecar: string | undefined;
        if (type === "scripts") {
          const candidate = legacySyncScriptIdentity().syncScriptSidecarPath(relative);
          if (all.includes(candidate)) {
            const value = legacySyncScriptIdentity().readSyncScriptIdentity(read(root, candidate));
            itemId = value.knowledgeId; sidecar = candidate;
          }
        }
        const privacy = (privateFolders[type] ?? []).includes(category.split("/")[0]) ? "private" : "public";
        if (!syncMemberSelected(selection, { type, itemId, category, privacy, deletedAt: "" })) continue;
        add(relative, type, itemId, category, "", privacy);
        if (sidecar) add(sidecar, type, itemId, category, "identity-sidecar", privacy);
        const dependencies = type === "scripts"
          ? all.filter(member => member.startsWith(relative.replace(/\.[^.]+$/, "") + ".assets/"))
          : assets.listedMarkdownAssets(root, type, source, read(root, relative).toString("utf8")).map(asset => `${type}/${asset.path}`);
        for (const member of dependencies) add(member, type, itemId, category, member, privacy);
      }
    } else {
      const groups = new Map<string, string[]>();
      for (const relative of all) {
        const parts = relative.split("/");
        const itemId = type === "packages" || type === "servers" ? parts[1]
          : type === "prompts" ? parts.slice(1, 3).join("/")
          : type === "action-module-sets" || type === "profiles" ? parts.slice(1, 3).join("/").replace(/\.json$/, "")
          : type === "recipes" ? /\.([^.]+)\.json$/.exec(parts.at(-1)!)?.[1] ?? ""
          : parts.at(-1)!.replace(/\.json$/, "");
        const group = groups.get(itemId) ?? []; group.push(relative); groups.set(itemId, group);
      }
      for (const [itemId, members] of groups) {
        const first = members[0], parts = first.split("/");
        const category = type === "profiles" || type === "action-module-sets" || type === "prompts" ? parts[1]
          : type === "actions" ? "" : type === "recipes" ? parts.slice(1, -1).join("/").replace(/^Uncategorized$/, "") : "";
        const privateKey = type === "actions" || type === "action-module-sets" ? itemId.split("/")[0] : category.split("/")[0];
        const privacy = type === "profiles" || (privateFolders[type] ?? []).includes(privateKey) ? "private" : "public";
        if (!syncMemberSelected(selection, { type, itemId, category, privacy, deletedAt: "" })) continue;
        for (const relative of members) {
          const member = type === "packages" || type === "servers" || type === "prompts" ? relative.split("/").slice(type === "prompts" ? 3 : 2).join("/")
            : type === "action-module-sets" && !relative.endsWith("/manifest.json") ? relative : "";
          add(relative, type, itemId, category, member, privacy);
        }
      }
    }
  }
  const selected = (value: SyncManifest["files"][number] | SyncManifest["deletions"][number]) =>
    value.type !== "skills" && syncMemberSelected(selection, value);
  const result: SyncManifest = { ...remote,
    files: [...remote.files.filter(file => !selected(file)), ...files],
    deletions: [...remote.deletions.filter(file => !selected(file)), ...nativeTombstones.filter(selected)] };
  validateSelectedSyncManifest(result, selection);
  return result;
}
