const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const { withCrossProcessLock } = require("../dist/runtime/cross-process-lock");
const { BackgroundTaskRegistry } = require("../dist/runtime/background-task-registry");

const source = fs.readFileSync(path.join(__dirname, "..", "src", "extension.ts"), "utf8");
const ast = ts.createSourceFile("extension.ts", source, ts.ScriptTarget.Latest, true);
const declaration = ast.statements.find(statement => ts.isFunctionDeclaration(statement)
  && statement.name?.text === "maintainPkmIntegration");
assert(declaration);
const compiled = ts.transpileModule(`
let integrationMaintenance;
let integrationMaintenanceErrorShown = false;
let integrationMaintenanceState = "idle";
let integrationMaintenanceError = "";
let newerPkmVersionNotice = "";
${declaration.getText(ast)}
globalThis.maintain = maintainPkmIntegration;
globalThis.integration = () => ({ state: integrationMaintenanceState, error: integrationMaintenanceError });
`, { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText;

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-integration-upgrade-"));
  const model = { serverCurrent: false, healthy: true, newer: false, pythonValid: true, fail: false };
  const calls = { generate: 0, repair: 0, refresh: 0, retrieval: 0, dialogs: 0, compiler: 0 };
  const registries = [];
  const host = () => {
    const backgroundTaskRegistry = new BackgroundTaskRegistry();
    registries.push(backgroundTaskRegistry);
    const sandbox = vm.createContext({
      path, process, withCrossProcessLock, backgroundTaskRegistry,
      ensureRecipeCompiler: () => { calls.compiler++; },
      managedMcpServerDirectory: () => root,
      mcpStatus: () => ({ newerThanExpected: model.newer, current: model.serverCurrent,
        installedVersion: "fixture", expectedVersion: "target" }),
      detectMcpPython: () => ({ valid: model.pythonValid, error: "Python unavailable" }),
      mcpRuntimeStatus: () => ({ healthy: model.healthy }),
      ensureMcpRuntime: async () => {
        calls.repair++;
        await new Promise(resolve => setTimeout(resolve, 10));
        if (model.fail) throw new Error("fixture repair failed");
        model.healthy = true;
        model.serverCurrent = true;
      },
      generateMcpServer: () => {
        calls.generate++;
        if (model.fail) throw new Error("fixture generation failed");
        model.serverCurrent = true;
      },
      refreshMcpDefinitions: () => { calls.refresh++; },
      scheduleRetrievalRefresh: () => { calls.retrieval++; },
      mcpPanelStatusData: () => ({}),
      log: { info() {}, warn() {} },
      panel: undefined,
      openMcpSetup() {},
      vscode: { window: {
        showInformationMessage: async () => { calls.dialogs++; },
        showWarningMessage: async () => { calls.dialogs++; },
      } },
    });
    vm.runInContext(compiled, sandbox);
    return sandbox;
  };
  try {
    const first = host();
    const running = first.maintain({});
    assert(["running", "ready"].includes(first.integration().state), "A synchronous code-only upgrade may already be ready");
    assert.strictEqual(first.maintain({}), running, "Duplicate checks in one Host share one background job");
    await running;
    assert.equal(first.integration().state, "ready");
    assert.equal(calls.generate, 1);
    assert.equal(calls.dialogs, 0, "Successful migrations need no user action");
    assert.equal(registries[0].snapshot().tasks.length, 0);
    await first.maintain({});
    assert.equal(calls.generate, 1, "Repeated healthy checks do not rewrite server code");
    assert.equal(calls.compiler, 2, "Even a current MCP version must recheck compiler paths on maintenance");

    model.healthy = false;
    model.serverCurrent = false;
    const second = host();
    const third = host();
    await Promise.all([second.maintain({}), third.maintain({})]);
    assert.equal(calls.repair, 1, "Concurrent Hosts serialize and recheck shared runtime state");
    assert.equal(second.integration().state, "ready");
    assert.equal(third.integration().state, "ready");

    model.serverCurrent = false;
    model.fail = true;
    await first.maintain({});
    assert.equal(first.integration().state, "error");
    assert.match(first.integration().error, /fixture generation failed/);
    assert.equal(registries[0].snapshot().tasks.length, 0);
    model.fail = false;
    await first.maintain({});
    assert.equal(first.integration().state, "ready", "A failed migration remains retryable");

    model.pythonValid = false;
    await first.maintain({});
    assert.equal(first.integration().state, "action-required");
    assert.match(first.integration().error, /Python unavailable/);
    model.pythonValid = true;
    model.newer = true;
    const previousGenerate = calls.generate;
    await first.maintain({});
    assert.equal(first.integration().state, "action-required");
    assert.equal(calls.generate, previousGenerate, "An older Host never downgrades a shared newer runtime");
    assert(!fs.existsSync(path.join(root, "integration-upgrade.lock")));
    console.log("Background integration upgrade: no-dialog success, idempotence, concurrent Hosts, failure/retry, missing Python and downgrade protection passed");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
