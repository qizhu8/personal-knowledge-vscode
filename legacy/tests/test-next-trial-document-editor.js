"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const Module = require("node:module");
const extension = process.env.PKM_TRIAL_EXTENSION_DIST;
if (!extension) throw new Error("Set PKM_TRIAL_EXTENSION_DIST to isolated extension compilation.");

for (const area of ["notes", "skills", "papers"]) for (const scenario of [
  "update", "create", "fields", "conflict", "unknown", "bad-receipt", "cancel", "closed", "invalid-fields", "changed-approval",
]) test(`native isolated editor ${area} ${scenario}`, async () => {
  const pin = "a".repeat(64), sha256 = "b".repeat(64), knowledgeId = `knowledge_${"c".repeat(24)}`;
  const row = { id: "original-doc", area, path: "Original.md", revision: 3, sha256, deleted: false, title: "Original" };
  const requests = [], previews = [], errors = [], commands = new Map(), notices = [];
  let closed, metadataMode = false;
  const body = "Original body\n", edited = "Edited\nmultiple lines\n{{ inert }}\n";
  class Client {
    async resumeImport() {}
    async close() {}
    isStopped() { return true; }
    async invoke(operation, args) {
      requests.push({ operation, args });
      if (operation === "mutation-scan") return { result: { scanRevision: pin, documents: [{ ...row, knowledgeId }] } };
      if (operation === "list") return { result: { items: [row], total: 1, nextOffset: null, workspaceRevision: pin } };
      if (operation === "get") return { result: { ...row, content: body } };
      if (scenario === "conflict") return { error: { code: "CONFLICT", effect: "not-committed" } };
      if (scenario === "unknown") throw Error("IPC lost");
      return { result: { operationId: args.operationId, action: scenario === "create" ? "create" : "update", area,
        path: "Original.md", id: scenario === "bad-receipt" ? "wrong-doc" : scenario === "create" ? knowledgeId : row.id,
        knowledgeId, revision: scenario === "create" ? 1 : 4, sha256: "d".repeat(64), category: "",
        name: scenario === "create" ? "New Original" : "Original" } };
    }
  }
  const window = {
    activeTextEditor: undefined,
    showOpenDialog: async () => [{ fsPath: "/isolated/node" }],
    showInputBox: async options => options.prompt.includes("category") ? "Guides" : "New Original",
    showWarningMessage: async message => {
      if (message.includes("Resume")) return "Resume Isolated Experiment";
      if (scenario === "changed-approval") window.activeTextEditor.document.text += "Changed during approval";
      return scenario === "cancel" ? undefined : "Publish Isolated Draft";
    },
    showInformationMessage: async message => notices.push(message),
    showErrorMessage: async message => errors.push(message),
    showQuickPick: async choices => choices[0]?.area ? choices.find(item => item.area === area) :
      choices.find(item => scenario === "create" ? item.action === "create" : item.action === "open"),
    showTextDocument: async document => { window.activeTextEditor = { document }; },
  };
  const vscode = {
    commands: { registerCommand(name, action) { commands.set(name, action); return { dispose() {} }; } },
    workspace: {
      onDidCloseTextDocument(callback) { closed = callback; return { dispose() {} }; },
      openTextDocument: async options => {
        const document = { text: options.content, languageId: options.language, getText() { return this.text; }, isClosed: false };
        previews.push(document); return document;
      },
    }, window,
  };
  const compiled = path.join(extension, "ui/next-managed-trial.js"), load = Module._load;
  delete require.cache[require.resolve(compiled)];
  let adapter;
  try {
    Module._load = function (name, ...args) {
      if (name === "vscode") return vscode;
      if (name === "../runtime/next-managed-client") return { NextManagedClient: Client };
      return load.call(this, name, ...args);
    };
    adapter = require(compiled);
  } finally { Module._load = load; }
  const credential = { parent: "/isolated", workspaceId: "workspace", capability: "e".repeat(64) };
  adapter.registerNextManagedTrial({ extensionPath: "/extension", subscriptions: [],
    secrets: { get: async () => JSON.stringify(credential) } }, () => "/legacy");
  try {
    await commands.get("personalKnowledge.nextTrialResumeWrite")();
    await commands.get("personalKnowledge.nextTrialEditDocument")();
    const draftBody = window.activeTextEditor.document;
    assert.equal(draftBody.languageId, "plaintext");
    draftBody.text = edited;
    if (["fields", "invalid-fields"].includes(scenario)) {
      metadataMode = true;
      await commands.get("personalKnowledge.nextTrialDocumentFields")();
      const fields = area === "skills" ? { priority: "highest", recipe_required: true } :
        area === "papers" ? { authors: ["Original author"], cites: [{ paper: "Prior", note: "Original relation" }] } :
          { pinned: true, tags: ["original"] };
      window.activeTextEditor.document.text = JSON.stringify(scenario === "invalid-fields" ? { knowledgeId: "replace" } : fields);
    }
    if (scenario === "closed") await adapter.closeNextManagedTrial();
    await commands.get("personalKnowledge.nextTrialPublishDocument")();
    const writes = requests.filter(row => /-(create|update)$/.test(row.operation));
    if (["cancel", "closed", "invalid-fields", "changed-approval"].includes(scenario)) {
      assert.equal(writes.length, 0);
    } else {
      assert.equal(writes.length, 1);
      const write = writes[0];
      assert.equal(write.operation, `${area === "notes" ? "note" : area === "skills" ? "skill" : "research"}-${scenario === "create" ? "create" : "update"}`);
      assert.equal(write.args.content, edited);
      assert.equal(write.args.expectedScanRevision, pin);
      assert.match(write.args.operationId, /^[a-f0-9-]{36}$/);
      if (scenario === "create") {
        assert.equal(write.args[area === "skills" ? "name" : "title"], "New Original");
        assert.equal(write.args.category, "Guides");
        assert(!("id" in write.args));
      } else {
        assert.equal(write.args.id, row.id);
        assert.equal(write.args.expectedSha256, sha256);
        assert.equal(write.args.expectedRevision, 3);
        assert.equal(write.args.preserveIdentity, true);
        assert(!("name" in write.args) && !("title" in write.args) && !("moveTo" in write.args));
      }
      if (metadataMode) assert(area === "skills" ? write.args.priority === "highest" :
        area === "papers" ? write.args.authors[0] === "Original author" : write.args.pinned === true);
      await commands.get("personalKnowledge.nextTrialPublishDocument")();
      assert.equal(requests.filter(row => /-(create|update)$/.test(row.operation)).length, 1, "Never replay a published or rejected draft");
    }
    assert.equal(draftBody.text.startsWith(edited), true, "Keep unsaved body on failure/conflict");
    if (scenario === "unknown") assert(errors.some(message => message.includes(writes[0].args.operationId)));
    if (scenario === "conflict") assert(errors.some(message => message.includes("CONFLICT")));
    if (["update", "create", "fields"].includes(scenario)) assert(notices.some(message => message.includes("published at revision")));
    if (closed) closed(draftBody);
  } finally { await adapter.closeNextManagedTrial(); }
});
