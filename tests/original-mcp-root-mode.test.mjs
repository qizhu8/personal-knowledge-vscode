import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { acquireLinuxRootWriterFence } from "../dist/linux-root-writer-fence.js";
import { planOriginalMcpRootMode, applyOriginalMcpRootMode } from "../dist/original-mcp-root-mode.js";

test("explicit backed root hardening keeps every child byte/mode/inode and the same fence", async t => {
  const parent = resolve("tests", `.original-mode-${randomUUID()}`);
  const root = join(parent, "original");
  await mkdir(root, { recursive: true, mode: 0o700 });
  t.after(() => rm(parent, { recursive: true }));
  await chmod(root, 0o775);
  const child = join(root, "unchanged.db");
  await writeFile(child, "Synthetic protected DB bytes.", { mode: 0o640 });
  const before = await lstat(child, { bigint: true });
  const plan = planOriginalMcpRootMode(root);
  assert.equal(plan.fromMode, 0o775);
  assert.equal((await lstat(root)).mode & 0o777, 0o775);
  await assert.rejects(applyOriginalMcpRootMode(plan,
    { writerFence: { root, assertHeld() {} }, backupDirectory: join(parent, "bad"), approvedMode: 0o700 }), /ROOT_MODE/);
  const writerFence = await acquireLinuxRootWriterFence(root);
  try {
    const result = await applyOriginalMcpRootMode(plan,
      { writerFence, backupDirectory: join(parent, "mode-backup"), approvedMode: 0o700 });
    assert.equal(result.changed, true);
    writerFence.assertHeld();
    assert.equal((await lstat(root)).mode & 0o777, 0o700);
    const receipt = JSON.parse(await readFile(result.receiptPath, "utf8"));
    assert.equal(receipt.plan.fromMode, 0o775);
    const after = await lstat(child, { bigint: true });
    for (const key of ["dev", "ino", "mode", "size", "mtimeNs", "ctimeNs"]) assert.equal(after[key], before[key]);
    assert.equal(await readFile(child, "utf8"), "Synthetic protected DB bytes.");
    await assert.rejects(applyOriginalMcpRootMode(plan,
      { writerFence, backupDirectory: join(parent, "stale"), approvedMode: 0o700 }), /ROOT_MODE/);
  } finally { await writerFence.release(); }
  const alias = join(parent, "alias");
  await symlink(root, alias);
  assert.throws(() => planOriginalMcpRootMode(alias), /ROOT_MODE/);
});
