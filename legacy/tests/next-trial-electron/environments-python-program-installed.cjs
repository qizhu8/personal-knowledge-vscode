"use strict";
const fs = require("node:fs"), path = require("node:path"), assert = require("node:assert/strict");
const vscode = require("vscode");
function workflow(context, label, hold = false) {
  const marker = path.join(context.root, `python-${label}-effects`);
  const value = { schema: "pkm.workflow.definition/v1", spec: { inputs: { value: { type: "string", required: true, nullable: false, schema: {} } }, outputs: {},
    nodes: [{ nodeId: "reviewed-python", kind: "pkm.step.script/v1", dependsOn: [], config: {
      runtime: "python", environmentId: "legacy-python", timeoutSeconds: 20, maxOutputBytes: 4096,
      args: ["{{ inputs.value }}", "--not-cli", "$(touch never-created)", "two words", "中文", ""],
      script: `import json,sys,time\nfrom pathlib import Path\np=Path(${JSON.stringify(marker)})\np.write_text(p.read_text()+'effect\\n' if p.exists() else 'effect\\n')\nprint(json.dumps({'args':sys.argv[1:],'prefix':sys.prefix}),flush=True)\n${hold ? "time.sleep(18)" : ""}` } }],
    completion: { requiredNodes: ["reviewed-python"] } } };
  const file = path.join(context.root, "workspace/reviewed-python-workflow.json");
  fs.writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
  return { file, marker, value, input: { value: `python-${label}` } };
}
function prepare(context, descriptor) {
  context.selectPython(); context.dialogs.push(descriptor.file); context.inputs.push(JSON.stringify(descriptor.input));
}
function result(context, label) {
  return context.rows().filter(row => row.provider === "python-script/v1"
    && row.jobs.some(job => job.stdout.includes(`python-${label}`))).at(-1);
}
exports.cases = async context => {
  const complete = workflow(context, "complete"), before = new Set(context.rows().map(row => row.runId)).size;
  context.deny(true); prepare(context, complete); await context.run(); context.deny(false);
  assert(!fs.existsSync(complete.marker)); assert.equal(new Set(context.rows().map(row => row.runId)).size, before);
  const originalWarning = vscode.window.showWarningMessage;
  vscode.window.showWarningMessage = async (message, options, button) => {
    if (message.includes("exact reviewed Python")) {
      assert(options.detail.includes("Source SHA-256:") && options.detail.includes("Executable digest:") && options.detail.includes("sys.argv"));
      fs.appendFileSync(complete.file, "\n");
    }
    return originalWarning(message, options, button);
  };
  try { prepare(context, complete); await context.run(); }
  finally { vscode.window.showWarningMessage = originalWarning; }
  assert.match(context.errors.pop(), /source changed/i); assert(!fs.existsSync(complete.marker));
  const prefix = path.join(context.root, "legacy-venv");
  fs.renameSync(prefix, `${prefix}-offline`);
  try { context.selectPython(); await context.run(); assert.match(context.errors.pop(), /ENOENT|changed|missing/); }
  finally { fs.renameSync(`${prefix}-offline`, prefix); }
  const approved = workflow(context, "complete");
  prepare(context, approved); await context.run();
  const done = result(context, "complete"); assert.equal(done?.state, "succeeded", JSON.stringify(context.errors));
  assert.deepEqual(JSON.parse(done.jobs[0].stdout), { prefix, args: ["python-complete", "--not-cli", "$(touch never-created)", "two words", "中文", ""] });
  assert.equal(fs.readFileSync(approved.marker, "utf8"), "effect\n");
  const cancellable = workflow(context, "cancel", true);
  prepare(context, cancellable); const pending = context.run();
  await context.wait(() => result(context, "cancel")?.jobs.some(job => job.state === "RUNNING"));
  context.cancellations.forEach(listener => listener()); await pending;
  const cancelled = result(context, "cancel"); assert.equal(cancelled.state, "cancelled"); assert.equal(cancelled.effect, "unknown");
  assert.equal(cancelled.jobs[0].state, "CANCELLED"); assert.equal(fs.readFileSync(cancellable.marker, "utf8"), "effect\n");
  assert.deepEqual(context.errors, []);
  return { completed: done, cancelled, declinedWithoutEffect: true, sourceDriftRejected: true,
    missingOriginalPathRefusedThenRestored: true, noEnvironmentPathReselection: true };
};
exports.crash = async context => {
  const descriptor = workflow(context, "crash", true);
  prepare(context, descriptor); const pending = context.run();
  await context.wait(() => result(context, "crash")?.jobs.some(job => job.state === "RUNNING"));
  const run = result(context, "crash"), child = context.children.at(-1), exited = new Promise(resolve => child.once("exit", resolve));
  child.kill("SIGKILL"); await exited; await pending;
  assert.match(context.errors.pop(), /Preserve the journal/); assert.deepEqual(context.errors, []);
  assert.equal(fs.readFileSync(descriptor.marker, "utf8"), "effect\n");
  return run;
};
exports.reopen = async context => {
  const crashMarker = path.join(context.root, "python-crash-effects");
  assert.equal(fs.readFileSync(crashMarker, "utf8"), "effect\n");
  const descriptor = workflow(context, "reopen"); prepare(context, descriptor); await context.run();
  const done = result(context, "reopen"); assert.equal(done?.state, "succeeded", JSON.stringify(context.errors));
  assert.equal(fs.readFileSync(crashMarker, "utf8"), "effect\n"); assert.equal(fs.readFileSync(descriptor.marker, "utf8"), "effect\n");
  return { completed: done, oldCrashEffectCount: 1, noReplay: true, freshExactSourceApproval: true };
};
