const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const { createHash, randomUUID } = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { pathToFileURL } = require("node:url");

const scratch = process.env.PKM_TRIAL_TEST_ROOT;
const server = process.env.PKM_TRIAL_SERVER_DIST;
const packageRoot = process.env.PKM_TRIAL_PACKAGE_ROOT;
const extension = process.env.PKM_TRIAL_EXTENSION_DIST;
if (!scratch || !server || !extension || !packageRoot) throw Error("Run with isolated compiled trial fixtures.");
const load = Module._load;
let NextManagedClient;
try {
  ({ NextManagedClient } = require(path.join(extension, "runtime/next-managed-client.js")));
} finally { Module._load = load; }

const node = fs.realpathSync(process.execPath);
const fixture = name => {
  const root = path.join(scratch, `${name}-${randomUUID()}`);
  fs.mkdirSync(root, { mode: 0o700 });
  return root;
};

test("production client private IPC carries exact Memory adoption and reads preserved native records", { timeout: 120000 }, async t => {
  const root = fixture("memory-import"), source = fixture("memory-copy"), legacy = fixture("unused-root");
  const database = path.join(scratch, `memory-${randomUUID()}.sqlite3`);
  const scope = '{"account":"synthetic-original","project":"original-project","repository":"original-repository"}';
  const sources = [{ id: "s", chat: "c", revision: "r", locator: "l" }];
  const id = `explicit-${createHash("sha256").update(`${scope}\0proposal`).digest("hex")}`;
  const python = fs.realpathSync(execFileSync("python3", ["-I", "-c", "import sys; print(sys.executable)"], { encoding: "utf8" }).trim());
  fs.mkdirSync(path.join(source, "notes"));
  fs.writeFileSync(path.join(source, "notes", "n.md"), "---\ntitle: Synthetic\n---\nSynthetic only.\n");
  execFileSync(python, ["-I", "-c", `
import json,sys
sys.path.insert(0,sys.argv[1])
from pkm_memory_engine import Engine
e=Engine(sys.argv[2],"synthetic-engine")
e.mutate("proposal","explicit_propose",{"id":sys.argv[4],"scope":sys.argv[3],"content":"Synthetic preserved fact","sources":json.loads(sys.argv[5])})
e.close()
`, path.join(__dirname, "../next-server/compute"), database, scope, id, JSON.stringify(sources)]);
  const before = fs.readFileSync(database), client = new NextManagedClient(), clients = [client];
  const restoredParent = fixture("memory-restored"), backup = path.join(scratch, `memory-backup-${randomUUID()}`);
  t.after(async () => {
    for (const current of clients) await current.close();
    for (const dir of [root, source, legacy, restoredParent, backup]) fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(database, { force: true });
  });
  const { MemoryMigrationAuthority } = require(path.join(extension, "runtime/memory-migration-authority.js"));
  let plan = await client.planImport(packageRoot, root, node, legacy, source, python, database);
  assert.equal(plan.ready, true, JSON.stringify(plan.blockers));
  assert.equal(plan.memoryPlan.actorId, "local:owner");
  plan = await client.selectMemoryScope(createHash("sha256").update(scope).digest("hex"));
  const authority = new MemoryMigrationAuthority(() => true);
  let approved = false;
  client.setMemoryScopeApprovalHandler(envelope => authority.authorize(envelope, {
    target: plan.target, actorId: "local:owner", scope,
    sourceDatabaseSha256: plan.memoryPlan.sourceSha256, importPlanSha256: plan.planSha256,
  }, async request => { approved = true; assert.equal(request.scope, scope); return true; }));
  const imported = await client.confirmImport(plan.planSha256);
  assert(approved);
  assert.equal(imported.outcome.status, "published");
  await client.attachImport();
  const enrolled = await client.prepareMemoryReadoption();
  const pin = enrolled.pin; // Independently retained by this synthetic fixture's trusted owner.
  assert.equal((await client.invoke("memory-get", { id })).scope, scope);
  assert.equal((await client.invoke("memory-audit", { id })).events[0].action, "proposed");
  assert.equal((await client.invoke("memory-replay", { operation: "memory.record.propose",
    arguments: { content: "Synthetic preserved fact", sources, operation_id: "proposal" } })).revision, 1);
  await assert.rejects(client.invoke("memory-replay", { operation: "memory.record.propose",
    arguments: { content: "New fact is not authorized", sources, operation_id: "new" } }), /outcome unknown/);
  assert.deepEqual(fs.readFileSync(database), before);
  const preparation = await client.prepareImportWrite();
  const credential = await client.enableImportWrite(preparation.authorizationDigest, preparation.target);
  const pendingRead = client.invoke("memory-get", { id });
  const closed = client.close();
  assert.equal((await pendingRead).scope, scope, "Close drains an already admitted real Memory read.");
  await closed;
  fs.rmSync(source, { recursive: true, force: true });
  fs.rmSync(database);
  const resumed = new NextManagedClient(); clients.push(resumed);
  await resumed.resumeImport(packageRoot, credential, node, legacy);
  await assert.rejects(resumed.invoke("memory-get", { id }), /outcome unknown/);
  const evidence = await resumed.prepareMemoryReadoption();
  assert.deepEqual(evidence.pin, pin, "Re-adoption needs neither the old Engine path nor the deleted source copy.");
  for (const changed of [
    { ...pin, importReceiptSha256: "0".repeat(64) },
    { ...pin, receiptStateSha256: "0".repeat(64) },
    { ...pin, actorId: "foreign" },
    { ...pin, scope: "foreign", sourceScopeSha256: createHash("sha256").update("foreign").digest("hex") },
  ]) await assert.rejects(resumed.readoptMemory(changed, async () => { throw Error("Must not confirm mismatched provenance"); }));
  await assert.rejects(resumed.readoptMemory(pin, async () => null));
  await assert.rejects(resumed.readoptMemory(pin, async () => ({
    actorId: pin.actorId, decisionId: randomUUID(), expiresAtMs: Date.now() - 1,
  })));
  await assert.rejects(resumed.invoke("memory-get", { id }), /outcome unknown/);
  const approveNew = (current, target) => {
    const newAuthority = new MemoryMigrationAuthority(() => true);
    return current.readoptMemory(pin, envelope => newAuthority.authorize(envelope, { ...pin, target }, async () => true));
  };
  await approveNew(resumed, evidence.target);
  assert.equal((await resumed.invoke("memory-get", { id })).scope, scope);
  assert.equal((await resumed.invoke("memory-replay", { operation: "memory.record.propose",
    arguments: { content: "Synthetic preserved fact", sources, operation_id: "proposal" } })).revision, 1);
  await resumed.close();
  execFileSync(node, [path.join(server, "cli.js"), "backup", "--data", plan.target, "--destination", backup],
    { stdio: "pipe" });
  const { restoreWorkspaceBackup } = await import(pathToFileURL(path.join(server, "workspace-backup.js")).href);
  const restored = path.join(restoredParent, "workspace");
  await assert.rejects(restoreWorkspaceBackup(backup, restored, { pythonExecutable: python }), { code: "AUTHORITY_REQUIRED" });
  await restoreWorkspaceBackup(backup, restored, { pythonExecutable: python, nativeRestoreAuthority: {
    actorId: "synthetic-independent-owner",
    async authorize(request) {
      assert.equal(request.workspaceId, pin.workspaceId);
      assert.equal(request.sourceRoot, backup);
      assert.equal(request.destination, restored);
      return { actorId: request.actorId, authorityId: "synthetic-independent-lineage",
        requestSha256: createHash("sha256").update(JSON.stringify(request)).digest("hex"),
        expiresAt: Date.now() + 60_000, lineage: "unrelated", trustedEpoch: null };
    },
  } });
  const reopened = new NextManagedClient(); clients.push(reopened);
  await reopened.openMemoryWorkspace(packageRoot, restored, node, legacy);
  await assert.rejects(reopened.invoke("memory-get", { id }), /outcome unknown/);
  assert.deepEqual((await reopened.prepareMemoryReadoption()).pin, pin);
  await approveNew(reopened, restored);
  assert.equal((await reopened.invoke("memory-get", { id })).scope, scope);
  assert.equal((await reopened.invoke("memory-replay", { operation: "memory.record.propose",
    arguments: { content: "Synthetic preserved fact", sources, operation_id: "proposal" } })).revision, 1);
  await reopened.close();
  const { DatabaseSync } = require("node:sqlite");
  const altered = new DatabaseSync(path.join(restored, "core.sqlite"));
  try {
    const row = altered.prepare("SELECT result_json FROM legacy_memory_import_operations WHERE operation_id='proposal'").get();
    const result = JSON.stringify({ ...JSON.parse(row.result_json), content: "Self-consistent forged historical result" });
    altered.prepare("UPDATE legacy_memory_import_operations SET result_json=? WHERE operation_id='proposal'").run(result);
    altered.prepare("UPDATE receipts SET result=? WHERE operation_id='proposal'").run(result);
  } finally { altered.close(); }
  const tampered = new NextManagedClient(); clients.push(tampered);
  await tampered.openMemoryWorkspace(packageRoot, restored, node, legacy);
  assert.notEqual((await tampered.prepareMemoryReadoption()).pin.receiptStateSha256, pin.receiptStateSha256);
  await assert.rejects(tampered.readoptMemory(pin, async () => { throw Error("Forged state must not reach host confirmation"); }));
  await assert.rejects(tampered.invoke("memory-get", { id }), /outcome unknown/);
});

