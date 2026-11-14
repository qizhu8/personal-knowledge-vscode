import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { Core } from "../dist/core.js";
import { Storage } from "../dist/storage.js";
import { restoreWorkspaceBackup } from "../dist/workspace-backup.js";
import { nativeRestoreAuthority } from "./host-composition-legacy-batch16-restore-fixture.mjs";

const execute = promisify(execFile);
const cli = resolve(import.meta.dirname, "../dist/cli.js");
const python = execFileSync("python3", ["-c", "import sys; print(sys.executable)"], { encoding: "utf8" }).trim();
const ack = "--acknowledge-quiescent-disposable-copy";
async function fixture(t) {
  const parent = resolve(import.meta.dirname, `.import-cli-${randomUUID()}`);
  const source = join(parent, "source"), destination = join(parent, "destination");
  await mkdir(join(source, "notes"), { recursive: true });
  await mkdir(join(source, "prompts/project/task/v1"), { recursive: true });
  await writeFile(join(source, "prompts/project/task/v1/template.jinja2"), "Hello {{ name }}\n");
  t.after(() => rm(parent, { recursive: true, force: true }));
  const run = (...args) => execute(process.execPath, [cli, ...args], { timeout: 30000 });
  return { source, destination, run };
}
test("CLI plans, imports and recovers a pinned disposable workspace", async t => {
  const f = await fixture(t);
  const planned = JSON.parse((await f.run("import-plan", "--source", f.source, ack)).stdout).plan;
  assert.equal(planned.ready, true, JSON.stringify(planned.blockers));
  const options = ["--source", f.source, "--destination", f.destination,
    "--plan-sha256", planned.planSha256, "--python", python, ack];
  const receipt = JSON.parse((await f.run("import", ...options)).stdout).receipt;
  assert.equal(receipt.fingerprint, planned.fingerprint);
  assert.equal(await readFile(join(f.destination, "prompts/project/task/v1/template.jinja2"), "utf8"), "Hello {{ name }}\n");
  const status = JSON.parse((await f.run("import-status", "--destination", f.destination)).stdout).outcome;
  assert.equal(status.status, "published");
  assert.deepEqual(status.receipt, receipt);
  const cleanup = JSON.parse((await f.run("import-cleanup", "--destination", f.destination,
    "--acknowledge-abandoned-stages")).stdout).cleanup;
  assert.deepEqual(cleanup, { removed: [], retained: [] });
  assert.deepEqual(JSON.parse((await f.run("import-status", "--destination", f.destination)).stdout).outcome, status);
  await assert.rejects(f.run("import", ...options), /DESTINATION_EXISTS|destination already exists/i);
});
test("CLI refuses unacknowledged, changed or blocked input without publishing", async t => {
  const f = await fixture(t);
  await assert.rejects(f.run("import-plan", "--source", f.source), /acknowledge/i);
  await assert.rejects(f.run("import-plan", "--source", "relative", ack), /absolute path/i);
  await assert.rejects(f.run("import-plan", "--source", f.source, "--source", f.source, ack), /duplicate/i);
  const planned = JSON.parse((await f.run("import-plan", "--source", f.source, ack)).stdout).plan;
  await writeFile(join(f.source, "prompts/project/task/v1/template.jinja2"), "Changed\n");
  await assert.rejects(f.run("import", "--source", f.source, "--destination", f.destination,
    "--plan-sha256", planned.planSha256, "--python", python, ack), /no longer matches/i);
  await assert.rejects(readFile(f.destination), { code: "ENOENT" });
  await writeFile(join(f.source, "prompts/.unrecognized"), "do not omit");
  await assert.rejects(f.run("import-plan", "--source", f.source, ack), error => {
    const result = JSON.parse(error.stdout);
    assert.equal(result.plan.ready, false);
    assert.ok(result.plan.blockers.length);
    return true;
  });
  await assert.rejects(f.run("import-status", "--destination", f.destination), error => {
    assert.notEqual(JSON.parse(error.stdout).outcome.status, "published");
    return true;
  });
});

