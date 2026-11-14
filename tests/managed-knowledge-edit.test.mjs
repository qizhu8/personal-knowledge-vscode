import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { createRequire } from "node:module";
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const require = createRequire(import.meta.url), project = resolve(import.meta.dirname, "../legacy");
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const python = execFileSync("python3", ["-I", "-B", "-c", "import os,sys; print(os.path.realpath(sys.executable))"], { encoding: "utf8" }).trim();
async function snapshot(root) {
  const entries = {};
  async function walk(path, prefix = "") {
    for (const entry of (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : 1)) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(join(path, entry.name), rel);
      else entries[rel] = hash(await readFile(join(path, entry.name)));
    }
  }
  await walk(root);
  return entries;
}

test("original Notes/Skills/Research become editable only in an authorized experiment using native CAS and durable receipts", { timeout: 240000 }, async t => {
  const root = join(project, "../tests", `.managed-knowledge-edit-${randomUUID()}`);
  const extension = join(root, "extension"), source = join(root, "source"), parent = join(root, "parent"), legacy = join(root, "legacy");
  const clients = [];
  t.after(async () => {
    for (const client of clients) { try { await client.close(); } catch { /* Unknown sessions do not manufacture clean checkpoints. */ } }
    if (clients.every(client => client.isStopped())) await rm(root, { recursive: true, force: true });
  });
  for (const path of [root, extension, source, parent, legacy]) await mkdir(path, { mode: 0o700 });
  await writeFile(join(legacy, "sentinel"), "Synthetic legacy root");
  await cp(join(project, "package.json"), join(extension, "package.json"));
  try {
    execFileSync(process.execPath, [require.resolve("typescript/bin/tsc"), "-p", project, "--outDir", join(extension, "dist"), "--sourceMap", "false"],
      { stdio: "pipe", timeout: 120000 });
  } catch (error) { throw new Error(`${error.message}\n${error.stdout || ""}\n${error.stderr || ""}`); }
  require(join(project, "scripts/next-rehearsal-runtime.js")).stage(join(extension, "next-runtime"), { production: true });
  const { NextManagedClient } = require(join(extension, "dist/runtime/next-managed-client.js"));
  const dist = join(extension, "next-runtime/server/dist");
  await t.test("nonempty executable package/catalog roots are planned only as inert archive bytes", async () => {
    const { planLegacyImport } = await import(join(dist, "legacy-import.js"));
    for (const area of ["packages", "actions", "components"]) {
      const copy = join(root, `unsupported-${area}`); await mkdir(join(copy, "notes"), { recursive: true });
      await mkdir(join(copy, area, "Example"), { recursive: true });
      await writeFile(join(copy, area, "Example", "original.py"), "raise RuntimeError('Never execute an unapproved migration fixture')\n");
      const plan = await planLegacyImport(copy);
      assert.equal(plan.ready, true, JSON.stringify(plan.blockers));
      assert(plan.preflight.entries.some(entry => entry.path === `${area}/Example/original.py` && entry.size > 0));
      assert.equal(plan.entries.find(entry => entry.source === `${area}/Example/original.py`).destination,
        `legacy-code-archive/${area}/Example/original.py`);
    }
  });
  await t.test("lossless native updates preserve JSON-style flow frontmatter and reject commented flow maps before effects", async () => {
    const { planKnowledgeMutation, applyKnowledgeMutation } = await import(join(dist, "knowledge-mutations.js"));
    const { readMutationScan } = await import(join(dist, "mutation-scan.js"));
    const flowRoot = join(root, "flow"); await mkdir(join(flowRoot, "notes"), { recursive: true });
    const path = join(flowRoot, "notes/Flow.md");
    const raw = '---\n{"title":"Flow","opaque":{"key":[1,2]}}\n---\nOriginal body\r\n';
    await writeFile(path, raw);
    const scan = readMutationScan(flowRoot), item = scan.documents[0];
    const request = { operation: "knowledge.note.update", actorId: "test:lossless-flow",
      args: { operationId: randomUUID(), id: item.id, expectedScanRevision: scan.scanRevision, expectedRevision: item.revision,
        expectedSha256: item.sha256, preserveIdentity: true, title: "Flow", description: "Added field", content: "Updated body\r\n" } };
    const planned = planKnowledgeMutation(flowRoot, request);
    applyKnowledgeMutation(flowRoot, planned, request.args.operationId);
    const result = await readFile(path, "utf8");
    assert.match(result, /"opaque":\{"key":\[1,2\]\}/);
    assert.match(result, /^---\n\{/); assert.match(result, /Updated body\r\n$/);
    const commented = '---\n{title: Flow, opaque: keep # preserve comment\n}\n---\nBody\n';
    await writeFile(path, commented);
    const updated = readMutationScan(flowRoot), current = updated.documents[0];
    assert.throws(() => planKnowledgeMutation(flowRoot, { ...request, args: { ...request.args, operationId: randomUUID(),
      id: current.id, expectedScanRevision: updated.scanRevision, expectedRevision: current.revision, expectedSha256: current.sha256 } }),
    error => error.code === "UNSUPPORTED_OPERATION");
    assert.equal(await readFile(path, "utf8"), commented);
  });
  const original = require(join(extension, "dist/knowledge/filestore.js"));
  original.setStorePath(source);
  original.noteUpsert({ slug: "", title: "Original Note", type: "journal", tags: ["legacy"], category: "Team", content: "Note original\r\n" });
  original.skillUpsert({ name: "Original Skill", category: "Team", content: "Skill original\r\n", description: "Preserved skill",
    tags: ["legacy"], source_project: "original-project", recipe_required: true, recipe_hint: "Keep original", related_skills: ["Other"], priority: "highest" });
  original.paperUpsert({ slug: "", title: "Original Research", category: "Team", content: "Research original\r\n",
    authors: ["Original Author"], year: 2020, topic: "Migration", conclusions: ["Keep complete"], assumptions: ["No production root"] });
  const paths = { notes: "Team/Original Note.md", skills: "Team/Original Skill.md", papers: "Team/Original Research.md" };
  // Resolve writer-safe file names rather than assuming display titles are paths.
  for (const area of Object.keys(paths)) {
    const names = await readdir(join(source, area, "Team"));
    paths[area] = `Team/${names.find(name => name.endsWith(".md"))}`;
    const path = join(source, area, paths[area]), raw = await readFile(path, "utf8");
    await writeFile(path, raw.replace("---\n", "---\n# Keep this exact comment\nopaqueFuture:\n  keep: [original, 17] # keep opaque\n"));
    const assets = join(source, area, paths[area].replace(/\.md$/, ".assets"));
    await mkdir(assets);
    await writeFile(join(assets, "raw.bin"), Buffer.from([0, 255, 128, 10]));
  }
  const beforeSource = await snapshot(source), beforeLegacy = await snapshot(legacy);
  const client = new NextManagedClient(); clients.push(client);
  const plan = await client.planImport(extension, parent, process.execPath, legacy, source, python);
  assert.equal(plan.ready, true, JSON.stringify(plan.blockers));
  await client.confirmImport(plan.planSha256); await client.attachImport();
  const beforeRead = await snapshot(plan.target);
  const scanResponse = await client.invoke("mutation-scan", {});
  assert.equal(scanResponse.error, undefined, JSON.stringify(scanResponse));
  const scan = scanResponse.result;
  assert.equal(scan.documents.length, 3);
  await assert.rejects(client.invoke("skill-update", {}), /read-only/);
  assert.deepEqual(await snapshot(plan.target), beforeRead);
  const prepared = await client.prepareImportWrite();
  const credential = await client.enableImportWrite(prepared.authorizationDigest, prepared.target);
  const updates = [], committed = [];
  for (const [area, operation] of [["notes", "note-update"], ["skills", "skill-update"], ["papers", "research-update"]]) {
    const current = (await client.invoke("mutation-scan", {})).result;
    const item = current.documents.find(item => item.area === area);
    const metadataBefore = (await client.invoke("metadata-get", { id: item.id })).result;
    const args = { operationId: randomUUID(), id: item.id, expectedScanRevision: current.scanRevision,
      expectedRevision: item.revision, expectedSha256: item.sha256, content: `${area}: edited complete body\r\n`, preserveIdentity: true };
    const response = await client.invoke(operation, args);
    assert.equal(response.error, undefined, JSON.stringify(response));
    const receipt = response.result;
    assert.equal(receipt.id, item.id); assert.equal(receipt.knowledgeId, item.knowledgeId);
    assert.equal(receipt.revision, item.revision + 1); assert.equal(receipt.area, area);
    const after = await client.invoke("get", { id: receipt.id });
    assert.equal(after.result.content, args.content);
    assert.equal(after.result.sha256, receipt.sha256);
    const raw = await readFile(join(plan.target, area, receipt.path), "utf8");
    assert.match(raw, /# Keep this exact comment/); assert.match(raw, /opaqueFuture:\n  keep: \[original, 17\] # keep opaque/);
    const asset = `${area}/${receipt.path.replace(/\.md$/, ".assets")}/raw.bin`;
    assert.equal(hash(await readFile(join(plan.target, asset))), beforeSource[asset]);
    const metadataAfter = (await client.invoke("metadata-get", { id: receipt.id })).result;
    for (const field of ["aliases", "source_project", "recipe_required", "recipe_hint", "priority", "authors", "conclusions", "assumptions"])
      assert.deepEqual(metadataAfter.metadata?.[field], metadataBefore.metadata?.[field], field);
    const replay = await client.invoke(operation, args);
    assert.deepEqual(replay.result, receipt);
    const changedRequest = await client.invoke(operation, { ...args, content: "Do not replace" });
    assert.equal(changedRequest.error.code, "CONFLICT");
    const stale = await client.invoke(operation, { ...args, operationId: randomUUID() });
    assert.equal(stale.error.code, "CONFLICT");
    const noMove = await client.invoke(operation, { ...args, operationId: randomUUID(), moveTo: "Moved.md" });
    assert.equal(noMove.error.code, "INVALID_ARGUMENT");
    updates.push({ operation, args, receipt }); committed.push(receipt);
  }
  for (const [operation, area, fields] of [
    ["note-create", "notes", { title: "Created Note", type: "journal", tags: ["new"], pinned: true }],
    ["skill-create", "skills", { name: "Created Skill", recipe_required: true, recipe_hint: "Explicit", priority: "high", related_skills: [] }],
    ["research-create", "papers", { title: "Created Research", authors: ["New Author"], year: "2026", kind: "idea", conclusions: ["New complete record"] }],
  ]) {
    const current = (await client.invoke("mutation-scan", {})).result;
    const args = { operationId: randomUUID(), expectedScanRevision: current.scanRevision, category: "Created", content: "Created full body\n", ...fields };
    const response = await client.invoke(operation, args);
    assert.equal(response.error, undefined, JSON.stringify(response)); assert.equal(response.result.area, area);
    assert.equal((await client.invoke("get", { id: response.result.id })).result.content, args.content);
    const conflict = await client.invoke(operation, { ...args, operationId: randomUUID(),
      expectedScanRevision: (await client.invoke("mutation-scan", {})).result.scanRevision });
    assert.equal(conflict.error.code, "CONFLICT");
    committed.push(response.result);
  }
  await client.close();
  const database = new DatabaseSync(":memory:");
  try {
    database.prepare("ATTACH DATABASE ? AS imported").run(`${pathToFileURL(join(plan.target, "core.sqlite")).href}?mode=ro&immutable=1`);
    assert.equal(database.prepare("SELECT COUNT(*) AS n FROM migration_runtime_intents").get().n, 0);
    for (const receipt of committed) {
      const row = database.prepare("SELECT operation,actor_id,result FROM receipts WHERE operation_id=?").get(receipt.operationId);
      assert(row.actor_id.startsWith("experiment:")); assert.deepEqual(JSON.parse(row.result), receipt);
    }
  } finally { database.close(); }
  const restarted = new NextManagedClient(); clients.push(restarted);
  await restarted.resumeImport(extension, credential, process.execPath, legacy);
  assert.equal((await restarted.invoke("mutation-scan", {})).result.documents.length, 6);
  for (const update of updates) {
    assert.equal((await restarted.invoke("get", { id: update.receipt.id })).result.sha256, update.receipt.sha256);
    assert.deepEqual((await restarted.invoke(update.operation, update.args)).result, update.receipt);
  }
  await restarted.close();
  await t.test("a crashed authorized writer cannot be reopened or have its effects automatically replayed", async () => {
    const crashParent = join(root, "crash-parent"); await mkdir(crashParent, { mode: 0o700 });
    const crashed = new NextManagedClient(); clients.push(crashed);
    const crashPlan = await crashed.planImport(extension, crashParent, process.execPath, legacy, source, python);
    await crashed.confirmImport(crashPlan.planSha256); await crashed.attachImport();
    const approval = await crashed.prepareImportWrite();
    const crashCredential = await crashed.enableImportWrite(approval.authorizationDigest, approval.target);
    const current = (await crashed.invoke("mutation-scan", {})).result;
    const args = { operationId: randomUUID(), expectedScanRevision: current.scanRevision, title: "Before crash", content: "Committed once" };
    const committed = await crashed.invoke("note-create", args);
    assert.equal(committed.error, undefined, JSON.stringify(committed));
    const pid = crashed.child.pid;
    const stopped = new Promise(resolve => crashed.child.once("exit", resolve));
    process.kill(pid, "SIGKILL"); await stopped;
    const rejected = new NextManagedClient(); clients.push(rejected);
    await assert.rejects(rejected.resumeImport(extension, crashCredential, process.execPath, legacy), /unclean sessions/);
    assert.equal(JSON.parse(await readFile(join(crashParent, ".pkm-isolated-experiment.json"), "utf8")).state, "active");
    const raw = await readFile(join(crashPlan.target, "notes", committed.result.path), "utf8");
    assert.match(raw, /Committed once/);
  });
  assert.deepEqual(await snapshot(source), beforeSource); assert.deepEqual(await snapshot(legacy), beforeLegacy);
});
