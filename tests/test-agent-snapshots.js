#!/usr/bin/env node
const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");

const { createAgentSnapshot, deleteAgentSnapshot, listAgentSnapshots, renameAgentSnapshot, readAgentSnapshotContents } = require("../dist/agent-sessions/agent-snapshots");

function encryptPayload(payload, snapshotId, magicCode, keyText = "uone") {
  const iv = crypto.randomBytes(12);
  const key = crypto.createHash("sha256").update(keyText, "utf8").digest();
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(`pkm.agent.snapshot/v1:${snapshotId}:${magicCode}`, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
  return {
    algorithm: keyText === "uone"
      ? "A256GCM-PKM-LOCAL-OBFUSCATION/v1"
      : "A256GCM-PKM-INTERNAL/v1",
    iv: iv.toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url"),
  };
}

function decryptPayload(payload, snapshotId, magicCode) {
  const key = crypto.createHash("sha256").update("uone", "utf8").digest();
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(payload.iv, "base64url"));
  decipher.setAAD(Buffer.from(`pkm.agent.snapshot/v1:${snapshotId}:${magicCode}`, "utf8"));
  decipher.setAuthTag(Buffer.from(payload.tag, "base64url"));
  return JSON.parse(Buffer.concat([
    decipher.update(Buffer.from(payload.ciphertext, "base64url")),
    decipher.final(),
  ]).toString("utf8"));
}

