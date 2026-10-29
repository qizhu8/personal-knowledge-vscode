#!/usr/bin/env node
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");
const ts = require("typescript");
const { todoUsageSummary, recipeNodeUsageSummary } = require("../dist/mcp/mcp-usage.js");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-todo-usage-"));
try {
  const sessionId = "agent_session_test";
  const todoId = "todo_test";
  const directory = path.join(root, ".pkm", "state", "mcp-usage", "todos", sessionId);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, `${todoId}.json`), JSON.stringify({
    schema: "pkm.mcp.todo-usage/v1",
    agentSessionId: sessionId,
    todoId,
    calls: 4,
    successes: 3,
    inputBytes: 600,
    outputBytes: 1400,
    durationMs: 37.5,
    estimatedTokens: 500,
    firstUsedAt: "2026-09-30T00:00:00Z",
    lastUsedAt: "2026-09-30T00:01:00Z",
    domains: { automation: { calls: 3 }, skillRouter: { calls: 1 } },
    tools: { recipe_run_report: { calls: 2 }, skill_context: { calls: 1 }, recipe_run_next: { calls: 1 } },
    modules: {"recipe_run_test:first":{calls:2,successes:1,inputBytes:120,outputBytes:280,durationMs:12,estimatedTokens:100}},
  }));

  const usage = todoUsageSummary(root, sessionId, todoId, [{
    usage: {
      measuredTokens: { input_tokens: 100, output_tokens: 25, cached_input_tokens: 50, reasoning_tokens: 5, total_tokens: 130 },
      estimatedTokens: 80,
      unknownModelCalls: 1,
      measuredReports: 1,
      estimatedReports: 1,
      providers: ["copilot"],
      models: ["test-model"],
    },
  }]);
  assert.deepStrictEqual(usage.protocol, {
    observed: true,
    quality: "estimated",
    calls: 4,
    successes: 3,
    failures: 1,
    inputBytes: 600,
    outputBytes: 1400,
    durationMs: 37.5,
    estimatedTokens: 500,
    firstUsedAt: "2026-09-30T00:00:00Z",
    lastUsedAt: "2026-09-30T00:01:00Z",
    domains: { automation: 3, skillRouter: 1 },
    tools: { recipe_run_report: 2, skill_context: 1, recipe_run_next: 1 },
  });
  assert.strictEqual(usage.model.quality, "partial");
  assert.deepStrictEqual(usage.model.measuredTokens, {
    inputTokens: 100, outputTokens: 25, cachedInputTokens: 50, reasoningTokens: 5, totalTokens: 130,
  });
  assert.strictEqual(usage.model.estimatedTokens, 80);
  assert.strictEqual(usage.model.unknownModelCalls, 1);
  assert.strictEqual(usage.modules["recipe_run_test:first"].calls, 2, "read only explicitly attributed module calls");
  assert.strictEqual(usage.modules["recipe_run_test:first"].failures, 1);
  assert.strictEqual(usage.modules["recipe_run_test:first"].estimatedTokens, 100);
  assert.deepStrictEqual(usage.credit, { quality: "unknown", premiumRequests: null });

  const unknown = todoUsageSummary(root, sessionId, "todo_missing", []);
  assert.strictEqual(unknown.protocol.observed, false);
  assert.strictEqual(unknown.protocol.quality, "unknown");
  assert.strictEqual(unknown.model.quality, "unknown");
  assert.strictEqual(unknown.credit.quality, "unknown");
  const records = [
    {recipeRunId:"recipe_run_test", nodeId:"first", attempt:1, measuredTokens:{input_tokens:10,output_tokens:5,total_tokens:15}},
    {recipeRunId:"recipe_run_test", nodeId:"first", attempt:2, estimatedTokens:20, unknownModelCalls:1},
    {recipeRunId:"recipe_run_test", nodeId:"second", attempt:1, measuredTokens:{total_tokens:100}},
    {recipeRunId:"run_child", nodeId:"first", attempt:1, measuredTokens:{total_tokens:200}},
  ];
  const nodeUsage = recipeNodeUsageSummary("recipe_run_test", "first", {records});
  assert.strictEqual(nodeUsage.model.measuredTokens.totalTokens, 15, "do not copy sibling or child-run consumption");
  assert.strictEqual(nodeUsage.model.estimatedTokens, 20, "include recorded retries");
  assert.strictEqual(nodeUsage.model.quality, "partial");
  assert.strictEqual(nodeUsage.protocol.observed, false, "report attempts are not function-call totals");
  assert.strictEqual(recipeNodeUsageSummary("recipe_run_test", "missing", {records}).model.quality, "unknown");
  assert.strictEqual(recipeNodeUsageSummary("recipe_run_test", "second", {records,recordsTruncated:1}).model.quality, "partial",
    "retained records cannot represent complete historical consumption after truncation");
  assert.strictEqual(recipeNodeUsageSummary("recipe_run_test", "zero", {records:[
    {recipeRunId:"recipe_run_test",nodeId:"zero",measuredTokens:{total_tokens:0}}
  ]}).model.quality, "measured", "explicitly measured zero is distinct from missing usage");
  const trashDirectory = path.join(root, ".pkm", "state", "agent-sessions-trash");
  const runsDirectory = path.join(root, ".pkm", "state", "recipe-runs");
  fs.mkdirSync(trashDirectory, {recursive:true});
  fs.mkdirSync(runsDirectory, {recursive:true});
  fs.writeFileSync(path.join(trashDirectory, `${sessionId}.json`), JSON.stringify({
    schema:"pkm.agent.session/v1", sessionId, status:"completed", task:"Historical task",
    trashedAt:"2026-10-04T00:00:00Z", recipeRunIds:["recipe_run_test"],
    todos:[{todoId, title:"Historical Todo", details:"Historical details", summary:"Historical summary", recipeRunIds:["recipe_run_test"]}],
    checkpoints:[{checkpointId:"historical_checkpoint", state:{summary:"Historical checkpoint"}}],
  }));
  fs.writeFileSync(path.join(trashDirectory, "corrupt.json"), "{");
  fs.writeFileSync(path.join(runsDirectory, "recipe_run_test.json"), JSON.stringify({
    schema:"pkm.recipe.run/v1",runId:"recipe_run_test",recipeName:"Historical Recipe",usage:{records},
    definition:{spec:{nodes:[{nodeId:"first",generalInstruction:"Historical module"},{nodeId:"second"}]}},
    nodes:{first:{state:"succeeded"},second:{state:"succeeded"}},
  }));
  const extensionSource = fs.readFileSync(path.join(__dirname, "..", "src", "extension.ts"), "utf8");
  const ast = ts.createSourceFile("extension.ts", extensionSource, ts.ScriptTarget.Latest, true);
  const projectionSource = ["agentSessionSnapshots", "agentSessionTrashSnapshots"].map(name =>
    ast.statements.find(statement => ts.isFunctionDeclaration(statement) && statement.name?.text === name).getText(ast)
  ).join("\n");
  const projectionContext = {
    fs,path,getStorePath:()=>root,todoUsageSummary,recipeNodeUsageSummary,
    ...require("../dist/agent-sessions/agent-session-lifecycle.js"),
    ...require("../dist/runtime/pkm-projection.js"),
    agentSessionOrigin: require("../dist/chat/api-chat-store.js").agentSessionOrigin,
    agentSessionJsonCache:{read:filename=>JSON.parse(fs.readFileSync(filename,"utf8"))},
  };
  vm.runInNewContext(ts.transpileModule(projectionSource,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText, projectionContext);
  const historical = projectionContext.agentSessionTrashSnapshots();
  assert.strictEqual(historical.length, 1, "corrupt Trash records do not hide healthy history");
  assert.strictEqual(historical[0].todos[0].details, "Historical details");
  assert.strictEqual(historical[0].checkpoint.summary, "Historical checkpoint");
  assert.strictEqual(historical[0].runs[0].nodes[0].instruction, "Historical module");
  assert.strictEqual(historical[0].runs[0].nodes[0].usage.model.measuredTokens.totalTokens, 15);
  assert.strictEqual(historical[0].runs[0].nodes[0].usage.protocol.calls, 2);
  assert.strictEqual(historical[0].runs[0].nodes[1].usage.protocol.observed, false, "sibling modules never inherit Todo-wide calls");
  console.log("Todo usage aggregation: protocol estimates and model quality stay separate");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
