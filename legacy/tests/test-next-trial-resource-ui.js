"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const Module = require("node:module");
const { createHash } = require("node:crypto");

const extension = process.env.PKM_TRIAL_EXTENSION_DIST;
if (!extension) throw new Error("Set PKM_TRIAL_EXTENSION_DIST to isolated extension compilation.");

for (const scenario of ["binary", "digest-mismatch", "wrong-binding", "invalid-base64", "oversized", "core-error"]) {
  test(`resource UI ${scenario}: no execution, file writes or unsafe preview`, async () => {
    const bytes = Buffer.from([0, 255, 13, 10, 128, 42]), digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    const asset = { area: "skills", path: "Doc.assets/data.bin", size: scenario === "oversized" ? 1048577 : bytes.length, digest };
    const documentSha256 = "a".repeat(64), errors = [], previews = [], requests = [], commands = new Map();
    class Client {
      async planImport() { return { ready: true, planSha256: "b".repeat(64), blockers: [], target: "/isolated/parent/workspace" }; }
      async confirmImport() { return { outcome: { status: "published" } }; }
      async importStatus() { return { outcome: { status: "published" } }; }
      async attachImport() {}
      async close() {}
      isStopped() { return true; }
      async invoke(operation, args) {
        requests.push({ operation, args });
        if (operation === "list") return { result: { items: [{ id: "doc", title: "Doc", area: "skills" }], nextOffset: null } };
        if (operation === "get") return { result: { content: "Synthetic document" } };
        if (operation === "asset-list") return { result: { id: "doc", area: "skills", documentSha256,
          revision: "c".repeat(64), items: [asset], nextOffset: null, diagnostics: [] } };
        assert.equal(operation, "asset-get");
        if (scenario === "core-error") return { error: { code: "ACCESS_DENIED", message: "Synthetic refusal", effect: "none" } };
        return { result: { ...asset, id: scenario === "wrong-binding" ? "another-doc" : "doc",
          documentSha256, offset: 0, nextOffset: null, data: scenario === "invalid-base64" ? "!not-base64!"
            : (scenario === "digest-mismatch" ? Buffer.alloc(bytes.length) : bytes).toString("base64") } };
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
    await commands.get("personalKnowledge.nextTrialImport")();
    assert.deepEqual(errors, []);
    previews.length = 0;
    await commands.get("personalKnowledge.nextTrialResources")();
    if (scenario === "binary") {
      assert.deepEqual(errors, []);
      assert.equal(previews.length, 1);
      assert.equal(previews[0].language, "plaintext");
      assert(previews[0].content.includes(digest));
      assert.match(previews[0].content, /00 ff 0d 0a 80 2a/);
    } else {
      assert.equal(previews.length, 0, "Invalid chunks must not produce any preview");
      assert.equal(errors.length, 1);
    }
    if (scenario === "oversized") assert.equal(requests.filter(item => item.operation === "asset-get").length, 0);
    assert(requests.every(item => !["create", "update"].includes(item.operation)));
    await adapter.closeNextManagedTrial();
  });
}
