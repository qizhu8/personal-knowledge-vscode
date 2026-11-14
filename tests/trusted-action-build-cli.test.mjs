import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { delimiter, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { AutomaticActionTrustAuthority } from "../legacy/src/runtime/action-trust-authority.ts";
import { until } from "./batch07-cli-fixtures.mjs";

const build = resolve(process.env.PKM_ACTION_BUILD ?? resolve(import.meta.dirname, "../dist"));
const { initialize } = await import(`${build}/storage.js`);
const { restoreWorkspaceBackup } = await import(`${build}/workspace-backup.js`);
const { inspectActionBuild, resolveActionExecutable } = await import(`${build}/action-program-build.js`);

test("Action build path probing preserves unexpected filesystem faults", t => {
  const originalPath = process.env.PATH;
  const first = resolve("first-action-toolchain"), second = resolve("second-action-toolchain");
  const firstCandidate = resolve(first, "compiler"), secondCandidate = resolve(second, "compiler");
  const executable = fs.realpathSync(process.execPath);
  const realpath = fs.realpathSync;
  const denied = Object.assign(new Error("not executable"), { code: "EACCES" });
  const eio = Object.assign(new Error("device I/O error"), { code: "EIO" });
  let fault = denied;
  process.env.PATH = `${first}${delimiter}${second}`;
  t.mock.method(fs, "realpathSync", (candidate, ...args) => {
    if (candidate === firstCandidate) throw fault;
    if (candidate === secondCandidate) return executable;
    return realpath(candidate, ...args);
  });
  syncBuiltinESMExports();
  try {
    assert.equal(resolveActionExecutable("compiler"), executable, "An inaccessible candidate must not hide a later executable.");
    fault = eio;
    assert.throws(() => resolveActionExecutable("compiler"), error => error === eio);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    if (originalPath === undefined) delete process.env.PATH; else process.env.PATH = originalPath;
  }
});

test("Action private-source checks preserve the filesystem cause", t => {
  const root = resolve("private-action-root");
  const binding = { implementation: { kind: "program", platforms: ["Linux"], program: process.execPath,
    args: ["${build_dir}/result"], build: {
      program: process.execPath, args: [], source_files: ["/source"], outputs: ["result"],
    } } };
  const lstat = fs.lstatSync;
  const emfile = Object.assign(new Error("file descriptor limit"), { code: "EMFILE" });
  const missing = Object.assign(new Error("directory does not exist"), { code: "ENOENT" });
  let fault = emfile;
  t.mock.method(fs, "lstatSync", (candidate, ...args) => {
    if (candidate === root) throw fault;
    return lstat(candidate, ...args);
  });
  syncBuiltinESMExports();
  try {
    assert.throws(() => inspectActionBuild(root, binding), error => error === emfile);
    fault = missing;
    assert.throws(() => inspectActionBuild(root, binding),
      error => error.cause === missing && /existing private .pkm-action-sources directory/.test(error.message));
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});

test("production Action build requires consent and runs only fresh compiled private sources", { timeout: 50000 }, async t => {
  const root = resolve(import.meta.dirname, `.trusted-action-build-${randomUUID()}`);
  const backup = `${root}-backup`;
  const restored = `${root}-restored`;
  await initialize(root);
  chmodSync(root, 0o700);
  const sourceDirectory = resolve(root, ".pkm-action-sources");
  mkdirSync(sourceDirectory, { mode: 0o700 });
  const source = resolve(sourceDirectory, "main.py");
  const validSource = "import json,sys\nprint(json.dumps({'value': json.load(sys.stdin)['value'] + '-compiled'}))\n";
  writeFileSync(source, validSource, { mode: 0o600 });
  const python = execFileSync("python3", ["-c", "import os,sys; print(os.path.realpath(sys.executable))"], { encoding: "utf8" }).trim();
  let allowed = true, consentHook, lastContext, client;
  const createAuthority = () => new AutomaticActionTrustAuthority({
    storePath: () => root, nativeEndpoint: true, isTrusted: () => true, enabled: () => true,
    prepare: async () => { throw new Error("Function check must not run"); },
    authorizeEffects: async (_id, _hash, context) => {
      lastContext = context;
      if (consentHook) await consentHook();
      return allowed;
    },
  });
  let authority = createAuthority();
  t.after(async () => {
    try { await client?.close(); } finally {
      try { await authority.dispose(); } finally {
        rmSync(root, { recursive: true, force: true });
        rmSync(backup, { recursive: true, force: true });
        rmSync(restored, { recursive: true, force: true });
      }
    }
  });
  await authority.start();
  const connect = async () => {
    client = new Client({ name: "production-action-build-test", version: "1.0.0" });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [resolve(build, "cli.js"), "mcp", "--data", root, "--experimental-legacy-mcp", "--experimental-trusted-actions"],
      stderr: "pipe",
    });
    let stderr = "";
    transport.stderr?.on("data", chunk => { stderr += String(chunk); });
    try { await client.connect(transport); }
    catch (error) { throw new Error(`CLI startup failed: ${stderr}`, { cause: error }); }
  };
  await connect();
  const definition = {
    schema: "pkm.action.definition/v1", action_id: "example.private.build", version: 1,
    description: "Compile and run a newly authored Python module.",
    input_schema: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false },
    output_schema: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false },
    effects: ["local-write"], dependencies: {}, casts: {},
    implementations: [{ kind: "program", platforms: ["Linux", "Windows", "Darwin"], program: python,
      args: ["${build_dir}/main.pyc"], build: {
        program: python,
        args: ["-c", "import py_compile,sys; py_compile.compile(sys.argv[1],cfile=sys.argv[2],doraise=True)", source, "${build_dir}/main.pyc"],
        source_files: [source], outputs: ["main.pyc"], timeout_seconds: 30,
      } }],
  };
  const submit = value => client.callTool({ name: "legacy_action_write", arguments: {
    tool: "action_register", arguments: { definition: value },
  } });
  const call = (registered, idempotencyKey) => client.callTool({ name: "action_call", arguments: {
    action_id: registered.action_id, content_hash: registered.content_hash,
    idempotency_key: idempotencyKey, inputs: { value: "hello" },
  } });
  const readRun = async runId => {
    const response = await client.callTool({ name: "legacy_action_read", arguments: {
      tool: "action_run_get", arguments: { run_id: runId },
    } });
    assert.notEqual(response.isError, true, JSON.stringify(response));
    return response.structuredContent.value;
  };
  const terminal = runId => until(() => readRun(runId),
    value => ["succeeded", "failed", "cancelled", "unknown"].includes(value.state));
  const counts = () => {
    const db = new DatabaseSync(resolve(root, "core.sqlite"), { readOnly: true });
    try { return ["native_action_automatic_calls", "action_runtime_runs", "runtime_process_jobs"]
      .map(table => Number(db.prepare(`SELECT count(*) n FROM ${table}`).get().n)); }
    finally { db.close(); }
  };
  const missing = structuredClone(definition);
  missing.action_id = "example.build.missing";
  missing.implementations[0].build.program = "pkm-nonexistent-compiler";
  const missingResult = await submit(missing);
  assert.equal(missingResult.isError, true);
  assert.match(JSON.stringify(missingResult), /Missing Action build toolchain/);
  if (process.platform !== "win32") {
    const linked = resolve(sourceDirectory, "linked.py");
    symlinkSync(source, linked);
    const unsafe = structuredClone(definition);
    unsafe.action_id = "example.build.symlink";
    unsafe.implementations[0].build.source_files = [linked];
    unsafe.implementations[0].build.args[2] = linked;
    const rejected = await submit(unsafe);
    assert.equal(rejected.isError, true);
    assert.match(JSON.stringify(rejected), /private .pkm-action-sources directory/i);
    rmSync(linked);
  }
  const registered = await submit(definition);
  assert.notEqual(registered.isError, true, JSON.stringify(registered));
  assert.equal(registered.structuredContent.value.callable, true);
  assert.equal(existsSync(resolve(root, ".pkm-action-builds")), false, "Registration must not build.");
  const before = counts();
  allowed = false;
  assert.equal((await call(registered.structuredContent.value, "denied")).isError, true);
  assert.deepEqual(counts(), before);
  assert.equal(existsSync(resolve(root, ".pkm-action-builds")), false, "Denied consent must not build.");
  assert.equal(lastContext.build.compiler, python);
  assert.deepEqual(lastContext.build.args, definition.implementations[0].build.args);
  assert.deepEqual(lastContext.build.outputs, ["main.pyc"]);
  assert.equal(lastContext.build.sources[0].sha256, createHash("sha256").update(validSource).digest("hex"));
  allowed = true;
  const called = await call(registered.structuredContent.value, "success");
  assert.notEqual(called.isError, true, JSON.stringify(called));
  const success = await terminal(called.structuredContent.value.runId);
  assert.equal(success.state, "succeeded", JSON.stringify(success));
  assert.deepEqual(success.output, { value: "hello-compiled" });
  assert.equal(counts()[2], before[2] + 2, "Compile and run use distinct durable direct-child jobs.");
  await client.close();
  await connect();
  assert.deepEqual((await readRun(called.structuredContent.value.runId)).output, { value: "hello-compiled" });

  const gcc = resolveActionExecutable("gcc");
  if (gcc) {
    const cSource = resolve(sourceDirectory, "native.c");
    writeFileSync(cSource, '#include <stdio.h>\nint main(void) { puts("{\\"value\\":\\"native-built\\"}"); return 0; }\n', { mode: 0o600 });
    const native = structuredClone(definition);
    native.action_id = "example.private.nativebuild";
    native.implementations[0].program = "${build_dir}/native";
    native.implementations[0].args = [];
    native.implementations[0].build = { program: gcc,
      args: [cSource, "-o", "${build_dir}/native"], source_files: [cSource], outputs: ["native"], timeout_seconds: 30 };
    const nativeRegistered = await submit(native);
    assert.notEqual(nativeRegistered.isError, true, JSON.stringify(nativeRegistered));
    const nativeCall = await call(nativeRegistered.structuredContent.value, "native-compiler");
    assert.notEqual(nativeCall.isError, true, JSON.stringify(nativeCall));
    const nativeRun = await terminal(nativeCall.structuredContent.value.runId);
    assert.equal(nativeRun.state, "succeeded", JSON.stringify(nativeRun));
    assert.deepEqual(nativeRun.output, { value: "native-built" });
    assert.equal(lastContext.build.compiler, gcc);
  }

  writeFileSync(source, "this is not valid Python !!!\n");
  const bad = structuredClone(definition);
  bad.action_id = "example.private.invalidbuild";
  const badRegistered = await submit(bad);
  assert.notEqual(badRegistered.isError, true, JSON.stringify(badRegistered));
  const jobsBeforeFailure = counts()[2];
  const badCall = await call(badRegistered.structuredContent.value, "compiler-failure");
  assert.notEqual(badCall.isError, true, JSON.stringify(badCall));
  const failed = await terminal(badCall.structuredContent.value.runId);
  assert.equal(failed.state, "failed", JSON.stringify(failed));
  assert.equal(failed.nodes[0].reason, "ACTION_BUILD_FAILED");
  assert.equal(Object.hasOwn(failed, "output"), false);
  assert.equal(counts()[2], jobsBeforeFailure + 1, "A failed compiler must not launch stale output.");

  writeFileSync(source, validSource);
  const noOutput = structuredClone(definition);
  noOutput.action_id = "example.private.nooutput";
  noOutput.implementations[0].build.args[1] = "pass";
  const noOutputRegistered = await submit(noOutput);
  assert.notEqual(noOutputRegistered.isError, true, JSON.stringify(noOutputRegistered));
  const jobsBeforeMissingOutput = counts()[2];
  const noOutputCall = await call(noOutputRegistered.structuredContent.value, "missing-output");
  assert.notEqual(noOutputCall.isError, true, JSON.stringify(noOutputCall));
  const noOutputRun = await terminal(noOutputCall.structuredContent.value.runId);
  assert.equal(noOutputRun.state, "failed");
  assert.equal(noOutputRun.nodes[0].reason, "ACTION_BUILD_OUTPUT_INVALID");
  assert.equal(counts()[2], jobsBeforeMissingOutput + 1);

  const changed = structuredClone(definition);
  changed.action_id = "example.private.changedbuild";
  const changedRegistered = await submit(changed);
  assert.notEqual(changedRegistered.isError, true, JSON.stringify(changedRegistered));
  consentHook = () => { writeFileSync(source, `${validSource}# changed after consent\n`); };
  const jobsBeforeChanged = counts()[2];
  const changedCall = await call(changedRegistered.structuredContent.value, "source-changed");
  consentHook = undefined;
  assert.notEqual(changedCall.isError, true, JSON.stringify(changedCall));
  const changedRun = await terminal(changedCall.structuredContent.value.runId);
  assert.equal(changedRun.state, "unknown", JSON.stringify(changedRun));
  assert.equal(changedRun.nodes[0].reason, "ACTION_BUILD_CHANGED");
  assert.equal(counts()[2], jobsBeforeChanged, "Changed sources cannot start a compiler.");

  writeFileSync(source, validSource);
  const oldEpoch = structuredClone(definition);
  oldEpoch.action_id = "example.private.oldepoch";
  oldEpoch.implementations[0].build.args[1] = "import time,py_compile,sys; time.sleep(30); py_compile.compile(sys.argv[1],cfile=sys.argv[2],doraise=True)";
  const oldRegistered = await submit(oldEpoch);
  assert.notEqual(oldRegistered.isError, true, JSON.stringify(oldRegistered));
  const oldCall = await call(oldRegistered.structuredContent.value, "old-trust-epoch");
  assert.notEqual(oldCall.isError, true, JSON.stringify(oldCall));
  await until(() => {
    const db = new DatabaseSync(resolve(root, "core.sqlite"), { readOnly: true });
    try { return db.prepare("SELECT record_json FROM runtime_process_jobs WHERE state='RUNNING'").get(); }
    finally { db.close(); }
  }, value => !!value && Number.isInteger(JSON.parse(value.record_json).pid));
  const oldJobCount = counts()[2];
  await authority.dispose();
  authority = createAuthority();
  await authority.start();
  const readmitted = await submit(oldEpoch);
  assert.notEqual(readmitted.isError, true, JSON.stringify(readmitted));
  const oldRun = await terminal(oldCall.structuredContent.value.runId);
  assert.notEqual(oldRun.state, "succeeded", "A new epoch cannot inherit in-flight build consent.");
  assert.equal(Object.hasOwn(oldRun, "output"), false);
  assert.equal(counts()[2], oldJobCount, "Re-admission must not start the old run phase.");

  const slow = structuredClone(definition);
  slow.action_id = "example.private.slowbuild";
  slow.implementations[0].build.args[1] = "import time,py_compile,sys; time.sleep(30); py_compile.compile(sys.argv[1],cfile=sys.argv[2],doraise=True)";
  const slowRegistered = await submit(slow);
  assert.notEqual(slowRegistered.isError, true, JSON.stringify(slowRegistered));
  const slowCall = await call(slowRegistered.structuredContent.value, "revoked-during-build");
  assert.notEqual(slowCall.isError, true, JSON.stringify(slowCall));
  const running = await until(() => {
    const db = new DatabaseSync(resolve(root, "core.sqlite"), { readOnly: true });
    try { return db.prepare("SELECT record_json FROM runtime_process_jobs WHERE state='RUNNING'").get(); }
    finally { db.close(); }
  }, value => !!value && Number.isInteger(JSON.parse(value.record_json).pid));
  const pid = JSON.parse(running.record_json).pid;
  const jobsBeforeRevoke = counts()[2];
  assert.notEqual((await client.callTool({ name: "action_trust_revoke", arguments: {} })).isError, true);
  await until(() => {
    try { process.kill(pid, 0); return false; } catch (error) { return error.code === "ESRCH"; }
  }, value => value === true);
  const cancelled = await terminal(slowCall.structuredContent.value.runId);
  assert.notEqual(cancelled.state, "succeeded");
  assert.equal(Object.hasOwn(cancelled, "output"), false);
  assert.equal(counts()[2], jobsBeforeRevoke, "Revocation must not launch the run phase.");
  await client.close();
  client = undefined;
  execFileSync(process.execPath, [resolve(build, "cli.js"), "backup", "--data", root, "--destination", backup], {
    stdio: "pipe", timeout: 15000,
  });
  assert.equal(existsSync(resolve(backup, ".pkm-action-sources", "main.py")), true);
  assert.equal(existsSync(resolve(backup, ".pkm-action-builds")), false);
  await restoreWorkspaceBackup(backup, restored, { nativeRestoreAuthority: {
    actorId: "test:owner",
    async authorize(request) {
      return { authorityId: "disposable-fixture", actorId: request.actorId,
        requestSha256: createHash("sha256").update(JSON.stringify(request)).digest("hex"),
        expiresAt: Date.now() + 60000, lineage: "unrelated", trustedEpoch: null };
    },
  } });
  assert.equal(readFileSync(resolve(restored, ".pkm-action-sources", "main.py"), "utf8"), validSource);
  assert.equal(existsSync(resolve(restored, ".pkm-action-builds")), false);
});
