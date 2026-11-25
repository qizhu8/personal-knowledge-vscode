import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { createRequire } from "node:module";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url), preparations = new WeakMap();
const archiveSha256 = "1804071cb3b9fc86edc5933d5001db6ea1a8d7a9adf30d6d2b3166fcd6048f27";
const hash = value => createHash("sha256").update(value).digest("hex");
const load = (installed, name) => import(pathToFileURL(join(installed, "next-runtime/server/dist", `${name}.js`)).href);
const members = Object.freeze(["package.json", "dist/workflows/recipe-filesystem-store.js", "dist/workflows/workflow-contracts.js",
  "dist/workflows/value-contracts.js", "dist/workflows/methodology-model.js", "dist/knowledge/knowledge-contracts.js",
  "resources/recipe_runtime.py", "resources/recipe_health.py", "resources/recipe_compiler_bridge.js"]);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function fail(code) { throw Object.assign(new Error(code), { code }); }
function stateFor(source) {
  const state = preparations.get(source);
  if (!state) fail("INSTALLED_RECIPE_ACTUAL_PREPARATION_REQUIRED");
  return state;
}
async function absent(path, code) {
  try { await lstat(path); fail(code); } catch (error) { if (error.code !== "ENOENT") throw error; }
}
async function pinnedArchive(path) {
  if (typeof path !== "string" || !isAbsolute(path) || resolve(path) !== path) fail("INSTALLED_RECIPE_PINNED_ORIGINAL_REQUIRED");
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 268435456 || await realpath(path) !== path)
    fail("INSTALLED_RECIPE_ORIGINAL_PACKAGE_CHANGED");
  const bytes = await readFile(path);
  if (hash(bytes) !== archiveSha256) fail("INSTALLED_RECIPE_ORIGINAL_PACKAGE_CHANGED");
  return bytes;
}
async function unchanged(state, root = state.value.root) {
  for (const file of state.files) assert.deepEqual(await readFile(join(root, file.path)), file.bytes);
}
function projection(value) {
  const result = structuredClone(value);
  const visit = item => {
    if (!item || typeof item !== "object") return;
    for (const key of Object.keys(item)) {
      if (["started_at", "last_heartbeat_at", "last_progress_at", "heartbeat_age_seconds", "progress_age_seconds"].includes(key)) delete item[key];
      else visit(item[key]);
    }
  };
  visit(result); return result;
}
async function waitJson(path, timeoutMs, check = () => {}) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    check();
    try {
      const value = JSON.parse(await readFile(path, "utf8"));
      if (value.failed) throw new Error(`Installed Recipe UI failed: ${value.error}`);
      return value;
    } catch (error) { if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error; }
    await delay(25);
  }
  throw new Error(`Installed Recipe evidence timed out: ${path}`);
}
async function driverIdentity(root, installed) {
  const stat = await lstat(root);
  if (!isAbsolute(root) || resolve(root) !== root || await realpath(root) !== root
    || !/^\.installed-host-[a-f0-9-]{36}$/.test(basename(root)) || !stat.isDirectory() || stat.isSymbolicLink()
    || stat.uid !== process.getuid() || stat.mode & 0o077) fail("INSTALLED_RECIPE_PRIVATE_DRIVER_REQUIRED");
  const first = JSON.parse(await readFile(join(root, "native-identity-first.json"), "utf8"));
  const proof = JSON.parse(await readFile(join(root, "native-identity-passed.json"), "utf8"));
  const member = typeof first.result?.path === "string" ? relative(root, first.result.path) : "";
  if (!member || member === ".." || member.startsWith(`..${sep}`) || isAbsolute(member)
    || await realpath(first.result.path) !== first.result.path) fail("INSTALLED_RECIPE_ENROLLED_PROFILE_REQUIRED");
  (await load(installed, "original-mcp-native-identity")).verifyOriginalMcpNativeIdentity(
    JSON.parse(first.publicRecord), first.result.sha256, first.result.profileSha256);
  assert.equal(await readFile(first.result.path, "utf8"), first.publicRecord);
  assert.equal(proof.passed, true); assert.equal(proof.realInstalledExtension, true);
  assert.equal(proof.identitySha256, first.result.sha256);
  return first;
}

