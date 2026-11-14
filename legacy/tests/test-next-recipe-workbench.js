"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), path = require("node:path"), Module = require("node:module");
const dist = process.env.PKM_TRIAL_EXTENSION_DIST;
if (!dist) throw Error("Set PKM_TRIAL_EXTENSION_DIST to the isolated extension compilation.");

for (const scenario of ["declined", "trust-revoked", "disposed", "approved"]) {
  test(`ordinary Recipe Workbench save requires a still-live exact human decision: ${scenario}`, async () => {
    let receive, dispose, saved = 0;
    const replies = [], binding = { root: "/isolated/workspace", workspaceId: "fixture", namespace: "a".repeat(16),
      chatId: "00000000-0000-4000-8000-000000000001", actorId: "local:owner" };
    const panel = { webview: { html: "", onDidReceiveMessage(handler) { receive = handler; return { dispose() {} }; },
      async postMessage(value) { replies.push(value); } }, onDidDispose(handler) { dispose = handler; } };
    const vscode = { ViewColumn: { One: 1 }, workspace: { isTrusted: true }, window: {
      createWebviewPanel() { return panel; },
      async showWarningMessage(message, options, button) {
        assert.equal(message, "Approve this exact Recipe request?");
        const detail = options.detail;
        assert(detail.includes(binding.root));
        assert(detail.includes('"expectedRevision": 0'));
        if (scenario === "trust-revoked") vscode.workspace.isTrusted = false;
        if (scenario === "disposed") dispose();
        return scenario === "declined" ? undefined : button;
      },
    } };
    const client = {
      isStopped() { return false; },
      async recipeCommand(command, review) {
        if (command.operation === "state") return { binding, state: { digest: "b".repeat(64) }, catalog: { recipes: [] } };
        assert.equal(command.operation, "save");
        const approved = await review({ binding, operation: "library-save", approval: command.input });
        if (!approved) throw Error("Exact human decision declined.");
        saved++;
        return { recipe: { ...command.input.fields, recipeId: command.input.recipeId, revision: 1 }, digest: "c".repeat(64) };
      },
    };
    const filename = path.join(dist, "ui/next-recipe-workbench.js"), originalLoad = Module._load;
    delete require.cache[require.resolve(filename)];
    let htmlRecipe, workbench;
    try {
      Module._load = function (name, ...args) {
        if (name === "vscode") return vscode;
        if (name === "./recipe-browser") return { recipeBrowserEditorDocument(recipe) { htmlRecipe = recipe; return ""; } };
        return originalLoad.call(this, name, ...args);
      };
      workbench = require(filename);
    } finally { Module._load = originalLoad; }
    await workbench.openManagedRecipeWorkbench({ secrets: { async get() {}, async store() {} } }, client, () => true);
    await receive({ type: "nativeRecipeEditor", requestId: "actual-ui-request", path: "/api/recipe",
      options: { method: "PUT", body: JSON.stringify({ ...htmlRecipe, name: "Reviewed definition" }) } });
    assert.equal(saved, scenario === "approved" ? 1 : 0);
    assert.equal(replies.length, 1);
    if (scenario === "approved") assert.equal(replies[0].value.recipe.revision, 1);
    else assert.equal(typeof replies[0].error, "string");
  });
}
