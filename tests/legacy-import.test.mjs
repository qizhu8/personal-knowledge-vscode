import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Core } from "../dist/core.js";
import { readTodoBoard, serializeTodoBoard } from "../dist/domain/todo-board.js";
import { cleanupInterruptedLegacyImportStages, importLegacyWorkspace, planLegacyImport, recoverLegacyImportOutcome } from "../dist/legacy-import.js";
import { legacyImportNoReplacePlatformError } from "../dist/domain/legacy-import.js";
import { Storage } from "../dist/storage.js";
import { createWorkspaceBackup, restoreWorkspaceBackup } from "../dist/workspace-backup.js";
import { nativeRestoreAuthority } from "./host-composition-legacy-batch16-restore-fixture.mjs";
import { checkCaptureRecords } from "../scripts/migration.mjs";
import { parseLegacyRouterConfig, routerConfigDestination } from "../dist/legacy-router-config.js";

const testsRoot = dirname(fileURLToPath(import.meta.url));
const digest = value => createHash("sha256").update(value).digest("hex");
const actor = { id: "legacy-import-test", canWrite: false };
const pythonExecutable = execFileSync("python3", ["-c", "import sys; print(sys.executable)"], { encoding: "utf8" }).trim();
const importOptions = { pythonExecutable };

async function fixture(t) {
  const id = randomUUID();
  const source = resolve(testsRoot, `.legacy-import-copy-${id}`);
  const destination = resolve(testsRoot, `.legacy-import-target-${id}`);
  await mkdir(source, { mode: 0o700 });
  t.after(async () => {
    await rm(source, { recursive: true, force: true });
    await rm(destination, { recursive: true, force: true });
    await rm(resolve(testsRoot, `.${destination.split("/").at(-1)}.pkm-legacy-import.outcome.json`), { force: true });
    await rm(resolve(testsRoot, `.${destination.split("/").at(-1)}.pkm-legacy-import.lock`), { force: true });
  });
  async function file(path, data) {
    const full = join(source, path);
    await mkdir(dirname(full), { recursive: true, mode: 0o700 });
    await writeFile(full, data, { mode: 0o600 });
  }
  return { source, destination, file };
}

function document(title, documentId, extra = "") {
  return `---\r\n title: ${title}\r\n documentId: ${documentId}\r\n revision: 3\r\n deleted: false\r\n${extra}---\r\nBody bytes stay authoritative.\r\n`;
}

test("explicit independent original router config is receipt-bound byte-preserved through owned import/restart/relocated restore", async t => {
  const f = await fixture(t);
  const configRoot = `${f.source}-router-copy`;
  const config = join(configRoot, "router-config.json");
  await mkdir(configRoot, { mode: 0o700 });
  t.after(() => rm(configRoot, { recursive: true, force: true }));
  const raw = JSON.stringify({ schema: 2, enabledSolutions: ["copilot_default"],
    sourcePriority: ["agent-native", "pkm-personal"], sources: [
      { id: "pkm-personal", label: "Personal", kind: "personal", detail: "Original personal source" },
      { id: "agent-native", label: "Native", kind: "native", detail: "Original host" },
    ] }, null, 2) + "\r\n";
  await writeFile(config, raw, { mode: 0o600 });
  await f.file("notes/entry.md", document("Entry", "router-note"));
  const before = await lstat(config, { bigint: true });
  const plan = await planLegacyImport(f.source, {}, { routerConfig: config });
  assert.equal(plan.ready, true, JSON.stringify(plan.blockers));
  assert.equal(plan.routerConfigPlan.sha256, digest(raw));
  const cliPlan = JSON.parse(execFileSync(process.execPath, [
    resolve(testsRoot, "../dist/cli.js"), "import-plan", "--source", f.source, "--router-config", config,
    "--acknowledge-quiescent-disposable-copy",
  ], { encoding: "utf8" })).plan;
  assert.equal(cliPlan.planSha256, plan.planSha256);
  const receipt = await importLegacyWorkspace(plan, f.destination, importOptions);
  assert.deepEqual(receipt.routerConfigPlan, plan.routerConfigPlan);
  assert.equal(receipt.assets.find(entry => entry.path === routerConfigDestination).sha256, digest(raw));
  const backup = `${f.destination}-backup`, restored = `${f.destination}-restored`;
  t.after(() => Promise.all([backup, restored].map(path => rm(path, { recursive: true, force: true }))));
  for (let i = 0; i < 2; i++) {
    const storage = await Storage.open(f.destination);
    try {
      const imported = await readFile(join(f.destination, routerConfigDestination), "utf8");
      assert.equal(imported, raw);
      parseLegacyRouterConfig(imported);
      if (i === 1) await createWorkspaceBackup(storage, backup, { acquireQuiescence: async () => ({ assertHeld() {}, release() {} }) });
    } finally { await storage.close(); }
  }
  await restoreWorkspaceBackup(backup, restored, { nativeRestoreAuthority, pythonExecutable });
  const restoredStorage = await Storage.open(restored);
  await restoredStorage.close();
  assert.equal(await readFile(join(restored, routerConfigDestination), "utf8"), raw);
  assert.equal(await readFile(config, "utf8"), raw);
  const after = await lstat(config, { bigint: true });
  for (const key of ["dev", "ino", "size", "mtimeNs", "ctimeNs"]) assert.equal(after[key], before[key]);
  await assert.rejects(lstat(join(f.destination, "retrieval")), { code: "ENOENT" });
  await writeFile(config, raw.replace('"copilot_default"', '"copilot_default", "l1_online"'));
  const changedTarget = `${f.destination}-changed`;
  await assert.rejects(importLegacyWorkspace(plan, changedTarget, importOptions), { code: "SOURCE_CHANGED" });
  await assert.rejects(lstat(changedTarget), { code: "ENOENT" });
});

