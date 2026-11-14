import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { AutomaticActionTrustAuthority } from "../legacy/src/runtime/action-trust-authority.ts";
import { createActionArtifactDestinationPicker, createActionArtifactPicker } from "../legacy/src/runtime/action-artifact-picker.ts";
import { nativeRestoreAuthority } from "./host-composition-legacy-batch16-restore-fixture.mjs";
import { until } from "./batch07-cli-fixtures.mjs";

const build = resolve(process.env.PKM_ACTION_BUILD ?? resolve(import.meta.dirname, "../dist"));
const { initialize, Storage } = await import(`${build}/storage.js`);
const { admitLegacyActionArtifactPath, legacyActionArtifact, inspectActionArtifact, verifyOwnedActionArtifact } = await import(`${build}/legacy-action-artifacts.js`);
const { builtinActionDefinitions } = await import(`${build}/domain/action-compiler-validation.js`);
const { createWorkspaceBackup, restoreWorkspaceBackup } = await import(`${build}/workspace-backup.js`);
const digest = value => createHash("sha256").update(value).digest("hex");
const actor = { id: "mcp:external", canWrite: true };

test("production program invokes the pinned original artifact-copy helper with two consents and a new owned output", { timeout: 90000 }, async t => {
  const parent = resolve(import.meta.dirname, `.trusted-program-artifact-${randomUUID()}`);
  const root = resolve(parent, "workspace"), selected = resolve(parent, "selected");
  const source = resolve(selected, "source.bin"), destination = resolve(selected, "program-output.bin");
  mkdirSync(selected, { recursive: true, mode: 0o700 });
  const bytes = Buffer.from([8, 0, 255, 17, 91]);
  writeFileSync(source, bytes);
  await initialize(root); chmodSync(root, 0o700);
  let client, sourceId, outputId, restoredAuthority, allowParent = true, allowChild = true, diagnostics = "";
  let pauseChild = false, waitingChild = false, releaseChild;
  const approvals = [];
  const picker = createActionArtifactPicker({ select: async () => source, confirm: async value =>
    value.path === source && value.expectedSha256 === digest(bytes) && value.size === bytes.length });
  const destinationPicker = createActionArtifactDestinationPicker({ select: async () => destination,
    confirm: async (_target, artifact) => artifact.artifactId === outputId && artifact.digest === digest(bytes) });
  const canonical = builtinActionDefinitions().get("core.artifact.copy");
  const definition = Object.fromEntries(Object.entries(canonical).filter(([key]) =>
    !["knowledgeId", "source_id", "implementation_hash", "content_hash"].includes(key)));
  const copyHash = canonical.content_hash;
  const authority = new AutomaticActionTrustAuthority({
    storePath: () => root, nativeEndpoint: true, isTrusted: () => true, enabled: () => true,
    prepare: async () => { throw new Error("Optional function check must not run"); },
    pickArtifact: picker, pickArtifactDestination: destinationPicker,
    authorizeEffects: async (id, _hash, context) => {
      approvals.push(id);
      assert.deepEqual(context.artifact, { artifactId: sourceId, digest: digest(bytes), size: bytes.length });
      if (id.startsWith("example.artifact.program")) {
        assert.deepEqual(context.childAction, { actionId: "core.artifact.copy", contentHash: copyHash });
        return allowParent;
      }
      assert.equal(id, "core.artifact.copy");
      if (pauseChild) {
        waitingChild = true;
        await new Promise(resolve => { releaseChild = resolve; });
      }
      return allowChild;
    },
  });
  t.after(async () => {
    releaseChild?.();
    try { await client?.close(); } finally {
      await authority.dispose(); await restoredAuthority?.dispose(); rmSync(parent, { recursive: true, force: true });
    }
  });
  await authority.start();
  const connect = async workspace => {
    const transport = new StdioClientTransport({ command: process.execPath,
      args: [resolve(build, "cli.js"), "mcp", "--data", workspace, "--experimental-legacy-mcp", "--experimental-trusted-actions"], stderr: "pipe" });
    transport.stderr?.on("data", chunk => { diagnostics += String(chunk); });
    try { await client.connect(transport); }
    catch (error) { throw new Error(`CLI startup failed for ${workspace}: ${diagnostics}`, { cause: error }); }
  };
  client = new Client({ name: "artifact-program-production", version: "1" });
  await connect(root);
  const tool = async (name, args) => {
    try { return await client.callTool({ name, arguments: args }); }
    catch (error) { throw new Error(`CLI ${name} failed: ${diagnostics}`, { cause: error }); }
  };
  const imported = await tool("action_artifact_pick_import", {});
  assert.notEqual(imported.isError, true, JSON.stringify(imported));
  sourceId = imported.structuredContent.value.artifact_id;
  const registeredCopy = await tool("legacy_action_write", { tool: "action_register", arguments: { definition } });
  assert.notEqual(registeredCopy.isError, true, JSON.stringify(registeredCopy));
  assert.equal(registeredCopy.structuredContent.value.content_hash, copyHash);
  const script = `import json,sys,time\nfrom action_modules import invoke_from_environment\nvalue=json.load(sys.stdin)\nresult=invoke_from_environment("core.artifact.copy",value,"program-copy")\ntime.sleep(2)\nprint(json.dumps(result))\n`;
  const program = {
    schema: "pkm.action.definition/v1", action_id: "example.artifact.program", version: 1,
    description: "Copy an artifact through the original nested invocation helper.",
    input_schema: definition.input_schema, output_schema: definition.output_schema,
    effects: ["local-read", "local-write"], dependencies: { "core.artifact.copy": copyHash },
    implementations: [{ kind: "program", program: "python3", args: ["-c", script], platforms: ["Linux"] }],
  };
  const registered = await tool("legacy_action_write", { tool: "action_register", arguments: { definition: program } });
  assert.notEqual(registered.isError, true, JSON.stringify(registered));
  assert.deepEqual(approvals, [], "Registration cannot run the program or request consent.");
  const wrongPin = structuredClone(program);
  wrongPin.action_id = "example.artifact.program-wrong-pin";
  wrongPin.dependencies["core.artifact.copy"] = "0".repeat(64);
  assert.equal((await tool("legacy_action_write", { tool: "action_register", arguments: { definition: wrongPin } })).isError, true);
  assert.equal((await tool("action_call", { action_id: program.action_id,
    content_hash: registered.structuredContent.value.content_hash, idempotency_key: "forged-input",
    inputs: { source: { artifact_id: `artifact_${"0".repeat(32)}` } } })).isError, true);
  assert.deepEqual(approvals, [], "Wrong revisions and forged inputs cannot request effect consent.");
  const invoke = key => tool("action_call", { action_id: program.action_id,
    content_hash: registered.structuredContent.value.content_hash, idempotency_key: key, inputs: { source: { artifact_id: sourceId } } });
  const read = async runId => (await tool("legacy_action_read",
    { tool: "action_run_get", arguments: { run_id: runId } })).structuredContent.value;
  const runs = actionId => {
    const db = new DatabaseSync(resolve(root, "core.sqlite"), { readOnly: true });
    try { return db.prepare("SELECT snapshot FROM action_runtime_runs WHERE json_extract(snapshot,'$.actionId')=?").all(actionId)
      .map(row => JSON.parse(row.snapshot)); }
    finally { db.close(); }
  };
  const beforeDenied = runs(program.action_id).length;
  allowParent = false;
  assert.equal((await invoke("parent-denied")).isError, true);
  assert.equal(runs(program.action_id).length, beforeDenied, "Parent denial creates no Action run.");
  assert.deepEqual(approvals, ["example.artifact.program"]);
  allowParent = true; allowChild = false;
  const denied = await invoke("child-denied");
  assert.notEqual(denied.isError, true, JSON.stringify(denied));
  const deniedRun = await until(() => read(denied.structuredContent.value.runId),
    value => ["succeeded", "failed", "unknown", "cancelled"].includes(value.state));
  assert.notEqual(deniedRun.state, "succeeded", JSON.stringify(deniedRun));
  assert.equal(Object.hasOwn(deniedRun, "output"), false);
  allowChild = true;
  const called = await invoke("program-copy");
  assert.notEqual(called.isError, true, JSON.stringify(called));
  const child = await until(() => runs("core.artifact.copy").find(item => item.state === "succeeded"),
    value => !!value);
  assert.equal((await read(called.structuredContent.value.runId)).state, "running");
  assert.deepEqual((await read(child.runId)).output_availability, { state: "blocked", reason: "ACCESS_DENIED" },
    "A nested artifact is private until its root Action succeeds.");
  assert.equal((await tool("action_artifact_pick_export", { artifact_id: child.nodes[0].outputs.artifact_id })).isError, true);
  const run = await until(() => read(called.structuredContent.value.runId),
    value => ["succeeded", "failed", "unknown", "cancelled"].includes(value.state));
  assert.equal(run.state, "succeeded", JSON.stringify(run));
  outputId = run.output.artifact_id;
  assert.match(outputId, /^artifact_[a-f0-9]{32}$/);
  assert.notEqual(outputId, sourceId);
  assert.equal(outputId, child.nodes[0].outputs.artifact_id);
  assert.deepEqual(approvals, ["example.artifact.program", "example.artifact.program", "core.artifact.copy",
    "example.artifact.program", "core.artifact.copy"]);
  const workspaceIdBeforeRestore = (await tool("action_trust_status", {})).structuredContent.value.workspaceId;
  const corruption = new DatabaseSync(resolve(root, "core.sqlite"));
  try {
    corruption.exec("BEGIN IMMEDIATE; DROP TRIGGER native_action_nested_plans_no_update");
    const stored = corruption.prepare("SELECT payload FROM native_action_nested_plans WHERE actor_id=? AND child_run_id=?")
      .get(actor.id, child.runId);
    const plan = JSON.parse(stored.payload);
    plan.parentRunId = "action_run_forged";
    const payload = JSON.stringify(plan);
    corruption.prepare("UPDATE native_action_nested_plans SET payload=?,payload_sha256=? WHERE actor_id=? AND child_run_id=?")
      .run(payload, digest(payload), actor.id, child.runId);
    assert.throws(() => verifyOwnedActionArtifact(corruption, workspaceIdBeforeRestore, actor, child.runId, outputId),
      error => error.code === "RECOVERY_CONFLICT");
  } finally { if (corruption.isTransaction) corruption.exec("ROLLBACK"); corruption.close(); }
  const exported = await tool("action_artifact_pick_export", { artifact_id: outputId });
  assert.notEqual(exported.isError, true, JSON.stringify(exported));
  assert.deepEqual(readFileSync(destination), bytes);
  const commandProgram = structuredClone(program);
  commandProgram.action_id = "example.artifact.program-cli";
  commandProgram.implementations[0].args[1] = `import json,subprocess,sys\nvalue=json.load(sys.stdin)\nchild=subprocess.run([sys.executable,"-m","action_modules","--invoke","core.artifact.copy","cli-copy"],input=json.dumps(value),text=True,capture_output=True,check=True)\nprint(child.stdout)\n`;
  const commandRegistration = await tool("legacy_action_write",
    { tool: "action_register", arguments: { definition: commandProgram } });
  assert.notEqual(commandRegistration.isError, true, JSON.stringify(commandRegistration));
  const commandCall = await tool("action_call", { action_id: commandProgram.action_id,
    content_hash: commandRegistration.structuredContent.value.content_hash, idempotency_key: "program-cli",
    inputs: { source: { artifact_id: sourceId } } });
  assert.notEqual(commandCall.isError, true, JSON.stringify(commandCall));
  const commandRun = await until(() => read(commandCall.structuredContent.value.runId),
    value => ["succeeded", "failed", "unknown", "cancelled"].includes(value.state));
  assert.equal(commandRun.state, "succeeded", JSON.stringify(commandRun));
  assert.match(commandRun.output.artifact_id, /^artifact_[a-f0-9]{32}$/);
  assert.notEqual(commandRun.output.artifact_id, outputId);
  const forged = structuredClone(program);
  forged.action_id = "example.artifact.program-forged";
  forged.implementations[0].args[1] = "import json,sys\nprint(json.dumps(json.load(sys.stdin)['source']))\n";
  const forgedRegistration = await tool("legacy_action_write", { tool: "action_register", arguments: { definition: forged } });
  assert.notEqual(forgedRegistration.isError, true, JSON.stringify(forgedRegistration));
  const forgedCall = await tool("action_call", { action_id: forged.action_id,
    content_hash: forgedRegistration.structuredContent.value.content_hash, idempotency_key: "forged-output",
    inputs: { source: { artifact_id: sourceId } } });
  assert.notEqual(forgedCall.isError, true, JSON.stringify(forgedCall));
  const forgedRun = await until(() => read(forgedCall.structuredContent.value.runId),
    value => ["succeeded", "failed", "unknown", "cancelled"].includes(value.state));
  assert.notEqual(forgedRun.state, "succeeded", "Returning an input reference cannot masquerade as a newly produced artifact.");
  assert.equal(Object.hasOwn(forgedRun, "output"), false);
  const malformed = structuredClone(program);
  malformed.action_id = "example.artifact.program-malformed";
  malformed.output_schema.additionalProperties = true;
  malformed.implementations[0].args[1] = "import json,sys\nprint(json.dumps({**json.load(sys.stdin)['source'],'extra':1}))\n";
  const malformedRegistration = await tool("legacy_action_write",
    { tool: "action_register", arguments: { definition: malformed } });
  assert.notEqual(malformedRegistration.isError, true, JSON.stringify(malformedRegistration));
  const malformedCall = await tool("action_call", { action_id: malformed.action_id,
    content_hash: malformedRegistration.structuredContent.value.content_hash, idempotency_key: "malformed-output",
    inputs: { source: { artifact_id: sourceId } } });
  assert.notEqual(malformedCall.isError, true, JSON.stringify(malformedCall));
  const malformedRun = await until(() => read(malformedCall.structuredContent.value.runId),
    value => ["succeeded", "failed", "unknown", "cancelled"].includes(value.state));
  assert.notEqual(malformedRun.state, "succeeded", "Malformed artifact-shaped outputs are not ordinary JSON success.");
  const failedAfterChild = structuredClone(program);
  failedAfterChild.action_id = "example.artifact.program-failed-after-child";
  failedAfterChild.implementations[0].args[1] = `import json,sys\nfrom action_modules import invoke_from_environment\nvalue=json.load(sys.stdin)\ninvoke_from_environment("core.artifact.copy",value,"failed-parent")\nsys.exit(1)\n`;
  const failedRegistration = await tool("legacy_action_write",
    { tool: "action_register", arguments: { definition: failedAfterChild } });
  assert.notEqual(failedRegistration.isError, true, JSON.stringify(failedRegistration));
  const previousChildren = new Set(runs("core.artifact.copy").map(value => value.runId));
  const failingCall = await tool("action_call", { action_id: failedAfterChild.action_id,
    content_hash: failedRegistration.structuredContent.value.content_hash, idempotency_key: "failed-after-child",
    inputs: { source: { artifact_id: sourceId } } });
  assert.notEqual(failingCall.isError, true, JSON.stringify(failingCall));
  const failedRun = await until(() => read(failingCall.structuredContent.value.runId),
    value => ["succeeded", "failed", "unknown", "cancelled"].includes(value.state));
  assert.notEqual(failedRun.state, "succeeded");
  assert.equal(Object.hasOwn(failedRun, "output"), false);
  const orphan = runs("core.artifact.copy").find(value => !previousChildren.has(value.runId));
  assert.equal(orphan?.state, "succeeded", "The separately approved child did run.");
  assert.deepEqual((await read(orphan.runId)).output_availability, { state: "blocked", reason: "ACCESS_DENIED" },
    "A successful child cannot publish through a failed root.");
  assert.equal((await tool("action_artifact_pick_export", { artifact_id: orphan.nodes[0].outputs.artifact_id })).isError, true);
  await client.close();
  client = new Client({ name: "artifact-program-restart", version: "1" });
  await connect(root);
  assert.deepEqual((await read(called.structuredContent.value.runId)).output, { artifact_id: outputId });
  const childCount = runs("core.artifact.copy").length;
  pauseChild = true;
  const pending = await invoke("revoked-child-consent");
  assert.notEqual(pending.isError, true, JSON.stringify(pending));
  await until(() => waitingChild, value => value === true);
  assert.notEqual((await tool("action_trust_revoke", {})).isError, true);
  releaseChild();
  const revokedRun = await until(() => read(pending.structuredContent.value.runId),
    value => ["succeeded", "failed", "unknown", "cancelled"].includes(value.state));
  assert.notEqual(revokedRun.state, "succeeded");
  assert.equal(runs("core.artifact.copy").length, childCount, "Revocation during child consent cannot create a child run.");
  assert.deepEqual((await read(called.structuredContent.value.runId)).output_availability,
    { state: "blocked", reason: "ACCESS_DENIED" });
  await client.close(); client = undefined; await authority.dispose();
  const backup = resolve(parent, "backup"), restored = resolve(parent, "restored");
  const storage = await Storage.open(root);
  try { await createWorkspaceBackup(storage, backup, { acquireQuiescence: async () => ({ assertHeld() {}, release() {} }) }); }
  finally { await storage.close(); }
  await restoreWorkspaceBackup(backup, restored, { nativeRestoreAuthority });
  restoredAuthority = new AutomaticActionTrustAuthority({
    storePath: () => restored, nativeEndpoint: true, isTrusted: () => true, enabled: () => true,
    prepare: async () => { throw new Error("Optional function check must not run"); },
  });
  await restoredAuthority.start();
  client = new Client({ name: "artifact-program-restored", version: "1" });
  await connect(restored);
  assert.deepEqual((await read(called.structuredContent.value.runId)).output, { artifact_id: outputId });
  const workspaceId = (await tool("action_trust_status", {})).structuredContent.value.workspaceId;
  const restoredDb = new DatabaseSync(resolve(restored, "core.sqlite"), { readOnly: true });
  try {
    assert.deepEqual(verifyOwnedActionArtifact(restoredDb, workspaceId, actor, child.runId, outputId),
      { artifactId: outputId, digest: digest(bytes), size: bytes.length });
    assert.throws(() => verifyOwnedActionArtifact(restoredDb, workspaceId, { id: "mcp:other", canWrite: true }, child.runId, outputId),
      error => error.code === "ACCESS_DENIED");
  } finally { restoredDb.close(); }
});

