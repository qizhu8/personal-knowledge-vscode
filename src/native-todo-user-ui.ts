import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { CoreError } from "./contracts.js";
import { scanBoards, checkedBoardPath, assertBoardFocus } from "./boards.js";
import { commandTodoBoard, readTodoBoard, serializeTodoBoard, todoBoardWorkers } from "./domain/todo-board.js";
import { canonicalJson } from "./domain/project-recipes-workflow-contracts.js";
import { sha256 } from "./markdown.js";
import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { nativeBoardLifecycleCatalog } from "./native-board-lifecycle-state.js";

const common = { boardSlug: z.string().min(1).max(1024) };
export const nativeTodoUserInput = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("read"), ...common }),
  z.strictObject({ kind: z.literal("command"), ...common, expectedDigest: z.string().regex(/^[a-f0-9]{64}$/),
    operationId: z.uuid(), command: z.record(z.string(), z.unknown()) }),
  z.strictObject({ kind: z.literal("worker-grant"), ...common, expectedDigest: z.string().regex(/^[a-f0-9]{64}$/),
    operationId: z.uuid(), actorId: z.string().regex(/^external:(?:copilot|claude|other):[A-Za-z0-9._-]{1,128}$/),
    tokenHash: z.string().regex(/^[a-f0-9]{64}$/) }),
]);
export type NativeTodoUserInput = z.infer<typeof nativeTodoUserInput>;
export const nativeTodoUiChats = z.array(z.strictObject({
  id: z.string().regex(/^chat:[a-f0-9-]{36}$/), title: z.string().max(4096),
  chatUrl: z.string().regex(/^pkm:\/\/chats\/[a-f0-9]{16}\/[a-f0-9-]{36}$/),
})).max(1000);
export type NativeTodoUiChat = z.infer<typeof nativeTodoUiChats>[number];
export const NATIVE_TODO_USER_OPERATION = "private.native-todo-user.command";
export type NativeTodoUserAuthority = Readonly<{ kind: "synthetic-only" }>;
const authorities = new WeakMap<NativeTodoUserAuthority, {
  root: string; fixture: string; nonce: string; workspaceId: string; boards: readonly string[];
  rootDevice: number; rootInode: number; tokenDevice: number; tokenInode: number;
}>();
function privateMarker(path: string): { bytes: Buffer; device: number; inode: number } {
  const before = lstatSync(path);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > 1024
    || before.uid !== process.getuid?.() || (before.mode & 0o7077) !== 0)
    throw new CoreError("ACCESS_DENIED", "Native Todo authority requires an owned private single-link fixture marker.");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = fstatSync(fd), bytes = readFileSync(fd), after = fstatSync(fd), current = lstatSync(path);
    if (opened.dev !== before.dev || opened.ino !== before.ino || after.mtimeMs !== before.mtimeMs
      || after.ctimeMs !== before.ctimeMs || after.size !== before.size || current.dev !== before.dev
      || current.ino !== before.ino || current.ctimeMs !== before.ctimeMs || current.mtimeMs !== before.mtimeMs
      || current.isSymbolicLink() || bytes.length !== before.size)
      throw new CoreError("ACCESS_DENIED", "Native Todo fixture marker identity changed.");
    return { bytes, device: before.dev, inode: before.ino };
  } finally { closeSync(fd); }
}
export function admitNativeTodoUserAuthority(input: {
  root: string; fixture: string; nonce: string; workspaceId: string; boards: readonly string[];
}): NativeTodoUserAuthority {
  if (process.platform !== "linux" || process.env.PKM_NATIVE_UI_PRIVATE_FIXTURE !== input.nonce
    || !/^[a-f0-9-]{36}$/.test(input.nonce) || realpathSync(input.root) !== input.root
    || realpathSync(input.fixture) !== input.fixture || dirname(input.root) !== input.fixture
    || input.root !== join(input.fixture, "knowledge"))
    throw new CoreError("ACCESS_DENIED", "Native Todo user authority is Linux synthetic-fixture-only.");
  const root = lstatSync(input.root), fixture = lstatSync(input.fixture);
  if (!root.isDirectory() || root.isSymbolicLink() || root.uid !== process.getuid?.() || (root.mode & 0o7077) !== 0
    || !fixture.isDirectory() || fixture.isSymbolicLink() || fixture.uid !== process.getuid?.() || (fixture.mode & 0o7077) !== 0)
    throw new CoreError("ACCESS_DENIED", "Native Todo fixture/root are not private owned directories.");
  const token = privateMarker(join(input.fixture, "native-ui-fixture-token"));
  if (token.bytes.toString() !== input.nonce || JSON.parse(privateMarker(join(input.root, ".pkm-next-workspace")).bytes.toString()).id !== input.workspaceId)
    throw new CoreError("ACCESS_DENIED", "Native Todo fixture token or workspace identity does not match.");
  const authority = Object.freeze({ kind: "synthetic-only" as const });
  authorities.set(authority, { ...input, boards: Object.freeze([...input.boards]), rootDevice: root.dev, rootInode: root.ino,
    tokenDevice: token.device, tokenInode: token.inode });
  return authority;
}
export function assertNativeTodoUserRootAuthority(root: string, authority?: NativeTodoUserAuthority) {
  const value = authority && authorities.get(authority), stat = lstatSync(root);
  if (!value || value.root !== root || value.rootDevice !== stat.dev
    || value.rootInode !== stat.ino || process.env.PKM_NATIVE_UI_PRIVATE_FIXTURE !== value.nonce)
    throw new CoreError("ACCESS_DENIED", "Trusted Todo user dispatch requires its exact unforgeable synthetic authority.");
  const token = privateMarker(join(value.fixture, "native-ui-fixture-token"));
  if (token.device !== value.tokenDevice || token.inode !== value.tokenInode || token.bytes.toString() !== value.nonce
    || JSON.parse(privateMarker(join(root, ".pkm-next-workspace")).bytes.toString()).id !== value.workspaceId)
    throw new CoreError("ACCESS_DENIED", "Native Todo synthetic authority is no longer current.");
  return value;
}
export function nativeTodoUserBoards(root: string, authority: NativeTodoUserAuthority | undefined, db: DatabaseSync, includeTrashed = false) {
  const value = assertNativeTodoUserRootAuthority(root, authority);
  const created: string[] = [];
  for (const row of db.prepare("SELECT * FROM legacy_note_workitems_canonical_source WHERE actor_id='user:local'").all()) {
    const binding = sha256(JSON.stringify({ workspaceId: row.workspace_id, actorId: row.actor_id, slug: row.slug,
      sourceMarkdownDigest: row.source_markdown_sha256, nativeBoardDigest: row.source_board_sha256 }));
    if (row.workspace_id !== value.workspaceId || typeof row.source_board !== "string"
      || sha256(row.source_board) !== row.source_board_sha256 || binding !== row.binding_sha256)
      throw new CoreError("RECOVERY_CONFLICT", "Created user Board lost its immutable workspace/source binding.", "unknown");
    created.push(String(row.slug));
  }
  const catalog = nativeBoardLifecycleCatalog(root, db);
  return [...new Set([...value.boards, ...created])].filter(key => includeTrashed || catalog.get(key)?.status !== "trashed");
}
export function assertNativeTodoUserAuthority(root: string, boardSlug: string, authority?: NativeTodoUserAuthority, db?: DatabaseSync) {
  const value = assertNativeTodoUserRootAuthority(root, authority);
  if (!value.boards.includes(boardSlug) && (!db || !nativeTodoUserBoards(root, authority, db).includes(boardSlug)))
    throw new CoreError("ACCESS_DENIED", "Todo Board is outside its original or durably created user authority.");
}
export const nativeTodoUserDdl = `CREATE TABLE IF NOT EXISTS native_todo_user_intent(
  operation_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, request_json TEXT NOT NULL,
  before_sha256 TEXT NOT NULL, after_json TEXT NOT NULL, result_json TEXT NOT NULL
);`;

