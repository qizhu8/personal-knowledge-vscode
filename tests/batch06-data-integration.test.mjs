import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { scanMarkdown } from "../dist/markdown.js";
import { applyKnowledgeMutation, knowledgeMutationDefinitions, knowledgeMutationScanRevision,
  planKnowledgeMutation, serializeKnowledgeMutationPlan } from "../dist/knowledge-mutations.js";
import { planTrashLifecycle, previewTrashLifecycle, serializeTrashLifecyclePlan, trashLifecycleDefinitions } from "../dist/trash-lifecycle.js";
import { httpCall, invocation, managerActor, nativeWorkspace } from "./batch06-manager-fixtures.mjs";

const digest = input => createHash("sha256").update(input).digest("hex");
const revision = root => knowledgeMutationScanRevision(scanMarkdown(root));
const call = (f, operation, args, actor = managerActor) => f.runtime.core.dispatch(
  operation.endsWith(".preview") ? "capability_read" : "capability_call", invocation(operation, args), actor);
const trashOptions = { trash: { layoutVersion: "pkm.trash-lifecycle/v1" } };

async function seedKnowledgeIntent(f, request, phase = "before") {
  const args = knowledgeMutationDefinitions.find(definition => definition.id === request.operation).input.parse(request.args);
  request = { operation: request.operation, actorId: request.actorId, args };
  const plan = planKnowledgeMutation(f.root, request);
  const serialized = serializeKnowledgeMutationPlan(plan);
  const workspaceId = await f.storage.workspaceId();
  await f.close();
  if (phase === "after") applyKnowledgeMutation(f.root, plan, plan.operationId);
  const fingerprint = digest(JSON.stringify(request));
  const requestJson = JSON.stringify(request);
  const values = [plan.operationId, workspaceId, resolve(f.root), request.actorId, request.operation, fingerprint, requestJson, serialized];
  const database = new DatabaseSync(resolve(f.root, "core.sqlite"));
  try { database.prepare("INSERT INTO migration_runtime_intents VALUES(?,?,?,?,?,?,?,?,?)").run(...values, digest(JSON.stringify(values))); }
  finally { database.close(); }
  return { plan, request };
}

test("actual native HTTP specialized Note/Skill/Research apply preserves identity and CAS/global retry receipts across restart", async t => {
  const f = await nativeWorkspace(t);
  let url = await f.listen();
  const receipts = [];
  for (const [kind, metadata] of [["note", { title: "Native Note", type: "journal" }],
    ["skill", { name: "Native Skill", priority: "high" }], ["research", { title: "Native Paper", authors: ["Synthetic"], kind: "paper" }]]) {
    const operation = `knowledge.${kind}.create`;
    const input = { operationId: randomUUID(), expectedScanRevision: revision(f.root), category: "Qualification", content: `Synthetic ${kind} body.`, ...metadata };
    const first = await httpCall(url, f.bearer, "capability_call", invocation(operation, input));
    assert.equal(first.status, 200, JSON.stringify(first.body));
    const receipt = first.body.result;
    assert.equal(receipt.revision, 1);
    assert.equal((await httpCall(url, f.bearer, "capability_call", invocation(operation, input))).status, 200);
    assert.deepEqual((await httpCall(url, f.bearer, "capability_call", invocation(operation, input))).body.result, receipt);
    assert.equal((await call(f, operation, input, { ...managerActor, id: "other-actor" })).error.code, "CONFLICT");
    assert.equal((await call(f, operation, { ...input, content: "Changed immutable request." })).error.code, "CONFLICT");
    const update = { operationId: randomUUID(), id: receipt.id, expectedScanRevision: revision(f.root),
      expectedRevision: receipt.revision, expectedSha256: receipt.sha256, content: `Updated ${kind} body.` };
    const changed = await httpCall(url, f.bearer, "capability_call", invocation(`knowledge.${kind}.update`, update));
    assert.equal(changed.status, 200, JSON.stringify(changed.body));
    assert.equal(changed.body.result.id, receipt.id);
    assert.equal(changed.body.result.knowledgeId, receipt.knowledgeId);
    assert.equal(changed.body.result.path, receipt.path);
    assert.equal(changed.body.result.revision, 2);
    const stale = await call(f, `knowledge.${kind}.update`, { ...update, operationId: randomUUID(), expectedScanRevision: revision(f.root) });
    assert.equal(stale.error.code, "CONFLICT", JSON.stringify(stale));
    const globalCollision = await call(f, "knowledge.document.create", { operationId: input.operationId, id: `collision-${kind}`, title: "Conflict", content: "Do not write" });
    assert.equal(globalCollision.error.code, "CONFLICT");
    receipts.push({ operation, input, receipt });
  }
  await f.reopen();
  url = await f.listen();
  for (const { operation, input, receipt } of receipts) {
    assert.deepEqual((await httpCall(url, f.bearer, "capability_call", invocation(operation, input))).body.result, receipt,
      "replay returns original create receipt, not latest edited document");
  }
});

