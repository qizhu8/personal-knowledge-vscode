"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), cp = require("node:child_process");
const vscode = require("vscode");
exports.run = async () => {
  const root = process.env.PKM_ENV_INSTALLED_ROOT, phase = process.env.PKM_ENV_INSTALLED_PHASE;
  const extension = vscode.extensions.getExtension("Uone.personal-knowledge"); await extension.activate();
  const restore = [], errors = [], infos = [], dialogs = [], inputs = [], traffic = [], children = [], cancellations = [], filePicks = [];
  let action, language = "javascript", environmentId, deny = false, missingPythonRefused = false;
  function replace(object, key, value) { const original = object[key]; object[key] = value; restore.push(() => { object[key] = original; }); return original; }
  const fork = cp.fork;
  replace(cp, "fork", function (file, ...args) {
    const child = fork.call(this, file, ...args);
    if (String(file).endsWith("/managed-client-child.js")) { children.push(child); child.on("message", item => traffic.push(item)); }
    return child;
  });
  replace(vscode.window, "showErrorMessage", async message => { errors.push(message); });
  replace(vscode.window, "showInformationMessage", async message => { infos.push(message); });
  replace(vscode.window, "showInputBox", async () => inputs.shift());
  replace(vscode.window, "showOpenDialog", async () => {
    const file = dialogs.shift(); assert(file, "Unexpected path picker"); filePicks.push(file); return [vscode.Uri.file(file)];
  });
  replace(vscode.window, "showQuickPick", async (items, options) => {
    if (typeof items[0] === "string" && (items.includes("Run registered Node.js controlled program")
      || items.includes("Import legacy profile registry"))) return action;
    if (items[0]?.entry) return items.find(item => item.entry.language === language && (!environmentId || item.entry.id === environmentId));
    if (items[0]?.executor) return options?.canPickMany ? items : items[0];
    if (typeof items[0] === "string" && /^[a-f0-9-]{36}$/.test(items[0])) return items[0];
    return undefined;
  });
  replace(vscode.window, "showWarningMessage", async (message, options, button) => {
    if (!/Create a disposable PKM Next trial|environment catalog|registered native controlled|private environment run journal|fixed Python Workflow|exact reviewed Python Workflow|explicitly reviewed Node project entry|reviewed Python source|permanent deletion script|Copy and rebind this Python|synthetic prefix to recoverable|quarantined Python folder/.test(message)) return undefined;
    assert(options.modal);
    return deny ? undefined : button;
  });
  replace(vscode.window, "withProgress", async (_options, callback) => callback({ report() {} }, {
    isCancellationRequested: false, onCancellationRequested(listener) {
      cancellations.push(listener); return { dispose() { const index = cancellations.indexOf(listener); if (index >= 0) cancellations.splice(index, 1); } };
    },
  }));
  const manage = () => vscode.commands.executeCommand("personalKnowledge.nextTrialEnvironments");
  const run = () => vscode.commands.executeCommand("personalKnowledge.nextTrialRuntime");
  const rows = () => traffic.flatMap(item => Array.isArray(item.result) ? item.result.filter(row => /^environment-/.test(row.runId)) : []);
  const latest = id => rows().filter(row => row.runId === id).at(-1);
  const wait = async predicate => {
    const deadline = Date.now() + 20000;
    while (!predicate()) { if (Date.now() >= deadline) assert.fail(JSON.stringify({ errors, infos, traffic: traffic.slice(-4) })); await new Promise(resolve => setTimeout(resolve, 50)); }
  };
  const execute = async (target, args, waitMs = 0, cancellation = false) => {
    action = target === "javascript" ? "Run registered Node.js controlled program" : "Run registered C# controlled program";
    language = target; inputs.push(JSON.stringify(args), String(waitMs));
    const promise = run();
    if (cancellation) {
      await wait(() => rows().some(row => row.jobs.some(job => job.state === "RUNNING" && job.stdout.includes(args[0]))));
      assert(cancellations.length); cancellations.forEach(listener => listener());
    }
    await promise;
    const result = rows().filter(row => row.jobs.some(job => job.stdout.includes(args[0]))).at(-1);
    assert(result, JSON.stringify({ errors, infos }));
    return result;
  };
  const pythonEnabled = process.env.PKM_ENV_INSTALLED_PYTHON_PROGRAM === "1";
  const pythonHelper = pythonEnabled ? require("./environments-python-program-installed.cjs") : undefined;
  const pythonContext = { root, inputs, dialogs, rows, errors, cancellations, children, run, wait,
    selectPython() { action = "Run reviewed Python Workflow"; language = "python"; environmentId = "legacy-python"; },
    deny(value) { deny = value; } };
  const nodeProjectEnabled = process.env.PKM_ENV_INSTALLED_NODE_PROJECT === "1";
  const nodeHelper = nodeProjectEnabled ? require("./environments-node-project-installed.cjs") : undefined;
  const nodeContext = { ...pythonContext, manage, execute,
    selectProject(id) { action = "Run registered Node.js project entry (CommonJS)"; language = "javascript"; environmentId = id; },
    selectManagement(value, target = "javascript", id) { action = value; language = target; environmentId = id; },
  };
  try {
    const trial = path.join(root, `execution-${phase}-trial`); fs.mkdirSync(trial, { mode: 0o700 });
    dialogs.push(trial, process.env.PKM_ENV_INSTALLED_NODE);
    await vscode.commands.executeCommand("personalKnowledge.nextTrialStart");
    assert.deepEqual(errors, []);
    // Imported old Python still dispatches through the original fixed diagnostic.
    action = "Run registered Python Workflow diagnostic"; language = "python"; await manage();
    assert(infos.some(message => /Python Workflow succeeded: 7/.test(message)));
    if (process.env.PKM_ENV_INSTALLED_AUTO_UPGRADE === "1") {
      const count = infos.length;
      environmentId = "missing-python"; await manage(); environmentId = undefined;
      assert.match(errors.pop(), /ENOENT|missing|repair/);
      assert.equal(infos.length, count, "Missing Python must never receive a successful Workflow receipt.");
      missingPythonRefused = true;
    }
    if (phase === "reopen") {
      const previous = JSON.parse(fs.readFileSync(path.join(root, "execution-initial-result.json")));
      action = "Inspect or cancel environment runs"; await run();
      assert.match(errors.pop(), /explicitly choose recovery/);
      action = "Recover interrupted environment history (no replay)"; await run();
      assert.deepEqual(errors, []);
      const recovered = latest(previous.crashRunId);
      assert.equal(recovered.state, "unknown"); assert.equal(recovered.effect, "unknown");
      assert.equal(recovered.jobs.length, 1); assert.equal(recovered.jobs[0].state, "INTERRUPTED");
      const count = new Set(rows().map(row => row.runId)).size;
      action = "Inspect or cancel environment runs"; await run();
      assert.equal(new Set(rows().map(row => row.runId)).size, count);
      const pythonProgram = pythonEnabled ? await pythonHelper.reopen(pythonContext) : undefined;
      const nodeProject = nodeProjectEnabled ? await nodeHelper.reopen(nodeContext, previous.nodeProject) : undefined;
      environmentId = undefined;
      const fresh = await execute("javascript", ["explicit-after-restart", "--import=still-data", "中文"]);
      assert.equal(fresh.state, "succeeded", JSON.stringify(fresh));
      assert.equal(latest(previous.crashRunId).jobs.length, 1);
      fs.writeFileSync(path.join(root, "execution-reopened-result.json"), JSON.stringify({
        recovered, fresh, pythonRegressionPassed: true, automaticReplay: false, filePicks, missingPythonRefused,
        ...(pythonProgram ? { pythonProgram } : {}),
        ...(nodeProject ? { nodeProject } : {}),
      }, null, 2));
      await vscode.commands.executeCommand("personalKnowledge.nextTrialClose");
      console.log("PASS installed execution restart: explicit expired-owner recovery UNKNOWN, no replay, fresh Node re-selection, old Python preserved.");
      return;
    }
    action = "Register local Node.js runtime"; dialogs.push(process.env.PKM_ENV_INSTALLED_NODE); inputs.push("Workflow Node"); await manage();
    if (fs.existsSync("/usr/bin/dotnet")) {
      action = "Register local C# executor set"; dialogs.push("/usr/bin/dotnet"); inputs.push("Offline C# executors"); await manage();
    }
    assert.deepEqual(errors, []);
    deny = true; action = "Run registered Node.js controlled program"; language = "javascript"; inputs.push('["denied"]', "0"); await run();
    assert.equal(rows().length, 0); deny = false;
    const nodeArgs = ["installed-node", "--import=not-a-flag", "$(touch never-created)", "two words", "中文", ""];
    const node = await execute("javascript", nodeArgs);
    assert.equal(node.state, "succeeded", JSON.stringify(node));
    assert.deepEqual(JSON.parse(node.jobs[0].stdout.split("\n")[0]), { args: nodeArgs });
    const cancelled = await execute("javascript", ["installed-cancel"], 20000, true);
    assert.equal(cancelled.state, "cancelled"); assert.equal(cancelled.effect, "unknown");
    assert.equal(cancelled.jobs[0].state, "CANCELLED");
    let csharp = { available: false, message: "No installed dotnet executor; no download or installation requested." };
    if (fs.existsSync("/usr/bin/dotnet")) {
      csharp = await execute("csharp", ["installed-csharp", "--not-cli", "two words", "中文"]);
      assert.equal(csharp.state, "succeeded", JSON.stringify(csharp));
      assert.deepEqual(csharp.jobs.map(job => job.phase), ["compile", "run"]);
    }
    const pythonProgram = pythonEnabled ? await pythonHelper.cases(pythonContext) : undefined;
    const nodeProject = nodeProjectEnabled ? await nodeHelper.cases(nodeContext) : undefined;
    let crashed;
    if (nodeProjectEnabled) crashed = await nodeHelper.crash(nodeContext, nodeProject);
    else if (pythonEnabled) crashed = await pythonHelper.crash(pythonContext);
    else {
      action = "Run registered Node.js controlled program"; language = "javascript"; inputs.push('["installed-crash-once"]', "20000");
      const pending = run();
      await wait(() => rows().some(row => row.jobs.some(job => job.state === "RUNNING" && job.stdout.includes("installed-crash-once"))));
      crashed = rows().filter(row => row.jobs.some(job => job.stdout.includes("installed-crash-once"))).at(-1);
      const child = children.at(-1), exited = new Promise(resolve => child.once("exit", resolve));
      child.kill("SIGKILL"); await exited; await pending;
      assert(errors.pop()?.includes("Preserve the journal"));
    }
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(root, "execution-initial-result.json"), JSON.stringify({
      node, cancelled, csharp, crashRunId: crashed.runId, pythonRegressionPassed: true, deniedApprovalCreatedNoRun: true,
      filePicks, missingPythonRefused,
      ...(pythonProgram ? { pythonProgram } : {}),
      ...(nodeProject ? { nodeProject } : {}),
      crashBoundary: `real managed child SIGKILL after ${pythonEnabled ? "reviewed Next Python effect/stdout" : "controlled Node stdout"}; before owner expiry`,
    }, null, 2));
    console.log("PASS installed execution: registered Node exact argv, actual cancellation, offline C# compile/run, and real managed-child SIGKILL.");
  } finally { restore.reverse().forEach(fn => fn()); }
};
