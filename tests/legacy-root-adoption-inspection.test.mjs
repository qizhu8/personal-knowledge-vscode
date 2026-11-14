import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { Storage } from "../dist/storage.js";
import { inspectLegacyRootForAdoption } from "../dist/legacy-import.js";

const testsRoot = fileURLToPath(new URL(".", import.meta.url));
const digest = value => createHash("sha256").update(value).digest("hex");

async function snapshot(root) {
  const entries = [];
  async function visit(directory, prefix = "") {
    for (const name of (await readdir(directory)).sort()) {
      const path = prefix ? `${prefix}/${name}` : name;
      const full = join(directory, name);
      const stat = await lstat(full, { bigint: true });
      entries.push({
        path,
        kind: stat.isDirectory() ? "directory" : "file",
        dev: stat.dev.toString(),
        ino: stat.ino.toString(),
        mode: Number(stat.mode & 0o777n),
        size: stat.size.toString(),
        mtimeNs: stat.mtimeNs.toString(),
        ctimeNs: stat.ctimeNs.toString(),
        ...(stat.isFile() ? { sha256: digest(await readFile(full)) } : {}),
      });
      if (stat.isDirectory()) await visit(full, path);
    }
  }
  await visit(root);
  return entries;
}

async function fixture(t) {
  const root = resolve(testsRoot, `.legacy-root-inspection-${randomUUID()}`);
  await mkdir(join(root, "notes"), { recursive: true, mode: 0o700 });
  t.after(() => rm(root, { recursive: true, force: true }));
  const markdown = "---\ntitle: Synthetic\n---\nFixture-only legacy content.\n";
  await writeFile(join(root, "notes", "synthetic.md"), markdown, { mode: 0o600 });
  return { root, markdown };
}

test("legacy root inspection is read-only, root-bound, and never authorizes direct adoption", async t => {
  const f = await fixture(t);
  const before = await snapshot(f.root);
  const report = await inspectLegacyRootForAdoption(f.root);
  const after = await snapshot(f.root);

  assert.deepEqual(after, before);
  assert.equal(report.schema, "pkm.legacy-root-adoption-inspection/v1");
  assert.equal(report.sourceRoot, f.root);
  const rootStat = await lstat(f.root, { bigint: true });
  assert.equal(report.rootIdentity.device, rootStat.dev.toString());
  assert.equal(report.rootIdentity.inode, rootStat.ino.toString());
  assert.equal(report.ready, false);
  assert.equal(report.inventoryPlan.ready, true, "The nested flag describes only bounded copy inventory.");
  assert.match(report.sourceFingerprint, /^[a-f0-9]{64}$/);
  assert.match(report.inspectionSha256, /^[a-f0-9]{64}$/);
  assert(report.blockers.some(blocker => blocker.code === "direct-adoption-unqualified"));
  assert(report.blockers.some(blocker => blocker.code === "writer-isolation-unverified"));
  assert(report.blockers.some(blocker => blocker.code === "complete-workflow-parity-unverified"));
  assert(report.blockers.some(blocker => blocker.code === "recovery-and-rollback-unqualified"));

  const secondRoot = resolve(testsRoot, `.legacy-root-inspection-${randomUUID()}`);
  await mkdir(join(secondRoot, "notes"), { recursive: true, mode: 0o700 });
  t.after(() => rm(secondRoot, { recursive: true, force: true }));
  await writeFile(join(secondRoot, "notes", "synthetic.md"), f.markdown, { mode: 0o600 });
  const second = await inspectLegacyRootForAdoption(secondRoot);
  assert.notEqual(second.sourceFingerprint, report.sourceFingerprint, "Identical bytes in a different root cannot share an adoption fingerprint.");

  await writeFile(join(f.root, "notes", "synthetic.md"), f.markdown.replace("Fixture-only", "Synthetic-only"));
  const changed = await inspectLegacyRootForAdoption(f.root);
  assert.notEqual(changed.sourceFingerprint, report.sourceFingerprint, "Content changes invalidate the root-bound source fingerprint.");
});

test("read-only CLI inspection needs no acknowledgement and legacy Storage.open fails before initialization", async t => {
  const f = await fixture(t);
  const before = await snapshot(f.root);
  const cli = resolve(testsRoot, "../dist/cli.js");
  const output = execFileSync(process.execPath, [cli, "inspect-legacy-root", "--root", f.root], { encoding: "utf8" });
  const { inspection } = JSON.parse(output);
  assert.equal(inspection.ready, false);
  assert(inspection.blockers.some(blocker => blocker.code === "direct-adoption-unqualified"));

  await assert.rejects(Storage.open(f.root), { code: "INVALID_WORKSPACE" });
  await assert.rejects(lstat(join(f.root, ".pkm-next-workspace")), { code: "ENOENT" });
  await assert.rejects(lstat(join(f.root, "core.sqlite")), { code: "ENOENT" });
  assert.deepEqual(await snapshot(f.root), before);
});

test("unsupported legacy entries remain visible blockers and are never omitted from inspection", async t => {
  const f = await fixture(t);
  await mkdir(join(f.root, ".pkm", "state", "agent-sessions"), { recursive: true, mode: 0o700 });
  await writeFile(join(f.root, ".pkm", "state", "agent-sessions", "session.json"), "{\"synthetic\":true}\n", { mode: 0o600 });
  const report = await inspectLegacyRootForAdoption(f.root);

  assert.equal(report.ready, false);
  assert.equal(report.sourceFingerprint, null);
  assert(report.inventoryPlan.blockers.some(blocker => blocker.path === ".pkm/state/agent-sessions"));
  assert(report.blockers.some(blocker => blocker.path === ".pkm/state/agent-sessions"));
});