test("native specialized guard refuses protected descriptors without source effects", async t => {
  const f = await nativeWorkspace(t);
  const board = resolve(f.root, "notes", "Board.md");
  const bytes = "---\ndocumentId: protected-board\nrevision: 1\ntitle: Protected Board\ndocumentKind: todo-board\n---\nKeep this board.\n";
  await writeFile(board, bytes);
  const record = scanMarkdown(f.root).find(document => document.record.id === "protected-board").record;
  const result = await call(f, "knowledge.note.update", { operationId: randomUUID(), id: record.id,
    expectedScanRevision: revision(f.root), expectedRevision: record.revision, expectedSha256: record.sha256, content: "Forbidden." });
  assert.equal(result.error.code, "ACCESS_DENIED", JSON.stringify(result));
  assert.equal(await readFile(board, "utf8"), bytes);
  assert.equal(scanMarkdown(f.root).length, 1);
});

for (const phase of ["before", "after"]) {
  test(`actual native startup recovers committed specialized ${phase} image once with immutable global receipt`, async t => {
    const f = await nativeWorkspace(t);
    const request = { operation: "knowledge.note.create", actorId: managerActor.id, args: {
      operationId: randomUUID(), expectedScanRevision: revision(f.root), title: `Recovery ${phase}`, content: "Exactly once synthetic recovery.",
    } };
    const seeded = await seedKnowledgeIntent(f, request, phase);
    await f.reopen();
    const receipt = await call(f, seeded.request.operation, seeded.request.args);
    assert.ok(receipt.result, JSON.stringify(receipt));
    assert.equal(receipt.result.id, seeded.plan.receipt.id);
    assert.equal(scanMarkdown(f.root).length, 1);
    const database = new DatabaseSync(resolve(f.root, "core.sqlite"));
    try {
      assert.equal(database.prepare("SELECT count(*) n FROM migration_runtime_intents").get().n, 0);
      assert.equal(database.prepare("SELECT count(*) n FROM receipts WHERE operation_id=?").get(seeded.plan.operationId).n, 1);
    } finally { database.close(); }
    await f.reopen();
    assert.deepEqual((await call(f, seeded.request.operation, seeded.request.args)).result, receipt.result);
  });
}

test("unknown specialized target and staged bytes fail native startup closed and preserve journal", async t => {
  const f = await nativeWorkspace(t);
  const request = { operation: "knowledge.note.create", actorId: managerActor.id, args: {
    operationId: randomUUID(), expectedScanRevision: revision(f.root), title: "Unknown staging", content: "Expected source.",
  } };
  const { plan } = await seedKnowledgeIntent(f, request);
  const stage = resolve(f.root, "notes", `.pkm-write-${plan.operationId}`);
  const bytes = Buffer.from([0, 255, 1, 2, 3]);
  await writeFile(stage, bytes);
  await assert.rejects(f.reopen(), error => error.code === "RECOVERY_CONFLICT");
  assert.deepEqual(await readFile(stage), bytes);
  const database = new DatabaseSync(resolve(f.root, "core.sqlite"));
  try { assert.equal(database.prepare("SELECT count(*) n FROM migration_runtime_intents").get().n, 1); }
  finally { database.close(); }
});

