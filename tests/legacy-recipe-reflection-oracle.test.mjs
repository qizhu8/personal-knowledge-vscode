import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { cp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { prepare, capture, load } from "./legacy-api-chat-recipes-fixtures.mjs";

const require = createRequire(import.meta.url);
const original = process.env.PKM_TEST_LEGACY_RECIPE_EXTENSION;
const skip = !original && "Requires an actual original VSIX.";

test("original built-in Reflection keeps global input collisions and performs actual local Skill selection/feedback on isolated Next",
  { skip, timeout: 90000 }, async t => {
    const prepared = prepare();
    const evidence = require("../legacy/tests/next-trial-electron/legacy-reflection-gate-fixture.cjs").create({
      extension: original, root: prepared.originalRoot, fixture: prepared.fixture,
    });
    const oracle = spawnSync("python3", ["-B", "tests/next-trial-electron/legacy-reflection-gate-oracle.py",
      original, prepared.fixture], { encoding: "utf8", timeout: 30000 });
    assert.equal(oracle.status, 0, oracle.stderr + oracle.stdout);
    const old = JSON.parse(oracle.stdout);
    assert.equal(old.final.status, "completed");
    assert.equal(old.release.start.ok, false);
    assert.match(old.release.start.error.message, /cannot emit accepted outcome.*succeeded/);
    const before = capture(prepared.originalRoot);
    const { initialize, Storage } = await load("storage");
    const { createNativeRuntime } = await load("native-runtime");
    const { LegacyRecipeLazyRuntime } = await load("legacy-recipe-lazy-runtime");
    const { LegacyRecipeExternalReports } = await load("legacy-recipe-external-reports");
    const { canonicalJson } = await load("domain/project-recipes-workflow-contracts");
    await initialize(prepared.root);
    await cp(join(prepared.originalRoot, "skills"), join(prepared.root, "skills"), { recursive: true });
    const storage = await Storage.open(prepared.root);
    let runtime, lazy, skillServer, skillClient;
    t.after(async () => {
      try {
        await skillClient?.close(); await skillServer?.close();
        lazy?.close(); await runtime?.close(); await storage.close();
        assert.deepEqual(capture(prepared.originalRoot), before);
      } finally { await rm(prepared.base, { recursive: true, force: true }); }
    });
    runtime = await createNativeRuntime({ storage, workspaceId: await storage.workspaceId() });
    const recipe = evidence.reflection, recipes = [recipe, evidence.gate];
    const actor = { id: prepared.actorId, canWrite: true };
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    skillServer = await (await load("legacy-note-mcp")).startLegacyNoteMcp(storage, serverTransport, {
      core: runtime.core, actor,
    });
    skillClient = new Client({ name: "reflection-real-skills", version: "1" });
    await skillClient.connect(clientTransport);
    const actualInvocations = [];
    const openLazy = () => {
      const external = new LegacyRecipeExternalReports({
        id: "original-reflection-external-caller", authorizationDigest: "a".repeat(64), portedNoops: true, humanGates: true,
        authorizeDefinition: binding => binding.actorId === actor.id && recipes.some(row =>
          binding.executableDigest === row.executableDigest
          && canonicalJson(binding.node) === canonicalJson(row.definition.spec.nodes.find(node => node.nodeId === binding.node.nodeId))),
      });
      const execute = external.adapter.execute;
      external.adapter.execute = (invocation, context) => {
        actualInvocations.push({ nodeId: invocation.node.nodeId, inputs: invocation.inputs });
        return execute(invocation, context);
      };
      return new LegacyRecipeLazyRuntime(storage.connectNative(), {
        actorId: actor.id, root: prepared.root, bindingFingerprint: "b".repeat(64), ownerId: randomUUID(),
        adapters: {}, externalReports: external, assertOwner: () => storage.assertWorkspaceLease(), requestCancel() {},
        catalog: async () => ({ recipes, snapshotRevision: "c".repeat(64) }),
        resolveRecipe: source => {
          const row = recipes.find(recipe => recipe.recipeId === source.recipeId);
          return { status: "valid", source, definition: row.definition, executableDigest: row.executableDigest };
        },
      });
    };
    lazy = openLazy();
    const call = (name, args) => lazy.dispatch(`mcp.tool.recipe_run_${name}`, args, actor);
    const started = await call("start", old.start_args);
    assert.equal(started.ok, true, JSON.stringify(started));
    let current = await call("next", { run_id: started.run_id, command_id: "native-reflection-claim" });
    let context;
    const actualResults = [];
    for (const [index, step] of old.steps.entries()) {
      assert.equal(current.next_action.node_id, step.action.node_id);
      assert.deepEqual(current.next_action.inputs, old.inputs);
      let result;
      if (index === 0) result = JSON.parse(step.args.result_json);
      else {
        const skill = old.skill_calls[index - 1];
        const args = { ...skill.args, ...(index === 2 ? { interaction_id: context.interaction_id } : {}) };
        const response = await skillClient.callTool({
          name: index === 1 ? "legacy_knowledge_read" : "legacy_skill_maintenance",
          arguments: { tool: skill.name, arguments: args },
        });
        assert(!response.isError, JSON.stringify(response));
        const value = response.structuredContent.value;
        assert.equal(value.ok, true, JSON.stringify(value));
        if (index === 1) {
          context = value;
          assert.deepEqual(value.skills.map(row => ({ id: row.skill_id, hash: row.content_hash })),
            skill.result.skills.map(row => ({ id: row.skill_id, hash: row.content_hash })));
          result = { "related-skills": value };
        } else result = { "maintenance-result": value };
      }
      actualResults.push(result);
      current = await call("report", { ...step.args, result_json: JSON.stringify(result) });
      assert.equal(current.ok, true, JSON.stringify(current));
      const completed = current.current_result.completed_nodes.find(node => node.node_id === step.action.node_id);
      assert.deepEqual(completed.result, result);
    }
    assert.equal(current.status, "completed");
    assert.deepEqual(actualInvocations, old.steps.map(step => ({ nodeId: step.action.node_id, inputs: old.inputs })));
    const feedback = (await readFile(join(prepared.root, "_feedback/skill-usage.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
    assert.equal(feedback.length, 1);
    for (const key of ["task_hash", "used_skills", "outcome", "observations", "evidence"])
      assert.deepEqual(feedback[0][key], old.feedback_rows[0][key], key);
    assert.equal(feedback[0].id, actualResults[2]["maintenance-result"].feedback_id);
    assert.equal(await readFile(join(prepared.root, "skills/Reflection.md"), "utf8"),
      await readFile(join(prepared.originalRoot, "skills/Reflection.md"), "utf8"));
    for (const gate of old.gates) {
      const start = await call("start", gate.start_args);
      assert.equal(start.ok, true, JSON.stringify(start));
      assert.equal(start.run_id, gate.start.run_id);
      const next = await call("next", gate.next_args);
      assert.deepEqual(next.next_action, gate.next.next_action);
      assert.equal((await call("report", gate.forged_args)).ok, false);
      lazy.close(); lazy = openLazy();
      const restarted = await call("get", { run_id: start.run_id });
      assert.deepEqual(restarted.next_action, gate.restart_get.next_action);
      const submitted = await call("submit_input", gate.submit_args);
      assert.equal(submitted.ok, true, JSON.stringify(submitted));
      const completed = submitted.current_result.completed_nodes.find(node => node.node_id === gate.submit_args.node_id);
      const expected = gate.submitted.current_result.completed_nodes.find(node => node.node_id === gate.submit_args.node_id);
      assert.deepEqual(completed, expected);
      if (gate.report_args) {
        assert.deepEqual(submitted.next_action.inputs, gate.submitted.next_action.inputs);
        assert.equal((await call("report", gate.report_args)).status, gate.final.status);
      } else assert.equal(submitted.status, gate.final.status);
    }
  });