test("router config selection rejects malformed or workspace-local state and does not skip unknown source metadata", async t => {
  const f = await fixture(t);
  const configRoot = `${f.source}-router-invalid`;
  const config = join(configRoot, "router-config.json");
  await mkdir(configRoot, { mode: 0o700 });
  t.after(() => rm(configRoot, { recursive: true, force: true }));
  await f.file("notes/entry.md", document("Entry", "router-invalid-note"));
  await writeFile(config, '{"schema":2,"enabledSolutions":["l1_online"]}', { mode: 0o600 });
  const malformed = await planLegacyImport(f.source, {}, { routerConfig: config });
  assert.equal(malformed.ready, false);
  assert(malformed.blockers.some(blocker => blocker.code === "invalid-router-config"));
  await f.file("retrieval/router-config.json", "{}");
  const local = await planLegacyImport(f.source, {}, { routerConfig: join(f.source, "retrieval/router-config.json") });
  assert.equal(local.ready, false);
  assert(local.blockers.some(blocker => blocker.code === "invalid-router-config"));
  assert.equal((await planLegacyImport(f.source)).ready, false, "Unknown source retrieval state must not be silently skipped.");
});

test("original Recipe run usage is byte-preserved only under the isolated read root with source hashes and restart/restore", async t => {
  const f = await fixture(t);
  const sourcePath = ".pkm/state/recipe-runs/recipe_run_original with spaces.json";
  const destinationPath = `recipe-usage-reads/${sourcePath}`;
  const bytes = Buffer.from('{\r\n "runId": "run-original", "recipeId": "original-recipe", "status": "completed", "definition": {}\r\n}\r\n');
  await f.file("notes/entry.md", document("Entry", "usage-note"));
  await f.file(sourcePath, bytes);
  await f.file(".pkm/state/recipe-runs/recipe_run_corrupt.json", "{original-corrupt-json");
  const statBefore = await lstat(join(f.source, sourcePath), { bigint: true });
  const plan = await planLegacyImport(f.source);
  assert.equal(plan.ready, true, JSON.stringify(plan.blockers));
  const entry = plan.entries.find(entry => entry.source === sourcePath);
  assert.equal(entry.sha256, digest(bytes));
  assert.equal(entry.destination, destinationPath);
  assert.equal(entry.mtimeNs, statBefore.mtimeNs.toString());
  const receipt = await importLegacyWorkspace(plan, f.destination, importOptions);
  assert.equal(receipt.assets.find(entry => entry.path === destinationPath).sha256, digest(bytes));
  assert.deepEqual(await readFile(join(f.destination, destinationPath)), bytes);
  assert.equal(await readFile(join(f.destination, "recipe-usage-reads/.pkm/state/recipe-runs/recipe_run_corrupt.json"), "utf8"), "{original-corrupt-json");
  assert.equal((await lstat(join(f.destination, destinationPath), { bigint: true })).mtimeNs, statBefore.mtimeNs);
  await assert.rejects(lstat(join(f.destination, ".pkm")), { code: "ENOENT" });
  let storage = await Storage.open(f.destination);
  await storage.close();
  storage = await Storage.open(f.destination);
  const backup = `${f.destination}-backup`, restored = `${f.destination}-restored`;
  t.after(() => Promise.all([backup, restored].map(path => rm(path, { recursive: true, force: true }))));
  try {
    await createWorkspaceBackup(storage, backup, { acquireQuiescence: async () => ({ assertHeld() {}, release() {} }) });
  } finally { await storage.close(); }
  await restoreWorkspaceBackup(backup, restored, { nativeRestoreAuthority, pythonExecutable });
  const restoredStorage = await Storage.open(restored);
  await restoredStorage.close();
  assert.deepEqual(await readFile(join(restored, destinationPath)), bytes);
  assert.equal((await lstat(join(restored, destinationPath), { bigint: true })).mtimeNs, statBefore.mtimeNs);
  assert.deepEqual(await readFile(join(f.source, sourcePath)), bytes);
  const statAfter = await lstat(join(f.source, sourcePath), { bigint: true });
  for (const key of ["dev", "ino", "size", "mtimeNs", "ctimeNs"]) assert.equal(statAfter[key], statBefore[key]);
  await f.file(sourcePath, '{"runId":"changed"}');
  const changedTarget = `${f.destination}-changed`;
  await assert.rejects(importLegacyWorkspace(plan, changedTarget, importOptions), { code: "SOURCE_CHANGED" });
  await assert.rejects(lstat(changedTarget), { code: "ENOENT" });
});

