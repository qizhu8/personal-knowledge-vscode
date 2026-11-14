import { constants, closeSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { CoreError } from "./contracts.js";
import { checkedBoardPath, assertBoardFocus, scanBoards } from "./boards.js";
import { checkedResourcePath } from "./document-path.js";
import {
  applyDocumentLifecycleUpdate, deserializeDocumentLifecyclePlan, planNativeBoardDocumentMove,
  readNativeBoardDocumentMove, serializeDocumentLifecyclePlan,
} from "./document-lifecycle.js";
import { readTodoBoard } from "./domain/todo-board.js";
import { rebaseMarkdownAssets } from "./domain/document-lifecycle-original.js";
import { readLegacyTodoRootProjection } from "./legacy-todo-root-projection.js";
import { atomicMarkdownWrite, decodeMarkdown, readMarkdown, scanMarkdown, sha256 } from "./markdown.js";
import {
  deserializeTrashLifecyclePlan, executeTrashLifecycle, planNativeBoardRestore, planNativeBoardTrash,
  previewNativeBoardTrash, serializeTrashLifecyclePlan,
} from "./trash-lifecycle.js";
import {
  assertNativeBoardWriteTarget, boardLifecycleFingerprint, boardLifecycleHash, boardLifecycleWorkspace, nativeBoardLifecycleCatalog,
  nativeBoardLifecycleDdl, nativeBoardLifecycleInput, nativeBoardLifecycleResult, nativeBoardPlanSchema, NATIVE_BOARD_LIFECYCLE_OPERATION,
  readNativeBoardLifecyclePending, type NativeBoardGenesis, type NativeBoardLifecycleEvent,
  type NativeBoardLifecycleInput, type NativeBoardLifecyclePlan,
} from "./native-board-lifecycle-state.js";
export { nativeBoardLifecycleResult } from "./native-board-lifecycle-state.js";

function fail(message: string): never { throw new CoreError("RECOVERY_CONFLICT", message, "unknown"); }
function transaction(db: DatabaseSync) {
  if (!db.isTransaction) fail("Board file lifecycle requires the existing workspace writer transaction and lease.");
}
function readBacking(root: string, key: string): string {
  const path = checkedResourcePath(root, `${key}.assets/pkm-todo-board.json`, false, "notes");
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 2_097_152)
    fail("Original Board backing is not bounded single-link data.");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd), raw = readFileSync(fd), after = lstatSync(path), final = fstatSync(fd);
    if (opened.dev !== stat.dev || opened.ino !== stat.ino || after.ctimeMs !== stat.ctimeMs
      || after.mtimeMs !== stat.mtimeMs || after.size !== stat.size || after.dev !== stat.dev || after.ino !== stat.ino
      || final.ctimeMs !== stat.ctimeMs || final.mtimeMs !== stat.mtimeMs || final.size !== stat.size || raw.length !== stat.size)
      fail("Original Board backing changed during read.");
    const text = raw.toString("utf8");
    if (!Buffer.from(text).equals(raw)) fail("Original Board backing is not UTF-8.");
    readTodoBoard(text);
    return text;
  } finally { closeSync(fd); }
}
function genesisFor(db: DatabaseSync, root: string, key: string, operationId: string, noteId: string, markdown: string): NativeBoardGenesis {
  const stored = db.prepare("SELECT payload FROM native_board_genesis WHERE board_key=?").get(key);
  if (stored) return nativeBoardPlanSchema.shape.genesis.parse(JSON.parse(String(stored.payload)));
  const projection = readLegacyTodoRootProjection(root)?.boards.find(board => board.slug === key);
  const canonical = db.prepare("SELECT name FROM sqlite_master WHERE name='legacy_note_workitems_canonical_source'").get()
    ? db.prepare("SELECT * FROM legacy_note_workitems_canonical_source WHERE slug=?").get(key) : undefined;
  const expectedMarkdown = projection?.markdownSha256 ?? canonical?.source_markdown_sha256;
  if (expectedMarkdown !== sha256(markdown)) fail("Board lifecycle cannot replace its exact immutable admitted descriptor.");
  let backing: string, backingPath: string | null;
  if (projection) { backing = readBacking(root, key); backingPath = `${key}.assets/pkm-todo-board.json`; }
  else {
    if (!canonical || canonical.workspace_id !== boardLifecycleWorkspace(root)
      || !["user:local", "mcp:external"].includes(String(canonical.actor_id))
      || sha256(String(canonical.source_board)) !== canonical.source_board_sha256
      || sha256(JSON.stringify({ workspaceId: canonical.workspace_id, actorId: canonical.actor_id, slug: key,
        sourceMarkdownDigest: canonical.source_markdown_sha256, nativeBoardDigest: canonical.source_board_sha256 })) !== canonical.binding_sha256)
      fail("Board lifecycle requires its exact native-created source binding.");
    let appeared = false;
    try { lstatSync(checkedResourcePath(root, `${key}.assets/pkm-todo-board.json`, false, "notes")); appeared = true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (appeared) fail("Native-backed Board cannot adopt an appearing original backing/authority.");
    backing = String(canonical.source_board); backingPath = null;
    readTodoBoard(backing);
  }
  if (projection && sha256(backing) !== projection.sha256) fail("Original Board genesis differs from its immutable projection pin.");
  return {
    workspaceId: boardLifecycleWorkspace(root), boardKey: key, noteId, firstOperationId: operationId,
    markdownPath: `${key}.md`, markdown, markdownSha256: sha256(markdown),
    backingPath, backing, backingSha256: sha256(backing),
  };
}
function updatedBoardSource(raw: string, noteId: string, path: string, input: Extract<NativeBoardLifecycleInput, { kind: "move" }>) {
  const updated = decodeMarkdown(noteId, raw, path);
  if (!updated.metadata.has("documentId") && !updated.metadata.has("knowledgeId")) updated.metadata.set("documentId", noteId);
  if (input.title !== undefined) updated.metadata.set("title", input.title);
  if (input.description !== undefined) updated.metadata.set("description", input.description);
  if (input.tags !== undefined) updated.metadata.set("tags", input.tags);
  updated.metadata.set("revision", updated.record.revision + 1);
  return { source: `---\n${updated.metadata.toString()}---\n${updated.record.content}`,
    title: input.title ?? String(updated.metadata.get("title") ?? updated.record.title) };
}
/** The caller authenticates its opaque synthetic-root authority and holds the normal writer fence. */
export function prepareNativeBoardLifecycle(db: DatabaseSync, root: string, value: NativeBoardLifecycleInput): NativeBoardLifecyclePlan {
  transaction(db);
  const input = nativeBoardLifecycleInput.parse(value);
  if (db.prepare("SELECT 1 FROM pending_document_lifecycle WHERE singleton=1").get())
    fail("Another document lifecycle intent requires exact recovery.");
  db.exec(nativeBoardLifecycleDdl);
  const catalog = nativeBoardLifecycleCatalog(root, db), previous = catalog.get(input.boardSlug);
  if (!previous && db.prepare("SELECT 1 FROM native_board_genesis WHERE board_key=?").get(input.boardSlug))
    fail("An unfinished or orphaned Board genesis requires exact recovery.");
  if ((previous?.status === "trashed") !== (input.kind === "restore"))
    throw new CoreError("CONFLICT", "Only an active Board may move/enter Trash, and only its exact Trash entry may restore.");
  const nativeRaw = readFileSync(checkedBoardPath(root, input.boardSlug, false), "utf8");
  readTodoBoard(nativeRaw);
  if (sha256(nativeRaw) !== input.expectedDigest) throw new CoreError("CONFLICT", "Board changed; reload before changing its files.");
  const beforePath = previous?.path ?? `${input.boardSlug}.md`;
  let genesis: NativeBoardGenesis, noteId: string, title: string, documentSha256: string;
  let path = beforePath, movePlan: string | null = null, beforeSource: string | null = null,
    updatedSource: string | null = null, trashPlan: string | null = null;
  if (input.kind === "restore") {
    if (!previous?.trashPlan || previous.input.expectedDigest !== input.expectedDigest
      || previous.documentSha256 !== input.expectedDocumentDigest) throw new CoreError("CONFLICT", "Trashed Board pins changed.");
    const original = deserializeTrashLifecyclePlan(previous.trashPlan);
    const pins = scanMarkdown(root).map(({ record }) => ({ id: record.id, area: record.area, path: record.path,
      revision: record.revision, sha256: record.sha256 }));
    const restore = planNativeBoardRestore(root, "user:local", original, { operationId: input.operationId,
      entryId: original.entryId, expectedScanRevision: sha256(JSON.stringify(pins)) }, previous.noteId);
    assertBoardFocus(input.boardSlug, [], readTodoBoard(nativeRaw).items, scanBoards(root, db));
    trashPlan = serializeTrashLifecyclePlan(restore);
    noteId = previous.noteId; title = previous.title; documentSha256 = previous.documentSha256;
    genesis = genesisFor(db, root, input.boardSlug, input.operationId, noteId, "");
  } else {
    const documents = scanMarkdown(root), matches = documents.filter(doc => doc.record.area === "notes" && doc.record.path === beforePath);
    if (matches.length !== 1 || matches[0]!.metadata.get("documentKind") !== "todo-board")
      fail("Board lifecycle requires its exact active Note descriptor.");
    const note = matches[0]!;
    if (note.record.sha256 !== input.expectedDocumentDigest || previous && (previous.noteId !== note.record.id
      || previous.documentSha256 !== note.record.sha256)) throw new CoreError("CONFLICT", "Board Note changed; reload its current identity and path.");
    noteId = note.record.id; title = String(note.metadata.get("title") ?? note.record.title);
    genesis = genesisFor(db, root, input.boardSlug, input.operationId, noteId, note.raw);
    documentSha256 = note.record.sha256;
    if (input.kind === "move") {
      assertNativeBoardWriteTarget(root, input.destinationPath, db, input.boardSlug, input.destinationPath !== beforePath);
      const args = { id: noteId, area: "notes" as const, path: beforePath, destinationPath: input.destinationPath,
        expectedRevision: note.record.revision, expectedSha256: note.record.sha256 };
      if (beforePath !== input.destinationPath) {
        const preview = readNativeBoardDocumentMove(root, documents,
          { operation: "knowledge.document.lifecycle.preview", actorId: "user:local", args }, noteId);
        const plan = planNativeBoardDocumentMove(root, documents, { operation: "knowledge.document.move", actorId: "user:local",
          args: { ...args, operationId: input.operationId, expectedScanRevision: preview.scanRevision,
            expectedPairedTreeDigest: preview.pairedAssets.digest, expectedDestinationSha256: null, expectedDestinationTreeDigest: null } }, noteId);
        movePlan = serializeDocumentLifecyclePlan(plan);
      }
      const updated = updatedBoardSource(note.raw, noteId, beforePath, input);
      beforeSource = note.raw; updatedSource = updated.source;
      path = input.destinationPath; title = updated.title;
      documentSha256 = sha256(beforePath === path ? updatedSource
        : rebaseMarkdownAssets(join(root, "notes"), beforePath, path, updatedSource));
    } else {
      const args = { area: "notes", path: beforePath, kind: "document" };
      const preview = previewNativeBoardTrash(root, args, noteId);
      trashPlan = serializeTrashLifecyclePlan(planNativeBoardTrash(root, "user:local", {
        ...args, operationId: input.operationId, expectedTreeSha256: preview.treeSha256,
        expectedScanRevision: preview.scanRevision, entryIdFormat: "original",
      }, noteId));
    }
  }
  const event: NativeBoardLifecycleEvent = {
    schema: "pkm.native-board-lifecycle/v1", workspaceId: genesis.workspaceId, boardKey: input.boardSlug, noteId, input,
    previousDigest: previous ? boardLifecycleHash(previous) : null, genesisDigest: boardLifecycleHash(genesis),
    beforePath, path, status: input.kind === "trash" ? "trashed" : "active", title, documentSha256,
    aliases: [...new Set([...(previous?.aliases ?? [genesis.markdownPath]), path])],
    trashPlan: input.kind === "trash" ? trashPlan : null,
  };
  const plan = nativeBoardPlanSchema.parse({ kind: "native-board-lifecycle", event, genesis, movePlan, beforeSource, updatedSource, trashPlan });
  if (!db.prepare("SELECT 1 FROM native_board_genesis WHERE board_key=?").get(input.boardSlug))
    db.prepare("INSERT INTO native_board_genesis VALUES(?,?,?)").run(input.boardSlug, JSON.stringify(genesis), event.genesisDigest);
  db.prepare("INSERT INTO pending_document_lifecycle VALUES(1,?,?,?,?,?)").run(
    input.operationId, boardLifecycleFingerprint(input), "user:local", NATIVE_BOARD_LIFECYCLE_OPERATION, JSON.stringify(plan));
  return plan;
}

/** Recovery is deterministic and must run before indexing; never grants an alternate writer path. */
export function recoverNativeBoardLifecycle(db: DatabaseSync, root: string): unknown {
  transaction(db);
  const plan = readNativeBoardLifecyclePending(db, root);
  if (!plan) return undefined;
  const event = plan.event, previous = nativeBoardLifecycleCatalog(root, db).get(event.boardKey);
  const expectedAliases = [...new Set([...(previous?.aliases ?? [plan.genesis.markdownPath]), event.path])];
  if (event.previousDigest !== (previous ? boardLifecycleHash(previous) : null)
    || event.beforePath !== (previous?.path ?? plan.genesis.markdownPath)
    || event.status !== (event.input.kind === "trash" ? "trashed" : "active")
    || (previous?.status === "trashed") !== (event.input.kind === "restore")
    || event.input.kind !== "move" && event.path !== event.beforePath
    || event.input.kind === "move" && event.path !== event.input.destinationPath
    || JSON.stringify(event.aliases) !== JSON.stringify(expectedAliases)
    || !previous && plan.genesis.firstOperationId !== event.input.operationId
    || sha256(readFileSync(checkedBoardPath(root, event.boardKey, false), "utf8")) !== event.input.expectedDigest)
    fail("Board lifecycle recovery conflicts with its prior identity or native Board bytes.");
  const commit = () => {
    const payload = JSON.stringify(event), result = nativeBoardLifecycleResult(event);
    db.prepare("INSERT INTO native_board_lifecycle_event(operation_id,board_key,payload,payload_sha256) VALUES(?,?,?,?)")
      .run(event.input.operationId, event.boardKey, payload, boardLifecycleHash(event));
    db.prepare("INSERT INTO receipts VALUES(?,?,?,?,?,?)").run(event.input.operationId, boardLifecycleFingerprint(event.input),
      JSON.stringify(result), "user:local", NATIVE_BOARD_LIFECYCLE_OPERATION, new Date().toISOString());
    db.prepare("DELETE FROM pending_document_lifecycle WHERE singleton=1").run();
    return result;
  };
  if (event.input.kind === "move") {
    if (plan.beforeSource === null || plan.updatedSource === null || plan.trashPlan !== null
      || sha256(plan.beforeSource) !== event.input.expectedDocumentDigest) fail("Board move lacks its exact compound plan.");
    const updated = updatedBoardSource(plan.beforeSource, event.noteId, event.beforePath, event.input);
    if (updated.source !== plan.updatedSource || updated.title !== event.title
      || sha256(event.beforePath === event.path ? updated.source
        : rebaseMarkdownAssets(join(root, "notes"), event.beforePath, event.path, updated.source)) !== event.documentSha256)
      fail("Board metadata update differs from its exact requested fields.");
    if (event.beforePath === event.path) {
      if (plan.movePlan !== null) fail("In-place Board metadata update cannot contain a move plan.");
      const current = readMarkdown(root, event.noteId, event.path);
      if (!current) fail("Board metadata source disappeared.");
      if (current.raw !== plan.updatedSource) {
        if (current.raw !== plan.beforeSource) fail("Board metadata changed outside its durable intent.");
        atomicMarkdownWrite(root, event.noteId, plan.updatedSource, event.input.expectedDocumentDigest, event.path, "notes", event.input.operationId);
      }
      return commit();
    }
    if (!plan.movePlan) fail("Board move lacks its paired-tree plan.");
    const move = deserializeDocumentLifecyclePlan(plan.movePlan);
    if (move.boardIdentity !== event.noteId || move.actorId !== "user:local" || move.operationId !== event.input.operationId
      || move.documentCas.path !== event.beforePath || move.result.document.afterPath !== event.path
      || move.documentCas.sha256 !== event.input.expectedDocumentDigest
      || move.changes[1]!.before!.toString("utf8") !== plan.beforeSource) fail("Board move envelope differs from its Note/path CAS.");
    const result = applyDocumentLifecycleUpdate(root, move, Buffer.from(plan.updatedSource), event.input.operationId, true);
    if (result.document.afterSha256 !== event.documentSha256) fail("Board move after digest differs from its exact event.");
    return commit();
  }
  if (!plan.trashPlan || plan.movePlan !== null || plan.beforeSource !== null || plan.updatedSource !== null) fail("Board Trash/restore lacks its exact compound plan.");
  const trash = deserializeTrashLifecyclePlan(plan.trashPlan);
  if (trash.boardIdentity !== event.noteId || trash.actorId !== "user:local" || trash.operationId !== event.input.operationId
    || trash.action !== event.input.kind || trash.path !== event.path || trash.area !== "notes"
    || trash.documentPins[0]?.sha256 !== event.input.expectedDocumentDigest
    || event.documentSha256 !== event.input.expectedDocumentDigest
    || event.input.kind === "trash" && event.trashPlan !== plan.trashPlan)
    fail("Board Trash/restore envelope differs from its stable identity and exact backup.");
  const directory = join(root, "notes", ".trash");
  try { mkdirSync(directory, { mode: 0o700 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o7077) !== 0)
    fail("Board Trash root is not a private owned directory.");
  const parent = openSync(join(root, "notes"), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { fsyncSync(parent); } finally { closeSync(parent); }
  let result: unknown;
  executeTrashLifecycle(root, trash, {
    withWriterLock(work) { transaction(db); return work(); },
    persistIntent() { fail("Board recovery cannot substitute an uncommitted Trash intent."); },
    readIntent(id) {
      const current = db.prepare("SELECT operation_id,plan FROM pending_document_lifecycle WHERE singleton=1").get();
      if (!current) return undefined;
      if (id !== event.input.operationId || current.operation_id !== id || current.plan !== JSON.stringify(plan))
        fail("Board Trash host journal changed before publication.");
      return plan.trashPlan!;
    },
    commitAtomic() { result = commit(); },
  }, true);
  return result;
}
