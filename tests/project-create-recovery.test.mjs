import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fixture, hashes } from "./batch09-original-control-fixtures.mjs";
import { applyProjectMutation, planProjectMutation, recoverProjectMutation } from "../dist/project-mutations.js";
import { readProjectRecipes } from "../dist/project-recipes.js";

for (const state of ["empty", "forged-pin", "unknown-entry"]) test(`Project create ${state} recovery validates original snapshot before directory normalization`, async t => {
  const f = await fixture(t);
  await writeFile(join(f.source, ".pkm-next-workspace"), JSON.stringify({
    schema: "pkm.next-workspace/v2", id: randomUUID(),
  }));
  const snapshot = readProjectRecipes(f.source, { operation: "project.list", args: {}, actorId: "test:owner" });
  const plan = planProjectMutation(f.source, { operation: "project.create", actorId: "test:owner", args: {
    operationId: randomUUID(), name: "Recovery only", at: "2026-11-07T12:00:00.000Z",
    expectedSnapshotRevision: snapshot.snapshotRevision,
  } });
  const directory = join(f.source, dirname(plan.files[0].relativePath));
  await mkdir(directory);
  const original = await hashes(f.source);
  if (state === "forged-pin") {
    plan.rootPin = "f".repeat(64); plan.result.snapshotRevision = plan.rootPin;
  }
  if (state === "unknown-entry") await writeFile(join(directory, "unknown.bin"), "must retain unknown bytes");
  assert.equal(recoverProjectMutation(f.source, plan).state, "missing");
  const result = applyProjectMutation(f.source, plan);
  if (state === "empty") {
    assert.equal(result.state, "complete", JSON.stringify(result));
    assert.equal(JSON.parse(await readFile(join(f.source, plan.files[0].relativePath))).projectId, plan.result.entityId);
    assert.equal(JSON.parse(await readFile(join(f.source, plan.files[1].relativePath))).threadId, plan.result.createdThread.threadId);
  } else {
    assert.equal(result.state, "unknown");
    assert.deepEqual(await readdir(directory), state === "forged-pin" ? [] : ["unknown.bin"]);
    const after = await hashes(f.source);
    for (const [path, digest] of Object.entries(original)) assert.equal(after[path], digest);
  }
});
