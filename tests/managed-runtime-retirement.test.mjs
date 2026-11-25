import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdir, readFile, writeFile, rm, readdir, realpath, symlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { cleanupIsolatedManagedRuntime, inspectIsolatedManagedRuntime,
  publishIsolatedManagedGeneration, stageIsolatedManagedGeneration,
  isolatedManagedLaunch, withIsolatedManagedGenerationAdmission,
  verifyIsolatedManagedGeneration } from "../experimental/managed-migration.mjs";

const hash = value => createHash("sha256").update(value).digest("hex");
const components = Object.fromEntries(["knowledge", "chat", "recipes", "agent_sessions"].map(name => [name, "0.1.0"]));

async function fixture(t) {
  const root = resolve("tests", `.runtime-retirement-${randomUUID()}`);
  const data = join(root, "data"), managed = join(root, "runtime");
  await mkdir(data, { recursive: true }); await mkdir(managed);
  await writeFile(join(data, ".pkm-next-workspace"), JSON.stringify({ schema: "pkm.next-workspace/v1", id: randomUUID() }));
  await writeFile(join(managed, ".pkm-isolated-migration"), JSON.stringify({ schema: "pkm.isolated-managed-migration/v1" }));
  const launcher = await readFile(resolve("experimental/managed-launcher.py"));
  await writeFile(join(managed, "launch.py"), launcher);
  const python = execFileSync("python3", ["-c", "import sys;from pathlib import Path;print(Path(sys.executable).resolve())"], { encoding: "utf8" }).trim();
  const interpreters = {};
  for (const [name, path] of Object.entries({ python, node: await realpath(process.execPath) }))
    interpreters[name] = { path, sha256: hash(await readFile(path)) };
  t.after(() => rm(root, { recursive: true, force: true }));
  async function generation(compatibility = { protocol: "pkm.mcp.api/1", components: { knowledge: "0" } }, kind) {
    const id = randomUUID(), directory = join(managed, "generations", id);
    await mkdir(join(directory, "runtime/next-server/compat"), { recursive: true });
    const platform = { interpreters, launcherSha256: hash(launcher), pythonDistributions: [], pythonDependencyProfile: "fastmcp" };
    const values = {
      "runtime/next-server/package.json": "{}",
      "runtime/next-server/compat/legacy-compact-mcp.py": "import sys\nprint('ready',flush=True)\nsys.stdin.read()\n",
      "launch.json": JSON.stringify({ data, allowWrites: false }),
      "platform.json": JSON.stringify(platform),
      "python-dependencies.json": JSON.stringify({ profile: "fastmcp", distributions: {} }),
    };
    if (kind === "standalone-core") {
      await mkdir(join(directory, "runtime/next-server/dist"));
      values["launch.json"] = JSON.stringify({ data, allowWrites: true });
      const config = { schema: "pkm.native-host-config/v1", provider: "openai-compatible",
        endpoint: "https://synthetic.invalid/v1", secretRef: "secret:fixture/model", model: "fixture-model",
        contextWindow: 16384, maxOutputTokens: 4096, outputTokenParameter: "max_tokens", includeUsage: true, tools: [] };
      values["core-host.json"] = JSON.stringify({ schema: "pkm.shared-core-host/v1", config,
        policy: { allowedProviders: ["openai-compatible"], allowedEndpoints: ["https://synthetic.invalid/v1"],
          allowedModels: ["fixture-model"], allowedTools: [] },
        secretEnvironment: { "secret:fixture/model": "PKM_FIXTURE_MODEL_TOKEN" }, humanReview: "browser" });
      values["core-host-config.json"] = JSON.stringify(config);
      values["python-bootstrap.py"] = await readFile(resolve("experimental/python-bootstrap.py"), "utf8");
      values["runtime/next-server/dist/shared-core-backend.js"] = `
        const {spawnSync}=require("node:child_process"),{resolve}=require("node:path");
        const result=spawnSync(process.env.PKM_ISOLATED_PYTHON_COMMAND,
          ["-I","-S","-B",process.env.PKM_ISOLATED_PYTHON_BOOTSTRAP,
            resolve(__dirname,"../compat/legacy-compact-mcp.py")],{input:"",encoding:"utf8"});
        if(result.status!==0||result.stdout.trim()!=="ready")throw new Error("Pinned Python bootstrap did not execute");
        process.stdout.write("core-fixture-ready\\n");process.stdin.resume();
      `;
    }
    const files = {};
    for (const [name, bytes] of Object.entries(values)) { await writeFile(join(directory, name), bytes); files[name] = hash(bytes); }
    const manifest = { schema: "pkm.mcp.lifecycle/v1", generation: id, managedRoot: managed, version: "0.1.0",
      components, enabledFeatureDomains: [], experimental: true, ...platform, node: interpreters.node.path,
      compatibility, files, runtimeBuild: hash(Object.keys(files).sort().map(name => `${name}\0${files[name]}\0`).join("")) };
    if (kind) Object.assign(manifest, { backendKind: kind,
      backendAbi: kind === "standalone-core" ? "pkm.shared-core-http/v1" : "pkm.mcp.api/1",
      ...(kind === "standalone-core" ? { coreHostProfileSha256: files["core-host.json"] } : {}) });
    await writeFile(join(directory, "manifest.json"), JSON.stringify(manifest));
    return manifest;
  }
  return { root, data, managed, python, generation };
}