test("actual native document paired-assets and folder trash restore preserve opaque bytes with no overwrite", async t => {
  const f = await nativeWorkspace(t, trashOptions);
  const opaque = Buffer.from([0, 255, 128, 13, 10, 9]);
  for (const kind of ["document", "folder"]) {
    const created = await call(f, "knowledge.note.create", { operationId: randomUUID(), expectedScanRevision: revision(f.root),
      title: `Paired ${kind}`, category: `Team-${kind}`, content: `![opaque](Paired ${kind}.assets/opaque.bin)\n` });
    assert.ok(created.result, JSON.stringify(created));
    const document = resolve(f.root, "notes", created.result.path);
    const original = await readFile(document);
    const assets = document.replace(/\.md$/, ".assets");
    await mkdir(assets);
    await writeFile(resolve(assets, "opaque.bin"), opaque);
    const path = kind === "document" ? created.result.path : `Team-${kind}`;
    const preview = await call(f, "knowledge.trash.lifecycle.preview", { area: "notes", kind, path });
    assert.ok(preview.result, JSON.stringify(preview));
    const input = { operationId: randomUUID(), area: "notes", kind, path,
      expectedTreeSha256: preview.result.treeSha256, expectedScanRevision: preview.result.scanRevision };
    const trashed = await call(f, "knowledge.trash.move", input);
    assert.ok(trashed.result, JSON.stringify(trashed));
    assert.deepEqual((await call(f, "knowledge.trash.move", input)).result, trashed.result);
    await assert.rejects(readFile(document), { code: "ENOENT" });
    await f.reopen(trashOptions);
    const emptyPreview = await call(f, "knowledge.trash.lifecycle.preview", { area: "notes", kind: "document", path: "missing.md" });
    assert.ok(emptyPreview.error);
    const pins = scanMarkdown(f.root).map(({ record }) => ({ id: record.id, area: record.area, path: record.path, revision: record.revision, sha256: record.sha256 }));
    const restored = await call(f, "knowledge.trash.restore", { operationId: randomUUID(), entryId: trashed.result.entryId,
      expectedScanRevision: digest(JSON.stringify(pins)) });
    assert.ok(restored.result, JSON.stringify(restored));
    assert.deepEqual(await readFile(document), original);
    assert.deepEqual(await readFile(resolve(assets, "opaque.bin")), opaque);
    assert.equal(scanMarkdown(f.root).find(({ record }) => record.id === created.result.id).record.revision, 1);
  }
});

test("native unknown trash bucket fails closed without accepting or deleting bytes", async t => {
  const f = await nativeWorkspace(t, trashOptions);
  const unknown = resolve(f.root, "notes", ".trash", randomUUID());
  await mkdir(unknown);
  await writeFile(resolve(unknown, "opaque.bin"), "unknown bytes");
  await f.close();
  await assert.rejects(f.reopen(trashOptions), error => error.code === "RECOVERY_CONFLICT");
  assert.equal(await readFile(resolve(unknown, "opaque.bin"), "utf8"), "unknown bytes");
  assert.deepEqual(await readdir(unknown), ["opaque.bin"]);
});

test("native startup provisions fresh authorized trash roots when no journal owns entries", async t => {
  const f = await nativeWorkspace(t, trashOptions);
  for (const area of ["notes", "skills", "papers"]) {
    assert.deepEqual(await readdir(resolve(f.root, area, ".trash")), []);
  }
});