const store = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-agent-snapshots-"));
try {
  const state = path.join(store, ".pkm", "state");
  const sessions = path.join(state, "agent-sessions");
  const runs = path.join(state, "recipe-runs");
  fs.mkdirSync(sessions, { recursive: true });
  fs.mkdirSync(runs, { recursive: true });
  const sessionId = "agent_session_snapshot_test";
  const runId = "recipe_run_snapshot_test";
  fs.writeFileSync(path.join(runs, `${runId}.json`), JSON.stringify({
    schema: "pkm.recipe.run/v1",
    runId,
    status: "running",
    receipts: { shouldNotPersist: true },
    nodes: { work: { state: "running" } },
  }));
  fs.writeFileSync(path.join(sessions, `${sessionId}.json`), JSON.stringify({
    schema: "pkm.agent.session/v1",
    sessionId,
    status: "running",
    task: "Validate Agent Snapshot storage",
    projectId: "project_pkm",
    hostSessionId: "copilot-source",
    agent: { name: "Copilot Agent", product: "GitHub Copilot" },
    recipeRunIds: [runId],
    todos: [{ todoId: "todo_work", title: "Validate storage", status: "running", recipeRunId: runId }],
    todoCommandReceipts: { shouldNotPersist: true },
    checkpoints: [{ checkpointId: "checkpoint_test", sequence: 1, reason: "restart", createdAt: "2026-09-23T00:00:00Z" }],
    privateContext: "sensitive snapshot payload",
    createdAt: "2026-09-23T00:00:00Z",
    updatedAt: "2026-09-23T00:01:00Z",
  }));

  const created = createAgentSnapshot(store, sessionId, "restart");
  assert.match(created.snapshot.magicCode, /^PKM-SNAP-(?:[A-F0-9]{4}-){3}[A-F0-9]{4}$/);
  assert.strictEqual(
    created.recoveryPrompt,
    `Call the PKM MCP function agent_session_snapshot_recover with {"magic_code":"${created.snapshot.magicCode}"}.`,
  );

  const snapshotPath = path.join(state, "agent-snapshots", `${created.snapshot.snapshotId}.json`);
  const snapshotText = fs.readFileSync(snapshotPath, "utf8");
  const snapshot = JSON.parse(snapshotText);
  assert.strictEqual(snapshot.schema, "pkm.agent.snapshot/v1");
  assert.strictEqual(snapshot.payload.algorithm, "A256GCM-PKM-LOCAL-OBFUSCATION/v1");
  assert.strictEqual(snapshot.recovery, undefined);
  assert.ok(!snapshotText.includes("sensitive snapshot payload"));
  assert.strictEqual(snapshot.capture.todoCount, 1);
  assert.strictEqual(snapshot.capture.recipeRunCount, 1);

  const listed = listAgentSnapshots(store);
  assert.strictEqual(listed.length, 1);
  assert.strictEqual(listed[0].todoCount, 1);
  assert.strictEqual(listed[0].recipeRunCount, 1);
  assert.strictEqual(listed[0].recoveryCount, 0);
  assert.strictEqual(fs.readFileSync(snapshotPath, "utf8"), snapshotText,
    "listing a healthy Snapshot must not rewrite its immutable record");

  const captured = readAgentSnapshotContents(store, snapshot.snapshotId);
  assert.deepStrictEqual(captured, { snapshotId: snapshot.snapshotId, ...decryptPayload(snapshot.payload, snapshot.snapshotId, snapshot.magicCode) });
  assert.strictEqual(captured.session.privateContext, "sensitive snapshot payload");
  assert.strictEqual(captured.session.todos[0].title, "Validate storage");
  assert.strictEqual(captured.session.checkpoints[0].checkpointId, "checkpoint_test");
  assert.strictEqual(captured.session.todoCommandReceipts, undefined);
  assert.strictEqual(captured.recipeRuns[0].receipts, undefined);
  assert.strictEqual(captured.recipeRuns[0].nodes.work.state, "running");
  assert.strictEqual(fs.readFileSync(snapshotPath, "utf8"), snapshotText, "inspection must not rewrite the Snapshot");
  const sessionPath = path.join(sessions, `${sessionId}.json`);
  const trashDirectory = path.join(state, "agent-sessions-trash");
  const trashedSessionPath = path.join(trashDirectory, `${sessionId}.json`);
  fs.mkdirSync(trashDirectory, { recursive: true });
  fs.renameSync(sessionPath, trashedSessionPath);
  const trashedSessionText = fs.readFileSync(trashedSessionPath, "utf8");
  const archived = createAgentSnapshot(store, sessionId, "blocked source chat");
  assert.strictEqual(archived.snapshot.sourceSessionId, sessionId);
  assert.strictEqual(archived.snapshot.sourceHostSessionId, "copilot-source");
  const archivedContents = readAgentSnapshotContents(store, archived.snapshot.snapshotId);
  assert.deepStrictEqual(archivedContents.session, captured.session);
  assert.deepStrictEqual(archivedContents.recipeRuns, captured.recipeRuns);
  assert.strictEqual(fs.existsSync(sessionPath), false, "capture must not restore a trashed Session");
  assert.strictEqual(fs.readFileSync(trashedSessionPath, "utf8"), trashedSessionText,
    "capture must not mutate the source Session or adopt its transport");
  fs.unlinkSync(path.join(state, "agent-snapshots", `${archived.snapshot.snapshotId}.json`));
  fs.renameSync(trashedSessionPath, sessionPath);
  fs.writeFileSync(path.join(sessions, `${sessionId}.json`), JSON.stringify({ task: "Changed live Session", todos: [] }));
  assert.deepStrictEqual(readAgentSnapshotContents(store, snapshot.snapshotId), captured, "inspection reads the capture, not live state");
  assert.throws(() => readAgentSnapshotContents(store, "../snapshot"), /identity is invalid/);
  assert.throws(() => readAgentSnapshotContents(store, "agent_snapshot_missing"), /not found/);

  const corruptId = "agent_snapshot_inspection_corrupt";
  const corruptPath = path.join(state, "agent-snapshots", `${corruptId}.json`);
  fs.writeFileSync(corruptPath, JSON.stringify({ ...snapshot, snapshotId: corruptId }));
  assert.throws(() => readAgentSnapshotContents(store, corruptId), /authenticate|authentication|decrypt/i);
  fs.writeFileSync(corruptPath, JSON.stringify({ ...snapshot, snapshotId: corruptId, schema: "unsupported" }));
  assert.throws(() => readAgentSnapshotContents(store, corruptId), /schema is unsupported/);
  fs.unlinkSync(corruptPath);

  assert.strictEqual(listed[0].name, snapshot.task);
  renameAgentSnapshot(store, snapshot.snapshotId, "  Short name  ");
  const renamed = JSON.parse(fs.readFileSync(snapshotPath, "utf8"));
  assert.deepStrictEqual(renamed, { ...snapshot, name: "Short name" },
    "renaming changes display metadata only, preserving identity and the exact recovery payload");
  assert.strictEqual(listAgentSnapshots(store)[0].name, "Short name");
  assert.strictEqual(listAgentSnapshots(store)[0].task, snapshot.task);
  assert.throws(() => renameAgentSnapshot(store, snapshot.snapshotId, "  "), /name must/);
  assert.throws(() => renameAgentSnapshot(store, snapshot.snapshotId, "x".repeat(201)), /name must/);
  assert.throws(() => renameAgentSnapshot(store, snapshot.snapshotId, "first\nsecond"), /name must/);
  assert.throws(() => renameAgentSnapshot(store, "../snapshot", "Short"), /identity is invalid/);
  assert.throws(() => renameAgentSnapshot(store, "agent_snapshot_missing", "Short"), /not found/);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(snapshotPath, "utf8")), renamed);

  const doubleWrapped = JSON.parse(fs.readFileSync(snapshotPath, "utf8"));
  doubleWrapped.capture = { recipeRunCount: 0, todoCount: 0 };
  doubleWrapped.payload = encryptPayload(
    doubleWrapped.payload, doubleWrapped.snapshotId, doubleWrapped.magicCode);
  fs.writeFileSync(snapshotPath, JSON.stringify(doubleWrapped));
  const repaired = listAgentSnapshots(store).find(item => item.snapshotId === created.snapshot.snapshotId);
  assert.strictEqual(repaired.todoCount, 1);
  assert.strictEqual(repaired.recipeRunCount, 1);
  assert.strictEqual(repaired.name, "Short name");
  const repairedRecord = JSON.parse(fs.readFileSync(snapshotPath, "utf8"));
  const repairedPayload = decryptPayload(
    repairedRecord.payload, repairedRecord.snapshotId, repairedRecord.magicCode);
  assert.ok(repairedPayload.session);
  assert.ok(Array.isArray(repairedPayload.recipeRuns));
  assert.strictEqual(repairedPayload.algorithm, undefined, "migration removes nested encryption envelopes");

  fs.writeFileSync(path.join(sessions, "agent_session_recovered.json"), JSON.stringify({
    schema: "pkm.agent.session/v1",
    sessionId: "agent_session_recovered",
    provenance: { kind: "agent-snapshot", snapshotId: created.snapshot.snapshotId },
  }));
  assert.strictEqual(listAgentSnapshots(store)[0].recoveryCount, 1);

  const legacyId = "agent_snapshot_legacy_test";
  const legacyPath = path.join(state, "agent-snapshots", `${legacyId}.json`);
  fs.writeFileSync(legacyPath, JSON.stringify({
    schema: "pkm.agent.snapshot/v1",
    snapshotId: legacyId,
    magicCode: "PKM-SNAP-1111-2222-3333-4444",
    sourceSessionId: sessionId,
    sourceHostSessionId: "copilot-source",
    task: "Legacy snapshot",
    projectId: "project_pkm",
    agent: { name: "Copilot Agent", product: "GitHub Copilot" },
    reason: "legacy",
    createdAt: "2026-09-22T00:00:00Z",
    recovery: { algorithm: "scrypt-sha256/v1", salt: "00", verifier: "legacy" },
    payload: { session: { todos: [{ title: "legacy plaintext todo" }], checkpoints: [] }, recipeRuns: [] },
  }));
  listAgentSnapshots(store);
  const migratedLegacy = fs.readFileSync(legacyPath, "utf8");
  assert.doesNotMatch(migratedLegacy, /legacy plaintext todo/);
  assert.strictEqual(JSON.parse(migratedLegacy).payload.algorithm, "A256GCM-PKM-LOCAL-OBFUSCATION/v1");
  assert.strictEqual(JSON.parse(migratedLegacy).recovery, undefined);

  const legacyEncryptedId = "agent_snapshot_legacy_encrypted";
  const legacyEncryptedMagic = "PKM-SNAP-AAAA-BBBB-CCCC-DDDD";
  const legacyEncryptedPath = path.join(state, "agent-snapshots", `${legacyEncryptedId}.json`);
  const legacyPayload = { session: { todos: [{ title: "legacy encrypted todo" }], checkpoints: [] }, recipeRuns: [] };
  fs.writeFileSync(legacyEncryptedPath, JSON.stringify({
    schema: "pkm.agent.snapshot/v1",
    snapshotId: legacyEncryptedId,
    magicCode: legacyEncryptedMagic,
    sourceSessionId: sessionId,
    task: "Legacy encrypted snapshot",
    createdAt: "2026-09-21T00:00:00Z",
    recovery: { algorithm: "scrypt-sha256/v1", salt: "00", verifier: "legacy" },
    payload: encryptPayload(
      legacyPayload, legacyEncryptedId, legacyEncryptedMagic, "uone:agent-snapshot:payload:v1"),
  }));
  listAgentSnapshots(store);
  const migratedEncrypted = JSON.parse(fs.readFileSync(legacyEncryptedPath, "utf8"));
  assert.strictEqual(migratedEncrypted.payload.algorithm, "A256GCM-PKM-LOCAL-OBFUSCATION/v1");
  assert.strictEqual(migratedEncrypted.recovery, undefined);
  assert.doesNotMatch(JSON.stringify(migratedEncrypted), /legacy encrypted todo/);

  deleteAgentSnapshot(store, created.snapshot.snapshotId);
  deleteAgentSnapshot(store, legacyId);
  deleteAgentSnapshot(store, legacyEncryptedId);
  assert.deepStrictEqual(listAgentSnapshots(store), []);
  assert.throws(() => deleteAgentSnapshot(store, created.snapshot.snapshotId), /not found/);
} finally {
  fs.rmSync(store, { recursive: true, force: true });
}