test("Recipe usage import preserves corrupt run bytes but rejects unknown nested state and Recovery Session authority bypass", async t => {
  const f = await fixture(t);
  await f.file("notes/entry.md", document("Entry", "usage-invalid-note"));
  await f.file(".pkm/state/recipe-runs/recipe_run_invalid.json", "not-json");
  assert.equal((await planLegacyImport(f.source)).ready, true);
  await rm(join(f.source, ".pkm/state/recipe-runs/recipe_run_invalid.json"));
  await f.file(".pkm/state/recipe-runs/nested/recipe_run_original.json", "{}");
  assert.equal((await planLegacyImport(f.source)).ready, false);
  await rm(join(f.source, ".pkm/state/recipe-runs"), { recursive: true });
  await f.file(".pkm/state/agent-sessions/session.json", "{}");
  assert.equal((await planLegacyImport(f.source)).ready, false);
});

test("Recipe usage refuses ambiguous equal-time names rather than silently changing source filesystem tie order", async t => {
  const f = await fixture(t);
  await f.file("notes/entry.md", document("Entry", "usage-order-note"));
  for (const [id, recipeName] of [["one", "Original name"], ["two", "Other name"]]) {
    const path = `.pkm/state/recipe-runs/recipe_run_${id}.json`;
    await f.file(path, JSON.stringify({ schema: "pkm.recipe.run/v1", recipeId: "recipe", recipeRevision: 1, recipeName }));
    execFileSync(pythonExecutable, ["-c", "import os,sys; os.utime(sys.argv[1],ns=(1700000000000000000,1700000000000000000))", join(f.source, path)]);
  }
  const plan = await planLegacyImport(f.source);
  assert.equal(plan.ready, false);
  assert(plan.blockers.some(blocker => blocker.code === "ambiguous-recipe-usage-order"));
});

