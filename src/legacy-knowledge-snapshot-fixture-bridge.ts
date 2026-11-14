import { createHash, randomUUID } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import {
  chmodSync, closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync,
  readFileSync, readdirSync, realpathSync, renameSync, rmdirSync, unlinkSync, writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { acquireLinuxRootWriterFence } from "./linux-root-writer-fence.js";
import { assertLinuxLegacyWritersQuiescent } from "./linux-legacy-writer-quiescence.js";
import { runLegacyMcpPython } from "./legacy-mcp-python.js";
import { validatePrivacyPolicy } from "./legacy-root-pkm-state.js";

const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const uuid = z.string().uuid();
const dir = z.strictObject({ path: z.string(), mode: z.number().int().min(0).max(0o777) });
const file = z.strictObject({ path: z.string(), mode: z.number().int().min(0).max(0o777),
  bytes: z.string(), sha256: digest });
const treeSchema = z.strictObject({ directories: z.array(dir).max(1024), files: z.array(file).max(4096) });
type Tree = z.infer<typeof treeSchema>;
const journalSchema = z.strictObject({
  schema: z.literal("pkm.private-original-snapshot-bridge/v1"), id: uuid, root: z.string(), rootPin: z.string(), statePin: z.string(),
  nonce: uuid, privacySha256: digest, corpusSha256: digest, before: treeSchema, after: treeSchema,
  result: z.record(z.string(), z.unknown()), checksum: digest,
});
type Journal = z.infer<typeof journalSchema>;
const stateRelative = ".pkm/state/knowledge-snapshots";
const journalName = "snapshot-bridge-journal.json";
const maximumBytes = 16 * 1024 * 1024;
const fail = (code: string, message: string): never => { throw Object.assign(new Error(message), { code }); };

function syncDirectory(path: string) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
function privateDirectory(path: string) {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(path) !== path
    || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0 || (stat.mode & 0o7000) !== 0)
    fail("FIXTURE_DENIED", "Private snapshot fixture directory is unsafe.");
}
function readStable(path: string, max = maximumBytes): Buffer {
  const before = lstatSync(path, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size > BigInt(max)
    || Number(before.uid) !== process.getuid?.() || (Number(before.mode) & 0o7000) !== 0)
    fail("UNSAFE_PATH", "Snapshot fixture requires bounded owned unlinked regular files.");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = fstatSync(fd, { bigint: true }), bytes = readFileSync(fd), after = fstatSync(fd, { bigint: true });
    const current = lstatSync(path, { bigint: true });
    for (const stat of [opened, after, current])
      if (!stat.isFile() || stat.dev !== before.dev || stat.ino !== before.ino || stat.nlink !== 1n
        || stat.size !== before.size || stat.mode !== before.mode || stat.mtimeNs !== before.mtimeNs || stat.ctimeNs !== before.ctimeNs)
        fail("SOURCE_CHANGED", "Snapshot fixture file changed while reading.");
    if (BigInt(bytes.length) !== before.size) fail("SOURCE_CHANGED", "Snapshot fixture file size changed.");
    return bytes;
  } finally { closeSync(fd); }
}
function safePath(value: string) {
  if (!value || value.includes("\\") || value.split("/").some(part => !part || part === "." || part === ".."
    || /[\u0000-\u001f\u007f:]/.test(part))) fail("UNSAFE_PATH", "Snapshot fixture path is unsafe.");
}
function inventory(base: string): Tree {
  const directories: Tree["directories"] = [], files: Tree["files"] = [];
  let total = 0;
  function visit(parent: string) {
    for (const name of readdirSync(parent).sort()) {
      const path = join(parent, name), address = relative(base, path).split("\\").join("/");
      safePath(address);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o7000) !== 0)
        fail("UNSAFE_PATH", "Snapshot fixture state contains an unsafe entry.");
      if (stat.isDirectory()) {
        directories.push({ path: address, mode: stat.mode & 0o777 }); visit(path);
      } else {
        const bytes = readStable(path);
        total += bytes.length;
        if (total > maximumBytes) fail("LIMIT", "Snapshot fixture state exceeds its bounded size.");
        files.push({ path: address, mode: stat.mode & 0o777, bytes: bytes.toString("base64"), sha256: sha256(bytes) });
      }
      if (directories.length > 1024 || files.length > 4096) fail("LIMIT", "Snapshot fixture state exceeds its bounded inventory.");
    }
  }
  const stat = lstatSync(base);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail("UNSAFE_PATH", "Original snapshot state must be a real directory.");
  visit(base);
  return { directories, files };
}
function validateTree(tree: Tree) {
  const names = new Set<string>();
  let total = 0;
  for (const row of [...tree.directories, ...tree.files]) {
    safePath(row.path);
    if (names.has(row.path)) fail("RECOVERY_CONFLICT", "Snapshot journal contains duplicate paths.");
    names.add(row.path);
  }
  for (const row of tree.files) {
    const bytes = Buffer.from(row.bytes, "base64"); total += bytes.length;
    if (bytes.toString("base64") !== row.bytes || sha256(bytes) !== row.sha256 || total > maximumBytes)
      fail("RECOVERY_CONFLICT", "Snapshot journal contains invalid file data.");
  }
}
function writeExclusive(path: string, bytes: Buffer, mode: number) {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
  try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
  chmodSync(path, mode);
  syncDirectory(dirname(path));
}
async function acquireOriginalSnapshotLock(path: string): Promise<{ assertHeld(): void; release(): Promise<void> }> {
  const before = lstatSync(path);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size !== 0
    || before.uid !== process.getuid?.()) fail("UNSAFE_PATH", "Original snapshot lock is unsafe.");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  const opened = fstatSync(fd);
  if (opened.dev !== before.dev || opened.ino !== before.ino || opened.nlink !== 1) {
    closeSync(fd); fail("SOURCE_CHANGED", "Original snapshot lock changed while opening.");
  }
  const child = spawn("bash", ["-c", "flock -xn 3 || exit 73; printf ready; cat >/dev/null"],
    { stdio: ["pipe", "pipe", "ignore", fd] });
  let closed = false;
  const close = new Promise<void>(resolveClose => child.once("close", () => { closed = true; resolveClose(); }));
  try {
    await new Promise<void>((resolveReady, reject) => {
      const timer = setTimeout(() => reject(new Error("Timed out acquiring original snapshot lock.")), 10_000);
      child.once("error", () => { clearTimeout(timer); reject(new Error("Snapshot lock helper unavailable.")); });
      child.once("close", () => { clearTimeout(timer); reject(new Error("Original snapshot lock is busy.")); });
      child.stdout!.once("data", data => {
        clearTimeout(timer);
        if (String(data) !== "ready") reject(new Error("Snapshot lock helper failed."));
        else resolveReady();
      });
    });
    const assertHeld = () => {
      const actual = lstatSync(path), held = fstatSync(fd);
      if (closed || child.exitCode !== null || child.signalCode !== null || actual.isSymbolicLink()
        || !actual.isFile() || actual.nlink !== 1 || actual.dev !== before.dev || actual.ino !== before.ino
        || held.dev !== before.dev || held.ino !== before.ino || held.nlink !== 1)
        fail("STORAGE_UNAVAILABLE", "Original snapshot lock was lost or replaced.");
    };
    assertHeld();
    return {
      assertHeld,
      async release() {
        child.stdin!.end();
        await close;
        closeSync(fd);
      },
    };
  } catch {
    child.stdin?.end();
    if (!closed && child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await close;
    closeSync(fd);
    return fail("BUSY", "The original snapshot writer lock could not be acquired.");
  }
}
function fixture(root: string, nonce: string): { parent: string; pin: string; statePin: string; state: string; privacy: string } {
  if (process.platform !== "linux" || resolve(root) !== root || !uuid.safeParse(nonce).success)
    fail("FIXTURE_DENIED", "Only an explicit Linux private snapshot fixture is supported.");
  const parent = dirname(root);
  if (process.env.PKM_PRIVATE_SNAPSHOT_FIXTURE !== parent || basename(root) !== "knowledge"
    || !/^pkm-snapshot-fixture-[a-f0-9-]{36}$/.test(basename(parent)))
    fail("FIXTURE_DENIED", "Snapshot bridge is restricted to its explicit private fixture.");
  for (const path of [parent, root, join(root, ".pkm"), join(root, ".pkm/state"), join(root, stateRelative)])
    privateDirectory(path);
  const markerPath = join(parent, "snapshot-fixture.json"), markerStat = lstatSync(markerPath);
  if ((markerStat.mode & 0o077) !== 0) fail("FIXTURE_DENIED", "Snapshot fixture marker is not private.");
  const marker = z.strictObject({ schema: z.literal("pkm.snapshot-fixture/v1"), nonce: uuid,
    rootPin: z.string() }).parse(JSON.parse(readStable(markerPath, 4096).toString("utf8")));
  const stat = lstatSync(root), pin = `${stat.dev}:${stat.ino}`;
  if (marker.nonce !== nonce || marker.rootPin !== pin) fail("FIXTURE_DENIED", "Snapshot fixture identity changed.");
  if (lstatSync(join(root, ".pkm-next-workspace"), { throwIfNoEntry: false }))
    fail("FIXTURE_DENIED", "This bridge does not replace adopted-workspace snapshot ownership.");
  const privacyPath = join(root, ".pkm/content-privacy.json"), privacyStat = lstatSync(privacyPath);
  if ((privacyStat.mode & 0o077) !== 0) fail("FIXTURE_DENIED", "Snapshot privacy policy is not private.");
  const privacyBytes = readStable(privacyPath, 2 * 1024 * 1024);
  validatePrivacyPolicy(privacyBytes);
  const privacy = sha256(privacyBytes);
  const stateStat = lstatSync(join(root, stateRelative));
  if (lstatSync(parent).dev !== stateStat.dev)
    fail("FIXTURE_DENIED", "Snapshot fixture and state must share a filesystem.");
  return { parent, pin, statePin: `${stateStat.dev}:${stateStat.ino}`, state: join(root, stateRelative), privacy };
}
function basename(value: string) { return value.slice(value.lastIndexOf("/") + 1); }
async function original(root: string, state: string, operation: string, args: Record<string, unknown> = {}) {
  return await runLegacyMcpPython(fileURLToPath(new URL("../compat/legacy-knowledge-snapshots.py", import.meta.url)), [],
    { root, state, operation, args }) as Record<string, unknown>;
}
function verifyConfig(state: Tree) {
  const top = new Set([...state.directories, ...state.files].map(row => row.path.split("/")[0]));
  if ([...top].some(name => !["repository.git", "latest.json", "snapshot.lock"].includes(name))
    || state.files.some(row => /(?:^|\/)(?:alternates|http-alternates|grafts|commondir|shallow)$/.test(row.path)
      || row.path.endsWith(".lock") && row.path !== "snapshot.lock")
    || state.directories.some(row => row.path.startsWith("repository.git/worktrees")))
    fail("UNSUPPORTED_STATE", "Original snapshot state has unsupported scheduling, recovery, Git links or locks.");
  const lock = state.files.find(row => row.path === "snapshot.lock");
  if (!lock || lock.bytes !== "") fail("UNSUPPORTED_STATE", "Original snapshot lock must be empty.");
  const config = state.files.find(row => row.path === "repository.git/config");
  if (!config) fail("UNSUPPORTED_STATE", "Original private snapshot Git repository is missing.");
  const text = Buffer.from(config!.bytes, "base64").toString("utf8");
  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (lines.length !== 4 || lines[0]?.toLowerCase() !== "[core]"
    || !/^[a-z]+ *= *(0|true|false)$/i.test(lines[1] ?? "")
    || !/^[a-z]+ *= *(0|true|false)$/i.test(lines[2] ?? "")
    || !/^[a-z]+ *= *(0|true|false)$/i.test(lines[3] ?? ""))
    fail("UNSUPPORTED_STATE", "Original snapshot Git config has unsupported authority or extensions.");
  const values = new Map<string, string>(lines.slice(1).map(line => {
    const [key, value] = line.split(/\s*=\s*/);
    return [key!.toLowerCase(), value!.toLowerCase()];
  }));
  if (values.size !== 3 || values.get("repositoryformatversion") !== "0" || values.get("bare") !== "true"
    || !["true", "false"].includes(values.get("filemode") ?? ""))
    fail("UNSUPPORTED_STATE", "Original snapshot Git config has unsupported authority or extensions.");
}
function verifyRepository(parent: string, stage: string, status: Record<string, unknown>) {
  const latest = z.object({ schema: z.literal("pkm.knowledge-snapshot/v1"),
    tag: z.string().regex(/^pkm-snapshot-[0-9TZ-]+[0-9a-f]{8}$/), commit: z.string().regex(/^[a-f0-9]{40}$/),
    private: z.literal(true), inventory_sha256: digest }).passthrough().safeParse(status.latest);
  const tags = z.array(z.string()).safeParse(status.tags);
  if (!latest.success || !tags.success || !tags.data.includes(latest.data.tag))
    fail("UNSUPPORTED_STATE", "Original snapshot latest metadata and tags are incomplete.");
  try {
    git(parent, stage, "fsck", "--strict", "--no-reflogs");
    const tag = `refs/tags/${latest.data!.tag}`;
    if (git(parent, stage, "rev-parse", "--verify", `${tag}^{commit}`).toString("utf8").trim() !== latest.data!.commit
      || git(parent, stage, "rev-parse", "--verify", "refs/heads/snapshots").toString("utf8").trim() !== latest.data!.commit)
      fail("UNSUPPORTED_STATE", "Original latest snapshot tag and commit differ.");
    const annotated = git(parent, stage, "cat-file", "-p", tag).toString("utf8");
    const body = annotated.slice(annotated.indexOf("\n\n") + 2).trim();
    const { commit: _commit, ...metadata } = latest.data!;
    if (!annotated.includes("\n\n") || !isDeepStrictEqual(JSON.parse(body), metadata))
      fail("UNSUPPORTED_STATE", "Original snapshot tag and latest metadata differ.");
  } catch { fail("UNSUPPORTED_STATE", "Original private snapshot Git history failed validation."); }
}
function git(parent: string, stage: string, ...args: string[]): Buffer {
  const env = { PATH: process.env.PATH || "", HOME: parent, TMPDIR: parent, GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null", GIT_NO_REPLACE_OBJECTS: "1", GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" };
  return execFileSync("git",
    ["-c", "core.hooksPath=/dev/null", "-c", "protocol.allow=never", `--git-dir=${join(stage, "repository.git")}`, ...args],
    { env, timeout: 30000, maxBuffer: 2 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
}
function same(left: unknown, right: unknown) { return JSON.stringify(left) === JSON.stringify(right); }
function materialize(stage: string, tree: Tree) {
  mkdirSync(stage, { mode: 0o700 });
  for (const row of tree.directories) { mkdirSync(join(stage, row.path), { mode: row.mode }); chmodSync(join(stage, row.path), row.mode); }
  for (const row of tree.files) writeExclusive(join(stage, row.path), Buffer.from(row.bytes, "base64"), row.mode);
}
function cleanupStage(stage: string, expected: Tree) {
  const current = inventory(stage);
  if (!stageSubset(current, expected)) fail("RECOVERY_CONFLICT", "Staged snapshot state changed before cleanup.");
  for (const row of [...current.files].reverse()) { const path = join(stage, row.path); unlinkSync(path); syncDirectory(dirname(path)); }
  for (const row of [...current.directories].reverse()) { const path = join(stage, row.path); rmdirSync(path); syncDirectory(dirname(path)); }
  rmdirSync(stage); syncDirectory(dirname(stage));
}
function stageSubset(current: Tree, expected: Tree) {
  return current.files.every(row => expected.files.some(candidate => same(candidate, row)))
    && current.directories.every(row => expected.directories.some(candidate => same(candidate, row)));
}
function readJournal(parent: string, root: string, nonce: string, pin: string, statePin: string): Journal {
  const path = join(parent, journalName), stat = lstatSync(path);
  if ((stat.mode & 0o077) !== 0 || !stat.isFile() || stat.isSymbolicLink() || ![1, 2].includes(stat.nlink)
    || stat.uid !== process.getuid?.() || stat.size > 48 * 1024 * 1024)
    fail("RECOVERY_CONFLICT", "Snapshot journal is not private and owned.");
  if (stat.nlink === 2) {
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const opened = fstatSync(fd);
      if (opened.dev !== stat.dev || opened.ino !== stat.ino || opened.nlink !== 2)
        fail("RECOVERY_CONFLICT", "Snapshot journal identity changed.");
      const preliminary = journalSchema.parse(JSON.parse(readFileSync(fd).toString("utf8")));
      const after = fstatSync(fd);
      if (after.dev !== stat.dev || after.ino !== stat.ino || after.nlink !== 2
        || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs)
        fail("RECOVERY_CONFLICT", "Snapshot journal changed during inspection.");
      const { checksum, ...body } = preliminary;
      if (sha256(JSON.stringify(body)) !== checksum || preliminary.root !== root || preliminary.rootPin !== pin
        || preliminary.statePin !== statePin || preliminary.nonce !== nonce)
        fail("RECOVERY_CONFLICT", "Snapshot journal hardlink does not bind this fixture.");
      const other = join(parent, `.pkm-snapshot-journal-${preliminary.id}`), link = lstatSync(other);
      if (!link.isFile() || link.isSymbolicLink() || link.dev !== stat.dev || link.ino !== stat.ino || link.nlink !== 2)
        fail("RECOVERY_CONFLICT", "Snapshot journal has an unowned hardlink.");
      unlinkSync(other); syncDirectory(parent);
    } finally { closeSync(fd); }
  }
  const journal = journalSchema.parse(JSON.parse(readStable(path, 48 * 1024 * 1024).toString("utf8")));
  const { checksum, ...body } = journal;
  if (sha256(JSON.stringify(body)) !== checksum || journal.root !== root || journal.rootPin !== pin
    || journal.statePin !== statePin || journal.nonce !== nonce)
    fail("RECOVERY_CONFLICT", "Snapshot journal does not bind this fixture identity.");
  validateTree(journal.before); validateTree(journal.after);
  const after = new Map(journal.after.files.map(row => [row.path, row]));
  if (journal.before.files.some(row => !after.has(row.path))
    || journal.before.directories.some(row => !journal.after.directories.some(item => same(item, row))))
    fail("RECOVERY_CONFLICT", "Snapshot journal cannot remove old state.");
  return journal;
}
function inspectTransition(state: string, journal: Journal) {
  const current = inventory(state);
  const before = new Map(journal.before.files.map(row => [row.path, row]));
  const after = new Map(journal.after.files.map(row => [row.path, row]));
  if (current.files.some(row => ![before.get(row.path), after.get(row.path)].some(candidate => same(candidate, row)))
    || journal.before.files.some(row => !current.files.some(candidate => candidate.path === row.path))
    || current.directories.some(row => !journal.after.directories.some(candidate => same(candidate, row)))
    || journal.before.directories.some(row => !current.directories.some(candidate => same(candidate, row))))
    fail("RECOVERY_CONFLICT", "Original snapshot state is not an exact journal transition.");
  return current;
}
function clearTemporary(parent: string, state: string, journal: Journal) {
  const path = join(parent, `.pkm-snapshot-bridge-${journal.id}`), stat = lstatSync(path, { throwIfNoEntry: false });
  if (!stat) return;
  if (!stat.isFile() || stat.isSymbolicLink() || ![1, 2].includes(stat.nlink)
    || stat.uid !== process.getuid?.() || stat.size > maximumBytes)
    fail("RECOVERY_CONFLICT", "Snapshot publication temporary is unsafe.");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let bytes: Buffer;
  try {
    const opened = fstatSync(fd);
    if (opened.dev !== stat.dev || opened.ino !== stat.ino || opened.nlink !== stat.nlink)
      fail("RECOVERY_CONFLICT", "Snapshot publication temporary changed.");
    bytes = readFileSync(fd);
    const after = fstatSync(fd);
    if (after.dev !== stat.dev || after.ino !== stat.ino || after.nlink !== stat.nlink
      || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs)
      fail("RECOVERY_CONFLICT", "Snapshot publication temporary changed.");
  } finally { closeSync(fd); }
  const candidates = [...journal.before.files, ...journal.after.files].filter(row =>
    (stat.nlink === 2 ? row.mode === (stat.mode & 0o777) : ((stat.mode & 0o777) & ~row.mode) === 0)
    && Buffer.from(row.bytes, "base64").subarray(0, bytes.length).equals(bytes));
  if (!candidates.length) fail("RECOVERY_CONFLICT", "Snapshot publication temporary is not owned by the journal.");
  if (stat.nlink === 2 && !candidates.some(row => {
    if (row.sha256 !== sha256(bytes)) return false;
    const target = lstatSync(join(state, row.path), { throwIfNoEntry: false });
    return target?.isFile() && !target.isSymbolicLink() && target.dev === stat.dev && target.ino === stat.ino && target.nlink === 2;
  })) fail("RECOVERY_CONFLICT", "Snapshot publication temporary has an unowned hardlink.");
  unlinkSync(path); syncDirectory(parent);
}
function publish(parent: string, state: string, journal: Journal, direction: "commit" | "rollback", checkpoint?: (phase: string) => void) {
  clearTemporary(parent, state, journal);
  const current = inspectTransition(state, journal);
  const target = direction === "commit" ? journal.after : journal.before;
  const sourceFiles = new Map(current.files.map(row => [row.path, row]));
  if (direction === "rollback") {
    for (const row of current.files.filter(item => !target.files.some(item2 => item2.path === item.path)).reverse()) {
      if (!same(inventory(state).files.find(item => item.path === row.path), row))
        fail("RECOVERY_CONFLICT", "Snapshot file changed before rollback.");
      unlinkSync(join(state, row.path)); syncDirectory(dirname(join(state, row.path)));
    }
  } else {
    for (const row of target.directories) {
      const path = join(state, row.path);
      if (!lstatSync(path, { throwIfNoEntry: false })) { mkdirSync(path, { mode: row.mode }); chmodSync(path, row.mode); syncDirectory(dirname(path)); }
    }
  }
  for (const row of target.files) {
    const existing = sourceFiles.get(row.path);
    if (same(existing, row)) continue;
    const path = join(state, row.path), temporary = join(parent, `.pkm-snapshot-bridge-${journal.id}`);
    writeExclusive(temporary, Buffer.from(row.bytes, "base64"), row.mode);
    try {
      checkpoint?.("temporary-ready");
      if (existing) {
        const bytes = readStable(path);
        if (sha256(bytes) !== existing.sha256 || (lstatSync(path).mode & 0o777) !== existing.mode)
          fail("RECOVERY_CONFLICT", "Snapshot file changed before publication.");
        renameSync(temporary, path);
      } else { linkSync(temporary, path); checkpoint?.("new-linked"); unlinkSync(temporary); }
      syncDirectory(dirname(path));
    } finally { if (lstatSync(temporary, { throwIfNoEntry: false })) unlinkSync(temporary); }
    checkpoint?.("published-file");
  }
  if (direction === "rollback") for (const row of [...current.directories].reverse()) {
    if (!target.directories.some(item => item.path === row.path)) { rmdirSync(join(state, row.path)); syncDirectory(dirname(join(state, row.path))); }
  }
  if (!same(inventory(state), target)) fail("RECOVERY_CONFLICT", "Snapshot publication differs from its journal.");
}

/** Explicit synthetic-only, offline bridge. It does not admit or open a Next workspace. */
export async function legacyKnowledgeSnapshotFixtureBridge(root: string, options: {
  nonce: string; operation: "status" | "read" | "create" | "recover-commit" | "recover-rollback" | "acknowledge";
  reason?: string; tag?: string; path?: string; checkpoint?: (phase: string) => void;
}): Promise<Record<string, unknown>> {
  if (!options || !["status", "read", "create", "recover-commit", "recover-rollback", "acknowledge"].includes(options.operation)
    || options.reason !== undefined && (typeof options.reason !== "string" || options.reason.length > 512 || /[\u0000-\u001f]/.test(options.reason)))
    fail("FIXTURE_DENIED", "Unsupported private snapshot operation.");
  if (options.operation === "read") {
    if (typeof options.tag !== "string" || !/^pkm-snapshot-[0-9TZ-]+[0-9a-f]{8}$/.test(options.tag)
      || typeof options.path !== "string" || !/^(?:skills|notes|papers|prompts|scripts)\/.+/.test(options.path))
      fail("FIXTURE_DENIED", "Snapshot read requires a bounded original tag and content path.");
    safePath(options.path!);
    if (options.path!.split("/").some(part => [".git", ".trash"].includes(part)))
      fail("FIXTURE_DENIED", "Snapshot read cannot expose Git or Trash control paths.");
  }
  const bound = fixture(root, options.nonce);
  const fence = await acquireLinuxRootWriterFence(root);
  let originalLock: Awaited<ReturnType<typeof acquireOriginalSnapshotLock>> | undefined;
  try {
    await assertLinuxLegacyWritersQuiescent(root);
    originalLock = await acquireOriginalSnapshotLock(join(bound.state, "snapshot.lock"));
    const check = () => {
      fence.assertHeld();
      originalLock!.assertHeld();
      const current = fixture(root, options.nonce);
      if (current.pin !== bound.pin || current.statePin !== bound.statePin || current.privacy !== bound.privacy)
        fail("SOURCE_CHANGED", "Snapshot fixture root, private state or privacy changed.");
    };
    check();
    const journalPath = join(bound.parent, journalName);
    if (options.operation.startsWith("recover-") || options.operation === "acknowledge") {
      const journal = readJournal(bound.parent, root, options.nonce, bound.pin, bound.statePin);
      if (journal.privacySha256 !== bound.privacy) fail("RECOVERY_CONFLICT", "Privacy changed during snapshot recovery.");
      const stage = join(bound.parent, `snapshot-stage-${journal.id}`);
      if (lstatSync(stage, { throwIfNoEntry: false }) && !stageSubset(inventory(stage), journal.after))
        fail("RECOVERY_CONFLICT", "Owned snapshot stage changed during recovery.");
      await assertLinuxLegacyWritersQuiescent(root); check();
      if (options.operation === "acknowledge") {
        clearTemporary(bound.parent, bound.state, journal);
        if (!same(inventory(bound.state), journal.after))
          fail("RECOVERY_REQUIRED", "Only the fully committed snapshot may be acknowledged.");
        if (lstatSync(stage, { throwIfNoEntry: false })) cleanupStage(stage, journal.after);
        unlinkSync(journalPath); syncDirectory(bound.parent);
        return { state: "acknowledged" };
      }
      if (options.operation === "recover-commit") {
        clearTemporary(bound.parent, bound.state, journal);
        if (!same(inventory(bound.state), journal.after)
          && String((await original(root, bound.state, "inventory")).sha256) !== journal.corpusSha256)
          fail("RECOVERY_CONFLICT", "Knowledge changed since the pending snapshot was prepared.");
      }
      check(); await assertLinuxLegacyWritersQuiescent(root); check();
      publish(bound.parent, bound.state, journal, options.operation === "recover-commit" ? "commit" : "rollback", options.checkpoint);
      check();
      if (lstatSync(stage, { throwIfNoEntry: false })) cleanupStage(stage, journal.after);
      if (options.operation === "recover-rollback") {
        unlinkSync(journalPath); syncDirectory(bound.parent);
        return { state: "rolled-back" };
      }
      return { state: "committed-awaiting-ack", result: journal.result };
    }
    if (lstatSync(journalPath, { throwIfNoEntry: false })) fail("RECOVERY_REQUIRED", "Original snapshot bridge has a pending journal.");
    const before = inventory(bound.state);
    verifyConfig(before);
    const id = randomUUID(), stage = join(bound.parent, `snapshot-stage-${id}`);
    materialize(stage, before);
    let staged = inventory(stage), prepared = false;
    try {
      if (!same(staged, before)) fail("SOURCE_CHANGED", "Snapshot staging differs from original state.");
      const corpus = String((await original(root, stage, "inventory")).sha256);
      const status = await original(root, stage, "status");
      verifyRepository(bound.parent, stage, status);
      let result: Record<string, unknown> = {};
      if (options.operation === "status") result = { ...status, repository: join(bound.state, "repository.git") };
      else if (options.operation === "read") {
        if (!Array.isArray(status.tags) || !status.tags.includes(options.tag))
          fail("NOT_FOUND", "Original snapshot tag was not found.");
        const spec = `refs/tags/${options.tag}:${options.path}`;
        try {
          if (git(bound.parent, stage, "cat-file", "-t", spec).toString("utf8").trim() !== "blob")
            fail("NOT_FOUND", "Original snapshot content is not a file.");
          const bytes = git(bound.parent, stage, "cat-file", "blob", spec);
          result = { tag: options.tag, path: options.path, contentBase64: bytes.toString("base64"), sha256: sha256(bytes) };
        } catch { fail("NOT_FOUND", "Original snapshot content was not found or exceeds the bounded read."); }
      } else result = await original(root, stage, "create", { reason: options.reason ?? "manual" });
      if (options.operation === "create") {
        const afterStatus = await original(root, stage, "status");
        verifyRepository(bound.parent, stage, afterStatus);
      }
      staged = inventory(stage);
      if (options.operation === "status" || options.operation === "read") {
        if (!same(staged, before) || !same(inventory(bound.state), before))
          fail("SOURCE_CHANGED", "Snapshot read changed its private state.");
        check(); await assertLinuxLegacyWritersQuiescent(root); check();
        return result;
      }
      if (String((await original(root, stage, "inventory")).sha256) !== corpus || !same(inventory(bound.state), before))
        fail("SOURCE_CHANGED", "Original knowledge or private snapshot state changed during preparation.");
      check(); await assertLinuxLegacyWritersQuiescent(root); check();
      const body = { schema: "pkm.private-original-snapshot-bridge/v1" as const, id, root,
        rootPin: bound.pin, statePin: bound.statePin, nonce: options.nonce, privacySha256: bound.privacy, corpusSha256: corpus, before, after: staged, result };
      const journal = journalSchema.parse({ ...body, checksum: sha256(JSON.stringify(body)) });
      validateTree(journal.before); validateTree(journal.after);
      const pendingJournal = join(bound.parent, `.pkm-snapshot-journal-${id}`);
      writeExclusive(pendingJournal, Buffer.from(JSON.stringify(journal)), 0o600);
      linkSync(pendingJournal, journalPath);
      syncDirectory(bound.parent);
      prepared = true;
      options.checkpoint?.("journal-linked");
      unlinkSync(pendingJournal); syncDirectory(bound.parent);
      options.checkpoint?.("prepared");
      readJournal(bound.parent, root, options.nonce, bound.pin, bound.statePin);
      check(); await assertLinuxLegacyWritersQuiescent(root); check();
      publish(bound.parent, bound.state, journal, "commit", options.checkpoint);
      if (String((await original(root, bound.state, "inventory")).sha256) !== corpus)
        fail("RECOVERY_CONFLICT", "Knowledge changed during snapshot publication.");
      check();
      cleanupStage(stage, staged);
      options.checkpoint?.("committed");
      return result;
    } finally {
      // Staging is private and is removed only if it still exactly matches the owned inventory.
      if (lstatSync(stage, { throwIfNoEntry: false })) {
        if (prepared || same(inventory(stage), staged)) cleanupStage(stage, staged);
      }
    }
  } finally {
    try { await originalLock?.release(); } finally { await fence.release(); }
  }
}
