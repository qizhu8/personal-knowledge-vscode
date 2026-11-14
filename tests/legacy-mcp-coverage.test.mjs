import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

test("original MCP source-derived coverage never equates adapter counts with migration acceptance", () => {
  const report = JSON.parse(execFileSync(process.execPath, [
    fileURLToPath(new URL("../scripts/assess-legacy-mcp-coverage.mjs", import.meta.url)),
  ], { encoding: "utf8" }));
  assert.equal(report.migrationReady, false);
  assert.equal(report.acceptanceEvidence, false);
  assert.equal(new Set(report.tools.map(tool => tool.name)).size, report.tools.length);
  for (const name of ["recipe_run_start", "api_chat_send"]) {
    assert(report.missingTools.includes(name), `Missing original surface must remain visible: ${name}`);
  }
  for (const name of ["add_note", "update_skill", "search_notes", "get_skill", "delete_note", "delete_skill", "delete_paper",
    "knowledge_file_trash", "note_work_item_command", "note_work_item_upsert",
    "get_knowledge", "get_script", "search_knowledge", "search_scripts", "retrieval_status", "retrieval_feedback"])
    assert(report.partialTools.includes(name));
  for (const name of ["skill_feedback", "propose_skill_update", "skill_capabilities"])
    assert.equal(report.tools.find(tool => tool.name === name).status, "implemented");
  assert.equal(report.tools.find(tool => tool.name === "todo_board_create").status, "partial");
  for (const name of ["knowledge_recovery_preview", "knowledge_recovery_apply"]) {
    assert(report.partialTools.includes(name));
    assert(!report.missingTools.includes(name));
  }
  for (const name of ["action_definition_check", "action_graph_check", "action_register", "action_proposals", "action_graph_save"]) {
    assert(report.partialTools.includes(name));
    assert(!report.missingTools.includes(name));
    assert.match(report.tools.find(tool => tool.name === name).blocker, /background preparation/);
  }
  assert.equal(report.tools.find(tool => tool.name === "action_templates").status, "implemented");
  assert(report.partialTools.includes("action_template_create"));
  assert.match(report.tools.find(tool => tool.name === "action_template_create").blocker, /pending-only/);
  for (const name of ["asset_classify_preview", "asset_classify_apply", "asset_classify_rollback"]) {
    assert(report.partialTools.includes(name));
    assert(!report.missingTools.includes(name));
    assert.match(report.tools.find(tool => tool.name === name).blocker, /--allow-asset-classification/);
  }
  for (const name of ["api_chat_capabilities", "api_chat_models", "api_chat_list", "api_chat_get", "api_chat_request_get"]) {
    assert(report.partialTools.includes(name));
    assert(!report.missingTools.includes(name));
    assert.match(report.tools.find(tool => tool.name === name).blocker, /legacy Hosts.*request submission\/replay/);
  }
  assert(report.partialTools.includes("recipe_capabilities"));
  assert(!report.missingTools.includes("recipe_capabilities"));
  assert.match(report.tools.find(tool => tool.name === "recipe_capabilities").blocker, /not implemented.*not runnable/);
  assert(report.partialTools.includes("action_capabilities"));
  assert(!report.missingTools.includes("action_capabilities"));
  assert.match(report.tools.find(tool => tool.name === "action_capabilities").blocker, /limited projection.*unavailable/);
  assert(report.partialTools.includes("action_run_get"));
  assert(!report.missingTools.includes("action_run_get"));
  assert.match(report.tools.find(tool => tool.name === "action_run_get").blocker, /native-owned Action run status.*monitor notifications/);
  assert(report.missingTools.includes("action_call"));
  assert.match(report.tools.find(tool => tool.name === "action_call").blocker,
    /ActionRuntime.call\/_authorize\/_call.*Azure CLI host credentials/);
  assert(report.missingTools.includes("action_cosmos_configure"));
  assert.match(report.tools.find(tool => tool.name === "action_cosmos_configure").blocker,
    /ActionRuntime.configure_cosmos.*No native host-bound admission\/revocation adapter/);
  assert(report.partialTools.includes("action_retrieve"));
  assert(!report.missingTools.includes("action_retrieve"));
  assert.match(report.tools.find(tool => tool.name === "action_retrieve").blocker,
    /Availability is explicitly blocked.*runtime readiness remain unavailable/);
  for (const name of ["action_module_sets", "action_module_set_import", "action_module_set_load", "action_module_set_remove"]) {
    assert(report.partialTools.includes(name));
    assert(!report.missingTools.includes(name));
    assert.match(report.tools.find(tool => tool.name === name).blocker, /host-approved fixed source/);
  }
  for (const name of ["action_artifact_import", "action_artifact_export"]) {
    assert(report.partialTools.includes(name));
    assert(!report.missingTools.includes(name));
    assert.match(report.tools.find(tool => tool.name === name).blocker, /exact source and destination paths/);
  }
  for (const name of ["knowledge_snapshot_status", "knowledge_snapshot_create", "knowledge_snapshot_restore_preview", "knowledge_snapshot_restore_apply"]) {
    assert(report.partialTools.includes(name));
    assert(!report.missingTools.includes(name));
    assert.match(report.tools.find(tool => tool.name === name).blocker, /private-Git/);
  }
  assert(!report.missingTools.includes("knowledge_snapshot_configure"));
  assert.equal(report.tools.find(tool => tool.name === "knowledge_snapshot_configure").status, "managed-experimental-only");
  assert.match(report.tools.find(tool => tool.name === "knowledge_snapshot_configure").blocker, /host is active/);
  assert(report.tools.every(tool => tool.sourceSha256.match(/^[a-f0-9]{64}$/)));
});
