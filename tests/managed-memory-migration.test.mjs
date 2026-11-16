import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { chmod, cp, lstat, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { planLegacyImport, importLegacyWorkspace } from "../dist/legacy-import.js";
import { memoryScope } from "../dist/memory.js";
import { Storage } from "../dist/storage.js";
import { legacyIndexedKnowledgeRead } from "../dist/legacy-retrieval-index.js";
import { LegacyMcpPythonWorker } from "../dist/legacy-mcp-python-worker.js";
import { createWorkspaceBackup, restoreWorkspaceBackup } from "../dist/workspace-backup.js";
import { verifyLegacyRetrievalModels } from "../dist/legacy-retrieval-model.js";
import { inspectLegacyRetrievalHistory } from "../dist/legacy-retrieval-history-import.js";
import { readLegacyRetrievalLearning } from "../dist/legacy-retrieval-learning.js";
import { admitLegacyKnowledgeRecovery } from "../dist/legacy-knowledge-recovery.js";
import { admitLegacyActionPackage } from "../dist/legacy-action-catalog.js";
import { admitLegacyKnowledgeSnapshots, verifyLegacyKnowledgeSnapshots } from "../dist/legacy-knowledge-snapshots.js";
import { portableActionArchive, portableActionManifest } from "./legacy-action-catalog-fixture.mjs";
import { originalActionCompilerFixtures as originalAction } from "./action-compiler-original-fixtures.mjs";
import { nativeRestoreAuthority } from "./host-composition-legacy-batch16-restore-fixture.mjs";
import { createAdmittedLegacyKnowledgeSnapshotScheduler } from "../dist/legacy-knowledge-snapshot-scheduler.js";
import { createNativeRuntime } from "../dist/native-runtime.js";
import { verifyLegacyActionArtifacts } from "../dist/legacy-action-artifacts.js";
import { verifySnapshotSchedule } from "../dist/legacy-knowledge-snapshot-scheduler-state.js";
import { enrollManagedSchedulerArtifacts, nextRealSnapshotMinute, waitForRealSnapshot } from "./managed-scheduler-artifact-fixture.mjs";
import { isolatedManagedLaunch, publishIsolatedManagedGeneration, stageIsolatedManagedGeneration,
  verifyIsolatedManagedGeneration } from "../experimental/managed-migration.mjs";

const testsRoot = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(testsRoot, ".."), repositoryRoot = resolve(packageRoot, "legacy");
const require = createRequire(join(repositoryRoot, "package.json"));
const sha = value => createHash("sha256").update(value).digest("hex");
const python = execFileSync("python3", ["-I", "-c", "import sys; print(sys.executable)"], { encoding: "utf8" }).trim();
const references = [{ id: "source-1", chat: "fixture-chat", revision: "turn-1", locator: "message/source-1" }];
const modelEnabled = process.env.PKM_MANAGED_MODEL_ACCEPTANCE === "1";
const boardRecoveryEnabled = process.env.PKM_MANAGED_BOARD_RECOVERY_ACCEPTANCE === "1";
const actionSnapshotsEnabled = process.env.PKM_MANAGED_ACTION_SNAPSHOTS_ACCEPTANCE === "1";
const schedulerArtifactsEnabled = process.env.PKM_MANAGED_SCHEDULER_ARTIFACTS_ACCEPTANCE === "1";

async function treeSnapshot(root, prefix = "") {
  const result = {};
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) Object.assign(result, await treeSnapshot(join(root, entry.name), relative));
    else {
      assert(entry.isFile(), "Original fixture contains only regular source files");
      result[relative] = sha(await readFile(join(root, entry.name)));
    }
  }
  return result;
}

