"use strict";
const fs = require("node:fs"), path = require("node:path"), assert = require("node:assert/strict");
const { spawn } = require("node:child_process"), { createHash, randomUUID } = require("node:crypto");
const digest = value => createHash("sha256").update(value).digest("hex");
const literal = 'SATURN $(touch NEVER-CREATED) ; & " literal argv';
const worker = `"use strict";
const fs=require("node:fs");
const [file,node,mode,literal]=process.argv.slice(2);
const fd=fs.openSync(file,"a",0o600);
try{fs.writeSync(fd,JSON.stringify({node,mode,literal})+"\\n");fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
console.log(JSON.stringify({node,literal}));
if(mode==="hold"){
 if(process.env.PKM_LAZY_OWNED_PIPE==="1"){process.stdin.resume();process.stdin.on("end",()=>process.exit(125));}
 setInterval(()=>{},1000);
}
`;
function create({ fixture, root, extension, untyped = false }) {
  const mask = process.umask(0o077);
  try {
    assert.equal(fs.realpathSync(root), path.join(fs.realpathSync(fixture), "knowledge"));
    const nonce = fs.readFileSync(path.join(fixture, "native-ui-fixture-token"), "utf8");
    const script = path.join(fixture, "workspace", "controlled-lazy-worker.cjs");
    fs.writeFileSync(script, worker, { flag: "wx", mode: 0o600 });
    const effects = path.join(fixture, "workspace", "controlled-lazy-effects.jsonl");
    const definition = { schema: "pkm.workflow.definition/v1", spec: {
      inputs: { mode: { type: "string", required: true, nullable: false, schema: {} },
        literal: { type: "string", required: false, default: literal, nullable: false, schema: {} } },
      nodes: ["first", "second"].map((nodeId, index) => ({
        nodeId, kind: "pkm.step.command/v1", config: {
          program: process.execPath, args: [script, effects, nodeId, index ? "complete" : "${inputs.mode}", "${inputs.literal}"],
          cwd: path.join(fixture, "workspace"), timeoutSeconds: 30, maxOutputBytes: 8192,
        }, dependsOn: index ? [{ from: "first", accept: ["succeeded"], required: true }] : [],
      })), outputs: {}, completion: { requiredNodes: ["second"] },
    } };
    if (untyped) definition.spec.inputs = {};
    const { ProjectStore } = require(path.join(extension, "dist/workflows/project-store.js"));
    const store = new ProjectStore(path.join(root, ".pkm/state"));
    const command = () => ({ commandId: randomUUID(), fingerprint: randomUUID(), expectedStoreVersion: store.list().storeVersion });
    const created = store.createRecipe(command(), { kind: "global" }, "SATURN controlled lazy Recipe", "Synthetic");
    store.updateRecipe(command(), created.entityId, { name: "SATURN controlled lazy Recipe", category: "Synthetic",
      description: "Exact fixed local command fixture only, not a generic executable grant.", definition });
    const recipe = store.list().recipes.find(item => item.recipeId === created.entityId);
    const evidence = { recipe, recipeId: recipe.recipeId, definition: recipe.definition, literal, script, effects,
      nonce, scriptSha256: digest(worker), program: process.execPath, programSha256: digest(fs.readFileSync(process.execPath)) };
    fs.writeFileSync(path.join(fixture, "controlled-lazy-recipe-evidence.json"), JSON.stringify(evidence), { flag: "wx", mode: 0o600 });
    return evidence;
  } finally { process.umask(mask); }
}
function adapter({ fixture, actorId, canonicalJson }) {
  const evidence = JSON.parse(fs.readFileSync(path.join(fixture, "controlled-lazy-recipe-evidence.json")));
  const owned = new Map(), executions = [];
  const assertFiles = () => {
    assert.equal(fs.readFileSync(path.join(fixture, "native-ui-fixture-token"), "utf8"), evidence.nonce);
    for (const [file, hash] of [[evidence.script, evidence.scriptSha256], [evidence.program, evidence.programSha256]]) {
      const stat = fs.lstatSync(file);
      assert(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.uid === process.getuid());
      assert.equal(digest(fs.readFileSync(file)), hash);
    }
    assert.equal(fs.realpathSync(path.dirname(evidence.effects)), path.join(fs.realpathSync(fixture), "workspace"));
    const effect = fs.lstatSync(evidence.effects, { throwIfNoEntry: false });
    if (effect) assert(effect.isFile() && !effect.isSymbolicLink() && effect.nlink === 1 && effect.uid === process.getuid() && !(effect.mode & 0o077));
  };
  const matches = binding => {
    try {
      assertFiles();
      return binding.actorId === actorId && binding.executableDigest === evidence.recipe.executableDigest
        && binding.source?.kind === "recipe" && binding.source?.recipeId === evidence.recipeId
        && canonicalJson(binding.node) === canonicalJson(evidence.definition.spec.nodes.find(node => node.nodeId === binding.node.nodeId));
    } catch { return false; }
  };
  const step = {
    id: "private-controlled-lazy-command", version: 1,
    outputContractDigest: digest("actual-original-command-result-v1"),
    authorizationDigest: digest(canonicalJson({ actorId, recipeId: evidence.recipeId,
      executableDigest: evidence.recipe.executableDigest, scriptSha256: evidence.scriptSha256, programSha256: evidence.programSha256 })),
    authorizeDefinition: matches,
    authorizeData(binding) {
      return matches(binding) && ["complete", "hold"].includes(binding.inputs.mode) && binding.inputs.literal === evidence.literal;
    },
    validateOutput(outputs) { return outputs && typeof outputs.result?.ok === "boolean"; },
    async execute(invocation, { signal }) {
      assertFiles();
      assert.equal(invocation.actorId, actorId);
      const config = invocation.node.config;
      const render = value => value.replace(/\$\{inputs\.(mode|literal)\}/g, (_match, key) => invocation.inputs[key]);
      const argv = [config.program, ...config.args.map(render)], started = new Date().toISOString();
      const key = invocation.runId + ":" + invocation.node.nodeId;
      assert(!owned.has(key));
      const child = spawn(argv[0], argv.slice(1), { cwd: config.cwd, shell: false,
        env: { HOME: path.join(fixture, "h"), PATH: path.dirname(evidence.program), PKM_LAZY_OWNED_PIPE: "1" },
        stdio: ["pipe", "pipe", "pipe"] });
      const active = { child, cancelled: false }; owned.set(key, active); executions.push({ runId: invocation.runId, argv });
      let stdout = "", stderr = "";
      child.stdout.on("data", data => { stdout = (stdout + data).slice(0, 8192); });
      child.stderr.on("data", data => { stderr = (stderr + data).slice(0, 8192); });
      const abort = () => child.kill("SIGKILL");
      signal.addEventListener("abort", abort, { once: true });
      const timer = setTimeout(abort, 30000);
      try {
        const [code, killed] = await new Promise((resolve, reject) => {
          child.once("error", reject); child.once("close", (code, killed) => resolve([code, killed]));
        });
        const result = { started_at: started, argv, completed_at: new Date().toISOString(),
          ok: code === 0 && !active.cancelled, exit_code: killed === "SIGKILL" ? -9 : code,
          cancelled: active.cancelled, timed_out: false, stdout, stderr,
          stdout_truncated: false, stderr_truncated: false,
          ...(active.cancelled ? { error: "Recipe cancellation requested." } : code !== 0 ? { error: "Command exited with a non-zero status." } : {}) };
        return { status: result.ok ? "succeeded" : "failed", outputs: { result } };
      } finally { clearTimeout(timer); signal.removeEventListener("abort", abort); owned.delete(key); }
    },
  };
  return { evidence, adapters: { "pkm.step.command/v1": step }, owned, executions,
    requestCancel({ runId, nodeId }) {
      const active = owned.get(runId + ":" + nodeId);
      if (active) { active.cancelled = true; active.child.kill("SIGKILL"); }
    } };
}
module.exports = { create, adapter };
