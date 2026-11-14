import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");
for (const name of ["runtime-process", "workflow-executor"]) {
  test(`${name} --check preserves captured bytes and nanosecond mtimes`, async () => {
    const provenance = `migration/${name}-provenance.json`;
    const record = JSON.parse(await readFile(resolve(root, provenance), "utf8"));
    const paths = [...new Set([provenance, ...record.files.map(file => file.captured)])];
    const before = await Promise.all(paths.map(async path => ({
      path, bytes: await readFile(resolve(root, path)), mtime: (await stat(resolve(root, path), { bigint: true })).mtimeNs,
    })));
    execFileSync(process.execPath, [`scripts/capture-${name}.mjs`, "--check"], { cwd: root, stdio: "pipe" });
    for (const file of before) {
      assert.deepEqual(await readFile(resolve(root, file.path)), file.bytes, file.path);
      assert.equal((await stat(resolve(root, file.path), { bigint: true })).mtimeNs, file.mtime, file.path);
    }

  });
}

test("native-only qualification --check preserves bytes and nanosecond mtimes", async () => {
  const path = resolve(root, "migration/native-qualification.json");
  const bytes = await readFile(path);
  const mtime = (await stat(path, { bigint: true })).mtimeNs;
  execFileSync(process.execPath, ["scripts/capture-native-qualification.mjs", "--check"], { cwd: root, stdio: "pipe" });
  assert.deepEqual(await readFile(path), bytes);
  assert.equal((await stat(path, { bigint: true })).mtimeNs, mtime);
});

test("Manager native-only provenance --check preserves exact bytes and nanosecond mtimes", async () => {
  const path = resolve(root, "migration/manager-chat-provenance.json");
  const bytes = await readFile(path), mtime = (await stat(path, { bigint: true })).mtimeNs;
  execFileSync(process.execPath, ["scripts/capture-manager-chat.mjs", "--check"], { cwd: root, stdio: "pipe" });
  assert.deepEqual(await readFile(path), bytes);
  assert.equal((await stat(path, { bigint: true })).mtimeNs, mtime);
});
