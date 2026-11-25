import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, realpath, rm, truncate, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

process.env.PKM_ACTION_SOURCE_IDENTITY = "frozen-original-v2";
const [{ captureOriginalMcpCustody }, domain, { originalDigest }] = await Promise.all([
  import("../dist/original-mcp-root.js"), import("../dist/original-mcp-action-domain.js"),
  import("../dist/domain/action-compiler-validation.js"),
]);
const hash = value => createHash("sha256").update(value).digest("hex");
const producer = `
import hashlib,json,os,platform,sys,time,uuid
from pathlib import Path
from action_modules import ModuleRuntime,LAUNCHERS,digest
from recipe_runtime import _atomic_write
root,workspace,node=map(Path,sys.argv[1:4])
runtime=ModuleRuntime(root)
runtime.configure_workspace(str(workspace))
review=runtime.register({"schema":"pkm.action.definition/v1","action_id":"fixture.domain.review","version":1,
 "input_schema":{"type":"object","properties":{},"additionalProperties":False},
 "output_schema":{"type":"object","properties":{"value":{}},"required":["value"],"additionalProperties":False},
 "effects":["pure","human-input"],"dependencies":{},
 "implementations":[{"kind":"pipeline","platforms":[platform.system()],"steps":[
  {"id":"pre","component":"core.checkpoint","inputs":{"kind":"decision","proposal":{"prior":"already answered"},
   "answer_schema":{"type":"object"},"test_answer":{}}},
  {"id":"review","component":"core.checkpoint",
   "inputs":{"kind":"approval","proposal":{"revision":"actual-old-source","change":"fixture only"},
    "answer_schema":{"type":"object","properties":{"approved":{"type":"boolean"}},"required":["approved"],"additionalProperties":False},
    "test_answer":{"approved":True}}}],"output":{"value":{"$step":"review.value"}}}],
 "examples":[{"inputs":{}}]})
assert runtime.validate(review["action_id"],review["content_hash"])["ok"]
waiting=runtime.call(review["action_id"],{},"old-wait",review["content_hash"])
until=time.monotonic()+15
while time.monotonic()<until:
 waiting=runtime.get(waiting["run_id"])
 if waiting["state"]=="waiting": break
 time.sleep(.02)
assert waiting["state"]=="waiting",waiting
prior=waiting["checkpoint"]
runtime.recovery.respond_checkpoint(waiting["run_id"],prior["checkpoint_id"],prior["resume_token"],
 prior["proposal_digest"],{},"old-native-answer")
until=time.monotonic()+15
while time.monotonic()<until:
 waiting=runtime.get(waiting["run_id"])
 if waiting["state"]=="waiting" and waiting["checkpoint"]["step"]=="review":break
 time.sleep(.02)
assert waiting["state"]=="waiting" and waiting["checkpoint"]["step"]=="review",waiting
echo=runtime.register({"schema":"pkm.action.definition/v1","action_id":"fixture.domain.echo","version":1,
 "input_schema":{"type":"object","properties":{"value":{"type":"string"}},"required":["value"],"additionalProperties":False},
 "output_schema":{"type":"object","properties":{"value":{"type":"string"}},"required":["value"],"additionalProperties":False},
 "effects":["pure"],"dependencies":{},"implementations":[{"id":"node","kind":"program","platforms":[platform.system()],
 "program":str(node),"args":["-e",sys.argv[5] if len(sys.argv)>5 else "let s='';for await(const c of process.stdin)s+=c;console.log(JSON.stringify({value:JSON.parse(s).value+'-old-output'}))"]}],
 "examples":[{"inputs":{"value":"example"},"output":{"value":"example-old-output"}}]})
_atomic_write(runtime.root/"policy.json",{"schema":"pkm.action.policy/v1","grants":[
 {"action_id":echo["action_id"],"content_hash":echo["content_hash"],"trusted_host_execution":True,"authorization_source":"operator"}]})
assert runtime.validate(echo["action_id"],echo["content_hash"])["ok"]
success=runtime.call(echo["action_id"],{"value":"kept"},"old-success",echo["content_hash"])
success=runtime.wait(success["run_id"])
assert success["state"]=="succeeded",success
abandoned={**success,"run_id":"action_run_"+uuid.uuid4().hex,"state":"running","inputs":{"value":"never-replayed"}}
abandoned.pop("output",None);abandoned.pop("execution",None)
abandoned["root_run_id"]=abandoned["run_id"]
runtime.runs.prepare(abandoned,runtime.root/"module-keys"/(digest("abandoned")+".json"),digest("old-unfinished"),echo)
runtime.runs.transition(abandoned,"dispatched","old-worker-unavailable")
unselected={**abandoned,"run_id":"action_run_"+uuid.uuid4().hex}
unselected["root_run_id"]=unselected["run_id"];unselected.pop("execution",None)
runtime.runs.prepare(unselected,runtime.root/"module-keys"/(digest("unselected")+".json"),digest("unselected-old-work"),echo)
queue1=runtime.queue_enqueue(echo["action_id"],echo["content_hash"],launch=False)
queue2=runtime.queue_enqueue(review["action_id"],review["content_hash"],allow_effects=True,launch=False)
queue=runtime.queue_read()
queue["jobs"][queue1["job_id"]]["state"]="running";queue["jobs"][queue1["job_id"]]["stage"]="test"
queue["jobs"][queue2["job_id"]]["state"]="queued";queue["jobs"][queue2["job_id"]]["stage"]="queued"
queue["worker_pid"]=999999
runtime.queue_save(queue)
settings=runtime.settings();settings["implementation_bindings"]={review["action_id"]:"old-missing-implementation"}
settings["enabled_module_sets"]={"fixture.domain.package":1}
_atomic_write(runtime.root/"settings.json",settings)
waiting=json.loads(runtime.path(waiting["run_id"]).read_text())
waiting["notifications"]=[{"sequence":7,"run_id":waiting["run_id"],"kind":"observing","at":1.0,
 "payload":{"remote_id":"actual-retained-notification"}}];waiting["event_sequence"]=7
_atomic_write(runtime.path(waiting["run_id"]),waiting)
if sys.argv[4]=="cancelled":_atomic_write(runtime.path(waiting["run_id"]).with_name("cancel.json"),{"requested":True})
for process in list(LAUNCHERS.values()):
 try:process.wait(timeout=5)
 except TimeoutError:raise AssertionError("Fixture old worker did not drain")
print(json.dumps({"waiting":waiting,"success":success,"abandoned":abandoned,
 "review":review,"echo":echo,"unselected":unselected["run_id"],"priorCheckpoint":prior["checkpoint_id"],"queue":[queue1["job_id"],queue2["job_id"]]}))
`;

