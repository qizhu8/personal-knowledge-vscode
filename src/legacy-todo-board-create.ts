import { createHash } from "node:crypto";
import { closeSync, constants, fsyncSync, linkSync, lstatSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { CoreError, type Actor, type StorageRequest } from "./contracts.js";
import type { Storage } from "./storage.js";
import { checkedDocumentPath, checkedResourcePath } from "./document-path.js";
import { checkedBoardPath } from "./boards.js";
import { decodeMarkdown, encodeMarkdown } from "./markdown.js";
import { readTodoBoard } from "./domain/todo-board.js";
import { legacyTodoBoardCreateArguments, legacyTodoBoardCreateSlug } from "./legacy-todo-board-create-contracts.js";

const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
export type LegacyTodoBoardCreateArguments = z.infer<typeof legacyTodoBoardCreateArguments> & { operationId: string };
const inputSchema = legacyTodoBoardCreateArguments.extend({ operationId: z.string().uuid() });
const slugFor = (input: LegacyTodoBoardCreateArguments) => legacyTodoBoardCreateSlug({ title: input.title, category: input.category });
const planSchema = z.strictObject({
  input: inputSchema, workspaceId: z.string().min(1), actorId: z.enum(["mcp:external", "user:local"]),
  slug: z.string().min(1), descriptor: z.string(), board: z.string(), fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
});
export const LEGACY_TODO_BOARD_CREATE_DDL = `CREATE TABLE IF NOT EXISTS legacy_todo_board_create_intent (
  operation_id TEXT PRIMARY KEY, plan_json TEXT NOT NULL
);`;
export const LEGACY_TODO_BOARD_CREATE_PENDING_OPERATION = "todo.board.create+original-note";

export async function createNativeLegacyTodoBoard(
  storage: Storage, actor: Actor, input: LegacyTodoBoardCreateArguments,
  authorize: (actor: Readonly<Actor>, operation: string) => boolean,
) {
  const parsed = inputSchema.parse(input);
  const slug = slugFor(parsed);
  const principal = Object.freeze({ ...actor });
  if (!actor?.canWrite || actor.id !== "mcp:external" || actor.boardWorker
    || typeof authorize !== "function" || authorize(principal, "todo.board.create") !== true) {
    throw new CoreError("ACCESS_DENIED", "Exact host-authorized external Board creation is required; worker grants cannot create Boards.");
  }
  const result = await storage.withWorkspaceExclusive(async () => {
    storage.assertWorkspaceLease();
    if (authorize(principal, "todo.board.create") !== true)
      throw new CoreError("ACCESS_DENIED", "Board creation authority was revoked.");
    return storage.requestLegacyTodoBoardCreate(parsed, principal.id);
  }) as { digest: string };
  return { ok: true as const, slug, items: [], digest: result.digest };
}

export function legacyTodoBoardCreateFingerprint(request: StorageRequest, input: LegacyTodoBoardCreateArguments) {
  return hash(JSON.stringify({ request, originalNoteCreate: inputSchema.parse(input) }));
}

function assertAbsent(path: string) {
  try { lstatSync(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  throw new CoreError("CONFLICT", "A Note, original backing or native Board already exists; no document was converted or overwritten.");
}
function readRegular(path: string, operationId?: string) {
  const stat = lstatSync(path);
  let ownedLink = false;
  if (stat.nlink === 2 && operationId) {
    try {
      const temporary = lstatSync(join(dirname(path), `.pkm-write-${operationId}`));
      ownedLink = temporary.isFile() && !temporary.isSymbolicLink() && temporary.dev === stat.dev
        && temporary.ino === stat.ino && temporary.nlink === 2;
    } catch { /* A missing owned temporary cannot authorize an arbitrary hardlink. */ }
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 && !ownedLink)
    throw new CoreError("RECOVERY_CONFLICT", "Board creation targets must be unlinked regular files.", "unknown");
  return readFileSync(path, "utf8");
}
function originalBackingPath(root: string, slug: string) {
  return checkedResourcePath(root, `${slug}.assets/pkm-todo-board.json`, false, "notes");
}
function absentBacking(root: string, slug: string) {
  try { assertAbsent(originalBackingPath(root, slug)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}

export function prepareLegacyTodoBoardCreate(
  db: DatabaseSync, root: string, request: StorageRequest, input: LegacyTodoBoardCreateArguments,
  board: string, fingerprint: string,
) {
  const parsed = inputSchema.parse(input), slug = slugFor(parsed);
  if (!db.isTransaction || request.operation !== "todo.board.create" || !["mcp:external", "user:local"].includes(request.actorId)
    || ![23, 24, 25, 26, 27, 28].includes(Number(db.prepare("PRAGMA user_version").get()?.user_version))
    || request.boardWorker || request.args.board_slug !== slug || request.args.operationId !== parsed.operationId
    || fingerprint !== legacyTodoBoardCreateFingerprint(request, parsed) || readTodoBoard(board).items.length) {
    throw new CoreError("INVALID_ARGUMENT", "Original Board creation differs from its fixed native request.");
  }
  try { assertAbsent(checkedDocumentPath(root, `${slug}.md`, false, "notes")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  try { assertAbsent(checkedResourcePath(root, `${slug}.assets`, false, "notes")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  absentBacking(root, slug);
  if (db.prepare("SELECT 1 FROM legacy_note_workitems_admission WHERE slug=?").get(slug))
    throw new CoreError("CONFLICT", "Board slug already has immutable original authority.");
  const id = `board-${parsed.operationId}`;
  const descriptor = decodeMarkdown(id, encodeMarkdown(id, parsed.title.trim(), "", 1, false, undefined, `${slug}.md`), `${slug}.md`);
  descriptor.metadata.set("type", "todo");
  descriptor.metadata.set("documentKind", "todo-board");
  descriptor.metadata.set("tags", []);
  descriptor.metadata.set("created", new Date().toISOString());
  const plan = planSchema.parse({ input: parsed, workspaceId: JSON.parse(readFileSync(join(root, ".pkm-next-workspace"), "utf8")).id,
    actorId: request.actorId, slug, descriptor: `---\n${descriptor.metadata.toString()}---\n`, board, fingerprint });
  db.prepare("INSERT INTO legacy_todo_board_create_intent VALUES(?,?)").run(parsed.operationId, JSON.stringify(plan));
  db.exec(`PRAGMA user_version=${Math.max(24, Number(db.prepare("PRAGMA user_version").get()?.user_version))}`);
}

function durablePublication(path: string, root: string) {
  const file = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { fsyncSync(file); } finally { closeSync(file); }
  if (process.platform !== "win32") {
    let pathDirectory = dirname(path);
    for (;;) {
      const directory = openSync(pathDirectory, "r");
      try { fsyncSync(directory); } finally { closeSync(directory); }
      if (pathDirectory === root) break;
      const parent = dirname(pathDirectory);
      if (parent === pathDirectory) throw new CoreError("UNSAFE_PATH", "Board publication escaped its workspace.");
      pathDirectory = parent;
    }
  }
}
function publishAbsentOrExact(root: string, path: string, raw: string, operationId: string) {
  try {
    if (readRegular(path, operationId) !== raw) throw new CoreError("RECOVERY_CONFLICT", "Board creation target changed; preserve the pending intent.", "unknown");
    try { unlinkSync(join(dirname(path), `.pkm-write-${operationId}`)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    durablePublication(path, root);
    return;
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const temporary = join(dirname(path), `.pkm-write-${operationId}`);
  try { const stat = lstatSync(temporary);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
      throw new CoreError("RECOVERY_CONFLICT", "Board creation temporary path is not owned regular data.", "unknown");
    unlinkSync(temporary);
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try { writeFileSync(fd, raw, "utf8"); fsyncSync(fd); } finally { closeSync(fd); }
  try {
    try { linkSync(temporary, path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || readRegular(path) !== raw) throw error;
    }
  } finally { unlinkSync(temporary); }
  durablePublication(path, root);
}

export function inspectLegacyTodoBoardCreateIntent(db: DatabaseSync, root: string) {
  const pending = db.prepare("SELECT * FROM pending_todo WHERE singleton=1").get();
  const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='legacy_todo_board_create_intent'").get();
  const rows = exists ? db.prepare("SELECT * FROM legacy_todo_board_create_intent").all() : [];
  if (rows.length > 1) throw new CoreError("RECOVERY_CONFLICT", "Multiple original Board creation intents require reconciliation.", "unknown");
  if (!rows.length) {
    if (pending?.operation === LEGACY_TODO_BOARD_CREATE_PENDING_OPERATION)
      throw new CoreError("RECOVERY_CONFLICT", "Original Board creation lost its committed descriptor authority.", "unknown");
    return undefined;
  }
  const row = rows[0]!, plan = planSchema.parse(JSON.parse(String(row.plan_json)));
  if (![24, 25, 26, 27, 28].includes(Number(db.prepare("PRAGMA user_version").get()?.user_version))) {
    throw new CoreError("RECOVERY_CONFLICT", "Original Board creation requires its downgrade-fenced schema24 authority.", "unknown");
  }
  const request: StorageRequest = { operation: "todo.board.create", args: { board_slug: plan.slug, operationId: plan.input.operationId }, actorId: plan.actorId };
  const descriptor = decodeMarkdown(`board-${plan.input.operationId}`, plan.descriptor, `${plan.slug}.md`);
  if (!pending || row.operation_id !== plan.input.operationId || pending.operation_id !== row.operation_id
    || pending.operation !== LEGACY_TODO_BOARD_CREATE_PENDING_OPERATION || pending.actor_id !== plan.actorId || pending.board_slug !== plan.slug
    || pending.before_sha256 !== null || pending.after_json !== plan.board || pending.fingerprint !== plan.fingerprint
    || plan.fingerprint !== legacyTodoBoardCreateFingerprint(request, plan.input)
    || plan.slug !== slugFor(plan.input)
    || plan.workspaceId !== JSON.parse(readFileSync(join(root, ".pkm-next-workspace"), "utf8")).id
    || descriptor.metadata.get("documentKind") !== "todo-board" || descriptor.record.title !== plan.input.title.trim()
    || readTodoBoard(plan.board).items.length
    || JSON.parse(String(pending.result)).digest !== readTodoBoard(plan.board).digest) {
    throw new CoreError("RECOVERY_CONFLICT", "Original Board creation intent is not bound to its exact native pending operation.", "unknown");
  }
  absentBacking(root, plan.slug);
  for (const [getPath, raw] of [[() => checkedDocumentPath(root, `${plan.slug}.md`, false, "notes"), plan.descriptor],
    [() => checkedBoardPath(root, plan.slug, false), plan.board]] as const) {
    try {
      const path = getPath();
      try {
        const temporary = lstatSync(join(dirname(path), `.pkm-write-${plan.input.operationId}`));
        if (!temporary.isFile() || temporary.isSymbolicLink() || temporary.nlink > 2)
          throw new CoreError("RECOVERY_CONFLICT", "Original Board creation temporary file has unknown ownership.", "unknown");
        if (temporary.nlink === 2) {
          let target;
          try { target = lstatSync(path); }
          catch { throw new CoreError("RECOVERY_CONFLICT", "Original Board creation temporary link has no owned target.", "unknown"); }
          if (target.dev !== temporary.dev || target.ino !== temporary.ino || target.nlink !== 2)
            throw new CoreError("RECOVERY_CONFLICT", "Original Board creation temporary has an unowned link.", "unknown");
        }
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      if (readRegular(path, plan.input.operationId) !== raw)
        throw new CoreError("RECOVERY_CONFLICT", "Original Board creation target conflicts with committed intent.", "unknown");
    }
    catch (error) { if (!["ENOENT", "NOT_FOUND"].includes(String((error as NodeJS.ErrnoException).code))) throw error; }
  }
  return plan;
}

export function recoverLegacyTodoBoardCreate(db: DatabaseSync, root: string) {
  const plan = inspectLegacyTodoBoardCreateIntent(db, root);
  if (!plan) return;
  publishAbsentOrExact(root, checkedDocumentPath(root, `${plan.slug}.md`, true, "notes"), plan.descriptor, plan.input.operationId);
  publishAbsentOrExact(root, checkedBoardPath(root, plan.slug, true), plan.board, plan.input.operationId);
  const sourceMarkdownDigest = hash(plan.descriptor), nativeBoardDigest = hash(plan.board);
  const binding = hash(JSON.stringify({ workspaceId: plan.workspaceId, actorId: plan.actorId, slug: plan.slug,
    sourceMarkdownDigest, nativeBoardDigest }));
  db.prepare(`INSERT INTO legacy_note_workitems_admission
    (slug,source_markdown_sha256,source_board_sha256,native_board_sha256,admitted_at,source_kind)
    VALUES(?,?,?,?,?,'native-board')`).run(plan.slug, sourceMarkdownDigest, nativeBoardDigest, nativeBoardDigest, new Date().toISOString());
  db.prepare("INSERT INTO legacy_note_workitems_canonical_source VALUES(?,?,?,?,?,?,?)")
    .run(plan.slug, sourceMarkdownDigest, nativeBoardDigest, plan.board, plan.workspaceId, plan.actorId, binding);
  db.prepare("DELETE FROM legacy_todo_board_create_intent WHERE operation_id=?").run(plan.input.operationId);
}
