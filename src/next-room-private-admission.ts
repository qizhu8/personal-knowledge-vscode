import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync,
  readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Storage } from "./storage.js";
import { inspectLegacyChatroomArchive, type LegacyChatroomFile } from "./legacy-chatroom-continuation.js";
import { inspectRetainedMeetingSource } from "./next-room-meeting-source.js";
import { checkedDocumentPath } from "./document-path.js";
import { acquireLinuxRootWriterFence, type LinuxRootWriterFence } from "./linux-root-writer-fence.js";
import { renameNoReplaceSync } from "./rename-no-replace.js";

const area = ".pkm-room-admission", schema = "pkm.private-room-admission/v1";
const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const hash = (value: unknown) => sha(JSON.stringify(value));
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
type Pin = LegacyChatroomFile & { uid: number; ctimeMs: number };
type Identity = { dev: number; ino: number };
type Plan = {
  schema: typeof schema; intentId: string; root: string; workspaceId: string; rootIdentity: Identity; marker: Pin;
  roomId: string; sourceRoot: string; sourceIdentity: Identity; sourceFingerprint: string;
  sourcePrivate?: false;
  meetingHash: string; files: Pin[];
  notes: { id: string; path: string; file: Pin | null }[];
};
type Stage = { planHash: string; sourceFingerprint: string; files: Pin[]; notes: (Pin | null)[] };
type Entry = { plan: Plan; stageHash: string | null };
type Index = { schema: typeof schema; entries: Entry[] };
export type PrivateRoomAdmissionBinding = Readonly<{
  root: string; workspaceId: string; roomId: string; sourceRoot: string; sourceFingerprint: string;
  meetingHash: string; operation: "admit" | "recover" | "use";
}>;
export type PrivateRoomAdmissionOptions = {
  sourcePrivate?: false;
  profile: { get(key: string): Promise<string | undefined>; store(key: string, value: string): Promise<void> };
  credentials: { verifyHost(roomId: string, hash: string): Promise<boolean>;
    load(roomId: string): Promise<{ hostCredential: string; hostCredentialHash: string } | undefined> };
  assertAuthority(): void;
  authorize(binding: PrivateRoomAdmissionBinding): Promise<boolean>;
  checkpoint?(phase: "prepared" | "staged" | "published" | "committed"): void;
};
const policies = new WeakMap<Storage, PrivateRoomAdmissionOptions>();
function fail(message: string): never { throw new Error(`PRIVATE_ROOM_ADMISSION_BLOCKED: ${message}`); }
function directory(file: string, privateMode = true): Identity {
  const stat = lstatSync(file);
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(file) !== file
    || stat.uid !== process.getuid?.() || privateMode && (stat.mode & 0o077) !== 0)
    fail("Directory identity/ownership/privacy changed.");
  return { dev: stat.dev, ino: stat.ino };
}
function bytes(file: string, privateMode: boolean): { pin: Pin; bytes: Buffer } {
  const before = lstatSync(file);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > 33_554_432
    || before.uid !== process.getuid?.() || privateMode && (before.mode & 0o077) !== 0)
    fail("Source/receipt must be a bounded owned regular file, not a link.");
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let data: Buffer;
  try {
    const opened = fstatSync(fd);
    if (opened.dev !== before.dev || opened.ino !== before.ino) fail("File changed before read.");
    data = readFileSync(fd);
  } finally { closeSync(fd); }
  const after = lstatSync(file);
  if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size
    || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs || after.mode !== before.mode)
    fail("File changed during read.");
  return { bytes: data, pin: { path: "", sha256: sha(data), size: before.size, mode: before.mode & 0o777,
    dev: before.dev, ino: before.ino, mtimeMs: before.mtimeMs, ctimeMs: before.ctimeMs, uid: before.uid } };
}
function pin(root: string, path: string, privateMode = false): Pin {
  return { ...bytes(join(root, path), privateMode).pin, path };
}
function same(a: unknown, b: unknown): boolean { return JSON.stringify(a) === JSON.stringify(b); }
function source(plan: Plan) {
  if (!same(directory(plan.sourceRoot, plan.sourcePrivate !== false), plan.sourceIdentity)) fail("Original source root identity changed.");
  const archive = inspectLegacyChatroomArchive(plan.sourceRoot, plan.roomId);
  const meetings = inspectRetainedMeetingSource(plan.sourceRoot, plan.roomId);
  const files = archive.files.map(file => pin(plan.sourceRoot, file.path));
  const notes = meetings.notes.map(note => ({ id: String(note.id), path: String(note.path),
    file: note.body === null ? null : pin(plan.sourceRoot, relative(plan.sourceRoot,
      checkedDocumentPath(plan.sourceRoot, note.path, false)).split(sep).join("/")) }));
  if (archive.sourceFingerprint !== plan.sourceFingerprint || meetings.hash !== plan.meetingHash
    || !same(files, plan.files) || !same(notes, plan.notes))
    fail("Original Room/Note source changed; preserve both versions.");
  return { archive, meetings };
}
function rootIdentity(plan: Plan) {
  if (resolve(plan.root) !== plan.root || !same(directory(plan.root), plan.rootIdentity)
    || !same(pin(plan.root, ".pkm-next-workspace", true), plan.marker))
    fail("Target root/marker identity changed.");
  const marker = JSON.parse(bytes(join(plan.root, ".pkm-next-workspace"), true).bytes.toString("utf8"));
  if (marker.schema !== "pkm.next-workspace/v2" || marker.id !== plan.workspaceId) fail("Workspace identity changed.");
}
function key(workspaceId: string) { return `personalKnowledge.next.privateRoomAdmission.v1.${workspaceId}`; }
function stageKey(plan: Plan) { return `personalKnowledge.next.privateRoomAdmissionStage.v1.${plan.workspaceId}.${plan.intentId}`; }
async function index(options: PrivateRoomAdmissionOptions, workspaceId: string): Promise<Index> {
  const raw = await options.profile.get(key(workspaceId));
  if (raw === undefined) return { schema, entries: [] };
  if (Buffer.byteLength(raw) > 16_777_216) fail("Oversized private profile admission index.");
  const value = JSON.parse(raw) as Index;
  if (value?.schema !== schema || !Array.isArray(value.entries) || value.entries.length > 32
    || new Set(value.entries.map(entry => entry.plan?.roomId)).size !== value.entries.length)
    fail("Malformed private profile admission index.");
  for (const entry of value.entries) {
    const plan = entry.plan;
    if (!plan || plan.schema !== schema || !uuid.test(plan.intentId) || plan.workspaceId !== workspaceId
      || !/^[A-Za-z0-9_-]{6,80}$/.test(plan.roomId) || !isAbsolute(plan.root) || !isAbsolute(plan.sourceRoot)
      || !Array.isArray(plan.files) || !Array.isArray(plan.notes) || plan.sourcePrivate !== undefined && plan.sourcePrivate !== false
      || entry.stageHash !== null && !/^[a-f0-9]{64}$/.test(entry.stageHash))
      fail("Invalid private profile admission binding.");
    const staged = await options.profile.get(stageKey(plan));
    if (staged !== undefined) {
      if (!/^[a-f0-9]{64}$/.test(staged) || entry.stageHash !== null && entry.stageHash !== staged)
        fail("Independent immutable stage pin conflicts.");
      entry.stageHash = staged;
    }
  }
  return value;
}
async function saveStage(options: PrivateRoomAdmissionOptions, entry: Entry, assertHeld: () => void) {
  const name = stageKey(entry.plan), value = entry.stageHash;
  if (!value) fail("Stage has no digest.");
  const prior = await options.profile.get(name);
  if (prior !== undefined && prior !== value) fail("Immutable stage pin already exists with different bytes.");
  if (prior === value) return;
  await options.profile.store(name, value);
  const end = Date.now() + 5000;
  while (true) {
    options.assertAuthority(); assertHeld();
    if (await options.profile.get(name) === value) return;
    if (Date.now() >= end) fail("Immutable stage pin was not observable; no publication allowed.");
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}
async function saveIndex(options: PrivateRoomAdmissionOptions, workspaceId: string, value: Index, assertHeld: () => void) {
  const raw = JSON.stringify(value), end = Date.now() + 5000;
  await options.profile.store(key(workspaceId), raw);
  // SecretStorage's change event/cache can lag its store acknowledgement.
  while (true) {
    options.assertAuthority(); assertHeld();
    if (await options.profile.get(key(workspaceId)) === raw) return;
    if (Date.now() >= end) fail("Profile admission pin was not observable after storage; no publication allowed.");
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}
async function authorize(options: PrivateRoomAdmissionOptions, plan: Plan, operation: PrivateRoomAdmissionBinding["operation"],
  assertHeld: () => void) {
  const guard = () => { options.assertAuthority(); assertHeld(); rootIdentity(plan); };
  guard(); source(plan);
  const binding = Object.freeze({ root: plan.root, workspaceId: plan.workspaceId, roomId: plan.roomId,
    sourceRoot: plan.sourceRoot, sourceFingerprint: plan.sourceFingerprint, meetingHash: plan.meetingHash, operation });
  if (!await options.authorize(binding)) fail("Independent selected-owner/profile approval denied.");
  guard();
  const db = new DatabaseSync(join(plan.sourceRoot, "chatrooms", plan.roomId, "chatroom.db"), { readOnly: true });
  let credentialHash: string;
  try {
    db.exec("PRAGMA query_only=ON; PRAGMA trusted_schema=OFF");
    credentialHash = String(db.prepare("SELECT host_credential_hash FROM room_metadata WHERE room_id=?").get(plan.roomId)?.host_credential_hash);
  } finally { db.close(); }
  if (!/^[a-f0-9]{64}$/.test(credentialHash) || !await options.credentials.verifyHost(plan.roomId, credentialHash))
    fail("Original Host profile credentials required.");
  const credentials = await options.credentials.load(plan.roomId);
  if (!credentials || credentials.hostCredentialHash !== credentialHash || sha(credentials.hostCredential) !== credentialHash)
    fail("Original Host proof changed.");
  guard(); source(plan);
}
function sync(directory: string) {
  const fd = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
function ensure(root: string, path: string) {
  let file = root;
  directory(root);
  for (const part of path.split("/").filter(Boolean)) {
    if (part === ".." || part === ".") fail("Unsafe private stage path.");
    const parent = file; file = join(file, part);
    if (!existsSync(file)) { mkdirSync(file, { mode: 0o700 }); sync(parent); }
    directory(file);
  }
  return file;
}
function create(file: string, data: Buffer, work: string) {
  if (existsSync(file)) {
    if (!bytes(file, true).bytes.equals(data)) fail("Private destination/receipt conflicts; nothing was overwritten.");
    return;
  }
  const temporary = join(work, randomUUID());
  const fd = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, data); fsyncSync(fd); } finally { closeSync(fd); }
  // Partial writes remain private in work; only fully fsynced files become visible.
  renameNoReplaceSync(temporary, file);
  sync(dirname(file)); sync(work);
}
function location(plan: Plan) { return join(plan.root, area, plan.intentId); }
function noteFile(plan: Plan, id: string) { return `${area}/${plan.intentId}/notes/${sha(id)}.md`; }
function json(file: string): any { return JSON.parse(bytes(file, true).bytes.toString("utf8")); }
function validateArea(root: string, entries: Entry[]) {
  if (!existsSync(join(root, area))) return;
  directory(join(root, area));
  if (readdirSync(join(root, area)).some(name => !entries.some(entry => entry.plan.intentId === name)))
    fail("Unknown private admission intent; preserve it for reconciliation.");
  let count = 0, total = 0;
  const walk = (file: string, depth: number) => {
    if (depth > 16 || ++count > 20_000) fail("Private admission inventory exceeds its bounds.");
    const stat = lstatSync(file);
    if (stat.isDirectory()) {
      directory(file);
      for (const name of readdirSync(file)) walk(join(file, name), depth + 1);
    } else {
      total += bytes(file, true).pin.size;
      if (total > 536_870_912) fail("Private admission inventory exceeds 512 MiB; no content was pruned.");
    }
  };
  walk(join(root, area), 0);
}
function verifyStage(plan: Plan, stage: Stage) {
  rootIdentity(plan); source(plan);
  if (stage.planHash !== hash(plan) || stage.files.length !== plan.files.length || stage.notes.length !== plan.notes.length)
    fail("Stage receipt conflicts with its profile plan.");
  const published = existsSync(join(plan.root, "chatrooms", plan.roomId));
  const archiveRoot = published ? plan.root : join(location(plan), "stage");
  const archive = inspectLegacyChatroomArchive(archiveRoot, plan.roomId);
  const targetFingerprint = hash({ root: plan.root, roomId: plan.roomId, files: archive.files });
  if (targetFingerprint !== stage.sourceFingerprint || !same(archive.files,
    stage.files.map(({ uid: _uid, ctimeMs: _ctime, ...file }) => file)))
    fail("Copied Room identity/bytes changed.");
  for (let i = 0; i < stage.files.length; i++) {
    const current = pin(archiveRoot, stage.files[i].path, true);
    // Directory publication changes ctime on the directory, not its files.
    if (!same(current, stage.files[i])) fail("Copied Room file changed.");
  }
  for (let i = 0; i < plan.notes.length; i++) {
    const note = plan.notes[i], expected = stage.notes[i];
    if (note.file === null) {
      if (expected !== null || existsSync(join(plan.root, noteFile(plan, note.id)))) fail("Missing original Note gained unapproved content.");
    } else if (!expected || !same(pin(plan.root, noteFile(plan, note.id), true), expected)
      || expected.sha256 !== note.file.sha256) fail("Private Note identity/bytes changed.");
  }
}
async function publish(options: PrivateRoomAdmissionOptions, entry: Entry, save: () => Promise<void>, assertHeld: () => void) {
  const plan = entry.plan;
  await authorize(options, plan, "recover", assertHeld);
  const intent = ensure(plan.root, `${area}/${plan.intentId}`);
  const work = ensure(intent, "work");
  create(join(intent, "plan.json"), Buffer.from(JSON.stringify(plan)), work);
  options.checkpoint?.("prepared"); options.assertAuthority(); assertHeld(); source(plan);
  let stage: Stage;
  if (existsSync(join(intent, "staged.json"))) {
    stage = json(join(intent, "staged.json"));
    if (!entry.stageHash || entry.stageHash !== hash(stage)) fail("Staged receipt has no exact independent profile pin.");
  } else {
    if (existsSync(join(plan.root, "chatrooms", plan.roomId)))
      fail("Unrecorded target Room; preserve it, never replace it.");
    const stageRoot = ensure(intent, "stage");
    for (const file of plan.files) {
      options.assertAuthority(); assertHeld(); source(plan);
      const target = join(stageRoot, file.path);
      ensure(stageRoot, relative(stageRoot, dirname(target)).split(sep).join("/"));
      create(target, bytes(join(plan.sourceRoot, file.path), false).bytes, work);
    }
    ensure(intent, "notes");
    for (const note of plan.notes) if (note.file) {
      options.assertAuthority(); assertHeld(); source(plan);
      create(join(plan.root, noteFile(plan, note.id)), bytes(join(plan.sourceRoot, note.file.path), false).bytes, work);
    }
    const archive = inspectLegacyChatroomArchive(stageRoot, plan.roomId);
    stage = { planHash: hash(plan), sourceFingerprint: hash({ root: plan.root, roomId: plan.roomId, files: archive.files }),
      files: archive.files.map(file => pin(stageRoot, file.path, true)),
      notes: plan.notes.map(note => note.file === null ? null : pin(plan.root, noteFile(plan, note.id), true)) };
    verifyStage(plan, stage);
    // Pin before publishing the immutable receipt. Recovery can reconstruct an absent receipt from the exact stage.
    if (entry.stageHash !== null && entry.stageHash !== hash(stage)) fail("Reconstructed stage differs from its durable profile pin.");
    entry.stageHash = hash(stage); await save();
    options.assertAuthority(); assertHeld(); source(plan);
    create(join(intent, "staged.json"), Buffer.from(JSON.stringify(stage)), work);
  }
  verifyStage(plan, stage);
  options.checkpoint?.("staged"); options.assertAuthority(); assertHeld(); verifyStage(plan, stage);
  const target = join(plan.root, "chatrooms", plan.roomId);
  if (!existsSync(target)) {
    ensure(plan.root, "chatrooms");
    renameNoReplaceSync(join(intent, "stage", "chatrooms", plan.roomId), target);
    sync(join(plan.root, "chatrooms")); sync(join(intent, "stage", "chatrooms"));
  }
  verifyStage(plan, stage);
  options.checkpoint?.("published"); options.assertAuthority(); assertHeld(); verifyStage(plan, stage);
}
function commit(storage: Storage, entry: Entry) {
  const plan = entry.plan, stage = json(join(location(plan), "staged.json")) as Stage;
  verifyStage(plan, stage); storage.assertWorkspaceLease();
  const db = storage.connectNative();
  try {
    db.exec("BEGIN IMMEDIATE; CREATE TABLE IF NOT EXISTS next_private_room_admissions(room_id TEXT PRIMARY KEY,plan_hash TEXT NOT NULL,stage_hash TEXT NOT NULL);");
    const prior = db.prepare("SELECT plan_hash,stage_hash FROM next_private_room_admissions WHERE room_id=?").get(plan.roomId);
    if (prior && (prior.plan_hash !== hash(plan) || prior.stage_hash !== entry.stageHash)) fail("Native admission receipt conflicts.");
    if (!prior) db.prepare("INSERT INTO next_private_room_admissions VALUES(?,?,?)").run(plan.roomId, hash(plan), entry.stageHash);
    verifyStage(plan, stage); storage.assertWorkspaceLease(); db.exec("COMMIT");
  } catch (error) { if (db.isTransaction) db.exec("ROLLBACK"); throw error; }
  finally { db.close(); }
}
function committed(storage: Storage, entry: Entry, recover = false) {
  if (!bytes(join(location(entry.plan), "plan.json"), true).bytes.equals(Buffer.from(JSON.stringify(entry.plan))))
    fail("Private plan file differs from its independent profile pin.");
  const stage = json(join(location(entry.plan), "staged.json")) as Stage;
  if (entry.stageHash !== hash(stage)) fail("Private receipt differs from profile pin.");
  verifyStage(entry.plan, stage);
  const receipt = { planHash: hash(entry.plan), stageHash: entry.stageHash };
  const db = storage.connectNative();
  try {
    const row = db.prepare("SELECT plan_hash,stage_hash FROM next_private_room_admissions WHERE room_id=?").get(entry.plan.roomId);
    if (!row || row.plan_hash !== receipt.planHash || row.stage_hash !== receipt.stageHash) fail("Native admission receipt is missing/conflicting.");
  } finally { db.close(); }
  const intent = location(entry.plan);
  if (recover) create(join(intent, "commit.json"), Buffer.from(JSON.stringify(receipt)), join(intent, "work"));
  else if (!same(json(join(intent, "commit.json")), receipt)) fail("Private commit receipt changed.");
}
export async function admitPrivateRoom(options: PrivateRoomAdmissionOptions & { storage: Storage; sourceRoot: string; roomId: string }) {
  const storage = options.storage, root = storage.workspaceRoot(), workspaceId = await storage.workspaceId();
  options.assertAuthority(); storage.assertWorkspaceLease(); directory(root); directory(options.sourceRoot, options.sourcePrivate !== false);
  const inside = (a: string, b: string) => { const part = relative(a, b); return !part || !isAbsolute(part) && part !== ".." && !part.startsWith(`..${sep}`); };
  if (inside(root, options.sourceRoot) || inside(options.sourceRoot, root)) fail("Source and target overlap.");
  const archive = inspectLegacyChatroomArchive(options.sourceRoot, options.roomId);
  const meetings = inspectRetainedMeetingSource(options.sourceRoot, options.roomId);
  const value = await index(options, workspaceId);
  validateArea(root, value.entries);
  let entry = value.entries.find(entry => entry.plan.roomId === options.roomId);
  if (!entry) {
    if (existsSync(join(root, "chatrooms", options.roomId))) fail("Target Room already exists; nothing was overwritten.");
    const plan: Plan = { schema, intentId: randomUUID(), root, workspaceId, rootIdentity: directory(root),
      marker: pin(root, ".pkm-next-workspace", true), roomId: options.roomId,
      sourceRoot: options.sourceRoot, sourceIdentity: directory(options.sourceRoot, options.sourcePrivate !== false),
      ...(options.sourcePrivate === false ? { sourcePrivate: false as const } : {}),
      sourceFingerprint: archive.sourceFingerprint,
      meetingHash: meetings.hash, files: archive.files.map(file => pin(options.sourceRoot, file.path)),
      notes: meetings.notes.map(note => ({ id: String(note.id), path: String(note.path), file: note.body === null ? null
        : pin(options.sourceRoot, relative(options.sourceRoot, checkedDocumentPath(options.sourceRoot, note.path, false)).split(sep).join("/")) })) };
    await authorize(options, plan, "admit", () => storage.assertWorkspaceLease());
    entry = { plan, stageHash: null }; value.entries.push(entry);
    await saveIndex(options, workspaceId, value, () => storage.assertWorkspaceLease());
  } else if (entry.plan.sourceRoot !== options.sourceRoot || entry.plan.sourceFingerprint !== archive.sourceFingerprint
    || entry.plan.meetingHash !== meetings.hash) fail("Existing private intent belongs to different original bytes.");
  const save = () => saveStage(options, entry!, () => storage.assertWorkspaceLease());
  await publish(options, entry, save, () => storage.assertWorkspaceLease());
  commit(storage, entry);
  options.checkpoint?.("committed"); options.assertAuthority(); storage.assertWorkspaceLease();
  committed(storage, entry, true); policies.set(storage, options);
  return { roomId: entry.plan.roomId, sourceFingerprint: (json(join(location(entry.plan), "staged.json")) as Stage).sourceFingerprint };
}
export async function openPrivateRoomAdmissions(options: PrivateRoomAdmissionOptions & { root: string }) {
  const root = resolve(options.root);
  const fence: LinuxRootWriterFence = await acquireLinuxRootWriterFence(root);
  let storage: Storage | undefined;
  try {
    options.assertAuthority(); fence.assertHeld(); directory(root);
    const workspaceId = JSON.parse(bytes(join(root, ".pkm-next-workspace"), true).bytes.toString("utf8")).id;
    const value = await index(options, workspaceId);
    if (!value.entries.length || value.entries.some(entry => entry.plan.root !== root)) fail("Independent private profile pin is missing.");
    validateArea(root, value.entries);
    for (const entry of value.entries)
      await publish(options, entry, () => saveStage(options, entry, () => fence.assertHeld()), () => fence.assertHeld());
    const { Storage } = await import("./storage.js");
    storage = await Storage.openPrivateRoomRecovery(root, value.entries.map(entry => ({ roomId: entry.plan.roomId,
      sourceFingerprint: (json(join(location(entry.plan), "staged.json")) as Stage).sourceFingerprint })), fence);
    for (const entry of value.entries) {
      await authorize(options, entry.plan, "recover", () => storage!.assertWorkspaceLease());
      commit(storage, entry); options.checkpoint?.("committed"); options.assertAuthority(); storage.assertWorkspaceLease();
      committed(storage, entry, true);
    }
    policies.set(storage, options);
    return storage;
  } catch (error) { if (storage) await storage.close(); else await fence.release(); throw error; }
}
export async function assertPrivateRoomAdmissions(storage: Storage) {
  if (!existsSync(join(storage.workspaceRoot(), area))) return;
  const options = policies.get(storage);
  if (!options) fail("Private Room/Note access requires its independently admitted profile owner.");
  const value = await index(options, await storage.workspaceId());
  if (!value.entries.length) fail("Private Room profile authorization was removed.");
  validateArea(storage.workspaceRoot(), value.entries);
  for (const entry of value.entries) {
    await authorize(options, entry.plan, "use", () => storage.assertWorkspaceLease());
    committed(storage, entry);
  }
}
export function privateMeetingNoteResolver(storage: Storage, roomId: string) {
  const root = storage.workspaceRoot();
  if (!existsSync(join(root, area))) return undefined;
  const options = policies.get(storage);
  if (!options) fail("Private Note has no live admitted profile owner.");
  options.assertAuthority(); storage.assertWorkspaceLease();
  const intents = readdirSync(join(root, area)).map(name => json(join(root, area, name, "plan.json")) as Plan);
  const plan = intents.find(plan => plan.roomId === roomId);
  if (!plan) return undefined;
  const stage = json(join(location(plan), "staged.json")) as Stage;
  verifyStage(plan, stage);
  if (!same(json(join(location(plan), "commit.json")), { planHash: hash(plan), stageHash: hash(stage) }))
    fail("Private Meeting admission is not committed.");
  return (id: string, path: string) => {
    if (!plan.notes.some(note => note.id === id && note.path === path)) fail("Cross-Meeting private Note lookup.");
    return join(root, noteFile(plan, id));
  };
}
