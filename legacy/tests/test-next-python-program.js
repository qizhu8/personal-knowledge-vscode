const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), { randomUUID, createHash } = require("node:crypto");
const { execFileSync } = require("node:child_process"), { pathToFileURL } = require("node:url");
const build = process.env.PKM_ENV_AUTHORITY_BUILD, next = process.env.PKM_ENV_NEXT_BUILD;
if (!build || !next) throw new Error("Set isolated PKM_ENV_AUTHORITY_BUILD/PKM_ENV_NEXT_BUILD.");
const { LocalEnvironmentCatalog } = require(path.join(build, "runtime/local-environment-catalog.js"));
const { PythonEnvironmentAuthority } = require(path.join(build, "runtime/python-environment-authority.js"));
const { PythonProgramAuthority } = require(path.join(build, "runtime/python-program-authority.js"));
const { LocalRuntimeAuthority } = require(path.join(build, "runtime/local-runtime-authority.js"));
const load = name => import(pathToFileURL(path.join(next, `${name}.js`)));
const hash = value => createHash("sha256").update(value).digest("hex");
async function fixture(t) {
  const root = path.resolve(`.migration-test-work/python-program-${randomUUID()}`);
  fs.mkdirSync(root, { mode: 0o700 });
  const venv = path.join(root, "original-venv");
  execFileSync("/usr/bin/python3", ["-m", "venv", "--without-pip", venv], { env: {}, cwd: root });
  const original = { id: "original-python", name: "Original", path: venv, python: path.join(venv, "bin/python"), manager: "venv" };
  const catalog = new LocalEnvironmentCatalog(path.join(root, "catalog"));
  catalog.register({ id: original.id, name: original.name, language: "python", kind: "environment", manager: "venv", root: venv,
    executors: [{ id: "python", executable: original.python }] }, catalog.read().digest);
  let trusted = true;
  const environments = new PythonEnvironmentAuthority(() => trusted, () => [original]);
  const programs = new PythonProgramAuthority(() => trusted, environments), workspaceId = randomUUID();
  const authority = new LocalRuntimeAuthority(() => trusted, catalog, path.join(root, "journal"));
  const journal = authority.selectJournal(workspaceId, "local:owner"), handle = environments.select(workspaceId, "local:owner", original.id);
  const { HostLocalEnvironmentWorkflow } = await load("host-local-environment-workflow");
  const services = [], open = (recover = false, options = {}) => {
    const service = new HostLocalEnvironmentWorkflow(journal, root, recover, options); services.push(service); return service;
  };
  t.after(async () => { for (const service of services.reverse()) await service.close(); programs.revoke(); environments.revoke();
    authority.revoke(); fs.rmSync(root, { recursive: true, force: true }); });
  const file = path.join(root, "reviewed-workflow.json");
  const definition = (script, args = [], extra = []) => ({ schema: "pkm.workflow.definition/v1",
    spec: { inputs: {}, outputs: {}, nodes: [{ nodeId: "script", kind: "pkm.step.script/v1", dependsOn: [],
      config: { runtime: "python", environmentId: original.id, script, args, timeoutSeconds: 20, maxOutputBytes: 4096 } }, ...extra],
      completion: { requiredNodes: [extra.at(-1)?.nodeId || "script"] } } });
  const select = (value, inputs = {}) => { fs.writeFileSync(file, JSON.stringify(value), { mode: 0o600 }); return programs.select(handle, root, file, root, inputs); };
  return { root, venv, original, catalog, environments, programs, authority, journal, handle, open, services, file, definition, select,
    revoke: () => { trusted = false; } };
}
async function until(read, predicate) {
  const deadline = Date.now() + 30000;
  for (;;) { const value = await read(); if (predicate(value)) return value;
    if (Date.now() > deadline) assert.fail(JSON.stringify(value)); await new Promise(resolve => setTimeout(resolve, 25)); }
}
test("actual Next Python adapter runs reviewed multi-step source and literal parameters in the original environment", async t => {
  const f = await fixture(t), marker = path.join(f.root, "effect"), args = ["two words", "--not-cli", "$(touch never-created)", "中文", ""];
  const program = f.select(f.definition("import json,sys\nfrom pathlib import Path\n"
    + `Path(${JSON.stringify(marker)}).write_text('once')\nprint(json.dumps({'args':sys.argv[1:],'prefix':sys.prefix}))`, args,
  [{ nodeId: "second", kind: "pkm.step.script/v1", dependsOn: [{ from: "script", accept: ["succeeded"], required: true }],
    config: { runtime: "python", environmentId: f.original.id, script: "print('second-real-python')", timeoutSeconds: 5, maxOutputBytes: 4096 } }]));
  f.programs.validate(program, f.handle.workspaceId);
  const service = f.open(), runId = service.startPython(program)[0].runId;
  const done = await until(() => service.status(runId)[0], run => run.state === "succeeded");
  assert.equal(done.provider, "python-script/v1"); assert.equal(done.jobs.length, 2);
  assert.deepEqual(JSON.parse(done.jobs[0].stdout), { args, prefix: f.venv });
  assert.equal(done.jobs[1].stdout, "second-real-python\n"); assert.equal(fs.readFileSync(marker, "utf8"), "once");
  assert(!fs.existsSync(path.join(f.root, "never-created")));
  await service.close(); const reopened = f.open();
  assert.equal(reopened.status(runId)[0].state, "succeeded"); assert.equal(fs.readFileSync(marker, "utf8"), "once");
});
test("reviewed source, native object identity, trust, runtime and payload drift refuse before a Python effect", async t => {
  const f = await fixture(t), program = f.select(f.definition("print('approved')")), service = f.open();
  assert.throws(() => f.programs.validate(structuredClone(program), f.handle.workspaceId), /authority/);
  assert.throws(() => service.startPython({ ...program, definition: f.definition("print('substituted')") }), /digest/);
  fs.appendFileSync(f.file, "\n");
  assert.throws(() => f.programs.validate(program, f.handle.workspaceId), /changed/);
  assert.throws(() => service.startPython(program), /changed/);
  const fresh = f.select(f.definition("print('new approval')"));
  fs.renameSync(f.venv, `${f.venv}-offline`);
  assert.throws(() => service.startPython(fresh), /ENOENT|changed/);
  fs.renameSync(`${f.venv}-offline`, f.venv);
  f.revoke(); assert.throws(() => f.programs.validate(fresh, f.handle.workspaceId), /revoked/);
  assert.deepEqual(service.status(), []);
});
test("actual Next Python cancellation and graceful host restart preserve UNKNOWN history without replay", async t => {
  const f = await fixture(t), marker = path.join(f.root, "cancel-effects");
  const program = f.select(f.definition(`import time\nfrom pathlib import Path\np=Path(${JSON.stringify(marker)})\np.write_text(p.read_text()+'effect\\n' if p.exists() else 'effect\\n')\nprint('started',flush=True)\ntime.sleep(18)`));
  const service = f.open(), id = service.startPython(program)[0].runId;
  await until(() => service.status(id)[0], run => run.jobs.some(job => job.stdout.includes("started")));
  service.cancel(id);
  const cancelled = await until(() => service.status(id)[0], run => run.state === "cancelled" && run.jobs.every(job => job.state !== "RUNNING"));
  assert.equal(cancelled.effect, "unknown");
  const nextId = service.startPython(program)[0].runId;
  await until(() => service.status(nextId)[0], run => run.jobs.some(job => job.stdout.includes("started")));
  await service.close(); const reopened = f.open();
  assert.equal(reopened.status(nextId)[0].state, "unknown");
  assert.equal(fs.readFileSync(marker, "utf8"), "effect\neffect\n");
});
test("canonical Next Recipe source uses the same real Python adapter, not inline or the old worker", async t => {
  const f = await fixture(t), definition = f.definition("print('next-recipe-real-python')");
  const compiler = await load("workflow-compiler"), contracts = await load("domain/project-recipes-workflow-contracts");
  const compiled = contracts.compileWorkflowDefinitionV1(definition);
  const recipe = { schema: "pkm.knowledge/v1", knowledgeId: `knowledge_${hash("fixture-python").slice(0, 24)}`,
    aliases: ["recipe:fixture_python"], recipeId: "fixture_python", scope: "global", name: "Python", revision: 1,
    description: "", category: "", definition, executableDigest: compiled.executableDigest };
  fs.mkdirSync(path.join(f.root, "recipes/Uncategorized"), { recursive: true });
  const recipeFile = path.join(f.root, "recipes/Uncategorized/Python.fixture_python.json");
  fs.writeFileSync(recipeFile, JSON.stringify(recipe));
  const ref = { kind: "recipe", recipeId: recipe.recipeId, expectedRevision: 1, expectedExecutableDigest: compiled.executableDigest };
  const resolveRecipe = source => compiler.readWorkflowCompiler(f.root, { operation: "workflow.definition.compile", args: { source } }, []);
  const resolved = resolveRecipe(ref);
  const program = { handle: f.handle, cwd: f.root, definition: resolved.definition, source: resolved.source,
    executableDigest: resolved.executableDigest, inputs: {} };
  assert.throws(() => f.open().startPython(program), /actual native Recipe source resolver/);
  await f.services.pop().close();
  const service = f.open(false, { resolveRecipe }), runId = service.startPython(program)[0].runId;
  const done = await until(() => service.status(runId)[0], run => run.state === "succeeded");
  assert.equal(done.jobs[0].stdout, "next-recipe-real-python\n");
  fs.writeFileSync(recipeFile, JSON.stringify({ ...recipe, revision: 2 }));
  assert.throws(() => service.startPython(program), /revision|snapshot|changed|conflict/i);
});
test("bound Workflow inputs become literal Python argv, never source or shell interpolation", async t => {
  const f = await fixture(t), definition = f.definition("import json,sys; print(json.dumps(sys.argv[1:]))", ["{{ inputs.value }}"]);
  definition.spec.inputs = { value: { type: "string", required: true, nullable: false, schema: {} } };
  const program = f.select(definition, { value: "$(touch literal-not-executed) 中文" }), service = f.open();
  const id = service.startPython(program)[0].runId;
  const done = await until(() => service.status(id)[0], run => run.state === "succeeded");
  assert.deepEqual(JSON.parse(done.jobs[0].stdout), ["$(touch literal-not-executed) 中文"]);
  assert(!fs.existsSync(path.join(f.root, "literal-not-executed")));
});
test("actual managed IPC requires fresh consumed-once native approval and rechecks source at its exact child challenge", { timeout: 120000 }, async t => {
  const f = await fixture(t), extension = path.join(f.root, "extension"), trial = path.join(f.root, "trial"), legacy = path.join(f.root, "legacy");
  for (const dir of [extension, trial, legacy]) fs.mkdirSync(dir, { mode: 0o700 });
  fs.copyFileSync(path.resolve("package.json"), path.join(extension, "package.json"));
  require("../scripts/next-rehearsal-runtime").stage(path.join(extension, "next-runtime"), { production: true });
  const { NextManagedClient } = require(path.join(build, "runtime/next-managed-client.js")), client = new NextManagedClient();
  f.services.push(client);
  const workspaceId = await client.start(extension, trial, fs.realpathSync(process.execPath), legacy);
  const handle = f.environments.select(workspaceId, "local:owner", f.original.id);
  const journal = f.authority.selectJournal(workspaceId, "local:owner");
  fs.writeFileSync(f.file, JSON.stringify(f.definition("print('real-next-ipc-python')")), { mode: 0o600 });
  const program = f.programs.select(handle, f.root, f.file, client.pythonWorkspaceDirectory(), {});
  const command = value => client.localEnvironmentCommand(f.authority, journal, value, f.programs);
  await command({ operation: "open", recover: false });
  await assert.rejects(command({ operation: "start-python", program }), /Fresh exact one-run/);
  await assert.rejects(client.request({ type: "environment-command", approvalId: randomUUID(),
    grant: { operation: "start-python", journal, program } }), /approval rejected/);
  f.programs.approve(program, workspaceId);
  const id = (await command({ operation: "start-python", program }))[0].runId;
  const done = await until(async () => (await command({ operation: "status" })).find(item => item.runId === id), run => run.state === "succeeded");
  assert.equal(done.jobs[0].stdout, "real-next-ipc-python\n");
  await assert.rejects(command({ operation: "start-python", program }), /consumed/);
  const validate = f.programs.validate.bind(f.programs);
  f.programs.approve(program, workspaceId); let calls = 0;
  f.programs.validate = (...args) => { if (++calls > 1) throw new Error("Source revoked at challenge"); return validate(...args); };
  await assert.rejects(command({ operation: "start-python", program }), /approval rejected/);
  f.programs.validate = validate;
  assert.equal((await command({ operation: "status" })).length, 1);
});
test("the same Next adapter uses an explicitly supplied genuine old-created conda prefix without provisioning",
  { skip: !process.env.PKM_TEST_EXISTING_CONDA_PREFIX }, async t => {
    const f = await fixture(t), prefix = process.env.PKM_TEST_EXISTING_CONDA_PREFIX;
    assert(path.isAbsolute(prefix) && fs.existsSync(path.join(prefix, "conda-meta/history")));
    const before = hash(fs.readFileSync(path.join(prefix, "conda-meta/history")));
    f.original.path = prefix; f.original.python = path.join(prefix, "bin/python"); f.original.manager = "conda";
    const handle = f.environments.select(f.handle.workspaceId, "local:owner", f.original.id);
    fs.writeFileSync(f.file, JSON.stringify(f.definition("import sys; print(sys.prefix)")), { mode: 0o600 });
    const program = f.programs.select(handle, f.root, f.file, f.root, {}), service = f.open();
    const id = service.startPython(program)[0].runId;
    const done = await until(() => service.status(id)[0], run => run.state === "succeeded");
    assert.equal(done.jobs[0].stdout.trim(), prefix);
    assert.equal(hash(fs.readFileSync(path.join(prefix, "conda-meta/history"))), before);
  });
