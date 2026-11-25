import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { serializeTodoBoard } from "../dist/domain/todo-board.js";
import { restoreWorkspaceBackup } from "../dist/workspace-backup.js";
import { nativeRestoreAuthority } from "./host-composition-legacy-batch16-restore-fixture.mjs";

const exec = promisify(execFile);
const cli = resolve(import.meta.dirname, "../dist/cli.js");
const audit = resolve(import.meta.dirname, "../scripts/migration-audit.mjs");
const python = execFileSync("python3", ["-c", "import sys; print(sys.executable)"], { encoding: "utf8" }).trim();
const ack = "--acknowledge-quiescent-disposable-copy";
const hash = data => createHash("sha256").update(data).digest("hex");

test("isolated import reconciliation detects missing and changed data; post-write inventory blocks blind rollback and fixture backup restores", { timeout: 60000 }, async t => {
  const parent = resolve(import.meta.dirname, `.migration-audit-${randomUUID()}`);
  const source = join(parent, "source"), target = join(parent, "target"), baseline = join(parent, "baseline.json");
  await mkdir(join(source, "notes/Team/_assets"), { recursive: true, mode: 0o700 });
  t.after(() => rm(parent, { recursive: true, force: true }));
  const note = "---\ntitle: Design\ndocumentId: design-note\nrevision: 3\n---\n![image](_assets/0123456789abcdef.png)\n";
  const asset = Buffer.from([0, 255, 7, 42]);
  await writeFile(join(source, "notes/Team/Design.md"), note);
  await writeFile(join(source, "notes/Team/_assets/0123456789abcdef.png"), asset);
  await mkdir(join(source, "notes/Team/Board.assets"));
  await writeFile(join(source, "notes/Team/Board.md"), "---\ntitle: Board\ndocumentId: board-a\ndocumentKind: todo-board\n---\nBoard\n");
  await writeFile(join(source, "notes/Team/Board.assets/pkm-todo-board.json"), serializeTodoBoard([{
    id: "work-1", title: "Work", goal: "Keep it", scope: "Migration", acceptance: ["Done"], state: "Planning",
    evidence: [], history: [{ at: "2025-02-03T04:05:06.000Z", actorId: "user:legacy", action: "created" }],
  }]));
  await mkdir(join(source, "skills/Team"), { recursive: true });
  await mkdir(join(source, "papers/Topic"), { recursive: true });
  await writeFile(join(source, "skills/Team/Skill.md"), "---\nname: Skill\ndocumentId: skill-a\n---\nSkill body\n");
  await writeFile(join(source, "papers/Topic/Paper.md"), "---\ntitle: Paper\ndocumentId: paper-a\n---\nPaper body\n");
  await mkdir(join(source, "prompts/project/task/v1"), { recursive: true });
  await writeFile(join(source, "prompts/project/task/v1/template.jinja2"), "Hello {{ name }}\n");
  const run = (script, ...args) => exec(process.execPath, [script, ...args], { timeout: 30000 });
  const plan = JSON.parse((await run(cli, "import-plan", "--source", source, ack)).stdout).plan;
  assert.equal(plan.ready, true, JSON.stringify(plan.blockers));
  await run(cli, "import", "--source", source, "--destination", target, "--plan-sha256", plan.planSha256, "--python", python, ack);
  const reconcile = () => run(audit, "reconcile", "--source", source, "--destination", target, ack);
  const initial = JSON.parse((await reconcile()).stdout);
  assert.equal(initial.status, "matched-scoped");
  assert(initial.rows.some(row => row.source.endsWith("template.jinja2") && row.result === "match"));
  assert(initial.rows.some(row => row.source.endsWith(".png") && row.result === "match"));
  assert(initial.rows.some(row => row.source.endsWith("pkm-todo-board.json")
    && row.destination === "boards/Team/Board/pkm-todo-board.json" && row.result === "match"));
  await assert.rejects(run(audit, "snapshot", "--root", target), /acknowledge/i);
  const snapshot = (await run(audit, "snapshot", "--root", target, ack)).stdout;
  await writeFile(baseline, snapshot);
  assert.equal(JSON.parse((await run(audit, "diff", "--root", target, "--baseline", baseline, ack)).stdout).status, "unchanged");
  const coldDelivery = join(parent, "cold-consistent");
  const coldReceipt = JSON.parse((await run(audit, "deliver-consistent", "--root", target, "--baseline", baseline,
    "--destination", coldDelivery, "--python", python, ack)).stdout);
  assert.equal(JSON.parse((await run(audit, "verify-consistent", "--destination", coldDelivery,
    "--manifest-sha256", coldReceipt.manifestSha256, "--python", python, ack)).stdout).status, "verified");
  const backup = join(parent, "backup"), restored = join(parent, "restored");
  await run(cli, "backup", "--data", target, "--destination", backup);
  const writer = `
    import { Core } from ${JSON.stringify(new URL("../dist/core.js", import.meta.url).href)};
    import { Storage } from ${JSON.stringify(new URL("../dist/storage.js", import.meta.url).href)};
    const storage = await Storage.open(process.argv[1]);
    try {
      const result = await new Core(storage).dispatch("capability_call", { operation: "knowledge.document.update", version: 1,
        arguments: { id: "design-note", operationId: process.argv[2], expectedRevision: 3, expectedSha256: process.argv[3],
          title: "Edited", content: "New write after baseline" } }, { id: "fixture:owner", canWrite: true });
      if (result.error) throw new Error(JSON.stringify(result.error));
    } finally { await storage.close(); }
  `;
  const writeOperationId = randomUUID();
  await exec(process.execPath, ["-e", writer, target, writeOperationId, hash(note)], { timeout: 30000 });
  await writeFile(join(target, "notes/Team/new.md"), "new file");
  const newAsset = Buffer.from([255, 0, 7, 128, 10]);
  await writeFile(join(target, "notes/Team/_assets/1111111111111111.png"), newAsset);
  await rm(join(target, "notes/Team/_assets/0123456789abcdef.png"));
  await assert.rejects(run(audit, "diff", "--root", target, "--baseline", baseline, ack), error => {
    const result = JSON.parse(error.stdout);
    assert.equal(result.status, "changed");
    for (const [path, change] of [["notes/Team/Design.md", "changed"], ["notes/Team/new.md", "added"],
      ["notes/Team/_assets/0123456789abcdef.png", "removed"]])
      assert(result.changes.some(item => item.path === path && item.change === change), JSON.stringify(result));
    return true;
  });
  await assert.rejects(reconcile(), error => {
    const result = JSON.parse(error.stdout);
    assert.equal(result.status, "blocked");
    assert(result.rows.some(row => row.source.endsWith("Design.md") && row.result === "mismatch"));
    assert(result.rows.some(row => row.source.endsWith(".png") && row.result === "missing"));
    return true;
  });
  const consistent = join(parent, "consistent");
  const runtimeHistory = JSON.stringify({ schema: "pkm.managed-runtime-history/v1",
    transitions: [{ sequence: 1, from: null, to: randomUUID(), phase: "switched" }], retired: [] });
  await writeFile(join(target, "runtime-control/managed-runtime-history.json"), runtimeHistory, { mode: 0o600 });
  const consistentResult = JSON.parse((await run(audit, "deliver-consistent", "--root", target, "--baseline", baseline,
    "--destination", consistent, "--python", python, ack)).stdout);
  assert(consistentResult.changes >= 3);
  assert.equal(JSON.parse((await run(audit, "verify-consistent", "--destination", consistent,
    "--manifest-sha256", consistentResult.manifestSha256, "--python", python, ack)).stdout).status, "verified");
  assert.equal(await readFile(join(consistent, "backup/runtime-control/managed-runtime-history.json"), "utf8"), runtimeHistory);
  for (const path of [".managed-runtime-history.guard", "shared-manager/shared-manager.guard"])
    await assert.rejects(readFile(join(consistent, "backup/runtime-control", path)), { code: "ENOENT" });
  if (process.platform === "linux") {
    const manifest = JSON.parse(await readFile(join(consistent, "manifest.json"), "utf8"));
    const marker = manifest.source.entries.find(entry => entry.path === ".pkm-next-writer-fenced.json");
    assert.equal(marker.sha256, hash(await readFile(join(target, marker.path))));
    await assert.rejects(readFile(join(consistent, "backup", marker.path)), { code: "ENOENT" });
  }
  assert.deepEqual(await readFile(join(consistent, "backup/notes/Team/_assets/1111111111111111.png")), newAsset);
  assert.match(await readFile(join(consistent, "backup/notes/Team/Design.md"), "utf8"), /New write after baseline/);
  const count = execFileSync(python, ["-c",
    "import pathlib,sqlite3,sys; c=sqlite3.connect(pathlib.Path(sys.argv[1]).as_uri()+'?mode=ro&immutable=1',uri=True); print(c.execute('select count(*) from receipts where operation_id=?',(sys.argv[2],)).fetchone()[0]); c.close()",
    join(consistent, "backup/core.sqlite"), writeOperationId], { encoding: "utf8" }).trim();
  assert.equal(count, "1");
  for (const suffix of ["-wal", "-shm"])
    await assert.rejects(readFile(join(consistent, `backup/core.sqlite${suffix}`)), { code: "ENOENT" });
  await assert.rejects(run(audit, "deliver-consistent", "--root", target, "--baseline", baseline,
    "--destination", consistent, "--python", python, ack), /EEXIST/);
  await writeFile(join(consistent, "backup/notes/Team/new.md"), "tampered");
  await assert.rejects(run(audit, "verify-consistent", "--destination", consistent,
    "--manifest-sha256", consistentResult.manifestSha256, "--python", python, ack), /payload differs/);
  await writeFile(join(consistent, "backup/notes/Team/new.md"), "new file");
  const invalidDatabase = Buffer.from("not a SQLite database");
  await writeFile(join(consistent, "backup/core.sqlite"), invalidDatabase);
  const forgedManifest = JSON.parse(await readFile(join(consistent, "manifest.json"), "utf8"));
  const databaseEntry = forgedManifest.backupInventory.entries.find(entry => entry.path === "core.sqlite");
  databaseEntry.size = invalidDatabase.length;
  databaseEntry.sha256 = hash(invalidDatabase);
  const forgedBytes = JSON.stringify(forgedManifest);
  await writeFile(join(consistent, "manifest.json"), forgedBytes);
  await assert.rejects(run(audit, "verify-consistent", "--destination", consistent,
    "--manifest-sha256", hash(forgedBytes), "--python", python, ack), /database|malformed|file is not/i);
  await writeFile(join(target, "unexpected-root"), "unsupported");
  await assert.rejects(run(audit, "deliver-consistent", "--root", target, "--baseline", baseline,
    "--destination", join(parent, "blocked-consistent"), "--python", python, ack), /INVALID_WORKSPACE|unrecognized entry/i);
  await assert.rejects(readFile(join(parent, "blocked-consistent/manifest.json")), { code: "ENOENT" });
  await rm(join(target, "unexpected-root"));
  const delivery = join(parent, "delivery");
  const delivered = JSON.parse((await run(audit, "deliver", "--root", target, "--baseline", baseline,
    "--destination", delivery, ack)).stdout);
  assert(delivered.changes >= 3);
  const verified = JSON.parse((await run(audit, "verify-delivery", "--destination", delivery,
    "--manifest-sha256", delivered.manifestSha256, ack)).stdout);
  assert.equal(verified.status, "verified");
  const manifest = JSON.parse(await readFile(join(delivery, "manifest.json"), "utf8"));
  assert(manifest.changes.some(item => item.path.endsWith("Design.md") && item.change === "changed"));
  assert(manifest.changes.some(item => item.path.endsWith(".png") && item.change === "removed"));
  assert(manifest.changes.some(item => item.path.endsWith("new.md") && item.change === "added"));
  const deliveredNote = await readFile(join(delivery, "payload/notes/Team/Design.md"), "utf8");
  assert.match(deliveredNote, /New write after baseline/);
  assert.match(deliveredNote, /design-note/);
  assert.equal(await readFile(join(delivery, "payload/notes/Team/new.md"), "utf8"), "new file");
  assert.deepEqual(await readFile(join(delivery, "payload/notes/Team/_assets/1111111111111111.png")), newAsset);
  assert.match(await readFile(join(delivery, "payload/notes/Team/Board.md"), "utf8"), /board-a/);
  await assert.rejects(readFile(join(delivery, "payload/notes/Team/_assets/0123456789abcdef.png")), { code: "ENOENT" });
  await assert.rejects(run(audit, "deliver", "--root", target, "--baseline", baseline, "--destination", delivery, ack), /EEXIST/);
  await assert.rejects(run(audit, "verify-delivery", "--destination", delivery, "--manifest-sha256", "0".repeat(64), ack), /digest mismatch/);
  await writeFile(join(delivery, "payload/notes/Team/new.md"), "tampered");
  await assert.rejects(run(audit, "verify-delivery", "--destination", delivery,
    "--manifest-sha256", delivered.manifestSha256, ack), /payload differs/);
  await restoreWorkspaceBackup(backup, restored, { pythonExecutable: python, nativeRestoreAuthority });
  assert.equal(await readFile(join(restored, "notes/Team/Design.md"), "utf8"), note);
  assert.deepEqual(await readFile(join(restored, "notes/Team/_assets/0123456789abcdef.png")), asset);
  assert.match(await readFile(join(target, "notes/Team/Design.md"), "utf8"), /New write after baseline/);
  assert.equal(await readFile(join(source, "notes/Team/Design.md"), "utf8"), note);
  await assert.rejects(run(audit, "diff", "--root", restored, "--baseline", baseline, ack), /identity differs/);
  const prompt = join(source, "prompts/project/task/v1/template.jinja2");
  await writeFile(prompt, "source drift");
  await assert.rejects(reconcile(), error => {
    const report = JSON.parse(error.stdout);
    assert.equal(report.status, "blocked");
    assert.equal(report.sourceMatchesReceipt, false);
    return true;
  });
  if (process.platform === "linux") {
    const markerPath = join(target, ".pkm-next-writer-fenced.json"), markerBytes = await readFile(markerPath);
    const invalidDelivery = join(parent, "invalid-fence-delivery");
    await writeFile(markerPath, JSON.stringify({ ...JSON.parse(markerBytes.toString("utf8")), root: source }));
    try {
      await assert.rejects(run(audit, "deliver-consistent", "--root", target, "--baseline", baseline,
        "--destination", invalidDelivery, "--python", python, ack), /writer-fence marker.*match/i);
      await assert.rejects(readFile(join(invalidDelivery, "manifest.json")), { code: "ENOENT" });
    } finally { await writeFile(markerPath, markerBytes); }
  }
  await symlink(join(source, "notes"), join(target, "unsafe-link"));
  await assert.rejects(run(audit, "snapshot", "--root", target, ack), /symlink/i);
});

