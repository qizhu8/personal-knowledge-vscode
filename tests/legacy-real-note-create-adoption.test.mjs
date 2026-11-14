import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { prepareLegacyRootAdoptionExperimental, resumeLegacyRootAdoptionExperimental,
  rollbackCommittedLegacyRootAdoptionExperimental } from "../dist/legacy-root-adoption.js";
import { createNativeRuntime } from "../dist/native-runtime.js";
import { legacyKnowledgeTree } from "../dist/legacy-knowledge-snapshot.js";
import { legacyKnowledgeWrite } from "../dist/legacy-knowledge-write.js";
import { inspectLegacyUiRetiredState } from "../dist/legacy-ui-retired-state.js";
import { Storage } from "../dist/storage.js";

test("real drained 4.0.22 Note-create history survives isolated adoption and restart", {
  skip: !process.env.PKM_INSTALLED_LEGACY_WRITE_FIXTURE, timeout: 90000,
}, async () => {
  const source = join(resolve(process.env.PKM_INSTALLED_LEGACY_WRITE_FIXTURE), "root");
  const parent = resolve(".migration-test-work/root-upgrade-validation", `real-note-create-adoption-${randomUUID()}`);
  const root = join(parent, "root");
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const copy = spawnSync("cp", ["-a", "--", source, root], { encoding: "utf8", timeout: 30000 });
  assert.equal(copy.status, 0, copy.stderr || String(copy.error));
  const note = join(root, "notes/Reload in flight.md");
  const logDir = join(root, ".pkm/state/diagnostics/mcp");
  const usageDir = join(root, ".pkm/state/mcp-usage/events");
  const paths = [note, ...(await readdir(logDir)).map(name => join(logDir, name)),
    ...(await readdir(usageDir)).map(name => join(usageDir, name))];
  const digest = bytes => createHash("sha256").update(bytes).digest("hex");
  const before = await Promise.all(paths.map(async path => digest(await readFile(path))));
  const authorityId = "isolated-real-write-snapshot-authority", allowedTools = ["knowledge_snapshot_status"];
  const options = { experimentalPostCommitRollbackBaseline: true, snapshotAdmission: {
    authorityId, allowedTools,
    authorize: binding => binding.workspaceRoot === root && binding.authorityId === authorityId
      && binding.actorId === "mcp:external" && binding.operation === "admit"
      && binding.privateGitRoot === join(root, "packages/knowledge-snapshots/repository.git")
      && JSON.stringify(binding.allowedTools) === JSON.stringify(allowedTools),
  } };
  await prepareLegacyRootAdoptionExperimental(root, options);
  await assert.rejects(Storage.open(root), { code: "RECOVERY_REQUIRED" });
  assert.deepEqual(await Promise.all(paths.map(async path => digest(await readFile(path)))), before);
  const adopted = await resumeLegacyRootAdoptionExperimental(root, options);
  assert.equal(adopted.state, "committed");
  assert.equal(adopted.qualification, "experimental-unqualified");
  assert.deepEqual(await Promise.all(paths.map(async path => digest(await readFile(path)))), before);
  let native;
  try {
    native = await createNativeRuntime({ storage: adopted.storage });
    const updated = await legacyKnowledgeWrite(native.core, adopted.storage, { id: "fixture-owner", canWrite: true }, {
      tool: "update_note", arguments: { slug: "Reload in flight", content: "Preserved after Next restart." },
    });
    assert.deepEqual(JSON.parse(updated.text), { ok: true, slug: "Reload in flight" });
  } finally { await native?.close(); await adopted.storage.close(); }
  const reopened = await Storage.open(root);
  try {
    const read = legacyKnowledgeTree(root, "notes").find(entry => entry.path === "Reload in flight.md");
    assert.match(read.raw, /Preserved after Next restart/);
    native = await createNativeRuntime({ storage: reopened });
    const duplicate = await legacyKnowledgeWrite(native.core, reopened, { id: "fixture-owner", canWrite: true }, {
      tool: "add_note", arguments: { title: "Reload in flight", content: "Must not overwrite." },
    });
    assert.match(JSON.parse(duplicate.text).error, /already exists/);
    assert.match((await readFile(note, "utf8")), /Preserved after Next restart/);
  } finally { await native?.close(); await reopened.close(); }
  await assert.rejects(rollbackCommittedLegacyRootAdoptionExperimental(root, { workspaceId: adopted.workspaceId }),
    { code: "SOURCE_CHANGED" });
  assert.match((await readFile(note, "utf8")), /Preserved after Next restart/);
  assert.deepEqual(await Promise.all(paths.slice(1).map(async path => digest(await readFile(path)))), before.slice(1));
  const changedLog = paths[1];
  await writeFile(changedLog, Buffer.concat([await readFile(changedLog), Buffer.from("\n")]));
  assert.throws(() => inspectLegacyUiRetiredState(root), { code: "LEGACY_UI_RETIRED_STATE_BLOCKED" });
  await assert.rejects(Storage.open(root), { code: "INVALID_WORKSPACE" });
  console.log(`Retained isolated adoption fixture: ${parent}`);
});
