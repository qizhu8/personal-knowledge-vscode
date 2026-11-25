import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { acquireLinuxRootWriterFence } from "../dist/linux-root-writer-fence.js";
import { planOriginalMcpGitProtection, applyOriginalMcpGitProtection } from "../dist/original-mcp-git-protection.js";

async function fixture(t) {
  const parent = resolve("tests", `.original-mcp-git-${randomUUID()}`);
  const root = join(parent, "original");
  await mkdir(root, { recursive: true, mode: 0o700 });
  const initialized = spawnSync("/usr/bin/git", ["-C", root, "init", "--template="], { encoding: "utf8" });
  assert.equal(initialized.status, 0, initialized.stderr);
  t.after(() => rm(parent, { recursive: true }));
  const before = "# Original scope remains unchanged\r\nknowledge.db\r\n";
  await writeFile(join(root, ".gitignore"), before, { mode: 0o600 });
  return { root, parent, before };
}
test("native database/config namespaces are excluded only after private backup and under the same real fence", async t => {
  const f = await fixture(t);
  const plan = planOriginalMcpGitProtection(f.root);
  assert.equal(await readFile(join(f.root, ".gitignore"), "utf8"), f.before);
  await assert.rejects(applyOriginalMcpGitProtection(plan,
    { writerFence: { root: f.root, assertHeld() {} }, backupDirectory: join(f.parent, "fake") }), /actual original-root fence/);
  const writerFence = await acquireLinuxRootWriterFence(f.root);
  try {
    const result = await applyOriginalMcpGitProtection(plan, { writerFence, backupDirectory: join(f.parent, "policy-before") });
    result.assertCurrent();
    assert.equal(await readFile(join(f.parent, "policy-before/gitignore.before"), "utf8"), f.before);
    const after = await readFile(join(f.root, ".gitignore"), "utf8");
    assert(after.startsWith(f.before));
    assert(after.includes("/core.sqlite-*"));
    assert.equal(planOriginalMcpGitProtection(f.root).writeRequired, false);
    await writeFile(join(f.root, ".gitignore"), f.before);
    assert.throws(() => result.assertCurrent(), /exclusion policy changed/);
    writerFence.assertHeld();
  } finally { await writerFence.release(); }
});
test("tracked private data and changed source policies refuse without deleting history or overwriting user changes", async t => {
  const f = await fixture(t);
  const plan = planOriginalMcpGitProtection(f.root);
  const changed = f.before + "# User changed this after inspection\n";
  await writeFile(join(f.root, ".gitignore"), changed);
  const writerFence = await acquireLinuxRootWriterFence(f.root);
  try {
    await assert.rejects(applyOriginalMcpGitProtection(plan,
      { writerFence, backupDirectory: join(f.parent, "stale") }), /plan changed/);
    assert.equal(await readFile(join(f.root, ".gitignore"), "utf8"), changed);
  } finally { await writerFence.release(); }
  await writeFile(join(f.root, "core.sqlite"), "Synthetic private DB bytes.");
  const indexed = spawnSync("/usr/bin/git", ["-C", f.root, "add", "-f", "core.sqlite"], { encoding: "utf8" });
  assert.equal(indexed.status, 0, indexed.stderr);
  assert.throws(() => planOriginalMcpGitProtection(f.root), /already tracked/);
  assert.equal(await readFile(join(f.root, "core.sqlite"), "utf8"), "Synthetic private DB bytes.");
});