test("private child starts only on a fresh isolated directory, serves document operations and drains", { timeout: 30000 }, async t => {
  const root = fixture("trial"), legacy = fixture("legacy");
  t.after(() => { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(legacy, { recursive: true, force: true }); });
  const client = new NextManagedClient();
  assert.match(await client.start(packageRoot, root, node, legacy), /^[a-f0-9-]{36}$/);
  const input = { id: "trial-document", operationId: randomUUID(), title: "Test", content: "Initial" };
  const created = await client.invoke("create", input);
  assert.equal(created.result.content, "Initial");
  assert.equal((await client.invoke("list", {})).result.items[0].id, input.id);
  const read = (await client.invoke("get", { id: input.id })).result;
  const write = client.invoke("update", { id: input.id, operationId: randomUUID(), expectedRevision: read.revision,
    expectedSha256: read.sha256, title: read.title, content: "Changed" });
  const closed = client.close();
  await assert.rejects(client.invoke("get", { id: input.id }), /not connected/);
  assert.equal((await write).result.content, "Changed");
  await closed;
  assert.equal(fs.readdirSync(legacy).length, 0);
  await assert.rejects(new NextManagedClient().start(packageRoot, root, node, legacy), /empty/);
  await assert.rejects(new NextManagedClient().start(packageRoot, legacy, node, legacy), /must not overlap/);
});