test("CLI cleanup removes only demonstrably abandoned owned stages", async t => {
  const f = await fixture(t);
  const parent = resolve(f.destination, "..");
  async function stage(pid, valid = true) {
    const token = randomUUID(), workspaceId = randomUUID();
    const path = join(parent, `.destination.pkm-legacy-import-${token}`);
    const owner = { schema: "pkm.legacy-import-stage/v1", token, pid, destination: f.destination, stage: path, workspaceId };
    await mkdir(path);
    await writeFile(join(path, ".pkm-next-workspace"), JSON.stringify({ schema: "pkm.next-workspace/v2", id: workspaceId }));
    await writeFile(`${path}.owner.json`, valid ? JSON.stringify(owner) : "{}");
    return path;
  }
  const dead = await stage(2147483647), live = await stage(process.pid), unknown = await stage(2147483647, false);
  await assert.rejects(f.run("import-cleanup", "--destination", f.destination), /acknowledge/i);
  await assert.rejects(f.run("import-cleanup", "--destination", f.destination, "--acknowledge-quiescent-disposable-copy"), /Options do not match/);
  await assert.rejects(f.run("import-cleanup", "--destination", f.destination, "--acknowledge-abandoned-stages"), error => {
    const { cleanup } = JSON.parse(error.stdout);
    assert.deepEqual(cleanup.removed, [dead]);
    assert.deepEqual(cleanup.retained, [live]);
    return true;
  });
  await assert.rejects(lstat(dead), { code: "ENOENT" });
  assert((await lstat(live)).isDirectory());
  assert((await lstat(unknown)).isDirectory());
  assert((await lstat(f.source)).isDirectory());
});

test("Linux CLI fixture: plan, import, native reads, backup and relocated restore", { timeout: 60000 }, async t => {
  const f = await fixture(t);
  const note = "---\ntitle: Design\ndocumentId: design-note\nrevision: 3\naliases: [note:Old/Design]\n---\n![image](_assets/0123456789abcdef.png)\n";
  const asset = Buffer.from([0, 255, 7, 42]);
  await mkdir(join(f.source, "notes/Team/_assets"), { recursive: true });
  await mkdir(join(f.source, "skills/Team"), { recursive: true });
  await mkdir(join(f.source, "papers/Topic"), { recursive: true });
  await writeFile(join(f.source, "notes/Team/Design.md"), note);
  await writeFile(join(f.source, "notes/Team/_assets/0123456789abcdef.png"), asset);
  await writeFile(join(f.source, "skills/Team/Skill.md"), "---\nname: Skill\ndocumentId: skill-a\n---\nSkill body\n");
  await writeFile(join(f.source, "papers/Topic/Paper.md"), "---\ntitle: Paper\ndocumentId: paper-a\n---\nPaper body\n");
  const plan = JSON.parse((await f.run("import-plan", "--source", f.source, ack)).stdout).plan;
  assert.equal(plan.ready, true, JSON.stringify(plan.blockers));
  const receipt = JSON.parse((await f.run("import", "--source", f.source, "--destination", f.destination,
    "--plan-sha256", plan.planSha256, "--python", python, ack)).stdout).receipt;
  assert.equal(receipt.fingerprint, plan.fingerprint);
  assert.equal(JSON.parse((await f.run("import-status", "--destination", f.destination)).stdout).outcome.status, "published");
  async function check(root) {
    const storage = await Storage.open(root);
    try {
      const core = new Core(storage);
      const result = await core.dispatch("capability_read", { operation: "knowledge.document.get", version: 1,
        arguments: { id: "design-note" } }, { id: "fixture:reader", canWrite: false });
      assert.equal(result.error, undefined, JSON.stringify(result.error));
      assert.equal(result.result.revision, 3);
      assert.match(result.result.content, /0123456789abcdef/);
      assert.deepEqual(await readFile(join(root, "notes/Team/_assets/0123456789abcdef.png")), asset);
      assert.equal(await readFile(join(root, "notes/Team/Design.md"), "utf8"), note);
      assert.match(await readFile(join(root, "skills/Team/Skill.md"), "utf8"), /Skill body/);
      assert.match(await readFile(join(root, "papers/Topic/Paper.md"), "utf8"), /Paper body/);
      assert.equal(await readFile(join(root, "prompts/project/task/v1/template.jinja2"), "utf8"), "Hello {{ name }}\n");
    } finally { await storage.close(); }
  }
  await check(f.destination);
  const backup = join(resolve(f.destination, ".."), "backup");
  const restored = join(resolve(f.destination, ".."), "restored");
  await f.run("backup", "--data", f.destination, "--destination", backup);
  await restoreWorkspaceBackup(backup, restored, { pythonExecutable: python, nativeRestoreAuthority });
  await check(restored);
  assert.equal(await readFile(join(f.source, "notes/Team/Design.md"), "utf8"), note);
  assert.deepEqual(await readFile(join(f.source, "notes/Team/_assets/0123456789abcdef.png")), asset);
});
