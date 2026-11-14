"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const Module = require("node:module");
const { createHash, randomUUID } = require("node:crypto");

const extension = process.env.PKM_TRIAL_EXTENSION_DIST;
if (!extension) throw Error("Set PKM_TRIAL_EXTENSION_DIST to isolated extension compilation.");
const sha = value => createHash("sha256").update(value).digest("hex");

for (const mode of ["approve", "cancel", "untrusted"]) {
  test(`VS Code Memory import ${mode} uses explicit source/scope/host approval rather than CLI authority`, async () => {
    const scope = '{"account":"synthetic","project":"original","repository":"original"}';
    const target = "/synthetic/private/workspace", planSha256 = "b".repeat(64), sourceSha256 = "a".repeat(64);
    const commands = new Map(), approvals = [], errors = [], reads = [], secrets = new Map();
    const workspaceId = randomUUID();
    const pin = { schema: "pkm.memory-host-pin/v1", workspaceId, actorId: "local:owner",
      scope, sourceScopeSha256: sha(scope), sourceDatabaseSha256: sourceSha256,
      importPlanSha256: planSha256, importReceiptSha256: "c".repeat(64), receiptStateSha256: "d".repeat(64) };
    let quickPick = 0, selected = false, attached = false, client;
    class Client {
      constructor() { client = this; }
      async planImport(...args) {
        assert.equal(args.length, 7);
        assert.equal(args[6], "/synthetic/fixture");
        return { ready: true, target, planSha256, blockers: [], memoryPlan: { scopes: [scope], sourceSha256 } };
      }
      async selectMemoryScope(digest) {
        assert.equal(digest, sha(scope)); selected = true;
        return { ready: true, target, planSha256, blockers: [],
          memoryPlan: { scopes: [scope], sourceSha256, continuityScopeSha256: digest } };
      }
      setMemoryScopeApprovalHandler(handler) { this.handler = handler; }
      async confirmImport(digest) {
        assert(selected); assert.equal(digest, planSha256);
        const approval = await this.handler({ target, request: {
          schema: "pkm.memory-scope-continuity/v2", workspaceId, actorId: "local:owner",
          scope, sourceScopeSha256: sha(scope), sourceDatabaseSha256: sourceSha256,
          importPlanSha256: planSha256, importReceiptSha256: "c".repeat(64),
        } });
        if (!approval) throw Error("Exact host Memory admission denied.");
        approvals.push(approval);
        return { outcome: { status: "published" } };
      }
      async importStatus() { return { outcome: { status: "published" } }; }
      async attachImport() { attached = true; }
      async prepareMemoryReadoption() { return { target, pin }; }
      async openMemoryWorkspace() {}
      async readoptMemory(expected, handler) {
        assert.deepEqual(expected, pin);
        const { schema, receiptStateSha256, ...identity } = pin;
        const approval = await handler({ target, receiptStateSha256,
          request: { ...identity, schema: "pkm.memory-scope-continuity/v2" } });
        if (!approval) throw Error("Exact new Memory session denied.");
        approvals.push(approval);
      }
      async invoke(operation, args) {
        if (operation === "list") return { result: { items: [] } };
        reads.push({ operation, args }); return { records: [] };
      }
      async close() {}
      isStopped() { return true; }
    }
    const vscode = {
      commands: { registerCommand(name, action) { commands.set(name, action); return { dispose() {} }; } },
      workspace: { isTrusted: mode !== "untrusted", openTextDocument: async options => options },
      window: {
        showOpenDialog: async () => [{ fsPath: "/synthetic/fixture" }],
        showQuickPick: async choices => ++quickPick === 1 ? choices[1] : quickPick === 2 ? choices[0] : undefined,
        showWarningMessage: async (message, options) => {
          if (message.includes("Assert this")) return "I Assert Static Copy";
          if (message.includes("exact displayed plan")) return "Import Exact Plan";
          assert.match(options.detail, /NOT original-owner proof/);
          for (const value of [target, "local:owner", scope, sourceSha256, planSha256, "c".repeat(64)])
            assert(options.detail.includes(value));
          return mode === "approve" ? message.startsWith("Re-adopt") ? "Approve New Memory Session" : "Adopt Exact Memory Scope" : undefined;
        },
        showInputBox: async () => "synthetic",
        showInformationMessage: async () => {},
        showErrorMessage: async message => errors.push(message),
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
    adapter.registerNextManagedTrial({ extensionPath: "/synthetic/extension", subscriptions: [],
      secrets: { get: async key => secrets.get(key), store: async (key, value) => secrets.set(key, value) } }, () => "/synthetic/not-read");
    await commands.get("personalKnowledge.nextTrialImport")();
    assert(client);
    assert.equal(attached, mode === "approve");
    assert.equal(approvals.length, mode === "approve" ? 1 : 0);
    if (mode === "approve") {
      assert.deepEqual(errors, []);
      assert.deepEqual(reads, [{ operation: "memory-search", args: { query: "synthetic" } }]);
      assert.deepEqual(JSON.parse(secrets.get(`pkm.nextTrial.memoryHostPin.v1:${workspaceId}`)), pin);
      await adapter.closeNextManagedTrial();
      await commands.get("personalKnowledge.nextTrialMemoryReadopt")();
      assert.deepEqual(errors, []);
      assert.equal(approvals.length, 2);
      pin.receiptStateSha256 = "e".repeat(64);
      await commands.get("personalKnowledge.nextTrialMemoryReadopt")();
      assert(errors.at(-1).includes("Independent host pin"));
      assert.equal(approvals.length, 2);
      pin.receiptStateSha256 = "d".repeat(64);
      secrets.clear();
      await commands.get("personalKnowledge.nextTrialMemoryReadopt")();
      assert(errors.at(-1).includes("Independent host pin"));
      assert.equal(approvals.length, 2, "Evidence in the workspace cannot enroll its own trusted-host pin.");
    } else {
      assert(errors.some(message => /admission denied/.test(message)));
      if (mode === "untrusted") {
        await commands.get("personalKnowledge.nextTrialMemoryReadopt")();
        assert(errors.at(-1).includes("Trusted workspace approval"));
      }
    }
    await adapter.closeNextManagedTrial();
  });
}
