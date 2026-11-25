import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { chmodSync, existsSync, linkSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import { recipeExecutionFixture } from "./fixtures/original-mcp-recipe-execution-fixture.mjs";
import { planOriginalMcpRecipeLibrary, admitOriginalMcpRecipeLibrary, activateOriginalMcpRecipeLibrary } from "../dist/original-mcp-recipe-library.js";
import { createNativePublicOwnerBackend } from "../dist/native-public-mcp-owner.js";
import { recipeNativeClientFixture } from "./fixtures/original-mcp-recipe-native-client.mjs";
import { pinRecipeEffectFile } from "../dist/original-mcp-recipe-effect-files.js";

const extension = process.env.PKM_TEST_LEGACY_RECIPE_EXTENSION;
const python = process.env.PKM_TEST_PYTHON ?? "python3";
test("public subflow failure uses the known pinned child result without granting an effect or replay", async t => {
  const f = await recipeExecutionFixture(t);
  const backend = createNativePublicOwnerBackend(f.opened.owner, {
    actor: { id: "mcp:external", canWrite: true }, originalMcpHost: f.host,
  });
  const call = async (tool, args) => (await backend.invoke("original_mcp_public",
    { tool, arguments: args })).structuredContent;
  try {
    const definition = { schema: "pkm.workflow.definition/v1", spec: {
      inputs: {}, outputs: {}, nodes: [{ nodeId: "child", kind: "pkm.subflow/v1", dependsOn: [],
        config: { recipeId: f.recipe.recipeId, revision: f.recipe.revision,
          executableDigest: f.recipe.executableDigest } }], completion: { requiredNodes: ["child"] },
    } };
    const start = await call("recipe_run_start_adhoc", { name: "Explicitly failing pinned child",
      command_id: "failed-subflow-start", definition_json: JSON.stringify(definition), inputs_json: "{}" });
    assert.equal(start.ok, true, JSON.stringify(start));
    const parent = await call("recipe_run_next", { run_id: start.run_id, command_id: "failed-subflow-parent", detail: "full" });
    assert.equal(parent.next_action.kind, "run_subrecipe", JSON.stringify(parent));
    const childId = parent.next_action.child_run_id;
    const child = await call("recipe_run_next", { run_id: childId, command_id: "failed-subflow-child", detail: "full" });
    const failed = await call("recipe_run_report", { run_id: childId, node_id: child.next_action.node_id,
      command_id: "failed-subflow-report", outcome: "failed", result_json: "{}", error: "Explicit fixture failure.", detail: "full" });
    assert.equal(failed.status, "failed", JSON.stringify(failed));
    const terminal = await call("recipe_run_get", { run_id: start.run_id, detail: "full" });
    assert.equal(terminal.status, "failed", JSON.stringify(terminal));
    assert.deepEqual(terminal.current_result.completed_nodes[0], {
      node_id: "child", outcome: "failed", result: { child_run_id: childId }, error: "Pinned sub-Recipe run failed.",
    });
    const next = await call("recipe_run_next", { run_id: start.run_id, command_id: "failed-subflow-no-replay", detail: "full" });
    assert.equal(next.status, "failed", JSON.stringify(next));
    assert.equal(f.frames.filter(frame => frame.method === "recipe.effect.approve").length, 0);
  } finally { await backend.close(); }
});
test("native Recipe executable role preserves exact owned installed-file pins without granting source-file write/link admission", t => {
  const root = resolve("tests", `.recipe-effect-file-${randomUUID()}`);
  mkdirSync(root, { mode: 0o700 }); t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, "source.py");
  writeFileSync(source, "print('owned')\n"); chmodSync(source, 0o775);
  assert.throws(() => pinRecipeEffectFile(source), /NATIVE_RECIPE_EFFECT_FILE_CHANGED/);
  const before = pinRecipeEffectFile(source, undefined, true);
  linkSync(source, join(root, "installed-alias"));
  assert.throws(() => pinRecipeEffectFile(source), /NATIVE_RECIPE_EFFECT_FILE_CHANGED/);
  const after = pinRecipeEffectFile(source, undefined, true);
  assert.equal(after.sha256, before.sha256); assert.notEqual(after.identity, before.identity);
  chmodSync(source, 0o777);
  assert.throws(() => pinRecipeEffectFile(source, undefined, true), /NATIVE_RECIPE_EFFECT_FILE_CHANGED/);
});
async function originalOracle(root, registry, args) {
  const output = await new Promise((resolve, reject) => {
    const child = execFile(python, ["-I", "-B", "-c", `
import importlib.util,json,sys,time
from pathlib import Path
resources=Path(sys.argv[1]);sys.path.insert(0,str(resources))
spec=importlib.util.spec_from_file_location('verified_original_effect_oracle',resources/'recipe_runtime.py')
runtime=importlib.util.module_from_spec(spec);spec.loader.exec_module(runtime)
class Registration:
 def __init__(self):self.tools={}
 def tool(self,**kwargs):
  def register(function):self.tools[function.__name__]=function;return function
  return register
registration=Registration()
runtime.register_recipe_tools(registration,Path(sys.argv[2]),environments_registry=Path(sys.argv[3]))
args=json.load(sys.stdin);start=registration.tools['recipe_run_start'](**args);current=start
deadline=time.monotonic()+15
while current.get('ok') and current.get('status')=='running' and time.monotonic()<deadline:
 time.sleep(.02);current=registration.tools['recipe_run_get'](run_id=start['run_id'])
assert current.get('status')=='completed',current
print(json.dumps({'start':start,'completed':current}))
`, join(extension, "resources"), root, registry], { encoding: "utf8", timeout: 30000, maxBuffer: 65536 },
      (error, stdout) => error ? reject(error) : resolve(stdout));
    child.stdin.end(JSON.stringify(args));
  });
  return JSON.parse(output);
}
test("actual authenticated original public command and Script autonomous starts execute exact owned argv after separate native effect consent", { timeout: 90000 }, async t => {
  assert(extension, "Requires the actual verified original 4.0.22.");
  const profile = resolve("tests", `.recipe-effect-profile-${randomUUID()}`);
  mkdirSync(profile, { mode: 0o700 });
  t.after(() => rmSync(profile, { recursive: true, force: true }));
  const prefix = execFileSync(python, ["-I", "-B", "-c", "import os,sys;print(os.path.realpath(sys.prefix))"], { encoding: "utf8" }).trim();
  const require = createRequire(join(extension, "package.json"));
  const oldRegistry = require("./dist/servers/pyenvs.js");
  oldRegistry.initPyenvs(profile);
  const registered = oldRegistry.pyenvAdd({ name: "autonomous-python", manager: "other", path: prefix, python: join(prefix, "bin/python") });
  chmodSync(join(profile, "registry.json"), 0o600);
  const literal = '$(touch NEVER-CREATED) ; " literal argv';
  for (const kind of ["command", "script"]) await t.test(kind, async t => {
    const config = kind === "command"
      ? { program: process.execPath, args: ["-e", "console.log(JSON.stringify(process.argv.slice(1)))", literal],
        timeoutSeconds: 5, maxOutputBytes: 4096 }
      : { runtime: "python", environmentId: registered.id, script: "import json,sys\nprint(json.dumps(sys.argv[1:]))",
        args: [literal], timeoutSeconds: 5, maxOutputBytes: 4096 };
    const definition = { schema: "pkm.workflow.definition/v1", spec: { inputs: {}, outputs: {},
      nodes: ["first", "second"].map((nodeId, index) => ({ nodeId, kind: `pkm.step.${kind}/v1`, config,
        dependsOn: index ? [{ from: "first", accept: ["succeeded"] }] : [] })),
      completion: { requiredNodes: ["second"] } } };
    let client, f;
    const native = async frame => {
      if (frame.method !== "recipe.source.approve" && frame.method !== "recipe.effect.approve") return { decision: "approve" };
      const current = f;
      client ??= recipeNativeClientFixture({ subscriptions: [], globalStorageUri: { fsPath: profile } }, frame.session, {
        signal: current.session.signal, assertCurrent() { current.session.assertCurrent(); current.opened.owner.assertWorkspaceLease(); },
        close: () => current.close(),
      });
      const producers = await client.ready;
      return (frame.method === "recipe.source.approve"
        ? producers.source.handle(frame.method, frame.payload, frame.requestId, new AbortController().signal)
        : producers.effect.handle(frame.payload, frame.requestId, new AbortController().signal));
    };
    f = await recipeExecutionFixture(t, { definition, nativeRequest: native, nativeSourceRequest: native });
    const args = { recipe_id: f.recipe.recipeId, command_id: "actual-public-" + kind, autonomous: true };
    const old = await originalOracle(resolve(f.root, "..", "oracle"), join(profile, "registry.json"), args);
    chmodSync(join(profile, "registry.json"), 0o600);
    assert.equal(old.completed.automation.startedNodes, 2);
    const source = await planOriginalMcpRecipeLibrary(f.opened.owner, f.host, f.selection);
    await admitOriginalMcpRecipeLibrary(f.opened.owner, f.host, source, f.producer.policy);
    const backend = createNativePublicOwnerBackend(f.opened.owner, {
      actor: { id: "mcp:external", canWrite: true }, originalMcpHost: f.host,
    });
    let parentBackend, phase = "autonomous-start";
    try {
      const started = (await backend.invoke("original_mcp_public", { tool: "recipe_run_start", arguments: args })).structuredContent;
      assert.equal(started.ok, true, JSON.stringify(started));
      let current = started;
      for (let i = 0; i < 500 && current.status === "running"; i++) {
        await new Promise(resolve => setTimeout(resolve, 10));
        current = (await backend.invoke("original_mcp_public", { tool: "recipe_run_get",
          arguments: { run_id: started.run_id } })).structuredContent;
        if (current.next_action?.state === "launch-outcome-unknown") break;
      }
      current = (await backend.invoke("original_mcp_public", { tool: "recipe_run_get",
        arguments: { run_id: started.run_id } })).structuredContent;
      assert.equal(current.status, "completed", JSON.stringify(current));
      assert.equal(current.automation.startedNodes, 2);
      for (const node of current.current_result.completed_nodes) {
        assert.deepEqual(JSON.parse(node.result.stdout), [literal]);
        assert.equal(node.result.ok, true);
      }
      assert.equal(client.ui.messages.filter(message => message.message === "Run this exact Recipe command/Script step?").length, 2);
      assert(f.frames.filter(frame => frame.method === "recipe.effect.approve").every(frame =>
        frame.payload.request.authority.shell === false && frame.payload.request.authority.automaticReplay === false));
      assert(!existsSync(join(f.root, "NEVER-CREATED")));
      phase = "autonomous-close";
      await backend.close(); await f.close(); client = undefined;
      phase = "parent-open";
      f = await recipeExecutionFixture(t, { definition, nativeRequest: native, nativeSourceRequest: native });
      parentBackend = createNativePublicOwnerBackend(f.opened.owner, {
        actor: { id: "mcp:external", canWrite: true }, originalMcpHost: f.host,
      });
      const parentCommand = "actual-pinned-parent-" + kind;
      const digest = value => createHash("sha256").update(value).digest("hex");
      const parentId = "recipe_run_" + digest(parentCommand).slice(0, 24);
      const childId = "recipe_run_" + digest(`${parentId}:sub:1`).slice(0, 24);
      const parent = { schema: "pkm.workflow.definition/v1", spec: { inputs: {}, outputs: {}, nodes: [{
        nodeId: "sub", kind: "pkm.subflow/v1", config: { recipeId: f.recipe.recipeId,
          revision: f.recipe.revision, executableDigest: f.recipe.executableDigest }, dependsOn: [],
      }], completion: { requiredNodes: ["sub"] } } };
      const invoke = async (tool, args) => (await parentBackend.invoke("original_mcp_public",
        { tool, arguments: args })).structuredContent;
      phase = "parent-start";
      const parentStart = await invoke("recipe_run_start_adhoc", { name: "Pinned parent " + kind,
        definition_json: JSON.stringify(parent), command_id: parentCommand, inputs_json: '{"token":"parent-global"}' });
      assert.equal(parentStart.ok, true, JSON.stringify(parentStart));
      const consentBefore = client.ui.messages.filter(message => message.message === "Run this exact Recipe command/Script step?").length;
      const parentClaim = await invoke("recipe_run_next", { run_id: parentId, command_id: parentCommand + "-claim" });
      phase = "parent-child";
      assert.equal(parentClaim.next_action?.kind, "run_subrecipe", JSON.stringify(parentClaim));
      assert.equal(parentClaim.next_action.child_run_id, childId);
      const childPending = await invoke("recipe_run_get", { run_id: childId });
      assert.equal(childPending.current_result.counts.running, 0);
      assert.equal(client.ui.messages.filter(message => message.message === "Run this exact Recipe command/Script step?").length, consentBefore);
      for (const [index, nodeId] of ["first", "second"].entries()) {
        let child = await invoke("recipe_run_next", { run_id: childId, command_id: `${parentCommand}-child-${index}`, detail: "full" });
        assert.equal(child.ok, true, JSON.stringify(child));
        for (let poll = 0; poll < 100 && !child.current_result.completed_nodes.some(node => node.node_id === nodeId); poll++) {
          await new Promise(resolve => setTimeout(resolve, 10));
          child = await invoke("recipe_run_get", { run_id: childId });
          if (child.next_action?.state === "launch-outcome-unknown") break;
        }
        const result = child.current_result.completed_nodes.find(node => node.node_id === nodeId);
        assert(result?.result.ok, JSON.stringify(child));
        assert.deepEqual(JSON.parse(result.result.stdout), [literal]);
      }
      const parentDone = await invoke("recipe_run_get", { run_id: parentId });
      phase = "parent-terminal";
      assert.equal(parentDone.status, "completed", JSON.stringify(parentDone));
      const childResult = parentDone.current_result.completed_nodes[0].result;
      assert.equal(childResult.child_run_id, childId);
      assert.equal(childResult.child_result.counts.succeeded, 2);
      assert.equal(client.ui.messages.filter(message => message.message === "Run this exact Recipe command/Script step?").length, consentBefore + 2);
    } catch (error) { t.diagnostic(`Native effect stage: ${phase}`); throw error; }
    finally { await parentBackend?.close(); await backend.close(); }
    assert(readFileSync(f.sourceFile).length > 0);
  });
});
test("actual native Recipe denial and restarted owned effect retain failed/UNKNOWN without another child", { timeout: 90000 }, async t => {
    for (const mode of ["deny", "restart"]) await t.test(mode, async t => {
      const definition = { schema: "pkm.workflow.definition/v1", spec: { inputs: {}, outputs: {},
        nodes: ["first", "second"].map((nodeId, index) => ({ nodeId, kind: "pkm.step.command/v1",
          config: { program: process.execPath, args: ["-e",
            "require('node:fs').appendFileSync(process.argv[1],'owned-start\\n');setTimeout(()=>process.exit(0),20000)",
            "${inputs.marker}"], timeoutSeconds: 30, maxOutputBytes: 4096 },
          dependsOn: index ? [{ from: "first", accept: ["succeeded"] }] : [] })),
        completion: { requiredNodes: ["second"] } } };
      let client, activation, f;
      const native = async frame => {
        if (frame.method !== "recipe.source.approve" && frame.method !== "recipe.effect.approve") return { decision: "approve" };
        if (!client || activation !== frame.session.activationId) {
          activation = frame.session.activationId;
          client = recipeNativeClientFixture({ subscriptions: [], globalStorageUri: { fsPath: resolve(f.root, "..") } }, frame.session, {
            signal: f.session.signal, assertCurrent() { f.session.assertCurrent(); f.opened.owner.assertWorkspaceLease(); },
            close: () => f.close(),
          });
          if (mode === "deny") client.ui.choice = (message, _options, choices) =>
            message === "Run this exact Recipe command/Script step?" ? "Deny" : choices[0];
        }
        const producers = await client.ready;
        return (frame.method === "recipe.source.approve"
          ? producers.source.handle(frame.method, frame.payload, frame.requestId, new AbortController().signal)
          : producers.effect.handle(frame.payload, frame.requestId, new AbortController().signal))
          .catch(error => { console.error("ACTUAL_RECIPE_NATIVE_HANDLER", error.stack); throw error; });
      };
      f = await recipeExecutionFixture(t, { definition, nativeRequest: native, nativeSourceRequest: native });
      const marker = resolve(f.root, "..", "owned-child-effects");
      async function authorize() {
        const source = await planOriginalMcpRecipeLibrary(f.opened.owner, f.host, f.selection);
        await admitOriginalMcpRecipeLibrary(f.opened.owner, f.host, source, f.producer.policy);
      }
      function backend() { return createNativePublicOwnerBackend(f.opened.owner,
        { actor: { id: "mcp:external", canWrite: true }, originalMcpHost: f.host }); }
      await authorize();
      let api = backend(); t.after(() => api.close());
      const invoke = async (tool, args) => (await api.invoke("original_mcp_public", { tool, arguments: args })).structuredContent;
      const args = { recipe_id: f.recipe.recipeId, command_id: "actual-native-" + mode,
        autonomous: true, inputs_json: JSON.stringify({ marker }) };
      const started = await invoke("recipe_run_start", args); assert.equal(started.ok, true, JSON.stringify(started));
      if (mode === "deny") {
        let current;
        for (let i = 0; i < 200; i++) {
          current = await invoke("recipe_run_get", { run_id: started.run_id });
          if (current.automation.status === "failed") break;
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        assert.equal(current.automation.status, "failed", JSON.stringify(current));
        assert.equal(current.automation.startedNodes, 1);
        assert.equal(current.current_result.completed_nodes[0].result.ok, false);
        assert(!existsSync(marker));
        assert.equal(client.ui.messages.filter(item => item.message === "Run this exact Recipe command/Script step?").length, 1);
      } else {
        for (let i = 0; i < 500 && !existsSync(marker); i++) await new Promise(resolve => setTimeout(resolve, 10));
        assert.equal(readFileSync(marker, "utf8"), "owned-start\n");
        await api.close(); await f.close(); await f.reopen(); client = undefined;
        await activateOriginalMcpRecipeLibrary(f.opened.owner, f.host, f.producer.policy); api = backend();
        const reactivated = await invoke("recipe_run_start", args);
        assert.equal(reactivated.ok, true, JSON.stringify(reactivated));
        assert.equal(reactivated.replayed, true);
        const recovered = await invoke("recipe_run_get", { run_id: started.run_id });
        assert.equal(recovered.next_action.state, "launch-outcome-unknown", JSON.stringify(recovered));
        assert.equal(recovered.next_action.replay_allowed, false);
        await invoke("recipe_run_next", { run_id: started.run_id, command_id: "no-replay-after-restart" });
        await new Promise(resolve => setTimeout(resolve, 100));
        assert.equal(readFileSync(marker, "utf8"), "owned-start\n");
        assert.equal(f.frames.filter(frame => frame.method === "recipe.effect.approve").length, 1);
      }
  });
});