test("import and backup restore retain exact Markdown modification times and reject stale time-only plans", { timeout: 30_000 }, async t => {
  const f = await fixture(t);
  const paths = ["notes/old.md", "notes/new.md", "skills/example.md", "papers/example.md"];
  const stamps = ["1675224306123456789", "1675224306123456790", "1600000000123456789", "1500000000987654321"];
  for (const [index, path] of paths.entries()) {
    await f.file(path, document(`Entry ${index}`, `mtime-${index}`));
    execFileSync(pythonExecutable, ["-c", "import os,sys; p,n=sys.argv[1:]; os.utime(p, ns=(int(n),int(n)))", join(f.source, path), stamps[index]]);
  }
  const stale = await planLegacyImport(f.source);
  assert.equal(stale.ready, true, JSON.stringify(stale.blockers));
  execFileSync(pythonExecutable, ["-c", "import os,sys; p,n=sys.argv[1:]; os.utime(p, ns=(int(n),int(n)))", join(f.source, paths[0]), "1675224306123456791"]);
  await assert.rejects(importLegacyWorkspace(stale, f.destination, importOptions), { code: "SOURCE_CHANGED" });
  execFileSync(pythonExecutable, ["-c", "import os,sys; p,n=sys.argv[1:]; os.utime(p, ns=(int(n),int(n)))", join(f.source, paths[0]), stamps[0]]);
  const plan = await planLegacyImport(f.source);
  assert.equal(plan.ready, true, JSON.stringify(plan.blockers));
  await importLegacyWorkspace(plan, f.destination, importOptions);
  const backup = `${f.destination}-mtime-backup`, restored = `${f.destination}-mtime-restored`;
  t.after(async () => { await rm(backup, { recursive: true, force: true }); await rm(restored, { recursive: true, force: true }); });
  for (const [index, path] of paths.entries()) {
    assert.equal((await lstat(join(f.destination, path), { bigint: true })).mtimeNs.toString(), stamps[index]);
  }
  const storage = await Storage.open(f.destination);
  try { await createWorkspaceBackup(storage, backup, { acquireQuiescence: async () => ({ assertHeld() {}, release() {} }) }); }
  finally { await storage.close(); }
  await restoreWorkspaceBackup(backup, restored, { nativeRestoreAuthority, pythonExecutable });
  for (const [index, path] of paths.entries()) {
    assert.equal((await lstat(join(restored, path), { bigint: true })).mtimeNs.toString(), stamps[index]);
    const original = execFileSync(pythonExecutable, ["-c", "import datetime,os,sys; print(datetime.datetime.utcfromtimestamp(os.stat(sys.argv[1]).st_mtime).isoformat())", join(f.source, path)], { encoding: "utf8" });
    const actual = execFileSync(pythonExecutable, ["-c", "import datetime,os,sys; print(datetime.datetime.utcfromtimestamp(os.stat(sys.argv[1]).st_mtime).isoformat())", join(restored, path)], { encoding: "utf8" });
    assert.equal(actual, original);
  }
});

test("offline import accepts Notes exceeding the former aggregate preflight read ceiling", { timeout: 120_000 }, async t => {
  const f = await fixture(t);
  const contents = `---\ntitle: Large Note\ndocumentId: large-note\n---\n${"x".repeat(33 * 1024 * 1024)}\n`;
  await f.file("notes/large.md", contents);
  const limited = await planLegacyImport(f.source, { maxReadBytes: 1024 });
  assert.equal(limited.ready, false);
  assert.ok(limited.blockers.some(blocker => blocker.code === "read-budget"));
  const plan = await planLegacyImport(f.source);
  assert.equal(plan.ready, true, JSON.stringify(plan.blockers));
  const receipt = await importLegacyWorkspace(plan, f.destination, importOptions);
  assert.equal(receipt.documentCount, 1);
  assert.equal(digest(await readFile(join(f.destination, "notes/large.md"))), digest(contents));
  const storage = await Storage.open(f.destination);
  const backup = `${f.destination}-backup`, restored = `${f.destination}-restored`;
  t.after(async () => {
    await rm(backup, { recursive: true, force: true });
    await rm(restored, { recursive: true, force: true });
  });
  try {
    await createWorkspaceBackup(storage, backup, { acquireQuiescence: async () => ({ assertHeld() {}, release() {} }) });
  } finally { await storage.close(); }
  await restoreWorkspaceBackup(backup, restored, { nativeRestoreAuthority, pythonExecutable });
  const reopened = await Storage.open(restored);
  try { assert.equal(digest(await readFile(join(restored, "notes/large.md"))), digest(contents)); }
  finally { await reopened.close(); }
});

