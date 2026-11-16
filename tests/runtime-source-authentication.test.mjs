import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { checkNativeRecords, hash, readOriginalSource } from "../scripts/migration.mjs";
import { originalReleaseModules } from "./legacy-release-modules.mjs";

test("runtime historical source authentication preserves exact protected generations without native substitutions", async () => {
  const metadata = JSON.parse(await readFile(new URL("../migration/evidence/runtime-authentication-originals.json", import.meta.url), "utf8"));
  const datasets = {
    "tests/test-api-chat.js": "runtime-chat-turn-historical",
    "src/runtime/pkm-service.ts": "runtime-runtime-process-historical",
    "src/retrieval/retrieval-worker.ts": "runtime-retrieval-evidence-historical",
    "resources/retrieval_worker.py": "runtime-retrieval-evidence-historical",
    "src/workflows/project-model.ts": "runtime-workflow-compiler-historical",
    "resources/recipe_runtime.py": "runtime-workflow-executor-historical",
  };
  for (const member of metadata.members) {
    assert.equal(member.kind, "source");
    const request = { sha256: member.sha256, dataset: datasets[member.path] };
    assert.equal(hash(await readOriginalSource(member.path, request)), member.sha256);
    await assert.rejects(readOriginalSource(member.path, { ...request, sha256: "0".repeat(64) }),
      error => error.evidenceReason === "generation-mismatch");
    await assert.rejects(readOriginalSource(member.path, { ...request, kind: "captured" }),
      error => error.evidenceReason === "generation-mismatch");
  }
  await assert.rejects(readOriginalSource("src/runtime/pkm-service.ts", {
    sha256: "663a189e39666ee1b32d95a0ab7c2a2188e0baec3d69f7310ce68d15a2459635",
  }), error => error.evidenceReason === "hash-changed");
});

test("current Linux candidate pins require explicit scope and cannot rewrite historical or forged native expectations", async () => {
  const metadata = JSON.parse(await readFile(new URL("../migration/runtime-process-provenance.json", import.meta.url), "utf8"));
  const pin = metadata.native.find(row => row.file === "src/runtime-process.ts");
  assert.ok(pin);
  const previous = process.env.PKM_TEST_QUALIFICATION;
  try {
    delete process.env.PKM_TEST_QUALIFICATION;
    assert.deepEqual(await checkNativeRecords([pin]), [{ kind: "native", path: pin.file, reason: "hash-changed" }]);
    process.env.PKM_TEST_QUALIFICATION = "linux-candidate";
    assert.deepEqual(await checkNativeRecords([pin]), []);
    assert.deepEqual(await checkNativeRecords([{ ...pin, sha256: "0".repeat(64) }]),
      [{ kind: "native", path: pin.file, reason: "hash-changed" }]);
    await assert.rejects(readOriginalSource("src/runtime/pkm-service.ts", {
      kind: "captured", sha256: "663a189e39666ee1b32d95a0ab7c2a2188e0baec3d69f7310ce68d15a2459635",
      dataset: "linux-candidate-originals",
    }), error => error.evidenceReason === "generation-mismatch");
    process.env.PKM_TEST_QUALIFICATION = "not-a-supported-qualification";
    await assert.rejects(checkNativeRecords([pin]), /Unknown explicit test qualification/);
  } finally {
    if (previous === undefined) delete process.env.PKM_TEST_QUALIFICATION;
    else process.env.PKM_TEST_QUALIFICATION = previous;
  }
});

test("compiled original oracle refuses unknown modules instead of falling back to current fenced sources", () => {
  const load = originalReleaseModules();
  assert.throws(() => load("src/knowledge/unknown-release-module.ts"), /outside the authenticated release closure/);
  assert.throws(() => load("src/../unknown-release-module.ts"), /outside the authenticated release closure/);
});