/** Before B0/custody and after complete editor exit. Exact original release only; no source checkout fallback. */
export async function prepareInstalledNativeRecipeFixture({ installed, componentFixture, legacyVsix, python }) {
  await (await load(installed, "original-mcp-component-recovery")).assertOriginalMcpColdComponentFixture(componentFixture);
  if (preparations.has(componentFixture)) fail("INSTALLED_RECIPE_ALREADY_PREPARED");
  for (const path of [join(componentFixture.directory, "b0"), join(componentFixture.directory, "custody"),
    join(componentFixture.root, ".pkm-next-original-mcp.json"), join(componentFixture.root, "core.sqlite")])
    await absent(path, "INSTALLED_RECIPE_PRESEAL_PREPARATION_REQUIRED");
  const archive = await pinnedArchive(legacyVsix);
  if (typeof python !== "string" || !isAbsolute(python)) fail("INSTALLED_RECIPE_EXPLICIT_PYTHON_REQUIRED");
  for (const path of [join(componentFixture.root, "recipes"), join(componentFixture.root, ".pkm/state/recipe-store.json")])
    await absent(path, "INSTALLED_RECIPE_ORIGINAL_LIBRARY_ALREADY_EXISTS");
  const writer = join(componentFixture.directory, "original-recipe-writer");
  await mkdir(writer, { mode: 0o700 });
  execFileSync(python, ["-I", "-B", "-c", `
import io,json,stat,sys,zipfile
from pathlib import Path,PurePosixPath
root=Path(sys.argv[1]);total=0
with zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())) as archive:
 names=archive.namelist()
 metadata=json.loads(archive.read("extension/package.json"))
 assert (metadata["publisher"].lower(),metadata["name"],metadata["version"])==("uone","personal-knowledge","4.0.22")
 for member in json.loads(sys.argv[2]):
  path=PurePosixPath(member);name="extension/"+member
  assert not path.is_absolute() and ".." not in path.parts and "\\\\" not in member and ":" not in member
  assert names.count(name)==1
  info=archive.getinfo(name);total+=info.file_size
  assert not info.is_dir() and not stat.S_ISLNK(info.external_attr>>16) and info.file_size<=2097152 and total<=10485760
  target=root.joinpath(*path.parts);target.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
  with target.open("xb") as output:output.write(archive.read(info))
`, writer, JSON.stringify(members)], { input: archive, timeout: 30000, maxBuffer: 1048576 });
  const writerFiles = Object.fromEntries(await Promise.all(members.map(async member => [member, hash(await readFile(join(writer, member)))])));
  // Fixture-only compiler configuration points the unmodified original bridge at an exact executable/contracts pair.
  await writeFile(join(writer, "resources/recipe_compiler_config.json"), JSON.stringify({
    executable: process.execPath, contracts: join(writer, "dist/workflows/workflow-contracts.js"),
  }), { mode: 0o600, flag: "wx" });
  const { RecipeFilesystemStore, safeRecipeFileName } = require(join(writer, "dist/workflows/recipe-filesystem-store.js"));
  const { compileWorkflowDefinitionV1 } = require(join(writer, "dist/workflows/workflow-contracts.js"));
  const definition = { schema: "pkm.workflow.definition/v1", spec: { inputs: {}, outputs: {}, nodes: [
    { nodeId: "first", kind: "pkm.step.noop/v1", config: {}, dependsOn: [] },
    { nodeId: "second", kind: "pkm.step.noop/v1", config: {}, dependsOn: [{ from: "first", accept: ["succeeded"] }] },
  ], completion: { requiredNodes: ["second"] } } };
  const compiled = compileWorkflowDefinitionV1(definition); assert.equal(compiled.ok, true);
  let recipe;
  const mask = process.umask(0o077);
  try {
    recipe = new RecipeFilesystemStore(join(componentFixture.root, ".pkm/state")).put({
      recipeId: "recipe_installed_external", name: "Installed original external Recipe 工作", description: "Caller work, native receipts",
      scope: "global", category: "", revision: 3, definition: compiled.model, executableDigest: compiled.executableDigest,
    });
    const oracleRoot = join(componentFixture.directory, "original-recipe-oracle");
    new RecipeFilesystemStore(join(oracleRoot, ".pkm/state")).put(recipe);
  } finally { process.umask(mask); }
  const callerEvidencePath = join(componentFixture.directory, "recipe-caller-evidence.txt");
  const callerBytes = Buffer.from("Actual external caller-owned evidence. Native Recipe code only records the explicit report.\n");
  await writeFile(callerEvidencePath, callerBytes, { mode: 0o600, flag: "wx" });
  const commandId = "installed-original-recipe-flow", runId = `recipe_run_${hash(commandId).slice(0, 24)}`;
  const start = { recipe_id: recipe.recipeId, command_id: commandId, expected_revision: recipe.revision,
    expected_digest: recipe.executableDigest, inputs_json: '{"task":"external caller reads its own exact fixture evidence"}' };
  const reportFirst = { run_id: runId, node_id: "first", command_id: "installed-report-first", outcome: "succeeded",
    result_json: JSON.stringify({ sha256: hash(callerBytes), authority: "external-caller-reported-not-native-verified" }),
    usage_json: '{"estimated_tokens":12}', detail: "full" };
  const reportSecond = { run_id: runId, node_id: "second", command_id: "installed-report-second", outcome: "succeeded",
    result_json: "null", detail: "full" };
  const calls = [
    ["start", "recipe_run_start", start], ["get-initial", "recipe_run_get", { run_id: runId }],
    ["next", "recipe_run_next", { run_id: runId, command_id: "installed-claim-first" }],
    ["get-claimed", "recipe_run_get", { run_id: runId, detail: "compact" }],
    ["report-first", "recipe_run_report", reportFirst], ["report-second", "recipe_run_report", reportSecond],
    ["get-terminal", "recipe_run_get", { run_id: runId }],
    ["start-replay", "recipe_run_start", start], ["report-replay", "recipe_run_report", reportFirst],
    ["report-conflict", "recipe_run_report", { ...reportFirst, result_json: '{"changed":true}' }],
  ].map(([phase, tool, args]) => ({ phase, tool, args }));
  const expected = JSON.parse(execFileSync(python, ["-I", "-B", "-c", `
import importlib.util,json,sys
from pathlib import Path
resources=Path(sys.argv[1]);compiler=[sys.argv[3],str(resources/"recipe_compiler_bridge.js"),str(resources.parent/"dist/workflows/workflow-contracts.js")]
def audit(event,args):
 if event=="subprocess.Popen":
  if list(args[1])!=compiler:raise PermissionError("Only the exact original pure Recipe compiler bridge is allowed")
 elif event in {"os.system","os.exec","os.posix_spawn","os.fork","os.forkpty","socket.connect","socket.bind",
                "socket.getaddrinfo","socket.gethostbyname","socket.gethostbyaddr","socket.sendto"}:
  raise PermissionError("Installed Recipe oracle grants no process, model or network authority")
sys.addaudithook(audit);sys.path.insert(0,str(resources))
spec=importlib.util.spec_from_file_location("pinned_installed_recipe_oracle",resources/"recipe_runtime.py")
runtime=importlib.util.module_from_spec(spec);spec.loader.exec_module(runtime)
class Registration:
 def __init__(self):self.tools={}
 def tool(self,**kwargs):
  def register(function):
   self.tools[function.__name__]=function
   return function
  return register
registration=Registration();runtime.register_recipe_tools(registration,Path(sys.argv[2]))
print(json.dumps([registration.tools[call["tool"]](**call["args"]) for call in json.load(sys.stdin)]))
`, join(writer, "resources"), join(componentFixture.directory, "original-recipe-oracle"), process.execPath], {
    input: JSON.stringify(calls), encoding: "utf8", timeout: 45000, maxBuffer: 2_097_152,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1", TMPDIR: writer },
  }));
  assert.equal(expected[0].ok, true, JSON.stringify(expected[0])); assert.equal(expected[6].status, "completed");
  assert.equal(expected[7].replayed, true); assert.equal(expected[8].replayed, true); assert.equal(expected[9].ok, false);
  for (const member of members) assert.equal(hash(await readFile(join(writer, member))), writerFiles[member]);
  await pinnedArchive(legacyVsix);
  const files = [];
  for (const path of [".pkm/state/recipe-store.json", `recipes/Uncategorized/${safeRecipeFileName(recipe.name, recipe.recipeId)}`])
    files.push({ path, bytes: await readFile(join(componentFixture.root, path)) });
  const value = Object.freeze({ kind: "pkm.installed-native-recipe-fixture/v1", root: componentFixture.root,
    originalPackageSha256: archiveSha256, recipeId: recipe.recipeId, revision: recipe.revision,
    executableDigest: recipe.executableDigest, runId,
    files: Object.freeze(files.map(file => Object.freeze({ path: file.path, sha256: hash(file.bytes) }))) });
  const state = { value, componentFixture, installed, files, writerFiles, recipe, calls, expected,
    callerEvidencePath, callerBytes, phase: "prepared" };
  preparations.set(componentFixture, state); preparations.set(value, state);
  return value;
}