const projectsSource = fs.readFileSync(path.join(__dirname, "../src/webview/panel/15-projects.js"), "utf8");
const extensionSource = fs.readFileSync(path.join(__dirname, "../src/extension.ts"), "utf8");
const knowledgeSource = fs.readFileSync(path.join(__dirname, "../src/webview/panel/20-knowledge.js"), "utf8");
const coreSource = fs.readFileSync(path.join(__dirname, "../src/webview/panel/00-core.js"), "utf8");
const snapshotFixture = { snapshotId: "agent_snapshot_ui_test", magicCode: "PKM-SNAP-1111-2222-3333-4444", task: "Original captured task", name: "Short <name>" };
let modal;
let menu;
const requests = [];
const clipboardMessages = [];
const detail = { innerHTML: "", dataset: {}, scrollTop: 80, scrollLeft: 12, querySelectorAll: () => [] };
const ui = {
  projectSnapshot: { agentSnapshots: [snapshotFixture], agentSessions: [] },
  selectedAgentSnapshotId: snapshotFixture.snapshotId, selectedAgentSessionId: "",
  agentSnapshotContentsState: null,
  state: { tab: "agentSnapshots" },
  catExpanded: {}, githubSyncTypes: [],
  btoa: value => Buffer.from(value, "binary").toString("base64"),
  privacyInherited: () => false,
  uiIcon: name => `<span class="codicon codicon-${name}"></span>`,
  esc: value => String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;"),
  document: { getElementById: () => detail },
  ask: (command, data) => requests.push({ command, data }),
  pkModal: options => { modal = options; },
  vscode: { postMessage: message => clipboardMessages.push(message) },
  showPaperMenu: (left, top, items) => { menu = items; },
};
vm.createContext(ui);
vm.runInContext(coreSource.slice(coreSource.indexOf("function captureRefreshView("),
  coreSource.indexOf("function captureRefreshInputs(")), ui);
