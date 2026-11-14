import assert from "node:assert/strict";
import { test } from "node:test";
import { chmodSync, mkdirSync, writeFileSync, readFileSync, readdirSync, lstatSync, renameSync, rmSync, symlinkSync, linkSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { inspectLegacyUiRetiredState } from "../dist/legacy-ui-retired-state.js";

const project = resolve(new URL("../legacy", import.meta.url).pathname);
const hash = value => createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
function create(directory) {
  const root = join(directory, "knowledge"), state = join(root, ".pkm/state");
  const write = (name, value) => writeFileSync(join(state, name), typeof value === "string" ? value : JSON.stringify(value), { mode: 0o600 });
  const mask = process.umask(0o077);
  try {
    for (const name of ["project-store-migration/backup", "project-store-migration/backups", "project-store-migration/stage",
      "actions/preparations", "mcp-usage/events", "diagnostics/mcp"])
      mkdirSync(join(state, name), { recursive: true, mode: 0o700 });
    const rootId = `root_${randomUUID()}`, projectId = `project_${randomUUID().replaceAll("-", "")}`, threadId = `thread_${randomUUID().replaceAll("-", "")}`;
    const definition = { schema: "pkm.workflow.definition/v1", spec: { completion: { requiredNodes: [] }, inputs: {}, nodes: [], outputs: {} } };
    const payload = { receipts: [], state: { schema: 1, rootId,
      audit: [{ entityId: projectId, event: "system-project-repaired" }, { entityId: threadId, event: "system-thread-repaired" }],
      collaborationTasks: [], ganttTasks: [], migrations: [], recipeFolders: [], recipeTrash: [],
      projects: [{ name: "Default Project", projectId, systemKind: "default-project", version: 1 }],
      threads: [{ archived: false, description: "", legacyAliases: [], name: "General", projectId, systemKind: "general-thread", threadId, version: 1 }],
      recipes: [{ category: "System/PKM/Fundamental", definition, description: "Synthetic static archived definition",
        executableDigest: hash(definition), metadata: {}, name: "Synthetic builtin", recipeId: `recipe_${randomUUID().replaceAll("-", "")}`,
        revision: 1, scope: "global", systemKind: "built-in" }] } };
    const source = { schema: 1, storeVersion: 1, digest: hash(payload), payload };
    write("projects.json", source);
    write(`project-store-migration/backups/${source.digest}.projects.json`, source);
    const migration = { canonicalDigest: hash("canonical bootstrap fixture"), collaborationTasks: 0, ganttTasks: 0,
      phase: "cutover", projects: 1, sourceDigest: source.digest, threads: 1 };
    write("project-store.json", { canonicalDigest: migration.canonicalDigest, migration, receipts: [], rootId, schema: 1, storeVersion: 1 });
    write("project-store-migration/migration.json", { ...migration, hadTarget: false });
    write("actions/mutation-lease", "");
    write("actions/settings.json", { toolchains: {}, workspace_roots: {} });
    write("actions/validation-queue.json", { schema: "pkm.action.validation-queue/v1", jobs: {}, worker_pid: null });
    write("actions/preparations/core.delay.json", { content_hash: hash("blocked synthetic preparation"),
      reason: "needs_workspace: configure personalKnowledge.actions.workspaceRoots for this OS.", state: "blocked" });
    const writerId = `42-${randomUUID().replaceAll("-", "")}`, callId = randomUUID().replaceAll("-", "");
    const common = { schema: "pkm.diagnostic/v1", at: new Date().toISOString(), pid: 42, writerId, dropped: 0 };
    const call = { ...common, callId, tool: "mcp_lifecycle_quiesce", transportId: "a".repeat(24), requestId: "b".repeat(24) };
    write(`diagnostics/mcp/${writerId}.0000000000.jsonl`, [
      { ...common, event: "runtime.started", component: "unified-mcp", parentPid: 41 },
      { ...call, event: "mcp.call.started" }, { ...call, event: "mcp.call.returned", durationMs: 1 },
    ].map(row => JSON.stringify(row)).join("\n") + "\n");
    const eventId = randomUUID();
    write(`mcp-usage/events/${eventId}.json`, { domain: "knowledge", durationMs: 1, estimatedTokenEquivalent: 1, eventId,
      inputBytes: 2, occurredAt: common.at, outputBytes: 1, reportedTokens: { input: 0, output: 0 }, resultCount: 0,
      schema: 1, sessionId: "synthetic-42", success: true, toolName: "mcp_lifecycle_quiesce" });
    return { root, state, write, source, migration, writerId };
  } finally { process.umask(mask); }
}
function snapshot(root) {
  const entries = [];
  function visit(directory) {
    for (const name of readdirSync(directory).sort()) {
      const file = join(directory, name), stat = lstatSync(file, { bigint: true });
      entries.push([file, String(stat.ino), String(stat.mode), String(stat.mtimeNs), String(stat.ctimeNs),
        stat.isFile() ? hash(readFileSync(file).toString("base64")) : "directory"]);
      if (stat.isDirectory()) visit(file);
    }
  }
  visit(root); return entries;
}

test("retired UI receipt is read-only and binds all ProjectStore, blocked Action and paired lifecycle artifacts", t => {
  const directory = join(project, ".migration-test-work", `retired-ui-${randomUUID()}`);
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const fixture = create(directory), before = snapshot(fixture.root), receipt = inspectLegacyUiRetiredState(fixture.root);
  assert.equal(receipt.metadataAuthority, "archive_only");
  assert(receipt.paths.includes(".pkm/state/project-store.json"));
  assert(receipt.paths.includes(".pkm/state/actions/validation-queue.json"));
  assert(receipt.paths.some(path => path.startsWith(".pkm/state/diagnostics/mcp/")));
  assert.deepEqual(snapshot(fixture.root), before);
  fixture.write("actions/preparations/core.delay.json", { content_hash: hash("different blocked input"),
    reason: "needs_workspace: configure personalKnowledge.actions.workspaceRoots for this OS.", state: "blocked" });
  assert.notEqual(inspectLegacyUiRetiredState(fixture.root).sourceFingerprint, receipt.sourceFingerprint);
});

test("installed 4.0.22 default-umask state passes private-root permission checks without changing it", {
  skip: !process.env.PKM_INSTALLED_LEGACY_FIXTURE,
}, () => {
  const fixture = resolve(process.env.PKM_INSTALLED_LEGACY_FIXTURE);
  const result = JSON.parse(readFileSync(join(fixture, "control/original-lifecycle-result.json"), "utf8"));
  assert.equal(result.version, "4.0.22");
  assert.equal(result.state, "pass");
  const root = join(fixture, "root"), state = join(root, ".pkm/state");
  const paths = [join(root, ".pkm"), state, join(state, "project-store-migration"),
    join(state, "project-store-migration/backups"), join(state, "project-store-migration/migration.json")];
  const before = paths.map(path => {
    const stat = lstatSync(path, { bigint: true });
    return [stat.dev, stat.ino, stat.mode, stat.mtimeNs, stat.ctimeNs];
  });
  assert.equal(Number(before[0][2] & 0o777n), 0o775);
  assert.equal(Number(before[2][2] & 0o777n), 0o775);
  try {
    assert.equal(inspectLegacyUiRetiredState(root).metadataAuthority, "archive_only");
  } catch (error) {
    assert.equal(error.code, "LEGACY_UI_RETIRED_STATE_BLOCKED");
    assert.match(error.message, /MCP calls or lifecycle handoff are incomplete/);
  }
  assert.deepEqual(paths.map(path => {
    const stat = lstatSync(path, { bigint: true });
    return [stat.dev, stat.ino, stat.mode, stat.mtimeNs, stat.ctimeNs];
  }), before);
});

test("original 4.0.22 ProjectStore creates group-writable migration directories under ordinary umask", {
  skip: !process.env.PKM_INSTALLED_LEGACY_FIXTURE,
}, () => {
  const installed = resolve(process.env.PKM_INSTALLED_LEGACY_FIXTURE);
  const oldStore = join(installed, "extensions/uone.personal-knowledge-4.0.22/dist/workflows/project-store.js");
  const root = join(project, ".migration-test-work/root-upgrade-validation", `default-umask-project-${randomUUID()}`, "root");
  const script = `
    const fs = require("node:fs"), path = require("node:path");
    process.umask(0o002);
    fs.mkdirSync(process.argv[2], { recursive: true, mode: 0o700 });
    const state = path.join(process.argv[2], ".pkm/state");
    fs.mkdirSync(state, { recursive: true });
    new (require(process.argv[1]).ProjectStore)(state).list();
  `;
  const child = spawnSync(process.execPath, ["-e", script, oldStore, root], { encoding: "utf8", timeout: 30_000 });
  assert.equal(child.status, 0, child.stderr || String(child.error));
  const migration = join(root, ".pkm/state/project-store-migration");
  assert.equal(lstatSync(migration).mode & 0o777, 0o775);
  assert.equal(lstatSync(join(migration, "backups")).mode & 0o777, 0o775);
  assert.equal(lstatSync(join(migration, "migration.json")).mode & 0o777, 0o600);
});

test("legacy shared state is archive-only beneath a verified private root", t => {
  const directory = join(project, ".migration-test-work", `retired-ui-shared-${randomUUID()}`);
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const fixture = create(directory);
  chmodSync(fixture.root, 0o775);
  for (const relative of [".pkm", ".pkm/state", ".pkm/state/project-store-migration",
    ".pkm/state/project-store-migration/backups", ".pkm/state/actions", ".pkm/state/actions/preparations",
    ".pkm/state/mcp-usage", ".pkm/state/mcp-usage/events"]) chmodSync(join(fixture.root, relative), 0o775);
  const events = join(fixture.state, "mcp-usage/events");
  chmodSync(join(events, readdirSync(events)[0]), 0o664);
  const before = snapshot(fixture.root), receipt = inspectLegacyUiRetiredState(fixture.root);
  assert.equal(receipt.metadataAuthority, "archive_only");
  assert.equal(receipt.privateRootGuard.mode, 0o775);
  assert.equal(receipt.privateRootGuard.ancestors[0].mode, 0o700);
  assert.deepEqual(snapshot(fixture.root), before);
  chmodSync(join(fixture.state, "actions/settings.json"), 0o664);
  assert.throws(() => inspectLegacyUiRetiredState(fixture.root), { code: "LEGACY_UI_RETIRED_STATE_BLOCKED" });
  chmodSync(join(fixture.state, "actions/settings.json"), 0o600);
  chmodSync(fixture.root, 0o777);
  assert.throws(() => inspectLegacyUiRetiredState(fixture.root), { code: "LEGACY_UI_RETIRED_STATE_BLOCKED" });
});

test("completed original Note read is byte-bound only when facade and leaf diagnostics match", t => {
  const directory = join(project, ".migration-test-work", `retired-ui-note-read-${randomUUID()}`);
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const fixture = create(directory), diagnostic = `diagnostics/mcp/${fixture.writerId}.0000000000.jsonl`;
  const rows = readFileSync(join(fixture.state, diagnostic), "utf8").trim().split("\n").map(JSON.parse);
  const common = { schema: "pkm.diagnostic/v1", at: new Date().toISOString(), pid: 42, writerId: fixture.writerId,
    dropped: 0, transportId: "c".repeat(24), requestId: "d".repeat(24) };
  const wrapper = { ...common, callId: randomUUID().replaceAll("-", ""), tool: "capability_read" };
  const leaf = { ...common, callId: randomUUID().replaceAll("-", ""), tool: "get_note" };
  const start = value => ({ ...value, event: "mcp.call.started" });
  const end = value => ({ ...value, event: "mcp.call.returned", durationMs: 1 });
  const complete = [rows[0], start(wrapper), start(leaf), end(leaf), end(wrapper), ...rows.slice(1)];
  const stream = list => list.map(row => JSON.stringify(row)).join("\n") + "\n";
  fixture.write(diagnostic, stream(complete));
  for (const toolName of ["capability_read", "get_note"]) {
    const eventId = randomUUID();
    fixture.write(`mcp-usage/events/${eventId}.json`, { domain: "knowledge", durationMs: 1,
      estimatedTokenEquivalent: 1, eventId, inputBytes: 2, occurredAt: common.at, outputBytes: 1,
      reportedTokens: { input: 0, output: 0 }, resultCount: 0, schema: 1, sessionId: "synthetic-42",
      success: true, toolName, ...(toolName === "capability_read" ? { capabilityVersion: 1 } : {}) });
  }
  const before = snapshot(fixture.root), receipt = inspectLegacyUiRetiredState(fixture.root);
  assert.equal(receipt.metadataAuthority, "archive_only");
  assert.equal(receipt.components.telemetry, "completed-lifecycle-and-note-read-only");
  assert.deepEqual(snapshot(fixture.root), before);
  for (const change of [
    list => { list[2].requestId = "e".repeat(24); },
    list => { list[2].tool = "update_note"; list[3].tool = "update_note"; },
    list => { list.splice(3, 1); },
    list => { list.push(...list.splice(1, 4)); },
  ]) {
    const changed = structuredClone(complete);
    change(changed);
    fixture.write(diagnostic, stream(changed));
    assert.throws(() => inspectLegacyUiRetiredState(fixture.root), { code: "LEGACY_UI_RETIRED_STATE_BLOCKED" });
  }
});

test("in-flight Note creation is archived only with an exact completed facade and leaf", t => {
  const directory = join(project, ".migration-test-work", `retired-ui-note-create-${randomUUID()}`);
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const fixture = create(directory), diagnostic = `diagnostics/mcp/${fixture.writerId}.0000000000.jsonl`;
  const rows = readFileSync(join(fixture.state, diagnostic), "utf8").trim().split("\n").map(JSON.parse);
  const common = { schema: "pkm.diagnostic/v1", at: new Date().toISOString(), pid: 42, writerId: fixture.writerId,
    dropped: 0, transportId: "c".repeat(24), requestId: "d".repeat(24) };
  const wrapper = { ...common, callId: randomUUID().replaceAll("-", ""), tool: "capability_call" };
  const leaf = { ...common, callId: randomUUID().replaceAll("-", ""), tool: "add_note" };
  const start = value => ({ ...value, event: "mcp.call.started" });
  const end = value => ({ ...value, event: "mcp.call.returned", durationMs: 1 });
  const complete = [rows[0], start(wrapper), start(leaf), ...rows.slice(1), end(leaf), end(wrapper)];
  const stream = list => list.map(row => JSON.stringify(row)).join("\n") + "\n";
  fixture.write(diagnostic, stream(complete));
  for (const toolName of ["capability_call", "add_note"]) {
    const eventId = randomUUID();
    fixture.write(`mcp-usage/events/${eventId}.json`, { domain: "knowledge", durationMs: 1,
      estimatedTokenEquivalent: 1, eventId, inputBytes: 2, occurredAt: common.at, outputBytes: 1,
      reportedTokens: { input: 0, output: 0 }, resultCount: 0, schema: 1, sessionId: "synthetic-42-01234567",
      success: true, toolName, ...(toolName === "capability_call" ? { capabilityVersion: 1 } : {}) });
  }
  const before = snapshot(fixture.root), receipt = inspectLegacyUiRetiredState(fixture.root);
  assert.equal(receipt.components.telemetry, "completed-lifecycle-and-note-create");
  assert.deepEqual(snapshot(fixture.root), before);
  for (const change of [
    list => { list[2].requestId = "e".repeat(24); },
    list => { list[2].tool = "update_note"; list[5].tool = "update_note"; },
    list => { list.splice(5, 1); },
    list => { list.splice(1, 2); },
    list => { list.splice(1, 2); list.splice(3, 0, start(wrapper), start(leaf)); },
  ]) {
    const changed = structuredClone(complete);
    change(changed);
    fixture.write(diagnostic, stream(changed));
    assert.throws(() => inspectLegacyUiRetiredState(fixture.root), { code: "LEGACY_UI_RETIRED_STATE_BLOCKED" });
  }
  fixture.write(diagnostic, stream(complete));
  const secondWriter = `42-${randomUUID().replaceAll("-", "")}`;
  const secondRows = rows.map(row => ({ ...row, writerId: secondWriter }));
  fixture.write(`diagnostics/mcp/${secondWriter}.0000000000.jsonl`, stream(secondRows));
  const lifecycleId = randomUUID();
  fixture.write(`mcp-usage/events/${lifecycleId}.json`, { domain: "knowledge", durationMs: 1, estimatedTokenEquivalent: 1,
    eventId: lifecycleId, inputBytes: 2, occurredAt: common.at, outputBytes: 1, reportedTokens: { input: 0, output: 0 },
    resultCount: 0, schema: 1, sessionId: "synthetic-42", success: true, toolName: "mcp_lifecycle_quiesce" });
  assert.throws(() => inspectLegacyUiRetiredState(fixture.root), { code: "LEGACY_UI_RETIRED_STATE_BLOCKED" });
  unlinkSync(join(fixture.state, `diagnostics/mcp/${secondWriter}.0000000000.jsonl`));
  unlinkSync(join(fixture.state, `mcp-usage/events/${lifecycleId}.json`));
  const usage = readdirSync(join(fixture.state, "mcp-usage/events")).map(name => ({
    name, value: JSON.parse(readFileSync(join(fixture.state, "mcp-usage/events", name), "utf8")),
  })).find(entry => entry.value.toolName === "add_note");
  usage.value.sessionId = "synthetic-43-01234567";
  fixture.write(`mcp-usage/events/${usage.name}`, usage.value);
  assert.throws(() => inspectLegacyUiRetiredState(fixture.root), { code: "LEGACY_UI_RETIRED_STATE_BLOCKED" });
});

test("closed real 4.0.22 in-flight Note creation retains the original log and Note", {
  skip: !process.env.PKM_INSTALLED_LEGACY_WRITE_FIXTURE,
}, () => {
  const root = join(resolve(process.env.PKM_INSTALLED_LEGACY_WRITE_FIXTURE), "root");
  const note = join(root, "notes/Reload in flight.md");
  const diagnostics = join(root, ".pkm/state/diagnostics/mcp");
  const names = readdirSync(diagnostics);
  const before = [readFileSync(note), ...names.map(name => readFileSync(join(diagnostics, name)))];
  const receipt = inspectLegacyUiRetiredState(root);
  assert.equal(receipt.components.telemetry, "completed-lifecycle-and-note-create");
  assert.deepEqual([readFileSync(note), ...names.map(name => readFileSync(join(diagnostics, name)))], before);
});

test("retired UI archive rejects unfinished/unknown authority and unsafe files without mutation", async t => {
  const cases = [
    ["pending validation", fixture => fixture.write("actions/validation-queue.json", { schema: "pkm.action.validation-queue/v1", jobs: { pending: {} }, worker_pid: null })],
    ["worker lease", fixture => fixture.write("actions/mutation-lease", "42")],
    ["configured workspace", fixture => fixture.write("actions/settings.json", { toolchains: {}, workspace_roots: { linux: "/synthetic/workspace" } })],
    ["ready preparation", fixture => fixture.write("actions/preparations/core.delay.json", { content_hash: hash("ready"), reason: "", state: "ready" })],
    ["pending migration", fixture => fixture.write("project-store-migration/migration.json", { ...fixture.migration, hadTarget: false, phase: "prepared" })],
    ["pending diagnostic call", fixture => {
      const name = `diagnostics/mcp/${fixture.writerId}.0000000000.jsonl`;
      fixture.write(name, readFileSync(join(fixture.state, name), "utf8").split("\n").slice(0, 2).join("\n") + "\n");
    }],
    ["unknown state", fixture => fixture.write("actions/unknown.json", {})],
    ["tampered source digest", fixture => fixture.write("projects.json", { ...fixture.source, storeVersion: 2 })],
    ["group-writable migration directory without private root", fixture => {
      chmodSync(fixture.root, 0o777);
      chmodSync(join(fixture.state, "project-store-migration"), 0o775);
    }],
    ["group-writable usage event", fixture => {
      chmodSync(fixture.root, 0o777);
      const directory = join(fixture.state, "mcp-usage/events");
      chmodSync(join(directory, readdirSync(directory)[0]), 0o664);
    }],
    ["world-writable migration directory", fixture => chmodSync(join(fixture.state, "project-store-migration"), 0o777)],
    ["world-writable usage event", fixture => {
      const directory = join(fixture.state, "mcp-usage/events");
      chmodSync(join(directory, readdirSync(directory)[0]), 0o666);
    }],
    ["symbolic link in a parent component", fixture => {
      renameSync(join(fixture.state, "actions"), join(fixture.state, "actions-held"));
      symlinkSync("actions-held", join(fixture.state, "actions"));
    }],
    ["symbolic link", fixture => {
      unlinkSync(join(fixture.state, "actions/mutation-lease"));
      symlinkSync(join(fixture.state, "actions/settings.json"), join(fixture.state, "actions/mutation-lease"));
    }],
    ["hard link", fixture => linkSync(join(fixture.state, "actions/settings.json"), join(fixture.state, "actions/preparations/core.artifact.copy.json"))],
  ];
  for (const [name, mutate] of cases) await t.test(name, t => {
    const directory = join(project, ".migration-test-work", `retired-ui-${randomUUID()}`);
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const fixture = create(directory);
    mutate(fixture);
    const before = snapshot(fixture.root);
    assert.throws(() => inspectLegacyUiRetiredState(fixture.root), error => error.code === "LEGACY_UI_RETIRED_STATE_BLOCKED");
    assert.deepEqual(snapshot(fixture.root), before);
  });
});