export const installedNativeRecipeUiStages = Object.freeze([
  "native-recipe-source-deny", "native-recipe-source-admit", "native-recipe-start-deny", "native-recipe-start",
  "native-recipe-get-deny", "native-recipe-get-initial", "native-recipe-next", "native-recipe-get-claimed",
  "native-recipe-report-first", "native-recipe-report-second", "native-recipe-get-terminal",
  "native-recipe-start-replay", "native-recipe-report-replay", "native-recipe-report-conflict",
  "native-recipe-revoke", "native-recipe-get-revoked", "native-recipe-complete",
]);
export const installedNativeRecipeUiProgram = String.raw`
import hashlib,json,re,sys,time
from pathlib import Path
from playwright.sync_api import sync_playwright
f=json.loads(sys.argv[1]);root=Path(f["root"]);seconds=f["timeoutMs"]/1000
until=time.monotonic()+min(seconds*4,360);proof={"schema":"pkm.installed-native-recipe-ui-evidence/v1","dialogs":[]}
def check(condition,message):
 if not condition:raise AssertionError(message)
def digest(value):return hashlib.sha256(json.dumps(value,ensure_ascii=False,sort_keys=True,separators=(",",":")).encode()).hexdigest()
def stage(name):
 stop=min(until,time.monotonic()+seconds)
 while time.monotonic()<stop:
  try:
   current=json.loads((root/"progress.json").read_text()).get("stage")
   check(current!="failed","Parent installed workflow failed")
   if current==name:return
  except (FileNotFoundError,json.JSONDecodeError):pass
  time.sleep(.025)
 raise RuntimeError("Installed Recipe stage timed out: "+name)
def publish(name,value):
 with (root/name).open("x") as output:json.dump(value,output)
try:
 check(re.fullmatch(r"\.installed-host-[a-f0-9-]{36}",root.name),"Not a disposable installed driver")
 c=json.loads((root/"native-recipe-ui-contract.json").read_text())
 check(c["schema"]=="pkm.installed-native-recipe-ui/v1","Wrong Recipe UI contract")
 check(c["sourceRequest"]["schema"]=="pkm.original-recipe-library-source/v1","Wrong source subtype")
 check(c["sourceRequest"]["effects"]==["caller-reported-result-only"],"Unexpected Recipe effects")
 with sync_playwright() as p:
  browser=p.chromium.connect_over_cdp("http://127.0.0.1:"+str(f["port"]),timeout=f["timeoutMs"])
  pages=[page for context in browser.contexts for page in context.pages if "workbench" in page.url]
  check(len(pages)==1,"Exactly one installed workbench renderer is required")
  page=pages[0];page.set_default_timeout(f["timeoutMs"])
  publish("native-recipe-ui-ready.json",{"ready":True,"actualRenderer":True})
  for step in c["steps"]:
   if step["stage"]=="native-recipe-get-revoked":
    stage("native-recipe-revoke")
    item=page.locator(".statusbar-item").filter(has_text="PKM Recipe source")
    check(item.count()==1,"Exactly one actual Recipe-source indicator is required")
    item.hover()
    hover=page.locator(".monaco-hover").filter(has_text="Revocation closes the actual signed session.")
    hover.wait_for(state="visible");tooltip=hover.inner_text()
    for text in [c["binding"]["root"],c["binding"]["profileSha256"],c["recipeId"]+"@"+str(c["revision"])]:check(text in tooltip,"Wrong exact Recipe source tooltip")
    publish("native-recipe-revoke-observed.json",{"visible":True,"actualNativeUi":True,"statusBarNotClicked":True})
   stage(step["stage"])
   dialogs=page.locator(".monaco-dialog-box:visible");dialogs.wait_for(state="visible")
   check(dialogs.count()==1,"Multiple native modals cannot qualify Recipe consent")
   title=dialogs.get_by_text(step["title"],exact=True);check(title.count()==1 and title.is_visible(),"Wrong exact native Recipe modal title")
   text=dialogs.inner_text().replace("\u00a0"," ");start=text.find("{")
   check(start>=0,"Native Recipe modal omitted exact JSON details")
   data,_=json.JSONDecoder().raw_decode(text[start:])
   if step["kind"]=="source":
    check(data["request"]==c["sourceRequest"],"Native source request changed or omitted exact files/scope")
    check(data["requestSha256"]==digest(c["sourceRequest"]),"Wrong whole source request digest")
    session=data["session"];binding=session["binding"]
    check(session["epoch"]==c["nativeEpoch"] and session["activationId"]==c["nativeEpoch"],"Wrong native source epoch")
    check(session["identitySha256"]==c["identitySha256"],"Wrong actual enrolled identity")
    for key in ["root","workspaceId","profileSha256","planSha256"]:check(binding[key]==c["binding"][key],"Wrong signed Recipe binding: "+key)
    check(data.get("noExecution") is True,"Source admission was not source-only")
    check("each original lifecycle request needs its own current public approval" in data["permission"],"Source prompt inherited execution")
   else:
    check(data["root"]==c["binding"]["root"] and data["workspaceId"]==c["binding"]["workspaceId"],"Wrong public Recipe root/workspace")
    check(data["tool"]==step["tool"] and data["operation"]=="mcp.tool."+step["tool"] and data["version"]==1,"Wrong exact original Recipe operation")
    check(data["arguments"]==step["arguments"] and data["argumentsDigest"]==digest(step["arguments"]),"Wrong original arguments/digest")
    check(data["readOnly"]==(step["tool"]=="recipe_run_get"),"Wrong captured public annotation")
    if step["tool"]=="recipe_run_get":
     check("synchronize durable execution state" in data.get("permission",""),"Recipe getter's mutating inspection was not disclosed")
   button=dialogs.get_by_role("button",name=step["choice"],exact=True)
   check(button.count()==1 and button.is_visible(),"Wrong unique exact native approval button")
   check(dialogs.get_by_role("button",name="Deny",exact=True).count()==1,"Native Deny option is absent")
   proof["dialogs"].append({"stage":step["stage"],"choice":step["choice"],"title":step["title"],
     "visibleTextSha256":hashlib.sha256(text.encode()).hexdigest(),"exactRequestVisible":True})
   button.click()
  stage("native-recipe-complete")
  proof.update(passed=True,actualNativeUi=True,logicalRevocationProbeApproved=True,statusBarNotClicked=True)
  publish("native-recipe-ui-passed.json",proof)
except Exception as error:
 publish("native-recipe-ui-passed.json",{"failed":True,"error":str(error)})
 raise
`;
async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const done = new Promise(resolve => child.once("exit", resolve));
  child.kill("SIGTERM"); const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
  try { await done; } finally { clearTimeout(timer); }
}
function journal(database, runId) {
  const row = database.prepare("SELECT snapshot FROM workflow_executor_runs WHERE actor_id='mcp:external' AND run_id=?").get(runId);
  assert(row, "Real native scheduler snapshot is required.");
  const legacy = database.prepare("SELECT record FROM legacy_recipe_lazy_runs WHERE actor_id='mcp:external' AND run_id=?").get(runId);
  const source = database.prepare("SELECT source,record,approval FROM original_recipe_library_source WHERE singleton=1").get();
  const receipts = database.prepare("SELECT command_id,fingerprint,response FROM legacy_recipe_lazy_receipts WHERE actor_id='mcp:external' AND run_id=? ORDER BY command_id").all(runId);
  assert(legacy && source);
  return { snapshot: row.snapshot, record: legacy.record, source: source.source, sourceRecord: source.record,
    approval: source.approval, receipts: receipts.map(receipt => ({ ...receipt })) };
}
function countRuns(storage) {
  const db = storage.connectNative();
  try {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name='workflow_executor_runs'").get()) return 0;
    return db.prepare("SELECT count(*) AS count FROM workflow_executor_runs WHERE actor_id='mcp:external'").get().count;
  } finally { db.close(); }
}

