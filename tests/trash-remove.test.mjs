import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import test from "node:test";
import { removeTrashBucket } from "../dist/trash-remove.js";

for (const code of ["EPERM", "EACCES", "EBUSY", "ENOTEMPTY", "EMFILE", "ENFILE"]) {
  test(`Trash deletion retries transient ${code} without blocking the event loop`, async () => {
    let attempts = 0;
    const waits = [];
    await removeTrashBucket("preflighted-bucket", {
      async remove() { if (++attempts < 3) throw Object.assign(new Error("locked"), { code }); },
      async sleep(delay) { waits.push(delay); },
    });
    assert.equal(attempts, 3);
    assert.deepEqual(waits, [50, 100]);
  });
}
test("permanent Windows sharing/access failures remain explicit after bounded retries", async () => {
  const error = Object.assign(new Error("persistent Windows sharing violation"), { code: "EPERM" });
  let attempts = 0;
  const waits = [];
  await assert.rejects(removeTrashBucket("preflighted-bucket", {
    async remove() { attempts++; throw error; },
    async sleep(delay) { waits.push(delay); },
  }), value => value === error);
  assert.equal(attempts, 8);
  assert.deepEqual(waits, [50, 100, 200, 400, 800, 800, 800]);
});
test("missing buckets are idempotent; nonretryable IO errors are not hidden", async () => {
  await removeTrashBucket("preflighted-bucket", {
    async remove() { throw Object.assign(new Error("gone"), { code: "ENOENT" }); },
    async sleep() { assert.fail("ENOENT must not retry"); },
  });
  const error = Object.assign(new Error("device failure"), { code: "EIO" });
  await assert.rejects(removeTrashBucket("preflighted-bucket", {
    async remove() { throw error; },
    async sleep() { assert.fail("EIO must not retry"); },
  }), value => value === error);
});
test("real filesystem deletion handles nested paired assets, readonly files and absent retries", async t => {
  const root = resolve(import.meta.dirname, `.trash-remove-${randomUUID()}`);
  const bucket = join(root, "bucket"), sentinel = join(root, "active.md");
  await mkdir(join(bucket, "assets/empty"), { recursive: true });
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(sentinel, "active data must survive");
  await writeFile(join(bucket, "payload"), "original payload");
  await writeFile(join(bucket, "assets/image.bin"), Buffer.from([0, 255, 128]));
  await chmod(join(bucket, "assets/image.bin"), 0o400);
  await removeTrashBucket(bucket);
  await assert.rejects(readFile(join(bucket, "payload")), { code: "ENOENT" });
  await assert.rejects(readFile(join(bucket, "assets/image.bin")), { code: "ENOENT" });
  assert.equal(await readFile(sentinel, "utf8"), "active data must survive");
  await removeTrashBucket(bucket);
});