export function planNativeTodoUser(root: string, value: NativeTodoUserInput, directory: NativeTodoUiChat[], database?: DatabaseSync) {
  const input = nativeTodoUserInput.parse(value), chats = nativeTodoUiChats.parse(directory);
  const boards = scanBoards(root, database), board = boards.get(input.boardSlug);
  checkedBoardPath(root, input.boardSlug, false);
  if (!board) throw new CoreError("NOT_FOUND", "Native Todo Board is unavailable.");
  if (input.kind === "read") return { result: readTodoBoard(board.raw) };
  if (input.boardSlug.split("/")[0]!.toLowerCase() === "system") throw new CoreError("ACCESS_DENIED", "System Boards are read-only.");
  if (sha256(board.raw) !== input.expectedDigest) throw new CoreError("CONFLICT", "Todo Board changed; reload before retrying the preserved draft.");
  if (input.kind === "worker-grant") {
    const raw = serializeTodoBoard(readTodoBoard(board.raw).items, { ...todoBoardWorkers(board.raw), [input.actorId]: input.tokenHash });
    return { result: readTodoBoard(raw), write: { slug: input.boardSlug, before: sha256(board.raw), raw } };
  }
  if (canonicalJson(input.command).length > 1_048_576) throw new CoreError("LIMIT_EXCEEDED", "Todo command exceeds its bounded user payload.");
  const command = input.command;
  const owner = command.action === "assign" ? command.ownerId
    : command.action === "create" || command.action === "edit" ? (command.item as Record<string, unknown> | undefined)?.ownerId : undefined;
  if (typeof owner === "string" && owner.startsWith("chat:") && !chats.some(chat => chat.id === owner))
    throw new CoreError("ACCESS_DENIED", "Assign only an exact admitted original Chat identity.");
  if (sha256(board.raw) !== input.expectedDigest) throw new CoreError("CONFLICT", "Todo Board changed; reload before retrying the preserved draft.");
  let raw: string;
  try { raw = commandTodoBoard(board.raw, input.expectedDigest, command, { id: "user:local", role: "user" }); }
  catch (error) { throw new CoreError("DOMAIN_REJECTED", error instanceof Error ? error.message : String(error)); }
  assertBoardFocus(input.boardSlug, readTodoBoard(board.raw).items, readTodoBoard(raw).items, boards);
  return { result: readTodoBoard(raw), write: { slug: input.boardSlug, before: sha256(board.raw), raw } };
}
export function nativeTodoUserFingerprint(input: NativeTodoUserInput): string {
  return sha256(canonicalJson({ principal: "user:local", operation: NATIVE_TODO_USER_OPERATION, input }));
}
export function prepareNativeTodoUserIntent(db: DatabaseSync, input: NativeTodoUserInput, raw: string) {
  if (!db.isTransaction || input.kind === "read") throw new CoreError("TRANSACTION_BOUNDARY", "Trusted Todo user intent requires its native transaction.");
  db.prepare("INSERT INTO native_todo_user_intent VALUES(?,?,?,?,?,?)").run(input.operationId,
    nativeTodoUserFingerprint(input), canonicalJson(input), input.expectedDigest, raw, canonicalJson(readTodoBoard(raw)));
}
export function assertNativeTodoUserPending(db: DatabaseSync, pending: Record<string, unknown>) {
  if (pending.operation !== NATIVE_TODO_USER_OPERATION) return;
  const row = db.prepare("SELECT * FROM native_todo_user_intent WHERE operation_id=?").get(String(pending.operation_id));
  if (!row) throw new CoreError("RECOVERY_CONFLICT", "Trusted Todo user pending effect has no durable user intent.", "unknown");
  const input = nativeTodoUserInput.parse(JSON.parse(String(row.request_json)));
  if (input.kind === "read" || input.operationId !== pending.operation_id || input.boardSlug !== pending.board_slug
    || pending.actor_id !== "user:local" || row.fingerprint !== nativeTodoUserFingerprint(input)
    || row.fingerprint !== pending.fingerprint || row.before_sha256 !== input.expectedDigest
    || row.before_sha256 !== pending.before_sha256 || row.after_json !== pending.after_json
    || row.result_json !== pending.result || row.request_json !== canonicalJson(input)
    || row.result_json !== canonicalJson(readTodoBoard(String(row.after_json))))
    throw new CoreError("RECOVERY_CONFLICT", "Trusted Todo user pending intent or full-snapshot result changed.", "unknown");
}
