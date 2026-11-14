"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const Module = require("node:module");
const extension = process.env.PKM_TRIAL_EXTENSION_DIST;
if (!extension) throw new Error("Set PKM_TRIAL_EXTENSION_DIST to isolated extension compilation.");

for (const scenario of ["detail", "page", "empty", "cancel", "core-error", "detail-error", "snapshot-mismatch",
  "identity-mismatch", "revision-mismatch", "digest-mismatch", "knowledge-mismatch", "invalid-summary", "invalid-page"]) {
  test(`Recipe UI ${scenario}: read-only pinned original model`, async () => {
    const pin = "a".repeat(64), digest = "b".repeat(64);
    const summary = { recipeId: "recipe_original", knowledgeId: `knowledge_${"c".repeat(24)}`, revision: 7,
      name: "Original Recipe", description: "Original description", category: "Project/Original/Guides", executableDigest: digest };
    const item = { ...summary, schema: 1, aliases: ["recipe:Original"], scope: "global", definition: { nodes: [{ id: "original" }] },
      methodology: { preserve: "Original methodology" }, metadata: { applicableFunctions: ["Original"], solution: "Original",
        requiredInputs: [], expectedOutputs: [] }, editorLayout: { nodePositions: { original: { x: 7, y: 9 } } },
      origin: { kind: "legacy", sourceRecipeId: "recipe_original", sourceScope: "project", publisherUser: "Original owner" } };
    const requests = [], previews = [], errors = [], messages = [], commands = new Map();
    class Client {
      async planImport() { return { ready: true, planSha256: pin, blockers: [], target: "/isolated/target" }; }
      async confirmImport() { return { outcome: { status: "published" } }; }
      async importStatus() { return { outcome: { status: "published" } }; }
      async attachImport() {}
      async close() {}
      isStopped() { return true; }
      async invoke(operation, args) {
        requests.push({ operation, args });
        if (operation === "list") return { result: { items: [], nextOffset: null, workspaceRevision: pin } };
        if (scenario === "core-error" || scenario === "detail-error" && operation === "recipe-get")
          return { error: { code: "SNAPSHOT_CHANGED" } };
        if (operation === "recipe-list") {
          if (scenario === "page" && args.offset === 0)
            return { result: { items: [summary], total: 2, nextOffset: 1, snapshotRevision: pin } };
          return { result: { items: scenario === "empty" ? [] : [{ ...summary,
            ...(scenario === "invalid-summary" ? { executableDigest: undefined } : {}) }],
          total: scenario === "empty" ? 0 : scenario === "page" ? 2 : 1,
          nextOffset: scenario === "invalid-page" ? 0 : null, snapshotRevision: pin } };
        }
        assert.equal(operation, "recipe-get");
        return { result: { snapshotRevision: scenario === "snapshot-mismatch" ? "d".repeat(64) : pin,
          item: { ...item, ...(scenario === "identity-mismatch" ? { recipeId: "recipe_other" } : {}),
            ...(scenario === "revision-mismatch" ? { revision: 8 } : {}),
            ...(scenario === "digest-mismatch" ? { executableDigest: "e".repeat(64) } : {}),
            ...(scenario === "knowledge-mismatch" ? { knowledgeId: `knowledge_${"f".repeat(24)}` } : {}) } } };
      }
    }
    const vscode = {
      commands: { registerCommand(name, action) { commands.set(name, action); return { dispose() {} }; } },
      workspace: { openTextDocument: async options => { previews.push(options); return options; } },
      window: {
        showOpenDialog: async () => [{ fsPath: "/isolated/fixture" }],
        showWarningMessage: async message => message.includes("Assert this") ? "I Assert Static Copy" : "Import Exact Plan",
        showInformationMessage: async message => messages.push(message),
        showErrorMessage: async message => errors.push(message),
        showQuickPick: async choices => choices[0] === "No Memory Engine" ? choices[0] : scenario === "cancel" ? undefined :
          scenario === "page" && requests.filter(row => row.operation === "recipe-list").length === 1 ? choices.at(-1) : choices[0],
        showTextDocument: async () => {},
      },
    };
    const file = path.join(extension, "ui/next-managed-trial.js"), load = Module._load;
    delete require.cache[require.resolve(file)];
    let adapter;
    try {
      Module._load = function (name, ...args) {
        if (name === "vscode") return vscode;
        if (name === "../runtime/next-managed-client") return { NextManagedClient: Client };
        return load.call(this, name, ...args);
      };
      adapter = require(file);
    } finally { Module._load = load; }
    adapter.registerNextManagedTrial({ extensionPath: "/isolated/extension", subscriptions: [] }, () => "/isolated/legacy");
    try {
      await commands.get("personalKnowledge.nextTrialImport")(); previews.length = 0;
      await commands.get("personalKnowledge.nextTrialRecipes")();
      if (["detail", "page"].includes(scenario)) {
        assert.deepEqual(errors, []);
        assert.equal(previews.length, 1);
        assert.equal(previews[0].language, "plaintext");
        const content = previews[0].content;
        assert.deepEqual(JSON.parse(content.slice(content.indexOf("{"))), { snapshotRevision: pin, summary, item });
        assert(content.includes("does not grant project ownership"));
        assert.deepEqual(requests.find(row => row.operation === "recipe-get").args,
          { id: summary.recipeId, expectedRevision: 7, expectedExecutableDigest: digest, snapshotRevision: pin });
        if (scenario === "page") assert.deepEqual(requests.filter(row => row.operation === "recipe-list").map(row => row.args),
          [{ offset: 0, limit: 50 }, { offset: 1, limit: 50, snapshotRevision: pin }]);
      } else {
        assert.equal(previews.length, 0);
        assert.equal(errors.length, ["empty", "cancel"].includes(scenario) ? 0 : 1);
        if (scenario === "empty") assert(messages.some(message => message.includes("No Recipes")));
      }
      assert(requests.every(row => ["list", "recipe-list", "recipe-get"].includes(row.operation)));
      assert(requests.filter(row => row.operation === "recipe-get").length <= 1, "Never retry rejected details");
    } finally { await adapter.closeNextManagedTrial(); }
  });
}
