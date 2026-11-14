"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const path = require("node:path");
const Module = require("node:module");
const extension = process.env.PKM_TRIAL_EXTENSION_DIST;
if (!extension) throw new Error("Set PKM_TRIAL_EXTENSION_DIST to isolated extension compilation.");

for (const area of ["prompts", "scripts", "packages", "actions", "components", "action-module-sets", "action-state"]) for (const scenario of ["detail", "unassigned", "directory", "empty-file", "binary", "chunked",
  "page", "page-total-mismatch", "empty", "cancel", "oversize", "core-error", "detail-error", "snapshot-mismatch", "identity-mismatch",
  "hash-mismatch", "base64-mismatch", "length-mismatch", "next-mismatch", "legacy-mismatch", "invalid-page", "invalid-path",
  ...(["prompts", "scripts"].includes(area) ? [] : ["archive-identity", "archive-role"])]) {
  test(`library ${area} ${scenario}: exact original identity/bytes without execution`, async () => {
    const pin = "a".repeat(64), knowledgeId = `script_${"b".repeat(24)}`;
    const bytes = scenario === "empty-file" ? Buffer.alloc(0) : scenario === "binary" ? Buffer.from([255, 0, 254, 1]) :
      scenario === "chunked" ? Buffer.alloc(70013, 65) : Buffer.from("Original {{inert}} text\n");
    const file = area === "prompts" ? `${area}/Project/Task/v1/Original.txt` : `${area}/Nested/Original.py`;
    const identity = { schema: "pkm.script/v1", knowledgeId, aliases: ["pkm://scripts/Old/Original.py"],
      futureOriginal: { owner: "Uninterpreted original" } };
    const archived = !["prompts", "scripts"].includes(area);
    const item = { area, path: file, kind: "file", role: area === "scripts" ? "script" : "resource", size: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"), mode: 0o640,
      prompt: area === "prompts" ? { project: "Project", task: "Task", version: "v1", file: "Original.txt" } : null,
      scriptIdentity: area === "scripts" ? identity : null, identityStatus: area === "scripts" ? "preserved" : "not-applicable" };
    if (scenario === "directory") Object.assign(item, { path: `${area}/Empty`, kind: "directory", role: "directory",
      size: 0, sha256: null, prompt: null, scriptIdentity: null, identityStatus: "not-applicable" });
    if (scenario === "unassigned" && area === "scripts") Object.assign(item, { scriptIdentity: null, identityStatus: "unassigned" });
    if (scenario === "oversize") item.size = 1024 * 1024 + 1;
    if (scenario === "invalid-path") item.path = `${area}/../escape`;
    if (scenario === "archive-identity") item.scriptIdentity = identity;
    if (scenario === "archive-role") item.role = "script";
    const legacy = archived || ["binary", "chunked", "directory"].includes(scenario) ? null :
      area === "prompts" ? { ...item.prompt, raw: bytes.toString("utf8"), content: bytes.toString("utf8"),
        meta: { title: "", note: "", hasMetadata: false } } :
        { content: bytes.toString("utf8"), file: "Original.py", path: "Nested/Original.py", lang: "Python", langs: ["Python"],
          knowledgeId: item.scriptIdentity?.knowledgeId ?? null, aliases: item.scriptIdentity?.aliases ?? [] };
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
        if (scenario === "core-error" || scenario === "detail-error" && operation === "library-get")
          return { error: { code: "INVALID_DOCUMENT" } };
        if (operation === "library-list") {
          if (["page", "page-total-mismatch"].includes(scenario) && args.offset === 0)
            return { result: { items: [{ ...item, path: `${area}/First`, prompt: null }], total: 2, nextOffset: 1, snapshotRevision: pin } };
          return { result: { items: scenario === "empty" ? [] : [item], total: scenario === "empty" ? 0 : scenario === "page-total-mismatch" ? 3 : scenario === "page" ? 2 : 1,
            nextOffset: scenario === "invalid-page" ? 0 : scenario === "page-total-mismatch" ? 2 : null, snapshotRevision: pin } };
        }
        assert.equal(operation, "library-get");
        const chunk = bytes.subarray(args.offset, args.offset + 65536), end = args.offset + chunk.length;
        return { result: { item: scenario === "identity-mismatch" ? { ...item, mode: 0o600 } : item,
          snapshotRevision: scenario === "snapshot-mismatch" ? "c".repeat(64) : pin, encoding: "base64",
          data: scenario === "base64-mismatch" ? "not base64" : scenario === "hash-mismatch" ? Buffer.alloc(chunk.length, 42).toString("base64") : chunk.toString("base64"),
          offset: scenario === "length-mismatch" ? args.offset + 1 : args.offset,
          nextOffset: scenario === "next-mismatch" ? 99 : end < bytes.length ? end : null,
          legacy: scenario === "legacy-mismatch" ? { ...legacy, raw: "wrong", content: "wrong" } : legacy,
          textStatus: scenario === "binary" ? "binary" : scenario === "chunked" ? "chunked" : "complete-utf8" } };
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
        showQuickPick: async choices => choices[0] === "No Memory Engine" ? choices[0] : choices[0]?.area ? choices.find(item => item.area === area) : scenario === "cancel" ? undefined :
          ["page", "page-total-mismatch"].includes(scenario) && requests.filter(row => row.operation === "library-list").length === 1 ? choices.at(-1) : choices[0],
        showTextDocument: async () => {},
      },
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
    adapter.registerNextManagedTrial({ extensionPath: "/isolated/extension", subscriptions: [] }, () => "/isolated/legacy");
    try {
      await commands.get("personalKnowledge.nextTrialImport")(); previews.length = 0;
      await commands.get(archived ? "personalKnowledge.nextTrialCodeArchive" : `personalKnowledge.nextTrial${area === "prompts" ? "Prompts" : "Scripts"}`)();
      if (["detail", "unassigned", "directory", "empty-file", "binary", "chunked", "page"].includes(scenario)) {
        assert.deepEqual(errors, []);
        assert.equal(previews.length, 1);
        assert.equal(previews[0].language, "plaintext");
        const content = previews[0].content, parsed = JSON.parse(content.slice(content.indexOf("{")));
        assert.deepEqual(parsed.item, item);
        assert.equal(parsed.snapshotRevision, pin);
        assert(content.includes(archived ? "NOT installed; execution NOT authorized; runtime NOT verified" : "aliases are not an event log"));
        if (archived) {
          assert.equal(parsed.preservedStoragePath, `legacy-code-archive/${item.path}`);
          assert(content.includes("Trusted workspace automatic Action trust policy is unchanged"));
        }
        if (area === "action-state") {
          assert.equal(parsed.archivePolicy, "archive_only");
          assert.equal(parsed.authorizationStatus, "not-inherited");
          assert.equal(parsed.originalSourcePath, `.pkm/state/actions/${item.path.slice("action-state/".length)}`);
          assert(content.includes("do NOT describe current runtime state"));
          assert(content.includes("No authorization is restored"));
        }
        if (scenario === "directory") {
          assert(!requests.some(row => row.operation === "library-get"));
        } else {
          assert.equal(parsed.raw, scenario === "binary" ? bytes.toString("hex") : bytes.toString("utf8"));
          assert.deepEqual(parsed.legacy, legacy);
          const reads = requests.filter(row => row.operation === "library-get");
          assert.equal(reads.length, scenario === "chunked" ? 2 : 1);
          assert.deepEqual(reads[0].args, { area, path: file, expectedDigest: item.sha256, snapshotRevision: pin, offset: 0, length: 65536 });
        }
        if (scenario === "page") assert.deepEqual(requests.filter(row => row.operation === "library-list").map(row => row.args),
          [{ area, offset: 0, limit: 50 }, { area, offset: 1, limit: 50, snapshotRevision: pin }]);
      } else {
        assert.equal(previews.length, 0);
        assert.equal(errors.length, ["empty", "cancel"].includes(scenario) ? 0 : 1);
        if (scenario === "oversize") assert(!requests.some(row => row.operation === "library-get"));
        if (scenario === "empty") assert(messages.some(message => message.includes(`No ${area}`)));
      }
      assert(requests.every(row => ["list", "library-list", "library-get"].includes(row.operation)));
    } finally { await adapter.closeNextManagedTrial(); }
  });
}
