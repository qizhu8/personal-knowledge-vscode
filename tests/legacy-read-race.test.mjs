import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { test } from "node:test";

test("legacy Markdown external-writer reads return exact snapshots or an explicit conflict", () => {
  const hook = resolve(import.meta.dirname, "legacy-read-race-hook.mjs");
  const runner = resolve(import.meta.dirname, "legacy-read-race-runner.mjs");
  const child = spawnSync(process.execPath, ["--import", hook, runner], {
    cwd: resolve(import.meta.dirname, ".."),
    encoding: "utf8",
    timeout: 60_000,
  });
  assert.ifError(child.error);
  assert.equal(child.status, 0, `race qualification runner failed\n${child.stdout}\n${child.stderr}`);
});