test("live launcher leases defer binary retirement; cleanup preserves durable pointers/history and inactive source cannot be fictitiously rolled back", async t => {
  const f = await fixture(t), first = await f.generation(), second = await f.generation();
  await publishIsolatedManagedGeneration(f.managed, first.generation);
  const child = spawn(f.python, ["-I", "-S", join(f.managed, "launch.py")], { stdio: ["pipe", "pipe", "pipe"] });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  const ready = await once(child.stdout, "data");
  assert.match(String(ready[0]), /ready/);
  await publishIsolatedManagedGeneration(f.managed, second.generation);
  let status = await cleanupIsolatedManagedRuntime(f.managed);
  assert(status.pendingCleanup.includes(first.generation));
  assert(status.leases.some(lease => lease.pid === child.pid && lease.live));
  const exited = once(child, "exit"); child.stdin.end(); await exited;
  const baseline = await readFile(join(f.managed, "active-generation.json"), "utf8");
  status = await cleanupIsolatedManagedRuntime(f.managed);
  assert.deepEqual(status.candidates, [second.generation]);
  assert(status.history.retired.includes(first.generation));
  assert.equal(await readFile(join(f.managed, "active-generation.json"), "utf8"), baseline);
  assert.equal(status.history.transitions.at(-1).dataRollback, false);
  await assert.rejects(publishIsolatedManagedGeneration(f.managed, first.generation), /ENOENT/);
  assert.deepEqual((await inspectIsolatedManagedRuntime(f.managed)).pendingCleanup, []);
});

test("incompatible candidate and linked cleanup controls fail closed without moving the active pointer", async t => {
  const f = await fixture(t), first = await f.generation();
  await publishIsolatedManagedGeneration(f.managed, first.generation);
  const bad = await f.generation({ protocol: "incompatible", components: {} });
  await assert.rejects(publishIsolatedManagedGeneration(f.managed, bad.generation), /Incompatible/);
  const pointer = await readFile(join(f.managed, "latest-generation.json"), "utf8");
  assert.equal(JSON.parse(pointer).generation, first.generation);
  const historyPath = join(f.data, "runtime-control/managed-runtime-history.json");
  const history = JSON.parse(await readFile(historyPath, "utf8"));
  history.transitions.push({ sequence: 2, from: first.generation, to: first.generation, phase: "prepared", dataRollback: false });
  await writeFile(historyPath, JSON.stringify(history));
  const recovered = await cleanupIsolatedManagedRuntime(f.managed);
  assert.equal(recovered.history.transitions.at(-1).phase, "switched");
  assert.deepEqual(await readdir(join(f.managed, "generations")), [first.generation]);
  await symlink(f.data, join(f.managed, "leases"));
  await assert.rejects(cleanupIsolatedManagedRuntime(f.managed), /Linked/);
  assert.equal(await readFile(join(f.managed, "latest-generation.json"), "utf8"), pointer);
});

