import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { legacyVscodeSyncCredentialReader } from "./legacy-github-sync-credentials.js";
import { experimentalLegacySyncJournalSchema as journalSchema } from "./legacy-github-sync-journal.js";
import { createNativeRuntime } from "./native-runtime.js";
import type { Storage } from "./storage.js";
import { syncPlanHash } from "./sync-plan.js";
import { syncPlanManifestSchema, type SyncManifest } from "./sync-plan-contracts.js";
import { projectSkillsOnlySyncInput } from "./sync-skills-only.js";
import { validatePrivacyPolicy } from "./legacy-root-pkm-state.js";
import { legacyMarkdownAssets, skillAssetPaths } from "./legacy-sync-markdown-assets.js";
import { assertNativeTrashRow, readNativeTrashOrigins, readOriginalTrashDeletionHistory } from "./migration-runtime.js";
import { inspectTrashLifecycleEntry, previewTrashLifecycle, previewTrashRestoreRevision } from "./trash-lifecycle.js";
import { trashLifecycleDefinitions } from "./trash-lifecycle-contracts.js";
import type { SyncTransportNativeHost } from "./sync-transport.js";
import type { SyncNativeGitProvider } from "./sync-native-git-provider.js";

const hash = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
const oid = z.string().regex(/^[a-f0-9]{40}$/);
const uuid = z.string().uuid();
type Journal = z.infer<typeof journalSchema>;

function fail(message: string): never {
  throw new Error(`Experimental legacy Sync: ${message}`);
}

function legacyTargetLock() {
  const load = createRequire(import.meta.url);
  const candidates = [
    new URL("../legacy/dist/runtime/cross-process-lock.js", import.meta.url),
    new URL("../legacy/dist/runtime/cross-process-lock.js", import.meta.url),
  ];
  const source = candidates.find(candidate => fs.existsSync(candidate));
  if (!source) return fail("retained target lock implementation is unavailable");
  const original = load(fileURLToPath(source)) as {
    withCrossProcessLock<T>(lockPath: string, owner: string, timeoutMs: number, work: () => Promise<T>): Promise<T>;
  };
  if (typeof original.withCrossProcessLock !== "function") return fail("retained target lock implementation is invalid");
  return original.withCrossProcessLock;
}

function readRegular(file: string, optional = false): Buffer | undefined {
  let descriptor: number;
  try { descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); }
  catch (error) {
    if (optional && (error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 8 * 1024 * 1024) fail("unsafe state file");
    const bytes = fs.readFileSync(descriptor), after = fs.fstatSync(descriptor);
    if (after.dev !== stat.dev || after.ino !== stat.ino || after.size !== stat.size
      || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs || bytes.length !== stat.size)
      fail("state file changed while reading");
    return bytes;
  } finally { fs.closeSync(descriptor); }
}

function readJson(file: string, optional = false): unknown {
  const bytes = readRegular(file, optional);
  if (!bytes) return undefined;
  try { return JSON.parse(bytes.toString("utf8")); } catch { return fail("invalid state JSON"); }
}

