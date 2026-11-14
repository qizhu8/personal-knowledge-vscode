const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");
const { execFile } = require("node:child_process");
const { createHash } = require("node:crypto");
const ts = require("typescript");
const sync = require("../dist/sync/github-sync");
const repair = require("../dist/sync/github-sync-content-repair");
const { sameKnowledgeRoot } = require("../dist/sync/github-sync-coordinator");

const repository = path.resolve(__dirname, "..");
const extension = fs.readFileSync(path.join(repository, "src/extension.ts"), "utf8");
const start = extension.indexOf('    case "githubSyncRepairResume": {');
const end = extension.indexOf('    case "githubSyncPickIdentity": {', start);
assert(start >= 0 && end > start);
const handler = ts.transpileModule(`async function run() { switch(msg.command) {
  ${extension.slice(start, end)}
} }`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const sha = bytes => createHash("sha256").update(bytes).digest("hex");

function fixture(t, command) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-repair-action-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "skills"));
  const source = path.join(root, "skills/Empty.md");
  fs.writeFileSync(source, '---\nname: "Empty"\n---\n');
  const bytes = fs.readFileSync(source);
  const issue = { type: "skills", itemId: "Empty", path: "skills/Empty.md", source: "local",
    reason: "content-validation", lines: [], content: bytes.toString(), digest: repair.contentRepairDigest(bytes.toString()),
    sourceDigest: sha(bytes), sourcePath: source };
  const record = { id: "review", issues: [issue] };
  const target = sync.normalizeGitHubSyncTarget({ name: "Fixture", repository: "/unused/remote.git", id: "fixture" });
  const calls = { trash: [], revalidate: 0, queued: 0, confirmations: 0, responses: [] };
  const context = vm.createContext({
    ...repair, path, fs, createHash, randomUUID: () => "fixture", sameKnowledgeRoot,
    context: { extensionPath: repository }, msg: { command, targetId: "fixture", repairId: "review", path: issue.path },
    githubSyncTargetById: () => target,
    readGitHubSyncTargets: () => [target],
    requireGitHubSyncManualMode: current => { if (current.automation.enabled) throw new Error("Turn off Auto Sync"); },
    withGitHubSyncTargetLock: async (_context, _id, run) => run(),
    withGitHubSyncApplyLock: async (_context, run) => run(),
    readGitHubSyncContentRepair: () => record,
    githubSyncStateDirectory: () => root,
    getStorePath: () => root,
    mutateGitHubSyncTargets: async (_context, _owner, change) => change([target]).result,
    revalidateGitHubSyncLocalContent: async () => { calls.revalidate++; },
    trashKnowledgeFileViaMcp: async (...args) => { calls.trash.push(args); },
    configureGitHubSyncScheduler: () => {},
    invalidateSharedContentCatalog: () => {},
    refreshKnowledgeGroups: () => {},
    githubSyncDiagnostics: { record: () => {} },
    githubSyncStateData: async () => ({ targets: [target] }),
    githubSyncScheduler: { request: async () => { calls.queued++; } },
    respond: response => calls.responses.push(response),
    vscode: { workspace: { textDocuments: [] }, window: {
      showWarningMessage: async (_title, options, answer) => { assert(options.modal); calls.confirmations++; return answer; },
    } },
  });
  return { root, source, bytes, target, context, calls, execute: () => vm.runInContext(handler + "\nrun()", context) };
}

test("confirmed pause/resume is reversible, file-preserving and never queues Sync", async t => {
  const f = fixture(t, "githubSyncRepairPause");
  await f.execute();
  assert.equal(f.target.pausedItems.length, 1);
  assert.equal(f.target.pausedItems[0].itemId, "Empty");
  assert.equal(f.calls.revalidate, 1);
  assert.equal(f.calls.trash.length, 0);
  assert.match(f.calls.responses.find(response => response.command === "githubSyncRepairResult").data.message, /Item paused/);
  f.context.msg = { command: "githubSyncRepairResume", targetId: "fixture", type: "skills", itemId: "Empty" };
  await f.execute();
  assert.equal(f.target.pausedItems.length, 0);
  assert.equal(f.calls.revalidate, 2);
  assert.equal(f.calls.queued, 0);
  assert.deepEqual(fs.readFileSync(f.source), f.bytes);
});