/** Actual same component/public dispatcher only. Typed Recipe-only revoke leaves other source domains/session intact. */
export async function verifyInstalledNativeRecipe({ root, installed, component, sourceFixture,
  python, env, port, payloadBuildId, timeoutMs = 120000 }) {
  const state = stateFor(sourceFixture);
  if (state.installed !== installed || component.fixture !== state.componentFixture || component.root !== sourceFixture.root)
    fail("INSTALLED_RECIPE_SAME_COMPONENT_REQUIRED");
  if (typeof component.recipeSourceControl !== "function" || typeof component.invoke !== "function")
    fail("INSTALLED_RECIPE_COMPONENT_RECIPE_CONTROL_AND_PUBLIC_INVOKE_REQUIRED");
  if (state.phase !== "prepared") fail("INSTALLED_RECIPE_VERIFY_ORDER_REQUIRED");
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535 || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000)
    fail("INSTALLED_RECIPE_BOUNDED_DRIVER_REQUIRED");
  const first = await driverIdentity(root, installed), recovery = await load(installed, "original-mcp-component-recovery");
  await recovery.assertOriginalMcpColdComponentFixture(component.fixture);
  const host = await component.complete(), full = await component.owner.ensureFull(), lease = { ...component.owner.workspaceLease() };
  (await load(installed, "root-owner")).assertRootOwner(component.owner);
  (await load(installed, "original-mcp-native-host")).assertOriginalMcpNativeHost(host, component.storage);
  assert.equal(full.storage, component.storage);
  const control = await component.recipeSourceControl(), policyApi = await load(installed, "original-mcp-native-recipe-policy");
  if (control?.kind !== "pkm.original-native-recipe-source-policy/v1" || typeof control.revoke !== "function"
    || typeof control.assertCurrent !== "function") fail("INSTALLED_RECIPE_ACTUAL_SOURCE_CONTROL_REQUIRED");
  const policy = control.policy;
  control.assertCurrent();
  policyApi.assertOriginalMcpNativeRecipeSourcePolicy(policy, component.owner, host);
  const descriptorBytes = await readFile(component.attachmentDescriptorPath), descriptor = JSON.parse(descriptorBytes);
  assert.equal(hash(descriptorBytes), component.attachmentDescriptorSha256);
  assert.equal(descriptor.identitySha256, first.result.sha256);
  assert.equal(descriptor.binding.root, component.root); assert.equal(descriptor.binding.workspaceId, component.workspaceId);
  assert.equal(descriptor.binding.planSha256, component.custody.planSha256);
  assert.equal(descriptor.binding.profileSha256, first.result.profileSha256);
  assert.equal(component.custody.profileSha256, first.result.profileSha256);
  assert.equal(descriptor.binding.payloadBuildId, payloadBuildId);
  assert.equal(descriptor.binding.hostEntrySha256, hash(await readFile(join(installed, "dist/extension.cjs"))));
  assert.equal(host.receipt.authorityId, `native-rpc:${descriptor.brokerId}`);
  assert.equal(host.receipt.profileSha256, first.result.profileSha256);
  assert.equal(host.options.providerTransport.supports("openai-compatible"), false);
  assert.equal(host.options.providerTransport.supports("azure-openai"), false);
  const source = await load(installed, "original-mcp-recipe-library");
  const { originalNativeRecipeDigest: digest } = await load(installed, "original-mcp-native-recipe-contracts");
  await assert.rejects((async () => source.originalMcpRecipeLibrarySession(component.storage, component.owner, host))(),
    /Library source decision/);
  const plan = await source.planOriginalMcpRecipeLibrary(component.owner, host, {
    recipeId: sourceFixture.recipeId, expectedRevision: sourceFixture.revision,
    expectedExecutableDigest: sourceFixture.executableDigest, maxFileBytes: 2_097_152,
  });
  if (!/^[a-f0-9]{64}$/.test(component.b0?.sha256)) fail("INSTALLED_RECIPE_ACTUAL_COMPONENT_B0_REQUIRED");
  state.b0Sha256 = component.b0.sha256;
  const sourceRequest = { ...plan, phase: "admit", actorId: "mcp:external", epoch: host.receipt.epoch,
    nativeHostReceiptSha256: host.receipt.receiptSha256 };
  const sourceSteps = [
    { stage: "native-recipe-source-deny", kind: "source", title: "Admit this exact original Recipe library source?", choice: "Deny" },
    { stage: "native-recipe-source-admit", kind: "source", title: "Admit this exact original Recipe library source?", choice: "Admit this exact Recipe source only" },
  ];
  const publicStep = (stage, call, choice = "Approve this request") => ({
    stage, kind: "public", tool: call.tool, arguments: call.args,
    title: `Allow PKM v5 ${call.tool} for this exact request?`, choice,
  });
  const steps = [...sourceSteps,
    publicStep("native-recipe-start-deny", state.calls[0], "Deny"),
    publicStep("native-recipe-start", state.calls[0]), publicStep("native-recipe-get-deny", state.calls[1], "Deny"),
    ...state.calls.slice(1).map(call => publicStep(`native-recipe-${call.phase}`, call)),
    publicStep("native-recipe-get-revoked", state.calls[1]),
  ];
  await writeFile(join(root, "native-recipe-ui-contract.json"), JSON.stringify({
    schema: "pkm.installed-native-recipe-ui/v1", identitySha256: first.result.sha256, nativeEpoch: host.receipt.epoch,
    binding: { root: component.root, workspaceId: component.workspaceId, profileSha256: first.result.profileSha256,
      planSha256: component.custody.planSha256 }, recipeId: sourceFixture.recipeId, revision: sourceFixture.revision,
    sourceRequest, steps, stages: installedNativeRecipeUiStages,
  }), { mode: 0o600, flag: "wx" });
  const ui = spawn(python, ["-B", "-c", installedNativeRecipeUiProgram, JSON.stringify({ root, port, timeoutMs })], { env, stdio: "inherit" });
  const observerAbort = new AbortController();
  let uiError;
  const uiDone = new Promise((resolve, reject) => {
    ui.once("error", reject);
    ui.once("exit", (code, signal) => code === 0 ? resolve() : reject(new Error(`Installed Recipe UI exited ${code}/${signal}`)));
  });
  void uiDone.catch(error => { uiError = error; observerAbort.abort(error); });
  const checkUi = () => { if (uiError) throw uiError; };
  const progress = stage => writeFile(join(root, "progress.json"), JSON.stringify({ stage }), { mode: 0o600 });
  const readJournal = () => { const db = component.storage.connectNative(); try { return journal(db, sourceFixture.runId); } finally { db.close(); } };
  const invoke = async call => {
    checkUi();
    const result = await component.invoke(call.tool, call.args, observerAbort.signal);
    assert(!result.isError, JSON.stringify(result));
    const value = result.structuredContent ?? JSON.parse(result.content[0].text);
    assert(value && typeof value === "object" && value.schema === "pkm.recipe.api/v1", "Original JSON result, not a pilot envelope, is required.");
    return value;
  };
  state.phase = "verifying";
  try {
    await waitJson(join(root, "native-recipe-ui-ready.json"), timeoutMs, checkUi);
    await progress("native-recipe-source-deny");
    await assert.rejects(source.admitOriginalMcpRecipeLibrary(component.owner, host, plan, policy, observerAbort.signal), /denied/);
    assert.equal(countRuns(component.storage), 0);
    const db = component.storage.connectNative();
    try { assert.equal(db.prepare("SELECT count(*) AS count FROM sqlite_master WHERE name='original_recipe_library_source'").get().count, 0); }
    finally { db.close(); }
    await unchanged(state);
    await progress("native-recipe-source-admit");
    await source.admitOriginalMcpRecipeLibrary(component.owner, host, plan, policy, observerAbort.signal);
    const grant = source.originalMcpRecipeLibrarySession(component.storage, component.owner, host);
    assert.equal(grant.signal.aborted, false);
    await progress("native-recipe-start-deny"); await assert.rejects(invoke(state.calls[0]), /denied|exact native/i);
    assert.equal(countRuns(component.storage), 0);
    const actual = [];
    for (const [index, call] of state.calls.entries()) {
      if (index === 1) {
        const before = readJournal();
        await progress("native-recipe-get-deny"); await assert.rejects(invoke(call), /denied|exact native/i);
        assert.deepEqual(readJournal(), before, "Denied inspection may not synchronize native durable state.");
      }
      if (call.phase === "report-first") assert.deepEqual(await readFile(state.callerEvidencePath), state.callerBytes);
      await progress(`native-recipe-${call.phase}`);
      const value = await invoke(call);
      assert.deepEqual(projection(value), projection(state.expected[index]), `Pinned original Recipe ${call.phase} mismatch`);
      actual.push(value); await unchanged(state);
    }
    assert.equal(actual[6].status, "completed"); assert.equal(actual[7].replayed, true); assert.equal(actual[8].replayed, true);
    state.nativeJournal = readJournal();
    const native = JSON.parse(state.nativeJournal.snapshot), protocol = JSON.parse(state.nativeJournal.record);
    assert.equal(native.state, "succeeded"); assert.equal(native.runId, sourceFixture.runId);
    assert.equal(native.source.recipeId, sourceFixture.recipeId); assert.equal(native.executableDigest, sourceFixture.executableDigest);
    assert(native.nodes.every(node => node.state === "succeeded" && node.effect === "known"));
    assert.deepEqual(protocol.nodes.first.result, JSON.parse(state.calls[4].args.result_json));
    assert.equal(state.nativeJournal.receipts.length, 4);
    assert.equal(JSON.parse(state.nativeJournal.source).planSha256, plan.planSha256);
    assert.equal(JSON.parse(state.nativeJournal.approval).requestSha256, digest(sourceRequest));
    assert.deepEqual(component.owner.workspaceLease(), lease);
    await progress("native-recipe-revoke");
    await waitJson(join(root, "native-recipe-revoke-observed.json"), timeoutMs, checkUi);
    control.revoke();
    assert.equal(grant.signal.aborted, true, "Cached source/runtime authority must follow the actual typed source signal.");
    control.assertCurrent(); host.assertCurrent();
    assert.equal(host.signal.aborted, false, "Recipe-only logical revocation must preserve the attachment for Todo/other leaves.");
    await progress("native-recipe-get-revoked");
    await assert.rejects(invoke(state.calls[1]), /Library source decision/);
    assert.deepEqual(readJournal(), state.nativeJournal);
    assert.equal((await component.owner.ensureFull()).runtime.core, full.runtime.core);
    assert.deepEqual(component.owner.workspaceLease(), lease); await unchanged(state);
    await progress("native-recipe-complete");
    const uiEvidence = await waitJson(join(root, "native-recipe-ui-passed.json"), timeoutMs, checkUi);
    await uiDone;
    assert.equal(uiEvidence.actualNativeUi, true); assert.equal(uiEvidence.logicalRevocationProbeApproved, true);
    assert.equal(uiEvidence.statusBarNotClicked, true);
    assert.equal(uiEvidence.dialogs.length, steps.length);
    const evidence = { passed: true, scope: "disposable installed static NoOp external-report flow only",
      fullNineQualified: false, fullCutoverQualified: false, automaticModelOrProcessExecution: false,
      actualInstalledUi: uiEvidence, sameRootOwnerAndCore: true, originalPackageSha256: archiveSha256,
      profileSha256: first.result.profileSha256, identitySha256: first.result.sha256,
      payloadBuildId, nativeEpoch: host.receipt.epoch, custodyPlanSha256: component.custody.planSha256,
      sourcePlanSha256: plan.planSha256, nativeHostReceiptSha256: host.receipt.receiptSha256,
      recipeId: sourceFixture.recipeId, revision: sourceFixture.revision, executableDigest: sourceFixture.executableDigest,
      runId: sourceFixture.runId, deniedSourceNoAdmission: true, deniedStartNoRun: true, deniedGetNoSync: true,
      actualNativeSchedulerAndReceipts: true, terminalIdempotency: true, originalOracleParity: true,
      actualTypedRecipeSourceRevocation: true, independentSignedSessionPreserved: true,
      newlyUiApprovedGetterDeniedAfterSourceRevoke: true, originalSourceBytesUnchanged: true,
      nativeJournalSha256: hash(JSON.stringify(state.nativeJournal)), b1AndB0Qualified: false };
    state.evidence = evidence; state.phase = "verified";
    await writeFile(join(root, "native-recipe-passed.json"), JSON.stringify(evidence), { mode: 0o600, flag: "wx" });
    return evidence;
  } finally {
    if (state.phase !== "verified") state.phase = "failed";
    observerAbort.abort(); control.revoke(); await stopChild(ui);
  }
}

