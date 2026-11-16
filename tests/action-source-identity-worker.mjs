import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ACTION_SOURCE_IDENTITY } from "../dist/domain/action-source-identity.js";
import { originalDefinitionValue, originalDigest } from "../dist/domain/action-compiler-validation.js";
import { readActionCompiler } from "../dist/action-compiler.js";
import { ActionRuntime } from "../dist/action-runtime.js";
import { createTrustedActionHostOptions } from "../dist/trusted-action-host.js";
import { legacyActionRead, legacyActionWrite } from "../dist/legacy-action-mcp.js";
import { admitLegacyActionPackage, legacyActionCatalog, LEGACY_ACTION_RUNTIME_UNAVAILABLE } from "../dist/legacy-action-catalog.js";
import { Storage, initialize } from "../dist/storage.js";
import { createNativeRuntime } from "../dist/native-runtime.js";
import { portableActionArchive, portableActionManifest } from "./legacy-action-catalog-fixture.mjs";
import { originalActionCompilerFixtures as original } from "./action-compiler-original-fixtures.mjs";

const request = JSON.parse(readFileSync(0, "utf8"));
const root = resolve(import.meta.dirname, "..");
const actor = { id: "mcp:external", canWrite: true };
await mkdir(request.directory, { recursive: true });

if (request.mode === "parity") {
  assert.equal(ACTION_SOURCE_IDENTITY.identity, "frozen-original-v2");
  const data = await initialize(join(request.directory, "workspace"));
  const source = join(request.directory, "source"), oracleStore = join(request.directory, "original");
  await mkdir(source); await mkdir(oracleStore);
  const archive = join(source, "reviewed.zip"), bytes = portableActionArchive();
  await writeFile(archive, bytes);
  const expected = JSON.parse(execFileSync("python3", ["-c", `
import json,sys
sys.path.insert(0,sys.argv[1])
from action_runtime import ActionRuntime
runtime=ActionRuntime(sys.argv[2])
runtime.modules.proposal_mode=True
runtime.modules.configure_workspace(sys.argv[3])
runtime.modules.module_set_import(sys.argv[4])
runtime.modules.module_set_load(sys.argv[5],int(sys.argv[6]))
definition=runtime.modules.definition(sys.argv[7])
wrapper={**definition,"action_id":"example.versioned.wrapper"}
for key in ["knowledgeId","content_hash","implementation_hash","source_id"]: wrapper.pop(key,None)
wrapper["dependencies"]={definition["action_id"]:definition["content_hash"]}
runtime.enabled_platform_actions=lambda: []
runtime.modules.availability=lambda action_id: {"state":"blocked","reason":sys.argv[8]}
print(json.dumps({"definition":definition,"wrapper":wrapper,
 "check":runtime.modules.definition_check(wrapper),
 "retrieval":runtime.retrieve("bounded delay",3),"retrievalAll":runtime.retrieve("core",10),
 "proposal":runtime.modules.register(wrapper)}))
`, join(root, "legacy/resources"), oracleStore, source, archive, portableActionManifest.module_set_id,
    String(portableActionManifest.version), original.example.action_id, LEGACY_ACTION_RUNTIME_UNAVAILABLE], {
    encoding: "utf8", env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
  }));
  const storage = await Storage.open(data);
  try {
    const packageSha256 = createHash("sha256").update(bytes).digest("hex");
    const workspaceId = await storage.workspaceId();
    await admitLegacyActionPackage(storage, actor, {
      sourceRoot: source, sourcePath: archive, expectedPackageSha256: packageSha256, authorityId: "isolated-v2-fixture",
      authorize: binding => binding.actorId === actor.id && binding.workspaceId === workspaceId
        && binding.sourcePath === archive && binding.packageSha256 === packageSha256,
    });
    await legacyActionCatalog(storage, actor, { tool: "action_module_set_import", arguments: { local_path: archive } });
    await legacyActionCatalog(storage, actor, { tool: "action_module_set_load", arguments: {
      module_set_id: portableActionManifest.module_set_id, version: portableActionManifest.version,
    } });
    const get = await legacyActionRead(storage, actor, { tool: "action_get",
      arguments: { action_id: original.example.action_id } });
    const { availability, execution_contract, ...definition } = get;
    assert.deepEqual(definition, expected.definition);
    assert.equal(availability.state, "blocked");
    assert.equal(execution_contract.revision, definition.content_hash);
    assert.deepEqual(await legacyActionRead(storage, actor, { tool: "action_retrieve",
      arguments: { task: "bounded delay", limit: 3 } }), expected.retrieval);
    const all = await legacyActionRead(storage, actor, { tool: "action_retrieve", arguments: { task: "core", limit: 10 } });
    for (const [index, candidate] of all.candidates.entries())
      assert.deepEqual(candidate, expected.retrievalAll.candidates[index], candidate.action_id);
    assert.deepEqual(await legacyActionRead(storage, actor, { tool: "action_definition_check",
      arguments: { definition: expected.wrapper } }), expected.check);
    const stale = structuredClone(expected.wrapper);
    stale.dependencies[original.example.action_id] = request.historicalPackageHash;
    const rejected = await legacyActionRead(storage, actor, { tool: "action_definition_check",
      arguments: { definition: stale } });
    assert.equal(rejected.ok, false);
    assert.match(rejected.diagnostics[0].message, /not pinned/);
    const graph = { action_id: "example.versioned.graph", nodes: [{
      id: "packaged", action_id: definition.action_id, content_hash: definition.content_hash,
      parameters: { value: "static authoring only" },
    }] };
    const checkedGraph = await legacyActionRead(storage, actor, { tool: "action_graph_check", arguments: { graph } });
    assert.equal(checkedGraph.dependencies[definition.action_id], definition.content_hash);
    await assert.rejects(legacyActionRead(storage, actor, { tool: "action_graph_check",
      arguments: { graph: { ...graph, nodes: [{ ...graph.nodes[0], content_hash: request.historicalPackageHash }] } } }), /contract changed/);
    const proposed = await legacyActionWrite(storage, actor, { tool: "action_register",
      arguments: { definition: expected.wrapper } });
    assert.deepEqual({ ...proposed, proposal_id: "<generated>" }, { ...expected.proposal, proposal_id: "<generated>" });
    assert.equal(proposed.callable, false);
    await assert.rejects(createTrustedActionHostOptions(storage), /fixture agreement only/);
    const db = storage.connectNative();
    try {
      assert.equal(db.prepare("SELECT count(*) n FROM sqlite_master WHERE name='native_action_automatic_admissions'").get().n, 0);
    } finally { db.close(); }
    console.log(JSON.stringify({ data, proposal: proposed, definitionHash: definition.content_hash, implementationHash: definition.implementation_hash,
      identity: ACTION_SOURCE_IDENTITY.identity, capabilities: readActionCompiler({ operation: "action.compiler.capabilities", args: {} }) }));
  } finally { await storage.close(); }
} else if (request.mode === "reject-proposals") {
  const storage = await Storage.open(request.data);
  let native;
  try {
    await assert.rejects(legacyActionRead(storage, actor, { tool: "action_proposals", arguments: {} }), /proposal binding changed/);
    const workspaceId = await storage.workspaceId();
    native = await createNativeRuntime({ storage, hostServices: { action: {
      process: { commands: [], trustedPrograms: { approve: async () => false } },
      automaticTrusted: {
        current: () => ({ workspaceId, actorId: actor.id, trustedWorkspace: true, epoch: "isolated-stale-proposal-fixture" }),
        revoke() {},
      },
    } } });
    await assert.rejects(native.services.hostServices.admitActionProposal(actor,
      request.proposal.proposal_id, request.proposal.content_hash), /does not compile to its exact pinned revision/);
    const db = storage.connectNative();
    try { assert.equal(db.prepare("SELECT count(*) n FROM native_action_automatic_admissions").get().n, 0); }
    finally { db.close(); }
    console.log(JSON.stringify({ rejected: true }));
  } finally { await native?.close(); await storage.close(); }
} else if (request.mode === "package-hash") {
  const { loadModuleSet } = await import("../dist/domain/action-compiler-validation.js");
  const { decodeLegacyActionPackage } = await import("../dist/legacy-action-package.js");
  const definition = loadModuleSet(decodeLegacyActionPackage(portableActionArchive())).definitions.get(original.example.action_id);
  console.log(JSON.stringify({ contentHash: definition.content_hash }));
} else if (request.mode === "reject-regenerated-v1") {
  const source = { kind: "inline", definition: structuredClone(original.example) };
  const compiled = readActionCompiler({ operation: "action.definition.compile", args: { source } });
  assert.equal(compiled.status, "valid");
  assert.equal(compiled.definitionDigest, request.historicalDigest);
  let executions = 0;
  const path = join(request.directory, "runtime.sqlite");
  let database = new DatabaseSync(path);
  const options = { workspaceRoot: request.directory, adapters: {
    "program:python": {
      id: "historical-fixture", version: 1, outputContractDigest: originalDigest(original.example.output_schema),
      authorizationDigest: originalDigest("isolated-historical-fixture"),
      authorizeDefinition: binding => binding.executableDigest === request.historicalDigest,
      authorizeData: () => true,
      execute: async invocation => { executions++; return { value: invocation.inputs.value }; },
    },
  } };
  let runtime = new ActionRuntime(database, options);
  try {
    const args = { operationId: "01234567-89ab-4cde-8123-456789abcdef", runId: "regenerated-v1-run", source,
      expectedDefinitionDigest: request.regeneratedDigest, deadline: Date.now() + 60_000, inputs: { value: "fixture" } };
    assert.throws(() => runtime.create("fixture", args), /digest changed/);
    assert.equal(database.prepare("SELECT count(*) n FROM action_runtime_runs").get().n, 0);
    runtime.create("fixture", { ...args, expectedDefinitionDigest: request.historicalDigest });
    await runtime.close();
    // Model the identity-bearing fields of a run/receipt persisted by the regenerated
    // v1 generation, without executing or enabling that incompatible generation.
    const snapshot = JSON.parse(database.prepare("SELECT snapshot FROM action_runtime_runs").get().snapshot);
    snapshot.definitionDigest = request.regeneratedDigest;
    snapshot.definition.content_hash = request.regeneratedDigest;
    snapshot.definition.implementation_hash = request.regeneratedImplementationHash;
    database.prepare("UPDATE action_runtime_runs SET snapshot=?").run(JSON.stringify(snapshot));
    const receipt = database.prepare("SELECT result FROM action_runtime_receipts").get();
    const result = JSON.parse(receipt.result);
    result.definitionDigest = request.regeneratedDigest;
    database.prepare("UPDATE action_runtime_receipts SET fingerprint=?, result=?").run(
      createHash("sha256").update(JSON.stringify({ operation: "action.runtime.create", args })).digest("hex"),
      JSON.stringify(result),
    );
    database.close();
    database = new DatabaseSync(path);
    runtime = new ActionRuntime(database, options);
    const before = {
      runs: database.prepare("SELECT * FROM action_runtime_runs").all(),
      receipts: database.prepare("SELECT * FROM action_runtime_receipts").all(),
      events: database.prepare("SELECT * FROM action_runtime_events").all(),
    };
    assert.throws(() => runtime.create("fixture", args), /digest changed/);
    await assert.rejects(runtime.tick("fixture", args.runId), /different source identity/);
    assert.equal(runtime.get("fixture", args.runId).state, "ready");
    assert.equal(executions, 0);
    assert.deepEqual({
      runs: database.prepare("SELECT * FROM action_runtime_runs").all(),
      receipts: database.prepare("SELECT * FROM action_runtime_receipts").all(),
      events: database.prepare("SELECT * FROM action_runtime_events").all(),
    }, before);
    console.log(JSON.stringify({
      sourceIdentity: readActionCompiler({ operation: "action.compiler.capabilities", args: {} }).sourceIdentity,
      rejected: true, executions,
    }));
  } finally { await runtime.close(); database.close(); }
} else {
  const definition = structuredClone(original.example);
  definition.implementations[0].program = "fixture-versioned";
  const source = { kind: "inline", definition };
  const compiled = readActionCompiler({ operation: "action.definition.compile", args: { source } });
  assert.equal(compiled.status, "valid");
  let executions = 0;
  const database = new DatabaseSync(join(request.directory, "runtime.sqlite"));
  const runtime = new ActionRuntime(database, { workspaceRoot: request.directory, adapters: {
    "program:fixture-versioned": {
      id: "fixture-versioned", version: 1, outputContractDigest: originalDigest(definition.output_schema),
      authorizationDigest: originalDigest("isolated-fixture-authority"),
      authorizeDefinition: binding => binding.actorId === "fixture" && binding.executableDigest === compiled.definitionDigest,
      authorizeData: () => true,
      execute: async invocation => { executions++; return { value: invocation.inputs.value }; },
    },
  } });
  try {
    if (request.mode === "create") {
      const args = { operationId: "01234567-89ab-4cde-8123-456789abcdef", runId: "versioned-run", source,
        expectedDefinitionDigest: compiled.definitionDigest, deadline: Date.now() + 60_000, inputs: { value: "fixture" } };
      runtime.create("fixture", args);
      assert.deepEqual(runtime.create("fixture", args), runtime.get("fixture", args.runId));
      console.log(JSON.stringify({ args, implementationHash: originalDefinitionValue(definition).implementation_hash }));
    } else if (request.mode === "reject") {
      assert.throws(() => runtime.create("fixture", request.args), /digest changed/);
      await assert.rejects(runtime.tick("fixture", request.args.runId), /different source identity/);
      assert.equal(runtime.get("fixture", request.args.runId).state, "ready");
      assert.equal(executions, 0);
      assert.equal(database.prepare("SELECT count(*) n FROM action_runtime_receipts").get().n, 1);
      console.log(JSON.stringify({ rejected: true }));
    } else {
      const result = await runtime.tick("fixture", request.args.runId);
      assert.equal(result.state, "succeeded");
      assert.equal((await runtime.tick("fixture", request.args.runId)).state, "succeeded");
      assert.equal(executions, 1);
      console.log(JSON.stringify({ executions }));
    }
  } finally { await runtime.close(); database.close(); }
}
