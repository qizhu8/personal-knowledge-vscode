"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const Module = require("node:module");
const extension = process.env.PKM_TRIAL_EXTENSION_DIST;
if (!extension) throw new Error("Set PKM_TRIAL_EXTENSION_DIST to isolated extension compilation.");

for (const scenario of ["summary", "task-pages", "stories", "conflict", "core-error", "empty"]) {
  test(`Board UI ${scenario} keeps read_only_defer and opens only validated plaintext snapshots`, async () => {
    const digest = "d".repeat(64), errors = [], previews = [], requests = [], commands = new Map(), notices = [];
    class Client {
      async planImport() { return { ready: true, planSha256: "b".repeat(64), blockers: [], target: "/isolated/parent/workspace" }; }
      async confirmImport() { return { outcome: { status: "published" } }; }
      async importStatus() { return { outcome: { status: "published" } }; }
      async attachImport() {}
      async close() {}
      isStopped() { return true; }
      async invoke(operation, args) {
        requests.push({ operation, args });
        if (operation === "list") return { result: { items: [] } };
        if (scenario === "core-error") return { error: { code: "INVALID_DOCUMENT" } };
        if (operation === "board-list") return { result: { items: scenario === "empty" ? [] : [{ title: "Original", slug: "Original", digest }], next_offset: null } };
        if (operation === "board-get") return { result: { board_slug: "Original", digest: scenario === "conflict" ? "a".repeat(64) : digest, counts: { workitems: 2 } } };
        assert(["board-tasks", "board-stories"].includes(operation));
        assert.equal(args.expected_digest, digest);
        return { result: { board_slug: "Original", digest, items: [{ id: `item-${args.offset}`, title: "Original task" }],
          next_offset: scenario === "task-pages" && args.offset === 0 ? 50 : null } };
      }
    }
    const vscode = {
      commands: { registerCommand(name, action) { commands.set(name, action); return { dispose() {} }; } },
      workspace: { openTextDocument: async options => { previews.push(options); return options; } },
      window: {
        showOpenDialog: async () => [{ fsPath: "/isolated/fixture" }],
        showWarningMessage: async message => message.includes("Assert this") ? "I Assert Static Copy" : "Import Exact Plan",
        showInformationMessage: async message => notices.push(message),
        showErrorMessage: async message => errors.push(message),
        showQuickPick: async choices => choices[0] === "No Memory Engine" ? choices[0] : typeof choices[0] === "object" ? choices[0]
          : choices[0] === "Board summary" ? scenario === "task-pages" ? "Tasks (read-only)" : scenario === "stories" ? "User Stories (read-only)" : "Board summary"
            : choices[0] === "Next Board item page" ? choices[0] : undefined,
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
    previews.length = 0;
    await commands.get("personalKnowledge.nextTrialBoards")();
    if (["conflict", "core-error"].includes(scenario)) {
      assert.equal(errors.length, 1);
      assert.equal(previews.length, 0);
    } else {
      assert.deepEqual(errors, []);
      assert.equal(previews.length, scenario === "empty" ? 0 : scenario === "task-pages" ? 2 : 1);
      assert(previews.every(item => item.language === "plaintext" && item.content.includes("read_only_defer")));
    }
    if (scenario === "empty") assert(notices.some(message => /No dedicated Boards/.test(message)));
    assert(requests.every(item => ["list", "board-list", "board-get", "board-tasks", "board-stories"].includes(item.operation)));
    await adapter.closeNextManagedTrial();
  });
}
