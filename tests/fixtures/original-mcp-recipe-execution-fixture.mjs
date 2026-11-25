import assert from "node:assert/strict";
import { createHash, createPublicKey, generateKeyPairSync, randomBytes, randomUUID, sign } from "node:crypto";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { startOriginalMcpNativeAttachmentServer } from "../../dist/original-mcp-native-attachment.js";
import { originalMcpNativeIdentity, originalMcpNativeAttestationMessage } from "../../dist/original-mcp-native-identity.js";
import { originalMcpNativeRequestMethods, originalMcpNativeRequestProtocol, originalMcpNativeRequestSession,
  originalMcpNativeResult, originalMcpNativeErrorResult, createOriginalMcpNativeRequestPolicy, waitForOriginalMcpNativeSupport } from "../../dist/original-mcp-native-request.js";
import { createOriginalMcpNativeHost, withOriginalMcpPublicRequest } from "../../dist/original-mcp-native-host.js";
import { captureOriginalMcpCustody, openOriginalMcpRoot } from "../../dist/original-mcp-root.js";
import { originalPublicMcpContracts } from "../../dist/native-public-original-mcp-contracts.js";
import { createOriginalMcpNativeRecipeSourcePolicy } from "../../dist/original-mcp-native-recipe-policy.js";
import { originalNativeRecipeDigest as digest } from "../../dist/original-mcp-native-recipe-contracts.js";
const require = createRequire(import.meta.url);
const { RecipeFilesystemStore } = require("../../legacy/dist/workflows/recipe-filesystem-store.js");
const { compileWorkflowDefinitionV1 } = require("../../legacy/dist/workflows/workflow-contracts.js");
const hash = value => createHash("sha256").update(value).digest("hex");
export async function recipeExecutionFixture(t, options = {}) {
  assert.equal(process.env.PKM_TEST_ISOLATED_NETWORK, "1", "Use the existing private Linux framework for actual cold original writers.");
  const base = resolve("tests", `.recipe-execution-${randomUUID()}`), root = join(base, "root"), oracleRoot = join(base, "oracle");
  const endpoint = join(homedir(), ".local/state/pkm-v5-recovery", `re-${randomBytes(4).toString("hex")}`);
  const callerInput = join(base, "caller-owned-input.txt");
  let opened, host, producer, server, socket, session, sourceFile, before;
  const close = async () => { producer?.dispose(); socket?.destroy(); await server?.close(); await host?.close(); await opened?.owner.close(); };
  t.after(async () => { await close(); if (sourceFile && before) assert.deepEqual(readFileSync(sourceFile), before);
    rmSync(base, { recursive: true, force: true }); rmSync(endpoint, { recursive: true, force: true }); });
  const definition = options.definition ?? { schema: "pkm.workflow.definition/v1", spec: { inputs: {}, outputs: {},
    nodes: [{ nodeId: "first", kind: "pkm.step.noop/v1", config: {}, dependsOn: [] },
      { nodeId: "second", kind: "pkm.step.noop/v1", config: {}, dependsOn: [{ from: "first", accept: ["succeeded"] }] }],
    completion: { requiredNodes: ["second"] } } };
  const compiled = compileWorkflowDefinitionV1(definition); assert.equal(compiled.ok, true);
  let recipe;
  for (const target of [root, oracleRoot]) {
    mkdirSync(join(target, ".pkm/state"), { recursive: true, mode: 0o700 });
    if (options.project) {
      const { ProjectStore } = require("../../legacy/dist/workflows/project-store.js");
      let creatingProject = false;
      const projectStore = new ProjectStore(join(target, ".pkm/state"), () => creatingProject ? options.project.projectId.replace(/^project_/, "") : randomUUID(),
        { autoMigrate: options.projectCanonical === true });
      const initial = projectStore.list();
      creatingProject = true;
      projectStore.createProject({
        commandId: "recipe-fixture-project", fingerprint: "recipe-fixture-project", expectedStoreVersion: initial.storeVersion,
      }, options.project.name);
    }
    if (!options.emptyLibrary) {
      const store = new RecipeFilesystemStore(join(target, ".pkm/state"));
      recipe = store.put({ recipeId: "recipe_original_external", name: "Original external workflow 工作", description: "External work, native receipts",
        scope: "global", category: "", revision: 3, definition: compiled.model, executableDigest: compiled.executableDigest,
        ...(options.nodeBindings ? { nodeBindings: options.nodeBindings } : {}) });
      const commandDefinition = { ...compiled.model, spec: { ...compiled.model.spec,
        nodes: [{ nodeId: "command", kind: "pkm.step.command/v1", config: { program: "/never-run-original-command", args: [] }, dependsOn: [] }],
        completion: { requiredNodes: ["command"] } } };
      const command = compileWorkflowDefinitionV1(commandDefinition);
      assert.equal(command.ok, true);
      store.put({ recipeId: "recipe_unadmitted_command", scope: "global", category: "", description: "Not approved",
        revision: 1, name: "Never authorize this command", definition: command.model, executableDigest: command.executableDigest });
    }
    for (const document of options.knowledge ?? []) {
      mkdirSync(join(target, document.area), { recursive: true, mode: 0o700 });
      writeFileSync(join(target, document.area, document.path), document.raw, { mode: 0o600 });
    }
    if (options.seedFromSkill) {
      const response = JSON.parse(execFileSync("python3", ["-I", "-B", "-c", `
import importlib.util,json,sys
from pathlib import Path
resources=Path(sys.argv[1]);sys.path.insert(0,str(resources))
spec=importlib.util.spec_from_file_location('original_recipe_seed',resources/'recipe_runtime.py')
runtime=importlib.util.module_from_spec(spec);spec.loader.exec_module(runtime)
class Registration:
 def __init__(self):self.tools={}
 def tool(self,**kwargs):
  def register(function):
   self.tools[function.__name__]=function
   return function
  return register
registration=Registration();runtime.register_recipe_tools(registration,Path(sys.argv[2]))
print(json.dumps(registration.tools['recipe_create_from_skill'](**json.load(sys.stdin))))
`, process.env.PKM_TEST_LEGACY_RECIPE_EXTENSION
        ? join(process.env.PKM_TEST_LEGACY_RECIPE_EXTENSION, "resources") : resolve("legacy/resources"), target],
      { input: JSON.stringify(options.seedFromSkill), encoding: "utf8", env: { ...process.env, PKM_NODE_EXECUTABLE: process.execPath } }));
      assert.equal(response.ok, true, JSON.stringify(response));
    }
  }
  mkdirSync(join(root, "notes"), { mode: 0o700 }); mkdirSync(endpoint, { mode: 0o700 });
  writeFileSync(callerInput, "Actual external caller-owned evidence. The native Recipe scheduler never executes or verifies this work.\n", { mode: 0o600 });
  writeFileSync(join(root, "notes/Entry.md"), "---\ntitle: Entry\n---\nActual original Library source.\n", { mode: 0o600 });
  writeFileSync(join(root, ".pkm/content-privacy.json"), '{"schema":1,"private":{}}', { mode: 0o600 });
  if (recipe) {
    sourceFile = join(root, "recipes/Uncategorized", require("../../legacy/dist/workflows/recipe-filesystem-store.js").safeRecipeFileName(recipe.name, recipe.recipeId));
    before = readFileSync(sourceFile);
  }
  const profileSha256 = digest("independent-original-recipe-library-profile");
  const plan = await captureOriginalMcpCustody({ root, backup: join(base, "custody"), operatorId: "recipe-execution-fixture",
    profileSha256, limits: { maxEntries: 1000, maxDepth: 16, maxBytes: 4_194_304, maxFileBytes: 2_097_152 } });
  const controls = { allow: true, pending: false, public: true }, frames = [];
  async function reopen() {
    opened = await openOriginalMcpRoot(plan);
    const keys = generateKeyPairSync("ed25519"), identity = originalMcpNativeIdentity(
      createPublicKey(keys.privateKey).export({ format: "der", type: "spki" }).toString("base64"), profileSha256);
    const binding = { root, workspaceId: opened.workspaceId, planSha256: plan.planSha256,
      catalogSha256: originalPublicMcpContracts().provenance.metadataSha256, profileSha256,
      payloadBuildId: digest("recipe-library-payload-fixture"), hostEntrySha256: digest("recipe-library-host-fixture") };
    server = await startOriginalMcpNativeAttachmentServer({ directory: endpoint, identity, identitySha256: identity.sha256,
      binding, maxPacketBytes: 65536, heartbeatIntervalMs: 100, heartbeatTimeoutMs: 1000 });
    socket = connect(join(endpoint, "n")); let buffer = "", attachedResolve;
    const attached = new Promise(resolve => { attachedResolve = resolve; }), send = value => socket.write(JSON.stringify(value) + "\n");
    socket.on("error", () => socket.destroy());
    socket.on("data", chunk => {
      buffer += chunk.toString("utf8"); let index;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const frame = JSON.parse(buffer.slice(0, index)); buffer = buffer.slice(index + 1);
        if (frame.type === "challenge") {
          const { body, message } = originalMcpNativeAttestationMessage(frame.challenge, identity.sha256, randomUUID());
          send({ type: "attestation", attestation: { ...body, signature: sign(null, message, keys.privateKey).toString("base64") } });
        } else if (frame.type === "attached") attachedResolve();
        else if (frame.type === "ping") send({ type: "pong", nonce: frame.nonce });
        else if (frame.type === "native-request") {
          frames.push(frame);
          if (frame.method === "recipe.source.approve") {
            if (options.nativeSourceRequest) {
              Promise.resolve().then(() => options.nativeSourceRequest(frame)).then(result => send(originalMcpNativeResult(frame, result)),
                () => send(originalMcpNativeErrorResult(frame, "NATIVE_HANDLER_FAILED")));
              continue;
            }
            if (!controls.pending) send(originalMcpNativeResult(frame, controls.allow ? { actorId: "mcp:external",
              decisionId: randomUUID(), expiresAtMs: Date.now() + 120000, requestSha256: digest(frame.payload.request) } : null));
          } else if (options.nativeRequest && frame.method !== "public.approve") {
            Promise.resolve().then(() => options.nativeRequest(frame)).then(result => send(originalMcpNativeResult(frame, result)),
              () => send(originalMcpNativeErrorResult(frame, "NATIVE_HANDLER_FAILED")));
          } else send(originalMcpNativeResult(frame, { decision: frame.method === "public.approve" && !controls.public ? "deny" : "approve" }));
        }
      }
    });
    await attached; session = await server.waitForSession({ timeoutMs: 1000 });
    send({ type: "native-supports", protocol: originalMcpNativeRequestProtocol, session: originalMcpNativeRequestSession(session),
      methods: [...originalMcpNativeRequestMethods], maxPacketBytes: 65536 });
    await waitForOriginalMcpNativeSupport(session, { timeoutMs: 1000 });
    host = await createOriginalMcpNativeHost(opened.storage, createOriginalMcpNativeRequestPolicy(session));
    producer = await createOriginalMcpNativeRecipeSourcePolicy(opened.owner, host, session);
  }
  await reopen();
  const dispatch = (execution, tool, args, actor = { id: "mcp:external", canWrite: true }, signal) =>
    withOriginalMcpPublicRequest(opened.storage, host, { operation: `mcp.tool.${tool}`, tool, version: 1,
      readOnly: tool === "recipe_run_get", arguments: args, argumentsDigest: digest(args) },
    () => execution.dispatch(tool, args, actor, signal), signal);
  const oracle = (calls) => JSON.parse(execFileSync("python3", ["-I", "-B", "-c", `
import importlib.util,json,sys
from pathlib import Path
resources=Path(sys.argv[1]);sys.path.insert(0,str(resources))
spec=importlib.util.spec_from_file_location('original_recipe_lifecycle_oracle',resources/'recipe_runtime.py')
runtime=importlib.util.module_from_spec(spec);spec.loader.exec_module(runtime)
class Registration:
 def __init__(self):self.tools={}
 def tool(self,**kwargs):
  def register(function):
   self.tools[function.__name__]=function
   return function
  return register
registration=Registration();runtime.register_recipe_tools(registration,Path(sys.argv[2]),
 environments_registry=Path(sys.argv[3]) if sys.argv[3] else None)
print(json.dumps([registration.tools[call['tool']](**call['args']) for call in json.load(sys.stdin)]))
`, process.env.PKM_TEST_LEGACY_RECIPE_EXTENSION
    ? join(process.env.PKM_TEST_LEGACY_RECIPE_EXTENSION, "resources") : resolve("legacy/resources"), oracleRoot,
    options.environmentsRegistryPath ?? ""], { input: JSON.stringify(calls), encoding: "utf8",
    env: { ...process.env, PKM_NODE_EXECUTABLE: process.execPath } }));
  return { root, recipe, sourceFile, callerInput, dispatch, oracle, frames, controls, close, reopen,
    selection: recipe ? { recipeId: recipe.recipeId, expectedRevision: recipe.revision, expectedExecutableDigest: recipe.executableDigest, maxFileBytes: 2_097_152 } : undefined,
    get opened() { return opened; }, get host() { return host; }, get producer() { return producer; }, get session() { return session; },
    hash };
}
export function originalRecipeTraceProjection(value) {
  const copy = structuredClone(value);
  const visit = item => { if (!item || typeof item !== "object") return;
    for (const key of Object.keys(item)) {
      if (["started_at", "last_heartbeat_at", "last_progress_at", "heartbeat_age_seconds", "progress_age_seconds"].includes(key)) delete item[key];
      else if (["startedAt", "completedAt", "lastHeartbeatAt", "lastProgressAt"].includes(key)
        && typeof item[key] === "string" && Number.isFinite(Date.parse(item[key]))) item[key] = "<timestamp>";
      else visit(item[key]);
    } };
  visit(copy); return copy;
}
