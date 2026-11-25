import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";

const python = execFileSync(process.env.PKM_TEST_PYTHON ?? process.env.PYTHON ?? "python3",
  ["-c", "import sys;print(sys.executable)"], { encoding: "utf8" }).trim();
const script = resolve("compat/legacy-action-azuredevops-query.py");
const inputs = { organization: "https://dev.azure.com/fixture", project: "Team Project", run_id: "42" };
async function fixture(t) {
  const directory = resolve("tests", `.azure-query-${randomUUID()}`);
  await mkdir(directory, { mode: 0o700 });
  t.after(() => rm(directory, { recursive: true, force: true }));
  const binary = join(directory, "az"), log = join(directory, "argv.jsonl");
  const configure = async mode => {
    await writeFile(binary, `#!${python}
import json,sys
with open(${JSON.stringify(log)},"a") as output: output.write(json.dumps(sys.argv[1:])+"\\n")
mode=${JSON.stringify(mode)}
if mode=="denied":
 sys.stderr.write("TF401019 SECRET_NEVER_EXPORTED");sys.exit(1)
if mode=="oversized":
 print("x"*70000);sys.exit(0)
if mode=="bad-json":
 print("invalid");sys.exit(0)
url=sys.argv[sys.argv.index("--url")+1]
if "/timeline?" in url:
 print(json.dumps([] if mode=="bad-timeline" else {"records":[{"name":"Current Task","state":"inProgress"}]}))
else:
 print(json.dumps({"id":42,"definition":{"id":7},"status":"inProgress" if mode=="observing" else "completed",
  "result":None if mode=="observing" else "succeeded"}))
`, { mode: 0o700 });
    await chmod(binary, 0o700);
  };
  const run = (value = inputs, path = `${directory}:${process.env.PATH}`) => JSON.parse(execFileSync(python, [script], {
    input: JSON.stringify(value), encoding: "utf8", timeout: 30_000,
    env: { ...process.env, PATH: path, PYTHONDONTWRITEBYTECODE: "1" },
  }));
  return { directory, binary, log, configure, run };
}

test("real read-only Azure CLI adapter uses exact GET argv and distinguishes observation from completion", async t => {
  const f = await fixture(t);
  for (const mode of ["observing", "completed"]) {
    await f.configure(mode);
    const value = f.run();
    assert.equal(value.ok, true);
    assert.equal(value.output.remote_id, "42");
    assert.equal(value.output.pipeline_id, "7");
    assert.equal(value.output.terminal, mode === "completed");
    assert.equal(value.output.result, mode === "completed" ? "succeeded" : null);
    assert.equal(value.output.tasks[0].name, "Current Task");
  }
  const calls = (await readFile(f.log, "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(calls.length, 4);
  for (const args of calls) {
    assert.equal(args[0], "rest");
    assert.deepEqual(args.slice(3), ["--method", "GET", "--resource", "499b84ac-1321-427f-aa17-267ca6975798",
      "--output", "json", "--only-show-errors"]);
    assert.match(args[2], /^https:\/\/dev\.azure\.com\/fixture\/Team%20Project\/_apis\/build\/builds\/42(?:\/timeline)?\?api-version=7\.1$/);
  }
});

test("Azure CLI query failures remain bounded, redacted and never claim remote completion", async t => {
  const f = await fixture(t);
  for (const [mode, code] of [["denied", "access_or_not_found"], ["oversized", "response_too_large"],
    ["bad-json", "invalid_response"], ["bad-timeline", "invalid_response"]]) {
    await f.configure(mode);
    const value = f.run();
    assert.equal(value.ok, false);
    assert.equal(value.failure.code, code);
    assert.equal(value.output, undefined);
    assert.doesNotMatch(JSON.stringify(value), /SECRET_NEVER_EXPORTED/);
  }
  assert.equal(f.run(null).failure.code, "invalid_input");
  assert.equal(f.run(inputs, "").failure.code, "missing_toolchain");
  assert.equal(f.run({ ...inputs, organization: "https://customer.invalid" }).failure.code, "invalid_input");
});
