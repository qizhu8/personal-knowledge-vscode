import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

const nextDist = process.env.PKM_NEXT_RECOVERY_TEST_DIST;
const hostDist = process.env.PKM_TEST_DIST;
const legacyDist = process.env.PKM_LEGACY_DIST;
const enabled = process.platform === "linux" && !!nextDist && !!hostDist && !!legacyDist
  && process.env.PKM_PRIVATE_PID_NAMESPACE === "1";
const require = createRequire(import.meta.url);
const load = name => import(pathToFileURL(join(resolve(nextDist), name)).href);

async function fixture() {
  const root = resolve(".migration-test-work", `host-next-recovery-${randomUUID()}`);
  await mkdir(join(root, "notes"), { recursive: true, mode: 0o700 });
  await writeFile(join(root, "notes/Existing.md"),
    "---\ntitle: Existing\ntype: general\n---\nOriginal synthetic note.\n", { mode: 0o600 });
  console.log(`HOST_NEXT_RECOVERY_FIXTURE ${root}`);
  return root;
}

async function failedHost(root) {
  const { HostWriterAdmission } = require(join(resolve(hostDist), "runtime/host-writer-admission.js"));
  const owner = new HostWriterAdmission(root, () => root);
  owner.markUncertain("host operation outcome unknown");
  await assert.rejects(owner.drain(), /outcome unknown/);
  return owner;
}

test("actual Next adoption and committed rollback fence failed legacy-host resume", { skip: !enabled, timeout: 60000 }, async () => {
  const root = await fixture(), owner = await failedHost(root);
  const { adoptLegacyRootInPlaceExperimental, rollbackCommittedLegacyRootAdoptionExperimental } =
    await load("legacy-root-adoption.js");
  const adopted = await adoptLegacyRootInPlaceExperimental(root, { experimentalPostCommitRollbackBaseline: true });
  const workspaceId = await adopted.storage.workspaceId();
  await adopted.storage.close();
  assert.throws(() => owner.resumeAfterFailedDrain(), /fenced|handed to next-server/i);
  assert.equal(owner.status().state, "unknown");
  const marker = await readFile(join(root, ".pkm-next-writer-fenced.json"), "utf8");
  assert.match(marker, /next-server/);
  const rollbackModule = pathToFileURL(join(resolve(nextDist), "legacy-root-adoption.js")).href;
  const killed = spawnSync(process.execPath, ["--input-type=module", "-e", `
    const api = await import(process.argv[1]);
    await api.rollbackCommittedLegacyRootAdoptionExperimental(process.argv[2], {
      workspaceId: process.argv[3],
      experimentalRollbackCheckpoint: point => {
        if (point === "owner-archived") process.kill(process.pid, "SIGKILL");
      },
    });
  `, rollbackModule, root, workspaceId], { encoding: "utf8", timeout: 60000 });
  assert.equal(killed.signal, "SIGKILL", killed.stderr);
  await assert.rejects(lstat(join(root, ".pkm-next-writer-fenced.json")), { code: "ENOENT" });
  await lstat(join(root, ".pkm-next-root-adoption-rollback.json"));
  assert.throws(() => owner.resumeAfterFailedDrain(), /fenced|handed to next-server/i);
  assert.equal(owner.status().state, "unknown");
  const result = await rollbackCommittedLegacyRootAdoptionExperimental(root, { workspaceId });
  assert.equal(result.qualification, "experimental-unqualified");
  owner.resumeAfterFailedDrain();
  const store = require(join(resolve(legacyDist), "knowledge/filestore.js"));
  store.setStorePath(root);
  await owner.observe("ui", () => store.noteUpsert({
    slug: "Existing", title: "Existing", type: "general", tags: [], content: "Legacy write after verified rollback.\n",
  }));
  assert.equal(store.noteGet("Existing").content, "Legacy write after verified rollback.\n");
  await assert.rejects(owner.drain(), /outcome unknown/);
});

test("a real Next Note write blocks rollback and keeps the failed legacy host closed", { skip: !enabled, timeout: 60000 }, async () => {
  const root = await fixture(), owner = await failedHost(root);
  const { adoptLegacyRootInPlaceExperimental, rollbackCommittedLegacyRootAdoptionExperimental } =
    await load("legacy-root-adoption.js");
  const { createNativeRuntime } = await load("native-runtime.js");
  const { legacyKnowledgeWrite } = await load("legacy-knowledge-write.js");
  const adopted = await adoptLegacyRootInPlaceExperimental(root, { experimentalPostCommitRollbackBaseline: true });
  const workspaceId = await adopted.storage.workspaceId();
  const runtime = await createNativeRuntime({ storage: adopted.storage });
  try {
    await legacyKnowledgeWrite(runtime.core, adopted.storage, { id: "fixture-owner", canWrite: true }, {
      tool: "update_note", arguments: { slug: "Existing", content: "Committed Next change.\n" },
    });
  } finally {
    await runtime.close();
    await adopted.storage.close();
  }
  await assert.rejects(rollbackCommittedLegacyRootAdoptionExperimental(root, { workspaceId }), { code: "SOURCE_CHANGED" });
  assert.throws(() => owner.resumeAfterFailedDrain(), /fenced|handed to next-server/i);
  assert.equal(owner.status().state, "unknown");
  assert.match(await readFile(join(root, "notes/Existing.md"), "utf8"), /Committed Next change/);
});