test("imports original Markdown, paired binary assets and validated dedicated Boards", async t => {
  const f = await fixture(t);
  const boardMarkdown = document("Team Board", "board-note", " documentKind: todo-board\r\n");
  const manualMarkdown = document("Manual", "manual-note");
  const skillMarkdown = document("Skill", "skill-note");
  const paperMarkdown = document("Paper", "paper-note");
  const history = [{ at: "2025-02-03T04:05:06.000Z", actorId: "user:legacy", action: "created" }];
  const originalItem = {
    id: "history-item", title: "Keep history", goal: "Keep every field", scope: "Migration",
    acceptance: ["History is unchanged"], state: "Planning", evidence: [], history,
  };
  const boardRaw = serializeTodoBoard([originalItem], { "external:copilot:fixture": "a".repeat(64) });
  const image = Buffer.from([0, 0xff, 0x41, 0x0a, 0x80]);
  const reference = Buffer.from("source bytes");
  await f.file("notes/Team/Board.md", boardMarkdown);
  await f.file("notes/Team/Board.assets/pkm-todo-board.json", boardRaw);
  await f.file("notes/Manual.md", manualMarkdown);
  await f.file("notes/Manual.assets/image.bin", image);
  await f.file("skills/Category/Skill.md", skillMarkdown);
  await f.file("papers/Topic/Paper.md", paperMarkdown);
  await f.file("papers/Topic/Paper.assets/reference.bin", reference);

  const plan = await planLegacyImport(f.source);
  assert.equal(plan.ready, true, JSON.stringify(plan.blockers));
  assert.equal(plan.entries.filter(entry => entry.kind === "document").length, 4);
  assert.equal(plan.boards.length, 1);
  assert.equal(plan.boards[0].digest, digest(boardRaw));
  const receipt = await importLegacyWorkspace(plan, f.destination, importOptions);
  assert.equal(receipt.fingerprint, plan.fingerprint);
  assert.equal(receipt.documentCount, 4);
  assert.equal(receipt.assetCount, 2);
  assert.equal(receipt.boardCount, 1);
  const outcome = await recoverLegacyImportOutcome(f.destination);
  assert.equal(outcome.status, "published");
  assert.deepEqual(outcome.receipt, receipt);
  assert.equal(await readFile(resolve(testsRoot, `.${f.destination.split("/").at(-1)}.pkm-legacy-import.outcome.json`), "utf8").then(JSON.parse).then(record => record.state), "prepared");
  assert.equal(receipt.receiptSha256, digest(JSON.stringify({
    schema: receipt.schema, destination: receipt.destination, fingerprint: receipt.fingerprint,
    documentCount: receipt.documentCount, assetCount: receipt.assetCount, boardCount: receipt.boardCount,
    totalBytes: receipt.totalBytes, documents: receipt.documents, assets: receipt.assets, boards: receipt.boards,
  })));

  assert.deepEqual(await readFile(join(f.destination, "notes/Team/Board.md")), Buffer.from(boardMarkdown));
  assert.deepEqual(await readFile(join(f.destination, "notes/Manual.assets/image.bin")), image);
  assert.deepEqual(await readFile(join(f.destination, "papers/Topic/Paper.assets/reference.bin")), reference);
  const migratedBoardBytes = await readFile(join(f.destination, "boards/Team/Board/pkm-todo-board.json"));
  assert.deepEqual(migratedBoardBytes, Buffer.from(boardRaw));
  const migratedBoard = readTodoBoard(migratedBoardBytes.toString("utf8"));
  assert.equal(migratedBoard.digest, digest(boardRaw));
  assert.deepEqual(migratedBoard.items[0].history, history);

  const storage = await Storage.open(f.destination);
  try {
    const core = new Core(storage);
    const listed = await core.dispatch("capability_read", {
      operation: "knowledge.document.list", version: 1,
      arguments: { area: "notes", offset: 0, limit: 20, includeDeleted: false },
    }, actor);
    assert.equal(listed.error, undefined);
    assert.equal(listed.result.items.length, 2);

    const note = await core.dispatch("capability_read", {
      operation: "knowledge.note.get", version: 1, arguments: { id: "board-note" },
    }, actor);
    assert.equal(note.error, undefined);
    assert.equal(note.result.item.documentId, "board-note");
    assert.equal(note.result.item.documentKind, "todo-board");

    const board = await core.dispatch("capability_read", {
      operation: "todo.board.get", version: 1, arguments: { board_slug: "Team/Board" },
    }, actor);
    assert.equal(board.error, undefined);
    assert.equal(board.result.digest, digest(boardRaw));

    const item = await core.dispatch("capability_read", {
      operation: "todo.workitem.get", version: 1,
      arguments: { board_slug: "Team/Board", id: "history-item" },
    }, actor);
    assert.equal(item.error, undefined);
    assert.equal(item.result.item.title, "Keep history");
  } finally {
    await storage.close();
  }
});