test("unknown trash bucket in another area blocks provisioning a missing authorized root", async t => {
  const f = await nativeWorkspace(t, trashOptions);
  await f.close();
  await rm(resolve(f.root, "notes", ".trash"), { recursive: true });
  const unknown = resolve(f.root, "skills", ".trash", randomUUID());
  await mkdir(unknown);
  await writeFile(resolve(unknown, "opaque.bin"), "unknown bytes");

  await assert.rejects(f.reopen(trashOptions), error => error.code === "RECOVERY_CONFLICT");
  await f.close();
  await assert.rejects(readdir(resolve(f.root, "notes", ".trash")), { code: "ENOENT" });
  assert.equal(await readFile(resolve(unknown, "opaque.bin"), "utf8"), "unknown bytes");
});

test("missing trash root still conflicts when a journal owns an entry there", async t => {
  const f = await nativeWorkspace(t, trashOptions);
  const created = await call(f, "knowledge.note.create", {
    operationId: randomUUID(), expectedScanRevision: revision(f.root),
    title: "Journal-owned trash entry", content: "Preserve the journal-owned payload.",
  });
  assert.ok(created.result, JSON.stringify(created));
  const path = created.result.path;
  const preview = await call(f, "knowledge.trash.lifecycle.preview", { area: "notes", kind: "document", path });
  assert.ok(preview.result, JSON.stringify(preview));
  const moved = await call(f, "knowledge.trash.move", {
    operationId: randomUUID(), area: "notes", kind: "document", path,
    expectedTreeSha256: preview.result.treeSha256, expectedScanRevision: preview.result.scanRevision,
  });
  assert.ok(moved.result, JSON.stringify(moved));
  await f.close();
  await rm(resolve(f.root, "notes", ".trash"), { recursive: true });

  await assert.rejects(f.reopen(trashOptions), error => error.code === "RECOVERY_CONFLICT");
  await f.close();
  await assert.rejects(readdir(resolve(f.root, "notes", ".trash")), { code: "ENOENT" });
});

test("actual native final transaction failure preserves after-image intent; restart atomically restores index and receipt", async t => {
  const f = await nativeWorkspace(t);
  const operationId = randomUUID();
  const args = { operationId, expectedScanRevision: revision(f.root), title: "Interrupted final commit", content: "Exact after bytes." };
  const database = new DatabaseSync(resolve(f.root, "core.sqlite"));
  try {
    database.exec(`CREATE TRIGGER batch06_fail_receipt BEFORE INSERT ON receipts
      WHEN NEW.operation_id='${operationId}' BEGIN SELECT RAISE(ABORT,'synthetic final commit failure'); END`);
    const response = await call(f, "knowledge.note.create", args);
    assert.ok(response.error, JSON.stringify(response));
    assert.equal(database.prepare("SELECT count(*) n FROM migration_runtime_intents WHERE operation_id=?").get(operationId).n, 1);
    assert.equal(database.prepare("SELECT count(*) n FROM receipts WHERE operation_id=?").get(operationId).n, 0);
    assert.equal(database.prepare("SELECT count(*) n FROM documents").get().n, 0, "index rollback is atomic with receipt");
    assert.equal(scanMarkdown(f.root).length, 1, "source effect is preserved, not replayed or rolled back");
    database.exec("DROP TRIGGER batch06_fail_receipt");
  } finally { database.close(); }
  await f.reopen();
  const receipt = await call(f, "knowledge.note.create", args);
  assert.ok(receipt.result, JSON.stringify(receipt));
  assert.equal(scanMarkdown(f.root).length, 1);
  const recovered = new DatabaseSync(resolve(f.root, "core.sqlite"));
  try {
    assert.equal(recovered.prepare("SELECT count(*) n FROM migration_runtime_intents").get().n, 0);
    assert.equal(recovered.prepare("SELECT count(*) n FROM receipts WHERE operation_id=?").get(operationId).n, 1);
    assert.equal(recovered.prepare("SELECT count(*) n FROM documents WHERE id=?").get(receipt.result.id).n, 1);
  } finally { recovered.close(); }
});

