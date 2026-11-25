import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { test } from "node:test";
import {
  acquireOriginalMcpRootFence,
  captureOriginalMcpCustody,
} from "../dist/original-mcp-root.js";
import { inspectOriginalMcpTrashCustody } from "../dist/original-mcp-trash-custody.js";

const sha256 = value => createHash("sha256").update(value).digest("hex");
const limits = { maxEntries: 1000, maxDepth: 32, maxBytes: 16_777_216, maxFileBytes: 8_388_608 };

async function fixture(t) {
  const directory = resolve("tests", `.original-trash-custody-${randomUUID()}`);
  const root = join(directory, "root");
  await mkdir(directory, { mode: 0o700 });
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const path of [
    "notes/public", "notes/.trash/opaque-old-id", "skills/.trash/other-old-id", "papers",
    ".pkm/state",
  ]) await mkdir(join(root, path), { recursive: true, mode: 0o700 });
  await writeFile(join(root, "notes/public/note.md"), "---\ntitle: Public\n---\nBody.\n", { mode: 0o600 });
  await writeFile(join(root, "notes/.trash/opaque-old-id/metadata.json"),
    '{"legacy":"do not reinterpret","surprising_shape":[1,2,3]}', { mode: 0o600 });
  await writeFile(join(root, "notes/.trash/opaque-old-id/payload"), "original payload bytes", { mode: 0o600 });
  await writeFile(join(root, "skills/.trash/other-old-id/unrecognized.bin"), Buffer.from([0, 255, 7, 9]), { mode: 0o600 });
  await writeFile(join(root, ".pkm/content-privacy.json"),
    JSON.stringify({ schema: 1, private: {} }), { mode: 0o600 });
  const backup = join(directory, "custody");
  return {
    root,
    request: {
      root, backup, operatorId: "trash-custody-fixture", profileSha256: sha256("isolated-profile"), limits,
    },
  };
}

async function snapshot(path, prefix = "") {
  const stat = await lstat(path, { bigint: true });
  const rows = [[prefix, String(stat.ino), Number(stat.mode), String(stat.size), String(stat.mtimeNs),
    String(stat.ctimeNs), stat.isFile() ? sha256(await readFile(path)) : null]];
  if (stat.isDirectory()) {
    for (const name of (await readdir(path)).sort())
      rows.push(...await snapshot(join(path, name), `${prefix}/${name}`));
  }
  return rows;
}

test("original Trash custody reports only a bounded opaque commitment and preserves nonempty legacy buckets", async t => {
  const f = await fixture(t);
  const before = await snapshot(f.root);
  const writerFence = await acquireOriginalMcpRootFence(f.root);
  t.after(() => writerFence.release());
  const plan = await captureOriginalMcpCustody(f.request, { writerFence });
  const receipt = await inspectOriginalMcpTrashCustody(plan, writerFence);

  assert.equal(receipt.schema, "pkm.original-mcp-trash-custody/v1");
  assert.equal(receipt.planSha256, plan.planSha256);
  assert.equal(receipt.areas[0].bucketCount, 1);
  assert.equal(receipt.areas[0].pathCount, 4);
  assert.equal(receipt.areas[0].fileCount, 2);
  assert.equal(receipt.areas[1].bucketCount, 1);
  assert.equal(receipt.areas[1].fileCount, 1);
  assert.equal(receipt.areas[2].exists, false);
  assert.doesNotMatch(JSON.stringify(receipt), /opaque-old-id|surprising_shape|original payload bytes|unrecognized\.bin/);
  assert.match(receipt.receiptSha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(await snapshot(f.root), before);
});

test("original Trash inspection refuses a forged fence before inspecting custody", async t => {
  const f = await fixture(t);
  const plan = await captureOriginalMcpCustody(f.request);
  await assert.rejects(inspectOriginalMcpTrashCustody(plan, {
    root: f.root, mode: "exclusive", assertHeld() {},
  }), /actual root writer fence/);
});
