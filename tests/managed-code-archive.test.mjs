import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { chmod, cp, link, lstat, mkdir, readFile, readdir, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { nativeRestoreAuthority } from "./host-composition-legacy-batch16-restore-fixture.mjs";

const require = createRequire(import.meta.url), project = resolve(import.meta.dirname, "../legacy");
const areas = ["packages", "actions", "components", "action-module-sets"];
const hash = value => createHash("sha256").update(value).digest("hex");
const python = execFileSync("python3", ["-I", "-B", "-c", "import os,sys; print(os.path.realpath(sys.executable))"], { encoding: "utf8" }).trim();
async function snapshot(root) {
  const entries = {};
  async function walk(prefix) {
    for (const name of (await readdir(join(root, prefix))).sort()) {
      const path = prefix ? `${prefix}/${name}` : name, stat = await lstat(join(root, path));
      entries[path] = { mode: stat.mode & 0o777, sha256: stat.isDirectory() ? null : hash(await readFile(join(root, path))) };
      if (stat.isDirectory()) await walk(path);
    }
  }
  await walk("");
  return entries;
}

test("inert code libraries preserve all bytes and ordinary modes without loading code or granting authority", { timeout: 240000 }, async t => {
  const root = join(project, "../tests", `.managed-code-archive-${randomUUID()}`);
  const extension = join(root, "extension"), source = join(root, "source"), legacy = join(root, "unrelated-legacy"), parent = join(root, "parent");
  const clients = [];
  t.after(async () => {
    for (const client of clients) { try { await client.close(); } catch { /* No unknown call is replayed. */ } }
    if (clients.every(client => client.isStopped())) await rm(root, { recursive: true, force: true });
  });
  for (const directory of [root, extension, source, legacy, parent]) await mkdir(directory, { mode: 0o700 });
  await mkdir(join(source, "notes"));
  await writeFile(join(legacy, "sentinel"), "Unrelated synthetic data must remain unchanged.");
  for (const area of areas) {
    await mkdir(join(source, area, "Example", ".hidden", "empty"), { recursive: true, mode: 0o750 });
    await writeFile(join(source, area, "Example", "manifest.json"), '{"name":"Example","unknown":{"preserve":true},"grants":["NOT AUTHORITY"]}\r\n');
    await writeFile(join(source, area, "Example", "definition.yaml"), "name: Example\nunknown: [opaque, original]\n");
    await writeFile(join(source, area, "Example", "original.py"), "raise RuntimeError('Migration must never load or run this module')\n");
    await chmod(join(source, area, "Example", "original.py"), 0o751);
    await writeFile(join(source, area, "Example", ".hidden", "raw.bin"), Buffer.from(Array.from({ length: 70013 }, (_, index) => index % 256)));
    await writeFile(join(source, area, "Example", ".hidden", ".opaque"), Buffer.from([255, 0, 13, 10]));
    await writeFile(join(source, area, "Example", "empty"), Buffer.alloc(0));
    await chmod(join(source, area), 0o755);
    await chmod(join(source, area, "Example"), 0o750);
    await chmod(join(source, area, "Example", ".hidden"), 0o710);
  }
  const before = await snapshot(source), legacyBefore = await snapshot(legacy);
  await cp(join(project, "package.json"), join(extension, "package.json"));
  try {
    execFileSync(process.execPath, [require.resolve("typescript/bin/tsc"), "-p", project, "--outDir", join(extension, "dist"), "--sourceMap", "false"],
      { stdio: "pipe", timeout: 120000 });
  } catch (error) { throw new Error(`${error.message}\n${error.stdout || ""}\n${error.stderr || ""}`); }
  require("../scripts/stage-runtime.cjs").stage(join(extension, "next-runtime"), { production: true });
  const dist = join(extension, "next-runtime/server/dist");
  const { NextManagedClient } = require(join(extension, "dist/runtime/next-managed-client.js"));
  const { planLegacyImport, importLegacyWorkspace, recoverLegacyImportOutcome, cleanupInterruptedLegacyImportStages } = await import(join(dist, "legacy-import.js"));
  const { auditImportedWorkspace, captureImportedExperiment } = await import(join(dist, "managed-import-audit.js"));
  const { readLibrary } = await import(join(dist, "library-reads.js"));
  const { Storage, validateWorkspace } = await import(join(dist, "storage.js"));
  const { createWorkspaceBackup, restoreWorkspaceBackup } = await import(join(dist, "workspace-backup.js"));
  const approved = await planLegacyImport(source);
  assert.equal(approved.ready, true, JSON.stringify(approved.blockers));
  assert.equal(approved.entries.length, Object.keys(before).length);
  for (const entry of approved.entries) {
    if (entry.source === "notes") continue;
    assert.equal(entry.destination, `legacy-code-archive/${entry.source}`);
    assert.equal(entry.mode, before[entry.source].mode);
    if (entry.kind === "asset") assert.equal(entry.sha256, before[entry.source].sha256);
  }
  const client = new NextManagedClient(); clients.push(client);
  const planned = await client.planImport(extension, parent, process.execPath, legacy, source, python);
  assert.equal(planned.ready, true, JSON.stringify(planned.blockers));
  await client.confirmImport(planned.planSha256);
  const status = await client.importStatus();
  assert.equal(status.outcome.status, "published");
  const receipt = status.outcome.receipt;
  assert.equal(receipt.assets.length, Object.values(before).filter(entry => entry.sha256 !== null).length);
  assert.deepEqual(receipt.archivedDirectories.map(entry => [entry.path, entry.mode]),
    approved.entries.filter(entry => entry.kind === "directory" && entry.source !== "notes").map(entry => [entry.destination, entry.mode]));
  await t.test("large bounded outcome records remain recoverable", async () => {
    const outcomeFile = join(parent, ".workspace.pkm-legacy-import.outcome.json");
    const original = await readFile(outcomeFile);
    try {
      await writeFile(outcomeFile, Buffer.concat([original, Buffer.alloc(1024 * 1024, 0x20)]));
      const recovered = await recoverLegacyImportOutcome(planned.target);
      assert.equal(recovered.status, "published");
      assert.deepEqual(recovered.receipt, receipt);
    } finally { await writeFile(outcomeFile, original); }
  });
  function assertNoActionAdmission(target = planned.target) {
    const database = new DatabaseSync(":memory:");
    try {
      database.prepare("ATTACH DATABASE ? AS imported").run(`${pathToFileURL(join(target, "core.sqlite")).href}?mode=ro&immutable=1`);
      for (const table of ["legacy_action_catalog_admissions", "legacy_action_artifact_grants", "legacy_action_catalog_events"]) {
        if (database.prepare("SELECT 1 FROM imported.sqlite_master WHERE type='table' AND name=?").get(table))
          assert.equal(database.prepare(`SELECT count(*) AS count FROM imported.${table}`).get().count, 0, table);
      }
    } finally { database.close(); }
  }
  assertNoActionAdmission();
  await client.attachImport();
  const targetBefore = await captureImportedExperiment(planned.target);
  for (const area of areas) await assert.rejects(lstat(join(planned.target, area)), { code: "ENOENT" });
  assert.equal((await lstat(join(planned.target, "legacy-code-archive"))).mode & 0o777, 0o700);
  async function verify(active) {
    for (const area of areas) {
      const items = [];
      let offset = 0, revision;
      do {
        const page = await active.invoke("library-list", { area, offset, limit: 2, ...(revision ? { snapshotRevision: revision } : {}) });
        assert.equal(page.error, undefined, JSON.stringify(page));
        revision ??= page.result.snapshotRevision;
        assert.equal(page.result.snapshotRevision, revision);
        items.push(...page.result.items); offset = page.result.nextOffset;
        if (offset === null) assert.equal(items.length, page.result.total);
      } while (offset !== null);
      assert.deepEqual(items.map(item => item.path), Object.keys(before).filter(path => path.startsWith(`${area}/`)).sort());
      for (const item of items) {
        assert.equal(item.mode, before[item.path].mode);
        assert.equal(item.sha256, before[item.path].sha256);
        assert.equal(item.prompt, null); assert.equal(item.scriptIdentity, null); assert.equal(item.identityStatus, "not-applicable");
        if (item.kind === "directory") { assert.equal(item.role, "directory"); continue; }
        assert.equal(item.role, "resource");
        const parts = [];
        let chunkOffset = 0;
        do {
          const response = await active.invoke("library-get", { area, path: item.path, expectedDigest: item.sha256,
            snapshotRevision: revision, offset: chunkOffset });
          assert.equal(response.error, undefined, JSON.stringify(response));
          assert.deepEqual(response.result.item, item); assert.equal(response.result.legacy, null);
          parts.push(Buffer.from(response.result.data, "base64")); chunkOffset = response.result.nextOffset;
        } while (chunkOffset !== null);
        assert.deepEqual(Buffer.concat(parts), await readFile(join(source, item.path)));
      }
      const item = items.find(item => item.kind === "file");
      for (const args of [
        { area, path: item.path, expectedDigest: "0".repeat(64), snapshotRevision: revision },
        { area, path: item.path, expectedDigest: item.sha256, snapshotRevision: "0".repeat(64) },
        { area, path: `${area}/../Example/original.py`, expectedDigest: item.sha256, snapshotRevision: revision },
      ]) assert((await active.invoke("library-get", args)).error);
    }
  }
  await verify(client);
  assert.deepEqual(await captureImportedExperiment(planned.target), targetBefore);
  await assert.rejects(client.invoke("action-run", {}));
  const preparation = await client.prepareImportWrite();
  const credential = await client.enableImportWrite(preparation.authorizationDigest, preparation.target);
  await verify(client);
  await client.close();
  const restarted = new NextManagedClient(); clients.push(restarted);
  await restarted.resumeImport(extension, credential, process.execPath, legacy);
  await verify(restarted); await restarted.close();
  assertNoActionAdmission();
  await t.test("Action history is archived, readable and restartable without inheriting authority", async () => {
    const copy = join(root, "action-history-source"), history = join(copy, ".pkm/state/actions");
    const historyParent = join(root, "action-history-parent");
    await cp(source, copy, { recursive: true });
    await mkdir(join(history, "runs", ".hidden", "empty"), { recursive: true, mode: 0o750 });
    await mkdir(historyParent, { mode: 0o700 });
    const original = new Map([
      ["host-authority.json", Buffer.from('{"token":"historical-only","trust_epoch":"old"}\n')],
      ["grants.json", Buffer.from('{"allow":["do-not-inherit"]}\n')],
      ["runs/.hidden/result.bin", Buffer.from([0, 255, 13, 10])],
      ["runs/empty.bin", Buffer.alloc(0)],
    ]);
    for (const [path, bytes] of original) await writeFile(join(history, path), bytes, { mode: 0o640 });
    await chmod(join(history, "host-authority.json"), 0o600);
    const beforeHistory = await snapshot(copy);
    const approvedHistory = await planLegacyImport(copy);
    assert.equal(approvedHistory.ready, true, JSON.stringify(approvedHistory.blockers));
    const active = new NextManagedClient(); clients.push(active);
    const plannedHistory = await active.planImport(extension, historyParent, process.execPath, legacy, copy, python);
    assert.equal(plannedHistory.ready, true, JSON.stringify(plannedHistory.blockers));
    await active.confirmImport(plannedHistory.planSha256);
    const receiptHistory = (await active.importStatus()).outcome.receipt;
    for (const [path, bytes] of original) {
      const archived = `legacy-code-archive/action-state/${path}`;
      const item = receiptHistory.assets.find(entry => entry.path === archived);
      assert.equal(item.sha256, hash(bytes));
      assert.equal(item.mode, beforeHistory[`.pkm/state/actions/${path}`].mode);
      assert.deepEqual(await readFile(join(plannedHistory.target, archived)), bytes);
    }
    assert(receiptHistory.archivedDirectories.some(item => item.path === "legacy-code-archive/action-state/runs/.hidden/empty"));
    await assert.rejects(lstat(join(plannedHistory.target, ".pkm/state/actions")), { code: "ENOENT" });
    await auditImportedWorkspace(plannedHistory.target, approvedHistory);
    assertNoActionAdmission(plannedHistory.target);
    async function readHistory(client) {
      const listing = await client.invoke("library-list", { area: "action-state", limit: 100 });
      assert.equal(listing.error, undefined, JSON.stringify(listing));
      for (const [path, bytes] of original) {
        const item = listing.result.items.find(entry => entry.path === `action-state/${path}`);
        assert(item); assert.equal(item.role, "resource"); assert.equal(item.identityStatus, "not-applicable");
        const got = await client.invoke("library-get", { area: "action-state", path: item.path,
          expectedDigest: item.sha256, snapshotRevision: listing.result.snapshotRevision });
        assert.equal(got.error, undefined, JSON.stringify(got));
        assert.equal(got.result.legacy, null);
        assert.deepEqual(Buffer.from(got.result.data, "base64"), bytes);
      }
      assert(listing.result.items.some(item => item.path === "action-state/runs/.hidden/empty" && item.kind === "directory"));
    }
    await active.attachImport(); await readHistory(active);
    const preparation = await active.prepareImportWrite();
    const historyCredential = await active.enableImportWrite(preparation.authorizationDigest, preparation.target);
    await readHistory(active); await active.close();
    const resumedHistory = new NextManagedClient(); clients.push(resumedHistory);
    await resumedHistory.resumeImport(extension, historyCredential, process.execPath, legacy);
    await readHistory(resumedHistory); await resumedHistory.close();
    assertNoActionAdmission(plannedHistory.target);
    const backup = join(root, "action-history-backup"), restored = join(root, "action-history-restored");
    const historyStorage = await Storage.open(plannedHistory.target);
    try { await createWorkspaceBackup(historyStorage, backup, { acquireQuiescence: async () => ({ assertHeld() {}, release() {} }) }); }
    finally { await historyStorage.close(); }
    await restoreWorkspaceBackup(backup, restored, { nativeRestoreAuthority, pythonExecutable: python });
    for (const [path, bytes] of original) assert.deepEqual(await readFile(join(restored, "legacy-code-archive/action-state", path)), bytes);
    assert.equal((await lstat(join(restored, "legacy-code-archive/action-state/runs/.hidden/empty"))).mode & 0o777,
      beforeHistory[".pkm/state/actions/runs/.hidden/empty"].mode);
    const changed = join(plannedHistory.target, "legacy-code-archive/action-state/grants.json");
    await writeFile(changed, "tampered");
    await assert.rejects(auditImportedWorkspace(plannedHistory.target, approvedHistory), /mismatch/);
    assert.deepEqual(await snapshot(copy), beforeHistory);
  });
  await t.test("empty Action history is preserved and unsafe or changing history is blocked", async () => {
    const emptySource = join(root, "empty-history-source");
    await mkdir(join(emptySource, "notes"), { recursive: true });
    await mkdir(join(emptySource, ".pkm/state/actions"), { recursive: true, mode: 0o750 });
    const emptyPlan = await planLegacyImport(emptySource);
    assert.equal(emptyPlan.ready, true, JSON.stringify(emptyPlan.blockers));
    const emptyTarget = join(root, "empty-history-target");
    const receipt = await importLegacyWorkspace(emptyPlan, emptyTarget, { pythonExecutable: python });
    assert(receipt.archivedDirectories.some(item => item.path === "legacy-code-archive/action-state" && item.mode === 0o750));
    assert.deepEqual(readLibrary(emptyTarget, { operation: "knowledge.library.list", args: { area: "action-state", offset: 0, limit: 20 } }).items, []);
    await auditImportedWorkspace(emptyTarget, emptyPlan);
    for (const variant of ["locks", "lck", "hardlink", "symlink", "collision", "unsafe", "drift"]) {
      const copy = join(root, `history-${variant}`); await cp(emptySource, copy, { recursive: true });
      const directory = join(copy, ".pkm/state/actions");
      await writeFile(join(directory, "grants.json"), '{"old":true}');
      if (variant === "locks") await mkdir(join(directory, ".locks"));
      if (variant === "lck") await writeFile(join(directory, "state.lck"), "");
      if (variant === "hardlink") await link(join(directory, "grants.json"), join(directory, "linked.json"));
      if (variant === "symlink") await symlink(join(directory, "grants.json"), join(directory, "linked.json"));
      if (variant === "collision") await writeFile(join(directory, "GRANTS.json"), "other");
      if (variant === "unsafe") await writeFile(join(directory, "bad:name"), "other");
      const plan = await planLegacyImport(copy);
      if (variant === "drift") {
        assert.equal(plan.ready, true, JSON.stringify(plan.blockers));
        await writeFile(join(directory, "grants.json"), '{"old":false}');
        await assert.rejects(importLegacyWorkspace(plan, join(root, `history-${variant}-target`), { pythonExecutable: python }),
          { code: "SOURCE_CHANGED" });
      } else {
        assert.equal(plan.ready, false, variant);
        await assert.rejects(importLegacyWorkspace(plan, join(root, `history-${variant}-target`), { pythonExecutable: python }),
          { code: "IMPORT_BLOCKED" });
      }
      await assert.rejects(lstat(join(root, `history-${variant}-target`)), { code: "ENOENT" });
    }
  });
  await t.test("native authorized backup/restore round-trip keeps inert directories, file modes and no-replace semantics", async () => {
    const backup = join(root, "backup"), restored = join(root, "restored");
    const storage = await Storage.open(planned.target);
    try { await createWorkspaceBackup(storage, backup, { acquireQuiescence: async () => ({ assertHeld() {}, release() {} }) }); }
    finally { await storage.close(); }
    const manifest = JSON.parse(await readFile(join(backup, ".pkm-workspace-backup.json")));
    assert.equal(manifest.archivedDirectoryModes.length, receipt.archivedDirectories.length);
    await restoreWorkspaceBackup(backup, restored, { nativeRestoreAuthority, pythonExecutable: python });
    await validateWorkspace(restored);
    const restoredFiles = await snapshot(restored);
    for (const [path, entry] of Object.entries(before).filter(([path]) => path !== "notes"))
      assert.deepEqual(restoredFiles[`legacy-code-archive/${path}`], entry, path);
    for (const area of areas) {
      await assert.rejects(lstat(join(restored, area)), { code: "ENOENT" });
      assert(readLibrary(restored, { operation: "knowledge.library.list", args: { area, offset: 0, limit: 100 } }).items.length > 0);
    }
    const occupied = join(root, "occupied"); await mkdir(occupied); await writeFile(join(occupied, "sentinel"), "no overwrite");
    await assert.rejects(restoreWorkspaceBackup(backup, occupied, { nativeRestoreAuthority, pythonExecutable: python }));
    await assert.rejects(importLegacyWorkspace(approved, occupied, { pythonExecutable: python }));
    assert.equal(await readFile(join(occupied, "sentinel"), "utf8"), "no overwrite");
    const badManifest = { ...manifest, archivedDirectoryModes: [{ path: "notes", mode: 0o777 }] };
    await writeFile(join(backup, ".pkm-workspace-backup.json"), JSON.stringify(badManifest));
    await assert.rejects(restoreWorkspaceBackup(backup, join(root, "bad-restored"), { nativeRestoreAuthority, pythonExecutable: python }));
    await writeFile(join(backup, ".pkm-workspace-backup.json"), JSON.stringify(manifest));
  });
  await t.test("unsafe entries, portable collisions, unknown roots and pending Action state never silently pass", async () => {
    for (const variant of ["symlink", "hardlink", "collision", "privileged", "unsafe", "archive-root", "action-lock", "action-intent", "action-tmp", "unknown-state", "oversize"]) {
      const copy = join(root, variant); await cp(source, copy, { recursive: true });
      const directory = join(copy, "actions/Example");
      if (variant === "symlink") await symlink(join(directory, "original.py"), join(directory, "link.py"));
      if (variant === "hardlink") await link(join(directory, "original.py"), join(directory, "linked.py"));
      if (variant === "collision") await writeFile(join(directory, "ORIGINAL.py"), "different");
      if (variant === "privileged") await chmod(join(directory, "original.py"), 0o4751);
      if (variant === "unsafe") await writeFile(join(directory, "bad:name"), "unsafe");
      if (variant === "archive-root") await mkdir(join(copy, "legacy-code-archive"));
      if (variant === "oversize") await truncate(join(directory, "original.py"), 268435457);
      if (variant.startsWith("action-") || variant === "unknown-state") {
        await mkdir(join(copy, ".pkm/state/actions"), { recursive: true });
        const path = variant === "action-lock" ? "actions/trust.lock" : variant === "action-intent" ? "actions/pending-intent.json"
          : variant === "action-tmp" ? "actions/host-authority.json.123.tmp" : "unknown.json";
        await writeFile(join(copy, ".pkm/state", path), '{"trusted":true}');
      }
      const blocked = await planLegacyImport(copy);
      assert.equal(blocked.ready, false, variant);
      if (variant.startsWith("action-")) assert(blocked.blockers.some(blocker => blocker.code === "pending-action-state"));
      if (variant === "oversize") assert(blocked.blockers.some(blocker => blocker.code === "library-byte-limit"));
      await assert.rejects(importLegacyWorkspace(blocked, join(root, `${variant}-target`), { pythonExecutable: python }));
      await assert.rejects(lstat(join(root, `${variant}-target`)), { code: "ENOENT" });
    }
    for (const limits of [{ maxReadBytes: 1 }, { maxTotalBytes: 1 }]) {
      const blocked = await planLegacyImport(source, limits);
      assert.equal(blocked.ready, false);
      assert(blocked.blockers.some(blocker => blocker.code === "library-byte-limit"));
    }
  });
  await t.test("source byte, mode and empty-directory drift reject the approved plan before publication", async () => {
    for (const variant of ["bytes", "mode", "directory"]) {
      const copy = join(root, `drift-${variant}`); await cp(source, copy, { recursive: true });
      const plan = await planLegacyImport(copy);
      if (variant === "bytes") await writeFile(join(copy, "packages/Example/original.py"), "changed");
      if (variant === "mode") await chmod(join(copy, "components/Example"), 0o700);
      if (variant === "directory") await mkdir(join(copy, "action-module-sets/new-empty"));
      await assert.rejects(importLegacyWorkspace(plan, join(root, `drift-${variant}-target`), { pythonExecutable: python }),
        error => error.code === "SOURCE_CHANGED");
      await assert.rejects(lstat(join(root, `drift-${variant}-target`)), { code: "ENOENT" });
    }
  });
  await t.test("empty area roots are preserved and direct readers never fall back to live native roots", async () => {
    const empty = join(root, "empty-source"), target = join(root, "empty-target");
    for (const area of ["notes", ...areas]) await mkdir(join(empty, area), { recursive: true, mode: 0o750 });
    const plan = await planLegacyImport(empty);
    assert.equal(plan.ready, true, JSON.stringify(plan.blockers));
    const receipt = await importLegacyWorkspace(plan, target, { pythonExecutable: python });
    assert.equal(receipt.archivedDirectories.length, 4);
    assert.equal(receipt.assets.length, 0);
    for (const area of areas) {
      assert.equal((await lstat(join(target, "legacy-code-archive", area))).mode & 0o777, 0o750);
      await mkdir(join(target, area));
      await writeFile(join(target, area, "must-not-read.py"), "native runtime content is not the archive");
      const listing = readLibrary(target, { operation: "knowledge.library.list", args: { area, offset: 0, limit: 100 } });
      assert.equal(listing.total, 0);
    }
    await mkdir(join(target, "legacy-code-archive/unknown"));
    assert.throws(() => readLibrary(target, { operation: "knowledge.library.list", args: { area: "actions", offset: 0, limit: 100 } }), /unknown area/);
    await rm(join(target, "legacy-code-archive/unknown"), { recursive: true });
    await chmod(join(target, "legacy-code-archive"), 0o755);
    assert.throws(() => readLibrary(target, { operation: "knowledge.library.list", args: { area: "actions", offset: 0, limit: 100 } }), /protected/);
    const bare = join(root, "bare-source"), bareTarget = join(root, "bare-target");
    await mkdir(join(bare, "notes"), { recursive: true });
    const barePlan = await planLegacyImport(bare);
    await importLegacyWorkspace(barePlan, bareTarget, { pythonExecutable: python });
    await mkdir(join(bareTarget, "legacy-code-archive"), { mode: 0o700 });
    await assert.rejects(auditImportedWorkspace(bareTarget, barePlan), /unplanned library directory/);
  });
  await t.test("publication death retains read-only inert directories for audit and cleans only the owned stage", async sub => {
    const destination = join(root, "crash-target"), shim = join(root, "publication-death.py");
    const frozen = join(root, "frozen-source");
    await cp(source, frozen, { recursive: true });
    await chmod(join(frozen, "actions/Example"), 0o555);
    sub.after(() => chmod(join(frozen, "actions/Example"), 0o700));
    const frozenBefore = await snapshot(frozen), frozenPlan = await planLegacyImport(frozen);
    assert.equal(frozenPlan.ready, true, JSON.stringify(frozenPlan.blockers));
    await writeFile(shim, `#!${python}\nimport os, signal, sys\nif len(sys.argv) >= 5 and sys.argv[-1] == ${JSON.stringify(destination)}:\n os.kill(os.getppid(), signal.SIGKILL)\n sys.exit(79)\nos.execv(${JSON.stringify(python)}, [${JSON.stringify(python)}, *sys.argv[1:]])\n`);
    await chmod(shim, 0o700);
    assert.throws(() => execFileSync(process.execPath, [join(dist, "cli.js"), "import", "--source", frozen,
      "--destination", destination, "--plan-sha256", frozenPlan.planSha256, "--python", shim,
      "--acknowledge-quiescent-disposable-copy"], { stdio: "pipe", timeout: 30000 }), error => error.signal === "SIGKILL");
    const stages = (await readdir(root)).filter(name => /^\.crash-target\.pkm-legacy-import-[a-f0-9-]{36}$/.test(name));
    assert.equal(stages.length, 1);
    const stage = join(root, stages[0]);
    await assert.rejects(auditImportedWorkspace(stage, frozenPlan), /writer-fence marker does not match/);
    for (const entry of frozenPlan.entries.filter(entry => entry.destination && entry.kind !== "directory"))
      assert.equal(hash(await readFile(join(stage, entry.destination))), entry.sha256);
    assert.equal((await lstat(join(stage, "legacy-code-archive/actions/Example"))).mode & 0o777, 0o555);
    const outcomeFile = join(root, ".crash-target.pkm-legacy-import.outcome.json"), outcome = await readFile(outcomeFile);
    assert.notEqual((await recoverLegacyImportOutcome(destination)).status, "published");
    assert.deepEqual(await cleanupInterruptedLegacyImportStages(destination), { removed: [stage], retained: [] });
    assert.deepEqual(await readFile(outcomeFile), outcome);
    assert.deepEqual(await snapshot(frozen), frozenBefore);
  });
  await t.test("extra inert directories and changed inert bytes permanently invalidate audited client reads", async () => {
    const tamperParent = join(root, "tamper-parent"); await mkdir(tamperParent, { mode: 0o700 });
    const tampered = new NextManagedClient(); clients.push(tampered);
    const plan = await tampered.planImport(extension, tamperParent, process.execPath, legacy, source, python);
    await tampered.confirmImport(plan.planSha256); await tampered.attachImport();
    const file = join(plan.target, "legacy-code-archive/actions/Example/original.py"), bytes = await readFile(file);
    await writeFile(file, "tampered");
    await assert.rejects(tampered.invoke("library-list", { area: "actions" }), /outcome unknown/);
    await writeFile(file, bytes);
    await assert.rejects(tampered.invoke("library-list", { area: "actions" }), /previously failed/);
    await tampered.close();
    await mkdir(join(plan.target, "legacy-code-archive/actions/unplanned-empty"));
    await assert.rejects(auditImportedWorkspace(plan.target, approved), /unplanned library directory/);
  });
  assert.deepEqual(await snapshot(source), before);
  assert.deepEqual(await snapshot(legacy), legacyBefore);
});