test("rehashed specialized journal cannot change after bytes away from its immutable request", async t => {
  const f = await nativeWorkspace(t);
  const request = { operation: "knowledge.note.create", actorId: managerActor.id, args: {
    operationId: randomUUID(), expectedScanRevision: revision(f.root), title: "Rehashed journal", content: "AUTHORIZED-CONTENT",
  } };
  const { plan } = await seedKnowledgeIntent(f, request);
  const database = new DatabaseSync(resolve(f.root, "core.sqlite"));
  let altered;
  try {
    const row = database.prepare("SELECT * FROM migration_runtime_intents WHERE operation_id=?").get(plan.operationId);
    const wire = JSON.parse(row.plan_json);
    const changed = Buffer.from(wire.change.after, "base64").toString().replace("AUTHORIZED-CONTENT", "UNAUTHORIZED-BYTES");
    wire.change.after = Buffer.from(changed).toString("base64");
    wire.change.afterSha256 = wire.receipt.sha256 = digest(changed);
    altered = JSON.stringify(wire);
    const binding = [row.operation_id, row.workspace_id, row.root_path, row.actor_id, row.operation,
      row.fingerprint, row.request_json, altered];
    database.prepare("UPDATE migration_runtime_intents SET plan_json=?,digest=? WHERE operation_id=?")
      .run(altered, digest(JSON.stringify(binding)), plan.operationId);
  } finally { database.close(); }
  await assert.rejects(f.reopen(), error => error.code === "RECOVERY_CONFLICT");
  assert.equal(scanMarkdown(f.root).length, 0, "forged source bytes are never applied");
  const preserved = new DatabaseSync(resolve(f.root, "core.sqlite"));
  try { assert.equal(preserved.prepare("SELECT plan_json FROM migration_runtime_intents").get().plan_json, altered); }
  finally { preserved.close(); }
});

test("pending trash without explicit layout policy is preserved without filesystem replay", async t => {
  const f = await nativeWorkspace(t, trashOptions);
  const created = await call(f, "knowledge.note.create", { operationId: randomUUID(), expectedScanRevision: revision(f.root),
    title: "Pending policy", content: "Keep the original bytes." });
  const args = { area: "notes", kind: "document", path: created.result.path };
  const preview = previewTrashLifecycle(f.root, args);
  const input = trashLifecycleDefinitions[1].input.parse({ operationId: randomUUID(), ...args,
    expectedTreeSha256: preview.treeSha256, expectedScanRevision: preview.scanRevision });
  const plan = planTrashLifecycle(f.root, managerActor.id, input);
  const workspaceId = await f.storage.workspaceId();
  const original = await readFile(resolve(f.root, "notes", created.result.path));
  await f.close();
  const request = { operation: "knowledge.trash.move", actorId: managerActor.id, args: input };
  const requestJson = JSON.stringify(request);
  const values = [input.operationId, workspaceId, resolve(f.root), managerActor.id, request.operation,
    digest(requestJson), requestJson, serializeTrashLifecyclePlan(plan)];
  const database = new DatabaseSync(resolve(f.root, "core.sqlite"));
  try { database.prepare("INSERT INTO migration_runtime_intents VALUES(?,?,?,?,?,?,?,?,?)").run(...values, digest(JSON.stringify(values))); }
  finally { database.close(); }
  await assert.rejects(f.reopen({}), error => ["UNAVAILABLE", "RECOVERY_CONFLICT"].includes(error.code));
  assert.deepEqual(await readFile(resolve(f.root, "notes", created.result.path)), original);
  assert.deepEqual(await readdir(resolve(f.root, "notes", ".trash")), []);
});

