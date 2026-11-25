import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";

test("legacy Markdown external-writer reads return exact snapshots or an explicit conflict", () => {
  const hook = resolve(import.meta.dirname, "legacy-read-race-hook.mjs");
  const runner = resolve(import.meta.dirname, "legacy-read-race-runner.mjs");
  const child = spawnSync(process.execPath, ["--import", hook, runner], {
    cwd: resolve(import.meta.dirname, ".."),
    encoding: "utf8",
    timeout: 240_000,
  });
  if (child.error) throw new Error(`Race runner failed\n${child.stdout}\n${child.stderr}`, { cause: child.error });
  assert.equal(child.status, 0, `race qualification runner failed\n${child.stdout}\n${child.stderr}`);
  if (process.env.PKM_TEST_REPORTS) {
    const report = JSON.parse(readFileSync(resolve(process.env.PKM_TEST_REPORTS, "legacy-read-race-candidate.json"), "utf8"));
    const completed = [...child.stdout.matchAll(/^PASS (.+)$/gm)].map(match => match[1]);
    assert.equal(completed.length, 6);
    assert.deepEqual(report.cases.filter(row => row.mixedOrPartialResultReturned === false).map(row => row.id), completed);
    assert.equal(report.cases.some(row => row.mixedAggregateWasConstructed === true && row.mixedAggregateWasReturned === false), true);
  }
});