test("production picker, copy and pipeline forward owned bytes with epoch-fenced grants", { timeout: 90000 }, async t => {
  const parent = resolve(import.meta.dirname, `.trusted-picker-${randomUUID()}`);
  const root = resolve(parent, "workspace"), selected = resolve(parent, "selected");
  const source = resolve(selected, "source.bin"), link = resolve(selected, "link.bin");
  const destination = resolve(selected, "exported.bin");
  mkdirSync(selected, { recursive: true, mode: 0o700 });
  const bytes = Buffer.from([0, 3, 10, 255]);
  writeFileSync(source, bytes);
  symlinkSync(source, link);
  await initialize(root);
  chmodSync(root, 0o700);
  let choice, allow = false, change = false, changeAfterConfirmation = false, prompts = 0;
  let effectSource, client, renewedAuthority, restoredAuthority, allowPipeline = true;
  let pausePick = false, picking = false, releasePick;
  let destinationChoice, allowDestination = false, changeDestination = false, destinationPrompts = 0;
  let expectedDestination = destination, pauseDestination = false, waitingDestination = false, releaseDestination;
  const picker = createActionArtifactPicker({
    select: async () => choice,
    confirm: async item => {
      prompts++;
      assert.equal(item.path, source);
      assert.equal(item.selectedRoot, selected);
      assert.equal(item.expectedSha256, digest(bytes));
      assert.equal(item.size, bytes.length);
      if (change) writeFileSync(source, "changed");
      if (pausePick) {
        picking = true;
        await new Promise(resolve => { releasePick = resolve; });
      }
      return allow;
    },
  });
  const destinationPicker = createActionArtifactDestinationPicker({
    select: async () => destinationChoice,
    confirm: async (target, artifact) => {
      destinationPrompts++;
      assert.equal(target.path, expectedDestination);
      assert.equal(target.selectedRoot, selected);
      assert.deepEqual(artifact, { artifactId: effectSource, digest: digest(bytes), size: bytes.length });
      if (changeDestination) writeFileSync(destination, "other file");
      if (pauseDestination) {
        waitingDestination = true;
        await new Promise(resolve => { releaseDestination = resolve; });
      }
      return allowDestination;
    },
  });
  const authority = new AutomaticActionTrustAuthority({
    storePath: () => root, nativeEndpoint: true, isTrusted: () => true, enabled: () => true,
    prepare: async () => { throw new Error("Optional function check must not run"); },
    pickArtifact: async () => {
      const selectedArtifact = await picker();
      if (selectedArtifact && changeAfterConfirmation) writeFileSync(source, "changed-after-confirmation");
      return selectedArtifact;
    },
    pickArtifactDestination: destinationPicker,
    authorizeEffects: async (_id, _hash, context) => {
      assert.deepEqual(context.artifact, { artifactId: effectSource, digest: digest(bytes), size: bytes.length });
      return context.kind !== "pipeline" || allowPipeline;
    },
  });
  t.after(async () => {
    releasePick?.();
    releaseDestination?.();
    try { await client?.close(); } finally {
      await authority.dispose();
      await renewedAuthority?.dispose();
      await restoredAuthority?.dispose();
      rmSync(parent, { recursive: true, force: true });
    }
  });
  await authority.start();
  client = new Client({ name: "artifact-picker-production", version: "1" });
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [resolve(build, "cli.js"), "mcp", "--data", root, "--experimental-legacy-mcp", "--experimental-trusted-actions"],
    stderr: "pipe",
  }));
  const tool = (name, args) => client.callTool({ name, arguments: args });
  const counts = () => {
    const db = new DatabaseSync(resolve(root, "core.sqlite"), { readOnly: true });
    try { return ["legacy_action_artifact_grants", "legacy_action_artifacts", "legacy_action_artifact_receipts"].map(table =>
      db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)
        ? Number(db.prepare(`SELECT count(*) n FROM ${table}`).get().n) : 0); }
    finally { db.close(); }
  };
  const before = counts();
  assert.equal((await tool("action_artifact_pick_import", { path: source })).isError, true);
  assert.equal(prompts, 0);
  assert.equal((await tool("action_artifact_pick_import", {})).isError, true, "Cancelled picker cannot import.");
  choice = link;
  assert.equal((await tool("action_artifact_pick_import", {})).isError, true, "Symlink cannot be selected.");
  const oversized = resolve(selected, "oversized.bin");
  writeFileSync(oversized, ""); truncateSync(oversized, 32 * 1024 * 1024 + 1);
  choice = oversized;
  assert.equal((await tool("action_artifact_pick_import", {})).isError, true, "Oversized files cannot be selected.");
  choice = source;
  assert.equal((await tool("action_artifact_pick_import", {})).isError, true, "Denied confirmation cannot import.");
  allow = true; change = true;
  assert.equal((await tool("action_artifact_pick_import", {})).isError, true, "Changed bytes cannot be approved.");
  writeFileSync(source, bytes); change = false;
  changeAfterConfirmation = true;
  assert.equal((await tool("action_artifact_pick_import", {})).isError, true, "Admission rechecks the approved digest.");
  changeAfterConfirmation = false;
  assert.deepEqual(counts(), before, "Denied or changed selections create no grant or artifact.");
  writeFileSync(source, bytes);
  const imported = await tool("action_artifact_pick_import", {});
  assert.notEqual(imported.isError, true, JSON.stringify(imported));
  effectSource = imported.structuredContent.value.artifact_id;
  assert.match(effectSource, /^artifact_[a-f0-9]{32}$/);
  assert.notEqual((await tool("action_artifact_pick_import", {})).isError, true, "Repeated approval remains usable.");
  const canonical = builtinActionDefinitions().get("core.artifact.copy");
  const definition = Object.fromEntries(Object.entries(canonical).filter(([key]) =>
    !["knowledgeId", "source_id", "implementation_hash", "content_hash"].includes(key)));
  const registered = await tool("legacy_action_write", { tool: "action_register", arguments: { definition } });
  assert.notEqual(registered.isError, true, JSON.stringify(registered));
  const call = await tool("action_call", { action_id: "core.artifact.copy",
    content_hash: registered.structuredContent.value.content_hash, idempotency_key: "picked-copy",
    inputs: { source: { artifact_id: effectSource } } });
  assert.notEqual(call.isError, true, JSON.stringify(call));
  const run = await until(async () => (await tool("legacy_action_read",
    { tool: "action_run_get", arguments: { run_id: call.structuredContent.value.runId } })).structuredContent.value,
  value => ["succeeded", "failed", "unknown", "cancelled"].includes(value.state));
  assert.equal(run.state, "succeeded", JSON.stringify(run));
  assert.match(run.output.artifact_id, /^artifact_[a-f0-9]{32}$/);
  const ownedId = run.output.artifact_id;
  effectSource = ownedId;
  const exportTool = args => tool("action_artifact_pick_export", args);
  assert.equal((await exportTool({ artifact_id: ownedId, destination })).isError, true);
  assert.equal((await exportTool({ artifact_id: imported.structuredContent.value.artifact_id })).isError, true,
    "Borrowed inputs cannot be exported through the managed picker.");
  assert.equal((await exportTool({ artifact_id: ownedId })).isError, true, "Cancelled destination picker cannot export.");
  destinationChoice = source;
  assert.equal((await exportTool({ artifact_id: ownedId })).isError, true, "An existing destination cannot be overwritten.");
  destinationChoice = destination;
  const beforeDeniedExport = counts();
  assert.equal((await exportTool({ artifact_id: ownedId })).isError, true, "Denied confirmation cannot export.");
  allowDestination = true; changeDestination = true;
  assert.equal((await exportTool({ artifact_id: ownedId })).isError, true, "A destination created during confirmation cannot be overwritten.");
  assert.equal(readFileSync(destination, "utf8"), "other file");
  rmSync(destination);
  assert.deepEqual(counts(), beforeDeniedExport, "Cancelled and denied destinations create no grant or receipt.");
  changeDestination = false;
  const exported = await exportTool({ artifact_id: ownedId });
  assert.notEqual(exported.isError, true, JSON.stringify(exported));
  assert.equal(exported.structuredContent.value.path, destination);
  assert.equal(exported.structuredContent.value.digest, digest(bytes));
  assert.deepEqual(readFileSync(destination), bytes);
  assert.equal(destinationPrompts, 3);
  const artifact = { type: "object", properties: { artifact_id: { type: "string", pattern: "^artifact_[0-9a-f]{32}$" } },
    required: ["artifact_id"], additionalProperties: false };
  const pipeline = {
    schema: "pkm.action.definition/v1", action_id: "example.artifact.forward", version: 1,
    description: "Forward an owned artifact reference through a pure component.",
    input_schema: { type: "object", properties: { source: artifact }, required: ["source"], additionalProperties: false },
    output_schema: artifact, effects: ["pure"],
    implementations: [{ kind: "pipeline", platforms: ["Linux", "Windows", "Darwin"],
      steps: [{ id: "hold", component: "core.constant", implementation: "javascript",
        inputs: { value: { $input: "source" } },
        output_schema: { type: "object", properties: { value: artifact }, required: ["value"], additionalProperties: false } }],
      output: { $step: "hold.value" } }],
  };
  const registeredPipeline = await tool("legacy_action_write", { tool: "action_register", arguments: { definition: pipeline } });
  assert.notEqual(registeredPipeline.isError, true, JSON.stringify(registeredPipeline));
  const invokePipeline = (key, sourceId) => tool("action_call", {
    action_id: pipeline.action_id, content_hash: registeredPipeline.structuredContent.value.content_hash,
    idempotency_key: key, inputs: { source: { artifact_id: sourceId } },
  });
  assert.equal((await invokePipeline("forged", `artifact_${"0".repeat(32)}`)).isError, true);
  assert.equal((await invokePipeline("borrowed", imported.structuredContent.value.artifact_id)).isError, true,
    "Borrowed inputs cannot masquerade as managed output.");
  effectSource = ownedId;
  allowPipeline = false;
  assert.equal((await invokePipeline("denied", ownedId)).isError, true);
  allowPipeline = true;
  const forwarded = await invokePipeline("forwarded", ownedId);
  assert.notEqual(forwarded.isError, true, JSON.stringify(forwarded));
  const read = async runId => (await tool("legacy_action_read",
    { tool: "action_run_get", arguments: { run_id: runId } })).structuredContent.value;
  const forwardRun = await until(() => read(forwarded.structuredContent.value.runId),
    value => ["succeeded", "failed", "unknown", "cancelled"].includes(value.state));
  assert.equal(forwardRun.state, "succeeded", JSON.stringify(forwardRun));
  assert.deepEqual(forwardRun.output, { artifact_id: ownedId });
  await client.close();
  client = new Client({ name: "artifact-picker-production-restart", version: "1" });
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [resolve(build, "cli.js"), "mcp", "--data", root, "--experimental-legacy-mcp", "--experimental-trusted-actions"],
    stderr: "pipe",
  }));
  assert.deepEqual((await read(forwarded.structuredContent.value.runId)).output, { artifact_id: ownedId });
  pausePick = true;
  pauseDestination = true;
  expectedDestination = destinationChoice = resolve(selected, "revoked-export.bin");
  const beforeRevoke = counts();
  const pendingPick = tool("action_artifact_pick_import", {});
  const pendingExport = exportTool({ artifact_id: ownedId });
  await until(() => picking, value => value === true);
  await until(() => waitingDestination, value => value === true);
  assert.notEqual((await tool("action_trust_revoke", {})).isError, true);
  releasePick();
  releaseDestination();
  assert.equal((await pendingPick).isError, true, "Revocation during picker confirmation cannot create a grant.");
  assert.equal((await pendingExport).isError, true, "Revocation during destination confirmation cannot export.");
  assert.equal(existsSync(expectedDestination), false);
  assert.deepEqual(counts(), beforeRevoke);
  pausePick = false;
  assert.equal((await tool("legacy_action_artifact_write",
    { tool: "action_artifact_import", arguments: { local_path: source } })).isError, true);
  assert.equal((await tool("legacy_action_artifact_write",
    { tool: "action_artifact_export", arguments: { artifact_id: effectSource, destination: resolve(selected, "unapproved") } })).isError, true);
  assert.equal((await tool("action_artifact_pick_import", {})).isError, true);
  assert.deepEqual((await read(forwarded.structuredContent.value.runId)).output_availability,
    { state: "blocked", reason: "ACCESS_DENIED" });
  await client.close(); client = undefined;
  await authority.dispose();
  renewedAuthority = new AutomaticActionTrustAuthority({
    storePath: () => root, nativeEndpoint: true, isTrusted: () => true, enabled: () => true,
    prepare: async () => { throw new Error("Optional function check must not run"); },
    pickArtifact: picker,
  });
  await renewedAuthority.start();
  client = new Client({ name: "artifact-picker-renewed", version: "1" });
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [resolve(build, "cli.js"), "mcp", "--data", root, "--experimental-legacy-mcp", "--experimental-trusted-actions"],
    stderr: "pipe",
  }));
  assert.equal((await tool("legacy_action_artifact_write",
    { tool: "action_artifact_import", arguments: { local_path: source } })).isError, true,
  "A new trust epoch cannot revive the old picker grant.");
  assert.notEqual((await tool("legacy_action_write", { tool: "action_register", arguments: { definition } })).isError, true);
  assert.equal((await tool("action_call", { action_id: "core.artifact.copy",
    content_hash: registered.structuredContent.value.content_hash, idempotency_key: "old-picked-source",
    inputs: { source: { artifact_id: imported.structuredContent.value.artifact_id } } })).isError, true,
  "A previously imported borrowed reference cannot revive an old picker grant.");
  assert.notEqual((await tool("action_artifact_pick_import", {})).isError, true,
    "A new explicit selection can approve the same path under the new epoch.");
  await client.close(); client = undefined;
  await renewedAuthority.dispose(); renewedAuthority = undefined;
  const backup = resolve(parent, "backup"), restored = resolve(parent, "restored");
  let storage = await Storage.open(root);
  try { await createWorkspaceBackup(storage, backup, { acquireQuiescence: async () => ({ assertHeld() {}, release() {} }) }); }
  finally { await storage.close(); }
  await restoreWorkspaceBackup(backup, restored, { nativeRestoreAuthority });
  restoredAuthority = new AutomaticActionTrustAuthority({
    storePath: () => restored, nativeEndpoint: true, isTrusted: () => true, enabled: () => true,
    prepare: async () => { throw new Error("Optional function check must not run"); },
  });
  await restoredAuthority.start();
  client = new Client({ name: "artifact-picker-restored", version: "1" });
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [resolve(build, "cli.js"), "mcp", "--data", restored, "--experimental-legacy-mcp", "--experimental-trusted-actions"],
    stderr: "pipe",
  }));
  assert.deepEqual((await read(forwarded.structuredContent.value.runId)).output, { artifact_id: ownedId });
  const workspaceId = (await tool("action_trust_status", {})).structuredContent.value.workspaceId;
  const restoredDb = new DatabaseSync(resolve(restored, "core.sqlite"), { readOnly: true });
  try {
    assert.deepEqual(verifyOwnedActionArtifact(restoredDb, workspaceId, actor, run.run_id ?? call.structuredContent.value.runId, ownedId),
      { artifactId: ownedId, digest: digest(bytes), size: bytes.length });
    assert.throws(() => verifyOwnedActionArtifact(restoredDb, workspaceId, { id: "mcp:other", canWrite: true },
      call.structuredContent.value.runId, ownedId), error => error.code === "ACCESS_DENIED");
  } finally { restoredDb.close(); }
});