test("child crash rejects pending and subsequent calls; startup errors preserve the chosen directory", { timeout: 30000 }, async t => {
  const root = fixture("crash"), legacy = fixture("legacy");
  t.after(() => { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(legacy, { recursive: true, force: true }); });
  const client = new NextManagedClient();
  await client.start(packageRoot, root, node, legacy);
  const inFlight = client.invoke("create", { id: "crash", operationId: randomUUID(), title: "Crash", content: "unknown" });
  client.child.kill("SIGKILL");
  await assert.rejects(inFlight, /unknown/);
  await assert.rejects(client.close(), /unknown|unexpected/);
  await assert.rejects(client.invoke("list", {}), /not connected/);
  const selected = fixture("bad-node");
  t.after(() => fs.rmSync(selected, { recursive: true, force: true }));
  await assert.rejects(new NextManagedClient().start(packageRoot, selected, "/nonexistent/node", legacy));
  assert.deepEqual(fs.readdirSync(selected), []);
  if (process.getuid?.() !== 0) {
    fs.chmodSync(selected, 0o500);
    try {
      await assert.rejects(new NextManagedClient().start(packageRoot, selected, node, legacy), /startup failed|exited during startup/);
      assert.deepEqual(fs.readdirSync(selected), []);
    } finally { fs.chmodSync(selected, 0o700); }
  }
});

test("modified payload fails verification before touching the selected directory", async t => {
  const root = fixture("integrity"), legacy = fixture("legacy");
  const entry = path.join(server, "managed-client-child.js");
  const original = fs.readFileSync(entry);
  t.after(() => {
    fs.writeFileSync(entry, original);
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(legacy, { recursive: true, force: true });
  });
  fs.appendFileSync(entry, "\n// altered\n");
  await assert.rejects(new NextManagedClient().start(packageRoot, root, node, legacy), /digest mismatch/);
  assert.deepEqual(fs.readdirSync(root), []);
});

