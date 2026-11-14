import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { CoreError, type Actor } from "./contracts.js";
import { readNativeBoardGenesis, resolveNativeBoardKey } from "./native-board-lifecycle-state.js";
import type { Storage } from "./storage.js";
import { checkedDocumentPath, checkedResourcePath } from "./document-path.js";
import { decodeMarkdown } from "./markdown.js";
import { scanBoards } from "./boards.js";
import { readTodoBoard, todoBoardFilename } from "./domain/todo-board.js";
import { preflightLegacyNoteWorkItemsAdmission } from "./legacy-note-workitems-admission.js";
import {
  createLegacyNoteWorkItemsJournal, LEGACY_NOTE_WORKITEMS_JOURNAL_DDL,
  legacyNoteWorkItemsReceiptSchema, type LegacyNoteWorkItemsNativeJournal,
} from "./legacy-note-workitems-journal.js";
import {
  createNativeLegacyNoteWorkItemsHost, type LegacyNoteWorkItemsPolicy,
} from "./legacy-note-workitems.js";
import { legacyNoteWorkItemsDefinitions } from "./legacy-note-workitems-contracts.js";
import { todoDefinitions } from "./todo-definitions.js";

const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const admissionDigest = /^[a-f0-9]{64}$/;

export interface LegacyNoteWorkItemsAdmissionPin {
  slug: string;
  sourceMarkdownDigest: string;
  sourceBoardDigest: string;
  nativeBoardDigest: string;
}

export interface NativeLegacyNoteWorkItemsPolicy extends LegacyNoteWorkItemsPolicy {
  admissions?: readonly LegacyNoteWorkItemsAdmissionPin[];
  canonicalSources?: readonly Readonly<{ slug: string; sourceMarkdownDigest: string; nativeBoardDigest: string; actorId: string }>[];
  recoveryActor?(request: Readonly<{
    operation: string;
    args: Readonly<Record<string, unknown>>;
    actorId: string;
  }>): Actor | undefined;
}

export const LEGACY_NOTE_WORKITEMS_NATIVE_DDL = `
CREATE TABLE IF NOT EXISTS legacy_note_workitems_admission (
  slug TEXT PRIMARY KEY, source_markdown_sha256 TEXT NOT NULL, source_board_sha256 TEXT NOT NULL,
  native_board_sha256 TEXT NOT NULL, admitted_at TEXT NOT NULL, source_kind TEXT NOT NULL DEFAULT 'original-pair'
);
CREATE TRIGGER IF NOT EXISTS legacy_note_workitems_admission_no_update
BEFORE UPDATE ON legacy_note_workitems_admission
BEGIN SELECT RAISE(ABORT, 'original Note admission is immutable'); END;
CREATE TRIGGER IF NOT EXISTS legacy_note_workitems_admission_no_delete
BEFORE DELETE ON legacy_note_workitems_admission
BEGIN SELECT RAISE(ABORT, 'original Note admission is immutable'); END;
CREATE TABLE IF NOT EXISTS legacy_note_workitems_canonical_source (
  slug TEXT PRIMARY KEY, source_markdown_sha256 TEXT NOT NULL, source_board_sha256 TEXT NOT NULL,
  source_board TEXT NOT NULL, workspace_id TEXT NOT NULL, actor_id TEXT NOT NULL, binding_sha256 TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS legacy_note_workitems_canonical_source_no_update
BEFORE UPDATE ON legacy_note_workitems_canonical_source
BEGIN SELECT RAISE(ABORT, 'native-backed original Note source is immutable'); END;
CREATE TRIGGER IF NOT EXISTS legacy_note_workitems_canonical_source_no_delete
BEFORE DELETE ON legacy_note_workitems_canonical_source
BEGIN SELECT RAISE(ABORT, 'native-backed original Note source is immutable'); END;
CREATE TABLE IF NOT EXISTS legacy_note_workitems_native_binding (
  operation_id TEXT PRIMARY KEY, bridge_fingerprint TEXT NOT NULL, bridge_actor_id TEXT NOT NULL,
  bridge_operation TEXT NOT NULL, bridge_request_json TEXT NOT NULL, native_fingerprint TEXT NOT NULL,
  native_actor_id TEXT NOT NULL, native_operation TEXT NOT NULL, native_result_json TEXT NOT NULL,
  bridge_result_json TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS legacy_note_workitems_native_binding_no_update
BEFORE UPDATE ON legacy_note_workitems_native_binding
BEGIN SELECT RAISE(ABORT, 'original Note native binding is immutable'); END;
CREATE TRIGGER IF NOT EXISTS legacy_note_workitems_native_binding_no_delete
BEFORE DELETE ON legacy_note_workitems_native_binding
BEGIN SELECT RAISE(ABORT, 'original Note native binding is immutable'); END;
CREATE TRIGGER IF NOT EXISTS legacy_note_workitems_receipt_requires_native_binding
BEFORE INSERT ON legacy_note_workitems_receipt
WHEN NOT EXISTS (
  SELECT 1 FROM legacy_note_workitems_native_binding b
  JOIN receipts r ON r.operation_id=b.operation_id
  WHERE b.operation_id=NEW.operation_id AND b.bridge_fingerprint=NEW.fingerprint
    AND b.bridge_actor_id=NEW.actor_id AND b.bridge_operation=NEW.operation
    AND b.bridge_request_json=NEW.request_json AND b.bridge_result_json=NEW.result_json
    AND r.fingerprint=b.native_fingerprint AND r.actor_id=b.native_actor_id
    AND r.operation=b.native_operation AND b.native_actor_id=NEW.actor_id
)
BEGIN SELECT RAISE(ABORT, 'original Note receipt lacks its canonical native operation binding'); END;`;