test("publication guard is released by the kernel after an owner crash, without stale-lock takeover", async t => {
  const f = await fixture(t), first = await f.generation();
  await publishIsolatedManagedGeneration(f.managed, first.generation);
  const child = spawn(f.python, ["-I", "-S", "-c",
    "import fcntl,sys\nf=open(sys.argv[1],'r+')\nfcntl.flock(f,fcntl.LOCK_EX)\nprint('locked',flush=True)\nsys.stdin.read()",
    join(f.managed, ".migration-publication-guard")], { stdio: ["pipe", "pipe", "pipe"] });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  await once(child.stdout, "data");
  await assert.rejects(inspectIsolatedManagedRuntime(f.managed), /busy/);
  const exited = once(child, "exit"); child.kill("SIGKILL"); await exited;
  assert.equal((await inspectIsolatedManagedRuntime(f.managed)).activeGeneration, first.generation);
});

test("runtime staging budget and destination headroom refuse before creating candidate bytes", async t => {
  const f = await fixture(t);
  await assert.rejects(stageIsolatedManagedGeneration({ managedRoot: f.managed, data: f.data,
    repositoryRoot: resolve("."), maxTotalBytes: 0 }), /budget/);
  await assert.rejects(stageIsolatedManagedGeneration({ managedRoot: f.managed, data: f.data,
    repositoryRoot: resolve("."), maxTotalBytes: 1 }), /budget/);
  await assert.rejects(stageIsolatedManagedGeneration({ managedRoot: f.managed, data: f.data,
    repositoryRoot: resolve("."), minFreeBytes: Number.MAX_SAFE_INTEGER }), /Insufficient free disk/);
  assert.deepEqual((await inspectIsolatedManagedRuntime(f.managed)).candidates, []);
});

test("explicit Core kind/ABI/profile admission reserves actual child code and cannot cross native MCP kinds", async t => {
  const f = await fixture(t), compatibility = { protocol: "pkm.shared-core-http/v1", components: { knowledge: "0" } };
  const first = await f.generation(compatibility, "standalone-core");
  const second = await f.generation(compatibility, "standalone-core");
  await publishIsolatedManagedGeneration(f.managed, first.generation);
  await assert.rejects(isolatedManagedLaunch(f.managed), /standalone Core/);
  const child = await withIsolatedManagedGenerationAdmission(f.managed, first.generation, "standalone-core", async launch => {
    assert.equal(launch.command, process.execPath);
    assert.equal(launch.env.NODE_OPTIONS, undefined);
    const backendProcess = spawn(launch.command, launch.args, { cwd: launch.cwd, env: launch.env, stdio: ["pipe", "pipe", "pipe"] });
    return { pid: backendProcess.pid, value: backendProcess };
  });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  assert.match(String((await once(child.stdout, "data"))[0]), /core-fixture-ready/);
  await publishIsolatedManagedGeneration(f.managed, second.generation);
  assert((await cleanupIsolatedManagedRuntime(f.managed)).pendingCleanup.includes(first.generation));
  const exited = once(child, "exit"); child.stdin.end(); await exited;
  assert.deepEqual((await cleanupIsolatedManagedRuntime(f.managed)).candidates, [second.generation]);
  const native = await f.generation(compatibility, "native-public-mcp");
  await assert.rejects(publishIsolatedManagedGeneration(f.managed, native.generation), /kind or ABI/);
  const manifestPath = join(f.managed, "generations", second.generation, "manifest.json");
  await writeFile(manifestPath, JSON.stringify({ ...second, backendAbi: "pkm.shared-core-http/v2" }));
  await assert.rejects(verifyIsolatedManagedGeneration(f.managed, second.generation), /kind or ABI/);
});
