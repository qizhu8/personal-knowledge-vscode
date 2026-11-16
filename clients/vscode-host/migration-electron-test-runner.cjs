"use strict";
const assert = require("node:assert/strict");
const { readFile, readdir } = require("node:fs/promises");
const { join } = require("node:path");
const { pathToFileURL } = require("node:url");
const vscode = require("vscode");

exports.run = async () => {
  const fixture = JSON.parse(process.env.PKM_MANAGED_MIGRATION_FIXTURE);
  delete process.env.PKM_MANAGED_MIGRATION_FIXTURE;
  const { publishIsolatedManagedGeneration } = await import(pathToFileURL(fixture.module).href);
  const extension = vscode.extensions.getExtension("pkm-nonproduction.pkm-v5");
  assert(extension, "Nonproduction extension must be loaded");
  const config = vscode.workspace.getConfiguration("pkm.nextHost");
  const before = config.inspect("managedRoot")?.globalValue;
  const command = (name, ...args) => vscode.commands.executeCommand(`pkm.nextHost.${name}`, ...args);
  const invoke = async (name, input = {}) => {
    const result = JSON.parse(await command("migrationInvoke", { name: `mcp_pkm_${name}`, input }));
    return result.structuredContent ?? JSON.parse(result.content.filter(part => part.type === "text").map(part => part.text).join("\n"));
  };
  const workerPids = new Set();
  const checkModel = async () => {
    if (!fixture.modelPackageId) return;
    const status = await invoke("retrieval_status");
    assert.equal(status.semantic_status, "ready");
    assert.equal(status.solution.active_package_id, fixture.modelPackageId);
    assert(!workerPids.has(status.pid));
    workerPids.add(status.pid);
    const result = await invoke("search_knowledge", { query: "evidence model", route: "semantic", debug: true });
    assert.equal(result.model_invoked, true);
    assert.match(result.retrieval_id, /^[a-f0-9]{48}$/);
    assert(result.hits.length > 0);
    const feedback = await invoke("retrieval_feedback", { retrieval_id: result.retrieval_id,
      relevant_source_ids: [result.hits[0].source_id], complete: true, provenance: "model" });
    assert.equal(feedback.ok, true, JSON.stringify(feedback));
    assert.equal(feedback.trained, true);
    assert.equal((await invoke("retrieval_status")).pid, status.pid);
    return status.pid;
  };
  const assertReaped = pid => {
    if (pid) assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  };
  const leaf = (name, args = {}, write = false) => invoke(write ? "capability_call" : "capability_read",
    { operation: `mcp.tool.${name}`, version: 1, arguments: args });
  let artifactId, schedule, disabledDue, scheduledTags;
  try {
    await extension.activate();
    const ids = await vscode.commands.getCommands(true);
    for (const name of ["migrationConnect", "migrationDisconnect", "migrationState", "migrationInvoke"])
      assert(ids.includes(`pkm.nextHost.${name}`));
    await config.update("managedRoot", fixture.managedRoot, vscode.ConfigurationTarget.Global);
    const connected = await command("migrationConnect");
    assert.equal(connected.status, "connected");
    assert.equal(connected.generation, fixture.first);
    assert.equal(connected.automaticReplay, false);
    assert.equal((await invoke("get_note", { id: "Example" })).title, "Electron migration");
    assert.equal((await invoke("get_research", { slug: "Paper" })).title, "Electron Research");
    const firstPid = await checkModel();
    if (fixture.schedulerArtifacts) {
      const tools = await import(pathToFileURL(join(fixture.module, "../../tests/managed-scheduler-artifact-fixture.mjs")).href);
      artifactId = (await leaf("action_artifact_import", { local_path: fixture.schedulerArtifacts.source }, true)).artifact_id;
      assert.match(artifactId, /^artifact_[a-f0-9]{32}$/);
      assert.equal((await leaf("action_artifact_export", { artifact_id: artifactId,
        destination: fixture.schedulerArtifacts.destination }, true)).digest, fixture.schedulerArtifacts.digest);
      const before = await leaf("knowledge_snapshot_status");
      schedule = tools.nextRealSnapshotMinute();
      const enabled = await leaf("knowledge_snapshot_configure", { enabled: true, ...schedule }, true);
      assert(Date.parse(enabled.next_run_utc) > Date.now());
      scheduledTags = (await tools.waitForRealSnapshot(leaf, before.tags.length)).tags.length;
    }
    await publishIsolatedManagedGeneration(fixture.managedRoot, fixture.second);
    const old = await invoke("mcp_lifecycle_status");
    assert.equal(old.generation, fixture.first);
    assert.equal(old.updateAvailable, true);
    const successor = await command("migrationConnect");
    assert.equal(successor.status, "connected");
    assert.equal(successor.generation, fixture.second);
    assertReaped(firstPid);
    const secondPid = await checkModel();
    if (fixture.schedulerArtifacts) {
      assert.equal((await leaf("knowledge_snapshot_status")).tags.length, scheduledTags);
      await assert.rejects(leaf("action_artifact_export", { artifact_id: artifactId,
        destination: fixture.schedulerArtifacts.destination }, true));
      schedule = { local_time: new Date(Date.now() + 90_000).toISOString().slice(11, 16), timezone: "UTC" };
      disabledDue = Date.parse((await leaf("knowledge_snapshot_configure", { enabled: true, ...schedule }, true)).next_run_utc);
      assert.equal((await leaf("knowledge_snapshot_configure", { enabled: false, ...schedule }, true)).enabled, false);
    }
    assert.equal((await invoke("list_notes", { limit: 0 })).notes.length, 1);
    await publishIsolatedManagedGeneration(fixture.managedRoot, fixture.first);
    const rollback = await command("migrationConnect");
    assert.equal(rollback.generation, fixture.first);
    assertReaped(secondPid);
    const rollbackPid = await checkModel();
    if (fixture.schedulerArtifacts) {
      await new Promise(resolve => setTimeout(resolve, Math.max(0, disabledDue - Date.now() + 500)));
      assert.equal((await leaf("knowledge_snapshot_status")).tags.length, scheduledTags,
        "Disabled real job must not fire across its actual deadline after restart/rollback");
      console.log("MANAGED_SCHEDULER_ARTIFACT_ELECTRON_OK: actual timer/Git, persisted disable across deadline/restart, artifact import/export/no-overwrite");
    }
    await command("migrationDisconnect");
    assertReaped(rollbackPid);
    assert.equal((await command("migrationState")).status, "disconnected");
    await assert.rejects(command("migrationInvoke", { name: "mcp_pkm_list_notes", input: {} }), /not accepting/);
    for (const filename of (await readdir(join(fixture.managedRoot, "instances"))).filter(name => name.endsWith(".json"))) {
      const state = JSON.parse(await readFile(join(fixture.managedRoot, "instances", filename), "utf8"));
      assert.equal(state.inFlight, 0);
      assert.equal(state.uncertainCalls, 0);
      assert.equal(state.acceptingNewCalls, false);
    }
    console.log("MANAGED_MIGRATION_ELECTRON_OK: actual launcher, original Chat handshake, Note/Research, upgrade, drain, reconnect, rollback");
    if (fixture.modelPackageId)
      console.log("MANAGED_MODEL_ELECTRON_OK: isolated local-model dependencies, actual semantic model receipts/feedback, distinct persistent workers reaped");
  } finally {
    await command("migrationDisconnect");
    await config.update("managedRoot", before, vscode.ConfigurationTarget.Global);
  }
};
