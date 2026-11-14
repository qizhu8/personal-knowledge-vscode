// Opt-in replay of existing domain-specific recovery tests, separate from syscall-fault claims.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const groups = [
  { file: "tests/todo.test.mjs", pattern: "pending Todo journal recovers|Todo journal recognizes", expected: 2 },
  { file: "tests/trash-lifecycle.test.mjs", pattern: "intent is persisted under host lock|paired partial interruption|unknown recovery tree", expected: 3 },
  { file: "tests/document-lifecycle.test.mjs", pattern: "exact fully written staging can recover|recovery preflights every tree", expected: 2 },
  { file: "tests/folder-lifecycle.test.mjs", pattern: "nested multi-document move pins|recovery starts from the exact untouched source phase|rejects destination replacement, unknown subtree bytes", expected: 3 },
  { file: "tests/sync-apply.test.mjs", pattern: "durable recovery rolls forward|recovery refuses a newer decision revision", expected: 2 },
  { file: "tests/coding-worker.test.mjs", pattern: "partially applied two-file Integrator crash|restart with a completed delivery", expected: 2 },
];
const paths = [...groups.map(group => group.file), "tests/storage-fault-qualification-domain.mjs",
  "tests/trash-lifecycle-fixture.mjs", "tests/sync-apply-fixture.mjs", "tests/coding-worker-fixtures.mjs",
  "src/boards.ts", "src/trash-lifecycle.ts", "src/document-lifecycle.ts", "src/folder-lifecycle.ts", "src/sync-apply.ts", "src/coding-worker.ts",
  "dist/boards.js", "dist/trash-lifecycle.js", "dist/document-lifecycle.js", "dist/folder-lifecycle.js", "dist/sync-apply.js", "dist/coding-worker.js"];
const digest = async path => createHash("sha256").update(await readFile(path)).digest("hex");
const sources = Object.fromEntries(await Promise.all(paths.map(async path => [path, await digest(path)])));
const temp = resolve("tests", `.storage-fault-qualification-domains-${randomUUID()}`);
await mkdir(temp);
const results = [];
try {
  for (const group of groups) {
    const processChild = spawn(process.execPath, ["--test", "--test-concurrency=1", "--test-name-pattern", group.pattern, group.file], {
      cwd: resolve("."), env: { ...process.env, TMPDIR: temp, TMP: temp, TEMP: temp }, stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    processChild.stdout.on("data", bytes => { output += bytes; });
    processChild.stderr.on("data", bytes => { output += bytes; });
    const [code, signal] = await once(processChild, "close");
    assert.equal(signal, null, output);
    assert.equal(code, 0, output);
    const match = output.match(/^# pass (\d+)$/m);
    assert.equal(Number(match?.[1]), group.expected, output);
    results.push({ ...group, passed: Number(match[1]) });
  }
  for (const [path, hash] of Object.entries(sources)) assert.equal(await digest(path), hash, `source changed: ${path}`);
  const report = { schema: "pkm.domain-recovery-qualification/v1", node: process.version, sources, results,
    scope: "existing synthetic domain fixture tests, not production I/O injection or a combined cross-domain crash",
    powerLossClaim: false, readinessApproval: false };
  console.log("STORAGE_DOMAIN_QUALIFICATION " + JSON.stringify(report));
  if (process.env.STORAGE_QUALIFICATION_SAVE === "1") {
    await writeFile("tests/storage-fault-qualification-domain-report.json", JSON.stringify(report, null, 2) + "\n");
  }
} finally {
  await rm(temp, { recursive: true, force: true });
}