test("original root and closed Engine import survives managed Chat upgrade/restart/restore without inheriting Memory scope admission", { timeout: modelEnabled ? 600_000 : 180_000 }, async t => {
  const parent = join(testsRoot, `.managed-memory-${randomUUID()}`);
  const source = join(parent, "original-legacy-root"), database = join(parent, "closed-original-memory.sqlite3");
  const destination = join(parent, "owned-import"), managedRoot = join(parent, "managed");
  const restored = join(parent, "relocated", "owned-restored"), backup = join(parent, "quiescent-backup");
  const connections = [];
  const recoveryRoot = join(parent, "explicit-host-recovery-evidence");
  const recoveryBytes = Buffer.from("---\r\ntitle: Managed recovery\r\nunknown: keep-exact\r\n---\r\nOriginal raw staged bytes.\r\n");
  let recoveryPlanSha, recoveryReport, boardDigest;
  const actionRoot = join(parent, "explicit-host-action-catalog"), actionArchive = join(actionRoot, "reviewed.zip");
  const snapshotOriginal = Buffer.from("---\r\ntitle: Snapshot original\r\nunknown: keep-exact\r\n---\r\nOriginal private Git bytes.\r\n");
  const snapshotChanged = Buffer.from("---\ntitle: Snapshot original\n---\nChanged before restore.\n");
  let actionCatalogBefore, actionProposalId, snapshotTag;
  let schedulerArtifacts, artifactId, scheduleTime, catchupDue, scheduledTags;
  const snapshotTools = ["knowledge_snapshot_status", "knowledge_snapshot_create",
    "knowledge_snapshot_restore_preview", "knowledge_snapshot_restore_apply",
    ...(schedulerArtifactsEnabled ? ["knowledge_snapshot_configure"] : [])];
  let storage;
  await mkdir(join(source, "notes"), { recursive: true, mode: 0o700 });
  t.after(async () => {
    try {
      for (const connection of connections) await connection.close();
      await storage?.close();
    } finally { await rm(parent, { recursive: true, force: true }); }
  });
  await writeFile(join(source, "notes", "legacy.md"),
    "---\ntitle: Original legacy Note\ndocumentId: original-note\n---\nOriginal source bytes remain untouched.\n");
  await mkdir(join(source, "papers"));
  await writeFile(join(source, "papers", "paper.md"), "---\ntitle: Original Research\n---\nOriginal Research body.\n");
  await mkdir(join(source, "skills"));
  const formalSkill = "---\nschema: pkm.knowledge/v1\nknowledgeId: knowledge_000000000000000000000099\nrevision: 1\nname: Evidence Skill\n---\nFormal immutable evidence.\n";
  await writeFile(join(source, "skills", "Evidence.md"), formalSkill);
  const rootIdentity = sha(source);
  const scope = JSON.stringify({ account: "local-owner", project: rootIdentity, repository: rootIdentity });
  const foreignIdentity = sha("foreign-original-root");
  const foreignScope = JSON.stringify({ account: "local-owner", project: foreignIdentity, repository: foreignIdentity });
  const id = `explicit-${sha(`${scope}\0old-proposal`)}`;
  const foreignId = `explicit-${sha(`${foreignScope}\0foreign-proposal`)}`;
  execFileSync(python, ["-I", "-c", `
import json, sys
sys.path.insert(0, sys.argv[1])
from pkm_memory_engine import Engine
engine = Engine(sys.argv[2], "legacy/account-root")
for scope, memory_id, operation in [(sys.argv[3], sys.argv[4], "old-proposal"),
                                    (sys.argv[5], sys.argv[6], "foreign-proposal")]:
    engine.mutate(operation, "explicit_propose", {
        "id": memory_id, "scope": scope, "content": "Original confirmed fact.",
        "sources": json.loads(sys.argv[7]),
    })
    engine.mutate(operation + "-confirm", "explicit_confirm", {
        "id": memory_id, "scope": scope, "expected_revision": 1,
        "host_authorization": {"decision_id":"original-human", "actor_id":"human:legacy"},
    })
engine.close()
`, join(packageRoot, "compute"), database, scope, id, foreignScope, foreignId, JSON.stringify(references)]);
  await chmod(database, 0o600);
  const sourceBefore = await treeSnapshot(source), databaseBefore = await readFile(database);
  const databaseStat = await lstat(database, { bigint: true });
  for (const suffix of ["-wal", "-shm"]) await assert.rejects(lstat(database + suffix), { code: "ENOENT" });
  let model, modelSourceBefore, firstModelFeedback, originalHistory, historyBefore, inactiveId, frozenRelease;
  let originalsVerifiedBeforeRemoval = false;
  const historyRoot = join(parent, "closed-original-retrieval-state");
  if (modelEnabled) {
    model = JSON.parse(execFileSync(python, ["-I", "-B", join(testsRoot, "legacy-retrieval-tiny-model.py"),
      join(parent, "random-offline-model-source")], {
      encoding: "utf8", env: { ...process.env, TMPDIR: parent, OMP_NUM_THREADS: "1",
        HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1", HF_DATASETS_OFFLINE: "1" },
    }));
    assert.equal(model.qualityEvidence, false);
    modelSourceBefore = await treeSnapshot(model.root);
    await mkdir(join(historyRoot, "solutions"), { recursive: true });
    await cp(model.root, join(historyRoot, "solutions", model.packageId), { recursive: true });
    const inactiveManifest = { ...JSON.parse(await readFile(join(model.root, "manifest.json"), "utf8")),
      name: "Original inactive managed dense-document fixture", architecture: "dense-document" };
    inactiveId = execFileSync(python, ["-I", "-c",
      "import hashlib,json,sys;print(hashlib.sha256(json.dumps(json.load(sys.stdin),sort_keys=True,ensure_ascii=False,allow_nan=False).encode()).hexdigest())"],
    { input: JSON.stringify(inactiveManifest), encoding: "utf8" }).trim();
    await cp(model.root, join(historyRoot, "solutions", inactiveId), { recursive: true });
    await writeFile(join(historyRoot, "solutions", inactiveId, "manifest.json"), JSON.stringify(inactiveManifest));
    await writeFile(join(historyRoot, "solution-selection.json"), JSON.stringify({ schema: 1, package_id: model.packageId }));
    originalHistory = JSON.parse(execFileSync(python, ["-I", "-B", "-c", `
import ast,hashlib,json,math,os,re,secrets,sqlite3,sys,threading
from pathlib import Path
node,=[n for n in ast.parse(Path(sys.argv[1]).read_text()).body if isinstance(n,ast.ClassDef) and n.name=="RetrievalLearning"]
exec(compile(ast.Module(body=[node],type_ignores=[]),"<actual-original-managed-history-fixture>","exec"))
learner=RetrievalLearning(Path(sys.argv[2]));learner.configure(True)
response={"ok":True,"model_invoked":True,"semantic_status":"ready","route":"semantic",
 "model_attempt_package_id":sys.argv[3],"corpus_revision":"original-fixture-corpus",
 "hits":[{"source_id":"pkm://notes/legacy","score":.9},{"source_id":"pkm://notes/Other","score":.1}]}
learner.observe(response,2.5,query="Private original staged history query")
with learner.connect() as db:receipt=db.execute("SELECT receipt FROM calls").fetchone()[0]
learner.feedback(receipt,["pkm://notes/legacy"],True,"user")
print(json.dumps({"receipt":receipt}))
`, join(repositoryRoot, "resources/retrieval_solutions.py"), historyRoot, model.packageId],
    { encoding: "utf8", env: { ...process.env, TMPDIR: parent } }));
    assert.match(originalHistory.receipt, /^[a-f0-9]{48}$/);
    originalHistory.snapshot = await inspectLegacyRetrievalHistory(join(historyRoot, "retrieval-learning.sqlite3"));
    const snapshotTarget = join(parent, "owned-release-snapshot");
    const snapshotPlan = await planLegacyImport(source, {});
    await importLegacyWorkspace(snapshotPlan, snapshotTarget, { pythonExecutable: python });
    const snapshotStorage = await Storage.open(snapshotTarget);
    const snapshotWorker = new LegacyMcpPythonWorker(join(packageRoot, "compat/legacy-knowledge-mcp.py"));
    let retrievalSnapshot;
    try {
      await legacyIndexedKnowledgeRead(snapshotStorage, { tool: "retrieval_status", arguments: {} }, undefined, request => {
        retrievalSnapshot = request.retrievalSnapshot;
        return snapshotWorker.execute(request);
      }, { id: "mcp:external", canWrite: true });
    } finally { await snapshotWorker.close(); await snapshotStorage.close(); }
    const frozenBytes = execFileSync(python, ["-I", "-B", join(testsRoot, "legacy-retrieval-frozen-fixture.py")], {
      input: JSON.stringify({ root: join(historyRoot, "solutions", model.packageId), snapshot: retrievalSnapshot }),
      encoding: "utf8", env: { ...process.env, TMPDIR: parent, OMP_NUM_THREADS: "1" },
    }).trim();
    frozenRelease = JSON.parse(frozenBytes);
    await writeFile(join(historyRoot, "serving-release.json"), frozenBytes);
    execFileSync(python, ["-I", "-B", join(testsRoot, "legacy-retrieval-history-fixture.py"), historyRoot], {
      input: JSON.stringify({ state: originalHistory.snapshot.state, predecessor: true }),
      encoding: "utf8", env: { ...process.env, TMPDIR: parent },
    });
    originalHistory.snapshot = await inspectLegacyRetrievalHistory(join(historyRoot, "retrieval-learning.sqlite3"));
    assert.notEqual(originalHistory.snapshot.source.rawStateSha256, originalHistory.snapshot.source.stateSha256);
    historyBefore = await treeSnapshot(historyRoot);
  }
  const admitRecovery = async () => {
    if (!boardRecoveryEnabled) return;
    await mkdir(join(recoveryRoot, "blobs"), { recursive: true });
    const rawPlan = Buffer.from(JSON.stringify({ schema: "pkm.knowledge-recovery/v1", knowledgeRoot: destination,
      files: [{ path: "notes/Recovered.md", sha256: sha(recoveryBytes), mode: "100644" }] }));
    recoveryPlanSha = sha(rawPlan);
    await writeFile(join(recoveryRoot, "plan.json"), rawPlan);
    await writeFile(join(recoveryRoot, "blobs", sha(recoveryBytes)), recoveryBytes);
    storage = await Storage.open(destination);
    try {
      const expected = { actorId: "mcp:external", workspaceId: await storage.workspaceId(),
        evidenceRoot: recoveryRoot, auditRoot: recoveryRoot, planSha256: recoveryPlanSha,
        authorityId: "test-native-fixed-managed-recovery-owner" };
      await assert.rejects(admitLegacyKnowledgeRecovery(storage, { id: "mcp:external", canWrite: true }, {
        evidenceRoot: join(parent, "never-granted-missing-evidence"), auditRoot: recoveryRoot,
        expectedPlanSha256: recoveryPlanSha, authorityId: expected.authorityId,
        authorize() { return false; },
      }), /denied/i, "Host denial precedes any named external file read");
      await admitLegacyKnowledgeRecovery(storage, { id: expected.actorId, canWrite: true }, {
        evidenceRoot: recoveryRoot, auditRoot: recoveryRoot, expectedPlanSha256: recoveryPlanSha,
        authorityId: expected.authorityId, authorize(binding) {
          assert(Object.isFrozen(binding));
          assert.deepEqual(binding, expected);
          return true;
        },
      });
    } finally { await storage.close(); storage = undefined; }
  };
  const plan = await planLegacyImport(source, {}, {
    memoryEngine: database, memoryActorId: "mcp:external", memoryContinuityScopeSha256: sha(scope),
    ...(modelEnabled ? { retrievalHistory: { stateRoot: historyRoot, actorId: "mcp:external" } } : {}),
  });
  assert.equal(plan.ready, true, JSON.stringify(plan.blockers));
  let approved;
  const receipt = await importLegacyWorkspace(plan, destination, {
    pythonExecutable: python, memoryActorId: "mcp:external",
    ...(modelEnabled ? { authorizeRetrievalHistory(request) {
      assert.equal(request.selectedPackageId, model.packageId);
      assert.equal(request.sourceSha256, plan.retrievalHistoryPlan.source.sha256);
      return { actorId: request.actorId, decisionId: "native-explicit-disposable-original-history" };
    } } : {}),
    authorizeMemoryScopeContinuity(request) {
      assert(Object.isFrozen(request));
      assert.equal(request.scope, scope);
      assert.equal(request.actorId, "mcp:external");
      assert.equal(request.sourceScopeSha256, sha(scope));
      approved = request;
      return { actorId: request.actorId, decisionId: "native-explicit-disposable-managed-rehearsal", expiresAtMs: Date.now() + 60_000 };
    },
  });
  assert.equal(receipt.memoryScopeContinuity.workspaceId, approved.workspaceId);
  assert.equal(receipt.memoryScopeContinuity.importReceiptSha256, receipt.memoryImport.receiptSha256);
  assert.notEqual(memoryScope(destination), scope, "Persisted import provenance is not an active host session.");
  if (modelEnabled) {
    storage = await Storage.open(destination);
    try {
      const db = storage.connectNative();
      try {
        assert.deepEqual(readLegacyRetrievalLearning(db, {
          workspaceId: await storage.workspaceId(), actorId: "mcp:external",
        }).state, originalHistory.snapshot.state);
        const packages = verifyLegacyRetrievalModels(db, destination);
        assert.equal(packages.active.packageId, model.packageId);
        assert.deepEqual(packages.packages.map(row => row.package_id).sort(), [model.packageId, inactiveId].sort());
        assert.equal(db.prepare("SELECT count(*) AS count FROM legacy_original_learning_receipts").get().count, 0);
      } finally { db.close(); }
    } finally { await storage.close(); storage = undefined; }
    const disabledState = join(parent, "closed-original-null-selection"), disabledTarget = join(parent, "owned-null-selection");
    await cp(historyRoot, disabledState, { recursive: true });
    await rm(join(disabledState, "serving-release.json"));
    await writeFile(join(disabledState, "solution-selection.json"), JSON.stringify({ schema: 1, package_id: null }));
    const disabledBefore = await treeSnapshot(disabledState);
    const disabledPlan = await planLegacyImport(source, {}, {
      retrievalHistory: { stateRoot: disabledState, actorId: "mcp:external" },
    });
    assert.equal(disabledPlan.ready, true, JSON.stringify(disabledPlan.blockers));
    await importLegacyWorkspace(disabledPlan, disabledTarget, { pythonExecutable: python,
      authorizeRetrievalHistory: request => ({ actorId: request.actorId, decisionId: "native-explicit-null-selection" }) });
    const disabled = await Storage.open(disabledTarget), db = disabled.connectNative();
    try {
      const packages = verifyLegacyRetrievalModels(db, disabledTarget);
      assert.equal(packages.active, undefined);
      assert.equal(packages.selection.package_id, null);
      assert.equal(packages.packages.length, 2);
      assert.equal(db.prepare("SELECT count(*) AS count FROM legacy_original_learning_receipts").get().count, 0);
    } finally { db.close(); await disabled.close(); }
    assert.deepEqual(await treeSnapshot(disabledState), disabledBefore);
    const baseState = join(parent, "closed-original-base-predecessor"), baseTarget = join(parent, "owned-base-predecessor");
    await cp(historyRoot, baseState, { recursive: true });
    const baseRelease = JSON.parse(JSON.stringify(frozenRelease));
    baseRelease.release.config.model = join(baseState, "solutions", model.packageId, "model");
    const baseEnvelope = execFileSync(python, ["-I", "-c",
      "import hashlib,json,sys;v=json.load(sys.stdin);v['sha256']=hashlib.sha256(json.dumps(v['release'],sort_keys=True,ensure_ascii=False).encode()).hexdigest();print(json.dumps(v))"],
    { input: JSON.stringify(baseRelease), encoding: "utf8" });
    await writeFile(join(baseState, "serving-release.json"), baseEnvelope);
    execFileSync(python, ["-I", "-c", `
import sqlite3,sys
with sqlite3.connect(sys.argv[1]) as db:
 for table,width in [("models",9),("calls",11)]:
  names=[row[1] for row in db.execute("PRAGMA table_info("+table+")")]
  for column in reversed(names[width:]):db.execute("ALTER TABLE "+table+" DROP COLUMN "+column)
 db.execute("DROP TABLE query_judgments")
`, join(baseState, "retrieval-learning.sqlite3")]);
    const baseBefore = await treeSnapshot(baseState);
    const baseOriginal = await inspectLegacyRetrievalHistory(join(baseState, "retrieval-learning.sqlite3"));
    const basePlan = await planLegacyImport(source, {}, {
      retrievalHistory: { stateRoot: baseState, actorId: "mcp:external" },
    });
    assert.equal(basePlan.ready, true, JSON.stringify(basePlan.blockers));
    await importLegacyWorkspace(basePlan, baseTarget, { pythonExecutable: python,
      authorizeRetrievalHistory: request => ({ actorId: request.actorId, decisionId: "native-explicit-base-predecessor" }) });
    const baseStorage = await Storage.open(baseTarget), baseDb = baseStorage.connectNative();
    try {
      assert.deepEqual(readLegacyRetrievalLearning(baseDb, {
        workspaceId: await baseStorage.workspaceId(), actorId: "mcp:external",
      }).state, baseOriginal.state);
      assert.equal(verifyLegacyRetrievalModels(baseDb, baseTarget).active.packageId, model.packageId);
      assert.equal(baseDb.prepare("SELECT count(*) AS count FROM legacy_original_learning_receipts").get().count, 0);
    } finally { baseDb.close(); await baseStorage.close(); }
    assert.deepEqual(await treeSnapshot(baseState), baseBefore);
  }
  await admitRecovery();
  if (actionSnapshotsEnabled) {
    await mkdir(actionRoot);
    const archive = portableActionArchive();
    await writeFile(actionArchive, archive);
    storage = await Storage.open(destination);
    try {
      await storage.provisionTrash();
      const workspaceId = await storage.workspaceId(), stat = await lstat(destination), rootPin = `${stat.dev}:${stat.ino}`;
      const expected = { actorId: "mcp:external", workspaceId, workspaceRoot: destination, workspaceRootPin: rootPin,
        sourceRoot: actionRoot, sourcePath: actionArchive, packageSha256: sha(archive),
        authorityId: "test-native-fixed-managed-action-catalog" };
      await admitLegacyActionPackage(storage, { id: expected.actorId, canWrite: true }, {
        sourceRoot: actionRoot, sourcePath: actionArchive, expectedPackageSha256: expected.packageSha256,
        authorityId: expected.authorityId, authorize(binding) {
          assert(Object.isFrozen(binding)); assert.deepEqual(binding, expected); return true;
        },
      });
      await admitLegacyKnowledgeSnapshots(storage, { id: "mcp:external", canWrite: true }, {
        authorityId: "test-native-fixed-managed-private-git", allowedTools: snapshotTools,
        authorize(binding) {
          assert.equal(binding.actorId, "mcp:external");
          assert.equal(binding.workspaceId, workspaceId);
          assert.equal(binding.workspaceRoot, destination);
          assert.equal(binding.privateGitRoot, join(destination, "packages/knowledge-snapshots/repository.git"));
          assert.equal(binding.authorityId, "test-native-fixed-managed-private-git");
          assert.equal(binding.operation, "admit");
          assert.deepEqual([...binding.allowedTools].sort(), [...snapshotTools].sort());
          assert(binding.rootPin === undefined || binding.rootPin === rootPin);
          return true;
        },
      });
    } finally { await storage.close(); storage = undefined; }
    await writeFile(join(destination, "notes/SnapshotOriginal.md"), snapshotOriginal, { mode: 0o755 });
  }
  if (schedulerArtifactsEnabled) {
    assert(actionSnapshotsEnabled, "Scheduler/artifact acceptance extends the genuine Action/private Git fixture");
    schedulerArtifacts = await enrollManagedSchedulerArtifacts(destination, join(parent, "explicit-host-artifact-paths"),
      { snapshotsAlreadyAdmitted: true });
  }
  const compiled = join(parent, "original-chat-connector.cjs");
  require("esbuild").buildSync({ entryPoints: [join(repositoryRoot, "src/chat/api-chat-mcp.ts")],
    outfile: compiled, bundle: true, platform: "node", format: "cjs", external: ["vscode"], logLevel: "silent" });
  const Module = require("node:module"), load = Module._load;
  let connectManagedChatMcp;
  try {
    Module._load = function (name, ...args) { return name === "vscode" ? {} : load.call(this, name, ...args); };
    ({ connectManagedChatMcp } = require(compiled));
  } finally { Module._load = load; }
  const connect = async root => {
    const connection = await connectManagedChatMcp(await isolatedManagedLaunch(root), new AbortController().signal, root);
    connections.push(connection); return connection;
  };
  const call = async (connection, name, input = {}) => {
    const result = JSON.parse(await connection.invoke(`mcp_pkm_${name}`, input, new AbortController().signal));
    return result.structuredContent ?? JSON.parse(result.content.filter(part => part.type === "text").map(part => part.text).join("\n"));
  };
  const memory = (connection, action, args, mutation = false) => call(connection,
    mutation ? "capability_call" : "capability_read",
    { operation: `memory.record.${action}`, version: 1, arguments: args });
  const workerPids = new Set();
  let stagedModelImportVerified = false;
  const checkMaintenance = async (connection, data) => {
    const worker = await call(connection, "retrieval_status");
    assert.equal(worker.ok, true);
    assert.equal(worker.ready, true);
    assert.equal(worker.semantic_status, modelEnabled ? "ready" : "off");
    if (modelEnabled) {
      assert.equal(worker.solution.active_package_id, null, "Frozen Skill serving is independent of the disabled portable solution manager");
      assert.equal(worker.skill_serving.release_id, frozenRelease.sha256);
      assert.equal(worker.solution.state, "disabled");
    } else assert.equal(worker.solution.state, "disabled");
    assert.equal(worker.skill_serving.enabled, modelEnabled);
    assert(worker.pid > 0);
    assert(!workerPids.has(worker.pid), "A new owned connection starts a distinct persistent Python child");
    workerPids.add(worker.pid);
    process.kill(worker.pid, 0);
    const feedback = await call(connection, "skill_feedback", {
      task: "Do not retain this raw private staged task.", used_skills: ["Evidence Skill"], outcome: "success",
      observations: ["Synthetic staged observation"], evidence: ["test proof"],
    });
    assert.equal(feedback.ok, true);
    const raw = await readFile(join(data, "_feedback", "skill-usage.jsonl"), "utf8");
    assert.equal(JSON.parse(raw.trimEnd().split("\n").at(-1)).id, feedback.feedback_id);
    assert(!raw.includes("Do not retain this raw private staged task."));
    const proposal = await call(connection, "propose_skill_update", {
      skill_id: "Evidence Skill", base_hash: "", reason: "Synthetic reviewable improvement",
      evidence: ["test proof"], proposed_content: "# Proposed only", confidence: .75,
    });
    assert.equal(proposal.ok, true);
    assert.equal(proposal.conflict, false);
    const proposalRaw = await readFile(proposal.proposal_path, "utf8");
    assert.match(proposalRaw, /# Proposed only/);
    assert.equal(await readFile(join(data, "skills", "Evidence.md"), "utf8"), formalSkill);
    assert.equal((await call(connection, "retrieval_status")).pid, worker.pid);
    return { pid: worker.pid, feedbackRaw: raw, proposalPath: proposal.proposal_path, proposalRaw };
  };
  const closeWorker = async (connection, pid) => {
    await connection.close();
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" }, "Managed close must reap its actual persistent Python child");
  };
  const checkModel = async connection => {
    if (!modelEnabled) return;
    await assert.rejects(call(connection, "retrieval_feedback", {
      retrieval_id: originalHistory.receipt, relevant_source_ids: ["pkm://notes/legacy"],
      complete: true, provenance: "model",
    }), /actor-bound model receipt/i, "Historical raw receipt never receives a manufactured actor envelope");
    const result = await call(connection, "search_knowledge", { query: "evidence model", route: "semantic", debug: true });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.semantic_status, "ready");
    assert.equal(result.model_invoked, true, "No lexical fallback may satisfy managed model acceptance");
    assert.equal(result.skill_serving.release_id, frozenRelease.sha256);
    assert(result.hits.every(hit => hit.content_type === "skill"), "Selected frozen release serves its exact evaluated Skill corpus");
    assert.match(result.retrieval_id, /^[a-f0-9]{48}$/);
    assert(result.hits.length > 0);
    assert.equal(result.online_learning.enabled, true);
    const args = { retrieval_id: result.retrieval_id, relevant_source_ids: [result.hits[0].source_id],
      complete: true, provenance: "model" };
    const feedback = await call(connection, "retrieval_feedback", args);
    assert.equal(feedback.ok, true, JSON.stringify(feedback));
    assert.equal(feedback.trained, true);
    firstModelFeedback ??= args;
    const replay = await call(connection, "retrieval_feedback", firstModelFeedback);
    assert.equal(replay.ok, true, JSON.stringify(replay));
    assert.equal(replay.duplicate, true, "Original receipt and learner state survive restart and relocated restore");
  };
  const checkBoardRecovery = async (connection, data, create = false) => {
    if (!boardRecoveryEnabled) return;
    const tool = (name, args, write = false) => call(connection, write ? "capability_call" : "capability_read",
      { operation: `mcp.tool.${name}`, version: 1, arguments: args });
    if (create) {
      const created = await tool("todo_board_create", { title: "Board", category: "Project" }, true);
      assert.equal(created.ok, true);
      assert.equal(created.slug, "Project/Board");
      assert.deepEqual(created.items, []);
      const mutation = await tool("note_work_item_command", { slug: created.slug, expected_digest: created.digest,
        command: { action: "create", item: { id: "managed-created", title: "Verify Board authority",
          goal: "Continue with fixed worker", scope: "Managed Board", acceptance: ["Native admission"],
          kind: "Task", state: "Planning", evidence: [] } } }, true);
      assert.equal(mutation.ok, true);
      assert.equal(mutation.items[0].id, "managed-created");
      boardDigest = mutation.digest;
      const preview = await tool("knowledge_recovery_preview", { evidence_directory: recoveryRoot });
      assert.equal(preview.plan_sha256, recoveryPlanSha);
      assert.equal(preview.counts.restore, 1);
      for (const bad of [{ evidence_directory: join(parent, "unadmitted") },
        { evidence_directory: recoveryRoot, actorId: "user:local" },
        { evidence_directory: recoveryRoot, evidenceRoot: recoveryRoot }])
        await assert.rejects(tool("knowledge_recovery_preview", bad));
      const applied = await tool("knowledge_recovery_apply", {
        evidence_directory: recoveryRoot, approved_plan_sha256: recoveryPlanSha,
      }, true);
      assert.equal(applied.ok, true);
      assert.equal(applied.restored, 1);
      recoveryReport = await readFile(applied.report);
      assert.equal(JSON.parse(recoveryReport).plan_sha256, recoveryPlanSha);
    }
    const listing = await tool("list_notes", { limit: 0 });
    assert(listing.notes.some(note => note.slug === "Project/Board" && note.documentKind === "todo-board" && note.type === "todo"));
    const board = await tool("get_note", { slug: "Project/Board" });
    assert.equal(board.documentKind, "todo-board");
    const items = await tool("note_work_items", { slug: "Project/Board" });
    assert.equal(items.digest, boardDigest);
    assert.equal(items.items[0].id, "managed-created");
    assert((await tool("note_work_item_notes", {})).notes.some(note => note.slug === "Project/Board"));
    assert.deepEqual(await readFile(join(data, "notes/Recovered.md")), recoveryBytes);
    if (data === destination) {
      const preview = await tool("knowledge_recovery_preview", { evidence_directory: recoveryRoot });
      assert.equal(preview.counts.identical, 1);
    } else await assert.rejects(tool("knowledge_recovery_preview", { evidence_directory: recoveryRoot }),
      /admi|grant|root|evidence|denied/i, "Restored receipts must not remap an old external root grant");
  };
  const checkActionSnapshots = async (connection, data, create = false) => {
    if (!actionSnapshotsEnabled) return;
    const tool = (name, args = {}, write = false) => call(connection, write ? "capability_call" : "capability_read",
      { operation: `mcp.tool.${name}`, version: 1, arguments: args });
    const selection = { module_set_id: portableActionManifest.module_set_id, version: portableActionManifest.version };
    assert((await tool("action_templates")).templates);
    const definition = await tool("action_definition_check", { definition: originalAction.example });
    assert(definition);
    if (create) {
      await assert.rejects(tool("action_module_set_import", { local_path: join(actionRoot, "unadmitted.zip") }, true));
      await tool("action_module_set_import", { local_path: actionArchive }, true);
      await tool("action_module_set_load", selection, true);
      await tool("action_module_set_load", { ...selection, enabled: false }, true);
      await assert.rejects(tool("action_get", { action_id: originalAction.example.action_id }));
      await tool("action_module_set_load", selection, true);
      const proposal = await tool("action_register", {
        definition: { ...originalAction.example, action_id: "example.managed.pending" },
      }, true);
      assert.equal(proposal.registered, false);
      assert.equal(proposal.callable, false);
      actionProposalId = proposal.proposal_id;
      actionCatalogBefore = await tool("action_module_sets");
      const snapshot = await tool("knowledge_snapshot_create", { reason: "managed-disposable" }, true);
      assert.equal(snapshot.private, true);
      snapshotTag = snapshot.tag;
      await writeFile(join(data, "notes/SnapshotOriginal.md"), snapshotChanged);
      await chmod(join(data, "notes/SnapshotOriginal.md"), 0o644);
      await writeFile(join(data, "notes/SnapshotExtra.md"), "---\ntitle: Extra\n---\nTrash this extra.\n");
      const preview = await tool("knowledge_snapshot_restore_preview", { tag: snapshot.tag }, true);
      assert(preview.changes.some(change => change.path === "notes/SnapshotOriginal.md" && change.action === "restore"));
      await assert.rejects(tool("knowledge_snapshot_restore_apply", {
        preview_id: preview.preview_id, approved_sha256: "0".repeat(64),
      }, true));
      assert.deepEqual(await readFile(join(data, "notes/SnapshotOriginal.md")), snapshotChanged);
      const applied = await tool("knowledge_snapshot_restore_apply", {
        preview_id: preview.preview_id, approved_sha256: preview.approved_sha256,
      }, true);
      assert.equal(applied.status, "completed");
      assert.equal(applied.privacy_preserved, true);
      await assert.rejects(lstat(join(data, "notes/SnapshotExtra.md")), { code: "ENOENT" });
      const trash = await treeSnapshot(join(data, "notes/.trash"));
      assert(Object.keys(trash).some(name => name.endsWith("/payload")));
      assert(Object.values(trash).includes(sha(snapshotChanged)));
      for (const bad of [{ actorId: "user:local" }, { root: data }, { allowedTools: snapshotTools }])
        await assert.rejects(tool("knowledge_snapshot_status", bad));
      if (!schedulerArtifactsEnabled) await assert.rejects(tool("knowledge_snapshot_configure", { enabled: true }, true));
    }
    const selected = await tool("action_get", { action_id: originalAction.example.action_id });
    assert.equal(selected.availability.state, "blocked");
    assert.match(selected.availability.reason, /ACTION_ADMISSION_REQUIRED/);
    assert.deepEqual(await tool("action_module_sets"), actionCatalogBefore);
    assert((await tool("action_proposals")).proposals.some(proposal => proposal.proposal_id === actionProposalId));
    assert.deepEqual(await readFile(join(data, "notes/SnapshotOriginal.md")), snapshotOriginal);
    assert.equal((await lstat(join(data, "notes/SnapshotOriginal.md"))).mode & 0o777, 0o755);
    if (data === destination) assert((await tool("knowledge_snapshot_status")).tags.includes(snapshotTag));
    else await assert.rejects(tool("knowledge_snapshot_status"), /grant|root|scope|admi|denied/i,
      "Private Git authority remains bound to its original workspace root until fresh host approval");
  };
  const checkMemory = async connection => {
    const indexed = await call(connection, "get_knowledge", { id: "pkm://notes/legacy" });
    assert.equal(indexed.content, "Original source bytes remain untouched.\n");
    const found = await call(connection, "search_knowledge", { query: "Original", debug: true });
    assert.equal(found.ok, true, JSON.stringify(found));
    assert(found.hits.some(hit => hit.content_type === "note" && hit.source_id === indexed.source_id));
    await assert.rejects(memory(connection, "get", { id }), /scope|unavailable|not available/i,
      "Managed Chat never inherits a different process's Memory migration approval.");
    const search = await memory(connection, "search", { query: "original" });
    assert.deepEqual(search.result.records, []);
    await assert.rejects(memory(connection, "audit", { id }), /scope|unavailable|not available/i);
    await assert.rejects(memory(connection, "get", { id: foreignId }), /not found in this repository scope/i);
    await assert.rejects(memory(connection, "propose", {
      content: "Original confirmed fact.", sources: references, operation_id: "foreign-proposal",
    }, true), /scope|unavailable|not available/i,
    "An imported foreign historical receipt must not bypass selected-scope read authority");
    await assert.rejects(memory(connection, "propose", {
      content: "Original confirmed fact.", sources: references, operation_id: "old-proposal",
    }, true), /scope|unavailable|not available/i);
    await assert.rejects(memory(connection, "confirm", {
      id, expected_revision: 2, operation_id: "no-human-decision",
    }, true), /native|decision|authoriz|unavailable|not available/i);
    return { importedScopeActivated: false };
  };
  const stage = async data => {
    const generation = await stageIsolatedManagedGeneration({ managedRoot, data, allowWrites: true, python,
      ...(schedulerArtifactsEnabled && data === destination ? { snapshotScheduler: schedulerArtifacts.snapshotScheduler } : {}),
      modelDependencies: modelEnabled, maxPythonDependencyBytes: modelEnabled ? 2 * 1024 ** 3 : 512 * 1024 ** 2 });
    assert.equal(generation.pythonDependencyProfile, modelEnabled ? "local-model" : "fastmcp");
    if (modelEnabled) {
      const pins = JSON.parse(await readFile(join(managedRoot, "generations", generation.generation, "python-dependencies.json"), "utf8"));
      assert.equal(pins.requirementsSha256, sha(await readFile(join(repositoryRoot, "resources/retrieval-model-requirements.txt"))));
      assert.equal(pins.distributions.torch.version, "2.6.0+cpu");
      assert.match(pins.distributions.transformers.version, /^4\./);
      assert(Object.keys(pins.distributions.torch.files).some(name => /^torch\/lib\/.*\.so/.test(name)));
      assert(!Object.keys(pins.distributions).some(name => /^(nvidia|triton)/.test(name)));
      if (!stagedModelImportVerified) {
        const probe = JSON.parse(execFileSync(python, ["-I", "-S", "-B", "-c", `
import json,pathlib,sys
root=pathlib.Path(sys.argv[1]).resolve()
sys.path.insert(0,str(root))
import torch,numpy,sklearn,sentence_transformers,transformers,safetensors,sentencepiece,yaml
modules=[torch,numpy,sklearn,sentence_transformers,transformers,safetensors,sentencepiece,yaml]
origins={m.__name__:str(pathlib.Path(m.__file__).resolve()) for m in modules}
assert all(pathlib.Path(p).is_relative_to(root) for p in origins.values()),origins
assert not any("site-packages" in p and pathlib.Path(p).resolve()!=root for p in sys.path),sys.path
assert torch.version.cuda is None
print(json.dumps({"origins":origins,"isolated":bool(sys.flags.isolated),"noSite":bool(sys.flags.no_site),"cpuProduct":(torch.tensor([[1.,2.]])@torch.tensor([[3.],[4.]])).tolist()}))
`, join(managedRoot, "generations", generation.generation, "runtime/site-packages")],
        { encoding: "utf8", env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } }));
        assert.equal(probe.isolated, true); assert.equal(probe.noSite, true);
        assert.deepEqual(probe.cpuProduct, [[11]]);
        console.log("MANAGED_MODEL_STAGED_IMPORT_OK", JSON.stringify(probe));
        stagedModelImportVerified = true;
      }
    }
    for (const name of ["compat/legacy-compact-mcp.py", "dist/memory-import.js", "dist/memory-scope-continuity.js",
      "compat/legacy-retrieval-index.py", "compat/legacy-retrieval-worker-captured.py",
      "dist/legacy-retrieval-index.js", "dist/legacy-retrieval-subscriptions.js",
      "dist/legacy-retrieval-snapshot-captured.js", "dist/legacy-retrieval-projection-captured.js",
      "dist/legacy-subscription-cache-import.js", "dist/legacy-skill-maintenance.js",
      "dist/legacy-mcp-python-worker.js"]) {
      assert.equal(generation.files[`runtime/next-server/${name}`], sha(await readFile(join(packageRoot, name))),
        `Generation captures exact current implementation bytes: ${name}`);
    }
    const wheel = "vendor/adaptive_skill_retrieval-0.3.0.dev2026100504-py3-none-any.whl";
    assert.equal(generation.files[`runtime/next-server/legacy/resources/${wheel}`],
      "332e434272a3cc88410eb50c7e4bfc3e3f69c5bf1e13f7f9a799087c37124f89");
    assert.equal(generation.files[`runtime/next-server/legacy/resources/${wheel}`],
      sha(await readFile(join(repositoryRoot, "resources", wheel))));
    return generation;
  };
  const first = await stage(destination);
  assert.equal(first.enabledFeatureDomains.length, 0);
  assert.equal(first.version, "0.1.0");
  await publishIsolatedManagedGeneration(managedRoot, first.generation);
  const firstConnection = await connect(managedRoot);
  assert.equal((await call(firstConnection, "get_note", { id: "legacy" })).title, "Original legacy Note");
  assert.equal((await call(firstConnection, "get_research", { slug: "paper" })).title, "Original Research");
  await checkBoardRecovery(firstConnection, destination, true);
  await checkActionSnapshots(firstConnection, destination, true);
  const schedulerTool = connection => (name, args = {}, write = false) => call(connection,
    write ? "capability_call" : "capability_read", { operation: `mcp.tool.${name}`, version: 1, arguments: args });
  if (schedulerArtifactsEnabled) {
    const tool = schedulerTool(firstConnection);
    const imported = await tool("action_artifact_import", { local_path: schedulerArtifacts.source }, true);
    artifactId = imported.artifact_id; assert.match(artifactId, /^artifact_[a-f0-9]{32}$/);
    assert.equal((await tool("action_artifact_export", { artifact_id: artifactId,
      destination: schedulerArtifacts.destination }, true)).digest, schedulerArtifacts.digest);
    assert.equal(sha(await readFile(schedulerArtifacts.destination)), schedulerArtifacts.digest);
    assert.throws(() => execFileSync(process.execPath, [join(managedRoot, "generations", first.generation,
      "runtime/next-server/dist/cli.js"), "backup", "--data", destination, "--destination", join(parent, "competing-backup")],
    { encoding: "utf8", stdio: "pipe", timeout: 15_000 }), /lease|locked|busy|already/i,
    "A separate real CLI backup must not bypass the live managed backend's native lease");
    await assert.rejects(tool("action_artifact_export", { artifact_id: artifactId,
      destination: schedulerArtifacts.destination }, true));
    const before = await tool("knowledge_snapshot_status");
    scheduleTime = nextRealSnapshotMinute();
    const configured = await tool("knowledge_snapshot_configure", { enabled: true, ...scheduleTime }, true);
    assert(Date.parse(configured.next_run_utc) > Date.now());
    scheduledTags = (await waitForRealSnapshot(tool, before.tags.length)).tags.length;
    console.log("MANAGED_REAL_SNAPSHOT_TIMER_OK", JSON.stringify({ due: configured.next_run_utc, scheduledTags }));
  }
  const proposal = await checkMemory(firstConnection);
  await checkModel(firstConnection);
  const maintenanceFirst = await checkMaintenance(firstConnection, destination);
  const second = await stage(destination);
  assert.equal(second.runtimeBuild, first.runtimeBuild);
  await publishIsolatedManagedGeneration(managedRoot, second.generation);
  const oldStatus = await call(firstConnection, "mcp_lifecycle_status");
  assert.equal(oldStatus.generation, first.generation);
  assert.equal(oldStatus.updateAvailable, true);
  await closeWorker(firstConnection, maintenanceFirst.pid);
  const secondConnection = await connect(managedRoot);
  assert.equal(secondConnection.generation, second.generation);
  await checkBoardRecovery(secondConnection, destination);
  await checkActionSnapshots(secondConnection, destination);
  if (schedulerArtifactsEnabled) {
    const tool = schedulerTool(secondConnection);
    assert.equal((await tool("knowledge_snapshot_status")).tags.length, scheduledTags);
    await assert.rejects(tool("action_artifact_export", { artifact_id: artifactId,
      destination: schedulerArtifacts.destination }, true), /exist|overwrite|destination/i);
    scheduleTime = nextRealSnapshotMinute();
    const configured = await tool("knowledge_snapshot_configure", { enabled: true, ...scheduleTime }, true);
    catchupDue = Date.parse(configured.next_run_utc);
    assert(catchupDue > Date.now(), "Restart catch-up must stop the real host before its deadline");
  }
  assert.deepEqual(await checkMemory(secondConnection), proposal);
  await checkModel(secondConnection);
  const maintenanceSecond = await checkMaintenance(secondConnection, destination);
  await closeWorker(secondConnection, maintenanceSecond.pid);
  if (schedulerArtifactsEnabled) await new Promise(resolve => setTimeout(resolve, Math.max(0, catchupDue - Date.now() + 500)));
  const restarted = await connect(managedRoot);
  if (schedulerArtifactsEnabled) {
    const tool = schedulerTool(restarted);
    scheduledTags = (await waitForRealSnapshot(tool, scheduledTags)).tags.length;
    assert.equal((await tool("knowledge_snapshot_configure", { enabled: false, ...scheduleTime }, true)).enabled, false);
    console.log("MANAGED_REAL_SNAPSHOT_RESTART_CATCHUP_OK", JSON.stringify({ catchupDue, scheduledTags, disabled: true }));
  }
  await checkBoardRecovery(restarted, destination);
  await checkActionSnapshots(restarted, destination);
  assert.deepEqual(await checkMemory(restarted), proposal);
  await checkModel(restarted);
  const maintenanceRestarted = await checkMaintenance(restarted, destination);
  assert(maintenanceRestarted.feedbackRaw.startsWith(maintenanceSecond.feedbackRaw));
  let backupDue;
  if (schedulerArtifactsEnabled) {
    const configured = await schedulerTool(restarted)("knowledge_snapshot_configure",
      { enabled: true, ...nextRealSnapshotMinute() }, true);
    backupDue = Date.parse(configured.next_run_utc);
  }
  await closeWorker(restarted, maintenanceRestarted.pid);
  if (modelEnabled) {
    assert.deepEqual(await treeSnapshot(source), sourceBefore);
    assert.deepEqual(await treeSnapshot(model.root), modelSourceBefore);
    assert.deepEqual(await treeSnapshot(historyRoot), historyBefore);
    assert.deepEqual(await readFile(database), databaseBefore);
    const stat = await lstat(database, { bigint: true });
    for (const name of ["dev", "ino", "size", "mtimeNs"]) assert.equal(stat[name], databaseStat[name]);
    for (const suffix of ["-wal", "-shm"]) await assert.rejects(lstat(database + suffix), { code: "ENOENT" });
    originalsVerifiedBeforeRemoval = true;
    await rm(source, { recursive: true });
    await rm(model.root, { recursive: true });
    await rm(historyRoot, { recursive: true });
    await rm(database);
  }
  // The actual managed backend has closed its exclusive native lease. This test
  // owns the only remaining storage host and a real admission fence during backup.
  storage = await Storage.open(destination);
  if (schedulerArtifactsEnabled) {
    const scheduler = createAdmittedLegacyKnowledgeSnapshotScheduler(storage, { id: "mcp:external", canWrite: true },
      schedulerArtifacts.snapshotScheduler.admissionSha256);
    const native = await createNativeRuntime({ storage });
    await scheduler.start();
    try {
      await createWorkspaceBackup(storage, join(parent, "admission-fence-backup"), {
        acquireQuiescence: async () => {
          assert.equal((await scheduler.status()).started, false, "Automatic backup fence precedes native quiescence");
          const before = await scheduler.status();
          await new Promise(resolve => setTimeout(resolve, Math.max(0, backupDue - Date.now() + 500)));
          assert.deepEqual(await scheduler.status(), before, "No due claim may enter while backup admission is paused");
          return native.acquireWorkspaceQuiescence();
        },
      });
      while (!(await scheduler.status()).lastCompletedUtc || Date.parse((await scheduler.status()).lastCompletedUtc) < backupDue) {
        assert(Date.now() < backupDue + 30_000, "Released native backup fence must resume exactly one actual due job");
        await new Promise(resolve => setTimeout(resolve, 200));
      }
    } finally { await scheduler.close(); await native.close(); }
    const db = storage.connectNative();
    try { verifyLegacyActionArtifacts(db, await storage.workspaceId()); verifySnapshotSchedule(db); } finally { db.close(); }
    await storage.close(); storage = undefined;
    const disabled = await connect(managedRoot);
    assert.equal((await schedulerTool(disabled)("knowledge_snapshot_configure",
      { enabled: false, ...nextRealSnapshotMinute() }, true)).enabled, false);
    await disabled.close();
    storage = await Storage.open(destination);
    console.log("MANAGED_PERSISTED_QUEUE_NATIVE_BACKUP_FENCE_OK", JSON.stringify({
      managedCliQueue: true, nativeAutomaticBackupFence: true, actualDueCrossed: true, publicChatBackupClaim: false,
    }));
  }
  if (schedulerArtifactsEnabled) await rm(dirname(schedulerArtifacts.source), { recursive: true });
  if (actionSnapshotsEnabled) {
    await rm(actionRoot, { recursive: true });
    const db = storage.connectNative();
    try { verifyLegacyKnowledgeSnapshots(db, destination); } finally { db.close(); }
  }
  if (boardRecoveryEnabled) {
    assert(recoveryReport.length > 0);
    await rm(recoveryRoot, { recursive: true });
  }
  if (modelEnabled) {
    const db = storage.connectNative();
    try {
      const current = readLegacyRetrievalLearning(db, {
        workspaceId: await storage.workspaceId(), actorId: "mcp:external",
      }).state;
      assert.equal(current.settings.find(row => row[0] === "salt")[1],
        originalHistory.snapshot.state.settings.find(row => row[0] === "salt")[1]);
      assert.deepEqual(current.query_judgments, originalHistory.snapshot.state.query_judgments);
      assert.equal(verifyLegacyRetrievalModels(db, destination).packages.length, 2);
    } finally { db.close(); }
  }
  let held = false;
  const backedUp = await createWorkspaceBackup(storage, backup, {
    acquireQuiescence: async () => {
      assert.equal(held, false); held = true;
      return { assertHeld() { assert.equal(held, true); }, release() { held = false; } };
    },
  });
  assert.equal(held, false);
  if (actionSnapshotsEnabled) {
    assert.equal((await lstat(join(backup, ".pkm-workspace-backup.json"))).mode & 0o777, 0o600);
    const manifest = JSON.parse(await readFile(join(backup, ".pkm-workspace-backup.json"), "utf8"));
    for (const file of manifest.files)
      assert.equal((await lstat(join(backup, file.path))).mode & 0o777, 0o600, `Private archive stores bytes non-executable: ${file.path}`);
    assert.equal(manifest.files.find(file => file.path === "notes/SnapshotOriginal.md").mode, 0o755);
  }
  await storage.close(); storage = undefined;
  await mkdir(dirname(restored));
  const restoredReceipt = await restoreWorkspaceBackup(backup, restored, { nativeRestoreAuthority, pythonExecutable: python });
  assert.equal(restoredReceipt.workspaceId, backedUp.workspaceId);
  assert.notEqual(memoryScope(restored), scope);
  const relocated = await stage(restored);
  if (process.env.PKM_MANAGED_ACCEPTANCE_COPY_SIGNAL)
    await writeFile(process.env.PKM_MANAGED_ACCEPTANCE_COPY_SIGNAL, JSON.stringify({
      managedRoot, generations: [first.generation, second.generation, relocated.generation],
      runtimeBuilds: [first.runtimeBuild, second.runtimeBuild, relocated.runtimeBuild],
    }) + "\n", { flag: "wx" });
  assert.notEqual(relocated.runtimeBuild, second.runtimeBuild, "Pinned launcher data location changes after explicit relocation");
  await publishIsolatedManagedGeneration(managedRoot, relocated.generation);
  await verifyIsolatedManagedGeneration(managedRoot, relocated.generation);
  const restoredConnection = await connect(managedRoot);
  assert.equal(restoredConnection.generation, relocated.generation);
  await checkBoardRecovery(restoredConnection, restored);
  await checkActionSnapshots(restoredConnection, restored);
  if (schedulerArtifactsEnabled) {
    const tool = schedulerTool(restoredConnection);
    await assert.rejects(tool("action_artifact_import", { local_path: schedulerArtifacts.source }, true), /grant|root|scope|admi|denied/i);
    await assert.rejects(tool("action_artifact_export", { artifact_id: artifactId,
      destination: schedulerArtifacts.destination }, true), /grant|root|scope|admi|denied/i);
    const db = new (await import("node:sqlite")).DatabaseSync(join(restored, "core.sqlite"), { readOnly: true });
    try { verifyLegacyActionArtifacts(db, schedulerArtifacts.snapshotScheduler.workspaceId); verifySnapshotSchedule(db); }
    finally { db.close(); }
  }
  assert.deepEqual(await checkMemory(restoredConnection), proposal);
  await checkModel(restoredConnection);
  assert.equal(await readFile(join(restored, "_feedback", "skill-usage.jsonl"), "utf8"), maintenanceRestarted.feedbackRaw);
  assert.equal(await readFile(join(restored, "_proposals", "skills", maintenanceFirst.proposalPath.split("/").at(-1)), "utf8"),
    maintenanceFirst.proposalRaw);
  const maintenanceRestored = await checkMaintenance(restoredConnection, restored);
  assert(maintenanceRestored.feedbackRaw.startsWith(maintenanceRestarted.feedbackRaw));
  assert.equal((await call(restoredConnection, "get_note", { id: "legacy" })).content, "Original source bytes remain untouched.\n");
  await closeWorker(restoredConnection, maintenanceRestored.pid);
  if (modelEnabled) {
    assert.equal(originalsVerifiedBeforeRemoval, true);
    for (const path of [source, model.root, historyRoot, database]) await assert.rejects(lstat(path), { code: "ENOENT" });
  } else {
    assert.deepEqual(await treeSnapshot(source), sourceBefore);
    assert.deepEqual(await readFile(database), databaseBefore);
    const after = await lstat(database, { bigint: true });
    for (const name of ["dev", "ino", "size", "mtimeNs"]) assert.equal(after[name], databaseStat[name]);
  }
  for (const suffix of ["-wal", "-shm"]) await assert.rejects(lstat(database + suffix), { code: "ENOENT" });
  await assert.rejects(readdir(join(managedRoot, "instances")), { code: "ENOENT" });
  console.log("MANAGED_MEMORY_MIGRATION_OK", JSON.stringify({
    experimental: true, productionCutover: false, completeFeatureDomains: false,
    importOwned: true, scopeContinuityExplicit: true, originalSourcesUnchanged: true,
    originalChatConnector: true, originalMemoryReadSearchAudit: true,
    stagedOriginalRetrievalGetSearch: true, pinnedWheelDirectImport: true,
    persistentOriginalWorkerStatus: true, advisoryFeedbackProposal: true,
    formalSkillUnchanged: true, persistentChildrenReaped: true,
    selectedHistoricalReplay: true, foreignHistoricalReplayDenied: true,
    newProposalReplay: true, externalDecisionDenied: true,
    upgradeDrainReconnect: true, restart: true, relocatedBackupRestore: true,
    runtimeBuilds: [first.runtimeBuild, second.runtimeBuild, relocated.runtimeBuild],
    managedModelEnabled: modelEnabled, actualOfflineRandomModel: modelEnabled,
    modelQueryReceiptFeedbackRestartRestore: modelEnabled, modelQualityClaim: false,
    closedOriginalLearnerGenesisImported: modelEnabled, selectedAndInactivePackagesImported: modelEnabled,
    historicalRawReceiptDeniedThroughout: modelEnabled, originalRetrievalStateUnchanged: modelEnabled,
    nullSelectionKeepsInactivePackagesWithoutGrant: modelEnabled, historicalSaltAndUserJudgmentsPreserved: modelEnabled,
    partialPredecessorNormalizedByOriginalHelper: modelEnabled, basePredecessorFrozenGenesisControl: modelEnabled,
    originalFrozenReleaseIdentityPreserved: modelEnabled, originalsRemovedBeforeBackupRestore: modelEnabled,
    managedBoardCreateDiscoveryWorkItem: boardRecoveryEnabled, managedHostBoundRecoveryPreviewApply: boardRecoveryEnabled,
    recoveredRawBytesRestartRelocation: boardRecoveryEnabled, restoredExternalRootGrantNotRemapped: boardRecoveryEnabled,
    managedActionHostCatalogCompilerTemplatesGet: actionSnapshotsEnabled, actionSelectionBlockedNoExecutionGrant: actionSnapshotsEnabled,
    managedPrivateGitStatusCreatePreviewApplyTrash: actionSnapshotsEnabled, privateSnapshotSourceModesAndBackup0600: actionSnapshotsEnabled,
    actualManagedSchedulerTimerGitCommit: schedulerArtifactsEnabled, managedSchedulerPersistentRestartCatchup: schedulerArtifactsEnabled,
    managedArtifactImportExportNoOverwriteRestartRelocationDenial: schedulerArtifactsEnabled,
  }));
});