function readVerified(path: string): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new CoreError("INVALID_DOCUMENT", "Pinned Note authority must be a regular file.");
    const bytes = readFileSync(fd);
    const text = bytes.toString("utf8");
    if (!Buffer.from(text, "utf8").equals(bytes)) {
      throw new CoreError("INVALID_DOCUMENT", "Pinned Note authority is not valid UTF-8.");
    }

    return text;
  } finally { closeSync(fd); }
}

function canonicalSourceBinding(row: Record<string, unknown>) {
  return hash(JSON.stringify({ workspaceId: row.workspace_id, actorId: row.actor_id, slug: row.slug,
    sourceMarkdownDigest: row.source_markdown_sha256, nativeBoardDigest: row.source_board_sha256 }));
}
function assertOriginalBackingAbsent(root: string, slug: string) {
  try {
    readVerified(checkedResourcePath(root, `${slug}.assets/${todoBoardFilename}`, false, "notes"));
    throw new CoreError("CONFLICT", "Native-backed Note authority cannot ignore an appearing original source backing.");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
}
function canonicalSourceSchema(database: DatabaseSync): "legacy" | "current" {
  const hasKind = database.prepare("PRAGMA table_info(legacy_note_workitems_admission)").all()
    .some(column => column.name === "source_kind");
  const hasSource = !!database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='legacy_note_workitems_canonical_source'").get();
  if (hasKind !== hasSource)
    throw new CoreError("INVALID_WORKSPACE", "Original Note source-kind and canonical source schemas are incomplete.");
  return hasKind ? "current" : "legacy";
}
function originalBoardSource(database: DatabaseSync, root: string, slug: string): string {
  const genesis = readNativeBoardGenesis(root, slug, database);
  if (genesis?.backingPath) return genesis.backing;
  if (canonicalSourceSchema(database) === "legacy")
    return readVerified(checkedResourcePath(root, `${slug}.assets/${todoBoardFilename}`, false, "notes"));
  const source = database.prepare(`SELECT s.*,a.source_markdown_sha256 AS admitted_markdown,a.source_kind,
    a.source_board_sha256 AS admitted_board,a.native_board_sha256 AS admitted_native
    FROM legacy_note_workitems_canonical_source s LEFT JOIN legacy_note_workitems_admission a ON a.slug=s.slug
    WHERE s.slug=?`).get(slug);
  if (!source) {
    const admission = database.prepare("SELECT source_kind FROM legacy_note_workitems_admission WHERE slug=?").get(slug);
    if (admission?.source_kind === "native-board")
      throw new CoreError("INVALID_WORKSPACE", "Native-backed original Note admission is missing its immutable source.");
    return readVerified(checkedResourcePath(root, `${slug}.assets/${todoBoardFilename}`, false, "notes"));
  }
  const identity = JSON.parse(readVerified(join(root, ".pkm-next-workspace")));
  if (typeof source.source_board !== "string" || hash(source.source_board) !== source.source_board_sha256
    || source.source_markdown_sha256 !== source.admitted_markdown || source.source_board_sha256 !== source.admitted_board
    || source.source_board_sha256 !== source.admitted_native || source.source_kind !== "native-board" || source.workspace_id !== identity.id
    || typeof source.actor_id !== "string" || !source.actor_id || canonicalSourceBinding(source) !== source.binding_sha256)
    throw new CoreError("INVALID_WORKSPACE", "Native-backed original Note source lost its exact immutable admission binding.");
  assertOriginalBackingAbsent(root, slug);
  readTodoBoard(source.source_board);
  return source.source_board;
}

export function initializeLegacyNoteWorkItemsSchema(database: DatabaseSync): void {
  const version = Number(database.prepare("PRAGMA user_version").get()?.user_version);
  const journalExists = database.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name IN (
    'legacy_note_workitems_admission','legacy_note_workitems_intent','legacy_note_workitems_receipt',
    'legacy_note_workitems_native_binding') LIMIT 1`).get();
  const sourceExists = database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='legacy_note_workitems_canonical_source'").get();
  if (version < 17 && !journalExists && sourceExists) {
    const columns = database.prepare("PRAGMA table_info(legacy_note_workitems_canonical_source)").all().map(row => row.name);
    const triggers = database.prepare(`SELECT name,sql FROM sqlite_master WHERE type='trigger'
      AND tbl_name='legacy_note_workitems_canonical_source'`).all();
    if (JSON.stringify(columns) !== JSON.stringify([
      "slug", "source_markdown_sha256", "source_board_sha256", "source_board", "workspace_id", "actor_id", "binding_sha256",
    ]) || database.prepare("SELECT 1 FROM legacy_note_workitems_canonical_source LIMIT 1").get()
      || !["legacy_note_workitems_canonical_source_no_update", "legacy_note_workitems_canonical_source_no_delete"]
        .every(name => triggers.some(row => row.name === name && String(row.sql).toLowerCase().includes("raise(abort"))))
      throw new CoreError("INVALID_WORKSPACE", "Pre-journal original Note source schema contains unknown authority.");
  } else canonicalSourceSchema(database);
  database.exec("SAVEPOINT legacy_note_source_schema");
  try {
    database.exec(LEGACY_NOTE_WORKITEMS_JOURNAL_DDL);
    database.exec(LEGACY_NOTE_WORKITEMS_NATIVE_DDL);
    const columns = database.prepare("PRAGMA table_info(legacy_note_workitems_admission)").all();
    if (!columns.some(column => column.name === "source_kind"))
      database.exec("ALTER TABLE legacy_note_workitems_admission ADD COLUMN source_kind TEXT NOT NULL DEFAULT 'original-pair'");
    database.exec("RELEASE legacy_note_source_schema");
  } catch (error) {
    database.exec("ROLLBACK TO legacy_note_source_schema; RELEASE legacy_note_source_schema");
    throw error;
  }
}

export function inspectLegacyNoteWorkItemsState(database: DatabaseSync): void {
  const tables = new Set((database.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map(row => row.name));
  const requiredTables = ["legacy_note_workitems_intent", "legacy_note_workitems_receipt",
    "legacy_note_workitems_admission", "legacy_note_workitems_native_binding"];
  if (requiredTables.some(name => !tables.has(name))) {
    throw new CoreError("INVALID_WORKSPACE", "Original Note journal schema is incomplete.");
  }
  const sourceSchema = canonicalSourceSchema(database);
  const expectedColumns: Record<string, string[]> = {
    legacy_note_workitems_intent: ["singleton", "operation_id", "fingerprint", "actor_id", "operation",
      "request_json", "native_operation", "native_args", "expected_json", "before_json"],
    legacy_note_workitems_receipt: ["operation_id", "fingerprint", "actor_id", "operation", "actor_json", "request_json", "result_json"],
    legacy_note_workitems_admission: ["slug", "source_markdown_sha256", "source_board_sha256", "native_board_sha256", "admitted_at",
      ...(sourceSchema === "current" ? ["source_kind"] : [])],
    legacy_note_workitems_native_binding: ["operation_id", "bridge_fingerprint", "bridge_actor_id", "bridge_operation",
      "bridge_request_json", "native_fingerprint", "native_actor_id", "native_operation", "native_result_json", "bridge_result_json"],
  };
  if (sourceSchema === "current") expectedColumns.legacy_note_workitems_canonical_source =
    ["slug", "source_markdown_sha256", "source_board_sha256", "source_board", "workspace_id", "actor_id", "binding_sha256"];
  for (const [table, columns] of Object.entries(expectedColumns)) {
    const actual = (database.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>).map(row => row.name);
    if (JSON.stringify(actual) !== JSON.stringify(columns)) {
      throw new CoreError("INVALID_WORKSPACE", "Original Note journal table columns differ from the qualified schema.");
    }
  }
  const triggers = new Map((database.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger'")
    .all() as Array<{ name: string; sql: string }>).map(row => [row.name, row.sql.toLowerCase()]));
  const immutable = [
    "legacy_note_workitems_receipt_no_update", "legacy_note_workitems_receipt_no_delete",
    "legacy_note_workitems_admission_no_update", "legacy_note_workitems_admission_no_delete",
    "legacy_note_workitems_native_binding_no_update", "legacy_note_workitems_native_binding_no_delete",
  ];
  if (tables.has("legacy_note_workitems_canonical_source")) {
    immutable.push("legacy_note_workitems_canonical_source_no_update", "legacy_note_workitems_canonical_source_no_delete");
    const sources = database.prepare(`SELECT s.*,a.source_markdown_sha256 AS admitted_markdown,a.source_kind,
      a.source_board_sha256 AS admitted_board,a.native_board_sha256 AS admitted_native
      FROM legacy_note_workitems_canonical_source s LEFT JOIN legacy_note_workitems_admission a ON a.slug=s.slug`).all();
    for (const row of sources) {
      if (typeof row.source_board !== "string" || hash(row.source_board) !== row.source_board_sha256
        || row.source_markdown_sha256 !== row.admitted_markdown || row.source_board_sha256 !== row.admitted_board
        || row.source_board_sha256 !== row.admitted_native || row.source_kind !== "native-board" || !row.workspace_id || !row.actor_id
        || canonicalSourceBinding(row) !== row.binding_sha256)
        throw new CoreError("INVALID_WORKSPACE", "Native-backed original Note source has invalid immutable pins.");
      readTodoBoard(row.source_board);
    }
    const invalidAdmission = database.prepare(`SELECT a.slug FROM legacy_note_workitems_admission a
      LEFT JOIN legacy_note_workitems_canonical_source s ON s.slug=a.slug
      WHERE a.source_kind NOT IN ('original-pair','native-board')
        OR a.source_kind='native-board' AND s.slug IS NULL OR a.source_kind='original-pair' AND s.slug IS NOT NULL`).get();
    if (invalidAdmission) throw new CoreError("INVALID_WORKSPACE", "Original Note admission lost its exact source-kind binding.");
  }
  if (immutable.some(name => !triggers.get(name)?.includes("raise(abort"))) {
    throw new CoreError("INVALID_WORKSPACE", "Original Note receipt or admission immutability triggers are missing.");
  }
  const bindingTrigger = triggers.get("legacy_note_workitems_receipt_requires_native_binding") ?? "";
  if (!bindingTrigger.includes("raise(abort") || !bindingTrigger.includes("join receipts")
    || !bindingTrigger.includes("bridge_fingerprint") || !bindingTrigger.includes("native_fingerprint")
    || !bindingTrigger.includes("native_actor_id")) {
    throw new CoreError("INVALID_WORKSPACE", "Original Note receipt insertion is not protected by its canonical native binding.");
  }
  const intent = database.prepare("SELECT * FROM legacy_note_workitems_intent").all() as Array<Record<string, unknown>>;
  if (intent.length) throw new CoreError("BUSY", "An original Note write requires exact recovery before backup or reads.", "unknown");
  const rows = database.prepare(`SELECT c.operation_id,c.fingerprint,c.actor_id,c.operation,c.actor_json,c.request_json,c.result_json,
    b.operation_id AS bound_id,b.bridge_fingerprint,b.bridge_actor_id,b.bridge_operation,b.bridge_request_json,
    b.native_fingerprint,b.native_actor_id,b.native_operation,b.native_result_json,b.bridge_result_json,
    r.operation_id AS native_id,r.fingerprint AS receipt_fingerprint,r.actor_id AS receipt_actor_id,
    r.operation AS receipt_operation,r.result AS receipt_result
    FROM legacy_note_workitems_receipt c
    LEFT JOIN legacy_note_workitems_native_binding b ON b.operation_id=c.operation_id
    LEFT JOIN receipts r ON r.operation_id=c.operation_id`).all() as Array<Record<string, unknown>>;
  const boundCount = Number(database.prepare("SELECT COUNT(*) AS count FROM legacy_note_workitems_native_binding").get()?.count);
  if (rows.length !== boundCount) throw new CoreError("INVALID_WORKSPACE", "Original Note bindings and receipts are incomplete.");
  for (const row of rows) {
    try {
      const actor = JSON.parse(String(row.actor_json)) as Actor;
      const args = JSON.parse(String(row.request_json)) as Record<string, unknown>;
      const definition = legacyNoteWorkItemsDefinitions.find(item => item.id === row.operation);
      const canonical = todoDefinitions.find(item => item.id === row.native_operation);
      const receipt = legacyNoteWorkItemsReceiptSchema.parse(JSON.parse(String(row.result_json)));
      const nativeResult = canonical?.output.safeParse(JSON.parse(String(row.native_result_json)));
      if (row.bound_id !== row.operation_id || row.native_id !== row.operation_id
        || row.bridge_fingerprint !== row.fingerprint || row.bridge_actor_id !== row.actor_id
        || row.bridge_operation !== row.operation || row.bridge_request_json !== row.request_json
        || row.bridge_result_json !== row.result_json || row.native_fingerprint !== row.receipt_fingerprint
        || row.native_actor_id !== row.actor_id || row.receipt_actor_id !== row.actor_id
        || row.native_operation !== row.receipt_operation || row.native_operation !== canonical?.id
        || row.native_result_json !== row.receipt_result || actor.id !== row.actor_id || actor.canWrite !== true
        || !definition || definition.readOnly || !definition.input.safeParse(args).success
        || args.operationId !== row.operation_id || !nativeResult?.success
        || hash(JSON.stringify({ operation: row.operation, actor, args })) !== row.fingerprint
        || JSON.stringify(receipt) !== row.result_json) {
        throw new Error("receipt binding mismatch");
      }
    } catch {
      throw new CoreError("INVALID_WORKSPACE", "Original Note receipt is not bound to its exact authenticated canonical operation.");
    }
  }
}

export function verifyLegacyNoteWorkItemsWorkspace(database: DatabaseSync, root: string): void {
  inspectLegacyNoteWorkItemsState(database);
  const rows = database.prepare(`SELECT slug,source_markdown_sha256,source_board_sha256,native_board_sha256
    FROM legacy_note_workitems_admission ORDER BY slug`).all() as Array<{
      slug: string; source_markdown_sha256: string; source_board_sha256: string; native_board_sha256: string;
    }>;
  for (const row of rows) {
    if (!row.slug || !admissionDigest.test(row.source_markdown_sha256)
      || !admissionDigest.test(row.source_board_sha256) || !admissionDigest.test(row.native_board_sha256)) {
      throw new CoreError("INVALID_WORKSPACE", "Original Note admission has malformed source pins.");
    }
    const markdown = readNativeBoardGenesis(root, row.slug, database)?.markdown
      ?? readVerified(checkedDocumentPath(root, `${row.slug}.md`, false, "notes"));
    const note = decodeMarkdown("native-note-admission", markdown, `${row.slug}.md`, "notes");
    if (note.metadata.get("documentKind") !== "todo-board" || hash(markdown) !== row.source_markdown_sha256) {
      throw new CoreError("CONFLICT", "Original Note changed after its durable Board admission.");
    }
    const sourceBoard = originalBoardSource(database, root, row.slug);
    if (hash(sourceBoard) !== row.source_board_sha256) {
      throw new CoreError("CONFLICT", "Original Note Board backing changed after its durable admission.");
    }
    readTodoBoard(sourceBoard);
    const native = scanBoards(root, database, true).get(row.slug);
    if (!native) throw new CoreError("NOT_FOUND", "Admitted native Board is unavailable.");
    readTodoBoard(native.raw);
  }
}

export function createNativeLegacyNoteWorkItemsComposition(
  storage: Storage, database: DatabaseSync, policy: NativeLegacyNoteWorkItemsPolicy,
  invokeCoreTodo: (operation: string, args: Record<string, unknown>, actor: Actor) => Promise<Record<string, unknown>>,
) {
  const root = storage.workspaceRoot();
  const readPinnedAuthority = (slug: string) => {
    const historical = readNativeBoardGenesis(root, slug, database);
    const markdown = historical?.markdown ?? readVerified(checkedDocumentPath(root, `${slug}.md`, false, "notes"));
    const note = decodeMarkdown("native-note-admission", markdown, `${slug}.md`, "notes");
    if (note.metadata.get("documentKind") !== "todo-board") {
      throw new CoreError("NOT_AVAILABLE", "Only an original Note-attached Board can be explicitly admitted.");
    }
    const sourceBoard = originalBoardSource(database, root, slug);
    return { markdown, sourceBoard };
  };
  const rowFor = (slug: string) => database.prepare(`SELECT source_markdown_sha256,source_board_sha256,native_board_sha256
    FROM legacy_note_workitems_admission WHERE slug=?`).get(slug) as {
      source_markdown_sha256: string; source_board_sha256: string; native_board_sha256: string;
    } | undefined;
  const boardFor = (slug: string) => {
    slug = resolveNativeBoardKey(root, slug, database);
    const admitted = rowFor(slug);
    if (!admitted) throw new CoreError("NOT_AVAILABLE", "This original Note Board has no explicit durable native admission.");
    const source = readPinnedAuthority(slug);
    if (hash(source.markdown) !== admitted.source_markdown_sha256 || hash(source.sourceBoard) !== admitted.source_board_sha256) {
      throw new CoreError("CONFLICT", "The immutable original Note or attached Board changed after admission.");
    }
    const board = scanBoards(root, database).get(slug);
    if (!board) throw new CoreError("NOT_FOUND", "Admitted native Board is unavailable.");
    readTodoBoard(board.raw);
    return board.raw;
  };

  async function admitConfiguredBoards(): Promise<void> {
    for (const pin of policy.canonicalSources ?? []) {
      if (!pin.slug || !pin.actorId || !admissionDigest.test(pin.sourceMarkdownDigest) || !admissionDigest.test(pin.nativeBoardDigest))
        throw new CoreError("INVALID_CONFIGURATION", "Native-backed Note admission pins are malformed.");
      if (rowFor(pin.slug)) throw new CoreError("CONFLICT", "Native-backed admission cannot replace an existing source admission.");
      const markdown = readNativeBoardGenesis(root, pin.slug, database)?.markdown
        ?? readVerified(checkedDocumentPath(root, `${pin.slug}.md`, false, "notes"));
      const note = decodeMarkdown("native-note-admission", markdown, `${pin.slug}.md`, "notes");
      const native = scanBoards(root, database, true).get(pin.slug);
      if (note.metadata.get("documentKind") !== "todo-board" || hash(markdown) !== pin.sourceMarkdownDigest
        || !native || hash(native.raw) !== pin.nativeBoardDigest)
        throw new CoreError("CONFLICT", "Native-backed Note descriptor or authority changed after explicit selection.");
      assertOriginalBackingAbsent(root, pin.slug);
      readTodoBoard(native.raw);
      const workspaceId = JSON.parse(readVerified(join(root, ".pkm-next-workspace"))).id;
      const binding = canonicalSourceBinding({ workspace_id: workspaceId, actor_id: pin.actorId, slug: pin.slug,
        source_markdown_sha256: pin.sourceMarkdownDigest, source_board_sha256: pin.nativeBoardDigest });
      database.exec("BEGIN IMMEDIATE");
      try {
        database.prepare(`INSERT INTO legacy_note_workitems_admission
          (slug,source_markdown_sha256,source_board_sha256,native_board_sha256,admitted_at,source_kind) VALUES(?,?,?,?,?,'native-board')`)
          .run(pin.slug, pin.sourceMarkdownDigest, pin.nativeBoardDigest, pin.nativeBoardDigest, new Date().toISOString());
        database.prepare(`INSERT INTO legacy_note_workitems_canonical_source
          (slug,source_markdown_sha256,source_board_sha256,source_board,workspace_id,actor_id,binding_sha256) VALUES(?,?,?,?,?,?,?)`)
          .run(pin.slug, pin.sourceMarkdownDigest, pin.nativeBoardDigest, native.raw, workspaceId, pin.actorId, binding);
        database.exec("COMMIT");
      } catch (error) { if (database.isTransaction) database.exec("ROLLBACK"); throw error; }
    }
    for (const pin of policy.admissions ?? []) {
      if (!pin || typeof pin.slug !== "string" || !pin.slug || !admissionDigest.test(pin.sourceMarkdownDigest)
        || !admissionDigest.test(pin.sourceBoardDigest) || !admissionDigest.test(pin.nativeBoardDigest)) {
        throw new CoreError("INVALID_CONFIGURATION", "Native Note admission pins are malformed.");
      }
      const source = readPinnedAuthority(pin.slug);
      const existing = rowFor(pin.slug);
      if (existing) {
        if (existing.source_markdown_sha256 !== pin.sourceMarkdownDigest
          || existing.source_board_sha256 !== pin.sourceBoardDigest
          || existing.native_board_sha256 !== pin.nativeBoardDigest) {
          throw new CoreError("CONFLICT", "Configured Note admission differs from the immutable workspace admission.");
        }
        if (hash(source.markdown) !== pin.sourceMarkdownDigest || hash(source.sourceBoard) !== pin.sourceBoardDigest) {
          throw new CoreError("CONFLICT", "Original Note or attached Board changed after its durable admission.");
        }
        const currentBoard = scanBoards(root, database, true).get(pin.slug);
        if (!currentBoard) throw new CoreError("NOT_AVAILABLE", "Pinned native Board is missing.");
        readTodoBoard(currentBoard.raw);
        continue;
      }
      const board = scanBoards(root, database, true).get(pin.slug);
      if (!board) throw new CoreError("NOT_AVAILABLE", "Pinned native Board is missing.");
      const preflight = preflightLegacyNoteWorkItemsAdmission({
        slug: pin.slug, sourceMarkdown: source.markdown, sourceMarkdownDigest: pin.sourceMarkdownDigest,
        sourceBoard: source.sourceBoard, sourceBoardDigest: pin.sourceBoardDigest,
        nativeBoard: board.raw, nativeBoardDigest: pin.nativeBoardDigest,
      });
      if (preflight.status !== "eligible-for-native-policy") {
        throw new CoreError("NOT_AVAILABLE", "Only an exact pinned original/native Board pair may be admitted.");
      }
      database.prepare(`INSERT INTO legacy_note_workitems_admission
        (slug,source_markdown_sha256,source_board_sha256,native_board_sha256,admitted_at) VALUES(?,?,?,?,?)`)
        .run(pin.slug, pin.sourceMarkdownDigest, pin.sourceBoardDigest, pin.nativeBoardDigest, new Date().toISOString());
    }
  }

  const authorized = (actor: Readonly<Actor>, operation: string, slug: string): boolean => {
    if (!policy || !actor?.id) return false;
    try {
      if (policy.authorize(Object.freeze({ ...actor }), operation) !== true) return false;
      const source = database.prepare("SELECT actor_id FROM legacy_note_workitems_canonical_source WHERE slug=?").get(slug);
      if (source && source.actor_id !== actor.id) return false;
      if (operation === "legacy.note.workitems.read" || operation === "legacy.note.workitems.notes") return true;
      return !!rowFor(slug);
    } catch { return false; }
  };
  const sourceHost = createNativeLegacyNoteWorkItemsHost(storage, { authorize: (actor, operation) => {
    try { return policy.authorize(actor, operation); } catch { return false; }
  } });
  const journalHost: LegacyNoteWorkItemsNativeJournal = {
    async withDurableFence(_operationId, work) {
      return storage.withWorkspaceExclusive(async () => {
        storage.assertWorkspaceLease();
        return work();
      });
    },
    authorize: (actor, operation, slug) => authorized(actor, operation, slug),
    readAdmittedBoard: async slug => boardFor(slug),
    async invokeNative(operation, args, actor) {
      const result = await invokeCoreTodo(operation, args, actor);
      const operationId = String(args.operationId);
      const binding = database.prepare(`SELECT bridge_fingerprint,bridge_actor_id,bridge_operation,bridge_request_json,
        native_fingerprint,native_actor_id,native_operation,native_result_json,bridge_result_json
        FROM legacy_note_workitems_native_binding WHERE operation_id=?`).get(operationId) as Record<string, unknown> | undefined;
      if (!binding || binding.native_actor_id !== actor.id || binding.native_operation !== operation
        || binding.native_result_json !== JSON.stringify(result)) {
        throw new CoreError("RECOVERY_CONFLICT", "Canonical Todo receipt is not atomically bound to the original Note intent.", "unknown");
      }
      return result;
    },
  };
  const journal = createLegacyNoteWorkItemsJournal(database, journalHost);

  async function dispatch(operation: string, input: unknown, actor: Actor): Promise<unknown> {
    const definition = legacyNoteWorkItemsDefinitions.find(item => item.id === operation);
    if (!definition) throw new CoreError("NOT_FOUND", "Unknown original Note Work Item operation.");
    const parsed = definition.input.parse(input) as Record<string, unknown>;
    if (typeof parsed.slug === "string") parsed.slug = resolveNativeBoardKey(root, parsed.slug, database);
    if (operation === "legacy.note.workitems.command" || operation === "legacy.note.workitems.upsert") {
      if (!authorized(actor, operation, String(parsed.slug))) {
        throw new CoreError("ACCESS_DENIED", "Native Note Board admission policy denied this actor.");
      }
      return journal.dispatch(operation, parsed, actor);
    }
    if (operation === "legacy.note.workitems.read") {
      const slug = String(parsed.slug);
      if (!authorized(actor, operation, slug)) throw new CoreError("ACCESS_DENIED", "Native Note policy denied this actor.");
      if (rowFor(slug)) return journal.read(slug, actor);
      return sourceHost.dispatch(operation, parsed, actor);
    }
    if (!authorized(actor, operation, "")) throw new CoreError("ACCESS_DENIED", "Native Note discovery policy denied this actor.");
    const source = await sourceHost.dispatch(operation, parsed, actor) as {
      ok: true; notes: Array<{ slug: string; title: string; count: number; digest?: string; error?: string }>; truncated: boolean;
    };
    const notes = [];
    for (const note of source.notes) {
      const key = resolveNativeBoardKey(root, note.slug, database);
      if (!rowFor(key)) { notes.push(note); continue; }
      const snapshot = await journal.read(key, actor);
      notes.push({ slug: note.slug, title: note.title, count: snapshot.items.filter(item => !item.deletedAt).length, digest: snapshot.digest });
    }
    return { ok: true, notes, truncated: source.truncated };
  }

  return {
    available(operation: string, actor?: Readonly<Actor>): boolean {
      const definition = legacyNoteWorkItemsDefinitions.find(item => item.id === operation);
      if (!definition || !actor?.id || !policy) return false;
      if ((operation === "legacy.note.workitems.command" || operation === "legacy.note.workitems.upsert")
        && !database.prepare("SELECT 1 FROM legacy_note_workitems_admission LIMIT 1").get()) return false;
      try { return policy.authorize(Object.freeze({ ...actor }), operation) === true; } catch { return false; }
    },
    dispatch,
    admitConfiguredBoards,
    async recoverPending(): Promise<void> {
      const intent = database.prepare("SELECT operation_id,actor_id,operation,request_json FROM legacy_note_workitems_intent WHERE singleton=1")
        .get() as { operation_id: string; actor_id: string; operation: string; request_json: string } | undefined;
      if (!intent) return;
      let args: Record<string, unknown>;
      try { args = JSON.parse(intent.request_json) as Record<string, unknown>; }
      catch { throw new CoreError("RECOVERY_CONFLICT", "Original Note intent arguments are malformed.", "unknown"); }
      const recoverActor = policy.recoveryActor?.(Object.freeze({
        operation: intent.operation, args: Object.freeze({ ...args }), actorId: intent.actor_id,
      }));
      if (!recoverActor || recoverActor.id !== intent.actor_id || !recoverActor.canWrite
        || !authorized(recoverActor, intent.operation, String(args.slug))) {
        throw new CoreError("RECOVERY_AUTHORITY_REQUIRED", "Exact original Note recovery requires the injected native actor policy.", "unknown");
      }
      await dispatch(intent.operation, args, recoverActor);
    },
    journal,
  };
}