vm.runInContext(knowledgeSource.slice(knowledgeSource.indexOf("function buildCatTree("),
  knowledgeSource.indexOf("function openCatFolderAddMenu(")), ui);
vm.runInContext(projectsSource.slice(projectsSource.indexOf("function recipeCopyPathMenu("),
  projectsSource.indexOf("function recipeRootMenu(")), ui);
vm.runInContext(projectsSource.slice(projectsSource.indexOf("function agentSnapshotSelect("),
  projectsSource.indexOf("function agentSessionContextMenu(")), ui);
vm.runInContext(projectsSource.slice(projectsSource.indexOf("function renderAgentSnapshots("),
  projectsSource.indexOf("function projectGanttBody(")), ui);
ui.agentSnapshotContextMenu({ preventDefault() {}, stopPropagation() {}, clientX: 0, clientY: 0 }, snapshotFixture.snapshotId);
assert.strictEqual(menu[0].label, snapshotFixture.name);
assert.ok(!menu.some(item => item.label === "Copy Magic Code"));
const recoveryItem = menu.find(item => item.label === "Copy Recovery Prompt");
recoveryItem.onClick();
assert.strictEqual(clipboardMessages[0].command, "copyText");
assert.strictEqual(clipboardMessages[0].text, `Call the PKM MCP function agent_session_snapshot_recover with {"magic_code":"${snapshotFixture.magicCode}"}.`);
menu.find(item => item.label === "Rename…").onClick();
assert.strictEqual(modal.defaultValue, snapshotFixture.name);
assert.strictEqual(modal.validate("Tiny"), "");
assert.ok(modal.validate("  "));
assert.ok(modal.validate("x".repeat(201)));
assert.ok(modal.validate("first\nsecond"));
modal.onOk("  Tiny  ");
assert.deepStrictEqual(JSON.parse(JSON.stringify(requests)), [{ command: "agentSnapshotRename", data: { snapshotId: snapshotFixture.snapshotId, name: "Tiny" } }]);
modal.onOk("   ");
modal.onOk(snapshotFixture.name);
assert.strictEqual(requests.length, 1);
ui.renderAgentSnapshots();
assert.match(detail.innerHTML, /Short &lt;name>/);
assert.match(detail.innerHTML, /class="tree-cat"/);
assert.match(detail.innerHTML, /li cattree-item agent-snapshot-tree-item active/);
assert.match(detail.innerHTML, /class="cattree-item-menu"/);
assert.match(detail.innerHTML, /onkeydown="if\(event.target===this/);
assert.ok(!detail.innerHTML.includes('class="agent-snapshot-row'));
assert.match(detail.innerHTML, /title="Rename Snapshot"/);
assert.ok(!detail.innerHTML.includes("<h3>Original captured task</h3>"));
assert.strictEqual(requests.at(-1).command, "agentSnapshotContents");
assert.strictEqual(requests.at(-1).data.snapshotId, snapshotFixture.snapshotId);
assert.match(detail.innerHTML, /aria-busy="true"/);
const requestsAfterLoad = requests.length;
ui.renderAgentSnapshots();
assert.strictEqual(requests.length, requestsAfterLoad, "rerendering does not duplicate contents requests");
assert.strictEqual(detail.scrollTop, 80, "rerendering the same Snapshot preserves vertical scroll");
assert.strictEqual(detail.scrollLeft, 12, "rerendering the same Snapshot preserves horizontal scroll");
ui.agentSnapshotOnContents({ snapshotId: "agent_snapshot_stale", session: { task: "Wrong capture" }, recipeRuns: [] });
assert.match(detail.innerHTML, /aria-busy="true"/, "stale response cannot replace the selected capture");
ui.agentSnapshotOnContents({ snapshotId: snapshotFixture.snapshotId, session: {
  task: "Captured <task>", status: "running", privateContext: "</pre><script>unsafe</script>",
  todos: [{ title: "First Todo", status: "succeeded" }, { title: "Second Todo", status: "pending" }],
  checkpoints: [{ checkpointId: "checkpoint_view_test", reason: "Captured context", commitments: ["Keep this goal"] }],
}, recipeRuns: [{ runId: "recipe_run_view_test", status: "running", nodes: { work: { state: "running" } } }] });
assert.match(detail.innerHTML, /Captured &lt;task>/);
assert.match(detail.innerHTML, /Todos \(2\)/);
assert.ok(detail.innerHTML.indexOf("First Todo") < detail.innerHTML.indexOf("Second Todo"));
assert.match(detail.innerHTML, /Keep this goal/);
assert.match(detail.innerHTML, /recipe_run_view_test/);
assert.match(detail.innerHTML, /Session Record/);
assert.ok(!detail.innerHTML.includes("<script>unsafe"));
ui.agentSnapshotOnContents({ snapshotId: snapshotFixture.snapshotId, error: "Cannot read <capture>" });
assert.match(detail.innerHTML, /role="alert">Cannot read &lt;capture>/);
assert.match(detail.innerHTML, />Retry<\/button>/);
ui.agentSnapshotLoadContents(snapshotFixture.snapshotId);
ui.agentSnapshotOnContents({ snapshotId: snapshotFixture.snapshotId, session: { task: "Empty capture" }, recipeRuns: [] });
assert.match(detail.innerHTML, /No captured Todos/);
assert.match(detail.innerHTML, /No captured Checkpoints/);
assert.match(detail.innerHTML, /No captured Recipe runs/);
delete snapshotFixture.name;
ui.renderAgentSnapshots();
assert.match(detail.innerHTML, /Original captured task/);
assert.match(extensionSource, /case "agentSnapshotRename": \{\s+renameAgentSnapshot\(getStorePath\(\), String\(msg.snapshotId \|\| ""\), String\(msg.name \|\| ""\)\);\s+respond\(\{ command: "projectState"/);
assert.match(extensionSource, /case "agentSnapshotContents":/);
assert.match(extensionSource, /data: readAgentSnapshotContents\(getStorePath\(\), snapshotId\)/);

console.log("Agent Snapshot storage and UI action tests passed");
