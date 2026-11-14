import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { mkdir, readFile, readlink, rm, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { initialize, Storage } from "../dist/storage.js";
import { NativeRecipeLibrary } from "../dist/native-recipe-library.js";
import { readProjectRecipeSnapshot } from "../dist/project-recipes.js";
import { capture } from "./legacy-api-chat-recipes-fixtures.mjs";
import { bindManagedClientHost, startManagedClientHost } from "../dist/managed-client-host.js";
import { canonicalJson } from "../dist/domain/project-recipes-workflow-contracts.js";

const require = createRequire(import.meta.url);
const original = process.env.PKM_TEST_LEGACY_RECIPE_EXTENSION;

test("actual managed production host forwards Recipe authority: original raw ports and human gate restart need fresh exact host decisions",
  { skip: !original && "Requires an actual original VSIX.", timeout: 90000 }, async t => {
    if (process.platform !== "linux") { t.skip("Private Linux namespace validation; Windows remains separate mandatory work."); return; }
    if (!process.env.PKM_RECIPE_PARENT_PID_NS) {
      const privateHome = resolve(`.migration-test-work/managed-recipe-namespace-${randomUUID()}`);
      await mkdir(privateHome, { recursive: true, mode: 0o700 });
      t.after(() => rm(privateHome, { recursive: true, force: true }));
      const env = { ...process.env, HOME: privateHome, TMPDIR: privateHome, TMP: privateHome, TEMP: privateHome,
        PKM_RECIPE_PARENT_PID_NS: await readlink("/proc/self/ns/pid") };
      delete env.NODE_TEST_CONTEXT;
      delete env.NODE_CHANNEL_FD;
      const result = spawnSync("unshare", ["-Urnmpf", "--mount-proc", "bash", "-c",
        '"$@" & workload=$!; wait "$workload"', "pkm-private-recipe-tests", process.execPath,
        "--test", "--test-name-pattern=actual managed production host", fileURLToPath(import.meta.url)], {
        env, encoding: "utf8", timeout: 80000,
      });
      assert.equal(result.status, 0, String(result.error ?? "") + result.stdout + result.stderr);
      assert.match(result.stdout, /MANAGED_RECIPE_ORACLE_COMPLETE/);
      console.log(result.stdout.trim());
      return;
    }
    assert.notEqual(await readlink("/proc/self/ns/pid"), process.env.PKM_RECIPE_PARENT_PID_NS);
    process.umask(0o077);
    const fixture = resolve(`.migration-test-work/managed-recipe-${randomUUID()}`);
    const root = join(fixture, "knowledge"), originalFixture = join(fixture, "original"), originalRoot = join(originalFixture, "knowledge");
    const configDirectory = join(fixture, "config"), configPath = join(configDirectory, "host.json");
    let host;
    await mkdir(configDirectory, { recursive: true, mode: 0o700 });
    t.after(async () => { try { await host?.close(); } finally { await rm(fixture, { recursive: true, force: true }); } });
    await mkdir(originalRoot, { recursive: true, mode: 0o700 });
    await initialize(root);
    await mkdir(join(root, "notes"), { recursive: true, mode: 0o700 });
    const note = "---\ntitle: Existing\ndocumentId: managed-recipe-note\nrevision: 1\n---\nOriginal synthetic content.\n";
    await writeFile(join(root, "notes/Existing.md"), note, { mode: 0o600 });
    await writeFile(join(originalFixture, "native-ui-fixture-token"), randomUUID(), { mode: 0o600 });
    const helper = require("../legacy/tests/next-trial-electron/native-recipe-reflection-gate-installed-fixture.cjs");
    helper.prepare({ extension: original, root: originalRoot, fixture: originalFixture });
    const old = JSON.parse(await readFile(join(originalFixture, "reflection-gate-original-trace.json")));
    const source = JSON.parse(await readFile(join(originalFixture, "reflection-gate-source.json")));
    const ports = JSON.parse(await readFile(join(originalFixture, "ported-branch-source.json")));
    const originalBefore = capture(originalRoot);
    const { id: workspaceId } = JSON.parse(await readFile(join(root, ".pkm-next-workspace")));
    const storage = await Storage.open(root), library = new NativeRecipeLibrary({
      database: storage.connectNative(), workspaceId, assertLease: () => storage.assertWorkspaceLease(),
      original: () => readProjectRecipeSnapshot(root),
    });
    const recipeIds = new Map(), native = [];
    try {
      for (const recipe of [source.reflection, source.gate, ports.recipe]) {
        const recipeId = `recipe_${randomUUID()}`;
        native.push(library.save({ actorId: "local:owner", recipeId, operationId: randomUUID(), expectedRevision: 0,
          expectedSnapshot: library.snapshot().snapshotRevision,
          fields: { name: recipe.name, category: recipe.category, description: recipe.description, definition: recipe.definition } }));
        recipeIds.set(recipe.recipeId, recipeId);
      }
    } finally { library.close(); await storage.close(); }
    const binding = { root, workspaceId, actorId: "local:owner", namespace: "a".repeat(16),
      chatId: randomUUID(), sourceFingerprint: "b".repeat(64) };
    const legacyRecipes = { ...binding,
      authorize: async candidate => canonicalJson(candidate) === canonicalJson(binding),
      externalReports: { id: "managed-original-recipe-copies", portedNoops: true, staticBranches: true, humanGates: true,
        authorizationDigest: createHash("sha256").update(canonicalJson({ binding, native })).digest("hex"),
        authorizeDefinition: candidate => candidate.actorId === binding.actorId && candidate.source?.kind === "recipe"
          && native.some(recipe => recipe.recipeId === candidate.source.recipeId && recipe.executableDigest === candidate.executableDigest
            && canonicalJson(candidate.node) === canonicalJson(recipe.definition.spec.nodes.find(node => node.nodeId === candidate.node.nodeId))),
      },
    };
    const endpoint = "http://127.0.0.1:1/v1";
    await writeFile(configPath, JSON.stringify({
      schema: "pkm.native-host-config/v1", provider: "openai-compatible", endpoint,
      secretRef: "secret:fixture/model", model: "fixture", contextWindow: 16384, maxOutputTokens: 4096,
      outputTokenParameter: "max_tokens", includeUsage: true, tools: ["knowledge.document.create"],
    }), { mode: 0o600 });
    const options = { optIn: true, dataPath: root, configPath, expectedWorkspaceId: workspaceId,
      policy: { authorizedConfigPath: configPath, allowedProviders: ["openai-compatible"], allowedEndpoints: [endpoint],
        allowedModels: ["fixture"], allowedTools: ["knowledge.document.create"], allowInsecureLoopback: true },
      resolveSecret: async () => { throw Error("Recipe reports and human decisions must never access the provider."); },
    };
    await assert.rejects(startManagedClientHost({ ...options, legacyRecipes: { ...legacyRecipes, actorId: "foreign" } }), /actor binding mismatch/);
    host = await startManagedClientHost({ ...options, legacyRecipes });
    let context = await host.recipeContext();
    assert.equal(context.binding.root, root);
    assert.equal(host.writerCoverage.cutoverAuthorized, false);
    await assert.rejects(host.invoke("mcp.tool.recipe_run_start", old.ports.start_args), /Invalid managed document request/);
    async function request(name, args) {
      const input = { operation: `mcp.tool.recipe_run_${name}`,
        args: { ...args, ...(args.recipe_id ? { recipe_id: recipeIds.get(args.recipe_id) } : {}) } };
      assert.equal((await context.invoke(input)).error.code, "ACCESS_DENIED");
      const preview = await context.preview(input);
      await context.approve({ operation: preview.operation, args: preview.args, previewDigest: preview.previewDigest });
      const response = await context.invoke(input);
      assert(!response.error, JSON.stringify(response));
      assert.equal(response.result.ok, true, JSON.stringify(response));
      assert.equal((await context.invoke(input)).error.code, "ACCESS_DENIED");
      return response.result;
    }
    await request("start", old.ports.start_args);
    let current = await request("next", old.ports.next_args);
    for (const report of old.ports.reports) {
      assert.deepEqual(current.next_action.inputs, old.ports.inputs);
      current = await request("report", report.args);
      assert.deepEqual(current.current_result.completed_nodes.find(node => node.node_id === report.args.node_id).result,
        JSON.parse(report.args.result_json));
    }
    assert.equal(current.status, "completed");
    const gate = old.reflection.gates[1];
    await request("start", gate.start_args);
    const claimed = await request("next", gate.next_args);
    assert.deepEqual(claimed.next_action, gate.next.next_action);
    const submit = { operation: "mcp.tool.recipe_run_submit_input", args: gate.submit_args };
    const preview = await context.preview(submit);
    await context.approve({ operation: preview.operation, args: preview.args, previewDigest: preview.previewDigest });
    const oldContext = context;
    await host.close();
    await assert.rejects(oldContext.invoke(submit), /admission is closed/);
    host = await startManagedClientHost({ ...options, legacyRecipes });
    context = await host.recipeContext();
    assert.equal((await context.invoke(submit)).error.code, "ACCESS_DENIED");
    const resumed = await request("get", { run_id: gate.start.run_id, detail: "full" });
    assert.deepEqual(resumed.next_action, claimed.next_action);
    assert.deepEqual((await request("next", { ...gate.next_args, command_id: "managed-reclaim-after-restart" })).next_action, claimed.next_action);
    await assert.rejects(context.preview({ operation: "mcp.tool.recipe_run_report", args: gate.forged_args }),
      /dedicated runtime adapter and cannot be reported manually/);
    const rejected = await request("submit_input", gate.submit_args);
    assert.equal(rejected.status, gate.final.status);
    const result = rejected.current_result.completed_nodes.find(node => node.node_id === gate.submit_args.node_id);
    assert.equal(result.outcome, "rejected");
    assert.deepEqual(result.result, JSON.parse(gate.submit_args.response_json));
    await host.close();
    host = await startManagedClientHost(options);
    assert.equal(host.recipeContext, undefined);
    assert.equal(await readFile(join(root, "notes/Existing.md"), "utf8"), note);
    assert.deepEqual(capture(originalRoot), originalBefore);
    console.log("MANAGED_RECIPE_ORACLE_COMPLETE");
  });

test("managed Recipe review shares admission and close draining; retained capabilities cannot outlive the host", async () => {
  let release, closed = false, calls = 0;
  const waiting = new Promise(resolve => { release = resolve; });
  const binding = { actorId: "local:owner", workspaceId: "fixture", root: "fixture" };
  const managed = bindManagedClientHost({
    workspaceId: "fixture", recipeHost: { binding, recipes: { state: async () => ({}) }, publicApi: {
      previewLazy: async () => { calls++; await waiting; return {}; },
    } },
    core: { dispatch: async () => { throw Error("No execution should be admitted."); } },
    close: async () => { closed = true; },
  }, "fixture");
  const context = await managed.recipeContext();
  const preview = context.preview({ operation: "mcp.tool.recipe_run_get", args: { run_id: "fixture" } });
  await new Promise(resolve => setImmediate(resolve));
  const closing = managed.close();
  assert.equal(closed, false);
  await assert.rejects(context.state(), /admission is closed/);
  await assert.rejects(managed.recipeContext(), /admission is closed/);
  release();
  await preview;
  await closing;
  assert.equal(closed, true);
  assert.equal(calls, 1);
  await assert.rejects(context.invoke({ operation: "mcp.tool.recipe_run_get", args: {} }), /admission is closed/);
});
