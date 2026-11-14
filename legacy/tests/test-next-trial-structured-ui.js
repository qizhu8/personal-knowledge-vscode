"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const Module = require("node:module");
const extension = process.env.PKM_TRIAL_EXTENSION_DIST;
if (!extension) throw new Error("Set PKM_TRIAL_EXTENSION_DIST to isolated extension compilation.");

for (const kind of ["Research", "Skills"]) for (const scenario of ["detail", "identity-mismatch", "core-error"]) {
  test(`structured ${kind} ${scenario}: full original identity/metadata and read-only binding`, async () => {
    const pin = "a".repeat(64), sha256 = "b".repeat(64), knowledgeId = `knowledge_${"c".repeat(24)}`;
    const item = { title: "Original", name: "Original", slug: "Nested/Original", documentId: "stable-doc", documentSha256: sha256,
      knowledgeId, revision: 7, aliases: ["Old alias"], recipe_hint: "Original hint", cites: [{ paper: "Prior", note: "Original relation" }] };
    const area = kind === "Research" ? "papers" : "skills", requests = [], previews = [], errors = [], commands = new Map();
    class Client {
      async planImport() { return { ready: true, planSha256: pin, blockers: [], target: "/isolated/target" }; }
      async confirmImport() { return { outcome: { status: "published" } }; }
      async importStatus() { return { outcome: { status: "published" } }; }
      async attachImport() {}
      async close() {}
      isStopped() { return true; }
      async invoke(operation, args) {
        requests.push({ operation, args });
        if (operation === "list") return { result: { items: args.area ? [{ id: "stable-doc", area, path: "Nested/Original.md" }] : [],
          nextOffset: null, workspaceRevision: pin } };
        if (scenario === "core-error") return { error: { code: "INVALID_DOCUMENT" } };
        if (operation === "research-list") return { result: { items: [item], revision: pin, nextOffset: null } };
        if (operation === "skill-list") return { result: { items: [item], snapshotRevision: pin, nextOffset: null } };
        if (operation === "skill-get") return { result: { item: { ...item, content: "Original body" }, snapshotRevision: pin } };
        if (operation === "metadata-get") return { result: { id: "stable-doc", sha256, metadata: { knowledgeId, unknownOriginalField: ["Preserved"] } } };
        assert.equal(operation, "get");
        return { result: { id: "stable-doc", area, path: "Nested/Original.md", sha256: scenario === "identity-mismatch" ? "d".repeat(64) : sha256, content: "Original body" } };
      }
    }
    const vscode = {
      commands: { registerCommand(name, action) { commands.set(name, action); return { dispose() {} }; } },
      workspace: { openTextDocument: async options => { previews.push(options); return options; } },
      window: {
        showOpenDialog: async () => [{ fsPath: "/isolated/fixture" }],
        showWarningMessage: async message => message.includes("Assert this") ? "I Assert Static Copy" : "Import Exact Plan",
        showInformationMessage: async () => {},
        showErrorMessage: async message => errors.push(message),
        showQuickPick: async choices => choices[0],
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
    await commands.get("personalKnowledge.nextTrialImport")(); previews.length = 0;
    await commands.get(`personalKnowledge.nextTrial${kind}`)();
    if (scenario === "detail") {
      assert.deepEqual(errors, []);
      assert.equal(previews.length, 1);
      assert.equal(previews[0].language, "plaintext");
      for (const text of [knowledgeId, "Old alias", "Original body", "unknownOriginalField", "Original relation"])
        assert(previews[0].content.includes(text));
    } else {
      assert.equal(errors.length, 1);
      assert.equal(previews.length, 0);
    }
    assert(!requests.some(item => ["create", "update"].includes(item.operation)));
    await adapter.closeNextManagedTrial();
  });
}
