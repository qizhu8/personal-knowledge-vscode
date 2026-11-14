const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const { createChatE2eFixture } = require("../dist/chat/chat-e2e-fixture");

test("real model fixture retrieval exposes only synthetic bounded tail evidence and current dependencies", async () => {
  const { retrieve } = createChatE2eFixture();
  const candidates = await retrieve("fixture-beta", new AbortController().signal);
  const evidence = candidates.find(item => item.content?.includes("125 ms"));
  assert(evidence.range.start > 160000);
  assert(candidates.filter(item => item.content).every(item => item.content.length <= 4000));
  assert(candidates.every(item => item.sourceId === "pkm://notes/e2e-synthetic"));
  retrieve.refreshSourceValidation();
  assert(candidates.every(candidate => retrieve.sourceIsCurrent(candidate)));
  const aborted = new AbortController(); aborted.abort();
  await assert.rejects(retrieve("fixture-beta", aborted.signal), /cancelled/);
});

test("fixture E2E continues coding after failed evidence, never reads private MCP and retains truthful reports", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-fixture-e2e-"));
  const modulePath = require.resolve("../dist/chat/api-chat-acceptance");
  const original = Module._load;
  let chat;
  try {
    Module._load = function(name, parent, ...rest) {
      if (parent?.filename === modulePath) {
        if (name === "vscode") return {
          workspace:{ isTrusted:true, workspaceFolders:[{ uri:{ scheme:"file", fsPath:directory } }] },
          window:{ showWarningMessage:async () => "Run fixture E2E", showQuickPick:async items => items[0], showInformationMessage:() => new Promise(() => {}) },
        };
        if (name === "./api-chat-vscode") return {
          discoverVscodeModels:async () => [{ name:"Copilot fixture", vendor:"copilot" }],
          vscodeModelProfile:() => ({ id:"fixture", label:"Copilot fixture", contextWindow:64000, maxOutputTokens:4096 }),
        };
        if (name === "./api-chat-mcp") return { vscodeToolCatalog() { throw new Error("Private MCP catalog must not be read."); } };
      }
      return original.call(this, name, parent, ...rest);
    };
    delete require.cache[modulePath];
    const { runFixtureChatAcceptance } = require(modulePath);
    Module._load = original;
    for (const successfulEvidence of [false, true]) {
      await runFixtureChatAcceptance(() => chat = {
        id:"fixture", createdAt:new Date().toISOString(), messages:[], context:[{ content:"PRIVATE" }],
        agentContext:{ memory:[{ content:"PRIVATE" }], pkmSkills:[], externalSkills:[] }, mcpServers:[{ name:"private" }],
      }, async (target, prompt, retrieval) => {
        assert.equal(target.includeHistory, false);
        assert.deepEqual(target.context, []);
        assert.deepEqual(target.agentContext, { memory:[], pkmSkills:[], externalSkills:[] });
        assert.deepEqual(target.mcpServers, []);
        assert.deepEqual(target.vscodeTools, []);
        assert.equal(typeof retrieval, "function");
        const reply = { role:"assistant", status:"complete", content:"{}" };
        if (target.builtinTools.includes("run_process")) {
          const folder = fs.readdirSync(directory).filter(name => name.startsWith("chat-e2e-")).sort()
            .find(name => fs.existsSync(path.join(directory, name, "module.cjs")) &&
              fs.readFileSync(path.join(directory, name, "module.cjs"), "utf8").includes("left - right"));
          fs.writeFileSync(path.join(directory, folder, "module.cjs"), "exports.add = (left, right) => left + right;\n");
          const stdout = require("node:child_process").execFileSync(process.execPath, [`${folder}/test.cjs`], { cwd:directory, encoding:"utf8" });
          reply.toolCalls = ["read_file", "replace_text", "save_file"].map(name => ({ name, status:"complete" }));
          reply.toolCalls.push({ name:"run_process", status:"complete",
            arguments:JSON.stringify({ program:process.execPath, arguments:[`${folder}/test.cjs`], cwd:"." }),
            result:JSON.stringify({ exitCode:0, stdout }) });
          target.toolSelection = { disabledTools:[], disabledSources:[] };
          delete target.builtinTools;
        } else if (successfulEvidence) {
          reply.content = '{"latencyMs":125,"concurrency":32,"hardware":"CPU-only","approval":"NOT_APPROVED"}';
          reply.retrieval = { phase:"sent", candidates:[{ selected:true, range:{ start:180000, end:180100 } }] };
          reply.budgetReceipts = [{ status:"sent" }];
        }
        target.messages.push(reply);
      }, () => {});
      const reports = fs.readdirSync(directory).filter(name => name.startsWith("chat-e2e-"))
        .map(name => JSON.parse(fs.readFileSync(path.join(directory, name, "acceptance.json"))));
      assert(reports.some(report => report.status === (successfulEvidence ? "succeeded" : "failed")));
      const report = reports.find(report => report.status === (successfulEvidence ? "succeeded" : "failed"));
      assert.deepEqual(report.steps.map(step => step.name), ["tail-evidence", "coding"]);
      assert.equal(report.steps[1].verdict, "succeeded");
      assert.equal(report.credits, null);
      assert.equal(report.privateKnowledge, false);
    }
  } finally {
    Module._load = original; delete require.cache[modulePath];
    fs.rmSync(directory, { recursive:true, force:true });
  }
});