test("audit rejects blocked sources, overlapping roots, malformed snapshots and unsafe baseline locations", { timeout: 30000 }, async t => {
  const parent = resolve(import.meta.dirname, `.migration-audit-errors-${randomUUID()}`);
  const source = join(parent, "source"), target = join(parent, "target");
  await mkdir(join(source, "notes"), { recursive: true });
  await mkdir(target);
  t.after(() => rm(parent, { recursive: true, force: true }));
  const run = (...args) => exec(process.execPath, [audit, ...args], { timeout: 30000 });
  await writeFile(join(source, "notes/.unknown"), "do not omit");
  await assert.rejects(run("reconcile", "--source", source, "--destination", target, ack), error => {
    const report = JSON.parse(error.stdout);
    assert.equal(report.status, "blocked");
    assert(report.blockers.length);
    return true;
  });
  await assert.rejects(run("reconcile", "--source", source, "--destination", source, ack), /overlap/i);
  const malformed = join(parent, "bad.json");
  await writeFile(malformed, "{}");
  await assert.rejects(run("diff", "--root", target, "--baseline", malformed, ack), /Invalid snapshot/);
  await assert.rejects(run("diff", "--root", target, "--baseline", join(target, "bad.json"), ack), /outside/);
  await writeFile(malformed, JSON.stringify({ schema: "pkm.disposable-inventory/v1", root: target, device: "1", inode: "2",
    entries: [{ path: "../escape", kind: "file", mode: 384, size: 0, sha256: hash(""), mtimeNs: "0" }] }));
  await assert.rejects(run("diff", "--root", target, "--baseline", malformed, ack), /Invalid snapshot entry/);
  const snapshot = (await run("snapshot", "--root", target, ack)).stdout;
  const baseline = join(parent, "baseline.json");
  await writeFile(baseline, snapshot);
  const malformedSnapshot = JSON.parse(snapshot);
  malformedSnapshot.entries = [{ path: "note", kind: "file", mode: 384, size: 0, sha256: hash(""), mtimeNs: 0 }];
  await writeFile(malformed, JSON.stringify(malformedSnapshot));
  await assert.rejects(run("diff", "--root", target, "--baseline", malformed, ack), /Invalid snapshot entry/);
  await writeFile(join(target, "core.sqlite-wal"), "uncheckpointed");
  const result = JSON.parse((await run("deliver", "--root", target, "--baseline", baseline,
    "--destination", join(parent, "delivery"), ack)).stdout);
  const manifest = JSON.parse(await readFile(join(parent, "delivery/manifest.json"), "utf8"));
  assert.deepEqual(manifest.sqliteSidecars, ["core.sqlite-wal"]);
  assert.equal(await readFile(join(parent, "delivery/payload/core.sqlite-wal"), "utf8"), "uncheckpointed");
  assert.equal(JSON.parse((await run("verify-delivery", "--destination", join(parent, "delivery"),
    "--manifest-sha256", result.manifestSha256, ack)).stdout).status, "verified");
  await assert.rejects(run("deliver", "--root", target, "--baseline", baseline, "--destination", join(target, "delivery"), ack), /overlap/);
  await assert.rejects(run("deliver-consistent", "--root", target, "--baseline", baseline,
    "--destination", join(target, "delivery"), "--python", python, ack), /overlap/);
  await writeFile(join(target, "hidden-data"), Buffer.concat([Buffer.from("SQLite format 3\0"), Buffer.alloc(100)]));
  await assert.rejects(run("deliver-consistent", "--root", target, "--baseline", baseline,
    "--destination", join(parent, "database-delivery"), "--python", python, ack), /Additional SQLite database/);
  await assert.rejects(readFile(join(parent, "database-delivery/manifest.json")), { code: "ENOENT" });
  await symlink(source, join(target, "unsafe-link"));
  await assert.rejects(run("deliver", "--root", target, "--baseline", baseline, "--destination", join(parent, "unsafe-delivery"), ack), /symlink/i);
  await assert.rejects(readFile(join(parent, "unsafe-delivery/manifest.json")), { code: "ENOENT" });
});
