import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, writeFileSync, lstatSync, readdirSync, rmSync, mkdirSync, chmodSync, renameSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { createRequire } from "node:module";
import vm from "node:vm";
import ts from "typescript";
import {
  inspectLegacyUiBootstrapCompatibility, recordLegacyUiBootstrapCompatibility, verifyLegacyUiBootstrapCompatibility,
} from "../dist/legacy-ui-bootstrap-compatibility.js";
import { planLegacyImport } from "../dist/legacy-import.js";
import { planLegacyProjectEnvelope } from "../dist/legacy-project-envelope.js";
import { assertLegacyUiDeletionWriteTarget } from "../dist/legacy-ui-deletion-journal.js";
import { assertNativeBoardWriteTarget } from "../dist/native-board-lifecycle-state.js";
import { legacyImportPlanSchema } from "../dist/domain/legacy-import.js";
import { adoptLegacyRootInPlaceExperimental } from "../dist/legacy-root-adoption.js";
import { Storage } from "../dist/storage.js";

const project = resolve(new URL("../legacy", import.meta.url).pathname);
const require = createRequire(import.meta.url), modules = new Map();
const hash = value => createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
function original(file) {
  if (modules.has(file)) return modules.get(file).exports;
  const module = { exports: {} };
  modules.set(file, module);
  const code = ts.transpileModule(readFileSync(file, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInThisContext(`(function(require,module,exports){${code}\n})`, { filename: file })
    (name => name.startsWith(".") ? original(`${resolve(dirname(file), name)}.ts`) : require(name), module, module.exports);
  return module.exports;
}
const { ProjectStore } = original(join(project, "src/workflows/project-store.ts"));
function fixture(t) {
  const directory = join(project, ".migration-test-work", `bootstrap-compat-${randomUUID()}`);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const root = join(directory, "knowledge");
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const mask = process.umask(0o077), state = join(root, ".pkm/state");
  try {
    mkdirSync(state, { recursive: true, mode: 0o700 });
    new ProjectStore(state).list();
    const write = (relative, value) => writeFileSync(join(root, relative), typeof value === "string" ? value : JSON.stringify(value), { mode: 0o600 });
    for (const name of ["actions/preparations", "diagnostics/mcp", "mcp-usage/events"]) mkdirSync(join(state, name), { recursive: true, mode: 0o700 });
    mkdirSync(join(root, "notes"), { mode: 0o700 });
    write("notes/synthetic.md", "# Synthetic bootstrap fixture\n");
    write(".pkm/content-privacy.json", { schema: 1, private: {} });
    write(".pkm/state/actions/mutation-lease", "");
    write(".pkm/state/actions/settings.json", { toolchains: {}, workspace_roots: {} });
    write(".pkm/state/actions/validation-queue.json", { schema: "pkm.action.validation-queue/v1", jobs: {}, worker_pid: null });
    write(".pkm/state/actions/preparations/core.delay.json", { content_hash: hash("blocked synthetic action"), state: "blocked",
      reason: "needs_workspace: configure personalKnowledge.actions.workspaceRoots for this OS." });
    const writerId = `42-${randomUUID().replaceAll("-", "")}`, callId = randomUUID().replaceAll("-", ""), at = new Date().toISOString();
    const common = { schema: "pkm.diagnostic/v1", at, pid: 42, writerId, dropped: 0 };
    const call = { ...common, callId, tool: "mcp_lifecycle_quiesce", transportId: "a".repeat(24), requestId: "b".repeat(24) };
    write(`.pkm/state/diagnostics/mcp/${writerId}.0000000000.jsonl`, [
      { ...common, event: "runtime.started", component: "unified-mcp", parentPid: 41 },
      { ...call, event: "mcp.call.started" }, { ...call, event: "mcp.call.returned", durationMs: 1 },
    ].map(row => JSON.stringify(row)).join("\n") + "\n");
    const eventId = randomUUID();
    write(`.pkm/state/mcp-usage/events/${eventId}.json`, { domain: "knowledge", durationMs: 1, estimatedTokenEquivalent: 1, eventId,
      inputBytes: 2, occurredAt: at, outputBytes: 1, reportedTokens: { input: 0, output: 0 }, resultCount: 0, schema: 1,
      sessionId: "synthetic-42", success: true, toolName: "mcp_lifecycle_quiesce" });
  } finally { process.umask(mask); }
  return root;
}
function snapshot(root) {
  const entries = [];
  function visit(directory) {
    for (const name of readdirSync(directory).sort()) {
      const file = join(directory, name), stat = lstatSync(file, { bigint: true });
      entries.push([file, String(stat.ino), String(stat.mode), String(stat.mtimeNs), String(stat.ctimeNs),
        stat.isFile() ? createHash("sha256").update(readFileSync(file)).digest("hex") : "directory"]);
      if (stat.isDirectory()) visit(file);
    }
  }
  visit(root); return entries;
}
function change(root, relative, mutate) {
  const file = join(root, relative);
  const value = JSON.parse(readFileSync(file, "utf8"));
  writeFileSync(file, JSON.stringify(mutate(value)));
}

test("original ProjectStore bootstrap is reconciled against actual canonical tree and pinned in the in-place plan", async t => {
  const root = fixture(t), before = snapshot(root);
  const receipt = inspectLegacyUiBootstrapCompatibility(root);
  assert.equal(receipt.project.counts.recipes, JSON.parse(readFileSync(join(root, ".pkm/state/projects.json"))).payload.state.recipes.length);
  assert.equal(receipt.components.project, "verified-cutover");
  const plan = await planLegacyImport(root, {}, { inPlaceAdoption: true });
  assert.equal(plan.ready, true, JSON.stringify(plan.blockers));
  assert.deepEqual(plan.inPlaceUiBootstrap, receipt);
  assert(plan.entries.some(entry => entry.source === ".pkm/state/projects.json" && entry.sha256));
  assert.equal((await planLegacyProjectEnvelope(root)).uiBootstrap.sourceFingerprint, receipt.sourceFingerprint);
  assert.deepEqual(snapshot(root), before);
});

test("private-root guard binds legacy shared modes in the compatibility plan and receipt", async t => {
  const root = fixture(t), state = join(root, ".pkm/state");
  chmodSync(root, 0o775);
  for (const relative of [".pkm", ".pkm/state", ".pkm/state/project-store-migration",
    ".pkm/state/project-store-migration/backups", ".pkm/state/actions", ".pkm/state/actions/preparations",
    ".pkm/state/mcp-usage", ".pkm/state/mcp-usage/events"]) chmodSync(join(root, relative), 0o775);
  const chmodProjectDirectories = directory => {
    chmodSync(directory, 0o775);
    for (const name of readdirSync(directory)) {
      const path = join(directory, name);
      if (lstatSync(path).isDirectory()) chmodProjectDirectories(path);
    }
  };
  chmodProjectDirectories(join(root, "project"));
  const events = join(state, "mcp-usage/events");
  chmodSync(join(events, readdirSync(events)[0]), 0o664);
  const before = snapshot(root), receipt = inspectLegacyUiBootstrapCompatibility(root);
  assert.equal(receipt.privateRootGuard.mode, 0o775);
  assert.equal(receipt.privateRootGuard.ancestors[0].mode, 0o700);
  assert.deepEqual(receipt.privateRootGuard.containers.map(item => item.path), [".pkm", ".pkm/state"]);
  const plan = await planLegacyImport(root, {}, { inPlaceAdoption: true });
  assert.equal(plan.ready, true, JSON.stringify(plan.blockers));
  assert.deepEqual(plan.inPlaceUiBootstrap, receipt);
  legacyImportPlanSchema.parse(plan);
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  db.exec("BEGIN"); recordLegacyUiBootstrapCompatibility(db, randomUUID(), receipt); db.exec("ROLLBACK");
  assert.deepEqual(snapshot(root), before);
  const adopted = await adoptLegacyRootInPlaceExperimental(root, {
    snapshotAdmission: { authorityId: "isolated-bootstrap-test", allowedTools: ["knowledge_snapshot_status"], authorize: () => true },
  });
  assert.equal(adopted.qualification, "experimental-unqualified");
  await adopted.storage.close();
  const reopened = await Storage.open(root);
  await reopened.close();
  assert.deepEqual(inspectLegacyUiBootstrapCompatibility(root), receipt);
  chmodSync(root, 0o777);
  assert.throws(() => inspectLegacyUiBootstrapCompatibility(root));
  await assert.rejects(() => Storage.open(root));
});

test("mismatched tree, control, backup and unknown pending state cannot be admitted or rewritten", async t => {
  const cases = [
    ["canonical tree", root => {
      const directory = readdirSync(join(root, "project"))[0];
      change(root, `project/${directory}/project.json`, value => ({ ...value, name: "Undigested change" }));
    }],
    ["control digest", root => change(root, ".pkm/state/project-store.json", value => ({ ...value, canonicalDigest: "a".repeat(64) }))],
    ["pending Project intent", root => writeFileSync(join(root, ".pkm/state/project-store-intent.json"), "{}")],
    ["unknown pending marker", root => change(root, ".pkm/state/project-store-migration/migration.json", value => ({ ...value, phase: "unknown-pending" }))],
    ["unfinished staging", root => writeFileSync(join(root, ".pkm/state/project-store-migration/stage/unowned.json"), "{}")],
    ["backup mismatch", root => {
      const directory = join(root, ".pkm/state/project-store-migration/backups");
      const file = join(directory, readdirSync(directory)[0]);
      chmodSync(file, 0o600);
      writeFileSync(file, "{}");
    }],
    ["ready Action", root => change(root, ".pkm/state/actions/preparations/core.delay.json", value => ({ ...value, state: "ready" }))],
  ];
  for (const [name, mutate] of cases) await t.test(name, async t => {
    const root = fixture(t);
    mutate(root);
    const before = snapshot(root);
    assert.throws(() => inspectLegacyUiBootstrapCompatibility(root));
    await assert.rejects(() => planLegacyImport(root, {}, { inPlaceAdoption: true }));
    await assert.rejects(() => planLegacyProjectEnvelope(root));
    assert.deepEqual(snapshot(root), before);
  });
});

test("compatibility receipt transaction survives retry and refuses tampering without altering old state", t => {
  const root = fixture(t), before = snapshot(root), receipt = inspectLegacyUiBootstrapCompatibility(root);
  const db = new DatabaseSync(":memory:"), workspaceId = randomUUID();
  t.after(() => db.close());
  assert.throws(() => recordLegacyUiBootstrapCompatibility(db, workspaceId, receipt));
  db.exec("BEGIN");
  recordLegacyUiBootstrapCompatibility(db, workspaceId, receipt);
  db.exec("ROLLBACK");
  verifyLegacyUiBootstrapCompatibility(db, workspaceId, receipt, true);
  db.exec("BEGIN");
  recordLegacyUiBootstrapCompatibility(db, workspaceId, receipt);
  db.exec("COMMIT");
  db.exec("BEGIN");
  recordLegacyUiBootstrapCompatibility(db, workspaceId, receipt);
  db.exec("COMMIT");
  verifyLegacyUiBootstrapCompatibility(db, workspaceId, receipt);
  db.prepare("UPDATE legacy_ui_bootstrap_compatibility SET original_projects=?").run(Buffer.from("{}"));
  assert.throws(() => verifyLegacyUiBootstrapCompatibility(db, workspaceId, receipt));
  assert.deepEqual(snapshot(root), before);
});

test("real original deletion writer metadata remains exact inert provenance, not native Sync authority", async t => {
  const root = fixture(t);
  const codec = process.env.PKM_TODO_LEGACY_EXTENSION
    ? require(join(process.env.PKM_TODO_LEGACY_EXTENSION, "dist/knowledge/knowledge-deletion-journal.js"))
    : original(join(project, "src/knowledge/knowledge-deletion-journal.ts"));
  const mask = process.umask(0o077);
  try {
    mkdirSync(join(root, "notes/AssetsOnly.assets"), { mode: 0o700 });
    writeFileSync(join(root, "notes/AssetsOnly.assets/pkm-todo-board.json"), '{"original":true}', { mode: 0o600 });
    codec.recordKnowledgeResourceMutation(root, ["notes/synthetic.md", "notes/AssetsOnly.assets/pkm-todo-board.json",
      "notes/Retained.assets", "notes/Retained category"], [], () => {
      renameSync(join(root, "notes/synthetic.md"), join(root, "notes/after.md"));
      rmSync(join(root, "notes/AssetsOnly.assets"), { recursive: true });
    });
  } finally { process.umask(mask); }
  const before = snapshot(root), file = join(root, ".pkm/state/knowledge-deletions.json"), raw = readFileSync(file);
  const proof = inspectLegacyUiBootstrapCompatibility(root);
  assert.equal(proof.knowledgeDeletions.sha256, createHash("sha256").update(raw).digest("hex"));
  assert.equal(proof.knowledgeDeletions.records, 4);
  assert.equal(proof.knowledgeDeletions.authority, "preserved-original-sync-only");
  const plan = await planLegacyImport(root, {}, { inPlaceAdoption: true });
  assert.equal(plan.ready, true, JSON.stringify(plan.blockers));
  assert.equal(plan.entries.find(entry => entry.source === ".pkm/state/knowledge-deletions.json").sha256, proof.knowledgeDeletions.sha256);
  for (const summary of [undefined, { ...proof.knowledgeDeletions, sha256: "0".repeat(64) },
    { ...proof.knowledgeDeletions, authority: "native-sync" }, { ...proof.knowledgeDeletions, records: -1 }]) {
    assert.equal(legacyImportPlanSchema.safeParse({ ...plan,
      inPlaceUiBootstrap: { ...proof, knowledgeDeletions: summary } }).success, false);
  }
  const db = new DatabaseSync(":memory:"); t.after(() => db.close());
  db.exec("BEGIN"); recordLegacyUiBootstrapCompatibility(db, randomUUID(), proof); db.exec("COMMIT");
  db.exec("BEGIN");
  assert.throws(() => recordLegacyUiBootstrapCompatibility(db, randomUUID(), {
    ...proof, knowledgeDeletions: { ...proof.knowledgeDeletions, records: proof.knowledgeDeletions.records + 1 },
  }), /prepared journal/);
  db.exec("ROLLBACK");
  assert.throws(() => assertLegacyUiDeletionWriteTarget(db, root, "notes/synthetic.md"), /original Sync deletion/);
  assert.throws(() => assertNativeBoardWriteTarget(root, "synthetic.md", db), /original Sync deletion/);
  for (const destination of ["AssetsOnly.md", "assetsonly.md", "Retained.md", "Retained category/Child.md"])
    assert.throws(() => assertNativeBoardWriteTarget(root, destination, db), /original Sync deletion/);
  assert.doesNotThrow(() => assertNativeBoardWriteTarget(root, "AssetsOnly.md", db, undefined, false));
  assert.throws(() => assertNativeBoardWriteTarget(root, "synthetic.md", db, undefined, false), /original Sync deletion/);
  assert.doesNotThrow(() => assertLegacyUiDeletionWriteTarget(db, root, "notes/new.md"));
  assert.deepEqual(snapshot(root), before);
  writeFileSync(file, JSON.stringify({ schema: 1, records: [] }), { mode: 0o600 });
  assert.throws(() => assertLegacyUiDeletionWriteTarget(db, root, "notes/new.md"), /immutable source/);
});

test("pending/live, malformed, duplicate and traversal deletion state stays blocked without reconciliation writes", async t => {
  const at = new Date().toISOString();
  for (const value of [
    { schema: 1, records: [{ path: "notes/synthetic.md", deletedAt: at }] },
    { schema: 1, records: [{ path: "notes/../outside.md", deletedAt: at }] },
    { schema: 1, records: [{ path: "notes/absent.md", deletedAt: "invalid" }] },
    { schema: 1, records: [{ path: "notes/absent.md", deletedAt: at, pending: true }] },
    { schema: 1, records: [{ path: "notes/absent.md", deletedAt: at }, { path: "notes/ABSENT.md", deletedAt: at }] },
    { schema: 2, records: [] },
  ]) await t.test(JSON.stringify(value), async t => {
    const root = fixture(t);
    writeFileSync(join(root, ".pkm/state/knowledge-deletions.json"), JSON.stringify(value), { mode: 0o600 });
    const before = snapshot(root);
    assert.throws(() => inspectLegacyUiBootstrapCompatibility(root), /deletion journal/);
    await assert.rejects(() => planLegacyImport(root, {}, { inPlaceAdoption: true }));
    assert.deepEqual(snapshot(root), before);
  });
  const root = fixture(t);
  writeFileSync(join(root, ".pkm/state/knowledge-deletions.json.pending"), "{}", { mode: 0o600 });
  const before = snapshot(root);
  assert.throws(() => inspectLegacyUiBootstrapCompatibility(root), /Unknown or pending/);
  assert.deepEqual(snapshot(root), before);
});
