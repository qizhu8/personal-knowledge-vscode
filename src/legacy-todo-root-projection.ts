import { createHash } from "node:crypto";
import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { link, lstat, mkdir, open, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { readTodoBoard } from "./domain/todo-board.js";
import type { LegacyImportPlan } from "./legacy-import.js";
import { canonicalJson } from "./domain/project-recipes-workflow-contracts.js";
import { assertNativeTodoUserPending, NATIVE_TODO_USER_OPERATION } from "./native-todo-user-ui.js";
import { todoDefinitions } from "./todo-definitions.js";
import { readNativeBoardGenesisSource } from "./native-board-lifecycle-state.js";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const board = z.strictObject({
  slug: z.string().min(1).max(1024), source: z.string(), destination: z.string(),
  sha256: digest, size: z.number().int().nonnegative().max(2_097_152),
  markdown: z.string(), markdownSha256: digest,
});
export const legacyTodoRootProjectionSchema = z.strictObject({
  schema: z.literal("pkm.legacy-todo-root-projection/v1"),
  boards: z.array(board).max(1024), fingerprint: digest,
});
export type LegacyTodoRootProjection = z.infer<typeof legacyTodoRootProjectionSchema>;
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
function fail(message: string): never {
  throw Object.assign(new Error(message), { code: "TODO_PROJECTION_RECOVERY_REQUIRED" });
}
function read(root: string, relative: string, expected?: string, limit = 2_097_152, database?: DatabaseSync): Buffer {
  const genesis = readNativeBoardGenesisSource(root, relative, expected, database);
  if (genesis) {
    if (genesis.length > limit) fail("Board genesis exceeds its original source limit.");
    return genesis;
  }
  const path = join(root, relative), before = lstatSync(path, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size > BigInt(limit)
    || (Number(before.mode) & 0o7077) !== 0 || before.uid !== BigInt(process.getuid!()))
    fail("Old Todo source must remain a bounded private owned unlinked file.");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = fstatSync(fd, { bigint: true });
    if (opened.dev !== before.dev || opened.ino !== before.ino) fail("Old Todo source identity changed.");
    const bytes = readFileSync(fd), after = fstatSync(fd, { bigint: true }), current = lstatSync(path, { bigint: true });
    if (after.ctimeNs !== before.ctimeNs || after.mtimeNs !== before.mtimeNs || after.size !== before.size
      || current.isSymbolicLink() || current.dev !== before.dev || current.ino !== before.ino || current.ctimeNs !== before.ctimeNs
      || current.mtimeNs !== before.mtimeNs || current.size !== before.size || BigInt(bytes.length) !== before.size
      || expected && hash(bytes) !== expected) fail("Old Todo source changed during migration.");
    return bytes;
  } finally { closeSync(fd); }
}
export function readLegacyTodoRootProjection(root: string): LegacyTodoRootProjection | undefined {
  let raw: Buffer;
  try { raw = read(root, ".pkm-next-root-adoption.json", undefined, 16_777_216); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  const { journalSha256, ...journal } = JSON.parse(raw.toString("utf8"));
  if (journal.schema !== "pkm.legacy-root-adoption-journal/v1" || journal.sourceRoot !== root
    || hash(JSON.stringify(journal)) !== journalSha256) fail("Todo authority requires its exact root adoption journal.");
  return journal.todoProjection === undefined ? undefined : validateLegacyTodoRootProjection(journal.todoProjection);
}
export function validateLegacyTodoRootProjection(input: unknown): LegacyTodoRootProjection {
  const plan = legacyTodoRootProjectionSchema.parse(input);
  if (hash(canonicalJson(plan.boards)) !== plan.fingerprint || new Set(plan.boards.map(item => item.slug)).size !== plan.boards.length
    || plan.boards.some(item => item.slug.split("/").some(part => !part || part.startsWith(".") || /[\\:\u0000-\u001f]/.test(part))
      || item.source !== `notes/${item.slug}.assets/pkm-todo-board.json`
      || item.destination !== `boards/${item.slug}/pkm-todo-board.json` || item.markdown !== `notes/${item.slug}.md`))
    fail("Todo projection lost its exact old-layout Note/Board identity.");
  return plan;
}
export async function planLegacyTodoRootProjection(root: string, input: LegacyImportPlan): Promise<LegacyTodoRootProjection | undefined> {
  const boards = [];
  for (const entry of input.entries.filter(item => item.kind === "board-backing" && item.destination !== item.source)) {
    const slug = entry.boardSlug!, markdown = `notes/${slug}.md`;
    const note = input.entries.find(item => item.source === markdown);
    if (!entry.destination || !entry.sha256 || entry.size === undefined || !note?.sha256)
      fail("An old-layout Board requires its exact Note descriptor and source bytes.");
    const source = read(root, entry.source, entry.sha256);
    readTodoBoard(source.toString("utf8"));
    read(root, markdown, note.sha256);
    try { await lstat(join(root, entry.destination)); fail("Old-layout Todo migration never overwrites an existing native Board."); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    boards.push({ slug, source: entry.source, destination: entry.destination, sha256: entry.sha256, size: entry.size,
      markdown, markdownSha256: note.sha256 });
  }
  if (!boards.length) return undefined;
  return validateLegacyTodoRootProjection({ schema: "pkm.legacy-todo-root-projection/v1",
    boards, fingerprint: hash(canonicalJson(boards)) });
}
export function legacyTodoProjectionPaths(plan: LegacyTodoRootProjection, token: string): Set<string> {
  validateLegacyTodoRootProjection(plan);
  if (!/^[a-f0-9-]{36}$/.test(token)) fail("Todo projection requires its durable root journal token.");
  const paths = new Set<string>();
  for (const item of plan.boards) {
    const parts = item.destination.split("/");
    for (let index = 1; index < parts.length; index++) paths.add(parts.slice(0, index).join("/"));
    paths.add(item.destination);
    paths.add(`${parts.slice(0, -1).join("/")}/.pkm-write-${token}`);
  }
  return paths;
}
async function syncDirectory(path: string) {
  const fd = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await fd.sync(); } finally { await fd.close(); }
}
export async function publishLegacyTodoRootProjection(root: string, input: LegacyTodoRootProjection, token: string): Promise<void> {
  const plan = validateLegacyTodoRootProjection(input);
  legacyTodoProjectionPaths(plan, token);
  for (const item of plan.boards) {
    const bytes = read(root, item.source, item.sha256), target = join(root, item.destination);
    read(root, item.markdown, item.markdownSha256);
    let directory = root;
    for (const part of item.destination.split("/").slice(0, -1)) {
      directory = join(directory, part);
      try { await mkdir(directory, { mode: 0o700 }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      const stat = await lstat(directory);
      if (stat.isSymbolicLink() || !stat.isDirectory() || (stat.mode & 0o7077) !== 0 || stat.uid !== process.getuid!())
        fail("Native Todo publication directory is not private owned data.");
      await syncDirectory(dirname(directory));
    }
    const temporary = join(directory, `.pkm-write-${token}`);
    let targetExists = false;
    try {
      const stat = await lstat(target);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
        const pending = await lstat(temporary);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 2 || !pending.isFile() || pending.isSymbolicLink()
          || pending.ino !== stat.ino || pending.dev !== stat.dev || pending.nlink !== 2) fail("Unowned Todo publication target.");
        await unlink(temporary);
      }
      if (!read(root, item.destination, item.sha256).equals(bytes)) fail("Native Todo publication conflicts with its old source.");
      targetExists = true;
      try {
        const relative = `${item.destination.slice(0, item.destination.lastIndexOf("/"))}/.pkm-write-${token}`;
        const staging = read(root, relative);
        if (staging.length > bytes.length || !staging.equals(bytes.subarray(0, staging.length)))
          fail("Unexpected bytes in the journal-owned Todo staging path.");
        await unlink(temporary);
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (!targetExists) {
      try {
        const stat = await lstat(temporary);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) fail("Unowned Todo staging file.");
        const staged = read(root, `${item.destination.slice(0, item.destination.lastIndexOf("/"))}/.pkm-write-${token}`);
        if (staged.length > bytes.length || !staged.equals(bytes.subarray(0, staged.length)))
          fail("Todo staging bytes differ from the prepared journal's exact source prefix.");
        if (staged.length < bytes.length) {
          const fd = await open(temporary, constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW | constants.O_NONBLOCK);
          try {
            const opened = await fd.stat();
            if (opened.dev !== stat.dev || opened.ino !== stat.ino || opened.size !== staged.length || opened.nlink !== 1)
              fail("Journal-owned Todo staging identity changed.");
            await fd.writeFile(bytes.subarray(staged.length)); await fd.sync();
          } finally { await fd.close(); }
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        const fd = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        try { await fd.writeFile(bytes); await fd.sync(); } finally { await fd.close(); }
      }
      await link(temporary, target);
      await unlink(temporary);
    }
    await syncDirectory(directory);
    await syncDirectory(dirname(directory));
  }
  await syncDirectory(root);
}
export function verifyLegacyTodoProjectionSource(root: string, input: LegacyTodoRootProjection, published: boolean, database?: DatabaseSync): void {
  const plan = validateLegacyTodoRootProjection(input);
  for (const item of plan.boards) {
    read(root, item.markdown, item.markdownSha256, 2_097_152, database);
    readTodoBoard(read(root, item.source, item.sha256, 2_097_152, database).toString("utf8"));
    if (published) readTodoBoard(read(root, item.destination, item.sha256).toString("utf8"));
  }
}
export const legacyTodoProjectionDdl = `CREATE TABLE IF NOT EXISTS legacy_todo_root_projection(
  workspace_id TEXT PRIMARY KEY, payload TEXT NOT NULL, payload_sha256 TEXT NOT NULL,
  original_boards TEXT NOT NULL
);`;
export function recordLegacyTodoProjection(db: DatabaseSync, root: string, workspaceId: string, input: LegacyTodoRootProjection) {
  const plan = validateLegacyTodoRootProjection(input);
  if (!db.isTransaction) fail("Todo publication receipt requires the native workspace transaction.");
  verifyLegacyTodoProjectionSource(root, plan, true);
  db.exec(legacyTodoProjectionDdl);
  const payload = canonicalJson(plan), originals = canonicalJson(plan.boards.map(item => read(root, item.source, item.sha256).toString("utf8")));
  const row = db.prepare("SELECT * FROM legacy_todo_root_projection WHERE workspace_id=?").get(workspaceId);
  if (row) {
    if (row.payload !== payload || row.payload_sha256 !== hash(payload) || row.original_boards !== originals) fail("Conflicting native Todo projection receipt.");
    return;
  }
  db.prepare("INSERT INTO legacy_todo_root_projection VALUES(?,?,?,?)").run(workspaceId, payload, hash(payload), originals);
}
export function verifyLegacyTodoProjectionReceipt(db: DatabaseSync, root: string, workspaceId: string, input: LegacyTodoRootProjection) {
  const plan = validateLegacyTodoRootProjection(input);
  verifyLegacyTodoProjectionSource(root, plan, false, db);
  const ddl = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='legacy_todo_root_projection'").get();
  if (ddl?.sql !== legacyTodoProjectionDdl.replace("IF NOT EXISTS ", "").trim().replace(/;$/, ""))
    fail("Unexpected native Todo projection receipt schema.");
  const row = db.prepare("SELECT * FROM legacy_todo_root_projection WHERE workspace_id=?").get(workspaceId);
  if (!row || row.payload !== canonicalJson(plan) || row.payload_sha256 !== hash(String(row.payload))
    || row.original_boards !== canonicalJson(plan.boards.map(item => read(root, item.source, item.sha256, 2_097_152, db).toString("utf8"))))
    fail("Todo projection receipt is missing or changed.");
  for (const item of plan.boards) {
    const original = readTodoBoard(read(root, item.source, item.sha256, 2_097_152, db).toString("utf8"));
    const currentBytes = read(root, item.destination), current = readTodoBoard(currentBytes.toString("utf8"));
    const currentDigest = hash(currentBytes);
    const pending = db.prepare("SELECT name FROM sqlite_master WHERE name='pending_todo'").get()
      ? db.prepare("SELECT * FROM pending_todo WHERE board_slug=?").get(item.slug) : undefined;
    let pendingAfter = false;
    if (pending && hash(String(pending.after_json)) === currentDigest) {
      if (pending.operation === NATIVE_TODO_USER_OPERATION) assertNativeTodoUserPending(db, pending);
      else if (!todoDefinitions.some(definition => definition.id === pending.operation && !definition.readOnly))
        fail("Native Todo pending publication has unknown authority.");
      readTodoBoard(String(pending.after_json));
      pendingAfter = true;
    }
    if (!pendingAfter) {
      const hasReceipts = !!db.prepare("SELECT name FROM sqlite_master WHERE name='receipts'").get();
      const hasUser = !!db.prepare("SELECT name FROM sqlite_master WHERE name='native_todo_user_intent'").get();
      const generic = hasReceipts ? db.prepare(`SELECT rowid AS sequence,result FROM receipts
        WHERE operation LIKE 'todo.%' AND json_extract(result,'$.board_slug')=? ORDER BY rowid DESC LIMIT 1`).get(item.slug) : undefined;
      const user = hasReceipts && hasUser ? db.prepare(`SELECT r.rowid AS sequence,r.operation_id,r.fingerprint,r.result,
        u.after_json,u.result_json,u.before_sha256
        FROM receipts r JOIN native_todo_user_intent u ON u.operation_id=r.operation_id
        WHERE r.operation=? AND r.actor_id='user:local' AND json_extract(u.request_json,'$.boardSlug')=?
        ORDER BY r.rowid DESC LIMIT 1`).get(NATIVE_TODO_USER_OPERATION, item.slug) : undefined;
      let expected = item.sha256;
      if (user && (!generic || Number(user.sequence) > Number(generic.sequence))) {
        assertNativeTodoUserPending(db, { operation: NATIVE_TODO_USER_OPERATION, operation_id: user.operation_id,
          fingerprint: user.fingerprint, actor_id: "user:local", board_slug: item.slug,
          before_sha256: user.before_sha256, after_json: user.after_json, result: user.result });
        if (user.result !== user.result_json || user.result !== canonicalJson(readTodoBoard(String(user.after_json))))
          fail("Native Todo user full-snapshot receipt changed.");
        expected = hash(String(user.after_json));
      } else if (generic) expected = String(JSON.parse(String(generic.result)).digest);
      if (currentDigest !== expected) fail("Native Todo bytes differ from their latest durable publication receipt.");
    }
    for (const old of original.items) {
      const now = current.items.find(candidate => candidate.id === old.id);
      if (!now || canonicalJson(now.history?.slice(0, old.history?.length ?? 0) ?? []) !== canonicalJson(old.history ?? []))
        fail("Native Todo history lost an original Work Item identity or audit prefix.");
    }
  }
}
