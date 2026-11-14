import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { planLegacyImport, importLegacyWorkspace } from "../dist/legacy-import.js";
import { inspectMemoryHostPin } from "../dist/memory-readoption.js";
import { activateMemoryScopeContinuity, activateReadoptedMemoryScope } from "../dist/memory-scope-continuity.js";
import { readManagedMemory } from "../dist/managed-memory-reader.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { MemoryMigrationAuthority } = createRequire(import.meta.url)(join(root, "../dist/runtime/memory-migration-authority.js"));
const sha = value => createHash("sha256").update(value).digest("hex");

test("expired original adoption is provenance only; a separately confirmed session works without source files or grant mutation", async t => {
  const directory = join(root, "tests", `.readopt-${randomUUID()}`);
  const source = join(directory, "copy"), database = join(directory, "original.sqlite"), target = join(directory, "owned");
  await mkdir(join(source, "notes"), { recursive: true, mode: 0o700 });
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(source, "notes", "n.md"), "---\ntitle: Synthetic\n---\nSynthetic source.\n");
  const scope = "synthetic-original-scope", id = `explicit-${sha(`${scope}\0proposal`)}`;
  const python = execFileSync("python3", ["-I", "-c", "import sys; print(sys.executable)"], { encoding: "utf8" }).trim();
  execFileSync(python, ["-I", "-c", `
import sys
sys.path.insert(0,sys.argv[1])
from pkm_memory_engine import Engine
e=Engine(sys.argv[2],"synthetic-engine")
e.mutate("proposal","explicit_propose",{"id":sys.argv[4],"scope":sys.argv[3],"content":"Exact original fact","sources":[{"id":"s","chat":"c","revision":"r","locator":"l"}]})
e.close()
`, join(root, "compute"), database, scope, id]);
  const plan = await planLegacyImport(source, {}, {
    memoryEngine: database, memoryActorId: "local:owner", memoryContinuityScopeSha256: sha(scope),
  });
  const receipt = await importLegacyWorkspace(plan, target, {
    pythonExecutable: python, memoryActorId: "local:owner",
    authorizeMemoryScopeContinuity: request => ({ actorId: request.actorId, decisionId: randomUUID(), expiresAtMs: Date.now() + 1000 }),
  });
  const pin = inspectMemoryHostPin(target);
  await rm(source, { recursive: true }); await rm(database);
  const originalNow = Date.now, clock = Math.max(originalNow(), receipt.memoryScopeContinuity.expiresAtMs + 1);
  Date.now = () => clock;
  try {
    assert.throws(() => activateMemoryScopeContinuity(target, receipt.memoryScopeContinuity), { code: "NOT_AVAILABLE" });
    await assert.rejects(readManagedMemory(target, "memory-get", { id }), { code: "NOT_AVAILABLE" });
    const { schema, receiptStateSha256, ...identity } = pin;
    const request = { ...identity, schema: "pkm.memory-scope-continuity/v2" };
    const authority = new MemoryMigrationAuthority(() => true, () => clock);
    let confirmed = false;
    const approval = await authority.authorize({ target, request, receiptStateSha256 }, { ...pin, target },
      async () => { confirmed = true; return true; });
    assert(confirmed && approval);
    assert.notEqual(approval.decisionId, receipt.memoryScopeContinuity.decisionId);
    activateReadoptedMemoryScope(target, request, approval);
    assert.equal((await readManagedMemory(target, "memory-get", { id })).content, "Exact original fact");
    assert.deepEqual(inspectMemoryHostPin(target), pin, "Re-adoption does not rewrite provenance, receipts or source state.");
    Date.now = () => approval.expiresAtMs + 1;
    await assert.rejects(readManagedMemory(target, "memory-get", { id }), { code: "NOT_AVAILABLE" });
  } finally { Date.now = originalNow; }
});