test("production client imports only an approved static copy and attaches read-only via private child", { timeout: 120000 }, async t => {
  const root = fixture("import"), source = fixture("copy"), legacy = fixture("legacy");
  const client = new NextManagedClient();
  t.after(async () => {
    try { await client.close(); }
    finally {
      if (client.isStopped()) for (const dir of [root, source, legacy]) fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  fs.mkdirSync(path.join(source, "notes"));
  const note = "---\ntitle: Fixture\ndocumentId: fixture-note\nrevision: 2\n---\nFixture content\n";
  fs.writeFileSync(path.join(source, "notes/Fixture.md"), note);
  const archive = Buffer.from("raise RuntimeError('PRESERVED DATA MUST NOT EXECUTE')\n");
  const areas = ["packages", "actions", "components", "action-module-sets"];
  for (const area of areas) {
    fs.mkdirSync(path.join(source, area));
    fs.writeFileSync(path.join(source, area, ".inert.py"), archive, { mode: 0o751 });
  }
  const python = fs.realpathSync(execFileSync("python3", ["-c", "import sys; print(sys.executable)"], { encoding: "utf8" }).trim());
  const plan = await client.planImport(packageRoot, root, node, legacy, source, python);
  assert.equal(plan.ready, true, JSON.stringify(plan.blockers));
  assert.deepEqual(plan.blockers, []);
  assert.equal(plan.target, path.join(root, "workspace"));
  assert.equal(fs.existsSync(plan.target), false);
  await assert.rejects(client.confirmImport("0".repeat(64)), /rejected/);
  const imported = await client.confirmImport(plan.planSha256);
  assert.equal(imported.outcome.status, "published");
  assert.equal((await client.importStatus()).outcome.status, "published");
  const before = fs.readFileSync(path.join(root, "workspace/notes/Fixture.md"), "utf8");
  await client.attachImport();
  const listing = await client.invoke("list", { limit: 100 });
  assert.equal(listing.result.items[0].id, "fixture-note");
  const read = await client.invoke("get", { id: "fixture-note" });
  assert.equal(read.result.content, "Fixture content\n");
  for (const area of areas) {
    const listing = (await client.invoke("library-list", { area, offset: 0, limit: 50 })).result;
    const item = listing.items.find(item => item.path === `${area}/.inert.py`);
    assert(item, "Preserved hidden archive data must be visible through the existing read-only client");
    assert.equal(item.identityStatus, "not-applicable");
    assert.equal(item.scriptIdentity, null);
    assert.equal(item.prompt, null);
    assert.equal(item.sha256, createHash("sha256").update(archive).digest("hex"));
    const detail = (await client.invoke("library-get", { area, path: item.path, expectedDigest: item.sha256,
      snapshotRevision: listing.snapshotRevision, offset: 0, length: 65536 })).result;
    assert.deepEqual(Buffer.from(detail.data, "base64"), archive);
    assert.equal(detail.legacy, null);
    assert.equal(fs.existsSync(path.join(root, "workspace", area)), false);
    assert.deepEqual(fs.readFileSync(path.join(root, "workspace/legacy-code-archive", item.path)), archive);
  }
  await assert.rejects(client.invoke("create", { id: "forbidden" }), /read-only/);
  await assert.rejects(client.invoke("update", { id: "fixture-note" }), /read-only/);
  await assert.rejects(client.confirmImport(plan.planSha256), /rejected/);
  await client.close();
  assert.equal(fs.readFileSync(path.join(root, "workspace/notes/Fixture.md"), "utf8"), before);
  assert.equal(fs.readFileSync(path.join(source, "notes/Fixture.md"), "utf8"), note);
  for (const area of areas) {
    assert.deepEqual(fs.readFileSync(path.join(source, area, ".inert.py")), archive);
    assert.equal(fs.statSync(path.join(source, area, ".inert.py")).mode & 0o777, 0o751);
  }
  assert.deepEqual(fs.readdirSync(legacy), []);
});

test("imported legacy Board reads reuse Todo contracts without mutating backing data or granting writes", { timeout: 120000 }, async t => {
  const root = fixture("board"), source = fixture("board-copy"), legacy = fixture("legacy"), client = new NextManagedClient();
  t.after(async () => {
    try { await client.close(); }
    finally { if (client.isStopped()) for (const dir of [root, source, legacy]) fs.rmSync(dir, { recursive: true, force: true }); }
  });
  fs.mkdirSync(path.join(source, "notes"));
  fs.mkdirSync(path.join(source, "notes/Board.assets"));
  fs.writeFileSync(path.join(source, "notes/Board.md"), "---\ntitle: Board\ndocumentId: imported-board\ndocumentKind: todo-board\n---\n");
  const item = { id: "original-task", kind: "Task", title: "Original contract", goal: "Keep it", scope: "Readonly",
    acceptance: ["No writes"], state: "Planning", evidence: [] };
  const board = JSON.stringify({ schema: "pkm.todo-board/v1", items: [item],
    workers: { "external:copilot:fixture": "e".repeat(64) } }, null, 2) + "\n";
  fs.writeFileSync(path.join(source, "notes/Board.assets/pkm-todo-board.json"), board);
  const python = fs.realpathSync(execFileSync("python3", ["-c", "import sys; print(sys.executable)"], { encoding: "utf8" }).trim());
  const plan = await client.planImport(packageRoot, root, node, legacy, source, python);
  assert.equal(plan.ready, true, JSON.stringify(plan.blockers));
  await client.confirmImport(plan.planSha256); await client.attachImport();
  const listing = await client.invoke("board-list", { offset: 0, limit: 1 });
  assert.equal(listing.result.items[0].slug, "Board");
  const summary = await client.invoke("board-get", { board_slug: "Board" });
  assert.equal(summary.result.counts.workitems, 1);
  const tasks = await client.invoke("board-tasks", { board_slug: "Board", expected_digest: summary.result.digest, offset: 0, limit: 1 });
  assert.equal(tasks.result.items[0].title, item.title);
  assert.equal(tasks.result.items[0].state, "Planning");
  assert(!JSON.stringify(tasks).includes("e".repeat(64)), "Worker authority grants are not exposed by read projections");
  assert.equal((await client.invoke("board-stories", { board_slug: "Board", expected_digest: summary.result.digest })).result.total, 0);
  assert((await client.invoke("board-get", { board_slug: "../outside" })).error);
  assert((await client.invoke("board-tasks", { board_slug: "Board", expected_digest: "0".repeat(64) })).error);
  assert((await client.invoke("board-tasks", { board_slug: "Board", operationId: randomUUID(), item: { title: "Must not mutate" } })).error,
    "Read contracts must refuse injected mutation arguments");
  await assert.rejects(client.invoke("update", { id: "imported-board", content: "No" }), /read-only/);
  const targetBoard = path.join(root, "workspace/boards/Board/pkm-todo-board.json");
  assert.equal(fs.readFileSync(targetBoard, "utf8"), board);
  await client.close();
  assert.equal(fs.readFileSync(targetBoard, "utf8"), board);
  assert.equal(fs.readFileSync(path.join(source, "notes/Board.assets/pkm-todo-board.json"), "utf8"), board);
  assert.deepEqual(fs.readdirSync(legacy), []);
  const invalidSource = fixture("invalid-board-copy"), invalidParent = fixture("invalid-board"), invalidClient = new NextManagedClient();
  t.after(async () => {
    try { await invalidClient.close(); }
    finally { if (invalidClient.isStopped()) for (const dir of [invalidSource, invalidParent]) fs.rmSync(dir, { recursive: true, force: true }); }
  });
  fs.mkdirSync(path.join(invalidSource, "notes"));
  fs.mkdirSync(path.join(invalidSource, "notes/Invalid.assets"));
  fs.writeFileSync(path.join(invalidSource, "notes/Invalid.md"), "---\ntitle: Invalid\ndocumentId: invalid-board\ndocumentKind: todo-board\n---\n");
  fs.writeFileSync(path.join(invalidSource, "notes/Invalid.assets/pkm-todo-board.json"), '{"schema":"unsupported","items":[]}');
  const invalidPlan = await invalidClient.planImport(packageRoot, invalidParent, node, legacy, invalidSource, python);
  assert.equal(invalidPlan.ready, false, "Unsupported Board codec must block, never repair or display fabricated tasks");
  assert(invalidPlan.blockers.length);
  assert.equal(fs.existsSync(path.join(invalidParent, "workspace")), false);
  await invalidClient.close();
});

test("production command adapter uses explicit prompts and drives the real isolated child", { timeout: 30000 }, async t => {
  const root = fixture("ui"), legacy = fixture("legacy");
  t.after(() => { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(legacy, { recursive: true, force: true }); });
  const commands = new Map(), information = [], errors = [];
  const inputs = ["UI document", "UI initial", "UI changed"];
  const picks = ["Create document", "List and edit documents"];
  const dialogs = [{ fsPath: root }, { fsPath: node }];
  const vscode = {
    commands: { registerCommand(name, action) { commands.set(name, action); return { dispose() {} }; } },
    window: {
      showOpenDialog: async () => [dialogs.shift()],
      showWarningMessage: async () => "Create Trial",
      showInputBox: async () => inputs.shift(),
      showQuickPick: async choices => typeof choices[0] === "object" ? choices[0] : picks.shift(),
      showInformationMessage: async value => information.push(value),
      showErrorMessage: async value => errors.push(value),
    },
  };
  let adapter;
  try {
    Module._load = function (name, ...args) {
      if (name === "vscode") return vscode;
      return load.call(this, name, ...args);
    };
    adapter = require(path.join(extension, "ui/next-managed-trial.js"));
  } finally { Module._load = load; }
  const context = { extensionPath: packageRoot, subscriptions: [] };
  adapter.registerNextManagedTrial(context, () => legacy);
  assert.deepEqual(fs.readdirSync(root), [], "registration must not start a child");
  await commands.get("personalKnowledge.nextTrialStart")();
  await commands.get("personalKnowledge.nextTrialDocuments")();
  await commands.get("personalKnowledge.nextTrialClose")();
  assert.deepEqual(errors, []);
  assert(information.some(value => value.includes("created")));
  assert(information.some(value => value.includes("updated")));
  assert.deepEqual(fs.readdirSync(legacy), []);
});

test("production import UI drives the verified real child through plan, confirmation, publication and read-only preview", { timeout: 120000 }, async t => {
  const root = fixture("import-ui"), source = fixture("import-ui-copy"), legacy = fixture("legacy");
  fs.mkdirSync(path.join(source, "notes"));
  const note = "---\ntitle: UI copy\ndocumentId: ui-copy\nrevision: 2\n---\nSynthetic UI copy\n";
  fs.writeFileSync(path.join(source, "notes/Copy.md"), note);
  const python = fs.realpathSync(execFileSync("python3", ["-c", "import sys; print(sys.executable)"], { encoding: "utf8" }).trim());
  const dialogs = [source, root, node, python], commands = new Map(), warnings = [], errors = [], information = [], previews = [];
  const vscode = {
    commands: { registerCommand(name, action) { commands.set(name, action); return { dispose() {} }; } },
    workspace: { openTextDocument: async options => { previews.push(options); return options; } },
    window: {
      showOpenDialog: async () => [{ fsPath: dialogs.shift() }],
      showWarningMessage: async (message, options) => {
        warnings.push({ message, detail: options.detail });
        if (warnings.length === 1) return "I Assert Static Copy";
        assert.match(options.detail, /Plan digest: [a-f0-9]{64}/);
        assert.match(options.detail, /Blockers:\nNone/);
        assert.equal(fs.existsSync(path.join(root, "workspace")), false, "Confirmation must precede import");
        return "Import Exact Plan";
      },
      showInformationMessage: async message => information.push(message),
      showErrorMessage: async message => errors.push(message),
      showQuickPick: async choices => {
        if (choices[0] === "No Memory Engine") return choices[0];
        assert.equal(choices.length, 1);
        assert.equal(choices[0].label, "UI copy");
        return choices[0];
      },
      showTextDocument: async () => {},
    },
  };
  const file = path.join(extension, "ui/next-managed-trial.js");
  delete require.cache[require.resolve(file)];
  let adapter;
  try {
    Module._load = function (name, ...args) {
      if (name === "vscode") return vscode;
      return load.call(this, name, ...args);
    };
    adapter = require(file);
  } finally { Module._load = load; }
  t.after(async () => {
    await adapter.closeNextManagedTrial();
    for (const dir of [root, source, legacy]) fs.rmSync(dir, { recursive: true, force: true });
  });
  adapter.registerNextManagedTrial({ extensionPath: packageRoot, subscriptions: [] }, () => legacy);
  await commands.get("personalKnowledge.nextTrialImport")();
  assert.deepEqual(errors, []);
  assert.equal(warnings.length, 2);
  assert.match(warnings[0].detail, /assertion, not a writer fence/);
  assert.match(warnings[1].detail, /not a complete file integrity proof/);
  assert(information.some(message => /attached read-only/.test(message)));
  assert.equal(previews[0].content, "Synthetic UI copy\n");
  await commands.get("personalKnowledge.nextTrialDocuments")();
  assert.equal(previews.length, 2);
  await commands.get("personalKnowledge.nextTrialClose")();
  assert.deepEqual(errors, []);
  assert.deepEqual(dialogs, []);
  assert.equal(fs.readFileSync(path.join(source, "notes/Copy.md"), "utf8"), note);
  assert.deepEqual(fs.readdirSync(legacy), []);
});
