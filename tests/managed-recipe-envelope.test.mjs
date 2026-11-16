import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { createRequire } from "node:module";
import { chmod, cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const require = createRequire(import.meta.url);
const project = resolve(import.meta.dirname, "../legacy");
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const python = execFileSync("python3", ["-I", "-B", "-c", "import os,sys; print(os.path.realpath(sys.executable))"], { encoding: "utf8" }).trim();
async function snapshot(root) {
  const result = {};
  async function walk(directory, prefix = "") {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(join(directory, entry.name), path);
      else result[path] = hash(await readFile(join(directory, entry.name)));
    }
  }
  await walk(root);
  return result;
}

test("original ProjectStore Recipe envelope becomes audited client-readable without losing opaque bytes or authority boundaries", { timeout: 240000 }, async t => {
  const root = join(project, "../tests", `.managed-recipes-${randomUUID()}`);
  const extension = join(root, "extension"), source = join(root, "source"), parent = join(root, "parent #100% ?"), legacy = join(root, "legacy");
  const clients = [];
  t.after(async () => {
    for (const client of clients) { try { await client.close(); } catch { /* Unknown sessions are never replayed. */ } }
    if (clients.every(client => client.isStopped())) await rm(root, { recursive: true, force: true });
  });
  for (const path of [root, extension, source, parent, legacy]) await mkdir(path, { mode: 0o700 });
  await mkdir(join(source, "notes"));
  await writeFile(join(legacy, "sentinel"), "Synthetic root must remain untouched");
  await cp(join(project, "package.json"), join(extension, "package.json"));
  execFileSync(process.execPath, [require.resolve("typescript/bin/tsc"), "-p", project, "--outDir", join(extension, "dist"),
    "--sourceMap", "false"], { stdio: "pipe", timeout: 120000 });
  require("../scripts/stage-runtime.cjs").stage(join(extension, "next-runtime"), { production: true });
  const dist = join(extension, "next-runtime/server/dist");
  const { ProjectStore } = require(join(extension, "dist/workflows/project-store.js"));
  const { canonicalJson } = require(join(extension, "dist/workflows/workflow-contracts.js"));
  const { NextManagedClient } = require(join(extension, "dist/runtime/next-managed-client.js"));
  const { auditImportedWorkspace, captureImportedExperiment } = await import(join(dist, "managed-import-audit.js"));
  const { planLegacyImport, importLegacyWorkspace, recoverLegacyImportOutcome, cleanupInterruptedLegacyImportStages } =
    await import(join(dist, "legacy-import.js"));
  const store = new ProjectStore(join(source, ".pkm/state"), randomUUID, { autoMigrate: false });
  let version = store.list().storeVersion;
  const command = name => ({ commandId: name, fingerprint: `original-${name}`, expectedStoreVersion: version });
  const createdProject = store.createProject(command("project-create"), "Original Project");
  version = createdProject.snapshot.storeVersion;
  const global = store.createRecipe(command("global-recipe"), { kind: "global" }, "Global 原配方", "Guides/Nested");
  version = global.snapshot.storeVersion;
  const local = store.createRecipe(command("project-recipe"), { kind: "project", projectId: createdProject.entityId }, "Project Recipe", "Guides");
  const sourcePath = join(source, ".pkm/state/projects.json");
  const envelope = JSON.parse(await readFile(sourcePath, "utf8"));
  envelope.futureOpaqueMetadata = { preserve: ["unknown", 17, { binaryDescription: "No interpretation" }] };
  await writeFile(sourcePath, canonicalJson(envelope));
  const original = store.list(), sourceBytes = await readFile(sourcePath);
  const parityRoot = join(root, "legacy-parity");
  await cp(source, parityRoot, { recursive: true });
  const parityStore = new ProjectStore(join(parityRoot, ".pkm/state"), randomUUID);
  parityStore.list();
  const preview = parityStore.migrateLegacyRecipes("preview");
  for (const action of ["stage", "verify", "cutover"])
    parityStore.migrateLegacyRecipes(action, { sourceDigest: preview.sourceDigest });
  const migratedOriginal = parityStore.list();
  const sourceBefore = await snapshot(source), legacyBefore = await snapshot(legacy);
  const client = new NextManagedClient(); clients.push(client);
  const plan = await client.planImport(extension, parent, process.execPath, legacy, source, python);
  assert.equal(plan.ready, true, JSON.stringify(plan.blockers));
  assert.equal(plan.blockers.length, 0);
  try { assert.equal((await client.confirmImport(plan.planSha256)).outcome.status, "published"); }
  catch (error) {
    const outcome = await client.importStatus();
    assert.fail(`${error.message}; reconciled status: ${JSON.stringify(outcome)}`);
  }
  assert.equal((await client.importStatus()).outcome.status, "published");
  await client.attachImport();
  const beforeAudit = await captureImportedExperiment(plan.target);
  const approvedPlan = await planLegacyImport(source);
  const audit = await auditImportedWorkspace(plan.target, approvedPlan);
  assert.equal((await captureImportedExperiment(plan.target)).full, beforeAudit.full, "Repeated envelope audit must not change target metadata or bytes.");
  assert.equal(audit.summary.projectEnvelope, "original-bytes-control-projections-and-ordered-receipts");
  const beforeRead = await snapshot(plan.target);
  const listed = (await client.invoke("recipe-list", { limit: 1 })).result;
  assert.equal(listed.total, original.recipes.length);
  assert.equal(listed.nextOffset, 1);
  const later = (await client.invoke("recipe-list", { offset: 1, limit: 100, snapshotRevision: listed.snapshotRevision })).result;
  const all = [...listed.items, ...later.items];
  assert.deepEqual(all.map(item => item.recipeId).sort(), original.recipes.map(item => item.recipeId).sort());
  for (const recipe of migratedOriginal.recipes) {
    const got = await client.invoke("recipe-get", { id: recipe.recipeId, expectedRevision: recipe.revision,
      expectedExecutableDigest: recipe.executableDigest, snapshotRevision: listed.snapshotRevision });
    assert.equal(got.error, undefined);
    const projected = { ...got.result.item };
    for (const key of ["schema", "knowledgeId", "aliases"]) {
      if (!(key in recipe)) delete projected[key];
    }
    assert.deepEqual(projected, recipe);
    assert.equal(got.result.item.knowledgeId, `knowledge_${hash(`recipe\0${recipe.recipeId}`).slice(0, 24)}`);
    const stored = approvedPlan.projectEnvelopePlan.projectionFiles.filter(file => file.kind === "recipe")
      .map(file => JSON.parse(Buffer.from(file.base64, "base64").toString("utf8")))
      .find(record => record.recipeId === recipe.recipeId);
    assert.deepEqual(got.result.item, stored);
  }
  assert(all.some(item => item.recipeId === global.entityId));
  assert(all.some(item => item.recipeId === local.entityId));
  assert.equal((await client.invoke("recipe-list", { snapshotRevision: "0".repeat(64) })).error.code, "CONFLICT");
  assert.equal((await client.invoke("recipe-get", { id: global.entityId, expectedRevision: 999 })).error.code, "CONFLICT");
  assert.equal((await client.invoke("recipe-get", { id: global.entityId, expectedExecutableDigest: "0".repeat(64) })).error.code, "CONFLICT");
  const projectRecipes = (await client.invoke("recipe-list", { projectId: createdProject.entityId })).result;
  assert.deepEqual(projectRecipes.items.map(item => item.recipeId), [local.entityId]);
  assert.equal((await client.invoke("recipe-get", { id: "../../private" })).error.code, "INVALID_ARGUMENT");
  await assert.rejects(client.invoke("recipe-execute", {}), /read-only/);
  assert.deepEqual(await snapshot(plan.target), beforeRead);
  const marker = JSON.parse(await readFile(join(plan.target, ".pkm-next-workspace"), "utf8"));
  const db = new DatabaseSync(join(plan.target, "core.sqlite"), { readOnly: true });
  try {
    const row = db.prepare("SELECT source_bytes FROM legacy_project_envelope WHERE workspace_id=?").get(marker.id);
    assert.deepEqual(Buffer.from(row.source_bytes), sourceBytes);
    const receipts = db.prepare("SELECT command_id FROM legacy_project_receipt WHERE workspace_id=? ORDER BY ordinal").all(marker.id);
    assert.deepEqual(receipts.map(row => row.command_id), envelope.payload.receipts.map(row => row.commandId));
  } finally { db.close(); }
  await client.close();

  await t.test("corrupt projection/opaque source/history refuse audit despite published outcome", async () => {
    const recipePath = approvedPlan.entries.find(entry => entry.destination?.startsWith("recipes/")).destination;
    const path = join(plan.target, recipePath), bytes = await readFile(path);
    await writeFile(path, "{}");
    assert.equal((await recoverLegacyImportOutcome(plan.target)).status, "published");
    await assert.rejects(auditImportedWorkspace(plan.target, approvedPlan), /mismatch/);
    await writeFile(path, bytes);
    const mutate = (sql, ...args) => {
      const database = new DatabaseSync(join(plan.target, "core.sqlite"));
      try { database.prepare(sql).run(...args); } finally { database.close(); }
    };
    mutate("UPDATE legacy_project_envelope SET source_bytes=? WHERE workspace_id=?", Buffer.from("{}"), marker.id);
    await assert.rejects(auditImportedWorkspace(plan.target, approvedPlan), /failed verification/);
    mutate("UPDATE legacy_project_envelope SET source_bytes=? WHERE workspace_id=?", sourceBytes, marker.id);
    mutate("UPDATE legacy_project_receipt SET fingerprint='changed' WHERE workspace_id=? AND ordinal=0", marker.id);
    await assert.rejects(auditImportedWorkspace(plan.target, approvedPlan), /immutable source prefix/);
    mutate("UPDATE legacy_project_receipt SET fingerprint=? WHERE workspace_id=? AND ordinal=0",
      envelope.payload.receipts[0].fingerprint, marker.id);
    const control = Buffer.from(approvedPlan.projectEnvelopePlan.projectControlBase64, "base64");
    mutate("UPDATE legacy_project_control SET control_bytes=? WHERE workspace_id=?", Buffer.from("{}"), marker.id);
    await assert.rejects(auditImportedWorkspace(plan.target, approvedPlan), /control differs/);
    mutate("UPDATE legacy_project_control SET control_bytes=? WHERE workspace_id=?", control, marker.id);
    const liveDatabase = new DatabaseSync(join(plan.target, "core.sqlite"));
    try {
      liveDatabase.exec("PRAGMA journal_mode=WAL");
      liveDatabase.prepare("UPDATE legacy_project_control SET control_bytes=? WHERE workspace_id=?").run(Buffer.from("{}"), marker.id);
      const liveBefore = await captureImportedExperiment(plan.target);
      await assert.rejects(auditImportedWorkspace(plan.target, approvedPlan), /closed checkpointed/);
      assert.equal((await captureImportedExperiment(plan.target)).full, liveBefore.full);
    } finally { liveDatabase.close(); }
    mutate("UPDATE legacy_project_control SET control_bytes=? WHERE workspace_id=?", control, marker.id);
    await auditImportedWorkspace(plan.target, approvedPlan);
  });
  await t.test("unknown state, envelope drift and missing authority stay blocked", async () => {
    for (const kind of ["unknown", "trash", "corrupt", "unsupported-recipe-field"]) {
      const copy = join(root, kind);
      await cp(source, copy, { recursive: true });
      if (kind === "unknown") await writeFile(join(copy, ".pkm/state/future-journal.json"), "{}");
      else if (kind === "trash") await mkdir(join(copy, "recipes/.trash"), { recursive: true });
      else if (kind === "corrupt") await writeFile(join(copy, ".pkm/state/projects.json"), "{}");
      else {
        const unsupported = structuredClone(envelope);
        unsupported.payload.state.recipes[0].futureRecipeMetadata = { preserveNotOmit: true };
        unsupported.digest = hash(canonicalJson(unsupported.payload));
        await writeFile(join(copy, ".pkm/state/projects.json"), canonicalJson(unsupported));
      }
      const blocked = await planLegacyImport(copy);
      assert.equal(blocked.ready, false, kind);
      await assert.rejects(importLegacyWorkspace(blocked, join(root, `${kind}-target`), { pythonExecutable: python }));
    }
  });
  await t.test("explicit isolated experiment clean restart retains original Recipe projections", async () => {
    const resumedParent = join(root, "restart-parent");
    await mkdir(resumedParent, { mode: 0o700 });
    const first = new NextManagedClient(); clients.push(first);
    const restartPlan = await first.planImport(extension, resumedParent, process.execPath, legacy, source, python);
    await first.confirmImport(restartPlan.planSha256);
    await first.attachImport();
    const expected = (await first.invoke("recipe-get", { id: local.entityId })).result;
    const prepared = await first.prepareImportWrite();
    assert.deepEqual(prepared.blockers, []);
    const credential = await first.enableImportWrite(prepared.authorizationDigest, prepared.target);
    assert.deepEqual((await first.invoke("recipe-get", { id: local.entityId })).result, expected);
    await first.close();
    const restarted = new NextManagedClient(); clients.push(restarted);
    await restarted.resumeImport(extension, credential, process.execPath, legacy);
    assert.deepEqual((await restarted.invoke("recipe-get", { id: local.entityId })).result, expected);
    assert.equal((await restarted.invoke("recipe-list", {})).result.total, original.recipes.length);
    await restarted.close();
  });
  await t.test("publication death preserves source envelope in stage and conservative recovery retains outcome", async () => {
    const destination = join(root, "crash-target"), shim = join(root, "publication-death.py");
    await writeFile(shim, `#!${python}
import os, signal, sys
if len(sys.argv) >= 5 and sys.argv[-1] == ${JSON.stringify(destination)}:
    os.kill(os.getppid(), signal.SIGKILL)
    sys.exit(79)
os.execv(${JSON.stringify(python)}, [${JSON.stringify(python)}, *sys.argv[1:]])
`);
    await chmod(shim, 0o700);
    assert.throws(() => execFileSync(process.execPath, [join(dist, "cli.js"), "import", "--source", source,
      "--destination", destination, "--plan-sha256", approvedPlan.planSha256, "--python", shim,
      "--acknowledge-quiescent-disposable-copy"], { stdio: "pipe", timeout: 30000 }), error => error.signal === "SIGKILL");
    const names = (await readdir(root)).filter(name => /^\.crash-target\.pkm-legacy-import-[a-f0-9-]{36}$/.test(name));
    assert.equal(names.length, 1);
    const stage = join(root, names[0]);
    await assert.rejects(auditImportedWorkspace(stage, approvedPlan), /writer-fence marker does not match/);
    for (const entry of approvedPlan.entries.filter(entry => entry.destination && entry.kind !== "directory"))
      assert.equal(hash(await readFile(join(stage, entry.destination))), entry.sha256);
    const record = join(root, ".crash-target.pkm-legacy-import.outcome.json"), outcome = await readFile(record);
    assert.notEqual((await recoverLegacyImportOutcome(destination)).status, "published");
    assert.deepEqual(await cleanupInterruptedLegacyImportStages(destination), { removed: [stage], retained: [] });
    assert.deepEqual(await readFile(record), outcome);
  });
  assert.deepEqual(await snapshot(source), sourceBefore);
  assert.deepEqual(await snapshot(legacy), legacyBefore);
});