test("production CLI copies exact owned artifacts with consent, restart and backup restore", { timeout: 90000 }, async t => {
  const parent = resolve(import.meta.dirname, `.trusted-artifact-${randomUUID()}`);
  const root = resolve(parent, "workspace"), selected = resolve(parent, "selected");
  const source = resolve(selected, "source.bin"), destination = resolve(selected, "destination.bin");
  const revokedDestination = resolve(selected, "revoked.bin");
  const backup = resolve(parent, "backup"), restored = resolve(parent, "restored");
  mkdirSync(selected, { recursive: true, mode: 0o700 });
  const bytes = Buffer.from([0, 1, 255, 13, 10, 7, 42]);
  writeFileSync(source, bytes);
  await initialize(root);
  chmodSync(root, 0o700);
  let storage = await Storage.open(root), authority, client;
  t.after(async () => {
    try { await client?.close(); } finally {
      try { await authority?.dispose(); } finally {
        await storage?.close();
        rmSync(parent, { recursive: true, force: true });
      }
    }
  });
  for (const [kind, path, expectedSha256] of [
    ["source", source, digest(bytes)], ["destination", destination, undefined], ["destination", revokedDestination, undefined],
  ]) {
    await admitLegacyActionArtifactPath(storage, actor, {
      kind, path, selectedRoot: selected, expectedSha256, authorityId: "isolated-test-owner",
      authorize: binding => binding.actorId === actor.id && binding.kind === kind && binding.path === path
        && binding.selectedRoot === selected && binding.expectedSha256 === (expectedSha256 ?? null),
    });
  }
  const oversized = resolve(selected, "oversized.bin"), linked = resolve(selected, "linked.bin");
  writeFileSync(oversized, "");
  truncateSync(oversized, 32 * 1024 * 1024 + 1);
  symlinkSync(source, linked);
  for (const path of [oversized, linked]) {
    await assert.rejects(admitLegacyActionArtifactPath(storage, actor, {
      kind: "source", path, selectedRoot: selected, expectedSha256: digest(bytes), authorityId: "isolated-test-owner",
      authorize: () => true,
    }));
  }
  await storage.close(); storage = undefined;
  let allowed = false, prompts = 0, expectedSource, expectedDigest = digest(bytes), expectedSize = bytes.length;
  let changeOnConsent = false, waitForConsent = false;
  let waiting = false, releaseConsent;
  t.after(() => releaseConsent?.());
  const startAuthority = async workspace => {
    authority = new AutomaticActionTrustAuthority({
      storePath: () => workspace, nativeEndpoint: true, isTrusted: () => true, enabled: () => true,
      prepare: async () => { throw new Error("Optional function check must not run"); },
      authorizeEffects: async (id, _hash, context) => {
        prompts++;
        assert.equal(id, "core.artifact.copy");
        assert.equal(context.kind, "artifact-copy");
        assert.deepEqual(context.artifact, { artifactId: expectedSource, digest: expectedDigest, size: expectedSize });
        assert.deepEqual(context.effects, ["local-read", "local-write"]);
        if (changeOnConsent) writeFileSync(source, "changed-after-consent");
        if (waitForConsent) {
          waiting = true;
          await new Promise(resolve => { releaseConsent = resolve; });
        }
        return allowed;
      },
    });
    await authority.start();
  };
  const connect = async workspace => {
    client = new Client({ name: "artifact-action-production", version: "1" });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [resolve(build, "cli.js"), "mcp", "--data", workspace, "--experimental-legacy-mcp", "--experimental-trusted-actions"],
      stderr: "pipe",
    });
    let stderr = "";
    transport.stderr?.on("data", chunk => { stderr += String(chunk); });
    try { await client.connect(transport); } catch (error) { throw new Error(stderr, { cause: error }); }
  };
  await startAuthority(root); await connect(root);
  const tool = (name, args) => client.callTool({ name, arguments: args });
  const imported = await tool("legacy_action_artifact_write", { tool: "action_artifact_import", arguments: { local_path: source } });
  assert.notEqual(imported.isError, true, JSON.stringify(imported));
  const sourceId = imported.structuredContent.value.artifact_id;
  expectedSource = sourceId;
  const canonical = builtinActionDefinitions().get("core.artifact.copy");
  const definition = Object.fromEntries(Object.entries(canonical).filter(([key]) =>
    !["knowledgeId", "source_id", "implementation_hash", "content_hash"].includes(key)));
  const register = definition => tool("legacy_action_write", { tool: "action_register", arguments: { definition } });
  assert.equal((await register({ ...definition, effects: ["pure"] })).isError, true);
  const registered = await register(definition);
  assert.notEqual(registered.isError, true, JSON.stringify(registered));
  assert.equal(registered.structuredContent.value.callable, true);
  assert.equal(prompts, 0, "Registration must not execute or ask for effect consent.");
  const counts = () => {
    const db = new DatabaseSync(resolve(root, "core.sqlite"), { readOnly: true });
    try { return ["native_action_automatic_calls", "action_runtime_runs", "legacy_action_artifacts"]
      .map(table => Number(db.prepare(`SELECT count(*) n FROM ${table}`).get().n)); }
    finally { db.close(); }
  };
  const before = counts();
  const call = (id, artifactId, hash = registered.structuredContent.value.content_hash) => tool("action_call", {
    action_id: "core.artifact.copy", content_hash: hash, idempotency_key: id, inputs: { source: { artifact_id: artifactId } },
  });
  assert.equal((await call("wrong-hash", sourceId, "0".repeat(64))).isError, true);
  assert.equal((await call("forged", `artifact_${"0".repeat(32)}`)).isError, true);
  assert.equal((await tool("action_call", { action_id: "core.artifact.copy",
    content_hash: registered.structuredContent.value.content_hash, idempotency_key: "extra-field",
    inputs: { source: { artifact_id: sourceId, path: source } } })).isError, true);
  assert.equal(prompts, 0);
  assert.equal((await call("denied", sourceId)).isError, true);
  assert.equal(prompts, 1);
  assert.deepEqual(counts(), before, "Denied consent publishes no run, receipt or artifact.");
  allowed = true;
  const accepted = await call("copy", sourceId);
  assert.notEqual(accepted.isError, true, JSON.stringify(accepted));
  const runId = accepted.structuredContent.value.runId;
  const readRun = async id => {
    const result = await tool("legacy_action_read", { tool: "action_run_get", arguments: { run_id: id } });
    assert.notEqual(result.isError, true, JSON.stringify(result));
    return result.structuredContent.value;
  };
  const run = await until(() => readRun(runId), value => ["succeeded", "failed", "unknown", "cancelled"].includes(value.state));
  assert.equal(run.state, "succeeded", JSON.stringify(run));
  const outputId = run.output.artifact_id;
  assert.match(outputId, /^artifact_[a-f0-9]{32}$/);
  assert.notEqual(outputId, sourceId);
  const exported = await tool("legacy_action_artifact_write", {
    tool: "action_artifact_export", arguments: { artifact_id: outputId, destination },
  });
  assert.notEqual(exported.isError, true, JSON.stringify(exported));
  assert.deepEqual(readFileSync(destination), bytes);
  const db = new DatabaseSync(resolve(root, "core.sqlite"), { readOnly: true });
  try { assert.throws(() => inspectActionArtifact(db, root, run.workspaceId ?? "", { id: "mcp:other", canWrite: true }, outputId),
    error => error.code === "ACCESS_DENIED"); }
  finally { db.close(); }
  const workspaceId = (await tool("action_trust_status", {})).structuredContent.value.workspaceId;
  const corrupt = new DatabaseSync(resolve(root, "core.sqlite"));
  try {
    assert.throws(() => verifyOwnedActionArtifact(corrupt, workspaceId, actor, "action_run_other", outputId),
      error => error.code === "ACCESS_DENIED");
    corrupt.exec("BEGIN IMMEDIATE; DROP TRIGGER legacy_action_artifacts_no_update");
    const row = corrupt.prepare("SELECT payload FROM legacy_action_artifacts WHERE id=?").get(outputId);
    const payload = JSON.parse(row.payload);
    payload.bytes = Buffer.alloc(bytes.length, 9).toString("base64");
    const text = JSON.stringify(payload);
    corrupt.prepare("UPDATE legacy_action_artifacts SET payload=?,payload_sha256=? WHERE id=?").run(text, digest(text), outputId);
    assert.throws(() => verifyOwnedActionArtifact(corrupt, workspaceId, actor, runId, outputId),
      error => error.code === "RECOVERY_CONFLICT");
  } finally { if (corrupt.isTransaction) corrupt.exec("ROLLBACK"); corrupt.close(); }
  await client.close(); client = undefined;
  await connect(root);
  assert.deepEqual((await readRun(runId)).output, { artifact_id: outputId });
  expectedSource = outputId;
  const copiedAgain = await call("copy-managed", outputId);
  assert.notEqual(copiedAgain.isError, true, JSON.stringify(copiedAgain));
  const again = await until(() => readRun(copiedAgain.structuredContent.value.runId),
    value => ["succeeded", "failed", "unknown", "cancelled"].includes(value.state));
  assert.equal(again.state, "succeeded", JSON.stringify(again));
  expectedSource = sourceId;
  changeOnConsent = true;
  const beforeChanged = counts();
  const changedCall = await call("changed-after-consent", sourceId);
  assert.notEqual(changedCall.isError, true, JSON.stringify(changedCall));
  const changed = await until(() => readRun(changedCall.structuredContent.value.runId),
    value => ["succeeded", "failed", "unknown", "cancelled"].includes(value.state));
  assert.equal(changed.state, "failed", JSON.stringify(changed));
  assert.equal(changed.nodes[0].reason, "ACTION_ARTIFACT_INPUT_UNAVAILABLE");
  assert.equal(Object.hasOwn(changed, "output"), false);
  assert.equal(counts()[2], beforeChanged[2], "A changed source produces no artifact.");
  changeOnConsent = false;
  expectedSource = outputId;
  waitForConsent = true;
  const beforeRevocation = counts();
  const pending = call("revoked-during-consent", outputId);
  await until(() => waiting, value => value === true);
  const revoked = await tool("action_trust_revoke", {});
  assert.notEqual(revoked.isError, true);
  releaseConsent();
  assert.equal((await pending).isError, true);
  waitForConsent = false;
  assert.deepEqual(counts(), beforeRevocation, "Revocation during consent publishes no run, receipt or artifact.");
  assert.equal((await call("revoked", outputId)).isError, true);
  assert.deepEqual((await readRun(runId)).output_availability, { state: "blocked", reason: "ACCESS_DENIED" });
  assert.equal((await tool("legacy_action_artifact_write", {
    tool: "action_artifact_export", arguments: { artifact_id: outputId, destination: revokedDestination },
  })).isError, true);
  assert.equal(existsSync(revokedDestination), false, "Revoked trust cannot export managed bytes through the legacy endpoint.");
  await client.close(); client = undefined;
  await authority.dispose(); authority = undefined;
  storage = await Storage.open(root);
  await createWorkspaceBackup(storage, backup, { acquireQuiescence: async () => ({ assertHeld() {}, release() {} }) });
  await storage.close(); storage = undefined;
  await restoreWorkspaceBackup(backup, restored, { nativeRestoreAuthority });
  storage = await Storage.open(restored);
  const restoreDestination = resolve(selected, "restored.bin");
  const largeSource = resolve(selected, "large.bin"), largeBytes = Buffer.alloc(25 * 1024 * 1024, 65);
  writeFileSync(largeSource, largeBytes);
  const largeDigest = digest(largeBytes);
  await admitLegacyActionArtifactPath(storage, actor, {
    kind: "source", path: largeSource, selectedRoot: selected, expectedSha256: largeDigest,
    authorityId: "isolated-restored-owner",
    authorize: binding => binding.actorId === actor.id && binding.kind === "source"
      && binding.path === largeSource && binding.expectedSha256 === largeDigest,
  });
  await admitLegacyActionArtifactPath(storage, actor, {
    kind: "destination", path: restoreDestination, selectedRoot: selected, authorityId: "isolated-restored-owner",
    authorize: binding => binding.actorId === actor.id && binding.kind === "destination"
      && binding.path === restoreDestination && binding.selectedRoot === selected,
  });
  await assert.rejects(legacyActionArtifact(storage, actor,
    { tool: "action_artifact_export", artifact_id: outputId, destination: restoreDestination }),
  error => error.code === "ACCESS_DENIED");
  await storage.close(); storage = undefined;
  await startAuthority(restored); await connect(restored);
  assert.deepEqual((await readRun(runId)).output, { artifact_id: outputId });
  const restoredExport = await tool("legacy_action_artifact_write",
    { tool: "action_artifact_export", arguments: { artifact_id: outputId, destination: restoreDestination } });
  assert.notEqual(restoredExport.isError, true, JSON.stringify(restoredExport));
  assert.equal(restoredExport.structuredContent.value.digest, digest(bytes));
  assert.deepEqual(readFileSync(restoreDestination), bytes);
  assert.notEqual((await register(definition)).isError, true, "A fresh trust epoch requires builtin re-admission.");
  const largeImport = await tool("legacy_action_artifact_write",
    { tool: "action_artifact_import", arguments: { local_path: largeSource } });
  assert.notEqual(largeImport.isError, true, JSON.stringify(largeImport));
  expectedSource = largeImport.structuredContent.value.artifact_id;
  expectedDigest = largeDigest; expectedSize = largeBytes.length;
  const largeCall = await call("large-copy", expectedSource);
  assert.notEqual(largeCall.isError, true, JSON.stringify(largeCall));
  const largeRun = await until(() => readRun(largeCall.structuredContent.value.runId),
    value => ["succeeded", "failed", "unknown", "cancelled"].includes(value.state));
  assert.equal(largeRun.state, "succeeded", JSON.stringify(largeRun));
  const restoredCounts = () => {
    const restoredDb = new DatabaseSync(resolve(restored, "core.sqlite"), { readOnly: true });
    try { return Number(restoredDb.prepare("SELECT count(*) n FROM legacy_action_artifacts").get().n); }
    finally { restoredDb.close(); }
  };
  const beforeQuota = restoredCounts();
  const quotaCall = await call("quota-copy", expectedSource);
  assert.notEqual(quotaCall.isError, true, JSON.stringify(quotaCall));
  const quotaRun = await until(() => readRun(quotaCall.structuredContent.value.runId),
    value => ["succeeded", "failed", "unknown", "cancelled"].includes(value.state));
  assert.equal(quotaRun.state, "failed", JSON.stringify(quotaRun));
  assert.equal(quotaRun.nodes[0].reason, "ACTION_ARTIFACT_QUOTA_EXCEEDED");
  assert.equal(Object.hasOwn(quotaRun, "output"), false);
  assert.equal(restoredCounts(), beforeQuota, "A quota failure publishes no managed artifact.");
});
