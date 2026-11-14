"use strict";
const fs = require("node:fs"), path = require("node:path"), assert = require("node:assert/strict");
const vscode = require("vscode");
const { LocalEnvironmentCatalog } = require("./dist/runtime/local-environment-catalog.js");
const store = context => new LocalEnvironmentCatalog(path.join(context.root, "u/User/globalStorage/uone.personal-knowledge/next-local-environments"));
const result = (context, label) => context.rows().filter(row => row.provider === "node-project/v1"
  && row.jobs.some(job => job.stdout.includes(label))).at(-1);
function prepare(context, project, label, hold = false) {
  context.selectProject(project.id); context.dialogs.push(project.entry);
  context.inputs.push(JSON.stringify([label, ...(hold ? ["hold"] : []), "--not-cli", "$(touch never-created)", "two words", "中文", ""]));
}
exports.cases = async context => {
  const lifecycle = await require("./environments-lifecycle-installed.cjs").cases(context);
  const root = path.join(context.root, "workspace/node-project"); fs.mkdirSync(root, { mode: 0o700 });
  fs.writeFileSync(path.join(root, "package.json"), '{"name":"installed-node-project","type":"commonjs","main":"index.cjs","scripts":{"start":"never-run","preinstall":"never-run"}}');
  fs.writeFileSync(path.join(root, "helper.cjs"), 'module.exports="actual-local-dependency";');
  const entry = path.join(root, "index.cjs");
  const source = `const fs=require("node:fs"),args=process.argv.slice(2);
fs.appendFileSync("effects.jsonl",JSON.stringify({value:args[0]})+"\\n");
console.log(JSON.stringify({args,cwd:process.cwd(),entry:__filename,helper:require("./helper.cjs"),main:require.main===module}));
if(args.includes("hold")){process.stdout.on("error",()=>process.exit(1));setInterval(()=>process.stdout.write("alive\\n"),100);}`;
  fs.writeFileSync(entry, source);
  context.selectManagement("Register Node.js project environment"); context.dialogs.push(root); await context.manage();
  assert.deepEqual(context.errors, []);
  const registered = store(context).read().catalog.entries.find(item => item.manager === "node-project" && item.root === root);
  assert(registered);
  const project = { id: registered.id, root, entry };
  const before = new Set(context.rows().map(row => row.runId)).size;
  context.deny(true); prepare(context, project, "installed-project-declined"); await context.run(); context.deny(false);
  assert.equal(new Set(context.rows().map(row => row.runId)).size, before); assert(!fs.existsSync(path.join(root, "effects.jsonl")));
  const originalWarning = vscode.window.showWarningMessage;
  vscode.window.showWarningMessage = async (message, options, button) => {
    if (message.includes("explicitly reviewed Node project")) {
      assert(options.detail.includes(source) && options.detail.includes("Source SHA-256:") && options.detail.includes(root));
      fs.appendFileSync(entry, "\n// changed while approval is open");
    }
    return originalWarning(message, options, button);
  };
  try { prepare(context, project, "installed-project-drift"); await context.run(); }
  finally { vscode.window.showWarningMessage = originalWarning; fs.writeFileSync(entry, source); }
  assert.match(context.errors.pop(), /changed/); assert(!fs.existsSync(path.join(root, "effects.jsonl")));
  fs.renameSync(entry, `${entry}-unavailable`);
  try {
    context.selectProject(project.id); context.dialogs.push(entry); await context.run();
    assert.match(context.errors.pop(), /ENOENT|missing/);
  } finally { fs.renameSync(`${entry}-unavailable`, entry); }
  prepare(context, project, "installed-project-complete"); await context.run();
  const complete = result(context, "installed-project-complete"); assert.equal(complete?.state, "succeeded", JSON.stringify(context.errors));
  assert.deepEqual(JSON.parse(complete.jobs[0].stdout), { args: ["installed-project-complete", "--not-cli", "$(touch never-created)", "two words", "中文", ""],
    cwd: root, entry, helper: "actual-local-dependency", main: true });
  assert(!fs.existsSync(path.join(root, "never-created")));
  const additional = [];
  for (const name of ["esm.mjs", "typed.mts"]) {
    const file = path.join(root, name), ts = name.endsWith(".mts");
    fs.writeFileSync(file, `import fs from "node:fs";import helper from "./helper.cjs";
${ts ? 'const kind: string="existing-node-typescript";' : 'const kind="esm";'}
await Promise.resolve();if(import.meta.main)console.log(JSON.stringify({args:process.argv.slice(2),url:import.meta.url,main:import.meta.main,cwd:process.cwd(),helper,kind}));`);
    context.selectProject(project.id); context.dialogs.push(file); context.inputs.push(JSON.stringify([name, "--literal", "two words", ""]));
    await context.run();
    const run = result(context, name); assert.equal(run?.state, "succeeded", JSON.stringify(context.errors));
    assert.equal(JSON.parse(run.jobs[0].stdout).url, require("node:url").pathToFileURL(file).href);
    assert.equal(JSON.parse(run.jobs[0].stdout).helper, "actual-local-dependency");
    assert.equal(JSON.parse(run.jobs[0].stdout).main, true);
    additional.push({ entry: name, provider: run.provider, state: run.state, runId: run.runId });
  }
  prepare(context, project, "installed-project-cancel", true); const pending = context.run();
  await context.wait(() => result(context, "installed-project-cancel")?.jobs.some(job => job.state === "RUNNING"));
  context.cancellations.forEach(listener => listener()); await pending;
  const cancelled = result(context, "installed-project-cancel"); assert.equal(cancelled.state, "cancelled");
  assert.equal(cancelled.effect, "unknown"); assert.equal(cancelled.jobs[0].state, "CANCELLED");
  let csharp = { available: false };
  if (fs.existsSync("/usr/bin/dotnet")) {
    context.selectManagement("Discover local C# executor sets", "csharp"); context.dialogs.push("/usr/bin");
    context.inputs.push("Discovered named C# tools"); await context.manage(); assert.deepEqual(context.errors, []);
    const discovered = store(context).read().catalog.entries.find(item => item.name === "Discovered named C# tools");
    assert(discovered.executors.some(item => item.id === "dotnet")); assert.equal(discovered.root, undefined);
    context.selectManagement("Reconfigure registered runtime or executor set", "csharp", discovered.id);
    context.inputs.push("Configured named C# tools", JSON.stringify(discovered.executors)); await context.manage();
    const configured = store(context).read().catalog.entries.find(item => item.id === discovered.id);
    assert.equal(configured.name, "Configured named C# tools"); assert.equal(configured.kind, "executor-set"); assert.equal(configured.root, undefined);
    csharp = await context.execute("csharp", ["installed-csharp-new-cancel"], 20000, true);
    assert.equal(csharp.state, "cancelled"); assert.equal(csharp.jobs[0].state, "SUCCEEDED");
    assert.equal(csharp.jobs[1].state, "CANCELLED"); assert.equal(csharp.effect, "unknown");
  }
  assert.deepEqual(context.errors, []);
  return { ...project, completed: complete, cancelled, csharp, lifecycle, esmAndExistingTypeScript: additional,
    declinedWithoutRun: true, sourceDriftRejected: true,
    missingEntryRejected: true, scriptedNativeDialogDecisions: true, interactivePlaywrightQualification: false };
};
exports.crash = async (context, project) => {
  prepare(context, project, "installed-project-crash", true); const pending = context.run();
  await context.wait(() => result(context, "installed-project-crash")?.jobs.some(job => job.state === "RUNNING"));
  const run = result(context, "installed-project-crash"), child = context.children.at(-1);
  const exited = new Promise(resolve => child.once("exit", resolve)); child.kill("SIGKILL"); await exited; await pending;
  assert.match(context.errors.pop(), /Preserve the journal/); return run;
};
exports.reopen = async (context, project) => {
  const effects = () => fs.readFileSync(path.join(project.root, "effects.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(effects().filter(row => row.value === "installed-project-crash").length, 1);
  prepare(context, project, "installed-project-fresh"); await context.run();
  const complete = result(context, "installed-project-fresh"); assert.equal(complete?.state, "succeeded", JSON.stringify(context.errors));
  assert.deepEqual(effects(), ["complete", "cancel", "crash", "fresh"].map(tag => ({ value: `installed-project-${tag}` })));
  return { completed: complete, effects: effects(), noReplay: true, freshExactEntryApproval: true };
};