/** Real isolated original Action source/state and selected B0, never platform qualification. */
export async function createOriginalMcpActionCustodyFixture(t, options = {}) {
  const directory = resolve("tests", `.original-action-domain-${randomUUID()}`), root = join(directory, "root"), cleanup = [];
  await mkdir(join(root, "notes"), { recursive: true, mode: 0o700 });
  await mkdir(join(root, ".pkm"), { recursive: true, mode: 0o700 });
  await mkdir(join(directory, "old-workspaces"), { mode: 0o700 });
  await writeFile(join(root, "notes/Entry.md"), "---\ntitle: Entry\n---\nOriginal source admission fixture.\n", { mode: 0o600 });
  await writeFile(join(root, ".pkm/content-privacy.json"), '{"schema":1,"private":{}}', { mode: 0o600 });
  t.after(async () => { for (const close of cleanup.reverse()) await close(); await rm(directory, { recursive: true, force: true }); });
  const old = JSON.parse(execFileSync("python3", ["-c", producer, root, join(directory, "old-workspaces"), await realpath(process.execPath),
    options.cancelled ? "cancelled" : "none", ...(options.programCode ? [options.programCode] : [])], {
    encoding: "utf8", timeout: 45_000, env: { ...process.env, PYTHONPATH: resolve("legacy/resources"),
      TMPDIR: directory, PYTHONDONTWRITEBYTECODE: "1" },
  }));
  const moduleId = "fixture.domain.module";
  const moduleRaw = {
    schema: "pkm.action.definition/v1", action_id: moduleId, version: 1, description: "Exact original installed package member.",
    knowledgeId: `action_${originalDigest(moduleId).slice(0, 24)}`, dependencies: {}, casts: {},
    input_schema: { type: "object", properties: {}, additionalProperties: false },
    output_schema: { type: "object", properties: { value: { type: "number" } }, required: ["value"], additionalProperties: false },
    effects: ["pure"], implementations: [{ id: "native", kind: "pipeline", platforms: ["Linux", "Windows", "Darwin"],
      steps: [{ id: "number", component: "core.constant", implementation: "javascript", inputs: { value: 7 } }],
      output: { value: { $step: "number.value" } } }], examples: [{ inputs: {}, output: { value: 7 } }],
  };
  const member = `definitions/${moduleId}.json`, memberText = JSON.stringify(moduleRaw), modulePath = "action-module-sets/fixture.domain.package/1";
  const unsigned = { schema: "pkm.action.module-set/v1", module_set_id: "fixture.domain.package", version: 1,
    name: "Original independently backed package", actions: [moduleId], files: { [member]: hash(memberText) },
    provenance: { fixture: "actual installed layout; no host settings" }, resources: {} };
  const manifest = { ...unsigned, package_hash: originalDigest(unsigned) }, manifestText = JSON.stringify(manifest);
  await mkdir(join(root, modulePath, "definitions"), { recursive: true, mode: 0o700 });
  await writeFile(join(root, modulePath, "manifest.json"), manifestText, { mode: 0o600 });
  await writeFile(join(root, modulePath, member), memberText, { mode: 0o600 });
  await mkdir(join(root, "action-sources"), { mode: 0o700 });
  await writeFile(join(root, "action-sources/proof.txt"), "Independently backed source bytes.", { mode: 0o600 });
  if (options.large) {
    await writeFile(join(root, "action-sources/unselected-large.bin"), "", { mode: 0o600 });
    await truncate(join(root, "action-sources/unselected-large.bin"), 25 * 1024 ** 3);
  }
  const plan = await captureOriginalMcpCustody({ root, backup: join(directory, "base-b0"), operatorId: "native-action-fixture",
    profileSha256: options.profileSha256 ?? hash("current native Action profile"),
    limits: { maxEntries: 3000, maxDepth: 32, maxBytes: 134_217_728, maxFileBytes: 33_554_432 } });
  const registry = await Promise.all(["fixture.domain.review", "fixture.domain.echo"].map(async id => {
    const path = `actions/${id}.json`; return { path, sha256: hash(await readFile(join(root, path))) };
  }));
  const node = await realpath(process.execPath), nodeBytes = await readFile(node);
  const selection = {
    definitions: registry, moduleSets: [{ path: modulePath, manifestSha256: hash(manifestText) }],
    assets: [{ path: "action-sources/proof.txt", sha256: hash("Independently backed source bytes.") }],
    toolchains: [{ path: node, sha256: hash(nodeBytes), role: "runtime" }],
    selections: [{ actionId: old.review.action_id, implementationId: "index:0", sourcePath: registry[0].path },
      { actionId: old.echo.action_id, implementationId: "node", sourcePath: registry[1].path },
      { actionId: moduleId, implementationId: "native", sourcePath: modulePath }],
    runIds: [old.waiting.run_id, old.success.run_id, old.abandoned.run_id],
    stateFiles: [".pkm/state/actions/validation-queue.json", `.pkm/state/actions/validations/${old.review.action_id}.json`],
  };
  const custody = await domain.captureOriginalMcpActionCustody(plan, { backup: join(directory, "action-b0"), selection });
  const oldSettings = await readFile(join(root, ".pkm/state/actions/settings.json"));
  return { directory, root, cleanup, old, moduleRaw, plan, selection, custody, oldSettings };
}