test("cancelled approvals, stale review and Auto Sync guards cannot modify knowledge or target selections", async t => {
  for (const command of ["githubSyncRepairPause", "githubSyncRepairTrash"]) {
    const f = fixture(t, command);
    f.context.vscode.window.showWarningMessage = async () => undefined;
    await f.execute();
    assert.equal(f.target.pausedItems, undefined);
    assert.equal(f.calls.trash.length, 0);
    assert.equal(f.calls.revalidate, 0);
    const feedback = f.calls.responses.find(response => response.command === "githubSyncRepairResult");
    assert.equal(feedback.data.cancelled, true);
    assert.match(feedback.data.message, /Cancelled/);
    f.context.msg.repairId = "stale";
    await assert.rejects(f.execute, /repair list changed/);
    f.context.msg.repairId = "review";
    f.target.automation.enabled = true;
    await assert.rejects(f.execute, /Turn off Auto Sync/);
    assert.deepEqual(fs.readFileSync(f.source), f.bytes);
  }
});

test("Trash approval pins original bytes, rejects unsaved/changed sources and invokes exact-path MCP", async t => {
  const f = fixture(t, "githubSyncRepairTrash");
  f.context.vscode.workspace.textDocuments = [{ isDirty: true, uri: { scheme: "file", fsPath: f.source } }];
  await assert.rejects(f.execute, /unsaved changes/);
  assert.equal(f.calls.confirmations, 0);
  f.context.vscode.workspace.textDocuments = [];
  f.context.vscode.window.showWarningMessage = async (_title, _options, answer) => {
    fs.appendFileSync(f.source, "edit during approval");
    return answer;
  };
  await assert.rejects(f.execute, /source changed/i);
  assert.equal(f.calls.trash.length, 0);
  fs.writeFileSync(f.source, f.bytes);
  f.context.vscode.window.showWarningMessage = async (_title, _options, answer) => answer;
  await f.execute();
  assert.deepEqual(f.calls.trash[0], [repository, f.root, "skills", "Empty.md", sha(f.bytes)]);
  assert.equal(f.calls.queued, 0);
  assert.equal(f.calls.revalidate, 1);
});

test("shared-file Trash is blocked if another target still has Auto Sync enabled", async t => {
  const f = fixture(t, "githubSyncRepairTrash");
  f.context.readGitHubSyncTargets = () => [f.target, { automation: { enabled: true } }];
  await assert.rejects(f.execute, /Turn off Auto Sync/);
  assert.equal(f.calls.trash.length, 0);
  assert.equal(f.calls.confirmations, 0);
  assert.deepEqual(fs.readFileSync(f.source), f.bytes);
});

test("revalidate-only never queues Sync while explicit revalidate-and-Sync does", async t => {
  const f = fixture(t, "githubSyncRepairRevalidateOnly");
  await f.execute();
  assert.equal(f.calls.revalidate, 1);
  assert.equal(f.calls.queued, 0);
  f.context.msg.command = "githubSyncRepairRevalidate";
  await f.execute();
  assert.equal(f.calls.queued, 1);
});

test("production MCP Trash launcher preserves bytes in shared Trash and rejects stale hashes", async t => {
  const f = fixture(t, "unused");
  const source = fs.readFileSync(path.join(repository, "src/mcp/mcp.ts"), "utf8");
  const ast = ts.createSourceFile("mcp.ts", source, ts.ScriptTarget.Latest, true);
  const declaration = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "trashKnowledgeFileViaMcp");
  assert(declaration);
  const compiled = ts.transpileModule(declaration.getText(ast), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const context = vm.createContext({ exports: {}, path, execFile, process, resolveMcpPython: () => "python" });
  vm.runInContext(compiled, context);
  const trash = context.exports.trashKnowledgeFileViaMcp;
  await assert.rejects(() => trash(repository, f.root, "skills", "Empty.md", "0".repeat(64)), /MCP Trash failed/);
  assert.deepEqual(fs.readFileSync(f.source), f.bytes);
  await trash(repository, f.root, "skills", "Empty.md", sha(f.bytes));
  assert(!fs.existsSync(f.source));
  const trashRoot = path.join(f.root, "skills/.trash");
  const entries = fs.readdirSync(trashRoot);
  assert.equal(entries.length, 1);
  assert.deepEqual(fs.readFileSync(path.join(trashRoot, entries[0], "payload")), f.bytes);
  assert(fs.existsSync(path.join(f.root, ".pkm/state/knowledge-deletions.json")));
});