test("native trash guards shared paired references, destination overwrite and tampered committed entry bytes", async t => {
  const f = await nativeWorkspace(t, trashOptions);
  const one = await call(f, "knowledge.note.create", { operationId: randomUUID(), expectedScanRevision: revision(f.root),
    title: "Source", content: "![asset](Source.assets/payload.bin)" });
  await mkdir(resolve(f.root, "notes", "Source.assets"));
  await writeFile(resolve(f.root, "notes", "Source.assets", "payload.bin"), "opaque");
  const outside = await call(f, "knowledge.note.create", { operationId: randomUUID(), expectedScanRevision: revision(f.root),
    title: "External", content: "![shared](Source.assets/payload.bin)" });
  const unsafe = await call(f, "knowledge.trash.lifecycle.preview", { area: "notes", path: one.result.path, kind: "document" });
  assert.ok(unsafe.error, JSON.stringify(unsafe));
  assert.equal(await readFile(resolve(f.root, "notes", "Source.assets", "payload.bin"), "utf8"), "opaque");
  const record = scanMarkdown(f.root).find(({ record }) => record.id === outside.result.id).record;
  await call(f, "knowledge.note.update", { operationId: randomUUID(), id: record.id, expectedScanRevision: revision(f.root),
    expectedRevision: record.revision, expectedSha256: record.sha256, content: "No shared reference." });
  const preview = await call(f, "knowledge.trash.lifecycle.preview", { area: "notes", path: one.result.path, kind: "document" });
  const move = await call(f, "knowledge.trash.move", { operationId: randomUUID(), area: "notes", path: one.result.path, kind: "document",
    expectedTreeSha256: preview.result.treeSha256, expectedScanRevision: preview.result.scanRevision });
  assert.ok(move.result, JSON.stringify(move));
  const target = resolve(f.root, "notes", one.result.path);
  await writeFile(target, "unrelated destination bytes");
  const pins = () => scanMarkdown(f.root).map(({ record }) => ({ id: record.id, area: record.area, path: record.path, revision: record.revision, sha256: record.sha256 }));
  const overwrite = await call(f, "knowledge.trash.restore", { operationId: randomUUID(), entryId: move.result.entryId,
    expectedScanRevision: digest(JSON.stringify(pins())) });
  assert.ok(overwrite.error, JSON.stringify(overwrite));
  assert.equal(await readFile(target, "utf8"), "unrelated destination bytes");
  const payload = resolve(f.root, "notes", ".trash", move.result.entryId, "assets", "payload.bin");
  await writeFile(payload, "unknown altered committed bytes");
  await f.close();
  await assert.rejects(f.reopen(trashOptions), error => error.code === "RECOVERY_CONFLICT");
  assert.equal(await readFile(payload, "utf8"), "unknown altered committed bytes");
  assert.equal(await readFile(target, "utf8"), "unrelated destination bytes");
});

test("v11-to-v18 workspace upgrade adds native tables without rewriting Markdown or immutable receipts", async t => {
  const f = await nativeWorkspace(t);
  const input = { operationId: randomUUID(), expectedScanRevision: revision(f.root), title: "Upgrade retained", content: "Original v11-compatible Markdown." };
  const receipt = (await call(f, "knowledge.note.create", input)).result;
  const path = resolve(f.root, "notes", receipt.path);
  const original = await readFile(path);
  await f.close();
  const old = new DatabaseSync(resolve(f.root, "core.sqlite"));
  let historical;
  try {
    historical = old.prepare("SELECT result FROM receipts WHERE operation_id=?").get(input.operationId).result;
    for (const table of ["manager_runtime_schema", "manager_runtime_runs", "manager_runtime_events",
      "manager_runtime_receipts", "migration_runtime_intents", "migration_runtime_trash"]) old.exec(`DROP TABLE ${table}`);
    old.exec("PRAGMA user_version=11");
  } finally { old.close(); }
  await f.reopen();
  assert.deepEqual(await readFile(path), original);
  const upgraded = new DatabaseSync(resolve(f.root, "core.sqlite"));
  try {
    assert.equal(upgraded.prepare("PRAGMA user_version").get().user_version, 23);
    for (const table of ["manager_runtime_runs", "manager_runtime_events", "manager_runtime_receipts",
      "migration_runtime_intents", "migration_runtime_trash"]) {
      assert.ok(upgraded.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table), table);
    }
    assert.equal(upgraded.prepare("SELECT result FROM receipts WHERE operation_id=?").get(input.operationId).result, historical);
  } finally { upgraded.close(); }
  assert.deepEqual((await call(f, "knowledge.note.create", input)).result, receipt);
});
