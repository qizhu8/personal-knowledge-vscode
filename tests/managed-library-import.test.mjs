import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { createRequire } from "node:module";
import { chmod, cp, lstat, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { createOriginalLibraryFixture } from "./library-original-fixture.mjs";
import { nativeRestoreAuthority } from "./host-composition-legacy-batch16-restore-fixture.mjs";

const require = createRequire(import.meta.url), project = resolve(import.meta.dirname, "../legacy");
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const python = execFileSync("python3", ["-I", "-B", "-c", "import os,sys; print(os.path.realpath(sys.executable))"], { encoding: "utf8" }).trim();
async function snapshot(root) {
  const entries = {};
  async function walk(path, prefix = "") {
    for (const entry of (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : 1)) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name, full = join(path, entry.name), stat = await lstat(full);
      entries[rel] = { mode: stat.mode & 0o777, digest: entry.isDirectory() ? null : hash(await readFile(full)) };
      if (entry.isDirectory()) await walk(full, rel);
    }
  }
  await walk(root);
  return entries;
}

test("original Prompt history and moved Script identity remain preserved, audited and client-readable without execution", { timeout: 240000 }, async t => {
  const root = join(project, "../tests", `.managed-library-${randomUUID()}`);
  const extension = join(root, "extension"), source = join(root, "source"), parent = join(root, "parent"), legacy = join(root, "legacy");
  const clients = [];
  t.after(async () => {
    for (const client of clients) { try { await client.close(); } catch { /* Unknown sessions are never replayed. */ } }
    if (clients.every(client => client.isStopped())) await rm(root, { recursive: true, force: true });
  });
  for (const path of [root, extension, source, parent, legacy]) await mkdir(path, { mode: 0o700 });
  await writeFile(join(legacy, "sentinel"), "Never access an actual legacy root.");
  await cp(join(project, "package.json"), join(extension, "package.json"));
  try {
    execFileSync(process.execPath, [require.resolve("typescript/bin/tsc"), "-p", project, "--outDir", join(extension, "dist"), "--sourceMap", "false"],
      { stdio: "pipe", timeout: 120000 });
  } catch (error) { throw new Error(`${error.message}\n${error.stdout || ""}\n${error.stderr || ""}`); }
  require(join(project, "scripts/next-rehearsal-runtime.js")).stage(join(extension, "next-runtime"), { production: true });
  const dist = join(extension, "next-runtime/server/dist");
  const original = require(join(extension, "dist/knowledge/storage.js"));
  const fixture = await createOriginalLibraryFixture(source, original);
  const beforeSource = await snapshot(source), beforeLegacy = await snapshot(legacy);
  const { NextManagedClient } = require(join(extension, "dist/runtime/next-managed-client.js"));
  const { planLegacyImport, importLegacyWorkspace, recoverLegacyImportOutcome, cleanupInterruptedLegacyImportStages } = await import(join(dist, "legacy-import.js"));
  const { auditImportedWorkspace, captureImportedExperiment } = await import(join(dist, "managed-import-audit.js"));
  const { readLibrary } = await import(join(dist, "library-reads.js"));
  const { Storage, validateWorkspace } = await import(join(dist, "storage.js"));
  const { createWorkspaceBackup, restoreWorkspaceBackup } = await import(join(dist, "workspace-backup.js"));
  const client = new NextManagedClient(); clients.push(client);
  const plan = await client.planImport(extension, parent, process.execPath, legacy, source, python);
  assert.equal(plan.ready, true, JSON.stringify(plan.blockers));
  const approvedPlan = await planLegacyImport(source);
  assert.deepEqual(approvedPlan.entries.filter(entry => entry.source.startsWith(".pkm")).map(entry => [entry.source, entry.destination]),
    [[".pkm", "legacy-import-evidence/.pkm"], [".pkm/state", "legacy-import-evidence/.pkm/state"]]);
  await client.confirmImport(plan.planSha256);
  assert.equal((await client.importStatus()).outcome.status, "published");
  await client.attachImport();
  await assert.rejects(lstat(join(plan.target, ".pkm")), { code: "ENOENT" });
  const beforeTarget = await captureImportedExperiment(plan.target);
  async function list(active, area) {
    let offset = 0, snapshotRevision, items = [];
    do {
      const page = await active.invoke("library-list", { area, offset, limit: 3, ...(snapshotRevision ? { snapshotRevision } : {}) });
      assert.equal(page.error, undefined);
      snapshotRevision ??= page.result.snapshotRevision;
      assert.equal(page.result.snapshotRevision, snapshotRevision);
      items.push(...page.result.items); offset = page.result.nextOffset;
      if (offset === null) assert.equal(items.length, page.result.total);
    } while (offset !== null);
    return { items, snapshotRevision };
  }
  async function read(active, entry, snapshotRevision) {
    const bytes = [], resultChunks = [];
    let offset = 0;
    do {
      const response = await active.invoke("library-get", { area: entry.area, path: entry.path, expectedDigest: entry.sha256, snapshotRevision, offset });
      assert.equal(response.error, undefined, JSON.stringify(response));
      const chunk = response.result;
      assert.deepEqual(chunk.item, entry); assert.equal(chunk.snapshotRevision, snapshotRevision);
      assert.equal(chunk.offset, offset);
      assert.equal(chunk.encoding, "base64");
      const decoded = Buffer.from(chunk.data, "base64");
      assert.equal(decoded.toString("base64"), chunk.data);
      assert.equal(decoded.length, Math.min(65536, entry.size - offset));
      bytes.push(decoded); resultChunks.push(chunk); offset = chunk.nextOffset;
    } while (offset !== null);
    const raw = Buffer.concat(bytes);
    assert.equal(raw.length, entry.size); assert.equal(hash(raw), entry.sha256);
    assert.deepEqual(raw, await readFile(join(source, entry.path)));
    return resultChunks;
  }
  async function check(active) {
    const prompts = await list(active, "prompts"), scripts = await list(active, "scripts");
    const expectedPaths = Object.keys(beforeSource).filter(path => /^(prompts|scripts)\//.test(path));
    assert.deepEqual([...prompts.items, ...scripts.items].map(entry => entry.path).sort(), expectedPaths.sort());
    for (const [area, listing] of [["prompts", prompts], ["scripts", scripts]]) {
      for (const entry of listing.items) {
        assert.equal(entry.area, area);
        assert.equal(entry.mode, entry.kind === "directory" ? 0o700 : beforeSource[entry.path].mode);
        if (entry.kind === "file") await read(active, entry, listing.snapshotRevision);
      }
    }
    const prompt = prompts.items.find(entry => entry.path === "prompts/Ads/Accuracy/v9.1/prompt.jinja2");
    const promptRead = (await read(active, prompt, prompts.snapshotRevision))[0];
    assert.deepEqual(promptRead.legacy, fixture.prompt);
    const history = [];
    for (const version of ["v10", "v9", "v9.1"]) {
      const entry = prompts.items.find(item => item.prompt?.version === version && item.prompt.file === "prompt.jinja2");
      const got = (await read(active, entry, prompts.snapshotRevision))[0].legacy;
      history.push({ version, content: got.content.replace(/^\n/, "") });
    }
    assert.deepEqual(history, fixture.versions);
    const moved = scripts.items.find(entry => entry.path === "scripts/Archive/check.script");
    assert.equal(moved.identityStatus, "preserved");
    assert.deepEqual(moved.scriptIdentity, fixture.sidecar);
    assert.deepEqual((await read(active, moved, scripts.snapshotRevision))[0].legacy, fixture.script);
    assert(moved.scriptIdentity.aliases.includes(`pkm://script/${fixture.beforeMove.knowledgeId}`));
    assert(moved.scriptIdentity.aliases.includes("pkm://scripts/Tools/check.script"));
    const unassigned = scripts.items.find(entry => entry.path === "scripts/run.sh");
    assert.equal(unassigned.identityStatus, "unassigned");
    assert.equal(unassigned.scriptIdentity, null);
    assert.equal((await read(active, unassigned, scripts.snapshotRevision))[0].legacy.knowledgeId, null);
    const binary = scripts.items.find(entry => entry.path === "scripts/binary.bin");
    const chunks = await read(active, binary, scripts.snapshotRevision);
    assert.equal(chunks.length, 2); assert.equal(chunks[0].textStatus, "chunked"); assert.equal(chunks[0].legacy, null);
    assert.equal((await active.invoke("library-list", { area: "prompts", snapshotRevision: "0".repeat(64) })).error.code, "CONFLICT");
    const pins = { area: moved.area, path: moved.path, expectedDigest: moved.sha256, snapshotRevision: scripts.snapshotRevision };
    assert.equal((await active.invoke("library-get", { ...pins, expectedDigest: "0".repeat(64) })).error.code, "CONFLICT");
    assert.equal((await active.invoke("library-get", { ...pins, path: "scripts/../../private" })).error.code, "INVALID_ARGUMENT");
    assert.equal((await active.invoke("library-get", { ...pins, area: "prompts" })).error.code, "NOT_FOUND");
    assert.equal((await active.invoke("library-get", { ...pins, length: 65537 })).error.code, "INVALID_ARGUMENT");
    assert.equal((await active.invoke("library-get", { ...pins, offset: moved.size + 1 })).error.code, "INVALID_ARGUMENT");
    assert.equal((await active.invoke("library-get", { ...pins, path: "scripts/.pending.json" })).error.code, "INVALID_ARGUMENT");
  }
  await check(client);
  assert.equal((await captureImportedExperiment(plan.target)).full, beforeTarget.full, "Library reads must not write sidecars, target bytes or metadata.");
  await assert.rejects(client.invoke("script-execute", {}), /read-only/);
  const preparation = await client.prepareImportWrite();
  const credential = await client.enableImportWrite(preparation.authorizationDigest, preparation.target);
  await check(client);
  await client.close();
  const resumed = new NextManagedClient(); clients.push(resumed);
  await resumed.resumeImport(extension, credential, process.execPath, legacy);
  await check(resumed);
  await resumed.close();
  assert.deepEqual(await snapshot(source), beforeSource);
  assert.deepEqual(await snapshot(legacy), beforeLegacy);
  await t.test("native backup/restore preserves library files, executable modes and inert empty shell evidence", async () => {
    const target = join(root, "backup-target"), backup = join(root, "backup"), restored = join(root, "restored");
    await importLegacyWorkspace(approvedPlan, target, { pythonExecutable: python });
    const storage = await Storage.open(target);
    try {
      await createWorkspaceBackup(storage, backup, { acquireQuiescence: async () => ({ assertHeld() {}, release() {} }) });
    } finally { await storage.close(); }
    assert.equal((await lstat(join(backup, "scripts/run.sh"))).mode & 0o777, 0o600);
    await restoreWorkspaceBackup(backup, restored, { nativeRestoreAuthority, pythonExecutable: python });
    await validateWorkspace(restored);
    await assert.rejects(lstat(join(restored, ".pkm")), { code: "ENOENT" });
    assert((await lstat(join(restored, "legacy-import-evidence/.pkm/state"))).isDirectory());
    const restoredSnapshot = await snapshot(restored);
    for (const [path, entry] of Object.entries(beforeSource).filter(([path]) => /^(prompts|scripts)\//.test(path))) {
      assert.equal(restoredSnapshot[path].digest, entry.digest, path);
      assert.equal(restoredSnapshot[path].mode, entry.digest === null ? 0o700 : entry.mode, path);
    }
    original.setStorePath(restored);
    assert.deepEqual(original.promptList(), fixture.promptList);
    assert.deepEqual(original.promptGetFile("Ads", "Accuracy", "v9.1", "prompt.jinja2"), fixture.prompt);
    assert.deepEqual(original.promptGetAllVersionsOfFile("Ads", "Accuracy", "prompt.jinja2"), fixture.versions);
    assert.deepEqual(original.scriptGet("pkm://scripts/Tools/check.script"), fixture.script);
    const listing = readLibrary(restored, { operation: "knowledge.library.list", args: { area: "scripts", offset: 0, limit: 100 } });
    assert.equal(listing.items.find(item => item.path === "scripts/Archive/check.script").scriptIdentity.knowledgeId, fixture.script.knowledgeId);
  });
  await t.test("unknown lock-shell descendants stay blocked and changed libraries permanently invalidate the reader", async () => {
    for (const name of ["markdown-assets.lock", "future-history.json"]) {
      const copy = join(root, `lock-${name}`); await cp(source, copy, { recursive: true });
      await writeFile(join(copy, ".pkm/state", name), "{}");
      const blocked = await planLegacyImport(copy);
      assert.equal(blocked.ready, false, name);
      await assert.rejects(importLegacyWorkspace(blocked, join(root, `blocked-${name}`), { pythonExecutable: python }));
    }
    const changedParent = join(root, "changed-parent"); await mkdir(changedParent, { mode: 0o700 });
    const changed = new NextManagedClient(); clients.push(changed);
    const changedPlan = await changed.planImport(extension, changedParent, process.execPath, legacy, source, python);
    await changed.confirmImport(changedPlan.planSha256); await changed.attachImport();
    const listing = await list(changed, "scripts"), entry = listing.items.find(item => item.path === "scripts/Archive/check.script");
    const sidecar = join(changedPlan.target, "scripts/Archive/.check.script.pkm.json"), bytes = await readFile(sidecar);
    await writeFile(sidecar, JSON.stringify({ ...fixture.sidecar, aliases: [] }));
    await assert.rejects(changed.invoke("library-get", { area: "scripts", path: entry.path, expectedDigest: entry.sha256,
      snapshotRevision: listing.snapshotRevision }), /outcome unknown/);
    await writeFile(sidecar, bytes);
    await assert.rejects(changed.invoke("library-list", { area: "scripts" }), /previously failed/);
    await changed.close();
  });
  await t.test("ambiguous path lineage, malformed metadata, hidden state and symlinks block before publishing", async () => {
    for (const variant of ["alias-current-path", "orphan", "malformed", "oversize", "hidden-history", "trash", "symlink"]) {
      const copy = join(root, variant); await cp(source, copy, { recursive: true });
      if (variant === "alias-current-path") {
        const path = join(copy, "scripts/Archive/.check.script.pkm.json");
        await writeFile(path, JSON.stringify({ ...fixture.sidecar, aliases: [...fixture.sidecar.aliases, "pkm://scripts/run.sh"] }));
      } else if (variant === "orphan") await rm(join(copy, "scripts/Archive/check.script"));
      else if (variant === "malformed") await writeFile(join(copy, "scripts/Archive/.check.script.pkm.json"), "{}");
      else if (variant === "oversize") await writeFile(join(copy, "scripts/Archive/.check.script.pkm.json"), JSON.stringify({ ...fixture.sidecar, large: "x".repeat(65536) }));
      else if (variant === "symlink") await symlink(join(copy, "scripts/run.sh"), join(copy, "scripts/link.sh"));
      else {
        await mkdir(join(copy, "scripts", variant === "trash" ? ".trash" : ".history"));
        await writeFile(join(copy, "scripts", variant === "trash" ? ".trash" : ".history", "raw"), "Do not omit.");
      }
      const blocked = await planLegacyImport(copy);
      assert.equal(blocked.ready, false, variant);
      await assert.rejects(importLegacyWorkspace(blocked, join(root, `${variant}-destination`), { pythonExecutable: python }));
      assert.throws(() => readLibrary(copy, { operation: "knowledge.library.list", args: { area: "scripts", offset: 0, limit: 20 } }));
    }
  });
  await t.test("publication death retains exact library bytes; conservative cleanup preserves unknown outcome", async () => {
    const destination = join(root, "crash-target"), shim = join(root, "publication-death.py");
    await writeFile(shim, `#!${python}\nimport os, signal, sys\nif len(sys.argv) >= 5 and sys.argv[-1] == ${JSON.stringify(destination)}:\n os.kill(os.getppid(), signal.SIGKILL)\n sys.exit(79)\nos.execv(${JSON.stringify(python)}, [${JSON.stringify(python)}, *sys.argv[1:]])\n`);
    await chmod(shim, 0o700);
    assert.throws(() => execFileSync(process.execPath, [join(dist, "cli.js"), "import", "--source", source,
      "--destination", destination, "--plan-sha256", approvedPlan.planSha256, "--python", shim,
      "--acknowledge-quiescent-disposable-copy"], { stdio: "pipe", timeout: 30000 }), error => error.signal === "SIGKILL");
    const names = (await readdir(root)).filter(name => /^\.crash-target\.pkm-legacy-import-[a-f0-9-]{36}$/.test(name));
    assert.equal(names.length, 1);
    const stage = join(root, names[0]); await auditImportedWorkspace(stage, approvedPlan);
    const outcomePath = join(root, ".crash-target.pkm-legacy-import.outcome.json"), outcome = await readFile(outcomePath);
    assert.notEqual((await recoverLegacyImportOutcome(destination)).status, "published");
    assert.deepEqual(await cleanupInterruptedLegacyImportStages(destination), { removed: [stage], retained: [] });
    assert.deepEqual(await readFile(outcomePath), outcome);
  });
  assert.deepEqual(await snapshot(source), beforeSource);
  assert.deepEqual(await snapshot(legacy), beforeLegacy);
});