function directory(file: string, optional = false): string[] {
  let stat: fs.Stats;
  try { stat = fs.lstatSync(file); }
  catch (error) {
    if (optional && (error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail("unsafe state directory");
  return fs.readdirSync(file).sort();
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail("invalid legacy state");
  return value as Record<string, unknown>;
}

function empty(value: unknown): boolean {
  return value === undefined || Array.isArray(value) && value.length === 0;
}

function emptyEntityBases(value: unknown): boolean {
  // Nonempty maps retain unresolved per-entity history, not the global baseline.
  return value === undefined || value !== null && typeof value === "object"
    && !Array.isArray(value) && Object.keys(value).length === 0;
}

function validRecordedOutbox(value: unknown): boolean {
  if (value === undefined) return true;
  return Array.isArray(value) && value.length <= 10_000 && value.every(item => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return false;
    return typeof item.entity === "string" && item.entity.length > 0 && item.entity.length <= 1024
      && typeof item.snapshot === "string" && item.snapshot.length <= 1_048_576;
  });
}

type SkillsSelection = Record<"public" | "private", { items: string[]; folders: string[] }>;

function validateSkillsSelection(value: unknown, policy: SyncTransportNativeHost["policy"]): SkillsSelection {
  const selection = object(value);
  const result: SkillsSelection = { public: { items: [], folders: [] }, private: { items: [], folders: [] } };
  const knownTypes = new Set(["skills", "notes", "papers", "prompts", "scripts", "packages", "servers",
    "recipes", "agentSnapshots", "actions", "action-module-sets", "profiles"]);
  if (Object.keys(selection).some(key => key !== "public" && key !== "private")) fail("unsupported legacy selection scope");
  for (const privacy of ["public", "private"] as const) {
    const scope = object(selection[privacy]);
    for (const [type, raw] of Object.entries(scope)) {
      const selected = object(raw);
      if (!knownTypes.has(type) || Object.keys(selected).some(key => key !== "items" && key !== "folders"))
        fail("unsupported legacy selection fields");
      if (type === "skills") {
        const items = selected.items ?? [], folders = selected.folders ?? [];
        if (!Array.isArray(items) || !Array.isArray(folders)
          || [...items, ...folders].some(value => typeof value !== "string" || value.length > 512 || /[\u0000-\u001f\u007f\\]/.test(value)))
          fail("unsupported Skills selection");
        if (privacy === "private" && (items.length || folders.length)
          && (!policy.allowPrivate || policy.visibility !== "private")) fail("private Skills require an authorized private repository");
        result[privacy] = { items, folders };
      } else if (!empty(selected.items) || !empty(selected.folders)) fail("unsupported legacy selection");
    }
  }
  if (!Object.values(result).some(scope => scope.items.length || scope.folders.length)) fail("Skills selection missing");
  return result;
}

function selectedSkill(selection: SkillsSelection, member: { privacy?: "public" | "private"; itemId: string; category?: string }): boolean {
  if (!member.privacy || member.category === undefined) fail("Skills selection requires classified identity");
  const scope = selection[member.privacy];
  const category = member.category;
  return scope.items.includes(member.itemId) || scope.folders.some(folder =>
    folder === "" || category === folder || category.startsWith(`${folder}/`));
}

function privacyState(root: string): { digest: string; folders: Set<string> } {
  const pkm = path.join(root, ".pkm");
  directory(pkm, true);
  const bytes = readRegular(path.join(pkm, "content-privacy.json"), true);
  if (!bytes) return { digest: hash("absent"), folders: new Set() };
  validatePrivacyPolicy(bytes);
  const state = object(JSON.parse(bytes.toString("utf8")));
  const values = object(state.private).skills;
  return { digest: hash(bytes), folders: new Set((values ?? []) as string[]) };
}

function assertNoPendingLegacySkillDeletions(root: string): void {
  const state = path.join(root, ".pkm", "state");
  directory(path.join(root, ".pkm"), true);
  directory(state, true);
  const bytes = readRegular(path.join(state, "knowledge-deletions.json"), true);
  if (!bytes) return;
  const journal = object(JSON.parse(bytes.toString("utf8")));
  if (journal.schema !== 1 || !Array.isArray(journal.records)) fail("invalid original deletion journal");
  for (const raw of journal.records) {
    const record = object(raw);
    if (typeof record.path !== "string" || !/^(skills|notes|papers|prompts|scripts)\//.test(record.path)
      || record.path.split("/").some(part => !part || part === "." || part === "..")
      || typeof record.deletedAt !== "string" || !Number.isFinite(Date.parse(record.deletedAt)))
      fail("invalid original deletion journal");
    if (record.path.startsWith("skills/")) fail("original Skills deletion requires recoverable reconciliation");
  }
}

function validateSkillContent(name: string, data: Buffer): string | undefined {
  if (data.length > 1024 * 1024 || !Buffer.from(data.toString("utf8")).equals(data)) fail("unsupported Skill bytes");
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(data.toString("utf8"));
  if (!frontmatter) fail("Skill identity requires frontmatter");
  if (!data.toString("utf8").slice(frontmatter[0].length).trim()) fail("Skill body is empty");
  let parsed: unknown;
  try { parsed = parseYaml(frontmatter[1]); } catch { return fail("invalid Skill frontmatter"); }
  const metadata = object(parsed);
  if (metadata.name !== name || metadata.category || object(metadata.metadata ?? {}).category)
    fail("Skill identity or category requires review");
  if (metadata.knowledgeId !== undefined
    && (typeof metadata.knowledgeId !== "string" || !/^knowledge_[a-f0-9]{24}$/.test(metadata.knowledgeId)))
    fail("Skill knowledge identity requires review");
  return metadata.knowledgeId as string | undefined;
}

function safeSkills(manifest: SyncManifest, folders: Set<string>): void {
  const files = manifest.files.filter(file => file.type === "skills");
  const documents = new Map<string, typeof files[number]>(), identities = new Set<string>(), names = new Set<string>();
  for (const file of files.filter(file => !file.member)) {
    if (!/^skills\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.md$/.test(file.path)
      || file.itemId !== path.posix.basename(file.path, ".md") || names.has(file.itemId.toLowerCase())
      || file.category !== path.posix.dirname(file.path).slice("skills".length).replace(/^\//, "")
      || file.privacy !== (file.category && folders.has(file.category.split("/")[0]) ? "private" : "public")
      || /^system(?:\/|$)/i.test(file.category)
      || /^system$/i.test(file.itemId)) fail("unsupported Skills identity or privacy");
    if (file.contentBase64 === undefined) fail("remote Skill content is missing");
    const identity = validateSkillContent(file.itemId, Buffer.from(file.contentBase64, "base64"));
    if (identity && identities.has(identity)) fail("duplicate Skill knowledge identity");
    if (identity) identities.add(identity);
    names.add(file.itemId.toLowerCase());
    documents.set(file.itemId, file);
  }
  const paths = files.map(file => file.path);
  for (const file of files.filter(file => !!file.member)) {
    const document = documents.get(file.itemId);
    if (!document || file.member !== file.path || file.category !== document.category || file.privacy !== document.privacy
      || !/^skills\/(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.(?:avif|bmp|gif|ico|jpeg|jpg|pdf|png|svg|tif|tiff|webp)$/i.test(file.path)
      || file.contentBase64 === undefined) fail("unsupported Skill asset");
    let owned: Set<string>;
    try { owned = skillAssetPaths(document.path, Buffer.from(document.contentBase64!, "base64").toString("utf8"), paths); }
    catch { return fail("unsafe Skill asset reference"); }
    if (!owned.has(file.path)) fail("unowned Skill asset");
  }
  for (const deletion of manifest.deletions.filter(item => item.type === "skills")) {
    if (!/^[A-Za-z0-9_-]+$/.test(deletion.itemId) || /^system$/i.test(deletion.itemId)
      || deletion.category === undefined || !/^(?:[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*)?$/.test(deletion.category)
      || /^system(?:\/|$)/i.test(deletion.category)
      || deletion.privacy !== (deletion.category && folders.has(deletion.category.split("/")[0]) ? "private" : "public"))
      fail("unsupported Skills deletion identity or privacy");
  }
}

function legacyBinding(globalStorage: string, root: string, targetId: string, policy: SyncTransportNativeHost["policy"],
  nativeGit?: SyncNativeGitProvider) {
  const syncDir = path.join(globalStorage, "github-sync");
  directory(globalStorage); directory(syncDir);
  const bytes = readRegular(path.join(syncDir, "targets.json"))!;
  let parsed: unknown;
  try { parsed = JSON.parse(bytes.toString("utf8")); } catch { return fail("invalid targets file"); }
  const raw = object(parsed);
  if (raw.schema !== 1 || !Array.isArray(raw.targets)) fail("unsupported targets file");
  const matches = raw.targets.filter(value => object(value).id === targetId);
  if (matches.length !== 1) fail("target identity is not unique");
  const target = object(matches[0]);
  const authentication = object(target.authentication);
  const baseline = target.lastSync === undefined ? undefined : object(target.lastSync);
  const expectedRepository = nativeGit?.options.repository ?? `https://github.com/${policy.owner}/${policy.repository}.git`;
  const expectedAuthentication = nativeGit?.options.authentication;
  if (target.repository !== expectedRepository || target.branch !== policy.branch
    || (expectedAuthentication ? authentication.method !== expectedAuthentication.method
      || authentication.method === "ssh" && authentication.identityFile !== (expectedAuthentication.method === "ssh" ? expectedAuthentication.identityFile : undefined)
      : authentication.method !== "vscode") || typeof authentication.expectedLogin !== "string"
    || authentication.expectedLogin.toLowerCase() !== policy.expectedLogin.toLowerCase()
    || baseline && (baseline.repository !== target.repository || baseline.branch !== target.branch
      || typeof baseline.storeRoot !== "string" || fs.realpathSync(baseline.storeRoot) !== root
      || !oid.safeParse(baseline.commit).success)) fail("legacy target, account or baseline differs");
  let skillsMount = false;
  if (target.skillsMount !== undefined) {
    const mount = object(target.skillsMount);
    if (mount.path !== "Skills" || mount.adoption !== "explicit"
      || Object.keys(mount).some(key => key !== "path" && key !== "adoption")) fail("legacy Skills mount requires review");
    skillsMount = true;
  }
  if (target.publication || !empty(target.pausedItems) || !empty(target.pendingDeletions)
    || !emptyEntityBases(baseline?.entityBases)) fail("legacy target requires review");
  const selection = validateSkillsSelection(target.selection, policy);
  if (skillsMount && (["public", "private"] as const).some(scope =>
    selection[scope].items.length || selection[scope].folders.length !== 1 || selection[scope].folders[0] !== ""))
    fail("legacy Skills mount selection requires review");
  for (const dir of ["checkouts", `checkouts/${targetId}`, `checkouts/${targetId}/transactions`,
    "coordinators", `coordinators/${hash(root)}`]) directory(path.join(syncDir, dir), true);
  const transactionBytes = readRegular(path.join(syncDir, "checkouts", targetId, "transactions", "latest.json"), true);
  let transaction: unknown;
  if (transactionBytes) {
    try { transaction = JSON.parse(transactionBytes.toString("utf8")); }
    catch { return fail("invalid transaction JSON"); }
  }
  let pendingPushed: { receiptSha256: string; baseCommit: string; pushedCommit: string; outbox: Array<{ entity: string; snapshot: string }> } | undefined;
  if (transaction !== undefined) {
    if (!baseline) fail("legacy transaction requires recovery");
    const receipt = object(transaction);
    if (receipt.schema !== 1 || !["recorded", "pushed"].includes(String(receipt.state)) || receipt.targetId !== targetId
      || receipt.repository !== target.repository || receipt.branch !== target.branch
      || typeof receipt.transactionId !== "string"
      || receipt.operation !== "sync" || !validRecordedOutbox(receipt.outbox)
      || !emptyEntityBases(receipt.entityBases))
      fail("legacy transaction requires recovery");
    if (receipt.state === "recorded") {
      if (receipt.pushedCommit !== baseline.commit) fail("legacy transaction requires recovery");
    } else {
      if (receipt.baseCommit !== baseline.commit || !uuid.safeParse(receipt.transactionId).success
        || typeof receipt.pushedAt !== "string" || !Number.isFinite(Date.parse(receipt.pushedAt))
        || !oid.safeParse(receipt.pushedCommit).success
        || receipt.preparedCommit !== receipt.pushedCommit || !Array.isArray(receipt.outbox) || !receipt.outbox.length)
        fail("legacy transaction requires recovery");
      pendingPushed = { receiptSha256: hash(transactionBytes!), baseCommit: String(receipt.baseCommit),
        pushedCommit: String(receipt.pushedCommit), outbox: receipt.outbox as Array<{ entity: string; snapshot: string }> };
    }
  }
  const coordinator = readJson(path.join(syncDir, "coordinators", hash(root), "coordinator.json"), true);
  if (coordinator !== undefined) {
    const state = object(coordinator);
    if (state.schema !== 1 || ["intents", "claims", "blocked"].some(key =>
      Object.keys(object(state[key] ?? {})).length)) fail("legacy coordinator requires recovery");
  }
  directory(path.join(syncDir, "conflicts"), true);
  if (directory(path.join(syncDir, "conflicts", targetId), true).length)
    fail("legacy conflict requires recovery");
  directory(path.join(syncDir, "content-repairs"), true);
  if (readRegular(path.join(syncDir, "content-repairs", `${targetId}.json`), true) !== undefined
    || directory(path.join(syncDir, "content-repairs", targetId), true).length)
    fail("legacy content repair requires recovery");
  const serviceRoot = path.join(globalStorage, "pkm-service");
  for (const service of directory(serviceRoot, true)) {
    directory(path.join(serviceRoot, service));
    const results = path.join(serviceRoot, service, "results");
    if (directory(results, true).length) fail("legacy service result requires recovery");
  }
  return { configHash: hash(bytes), selection, skillsMount, baseline: baseline ? String(baseline.commit) : undefined, expectedLogin: authentication.expectedLogin,
    target: { id: targetId, name: typeof target.name === "string" ? target.name : targetId,
      repository: expectedRepository, branch: String(target.branch), authentication: { method: String(authentication.method) } },
    transactionSha256: transactionBytes ? hash(transactionBytes) : undefined, pendingPushed };
}

function comparableFiles(manifest: SyncManifest, skills: boolean): string {
  return JSON.stringify(manifest.files.filter(item => (item.type === "skills") === skills)
    .map(({ path, type, itemId, member, category, privacy, digest }) => ({ path, type, itemId, member, category, privacy, digest }))
    .sort((a, b) => a.path.localeCompare(b.path)));
}

function validateInitialMountIdentities(local: SyncManifest, remote: SyncManifest): void {
  const identity = (contentBase64: string) => {
    const text = Buffer.from(contentBase64, "base64").toString("utf8");
    const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
    if (!frontmatter) fail("Skill identity requires frontmatter");
    return object(parseYaml(frontmatter[1])).knowledgeId;
  };
  const localDocs = local.files.filter(file => file.type === "skills" && file.member === "");
  const upstream = remote.files.filter(file => file.type === "skills" && file.member === "");
  for (const remoteFile of upstream) {
    const remoteId = identity(remoteFile.contentBase64!);
    for (const localFile of localDocs) {
      const localId = identity(localFile.contentBase64!);
      if (remoteFile.itemId.toLowerCase() === localFile.itemId.toLowerCase()
        || remoteFile.path.toLowerCase() === localFile.path.toLowerCase()
        || remoteId !== undefined && remoteId === localId) {
        if (remoteFile.itemId !== localFile.itemId || remoteFile.path !== localFile.path
          || remoteId !== undefined && localId !== undefined && remoteId !== localId)
          fail("initial Skills mount contains a name, path or knowledge identity collision");
      }
    }
  }
}

function verifyLegacyPushedOutbox(outbox: Array<{ entity: string; snapshot: string }>, manifest: SyncManifest): void {
  const seen = new Set<string>();
  for (const entry of outbox) {
    if (seen.has(entry.entity)) fail("legacy pushed outbox is ambiguous");
    seen.add(entry.entity);
    const members = manifest.files.filter(file => `${file.type}\0${file.itemId}` === entry.entity)
      .map(({ member, path, digest, category, privacy }) => ({ member, path, digest, category, privacy }))
      .sort((a, b) => a.member.localeCompare(b.member));
    let snapshot: unknown;
    try { snapshot = JSON.parse(entry.snapshot); } catch { return fail("legacy pushed outbox requires review"); }
    const parsed = z.array(z.strictObject({ member: z.string(), path: z.string(), digest: z.string().regex(/^[a-f0-9]{64}$/),
      category: z.string(), privacy: z.enum(["public", "private"]) })).safeParse(snapshot);
    if (!parsed.success || !members.length
      || JSON.stringify(parsed.data.sort((a, b) => a.member.localeCompare(b.member))) !== JSON.stringify(members))
      fail("legacy pushed outbox does not match the remote manifest");
  }
  if (new Set(manifest.files.map(file => `${file.type}\0${file.itemId}`)).size !== seen.size)
    fail("legacy pushed outbox is incomplete");
}

function legacyRecoveryReceipt(storage: Storage, key: {
  workspaceId: string; targetId: string; policyId: string; configHash: string;
  receiptSha256: string; baseCommit: string; pushedCommit: string;
}, write: boolean): boolean {
  storage.assertWorkspaceLease();
  const database = storage.connectNative();
  const values = [key.workspaceId, key.targetId, key.policyId, key.configHash,
    key.receiptSha256, key.baseCommit, key.pushedCommit];
  try {
    if (write) {
      database.exec("BEGIN IMMEDIATE");
      database.exec(`CREATE TABLE IF NOT EXISTS legacy_sync_recovery_receipts (
        workspace_id TEXT NOT NULL, target_id TEXT NOT NULL, policy_id TEXT NOT NULL,
        config_hash TEXT NOT NULL, receipt_hash TEXT NOT NULL, base_commit TEXT NOT NULL, pushed_commit TEXT NOT NULL,
        PRIMARY KEY (workspace_id, target_id, policy_id)
      )`);
      database.prepare(`INSERT OR IGNORE INTO legacy_sync_recovery_receipts
        (workspace_id,target_id,policy_id,config_hash,receipt_hash,base_commit,pushed_commit)
        VALUES (?,?,?,?,?,?,?)`).run(...values);
    }
    const present = database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='legacy_sync_recovery_receipts'").get();
    const matches = !!present && !!database.prepare(`SELECT 1 FROM legacy_sync_recovery_receipts
      WHERE workspace_id=? AND target_id=? AND policy_id=? AND config_hash=? AND receipt_hash=?
        AND base_commit=? AND pushed_commit=?`).get(...values);
    if (write) {
      if (!matches) fail("legacy recovery receipt conflicts with durable state");
      storage.assertWorkspaceLease(); database.exec("COMMIT");
    }
    return matches;
  } catch (error) {
    if (database.isTransaction) database.exec("ROLLBACK");
    throw error;
  } finally { database.close(); }
}

function localManifest(root: string, remote: SyncManifest, folders: Set<string>, allowPrivate: boolean,
  nativeTrash?: { storage: Storage; workspaceId: string }, base?: SyncManifest): SyncManifest {
  const files: SyncManifest["files"] = [];
  const assets = legacyMarkdownAssets();
  const deletions: SyncManifest["deletions"] = [];
  if (nativeTrash) {
    const database = nativeTrash.storage.connectNative();
    try {
      const history = readOriginalTrashDeletionHistory(database, nativeTrash.workspaceId);
      const records = new Map(history.records.map(record => [record.path, record.deletedAt]));
      const rows = database.prepare("SELECT * FROM migration_runtime_trash WHERE workspace_id=?").all(nativeTrash.workspaceId);
      const owned = new Set<string>();
      for (const row of rows) {
        const plan = assertNativeTrashRow(database, nativeTrash.workspaceId, root, row);
        if (plan.area !== "skills") continue;
        owned.add(plan.entryId);
        inspectTrashLifecycleEntry(root, plan);
        if (plan.targetKind !== "document") fail("folder Trash deletion requires review");
        const match = /^(?:(?<category>[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*)\/)?(?<item>[A-Za-z0-9_-]+)\.md$/.exec(plan.path);
        if (!match?.groups) fail("unsupported trashed Skill identity");
        const { item: itemId, category = "" } = match.groups;
        const deletedAt = records.get(`skills/${plan.path}`);
        if (deletedAt !== plan.deletedAt) fail("trashed Skill deletion history differs");
        const privacy = category && folders.has(category.split("/")[0]) ? "private" : "public";
        if (privacy === "private" && !allowPrivate) fail("private Skills require an authorized private selection");
        const upstream = [...remote.deletions, ...(base?.deletions ?? [])].find(item => item.type === "skills"
          && item.itemId === itemId && item.category === category && item.privacy === privacy);
        deletions.push(upstream ?? { type: "skills", itemId, category, privacy, deletedAt });
      }
      const trash = path.join(root, "skills", ".trash");
      for (const entry of directory(trash, true)) if (!owned.has(entry)) fail("unrecognized Skill Trash entry");
    } finally { database.close(); }
  }
  const walk = (category: string) => {
    for (const name of directory(path.join(root, "skills", category), true)) {
      if (!category && name === ".trash" && nativeTrash) continue;
      const full = path.join(root, "skills", category, name);
      const stat = fs.lstatSync(full);
      if (stat.isDirectory() && !stat.isSymbolicLink() && assets.isMarkdownAssetDirectory(name)) continue;
      if (!/^[A-Za-z0-9_-]+(?:\.md)?$/.test(name) || /^system(?:\.md)?$/i.test(name)) fail("unsupported local Skills layout");
      if (stat.isDirectory() && !stat.isSymbolicLink() && !name.endsWith(".md")) {
        walk(category ? `${category}/${name}` : name);
        continue;
      }
      if (!name.endsWith(".md")) fail("unsupported local Skills layout");
      const data = readRegular(full)!;
      const itemId = name.slice(0, -3);
      validateSkillContent(itemId, data);
      const privacy = category && folders.has(category.split("/")[0]) ? "private" : "public";
      if (privacy === "private" && !allowPrivate) fail("private Skills require an authorized private selection");
      files.push({ path: `skills/${category ? `${category}/` : ""}${name}`, type: "skills", itemId,
        member: "", category, privacy, digest: hash(data), contentBase64: data.toString("base64") });
      for (const asset of assets.listedMarkdownAssets(root, "skills", `${category ? `${category}/` : ""}${name}`, data.toString("utf8"))) {
        const parts = asset.path.split("/");
        if (parts.some(part => !part || part === "." || part === "..")) fail("unsafe Skill asset path");
        let current = path.join(root, "skills");
        for (const part of parts.slice(0, -1)) {
          current = path.join(current, part);
          const member = fs.lstatSync(current);
          if (!member.isDirectory() || member.isSymbolicLink()) fail("unsafe Skill asset directory");
        }
        const content = readRegular(path.join(root, "skills", ...parts))!;
        const assetPath = `skills/${asset.path}`;
        files.push({ path: assetPath, type: "skills", itemId, member: assetPath, category, privacy,
          digest: hash(content), contentBase64: content.toString("base64") });
      }
    }
  };
  walk("");
  const manifest = syncPlanManifestSchema.parse({ ...remote,
    files: [...remote.files.filter(file => file.type !== "skills"), ...files],
    deletions: [...remote.deletions.filter(item => item.type !== "skills"), ...deletions] });
  safeSkills(manifest, folders);
  return manifest;
}

function writeJournal(file: string, journal: Journal, fault?: (point: string) => void): void {
  const parent = path.dirname(file);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  directory(parent);
  const staging = `${file}.${randomUUID()}.staging`;
  let fd: number | undefined;
  try {
    fd = fs.openSync(staging, "wx", 0o600);
    fs.writeFileSync(fd, JSON.stringify(journalSchema.parse(journal)) + "\n");
    fault?.("journal-written");
    fs.fsyncSync(fd);
    fault?.("journal-synced");
    fs.closeSync(fd); fd = undefined;
    fs.renameSync(staging, file);
    fault?.("journal-renamed");
    const dir = fs.openSync(parent, "r");
    try { fault?.("journal-before-directory-sync"); fs.fsyncSync(dir); fault?.("journal-directory-synced"); }
    finally { fs.closeSync(dir); }
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    fs.rmSync(staging, { force: true });
  }
}

/**
 * Explicit isolated-experiment host; never enabled by CLI or extension activation.
 * The caller must exclusively control the synthetic root and all legacy writers.
 */
export async function openExperimentalLegacySyncHost(options: {
  mode: "isolated-experiment";
  storage: Storage;
  globalStorage: string;
  targetId: string;
  actorId: string;
  transport: Omit<SyncTransportNativeHost, "readSecret">;
  publisherPolicy: { policyId: string; enforcement: "all-repository-ref-writers" | "atomic-git-lease" };
  experimentalNativeTrash?: true;
  experimentalFaultInjector?: (point: string) => void;
  readSecret(key: string, signal: AbortSignal): PromiseLike<string | undefined>;
}) {
  if (options.mode !== "isolated-experiment" || !/^[A-Za-z0-9._-]+$/.test(options.targetId)
    || options.experimentalFaultInjector && !options.experimentalNativeTrash
    || options.targetId === "." || options.targetId === ".."
    || !(options.publisherPolicy?.enforcement === "all-repository-ref-writers" && !options.transport.nativeGit
      || options.publisherPolicy?.enforcement === "atomic-git-lease" && !!options.transport.nativeGit)
    || options.publisherPolicy.policyId !== options.transport.policy.policyId) fail("invalid experimental binding");
  const root = fs.realpathSync(options.storage.workspaceRoot());
  const globalStorage = fs.realpathSync(options.globalStorage);
  const withTargetLock = legacyTargetLock();
  const binding = legacyBinding(globalStorage, root, options.targetId, options.transport.policy, options.transport.nativeGit);
  if (options.transport.repositoryLayout && !binding.skillsMount) fail("repository layout differs from the legacy target");
  const workspaceId = await options.storage.workspaceId();
  const journalPath = path.join(globalStorage, "github-sync", "experimental-next", `${options.targetId}.json`);
  directory(path.dirname(journalPath), true);
  const existing = readJson(journalPath, true);
  let journal: Journal = existing === undefined ? {
    schema: "pkm.experimental-legacy-sync/v1", workspaceId, configHash: binding.configHash,
    targetId: options.targetId, policyId: options.transport.policy.policyId,
    ...(binding.baseline ? { baseline: binding.baseline } : {}), phase: binding.baseline ? "idle" : "initial",
  } : journalSchema.parse(existing);
  if (journal.workspaceId !== workspaceId || journal.configHash !== binding.configHash
    || journal.targetId !== options.targetId || journal.policyId !== options.transport.policy.policyId)
    fail("saved experimental state does not match the legacy binding");
  if ((journal.trashMoves?.length || journal.trashRestores?.length)
    && (!options.experimentalNativeTrash || !journal.sessionId || !["applying", "publishing", "review"].includes(journal.phase)))
    fail("saved Sync Trash operations require their original recovery context");
  if (binding.pendingPushed) {
    if (journal.legacyRecovery) {
      if (journal.legacyRecovery.receiptSha256 !== binding.pendingPushed.receiptSha256
        || journal.legacyRecovery.baseCommit !== binding.pendingPushed.baseCommit
        || journal.legacyRecovery.pushedCommit !== binding.pendingPushed.pushedCommit)
        fail("legacy recovery receipt does not match");
      if (!legacyRecoveryReceipt(options.storage, { workspaceId, targetId: options.targetId,
        policyId: journal.policyId, configHash: binding.configHash, ...journal.legacyRecovery }, false))
        fail("legacy recovery has no durable native receipt");
    } else if (existing !== undefined || journal.baseline !== binding.baseline)
      fail("legacy transaction requires explicit recovery");
  } else if (journal.legacyRecovery) fail("legacy recovery source changed");
  const readSecret = legacyVscodeSyncCredentialReader({
    targetId: options.targetId, expectedLogin: binding.expectedLogin, secretRef: options.transport.policy.secretRef,
    readSecret: options.readSecret,
  });
  const check = () => {
    assertNoPendingLegacySkillDeletions(root);
    const current = legacyBinding(globalStorage, root, options.targetId, options.transport.policy, options.transport.nativeGit);
    if (current.configHash !== journal.configHash || current.transactionSha256 !== binding.transactionSha256)
      fail("legacy configuration changed");
    if (journal.privacyHash && privacyState(root).digest !== journal.privacyHash)
      fail("legacy privacy policy changed");
  };
  const native = await createNativeRuntime({ storage: options.storage,
    ...(options.experimentalNativeTrash ? { trash: { layoutVersion: "pkm.trash-lifecycle/v1" as const,
      ...(options.experimentalFaultInjector ? { faultInjector: options.experimentalFaultInjector } : {}) } } : {}),
    remote: {
    authorize: async actor => actor === options.actorId,
    sync: { ...options.transport, ...(binding.skillsMount ? { repositoryLayout: "skills-mount" as const } : {}),
      readSecret, assertPublicationAuthority: () => {
      check();
      options.transport.assertPublicationAuthority?.();
    } },
    publisherPolicy: options.publisherPolicy,
  } });
  const remote = native.services.remote!;
  const snapshotLocal = (remoteManifest: SyncManifest, folders: Set<string>, base?: SyncManifest) =>
    options.storage.withWorkspaceExclusive(() => localManifest(root, remoteManifest, folders,
      options.transport.policy.allowPrivate, options.experimentalNativeTrash ? { storage: options.storage, workspaceId } : undefined, base));
  try {
    if (journal.baselineOperationId) {
      const evidence = await remote.status(options.actorId, journal.baselineOperationId);
      const result = evidence?.result as { state?: string; commit?: string } | null;
      if (evidence?.kind !== "remote.sync.publish" || evidence.state !== "complete"
        || result?.state !== "published" || result.commit !== journal.baseline)
        fail("experimental baseline receipt does not match");
    } else if (journal.baseline !== (journal.legacyRecovery?.pushedCommit ?? binding.baseline))
      fail("experimental baseline has no receipt");
  } catch (error) {
    await native.close();
    throw error;
  }
  const save = (next: Journal) => {
    writeJournal(journalPath, next, point => {
      options.experimentalFaultInjector?.(point);
      if (next.trashMoves?.length || next.trashRestores?.length) options.experimentalFaultInjector?.(`trash-${point}`);
    });
    journal = next;
  };
  const inspectComparison = async () => {
    if (!journal.sessionId || !["comparison", "conflict"].includes(journal.phase)) fail("no comparison to inspect");
    const stored = await remote.inspectSession(options.actorId, journal.sessionId);
    const conflicts = stored.session.plan.conflicts.map(({ id, type, itemId, reason }) => ({ id, type, itemId, reason }));
    if (JSON.stringify(conflicts) !== JSON.stringify(journal.conflicts ?? [])) fail("comparison evidence differs");
    return stored;
  };
  const recoverableRemovals = async (sessionId: string) => {
    const stored = await remote.inspectSession(options.actorId, sessionId);
    const selected = new Map(stored.session.plan.proposals.map(proposal =>
      [`${proposal.type}\0${proposal.itemId}`, proposal.state] as const));
    for (const conflict of stored.session.plan.conflicts) {
      const decision = stored.session.decisions.filter(value => value.conflictId === conflict.id)
        .sort((a, b) => b.revision - a.revision)[0];
      if (!decision || (decision.choice !== "local" && decision.choice !== "remote"))
        fail("unresolved or unsupported Skills decision");
      selected.set(`${conflict.type}\0${conflict.itemId}`, conflict[decision.choice]);
    }
    const groups = new Map<string, typeof stored.input.local.manifest.files>();
    for (const file of stored.input.local.manifest.files.filter(value => value.type === "skills")) {
      const state = selected.get(`${file.type}\0${file.itemId}`);
      if (state && (state.kind !== "live" || !state.files.some(member => member.path === file.path))) {
        if (!options.experimentalNativeTrash || state.kind !== "deleted")
          fail("Skill or asset removal requires recoverable Trash integration");
        const group = groups.get(file.itemId) ?? [];
        group.push(file); groups.set(file.itemId, group);
      }
    }
    const removals = [...groups.values()].map(files => {
      const document = files.find(file => !file.member);
      if (!document || files.some(file => file.member && !file.path.startsWith(document.path.slice(0, -3) + ".assets/")))
        fail("Skill deletion has unsupported or unpaired assets");
      return { path: document.path.slice("skills/".length), digest: document.digest, files };
    }).sort((a, b) => a.path.localeCompare(b.path));
    const restores = stored.input.local.manifest.deletions.filter(item => item.type === "skills")
      .flatMap(item => {
        const state = selected.get(`skills\0${item.itemId}`);
        if (!state || state.kind !== "live") return [];
        if (!options.experimentalNativeTrash) fail("Skill restore requires recoverable Trash integration");
        return [{ itemId: item.itemId, files: state.files }];
      });
    return { removals, restores };
  };
  const moveDeletedSkills = async (sessionId: string) => {
    const { removals, restores } = await recoverableRemovals(sessionId);
    const stored = await remote.inspectSession(options.actorId, sessionId);
    if ((journal.trashMoves ?? []).some(move => !removals.some(item => item.path === move.path))
      || new Set((journal.trashMoves ?? []).map(move => move.path)).size !== (journal.trashMoves ?? []).length)
      fail("saved Sync Trash operations differ from the selected deletions");
    for (const item of removals) {
      let move = journal.trashMoves?.find(value => value.path === item.path);
      if (!move) {
        const preview = await options.storage.withWorkspaceExclusive(() => {
          options.storage.assertWorkspaceLease(); check();
          const privacy = privacyState(root);
          const current = localManifest(root, stored.input.local.manifest, privacy.folders, options.transport.policy.allowPrivate,
            { storage: options.storage, workspaceId }, stored.input.base.manifest);
          const actual = current.files.filter(file => file.type === "skills" && file.itemId === item.files[0]!.itemId)
            .map(file => [file.path, file.digest]).sort();
          const expected = item.files.map(file => [file.path, file.digest]).sort();
          if (JSON.stringify(actual) !== JSON.stringify(expected)) fail("Skill or assets changed before recoverable deletion");
          return previewTrashLifecycle(root, { area: "skills", path: item.path, kind: "document" });
        });
        if (preview.documents.length !== 1 || preview.documents[0]?.path !== item.path
          || preview.documents[0]?.sha256 !== item.digest) fail("Skill changed before recoverable deletion");
        move = { path: item.path, operationId: randomUUID(), expectedTreeSha256: preview.treeSha256,
          expectedScanRevision: preview.scanRevision };
        save({ ...journal, trashMoves: [...journal.trashMoves ?? [], move] });
        options.experimentalFaultInjector?.("bridge-intent");
      }
      const result = trashLifecycleDefinitions[1].output.parse(await native.services.migration.mutate({ operation: "knowledge.trash.move",
        actorId: options.actorId, args: { area: "skills", path: move.path, kind: "document",
          operationId: move.operationId, expectedTreeSha256: move.expectedTreeSha256,
          expectedScanRevision: move.expectedScanRevision, entryIdFormat: "original" } }));
      if (result.action !== "trash" || result.operationId !== move.operationId
        || result.area !== "skills" || result.path !== move.path) fail("Sync Trash receipt differs");
      check();
      options.experimentalFaultInjector?.("bridge-moved");
      await options.storage.withWorkspaceExclusive(() => {
        const database = options.storage.connectNative();
        try {
          const row = database.prepare("SELECT * FROM migration_runtime_trash WHERE entry_id=?").get(result.entryId);
          if (!row) fail("Sync Trash receipt lost its entry");
          const plan = assertNativeTrashRow(database, workspaceId, root, row);
          inspectTrashLifecycleEntry(root, plan);
          const actual = plan.moves.flatMap(part => part.entries.filter(entry => entry.kind === "file")
            .map(entry => [`skills/${part.originalPath}${entry.path ? `/${entry.path}` : ""}`, entry.sha256])).sort();
          const expected = item.files.map(file => [file.path, file.digest]).sort();
          if (JSON.stringify(actual) !== JSON.stringify(expected)) fail("Sync Trash receipt lost pinned members");
        } finally { database.close(); }
      });
    }
    if ((journal.trashRestores ?? []).some(value => !restores.some(item => item.itemId === value.itemId))
      || new Set((journal.trashRestores ?? []).map(value => value.itemId)).size !== (journal.trashRestores ?? []).length)
      fail("saved Sync Trash operations differ from the selected restorations");
    for (const item of restores) {
      let restore = journal.trashRestores?.find(value => value.itemId === item.itemId);
      if (!restore) {
        const preview = await options.storage.withWorkspaceExclusive(() => {
          options.storage.assertWorkspaceLease(); check();
          const database = options.storage.connectNative();
          try {
            const rows = database.prepare("SELECT * FROM migration_runtime_trash WHERE workspace_id=?").all(workspaceId);
            const plans = rows.map(row => assertNativeTrashRow(database, workspaceId, root, row))
              .filter(plan => plan.area === "skills" && plan.targetKind === "document"
                && path.posix.basename(plan.path, ".md") === item.itemId);
            if (plans.length !== 1) fail("Skill restore requires one exact Trash entry");
            const plan = plans[0]!;
            inspectTrashLifecycleEntry(root, plan);
            const actual = plan.moves.flatMap(part => part.entries.filter(entry => entry.kind === "file")
              .map(entry => [`skills/${part.originalPath}${entry.path ? `/${entry.path}` : ""}`, entry.sha256])).sort();
            const expected = item.files.map(file => [file.path, file.digest]).sort();
            if (JSON.stringify(actual) !== JSON.stringify(expected)) fail("remote restore differs from retained Trash bytes");
            return { entryId: plan.entryId, expectedScanRevision: previewTrashRestoreRevision(root) };
          } finally { database.close(); }
        });
        restore = { ...preview, itemId: item.itemId, operationId: randomUUID() };
        save({ ...journal, trashRestores: [...journal.trashRestores ?? [], restore] });
        options.experimentalFaultInjector?.("restore-intent");
      }
      const result = trashLifecycleDefinitions[2].output.parse(await native.services.migration.mutate({
        operation: "knowledge.trash.restore", actorId: options.actorId,
        args: { operationId: restore.operationId, entryId: restore.entryId, expectedScanRevision: restore.expectedScanRevision } }));
      if (result.action !== "restore" || result.operationId !== restore.operationId || result.entryId !== restore.entryId
        || result.area !== "skills") fail("Sync Trash restore receipt differs");
      check();
      options.experimentalFaultInjector?.("bridge-restored");
      await options.storage.withWorkspaceExclusive(() => {
        const database = options.storage.connectNative();
        try {
          const origin = readNativeTrashOrigins(database, workspaceId).get(restore!.entryId);
          if (!origin || origin.path !== result.path) fail("Sync restore lost its original Trash receipt");
          const actual = origin.moves.flatMap(part => part.entries.filter(entry => entry.kind === "file")
            .map(entry => [`skills/${part.originalPath}${entry.path ? `/${entry.path}` : ""}`, entry.sha256])).sort();
          const expected = item.files.map(file => [file.path, file.digest]).sort();
          if (JSON.stringify(actual) !== JSON.stringify(expected)) fail("Sync restore lost pinned members");
        } finally { database.close(); }
      });
    }
  };
  const recheckComparison = async () => {
    check();
    const stored = await inspectComparison();
    const current = await remote.pin(options.actorId);
    if (current.pin.commit !== stored.pin.commit || current.pin.manifestHash !== stored.pin.manifestHash)
      fail("comparison branch advanced");
    const privacy = privacyState(root);
    safeSkills(current.pin.manifest, privacy.folders);
    const local = await snapshotLocal(current.pin.manifest, privacy.folders, stored.input.base.manifest);
    if (binding.skillsMount) validateInitialMountIdentities(local, current.pin.manifest);
    const projected = projectSkillsOnlySyncInput({
      base: stored.input.base, local: { manifest: local, sha256: syncPlanHash(local) },
      remote: { manifest: current.pin.manifest, sha256: current.pin.manifestHash },
    }, member => selectedSkill(binding.selection, member));
    if (projected.input.local.sha256 !== stored.input.local.sha256) fail("comparison local Skills changed");
    check();
    return stored;
  };
  const compareInitial = async () => {
    if (journal.phase !== "initial" || journal.baseline) fail("initial comparison is not available");
    check();
    const current = await remote.pin(options.actorId);
    const privacy = privacyState(root);
    safeSkills(current.pin.manifest, privacy.folders);
    const local = await snapshotLocal(current.pin.manifest, privacy.folders);
    if (binding.skillsMount) validateInitialMountIdentities(local, current.pin.manifest);
    const base: SyncManifest = { ...current.pin.manifest,
      files: current.pin.manifest.files.filter(file => file.type !== "skills"),
      deletions: current.pin.manifest.deletions.filter(item => item.type !== "skills") };
    const project = projectSkillsOnlySyncInput({
      base: { manifest: base, sha256: syncPlanHash(base) },
      local: { manifest: local, sha256: syncPlanHash(local) },
      remote: { manifest: current.pin.manifest, sha256: current.pin.manifestHash },
    }, member => selectedSkill(binding.selection, member));
    check();
    const sessionId = randomUUID();
    const session = await remote.plan(options.actorId, { operationId: randomUUID(), sessionId,
      pinId: current.pinId, base: project.input.base, local: project.input.local });
    if (privacyState(root).digest !== privacy.digest) fail("legacy privacy policy changed");
    const conflicts = session.plan.conflicts.map(({ id, type, itemId, reason }) => ({ id, type, itemId, reason }));
    save({ ...journal, phase: "comparison", sessionId, conflicts, privacyHash: privacy.digest });
    return { state: "comparison" as const, commit: current.pin.commit, session };
  };
  const resumeUnsafe = async () => {
    check();
    if (binding.pendingPushed && !journal.legacyRecovery) {
      if (journal.phase !== "idle" || journal.baseline !== binding.baseline) fail("legacy pushed transaction requires review");
      const current = await remote.pin(options.actorId);
      if (current.pin.commit !== binding.pendingPushed.pushedCommit) fail("legacy pushed branch advanced");
      const base = await remote.readHistoricalBase(options.actorId, binding.pendingPushed.baseCommit);
      const privacy = privacyState(root);
      safeSkills(current.pin.manifest, privacy.folders); safeSkills(base.manifest, privacy.folders);
      const local = await snapshotLocal(current.pin.manifest, privacy.folders, base.manifest);
      if (comparableFiles(local, true) !== comparableFiles(current.pin.manifest, true)
        || comparableFiles(base.manifest, false) !== comparableFiles(current.pin.manifest, false)
        || JSON.stringify(base.manifest.deletions.filter(item => item.type !== "skills"))
          !== JSON.stringify(current.pin.manifest.deletions.filter(item => item.type !== "skills")))
        fail("legacy pushed local effects require review");
      verifyLegacyPushedOutbox(binding.pendingPushed.outbox, current.pin.manifest);
      check();
      const confirmation = await remote.pin(options.actorId);
      if (confirmation.pin.commit !== current.pin.commit || confirmation.pin.manifestHash !== current.pin.manifestHash)
        fail("legacy pushed branch advanced");
      check();
      if (privacyState(root).digest !== privacy.digest) fail("legacy privacy policy changed");
      const legacyRecovery = {
        receiptSha256: binding.pendingPushed.receiptSha256, baseCommit: binding.pendingPushed.baseCommit,
        pushedCommit: binding.pendingPushed.pushedCommit,
      };
      legacyRecoveryReceipt(options.storage, { workspaceId, targetId: options.targetId,
        policyId: journal.policyId, configHash: binding.configHash, ...legacyRecovery }, true);
      save({ ...journal, baseline: binding.pendingPushed.pushedCommit, legacyRecovery });
      return { state: "legacy-pushed-recovered" as const, commit: binding.pendingPushed.pushedCommit };
    }
    if (journal.phase === "initial") return { state: "initial" as const };
    if (journal.phase === "comparison") {
      const stored = await inspectComparison();
      return { state: "comparison" as const, commit: stored.pin.commit, session: stored.session };
    }
    if (journal.phase === "conflict") return { state: "conflict" as const, conflicts: journal.conflicts ?? [] };
    if (journal.phase === "review") return { state: "review" as const };
    if (journal.phase === "applying") {
      if (!journal.sessionId || !journal.applyOperationId || !journal.publishOperationId) fail("invalid apply recovery");
      await moveDeletedSkills(journal.sessionId);
      const receipt = await remote.apply(options.actorId, { operationId: journal.applyOperationId, sessionId: journal.sessionId });
      options.experimentalFaultInjector?.("sync-applied");
      save({ ...journal, phase: "publishing", applyId: receipt.applyId });
    }
    if (journal.phase === "publishing") {
      if (!journal.sessionId || !journal.publishOperationId || !journal.applyId) fail("invalid publication recovery");
      check();
      const status = await remote.status(options.actorId, journal.publishOperationId);
      let result;
      if (!status) result = await remote.publish(options.actorId, {
        operationId: journal.publishOperationId, sessionId: journal.sessionId, stagedReceiptId: journal.applyId,
      });
      else if (status.state === "complete") result = status.result as { state: string; commit?: string };
      else if (status.result) result = await remote.reconcile(options.actorId, journal.publishOperationId);
      else { save({ ...journal, phase: "review" }); return { state: "review" as const }; }
      if (result.state !== "published" || !oid.safeParse(result.commit).success) {
        save({ ...journal, phase: "review" });
        return { state: "review" as const };
      }
      save({ schema: journal.schema, workspaceId, configHash: binding.configHash,
        targetId: options.targetId, policyId: journal.policyId, baseline: result.commit!,
        baselineOperationId: journal.publishOperationId, phase: "idle",
        ...(journal.legacyRecovery ? { legacyRecovery: journal.legacyRecovery } : {}) });
      return { state: "published" as const, commit: result.commit! };
    }
    if (!journal.baseline) fail("saved baseline is missing");
    return { state: "idle" as const, baseline: journal.baseline };
  };
  let busy = false;
  const exclusive = async <T>(work: () => Promise<T>): Promise<T> => {
    if (busy) fail("another operation is active");
    busy = true;
    try {
      return await withTargetLock(path.join(globalStorage, "github-sync", "targets-state.lock"),
        "Experimental legacy Sync", 10 * 60_000, async () => {
          options.storage.assertWorkspaceLease();
          return await work();
        });
    } finally { busy = false; }
  };
  return {
    sync: () => exclusive(async () => {
      if (binding.pendingPushed && !journal.legacyRecovery) fail("legacy transaction requires explicit recovery");
      if (journal.phase === "initial") return compareInitial();
      if (journal.phase !== "idle") return resumeUnsafe();
      if (!journal.baseline) fail("saved baseline is missing");
      check();
      const current = await remote.pin(options.actorId);
      const base = await remote.readHistoricalBase(options.actorId, journal.baseline);
      const privacy = privacyState(root);
      safeSkills(current.pin.manifest, privacy.folders); safeSkills(base.manifest, privacy.folders);
      const local = await snapshotLocal(current.pin.manifest, privacy.folders, base.manifest);
      const project = projectSkillsOnlySyncInput({
        base: { manifest: base.manifest, sha256: base.manifestHash },
        local: { manifest: local, sha256: syncPlanHash(local) },
        remote: { manifest: current.pin.manifest, sha256: current.pin.manifestHash },
      }, member => selectedSkill(binding.selection, member));
      check();
      const sessionId = randomUUID();
      const session = await remote.plan(options.actorId, {
        operationId: randomUUID(), sessionId, pinId: current.pinId,
        base: project.input.base, local: project.input.local,
      });
      if (privacyState(root).digest !== privacy.digest) fail("legacy privacy policy changed");
      if (session.plan.conflicts.length) {
        const conflicts = session.plan.conflicts.map(({ id, type, itemId, reason }) => ({ id, type, itemId, reason }));
        save({ ...journal, phase: "conflict", sessionId, conflicts, privacyHash: privacy.digest });
        return { state: "conflict" as const, conflicts };
      }
      await recoverableRemovals(sessionId);
      save({ ...journal, phase: "applying", sessionId, applyOperationId: randomUUID(), publishOperationId: randomUUID(), privacyHash: privacy.digest });
      return resumeUnsafe();
    }),
    resume: () => exclusive(resumeUnsafe),
    inspectComparison: () => exclusive(async () => {
      const stored = await inspectComparison();
      return { commit: stored.pin.commit, session: stored.session };
    }),
    decide: (request: { sessionId: string; operationId: string; expectedRevision: number; conflictId: string;
      choice: "local" | "remote"; reason: string }) => exclusive(async () => {
      if (request.sessionId !== journal.sessionId) fail("comparison session differs");
      if (request.choice !== "local" && request.choice !== "remote") fail("unsupported conflict choice");
      await recheckComparison();
      return remote.decide(options.actorId, request);
    }),
    confirmComparison: (sessionId: string) => exclusive(async () => {
      if (sessionId !== journal.sessionId) fail("comparison session differs");
      const { session } = await recheckComparison();
      const resolved = new Set(session.decisions.map(decision => decision.conflictId));
      if (session.plan.conflicts.some(conflict => !resolved.has(conflict.id))) fail("comparison has unresolved conflicts");
      await recoverableRemovals(sessionId);
      save({ ...journal, phase: "applying", applyOperationId: randomUUID(), publishOperationId: randomUUID() });
      return resumeUnsafe();
    }),
    discardComparison: (sessionId: string) => exclusive(async () => {
      if (sessionId !== journal.sessionId || !["comparison", "conflict"].includes(journal.phase))
        fail("comparison session differs");
      check();
      const next: Journal = { schema: journal.schema, workspaceId, configHash: binding.configHash,
        targetId: options.targetId, policyId: journal.policyId,
        ...(journal.baseline ? { baseline: journal.baseline } : {}),
        ...(journal.baselineOperationId ? { baselineOperationId: journal.baselineOperationId } : {}),
        ...(journal.legacyRecovery ? { legacyRecovery: journal.legacyRecovery } : {}),
        phase: journal.baseline ? "idle" : "initial" };
      save(next);
      return { state: next.phase };
    }),
    status() { check(); return { phase: journal.phase, baseline: journal.baseline, conflicts: journal.conflicts ?? [],
      target: binding.target }; },
    close: () => native.close(),
  };
}
