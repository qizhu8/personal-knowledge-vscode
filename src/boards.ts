import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, openSync, writeFileSync, closeSync, renameSync, unlinkSync, fsyncSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { CoreError, type StorageRequest } from "./contracts.js";
import { sha256 } from "./markdown.js";
import { commandTodoBoard, readTodoBoard, serializeTodoBoard, todoBoardFilename, todoBoardWorkers } from "./domain/todo-board.js";
import { createTodoApi } from "./domain/todo-api.js";
import type { NoteWorkItem } from "./domain/note-work-items.js";
import type { TodoChat, TodoStore } from "./todo-store-contract.js";
import { todoDefinitions } from "./todo-definitions.js";
import type { DatabaseSync } from "node:sqlite";
import { assertNativeBoardLifecycleFiles, nativeBoardLifecycleCatalog, resolveNativeBoardKey } from "./native-board-lifecycle-state.js";
import { readOriginalMcpJournal } from "./original-mcp-root-custody.js";
import { assertOriginalMcpTodoSession, originalMcpDomainDirectory,
  authenticateOriginalMcpTodoWorker, verifyOriginalMcpDomainFiles, readOriginalMcpTodoManifest,
  originalMcpTodoAuthorizedBoardKeys } from "./original-mcp-domain-state.js";

