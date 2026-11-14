const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), { randomUUID } = require("node:crypto");
const { pathToFileURL } = require("node:url"), { promisify } = require("node:util"), { execFile } = require("node:child_process");
const rootBuild = process.env.PKM_ENV_AUTHORITY_BUILD, nextBuild = process.env.PKM_ENV_NEXT_BUILD;
if (!rootBuild || !nextBuild) throw Error("Set isolated PKM_ENV_AUTHORITY_BUILD and PKM_ENV_NEXT_BUILD.");
const { LocalEnvironmentCatalog } = require(path.join(rootBuild, "runtime/local-environment-catalog.js"));
const { LocalRuntimeAuthority } = require(path.join(rootBuild, "runtime/local-runtime-authority.js"));
const { discoverLocalExecutors, inspectNodeProject } = require(path.join(rootBuild, "runtime/local-node-project.js"));
const source = `const fs=require("node:fs");
const args=process.argv.slice(2);
fs.appendFileSync("effects.jsonl",JSON.stringify({args})+"\\n");
console.log(JSON.stringify({args,cwd:process.cwd(),entry:__filename,helper:require("./helper.cjs"),main:require.main===module,nodeOptions:process.env.NODE_OPTIONS??null}));
if(args[0]==="hold"||args[0]==="crash-once"){process.stdout.on("error",()=>process.exit(1));setInterval(()=>process.stdout.write("alive\\n"),100);}`;
async function fixture(t) {
  const root = path.join(fs.realpathSync(process.cwd()), "tests", `.node-project-${randomUUID()}`);
  const project = path.join(root, "project"); fs.mkdirSync(project, { recursive: true, mode: 0o700 });
  fs.chmodSync(root, 0o700);
  fs.writeFileSync(path.join(project, "package.json"), JSON.stringify({ name: "private-node-project", type: "commonjs",
    main: "index.cjs", scripts: { preinstall: "never-run", start: "never-run" } }));
  fs.writeFileSync(path.join(project, "index.cjs"), source);
  fs.writeFileSync(path.join(project, "helper.cjs"), 'module.exports="real-local-import";');
  const services = [], catalog = new LocalEnvironmentCatalog(path.join(root, "catalog"));
  catalog.register({ id: "project", name: "Real project", language: "javascript", kind: "environment", manager: "node-project",
    root: project, executors: [{ id: "node", executable: fs.realpathSync(process.execPath) }] }, catalog.read().digest);
  const authority = new LocalRuntimeAuthority(() => true, catalog, path.join(root, "journal"));
  const journal = authority.selectJournal(randomUUID(), "local:owner");
  const select = (value = journal) => authority.selectRuntime(value, "project", "node", path.join(project, "index.cjs"));
  const module = await import(pathToFileURL(path.join(nextBuild, "host-local-environment-workflow.js")));
  const open = (value = journal) => { const service = new module.HostLocalEnvironmentWorkflow(value, root, false); services.push(service); return service; };
  t.after(async () => { for (const service of services.reverse()) await service.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const effects = () => fs.existsSync(path.join(project, "effects.jsonl"))
    ? fs.readFileSync(path.join(project, "effects.jsonl"), "utf8").trim().split("\n").map(JSON.parse) : [];
  return { root, project, catalog, authority, journal, select, open, effects, module };
}
async function until(read, predicate) {
  const deadline = Date.now() + 15000;
  for (;;) { const value = read(); if (predicate(value)) return value;
    if (Date.now() > deadline) assert.fail(JSON.stringify(value)); await new Promise(resolve => setTimeout(resolve, 25)); }
}
test("native Node project executes actual CommonJS imports/main/CWD/literal argv, cancels and reopens without replay", async t => {
  const f = await fixture(t), selected = f.select(), service = f.open();
  const old = process.env.NODE_OPTIONS; process.env.NODE_OPTIONS = "--invalid-inherited-option";
  t.after(() => { if (old === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = old; });
  const args = ["two words", "--eval=not-code", "$(touch never-created)", "中文", ""];
  const id = service.start(selected, { args, waitMs: 0 })[0].runId;
  const done = await until(() => service.status(id)[0], run => run.state === "succeeded");
  assert.deepEqual(JSON.parse(done.jobs[0].stdout), { args, cwd: f.project, entry: path.join(f.project, "index.cjs"),
    helper: "real-local-import", main: true, nodeOptions: null });
  assert(!fs.existsSync(path.join(f.project, "never-created")));
  const active = service.start(f.select(), { args: ["hold"], waitMs: 0 })[0].runId;
  await until(() => service.status(active)[0], run => run.jobs.some(job => job.state === "RUNNING" && job.stdout.includes("hold")));
  service.cancel(active);
  const cancelled = await until(() => service.status(active)[0], run => run.jobs.some(job => job.state === "CANCELLED"));
  assert.equal(cancelled.effect, "unknown");
  await service.close();
  const second = f.authority.selectJournal(randomUUID(), "local:owner"), reopened = f.open(second);
  assert.equal(reopened.status().length, 2); assert.equal(f.effects().length, 2);
  assert.throws(() => reopened.start(selected, { args: [], waitMs: 0 }), /workspace\/actor/);
  const fresh = reopened.start(f.select(second), { args: ["fresh"], waitMs: 0 })[0].runId;
  await until(() => reopened.status(fresh)[0], run => run.state === "succeeded");
  assert.equal(f.effects().length, 3);
});
test("project source/package/new lock/format/path/mapping failures refuse before jobs and require fresh selection", async t => {
  const f = await fixture(t), service = f.open(), file = path.join(f.project, "index.cjs"), selected = f.select();
  assert.throws(() => f.authority.validateRuntime(structuredClone(selected), f.journal), /runtime changed/);
  fs.appendFileSync(file, "\n// changed");
  assert.throws(() => f.authority.validateRuntime(selected, f.journal), /changed/);
  assert.throws(() => service.start(selected, { args: [], waitMs: 0 }), /changed/);
  fs.writeFileSync(file, source);
  assert.throws(() => f.authority.validateRuntime(selected, f.journal), /runtime changed/);
  for (const [name, value] of [["package.json", '{"name":"changed"}'], ["package-lock.json", '{"lockfileVersion":3}']]) {
    const handle = f.select(), target = path.join(f.project, name), original = fs.existsSync(target) ? fs.readFileSync(target) : undefined;
    fs.writeFileSync(target, value);
    assert.throws(() => service.start(handle, { args: [], waitMs: 0 }), /changed/);
    if (original) fs.writeFileSync(target, original); else fs.unlinkSync(target);
  }
  const handle = f.select();
  assert.throws(() => service.start({ ...handle, project: { ...handle.project, entry: "../outside.cjs" } }, { args: [], waitMs: 0 }));
  fs.writeFileSync(path.join(f.project, "package.json"), '{"type":"module","main":"index.js"}');
  fs.writeFileSync(path.join(f.project, "index.js"), "export default 1");
  const esm = f.authority.selectRuntime(f.journal, "project", "node", path.join(f.project, "index.js"));
  assert.equal(esm.project.format, "module");
  assert.throws(() => service.start({ ...esm, project: { ...esm.project, format: "commonjs" } }, { args: [], waitMs: 0 }), /format/);
  assert.throws(() => f.authority.selectRuntime(f.journal, "project", "node", path.join(f.project, "missing.cjs")));
  const current = f.catalog.read();
  f.catalog.configureRuntime("project", "Explicit replacement", [{ id: "node", executable: process.execPath }], current.digest);
  assert.throws(() => f.authority.validateRuntime(handle, f.journal), /runtime changed/);
  assert.deepEqual(service.status(), []); assert.deepEqual(f.effects(), []);
});
test("missing local project dependency fails with receipts and never runs package installation hooks", async t => {
  const f = await fixture(t), file = path.join(f.project, "index.cjs");
  fs.writeFileSync(file, "require('not-an-installed-pkm-fixture-package')");
  const service = f.open(), id = service.start(f.select(), { args: [], waitMs: 0 })[0].runId;
  const failed = await until(() => service.status(id)[0], run => run.state === "failed");
  assert.match(failed.jobs[0].stderr, /Cannot find module 'not-an-installed-pkm-fixture-package'/); assert.equal(failed.jobs[0].exitCode, 1);
  assert(!fs.existsSync(path.join(f.project, "node_modules"))); assert.deepEqual(f.effects(), []);
});
test("ESM mjs/module js and native TypeScript reuse installed Node, imports/URL/TLA/argv and cancellation use real Workflow", async t => {
  const f = await fixture(t), service = f.open();
  fs.writeFileSync(path.join(f.project, "package.json"), '{"name":"esm-local","type":"module"}');
  fs.writeFileSync(path.join(f.project, "helper.mjs"), 'export const helper="installed-local-esm";');
  fs.writeFileSync(path.join(f.project, "typed-helper.ts"), 'export const typed: string="installed-local-typescript";');
  for (const entry of ["index.mjs", "index.js", "index.mts", "index.ts"]) {
    const ts = /\.(mts|ts)$/.test(entry);
    const file = path.join(f.project, entry);
    fs.writeFileSync(file, `import {appendFileSync} from "node:fs";import {helper} from "./helper.mjs";
${ts ? 'import {typed} from "./typed-helper.ts";const value: string=typed;' : 'const value="plain-js";'}
await Promise.resolve();
const args=process.argv.slice(2);appendFileSync("effects.jsonl",JSON.stringify({args})+"\\n");
console.log(JSON.stringify({args,cwd:process.cwd(),url:import.meta.url,main:import.meta.main,helper,value}));
if(args[0]==="hold"){setInterval(()=>console.log("alive"),100);}`);
    const selected = f.authority.selectRuntime(f.journal, "project", "node", file);
    const id = service.start(selected, { args: ["two words", "--literal", ""], waitMs: 0 })[0].runId;
    const done = await until(() => service.status(id)[0], run => !["ready", "running"].includes(run.state));
    assert.equal(done.state, "succeeded", JSON.stringify(done));
    assert.deepEqual(JSON.parse(done.jobs[0].stdout), { args: ["two words", "--literal", ""], cwd: f.project,
      url: pathToFileURL(file).href, main: true, helper: "installed-local-esm", value: ts ? "installed-local-typescript" : "plain-js" });
  }
  const file = path.join(f.project, "index.mjs"), selected = f.authority.selectRuntime(f.journal, "project", "node", file);
  const id = service.start(selected, { args: ["hold"], waitMs: 0 })[0].runId;
  await until(() => service.status(id)[0], run => run.jobs.some(job => job.stdout.includes("hold")));
  service.cancel(id);
  const cancelled = await until(() => service.status(id)[0], run => run.jobs.some(job => job.state === "CANCELLED"));
  assert.equal(cancelled.effect, "unknown");
  const stale = f.authority.selectRuntime(f.journal, "project", "node", file);
  fs.writeFileSync(path.join(f.project, "package.json"), '{"type":"commonjs"}');
  assert.throws(() => service.start(stale, { args: [], waitMs: 0 }), /changed/);
  assert.equal(f.effects().length, 5);
});
test("cts uses installed Node stripping only; non-erasable TypeScript fails without executing installation scripts", async t => {
  const f = await fixture(t), service = f.open(), file = path.join(f.project, "index.cts");
  fs.writeFileSync(file, 'const value: string="strip-only"; console.log(JSON.stringify({value,main:require.main===module}));');
  const select = () => f.authority.selectRuntime(f.journal, "project", "node", file);
  const id = service.start(select(), { args: [], waitMs: 0 })[0].runId;
  const done = await until(() => service.status(id)[0], run => !["ready", "running"].includes(run.state));
  assert.equal(done.state, "succeeded", JSON.stringify(done));
  assert.deepEqual(JSON.parse(done.jobs[0].stdout), { value: "strip-only", main: true });
  fs.writeFileSync(file, 'enum MustNotCompile { Value }; console.log(MustNotCompile.Value);');
  const failedId = service.start(select(), { args: [], waitMs: 0 })[0].runId;
  const failed = await until(() => service.status(failedId)[0], run => run.state === "failed");
  assert.match(failed.jobs[0].stderr, /enum|strip-only|TypeScript/);
  assert(!fs.existsSync(path.join(f.project, "node_modules")));
  assert.deepEqual(f.effects(), []);
});
test("C# named executor discovery is read-only and reconfiguration preserves ID/no venv, invalidates native approval and restores metadata", async t => {
  const f = await fixture(t), bin = path.join(f.root, "bin"); fs.mkdirSync(bin);
  fs.symlinkSync(fs.realpathSync(process.execPath), path.join(bin, "dotnet"));
  fs.writeFileSync(path.join(bin, "csc"), '#!/bin/sh\n: > "$0.executed"\nexit 91\n', { mode: 0o700 });
  const found = discoverLocalExecutors(bin, "csharp");
  assert.deepEqual(found.map(item => item.id), ["dotnet", "csc"]);
  const original = fs.readFileSync(path.join(bin, "csc"));
  const initial = f.catalog.register({ id: "cs", name: "Tools, not venv", language: "csharp", kind: "executor-set", manager: "local",
    executors: found.map(({ id, executable }) => ({ id, executable })) }, f.catalog.read().digest);
  assert.equal(initial.catalog.entries.find(item => item.id === "cs").root, undefined);
  const handle = f.authority.selectRuntime(f.journal, "cs", "dotnet");
  const updated = f.catalog.configureRuntime("cs", "Explicit configured tools", [found[0]].map(({ id, executable }) => ({ id, executable })), initial.digest);
  assert.equal(updated.catalog.entries.find(item => item.id === "cs").id, "cs");
  assert.throws(() => f.authority.validateRuntime(handle, f.journal), /runtime changed/);
  assert.throws(() => f.catalog.configureRuntime("cs", "Stale", [], initial.digest));
  const restored = f.catalog.restore(initial.catalog.revision, updated.digest);
  assert.equal(restored.catalog.entries.find(item => item.id === "cs").executors.length, 2);
  assert.throws(() => f.authority.validateRuntime(handle, f.journal), /runtime changed/);
  assert.deepEqual(fs.readFileSync(path.join(bin, "csc")), original);
  assert(!fs.existsSync(path.join(bin, "csc.executed")));
  assert.deepEqual(inspectNodeProject(f.project).entries, ["index.cjs"]);
});
test("real Node project broker SIGKILL records UNKNOWN without replay, then fresh selection executes once", { timeout: 30000 }, async t => {
  const f = await fixture(t), second = f.authority.selectJournal(randomUUID(), "local:owner");
  const result = await promisify(execFile)("unshare", require("../scripts/run-next-trial-private-display").privateNamespaceArgs([
    process.execPath, path.resolve("tests/local-runtime-crash-host.mjs"), nextBuild, f.root,
    JSON.stringify(f.journal), JSON.stringify(f.select()), JSON.stringify(second),
  ]), { cwd: f.root, env: { PATH: process.env.PATH }, timeout: 25000 });
  assert.match(result.stdout, /PASS no replay/);
  assert.deepEqual(f.effects(), [{ args: ["crash-once"] }]);
  const service = f.open(second), fresh = service.start(f.select(second), { args: ["fresh"], waitMs: 0 })[0].runId;
  await until(() => service.status(fresh)[0], run => run.state === "succeeded");
  assert.deepEqual(f.effects(), [{ args: ["crash-once"] }, { args: ["fresh"] }]);
});
