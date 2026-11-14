import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execute = promisify(execFile);
const cli = resolve(import.meta.dirname, "../dist/cli.js");
const python = execFileSync("python3", ["-c", "import sys; print(sys.executable)"], { encoding: "utf8" }).trim();
const ack = "--acknowledge-quiescent-disposable-copy";

test("legacy import creates a fresh workspace but cannot reimport that workspace as legacy", { timeout: 60000 }, async t => {
  const parent = resolve(import.meta.dirname, `.import-lineage-${randomUUID()}`);
  const source = join(parent, "legacy"), destination = join(parent, "native");
  await mkdir(join(source, "notes"), { recursive: true });
  t.after(() => rm(parent, { recursive: true, force: true }));
  const contents = "---\ntitle: Synthetic\n---\nFixture only.\n";
  await writeFile(join(source, "notes", "synthetic.md"), contents);
  const run = (...args) => execute(process.execPath, [cli, ...args], { timeout: 30000 });

  const plan = JSON.parse((await run("import-plan", "--source", source, ack)).stdout).plan;
  assert.equal(plan.ready, true, JSON.stringify(plan.blockers));
  const receipt = JSON.parse((await run("import", "--source", source, "--destination", destination,
    "--plan-sha256", plan.planSha256, "--python", python, ack)).stdout).receipt;
  assert.equal(receipt.fingerprint, plan.fingerprint);
  assert.equal((JSON.parse((await run("import-status", "--destination", destination)).stdout)).outcome.status, "published");
  assert.equal(await readFile(join(source, "notes", "synthetic.md"), "utf8"), contents);
  assert.equal(await readFile(join(destination, "notes", "synthetic.md"), "utf8"), contents);

  await assert.rejects(run("import-plan", "--source", destination, ack), error => {
    const blocked = JSON.parse(error.stdout).plan;
    assert.equal(blocked.ready, false);
    assert(blocked.blockers.some(blocker => blocker.path === ".pkm-next-workspace"));
    assert(blocked.blockers.some(blocker => blocker.path === "core.sqlite"));
    return true;
  });
});
