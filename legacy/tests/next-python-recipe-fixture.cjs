"use strict";
const fs = require("node:fs"), path = require("node:path"), { execFileSync } = require("node:child_process");
const { randomUUID, createHash } = require("node:crypto"), { pathToFileURL } = require("node:url");
const rootBuild = process.env.PKM_ENV_AUTHORITY_BUILD, nextBuild = process.env.PKM_ENV_NEXT_BUILD;
if (!rootBuild || !nextBuild) throw Error("Set isolated PKM_ENV_AUTHORITY_BUILD/PKM_ENV_NEXT_BUILD.");
const load = name => import(pathToFileURL(path.join(nextBuild, `${name}.js`)).href);
const { PythonEnvironmentAuthority } = require(path.join(rootBuild, "runtime/python-environment-authority.js"));
const { PythonRecipeAuthority, readProfilePythonRegistry } = require(path.join(rootBuild, "runtime/python-recipe-authority.js"));
const hash = value => createHash("sha256").update(value).digest("hex");
function prepare(existingPrefix) {
  const directory = path.resolve(`.migration-test-work/python-sql-recipe-${randomUUID()}`);
  const workspace = path.join(directory, "workspace"), prefix = existingPrefix || path.join(directory, "legacy-venv");
  fs.mkdirSync(workspace, { recursive: true, mode: 0o700 });
  if (existingPrefix) {
    if (!prefix.startsWith(path.resolve(".migration-test-work") + path.sep) || fs.realpathSync(prefix) !== prefix)
      throw Error("An explicitly supplied existing synthetic prefix is required.");
  } else execFileSync("/usr/bin/python3", ["-m", "venv", "--without-pip", prefix], { env: {}, cwd: directory });
  const profileStorage = path.join(directory, "u/User/globalStorage/uone.personal-knowledge");
  const registry = path.join(profileStorage, "environments/registry.json");
  const old = require(path.join(rootBuild, "servers/pyenvs.js"));
  old.initPyenvs(path.dirname(registry));
  const record = old.pyenvAdd({ name: "legacy-python", path: prefix, python: path.join(prefix, "bin/python"), manager: existingPrefix ? "conda" : "venv",
    description: "Existing offline old-registry environment; no provisioning during Next Recipe execution." });
  const metadata = { directory, workspace, prefix, profileStorage, registry, record,
    root: path.join(directory, "knowledge"), actorId: randomUUID(), chatId: randomUUID(), namespace: "0123456789abcdef",
    sourceFingerprint: hash(randomUUID()), recipeId: `recipe_${randomUUID()}`, originalRegistrySha256: hash(fs.readFileSync(registry)) };
  fs.writeFileSync(path.join(directory, "fixture.json"), JSON.stringify(metadata), { mode: 0o600 });
  return metadata;
}
function definition(environmentId) {
  return { schema: "pkm.workflow.definition/v1", spec: {
    inputs: { value: { type: "string", required: true, nullable: false, schema: {} },
      mode: { type: "string", required: true, nullable: false, schema: {} } }, outputs: {},
    nodes: [{ nodeId: "python", kind: "pkm.step.script/v1", dependsOn: [], config: {
      runtime: "python", environmentId, args: ["{{ inputs.value }}", "{{ inputs.mode }}", "--not-cli", "$(touch never-created)", "two words", "中文", ""],
      timeoutSeconds: 20, maxOutputBytes: 4096,
      script: "import json,sys,os,time\nwith open('effects.jsonl','a') as f:\n f.write(json.dumps({'value':sys.argv[1]})+'\\n');f.flush();os.fsync(f.fileno())\n"
        + "print(json.dumps({'argv':sys.argv[1:],'prefix':sys.prefix}),flush=True)\n"
        + "if sys.argv[2]=='hold':\n try:\n  for i in range(150):\n   print('alive',flush=True);time.sleep(.1)\n except BrokenPipeError: os._exit(0)" } }],
    completion: { requiredNodes: ["python"] } } };
}
async function open(metadata, recover = false) {
  const { Storage, initialize } = await load("storage");
  if (!fs.existsSync(path.join(metadata.root, ".pkm-next-workspace"))) await initialize(metadata.root);
  const storage = await Storage.open(metadata.root, { deferRecovery: true });
  const binding = { root: metadata.root, workspaceId: await storage.workspaceId(), actorId: metadata.actorId,
    sourceFingerprint: metadata.sourceFingerprint, namespace: metadata.namespace, chatId: metadata.chatId };
  const database = storage.connectNative(), { HostPythonRecipe } = await load("host-python-recipe");
  let recipes, runtime, closed = false;
  const owner = database.prepare("SELECT name FROM sqlite_master WHERE name='runtime_process_owner'").get()
    ? database.prepare("SELECT owner_id,closed FROM runtime_process_owner WHERE singleton=1").get() : undefined;
  if (owner?.closed === 0 && !recover) { await storage.close(); throw Error("Explicit exact prior-owner recovery required."); }
  const checkEnvironment = program => {
    const native = new PythonEnvironmentAuthority(() => { storage.assertWorkspaceLease(); return !closed; },
      () => readProfilePythonRegistry(metadata.registry));
    try {
      const handle = native.select(binding.workspaceId, binding.actorId, program.handle.environmentId);
      if (JSON.stringify(handle) !== JSON.stringify(program.handle)) throw Error("Original Python registry/root/interpreter changed.");
    } finally { native.revoke(); }
  };
  const python = new HostPythonRecipe({ database, binding, cwd: metadata.workspace, recipes: () => recipes,
    assertOwner: () => storage.assertWorkspaceLease(), environmentIds: () => readProfilePythonRegistry(metadata.registry).map(row => row.id),
    checkEnvironment, ...(owner?.closed === 0 ? { recoverPreviousOwner: String(owner.owner_id) } : {}),
    jobCreated(runId, jobId, phase) { fs.appendFileSync(path.join(metadata.directory, "job-links.jsonl"),
      JSON.stringify({ runId, jobId, phase }) + "\n", { mode: 0o600 }); } });
  const { LegacyApiChatRecipes } = await load("legacy-api-chat-recipes");
  recipes = new LegacyApiChatRecipes({ ...binding, library: { database }, adapters: { "pkm.step.script/v1": python.adapter() },
    assertLease: () => storage.assertWorkspaceLease(), authorize: async (candidate, operation, approval) =>
      JSON.stringify(candidate) === JSON.stringify(binding) && (operation !== "create" || python.admit(candidate, approval)) });
  const mutations = new Set(), { canonicalJson } = await load("domain/project-recipes-workflow-contracts");
  const publicRecipes = new (await load("native-recipe-public-api")).NativeRecipePublicApi({
    recipes, binding, uiApprovals: true, authorizeMutation: async request => {
      const key = canonicalJson(request), allowed = mutations.has(key); mutations.delete(key); return allowed;
    } });
  runtime = await (await load("native-runtime")).createNativeRuntime({ storage, workspaceId: binding.workspaceId,
    recipeApi: publicRecipes, workflow: { adapters: recipes.adapters, resolveRecipe: recipes.resolveRecipe, leaseMs: 30000 } });
  recipes.bindRuntime(runtime.core, runtime.services.workflow);
  let state = await recipes.state(binding);
  if (!state.recipes.length) {
    await recipes.saveLibrary(binding, { namespace: binding.namespace, chatId: binding.chatId, operationId: randomUUID(),
      recipeId: metadata.recipeId, expectedRevision: 0, expectedDigest: state.digest,
      fields: { name: "Genuine SQL Python Recipe", category: "", description: "Reviewed local Python",
        definition: definition(metadata.record.id) } });
  }
  const actor = { id: binding.actorId, canWrite: true, recipeProtocol: true };
  const env = { ...metadata, binding, storage, database, python, recipes, runtime, publicRecipes, actor,
    async args(value = "value", mode = "complete") {
      return { namespace: binding.namespace, chatId: binding.chatId, operationId: randomUUID(),
        recipeId: metadata.recipeId, expectedDigest: (await recipes.state(binding)).digest, inputs: { value, mode } };
    },
    grantMutation(operation, args) { mutations.add(canonicalJson({ operation, args, actor })); },
    async approvePython(args) {
      const preview = await python.preview({ operation: "recipe.runtime.start", args });
      const native = new PythonEnvironmentAuthority(() => !closed, () => readProfilePythonRegistry(metadata.registry));
      const authority = new PythonRecipeAuthority({ trusted: () => !closed, environments: native, binding, cwd: metadata.workspace });
      try {
        const grant = authority.select(preview); authority.approve(grant);
        const approved = authority.consume(grant); await python.approve(approved);
        return { preview, approved };
      } finally { authority.revoke(); native.revoke(); }
    },
    jobs() { return database.prepare("SELECT record_json FROM runtime_process_jobs ORDER BY rowid").all().map(row => JSON.parse(row.record_json)); },
    effects() { const file = path.join(metadata.workspace, "effects.jsonl");
      return fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : []; },
    async close() {
      if (closed) return;
      try { await python.close(); recipes.close(); await runtime.close(); } finally { closed = true; await storage.close(); }
    } };
  return env;
}
async function serve(metadata, recover) {
  const env = await open(metadata, recover), token = randomUUID();
  const http = await (await load("http")).startHttp(env.runtime.core, token, env.actor, 0);
  const mcp = await (await load("recipe-mcp-http")).startRecipeMcpHttp(env.runtime.core, env.actor, token);
  process.send({ type: "ready", http: http.url, mcp: mcp.url, token, binding: env.binding });
  process.on("message", async message => {
    try {
      let result;
      if (message.method === "args") result = await env.args(message.value, message.mode);
      else if (message.method === "preview") result = await env.python.preview(message.input);
      else if (message.method === "approve-python") result = await env.python.approve(message.input);
      else if (message.method === "approve-public") result = await env.publicRecipes.approve(env.binding, message.input);
      else if (message.method === "jobs") result = env.jobs();
      else if (message.method === "close") {
        await mcp.close(); http.server.closeAllConnections(); await new Promise(resolve => http.server.close(resolve)); await env.close();
        process.send({ id: message.id, result: true }); process.disconnect(); return;
      } else throw Error("Unknown private native fixture command.");
      process.send({ id: message.id, result });
    } catch (error) { process.send({ id: message.id, error: String(error.stack) }); }
  });
}
module.exports = { prepare, open, load, definition, hash };
if (require.main === module) {
  const metadata = JSON.parse(fs.readFileSync(path.join(process.argv[2], "fixture.json")));
  serve(metadata, process.argv[3] === "recover").catch(error => { console.error(error); process.exitCode = 1; process.disconnect?.(); });
}