test("unsupported trash and deletion surfaces block before creating a target", async t => {
  const f = await fixture(t);
  await f.file("notes/Note.md", document("Note", "note-1"));
  await f.file("notes/.trash/deleted.md", document("Deleted", "deleted-note"));
  await f.file(".pkm/state/knowledge-deletions.json", '{"records":[]}\n');
  const plan = await planLegacyImport(f.source);
  assert.equal(plan.ready, false);
  assert.ok(plan.blockers.some(blocker => blocker.code === "trash" || blocker.code === "metadata"));
  assert.ok(plan.blockers.some(blocker => blocker.code === "deletion-journal"));
  await assert.rejects(importLegacyWorkspace(plan, f.destination, importOptions), error => error.code === "IMPORT_BLOCKED");
  await assert.rejects(lstat(f.destination), error => error.code === "ENOENT");
});

test("source recheck rejects a stale plan without creating a target", async t => {
  const f = await fixture(t);
  await f.file("notes/Note.md", document("Note", "note-1"));
  const plan = await planLegacyImport(f.source);
  assert.equal(plan.ready, true);
  await f.file("notes/Note.md", document("Changed", "note-1"));
  await assert.rejects(importLegacyWorkspace(plan, f.destination, importOptions), error => error.code === "SOURCE_CHANGED");
  await assert.rejects(lstat(f.destination), error => error.code === "ENOENT");
});

test("an existing destination is never overwritten", async t => {
  const f = await fixture(t);
  await f.file("notes/Note.md", document("Note", "note-1"));
  const plan = await planLegacyImport(f.source);
  await mkdir(f.destination, { mode: 0o700 });
  await writeFile(join(f.destination, "keep.txt"), "keep", { mode: 0o600 });
  await assert.rejects(importLegacyWorkspace(plan, f.destination, importOptions), error => error.code === "DESTINATION_EXISTS");
  assert.equal(await readFile(join(f.destination, "keep.txt"), "utf8"), "keep");
});

test("atomic publication preserves an empty target created in the final race window", async t => {
  const f = await fixture(t);
  await f.file("notes/Note.md", document("Note", "note-race"));
  const plan = await planLegacyImport(f.source);
  const shim = resolve(testsRoot, `.legacy-import-python-${randomUUID()}`);
  const shimSource = `#!/usr/bin/env python3
import os, sys
if len(sys.argv) > 3:
    os.mkdir(sys.argv[-1])
real_python = ${JSON.stringify(pythonExecutable)}
os.execv(real_python, [real_python, *sys.argv[1:]])
`;
  await writeFile(shim, shimSource, { mode: 0o700 });
  await chmod(shim, 0o700);
  t.after(() => rm(shim, { force: true }));

  await assert.rejects(importLegacyWorkspace(plan, f.destination, { pythonExecutable: shim }), error => error.code === "DESTINATION_EXISTS");
  assert.deepEqual(await (await import("node:fs/promises")).readdir(f.destination), []);
});

test("publication supports Linux/Windows and explicitly refuses other OS platforms", async () => {
  const message = legacyImportNoReplacePlatformError("darwin");
  assert.match(message, /requires Linux or Windows/);
  assert.equal(legacyImportNoReplacePlatformError("linux"), undefined);
  assert.equal(legacyImportNoReplacePlatformError("win32"), undefined);
});