export interface Board { slug: string; title: string; raw: string }
function checkedSlug(slug: string, mutation = false) {
  if (!slug || slug.length > 1024 || /[\u0000-\u001f\u007f\\:*?"<>|]/.test(slug)
    || slug.split("/").some(part => !part || part === "." || part === ".." || part.startsWith(".") || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw new CoreError("INVALID_ARGUMENT", "Provide a safe Board slug; hidden paths, traversal and platform-reserved names/characters are forbidden.");
  if (mutation && slug.split("/")[0].toLowerCase() === "system") throw new CoreError("ACCESS_DENIED", "System Boards are read-only.");
}
function boardPath(root: string, slug: string, create: boolean, database?: DatabaseSync) {
  checkedSlug(slug, create);
  const original = readOriginalMcpJournal(root);
  if (original && !readOriginalMcpTodoManifest(root, database).some(item => item.key === slug))
    throw new CoreError("NOT_AVAILABLE", "This original Board has no exact native source/genesis receipt.");
  let directory = join(root, original ? originalMcpDomainDirectory("todo") : "boards");
  for (const part of ["", ...slug.split("/")]) {
    directory = part ? join(directory, part) : directory;
    if (!existsSync(directory)) {
      if (!create) throw new CoreError("NOT_FOUND", "Board not found.");
      mkdirSync(directory, { mode: 0o700 });
    }
    const stat = lstatSync(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new CoreError("INVALID_WORKSPACE", "Board paths must be real directories, not links.");
  }
  return join(directory, todoBoardFilename);
}
export const checkedBoardPath = boardPath;
export function scanBoards(root: string, database?: DatabaseSync, includeTrashed = false): Map<string, Board> {
  const result = new Map<string, Board>();
  const original = readOriginalMcpJournal(root);
  const base = join(root, original ? originalMcpDomainDirectory("todo") : "boards");
  if (!existsSync(base)) return result;
  if (original) verifyOriginalMcpDomainFiles(root, "todo", database);
  function walk(directory: string, slug: string) {
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new CoreError("INVALID_WORKSPACE", "Board directories cannot be symlinks.");
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name), entry = lstatSync(path);
      if (entry.isSymbolicLink()) throw new CoreError("INVALID_WORKSPACE", "Board entries cannot be symlinks.");
      if (entry.isDirectory()) { checkedSlug(slug ? `${slug}/${name}` : name); walk(path, slug ? `${slug}/${name}` : name); }
      else if (/^\.pkm-write-[a-f0-9-]+$/.test(name) && entry.isFile()) continue;
      else if (name === todoBoardFilename && slug && entry.isFile()) {
        const raw = readFileSync(path, "utf8");
        try { readTodoBoard(raw); }
        catch (error) { throw new CoreError("INVALID_DOCUMENT", `Invalid Board ${slug}: ${error instanceof Error ? error.message : String(error)}`); }
        result.set(slug, { slug, title: slug.split("/").at(-1)!, raw });
      } else throw new CoreError("INVALID_DOCUMENT", `Unsupported Board entry: ${slug}/${name}`);
    }
  }
  walk(base, "");
  if (original) {
    const files = readOriginalMcpTodoManifest(root, database);
    if ([...result.keys()].some(slug => !files.some(item => item.key === slug)))
      throw new CoreError("NATIVE_AUTHORITY_REQUIRED", "Todo enumeration requires its exact source manifest and native database scope.");
    for (const item of files) {
      const board = result.get(item.key);
      if (board) board.title = item.title!;
    }
  }
  const catalog = nativeBoardLifecycleCatalog(root, database);
  for (const [key, event] of catalog) {
    const board = result.get(key);
    if (!board) throw new CoreError("RECOVERY_CONFLICT", "Retained Board identity lost its canonical backing.", "unknown");
    board.title = event.title;
    if (!includeTrashed && event.status === "trashed") result.delete(key);
    else if (!includeTrashed) assertNativeBoardLifecycleFiles(root, event, database);
  }
  return result;
}
export function authenticateBoardWorker(root: string, slug: string, token: string) {
  if (!/^[a-f0-9]{64}$/.test(token)) throw new CoreError("ACCESS_DENIED", "Invalid Board worker token.");
  checkedSlug(slug);
  slug = resolveNativeBoardKey(root, slug);
  const board = scanBoards(root).get(slug);
  if (!board) throw new CoreError("NOT_FOUND", "Todo Board is no longer available.");
  const hash = createHash("sha256").update(token).digest("hex");
  if (readOriginalMcpJournal(root))
    return { id: authenticateOriginalMcpTodoWorker(root, slug, hash), boardWorker: { boardSlug: slug, digest: sha256(board.raw) } };
  const grant = Object.entries(todoBoardWorkers(board.raw)).find(([, candidate]) => candidate === hash);
  if (!grant) throw new CoreError("ACCESS_DENIED", "Worker token is invalid for this Board or has been rotated.");
  return { id: grant[0], boardWorker: { boardSlug: slug, digest: sha256(board.raw) } };
}
export function atomicBoardWrite(root: string, slug: string, raw: string, before: string | null, database?: DatabaseSync) {
  readTodoBoard(raw);
  const path = boardPath(root, slug, true, database);
  const digest = () => {
    if (!existsSync(path)) return null;
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new CoreError("INVALID_DOCUMENT", "Board target must be a regular file.");
    return sha256(readFileSync(path, "utf8"));
  };
  if (digest() !== before) throw new CoreError("RECOVERY_CONFLICT", `Board ${slug} changed outside the server; preserve the pending intent and reconcile.`);
  const temporary = join(dirname(path), `.pkm-write-${randomUUID()}`);
  const file = openSync(temporary, "wx", 0o600);
  try { writeFileSync(file, raw, "utf8"); fsyncSync(file); }
  finally { closeSync(file); }
  try {
    if (digest() !== before) throw new CoreError("RECOVERY_CONFLICT", `Board ${slug} changed while preparing a write.`);
    renameSync(temporary, path);
    if (process.platform !== "win32") {
      const folder = openSync(dirname(path), "r");
      try { fsyncSync(folder); } finally { closeSync(folder); }
    }
  } finally { if (existsSync(temporary)) unlinkSync(temporary); }
}
export function assertBoardFocus(slug: string, before: NoteWorkItem[], after: NoteWorkItem[], boards: Map<string, Board>) {
  for (const target of after) {
    const previous = before.find(item => item.id === target.id);
    if (target.deletedAt || target.kind === "UserStory" || target.state !== "WIP" || !target.ownerId || target.ownerId.startsWith("user:")
      || previous && !previous.deletedAt && previous.state === "WIP" && previous.ownerId === target.ownerId) continue;
    const conflicts = [...boards.values()].flatMap(board => readTodoBoard(board.raw).items.filter(item =>
      !item.deletedAt && item.kind !== "UserStory" && item.state === "WIP" && item.ownerId === target.ownerId
      && !(board.slug === slug && item.id === target.id)).map(item => ({ board_slug: board.slug, id: item.id, title: item.title.slice(0, 256), expected_digest: sha256(board.raw) })));
    if (conflicts.length) throw new CoreError("WORKITEM_FOCUS_CONFLICT", JSON.stringify({
      code: "WORKITEM_FOCUS_CONFLICT", confirmation_required: true, action_taken: false, actor_id: target.ownerId,
      target: { board_slug: slug, id: target.id }, active_workitems: conflicts.slice(0, 20), active_workitem_count: conflicts.length,
      choices: { hold_current: "Explicitly hold current work with a reason before reloading/retrying.", complete_current: "Submit the real current result before reloading/retrying.", keep_current: "Do not start the new task." },
    }));
  }
}
export function planTodo(root: string, request: StorageRequest, listChats?: () => TodoChat[], database?: DatabaseSync): {
  result: Record<string, unknown>;
  write?: { slug: string; before: string | null; raw: string };
} {
  assertOriginalMcpTodoSession(root, request.actorId, database,
    typeof request.args.board_slug === "string" ? request.args.board_slug : request.boardWorker?.boardSlug);
  if (typeof request.args.board_slug === "string")
    request = { ...request, args: { ...request.args, board_slug: resolveNativeBoardKey(root, request.args.board_slug, database) } };
  const allBoards = scanBoards(root, database);
  const allowed = readOriginalMcpJournal(root) ? originalMcpTodoAuthorizedBoardKeys(root, request.actorId, database) : undefined;
  const boards = allowed ? new Map([...allBoards].filter(([key]) => allowed.has(key))) : allBoards;
  if (request.boardWorker && (request.boardWorker.boardSlug !== request.args.board_slug
    || sha256(boards.get(request.boardWorker.boardSlug)?.raw ?? "") !== request.boardWorker.digest))
    throw new CoreError("ACCESS_DENIED", "Board worker authority changed before dispatch; authenticate again.");
  const definition = todoDefinitions.find(item => item.id === request.operation);
  if (!definition) throw new CoreError("NOT_FOUND", "Unknown Todo operation.");
  if (readOriginalMcpJournal(root) && definition.transportName === "create_board")
    throw new CoreError("NOT_AVAILABLE", "New original-root Boards require their own native Note/genesis publication admission.");
  const { operationId: _operationId, ...args } = request.args;
  let write: { slug: string; before: string | null; raw: string } | undefined;
  const store: TodoStore = {
    noteGet: slug => { const board = boards.get(slug); return board ? { title: board.title, documentKind: "todo-board" } : undefined; },
    noteWorkItemsRead: slug => {
      const board = boards.get(slug);
      if (!board) throw new CoreError("NOT_FOUND", "Board not found.");
      return readTodoBoard(board.raw);
    },
    noteWorkItemNotes: (query, limit) => {
      const matches = [...boards.values()].filter(board => `${board.slug} ${board.title}`.toLowerCase().includes(query.toLowerCase()));
      return { notes: matches.slice(0, limit).map(board => ({ slug: board.slug, title: board.title, count: readTodoBoard(board.raw).items.length, digest: sha256(board.raw) })), truncated: matches.length > limit };
    },
    noteWorkItemCommand: (slug, digest, command, actor) => {
      const board = boards.get(slug);
      if (!board) throw new CoreError("NOT_FOUND", "Board not found.");
      const raw = commandTodoBoard(board.raw, digest, command, actor);
      if (allowed && readTodoBoard(raw).items.some(item => item.state === "WIP" && item.ownerId === request.actorId)
        && [...allBoards.values()].some(other => !allowed.has(other.slug) && readTodoBoard(other.raw).items.some(item =>
          !item.deletedAt && item.state === "WIP" && item.ownerId === request.actorId)))
        throw new CoreError("NATIVE_AUTHORITY_REQUIRED", "Another source must be rebound before changing task focus.");
      assertBoardFocus(slug, readTodoBoard(board.raw).items, readTodoBoard(raw).items, boards);
      write = { slug, before: sha256(board.raw), raw };
      return readTodoBoard(raw);
    },
    // Chat ownership cannot be synthesized from a client connection.
    listChats: () => listChats?.() ?? [],
  };
  const api = createTodoApi(store);
  if (definition.transportName === "create_board") {
    const slug = String(args.board_slug);
    checkedSlug(slug, true);
    if (boards.has(slug)) throw new CoreError("CONFLICT", "Board already exists.");
    const raw = serializeTodoBoard([]);
    boards.set(slug, { slug, title: slug.split("/").at(-1)!, raw });
    return { result: api.callTodoApi("get_board", { board_slug: slug }, request.actorId), write: { slug, before: null, raw } };
  }
  if (args.board_slug !== undefined) checkedSlug(String(args.board_slug), !definition.readOnly);
  if (!listChats && definition.transportName === "assign_workitem" && String(args.owner_id).startsWith("chat:"))
    throw new CoreError("NOT_AVAILABLE", "Chat directory adapter is not configured; assigning a Chat is unavailable, not inferred from a client connection.");
  const board = boards.get(String(args.board_slug));
  if (args.expected_digest !== undefined && board && args.expected_digest !== sha256(board.raw)) throw new CoreError("CONFLICT", "Todo Board changed; reload/reconcile before continuing.");
  try {
    const result = api.callTodoApi(definition.transportName, args, request.actorId);
    if (definition.transportName === "list_agents") result.chatDirectory = {
      available: !!listChats,
      reason: listChats ? "Active native Chat sessions owned by the authenticated actor."
        : "Chat adapter not configured. Only identities recorded in this Board are listed; this is not a live Chat directory.",
    };
    return { result, ...(write ? { write } : {}) };
  } catch (error) {
    if (error instanceof CoreError) throw error;
    throw new CoreError("DOMAIN_REJECTED", error instanceof Error ? error.message : String(error));
  }
}