test("completed existing MCP and retrieval records cannot authorize Next adoption", { skip: !enabled, timeout: 60000 }, async () => {
  const root = await fixture();
  await mkdir(join(root, ".pkm/state"), { recursive: true, mode: 0o700 });
  await writeFile(join(root, ".pkm/content-privacy.json"), '{"schema":1,"private":{"notes":[]}}', { mode: 0o600 });
  const session = require(join(resolve(hostDist), "runtime/managed-writer-session.js"));
  const old = process.env.PKM_MANAGED_WRITER_SESSION, id = randomUUID();
  try {
    session.provisionManagedWriterSession(root, id);
    process.env.PKM_MANAGED_WRITER_SESSION = id;
    const oldMcp = session.beginExistingManagedMcp(root, id,
      { generation: randomUUID(), instanceId: "a".repeat(32), runtimeBuild: "b".repeat(64) });
    session.completeExistingManagedMcp(oldMcp);
    const build = await session.withManagedRetrievalOperation(root, async () =>
      session.beginManagedRetrievalBuild("a".repeat(64), "b".repeat(64)));
    session.completeManagedRetrievalBuild(build);
    session.closeManagedWriterAdmission(root, id);
    const successor = session.rotateManagedWriterSession(root, id).sessionId;
    session.closeManagedWriterAdmission(root, successor);
    const { planLegacyImport } = await load("legacy-import.js");
    const plan = await planLegacyImport(root, {}, { inPlaceAdoption: true });
    assert.equal(plan.ready, true, JSON.stringify(plan.blockers));
    assert.deepEqual(plan.inPlaceManagedWriterSession.retrieval, { completedRequests: 1, completedBuilds: 1, workerDrain: "unknown" });
    const { prepareLegacyRootAdoptionExperimental } = await load("legacy-root-adoption.js");
    await assert.rejects(prepareLegacyRootAdoptionExperimental(root, {
      snapshotAdmission: { authorityId: "synthetic-root-snapshot-authority",
        allowedTools: ["knowledge_snapshot_status"], authorize: () => true },
    }), error => error.code === "IMPORT_BLOCKED" && /shared worker or its background work/i.test(error.message));
    await assert.rejects(lstat(join(root, ".pkm-next-root-adoption.json")), { code: "ENOENT" });
  } finally {
    if (old === undefined) delete process.env.PKM_MANAGED_WRITER_SESSION;
    else process.env.PKM_MANAGED_WRITER_SESSION = old;
  }
});

test("compatible session cannot be mistaken for an absent session during Next adoption", { skip: !enabled, timeout: 60000 }, async () => {
  const root = await fixture();
  await mkdir(join(root, ".pkm/state"), { recursive: true, mode: 0o700 });
  await writeFile(join(root, ".pkm/content-privacy.json"), '{"schema":1,"private":{"notes":[]}}', { mode: 0o600 });
  const session = require(join(resolve(hostDist), "runtime/managed-writer-session.js"));
  session.bootstrapCompatibleManagedProfile(root, "a".repeat(64));
  const { prepareLegacyRootAdoptionExperimental } = await load("legacy-root-adoption.js");
  await assert.rejects(prepareLegacyRootAdoptionExperimental(root, {
    snapshotAdmission: { authorityId: "synthetic-root-snapshot-authority",
      allowedTools: ["knowledge_snapshot_status"], authorize: () => true },
  }), /session-compatible|adoption receipt/i);
  await assert.rejects(lstat(join(root, ".pkm-next-root-adoption.json")), { code: "ENOENT" });
});

test("a compatible session appearing after preparation blocks Next resume", { skip: !enabled, timeout: 60000 }, async () => {
  const root = await fixture();
  const { prepareLegacyRootAdoptionExperimental, resumeLegacyRootAdoptionExperimental } = await load("legacy-root-adoption.js");
  await prepareLegacyRootAdoptionExperimental(root, {});
  await mkdir(join(root, ".pkm/state/managed-writer-session-compatible"), { recursive: true, mode: 0o700 });
  await assert.rejects(resumeLegacyRootAdoptionExperimental(root, {}));
  await lstat(join(root, ".pkm-next-root-adoption.json"));
});