test("missing libc no-replace support is explicit and never falls back to rename", async t => {
  const f = await fixture(t);
  await f.file("notes/Note.md", document("Note", "note-helper"));
  const plan = await planLegacyImport(f.source);
  const shim = resolve(testsRoot, `.legacy-import-no-renameat2-${randomUUID()}`);
  await writeFile(shim, `#!/usr/bin/env python3
import os, sys
if len(sys.argv) == 3:
    real_python = ${JSON.stringify(pythonExecutable)}
    os.execv(real_python, [real_python, *sys.argv[1:]])
print('renameat2-unavailable', file=sys.stderr)
sys.exit(78)
`, { mode: 0o700 });
  await chmod(shim, 0o700);
  t.after(() => rm(shim, { force: true }));
  await assert.rejects(importLegacyWorkspace(plan, f.destination, { pythonExecutable: shim }), error => error.code === "NO_REPLACE_UNAVAILABLE");
  await assert.rejects(lstat(f.destination), error => error.code === "ENOENT");
  const recovery = await recoverLegacyImportOutcome(f.destination);
  assert.equal(recovery.status, "unknown");
});

test("missing explicit Python executable is rejected before target creation", async t => {
  const f = await fixture(t);
  await f.file("notes/Note.md", document("Note", "note-python"));
  const plan = await planLegacyImport(f.source);
  await assert.rejects(importLegacyWorkspace(plan, f.destination, { pythonExecutable: "python3" }), error => error.code === "PYTHON_PATH_REQUIRED");
  await assert.rejects(lstat(f.destination), error => error.code === "ENOENT");
});

test("recovery cleanup removes only dead-process stages with matching ownership records", async t => {
  const destination = resolve(testsRoot, `.legacy-import-target-${randomUUID()}`);
  const token = randomUUID();
  const base = destination.split("/").at(-1);
  const stage = resolve(testsRoot, `.${base}.pkm-legacy-import-${token}`);
  const ownerPath = `${stage}.owner.json`;
  const lockPath = resolve(testsRoot, `.${base}.pkm-legacy-import.lock`);
  const workspaceId = randomUUID();
  const owner = { schema: "pkm.legacy-import-stage/v1", token, pid: 2_147_483_647, destination, stage, workspaceId };
  await mkdir(stage, { mode: 0o700 });
  await writeFile(join(stage, ".pkm-next-workspace"), JSON.stringify({ schema: "pkm.next-workspace/v2", id: workspaceId }), { mode: 0o600 });
  await writeFile(ownerPath, JSON.stringify(owner), { mode: 0o600 });
  await writeFile(lockPath, JSON.stringify(owner), { mode: 0o600 });
  t.after(async () => {
    await rm(stage, { recursive: true, force: true });
    await rm(ownerPath, { force: true });
    await rm(lockPath, { force: true });
  });
  const result = await cleanupInterruptedLegacyImportStages(destination);
  assert.deepEqual(result, { removed: [stage], retained: [] });
  await assert.rejects(lstat(stage), error => error.code === "ENOENT");
  await assert.rejects(lstat(ownerPath), error => error.code === "ENOENT");
});

test("captured source provenance contains only current byte-identical source pairs", async () => {
  const repositoryRoot = resolve(testsRoot, "../legacy");
  const provenance = JSON.parse(await readFile(resolve(repositoryRoot, "../migration/legacy-import-provenance.json"), "utf8"));
  assert.equal(provenance.schema, "pkm.legacy-import-provenance/v1");
  assert.equal(provenance.ready, true);
  assert.deepEqual(provenance.issues, []);
  assert.equal(provenance.files.length, 2);
  assert.deepEqual(await checkCaptureRecords(provenance.files), []);
  for (const pair of provenance.files) {
    const source = await readFile(resolve(repositoryRoot, pair.source));
    const captured = await readFile(resolve(repositoryRoot, "../", pair.captured));
    assert.equal(pair.sourceSha256, digest(source));
    assert.equal(pair.capturedSha256, digest(captured));
    assert.equal(pair.sourceSha256, pair.capturedSha256);
  }
});