/** Parent must first close the component/editor, capture real B1, retire it, and restore B0 to a new root. */
export async function verifyInstalledNativeRecipeRestored(sourceFixture, { retirement, restored }) {
  const state = stateFor(sourceFixture);
  if (state.phase !== "verified" || !state.evidence || !state.nativeJournal)
    fail("INSTALLED_RECIPE_VERIFIED_EFFECTS_AND_PARENT_RECOVERY_REQUIRED");
  if (retirement?.kind !== "pkm.original-mcp-component-retirement/v1" || retirement.root !== sourceFixture.root
    || retirement.receiptPath !== join(state.componentFixture.directory, "retirement-complete.json")
    || restored?.root !== join(state.componentFixture.directory, "restored-b0")
    || restored.receiptPath !== join(state.componentFixture.directory, "b0-restored.json")
    || restored.originalRootOverwritten !== false || restored.newRootIdentity !== true)
    fail("INSTALLED_RECIPE_PARENT_RECOVERY_RECEIPTS_REQUIRED");
  const restoredRoot = restored.root, archive = retirement.archive;
  if (typeof archive !== "string" || !/^\.pkm-next-component-retired-[a-f0-9-]{36}$/.test(basename(archive))
    || relative(sourceFixture.root, archive) !== basename(archive)) fail("INSTALLED_RECIPE_DISJOINT_RESTORATION_REQUIRED");
  const retirementBytes = await readFile(retirement.receiptPath), restoredBytes = await readFile(restored.receiptPath);
  assert.equal(hash(retirementBytes), retirement.receiptSha256); assert.equal(hash(restoredBytes), restored.receiptSha256);
  const retiredReceipt = JSON.parse(retirementBytes), restoredReceipt = JSON.parse(restoredBytes);
  assert.equal(retiredReceipt.schema, "pkm.original-mcp-component-retirement/v1");
  assert.equal(retiredReceipt.root, sourceFixture.root); assert.equal(retiredReceipt.archive, archive);
  assert.equal(retiredReceipt.originalPathRetired, true); assert.equal(retiredReceipt.enginesStopped, true);
  assert.equal(retiredReceipt.b0Sha256, state.b0Sha256);
  assert.equal(restoredReceipt.schema, "pkm.original-mcp-component-b0-restored/v1");
  assert.equal(restoredReceipt.root, restoredRoot); assert.equal(restoredReceipt.originalRoot, sourceFixture.root);
  assert.equal(restoredReceipt.retirementSha256, retirement.receiptSha256);
  assert.equal(restoredReceipt.b0Sha256, state.b0Sha256); assert.equal(restoredReceipt.b1Sha256, retiredReceipt.b1Sha256);
  assert.equal(restoredReceipt.originalRootOverwritten, false);
  assert.equal(restoredReceipt.nativeIdentityOrProfileRestored, false);
  for (const path of [restoredRoot, archive]) {
    const stat = await lstat(path);
    if (!isAbsolute(path) || resolve(path) !== path || await realpath(path) !== path
      || !stat.isDirectory() || stat.isSymbolicLink()) fail("INSTALLED_RECIPE_CANONICAL_RECOVERY_ROOT_REQUIRED");
    await unchanged(state, path);
  }
  const { DatabaseSync } = await import("node:sqlite");
  const database = new DatabaseSync(join(archive, "core.sqlite"), { readOnly: true });
  try { assert.deepEqual(journal(database, sourceFixture.runId), state.nativeJournal); }
  finally { database.close(); }
  await absent(join(restoredRoot, "core.sqlite"), "INSTALLED_RECIPE_B0_MUST_NOT_INHERIT_NATIVE_STATE");
  await absent(join(restoredRoot, ".pkm-next-original-mcp.json"), "INSTALLED_RECIPE_B0_MUST_NOT_INHERIT_NATIVE_GRANTS");
  return { originalRecipeB0BytesRestored: true, originalRecipeB1BytesPreserved: true,
    nativeB1SchedulerSourceAndProtocolReceiptsPreserved: true, freshB0HasNoNativeStateOrGrant: true,
    fullNineQualified: false, fullCutoverQualified: false };
}
