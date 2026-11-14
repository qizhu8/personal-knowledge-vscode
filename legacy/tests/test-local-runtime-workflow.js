const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { pathToFileURL } = require("node:url");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const rootBuild = process.env.PKM_ENV_AUTHORITY_BUILD, nextBuild = process.env.PKM_ENV_NEXT_BUILD;
if (!rootBuild || !nextBuild) throw new Error("Set isolated PKM_ENV_AUTHORITY_BUILD and PKM_ENV_NEXT_BUILD.");
const { LocalEnvironmentCatalog } = require(path.join(rootBuild, "runtime/local-environment-catalog.js"));
const { LocalRuntimeAuthority } = require(path.join(rootBuild, "runtime/local-runtime-authority.js"));
const load = () => import(pathToFileURL(path.join(nextBuild, "host-local-environment-workflow.js")));
async function fixture(t) {
  const root = path.join(fs.realpathSync(process.cwd()), "tests", `.local-runtime-${randomUUID()}`);
  fs.mkdirSync(root, { mode: 0o700 });
  const services = [];
  t.after(async () => { for (const service of services.reverse()) await service.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const catalog = new LocalEnvironmentCatalog(path.join(root, "catalog"));
  catalog.register({ id: "node", name: "Local Node", language: "javascript", kind: "runtime", manager: "local",
    executors: [{ id: "node", executable: fs.realpathSync(process.execPath) }] }, catalog.read().digest);
  let trusted = true;
  const authority = new LocalRuntimeAuthority(() => trusted, catalog, path.join(root, "journal"));
  const journal = authority.selectJournal(randomUUID(), "local:owner");
  const handle = authority.selectRuntime(journal, "node", "node");
  const { HostLocalEnvironmentWorkflow } = await load();
  const open = (value = journal, recover = false) => {
    const service = new HostLocalEnvironmentWorkflow(value, root, recover); services.push(service); return service;
  };
  return { root, catalog, authority, journal, handle, open, services, setTrusted(value) { trusted = value; } };
}
async function until(fn, predicate) {
  const deadline = Date.now() + 30000;
  for (;;) {
    const result = await fn();
    if (predicate(result)) return result;
    if (Date.now() > deadline) assert.fail(JSON.stringify(result));
    await new Promise(resolve => setTimeout(resolve, 30));
  }
}
test("registered Node really executes fixed Workflow with exact arguments; cancellation and graceful restart never replay", { timeout: 40000 }, async t => {
  const f = await fixture(t), service = f.open(), args = ["two words", "--import=not-a-flag", "$(touch not-created)", "中文", ""];
  const old = process.env.NODE_OPTIONS; process.env.NODE_OPTIONS = "--invalid-inherited-option";
  t.after(() => { if (old === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = old; });
  const id = service.start(f.handle, { args, waitMs: 0 })[0].runId;
  const complete = await until(() => service.status(id)[0], run => run.state === "succeeded");
  assert.deepEqual(JSON.parse(complete.jobs[0].stdout.split("\n")[0]), { args });
  assert.equal(complete.jobs[0].exitCode, 0); assert(!fs.existsSync(path.join(f.root, "not-created")));
  const active = service.start(f.handle, { args: ["cancel"], waitMs: 20000 })[0].runId;
  await until(() => service.status(active)[0], run => run.jobs.some(job => job.state === "RUNNING" && job.stdout.includes("cancel")));
  service.cancel(active);
  const cancelled = await until(() => service.status(active)[0], run => run.jobs.every(job => job.state === "CANCELLED"));
  assert.equal(cancelled.state, "cancelled"); assert.equal(cancelled.effect, "unknown");
  await new Promise(resolve => setTimeout(resolve, 30));
  service.start(f.handle, { args: ["close"], waitMs: 20000 });
  await until(() => service.status()[0], run => run.jobs.some(job => job.state === "RUNNING"));
  await service.close();
  const nextJournal = f.authority.selectJournal(randomUUID(), "local:owner"), reopened = f.open(nextJournal);
  const states = reopened.status();
  assert(states.some(run => run.state === "unknown"));
  assert.equal(states.length, 3);
  assert.throws(() => reopened.start(f.handle, { args: [], waitMs: 0 }), /workspace\/actor/);
  const reselected = f.authority.selectRuntime(nextJournal, "node", "node");
  const fresh = reopened.start(reselected, { args: ["fresh"], waitMs: 0 })[0].runId;
  await until(() => reopened.status(fresh)[0], run => run.state === "succeeded");
  assert.equal(reopened.status().length, 4);
});
test("native capabilities reject unsupported languages, stale catalogs, cloned handles, revoked trust and tampered executables", async t => {
  const f = await fixture(t);
  assert.throws(() => f.authority.validateRuntime(structuredClone(f.handle), f.journal), /runtime changed/);
  f.catalog.register({ id: "other", name: "No generic provider", language: "ruby", kind: "runtime", manager: "local",
    executors: [{ id: "ruby", executable: process.execPath }] }, f.catalog.read().digest);
  assert.throws(() => f.authority.selectRuntime(f.journal, "other", "ruby"), /No qualified/);
  assert.throws(() => f.authority.validateRuntime(f.handle, f.journal), /runtime changed/);
  f.setTrusted(false);
  assert.throws(() => f.authority.validateJournal(f.journal, f.journal.workspaceId, "local:owner"), /authority unavailable/);
  f.setTrusted(true);
  assert.throws(() => f.authority.validateJournal(f.journal, f.journal.workspaceId, "local:owner"), /authority unavailable/);
  const { verifyLocalRuntime } = await load();
  assert.throws(() => verifyLocalRuntime({ ...f.handle, targetPin: { ...f.handle.targetPin, ino: "0" } }, f.journal.workspaceId), /pin changed/);
});
test("C# executor set uses installed .NET8 SDK for offline controlled compile and actual parameterized execution", { timeout: 40000 }, async t => {
  if (!fs.existsSync("/usr/bin/dotnet")) { t.skip("No local dotnet SDK executor; nothing installed."); return; }
  const f = await fixture(t);
  f.catalog.register({ id: "csharp", name: "Installed C# executor set", language: "csharp", kind: "executor-set", manager: "local",
    executors: [{ id: "dotnet", executable: "/usr/bin/dotnet" }] }, f.catalog.read().digest);
  const handle = f.authority.selectRuntime(f.journal, "csharp", "dotnet"), service = f.open();
  let id;
  try { id = service.start(handle, { args: ["dotnet argument", "--not-cli", "中文"], waitMs: 0 })[0].runId; }
  catch (error) {
    if (/SDK\/reference\/runtime pack is unavailable/.test(error.message)) { t.skip(error.message); return; }
    throw error;
  }
  const result = await until(() => service.status(id)[0], run => !["ready", "running"].includes(run.state));
  assert.equal(result.state, "succeeded", JSON.stringify(result));
  assert.deepEqual(result.jobs.map(job => job.phase), ["compile", "run"]);
  assert.deepEqual(JSON.parse(result.jobs[1].stdout.split("\n")[0]), { args: ["dotnet argument", "--not-cli", "中文"] });
  assert.equal(result.jobs[1].exitCode, 0);
  const active = service.start(handle, { args: ["csharp-cancel"], waitMs: 20000 })[0].runId;
  await until(() => service.status(active)[0], run => run.jobs.some(job => job.phase === "run" && job.state === "RUNNING"
    && job.stdout.includes("csharp-cancel")));
  service.cancel(active);
  const cancelled = await until(() => service.status(active)[0], run => run.jobs.some(job => job.phase === "run" && job.state === "CANCELLED"));
  assert.equal(cancelled.state, "cancelled"); assert.equal(cancelled.effect, "unknown");
  assert.equal(cancelled.jobs[0].state, "SUCCEEDED");
});
test("C# without a matching installed SDK refuses before any process or run is created; no fallback installer", async t => {
  const f = await fixture(t);
  f.catalog.register({ id: "missing-sdk", name: "Unqualified SDK", language: "csharp", kind: "executor-set", manager: "local",
    executors: [{ id: "selected", executable: process.execPath }] }, f.catalog.read().digest);
  const handle = f.authority.selectRuntime(f.journal, "missing-sdk", "selected"), service = f.open();
  assert.throws(() => service.start(handle, { args: [], waitMs: 0 }), /unavailable.*Nothing was downloaded or installed/);
  assert.deepEqual(service.status(), []);
});
test("Runtime drain failure preserves its repository and an unclosed journal instead of announcing successful release", async t => {
  const f = await fixture(t), service = f.open();
  f.services.pop();
  const runtime = service.runtime, close = runtime.close.bind(runtime);
  runtime.close = async () => { throw new Error("Injected REAP_TIMEOUT; owned child outcome unknown"); };
  try {
    await assert.rejects(service.close(), /REAP_TIMEOUT/);
    assert.equal(service.database.prepare("SELECT closed FROM local_environment_owner WHERE singleton=1").get().closed, 0);
    assert.throws(() => service.status(), /lease lost/);
  } finally { await close({ drainMs: 0 }); service.database.close(); }
});
test("actual SIGKILL recovery fences unexpired Workflow assignments as UNKNOWN and never replays", { timeout: 30000 }, async t => {
  const f = await fixture(t), second = f.authority.selectJournal(randomUUID(), "local:owner");
  const helper = path.resolve("tests/local-runtime-crash-host.mjs");
  const result = await promisify(execFile)("unshare", require("../scripts/run-next-trial-private-display").privateNamespaceArgs([
    process.execPath, helper, nextBuild, f.root, JSON.stringify(f.journal), JSON.stringify(f.handle), JSON.stringify(second),
  ]), { cwd: f.root, env: { PATH: process.env.PATH }, timeout: 25000 });
  assert.match(result.stdout, /PASS no replay/);
});
test("private installed child requires exact one-use native grants and revalidates the catalog before actual launch", { timeout: 120000 }, async t => {
  const f = await fixture(t), extension = path.join(f.root, "extension");
  fs.mkdirSync(extension, { mode: 0o700 });
  fs.copyFileSync(path.resolve("package.json"), path.join(extension, "package.json"));
  if (process.env.PKM_ENV_FROZEN_RUNTIME)
    fs.cpSync(process.env.PKM_ENV_FROZEN_RUNTIME, path.join(extension, "next-runtime"), { recursive: true, errorOnExist: true, force: false });
  else require("../scripts/next-rehearsal-runtime").stage(path.join(extension, "next-runtime"), { production: true });
  const { NextManagedClient } = require(path.join(rootBuild, "runtime/next-managed-client.js"));
  const client = new NextManagedClient();
  f.services.push(client);
  const trial = path.join(f.root, "trial"), legacy = path.join(f.root, "legacy");
  fs.mkdirSync(trial, { mode: 0o700 }); fs.mkdirSync(legacy, { mode: 0o700 });
  const workspaceId = await client.start(extension, trial, fs.realpathSync(process.execPath), legacy);
  const journal = f.authority.selectJournal(workspaceId, "local:owner"), runtime = f.authority.selectRuntime(journal, "node", "node");
  const command = value => client.localEnvironmentCommand(f.authority, journal, value);
  await command({ operation: "open", recover: false });
  await assert.rejects(client.request({ type: "environment-command", approvalId: randomUUID(),
    grant: { operation: "start", journal, runtime, parameters: { args: ["forged"], waitMs: 0 } } }), /approval rejected/);
  await assert.rejects(command({ operation: "start", runtime: structuredClone(runtime), parameters: { args: [], waitMs: 0 } }), /runtime changed/);
  await assert.rejects(client.request({ type: "environment-command", approvalId: randomUUID(),
    grant: { operation: "start", journal, runtime, parameters: { args: [], waitMs: 0, script: "arbitrary()" } } }), /before admission/);
  const validate = f.authority.validateRuntime.bind(f.authority);
  let checks = 0;
  f.authority.validateRuntime = (...args) => { if (++checks > 1) throw new Error("Catalog revoked at child challenge"); return validate(...args); };
  await assert.rejects(command({ operation: "start", runtime, parameters: { args: ["revoked"], waitMs: 0 } }), /approval rejected/);
  f.authority.validateRuntime = validate;
  assert.deepEqual(await command({ operation: "status" }), []);
  const initial = await command({ operation: "start", runtime, parameters: { args: ["real-private-child"], waitMs: 0 } });
  const runId = initial[0].runId;
  const deadline = Date.now() + 10000;
  let run;
  do {
    run = (await command({ operation: "status" })).find(item => item.runId === runId);
    if (run.state === "succeeded") break;
    await new Promise(resolve => setTimeout(resolve, 50));
  } while (Date.now() < deadline);
  assert.equal(run.state, "succeeded", JSON.stringify(run));
  assert.deepEqual(JSON.parse(run.jobs[0].stdout.split("\n")[0]), { args: ["real-private-child"] });
  const project = path.join(f.root, "actual-project"), entrypoint = path.join(project, "index.cjs");
  fs.mkdirSync(project, { mode: 0o700 });
  fs.writeFileSync(path.join(project, "package.json"), '{"name":"private-ipc-project","type":"commonjs"}');
  const projectSource = `require("node:fs").appendFileSync("effects.jsonl","once\\n");console.log(JSON.stringify({cwd:process.cwd(),entry:__filename,args:process.argv.slice(2)}));`;
  fs.writeFileSync(entrypoint, projectSource);
  f.catalog.register({ id: "project", name: "Actual Node project", language: "javascript", kind: "environment",
    manager: "node-project", root: project, executors: [{ id: "node", executable: process.execPath }] }, f.catalog.read().digest);
  let projectHandle = f.authority.selectRuntime(journal, "project", "node", entrypoint);
  checks = 0;
  f.authority.validateRuntime = (...args) => {
    if (++checks > 1) fs.appendFileSync(entrypoint, "\n// changed at the private child challenge");
    return validate(...args);
  };
  await assert.rejects(command({ operation: "start", runtime: projectHandle, parameters: { args: ["denied"], waitMs: 0 } }), /approval rejected/);
  f.authority.validateRuntime = validate;
  assert(!fs.existsSync(path.join(project, "effects.jsonl")));
  fs.writeFileSync(entrypoint, projectSource);
  projectHandle = f.authority.selectRuntime(journal, "project", "node", entrypoint);
  const started = await command({ operation: "start", runtime: projectHandle, parameters: { args: ["actual", "--not-a-flag"], waitMs: 0 } });
  const completed = await until(async () => (await command({ operation: "status" })).find(item => item.runId === started[0].runId),
    item => item?.state === "succeeded");
  assert.deepEqual(JSON.parse(completed.jobs[0].stdout), { cwd: project, entry: entrypoint, args: ["actual", "--not-a-flag"] });
  assert.equal(fs.readFileSync(path.join(project, "effects.jsonl"), "utf8"), "once\n");
  await client.close();
});
