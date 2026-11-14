const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const { createHash, randomUUID } = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { pathToFileURL } = require("node:url");

const rootBuild = process.env.PKM_ENV_AUTHORITY_BUILD;
const nextBuild = process.env.PKM_ENV_NEXT_BUILD;
if (!rootBuild || !path.isAbsolute(rootBuild) || !nextBuild || !path.isAbsolute(nextBuild))
  throw new Error("Set absolute PKM_ENV_AUTHORITY_BUILD and PKM_ENV_NEXT_BUILD to isolated CJS/ESM builds.");
const { PythonEnvironmentAuthority } = require(path.join(rootBuild, "runtime/python-environment-authority.js"));
const { NextManagedClient } = require(path.join(rootBuild, "runtime/next-managed-client.js"));
const registry = require(path.join(rootBuild, "servers/pyenvs.js"));
const { stage } = require("../scripts/next-rehearsal-runtime.js");

function fixture(t) {
  const root = path.join(fs.realpathSync(process.cwd()), "tests", `.python-workflow-${randomUUID()}`);
  fs.mkdirSync(root, { mode: 0o700 });
  const clients = [];
  t.after(async () => { for (const client of clients) await client.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const python = fs.realpathSync("/usr/bin/python3"), stat = fs.statSync(python);
  assert.equal(stat.uid, 0); assert.equal(stat.mode & 0o022, 0);
  const envRoot = path.join(root, "venv");
  execFileSync(python, ["-m", "venv", "--without-pip", envRoot], { cwd: root, env: {} });
  registry.initPyenvs(path.join(root, "registry"));
  const env = registry.pyenvAdd({ name: "Synthetic Python", manager: "venv", path: envRoot, python: path.join(envRoot, "bin/python") });
  const authority = new PythonEnvironmentAuthority(() => true);
  return { root, envRoot, env, authority, clients };
}

test("native injected environment adapter really schedules Python through Workflow and Runtime; errors are visible", async t => {
  const f = fixture(t);
  const { runHostPythonWorkflow, verifyHostPythonHandle } = await import(pathToFileURL(path.join(nextBuild, "host-python-workflow.js")));
  const workspaceId = randomUUID(), actorId = "local:owner", handle = f.authority.select(workspaceId, actorId, f.env.id);
  let approvals = 0;
  const options = { handle, workspaceId, actorId, workspaceRoot: f.root, script: "print(7)",
    signal: new AbortController().signal, approve: async () => { approvals++; return true; } };
  const result = await runHostPythonWorkflow(options);
  assert.equal(result.state, "succeeded"); assert.equal(result.stdout, "7\n"); assert.equal(result.exitCode, 0);
  assert.equal(approvals, 1);
  assert(!JSON.stringify(result).includes(f.envRoot));
  assert.throws(() => verifyHostPythonHandle(handle, randomUUID(), actorId), /workspace\/actor/);
  assert.throws(() => verifyHostPythonHandle(handle, workspaceId, "other"), /workspace\/actor/);
  for (const patch of [
    { root: f.root }, { executable: handle.target }, { target: "/usr/bin/false" },
    { entryPin: { ...handle.entryPin, ino: "0" } }, { rootPin: { ...handle.rootPin, ino: "0" } },
  ]) assert.throws(() => verifyHostPythonHandle({ ...handle, ...patch }, workspaceId, actorId));
  const failure = await runHostPythonWorkflow({ ...options, script: "raise SystemExit(4)" });
  assert.equal(failure.state, "failed"); assert.equal(failure.exitCode, 4);
  assert.match(failure.error, /FAILED.*exit 4/);
  await assert.rejects(runHostPythonWorkflow({ ...options, approve: async () => false }), /approval denied/);
  let stale = false;
  await assert.rejects(runHostPythonWorkflow({ ...options, handle: { ...handle, rootPin: { ...handle.rootPin, ino: "0" } },
    approve: async () => { stale = true; return true; } }));
  assert.equal(stale, false);
});

test("production registered picker + modal + private IPC runs fixed print(7); no path grant survives restart/copy", { timeout: 120000 }, async t => {
  const f = fixture(t), extensionRoot = path.join(f.root, "extension");
  fs.mkdirSync(extensionRoot, { mode: 0o700 });
  fs.copyFileSync(path.resolve("package.json"), path.join(extensionRoot, "package.json"));
  stage(path.join(extensionRoot, "next-runtime"), { production: true });
  const makeDir = name => { const dir = path.join(f.root, name); fs.mkdirSync(dir, { mode: 0o700 }); return dir; };
  const legacy = makeDir("unused-legacy"), trial = makeDir("trial"), client = new NextManagedClient();
  const clients = f.clients; clients.push(client);
  const workspaceId = await client.start(extensionRoot, trial, fs.realpathSync(process.execPath), legacy);
  let trusted = true, selected = true, confirmed = true, picked = 0, modals = 0;
  const commands = new Map(), messages = [], errors = [], sent = [];
  const originalSend = client.child.send.bind(client.child);
  client.child.send = (message, ...args) => { sent.push(message); return originalSend(message, ...args); };
  const vscode = {
    workspace: { get isTrusted() { return trusted; }, workspaceFolders: [{ uri: { toString: () => "file:///synthetic-workspace" } }] },
    commands: { registerCommand(name, callback) { commands.set(name, callback); return { dispose() {} }; } },
    window: {
      async showQuickPick(items) {
        picked++; assert.equal(items.length, 1); assert.equal(items[0].environmentId, f.env.id);
        return selected ? items[0] : undefined;
      },
      async showWarningMessage(text, options, action) {
        modals++; assert.equal(options.modal, true);
        assert.match(options.detail, /Script: print\(7\)/); assert(options.detail.includes(workspaceId));
        assert(options.detail.includes(f.env.python)); return confirmed ? action : undefined;
      },
      async showInformationMessage(message) { messages.push(message); },
      async showErrorMessage(message) { errors.push(message); },
    },
  };
  const originalLoad = Module._load;
  let register;
  try {
    Module._load = function(name, parent, main) { return name === "vscode" ? vscode : originalLoad.call(this, name, parent, main); };
    ({ registerNextPythonEnvironment: register } = require(path.join(rootBuild, "ui/next-python-environment.js")));
  } finally { Module._load = originalLoad; }
  register({ subscriptions: [] }, () => client);
  const run = commands.get("personalKnowledge.nextTrialPython");
  trusted = false; await run(); assert.equal(picked, 0); assert.equal(sent.length, 0);
  trusted = true; selected = false; await run(); assert.equal(sent.length, 0);
  selected = true; confirmed = false; await run(); assert.equal(sent.length, 0);
  confirmed = true; await run();
  assert.equal(errors.length, 1, errors.join("\n")); assert.match(messages[0], /succeeded: 7/);
  assert.equal(sent.filter(m => m.type === "python-trial").length, 1);
  assert.equal(sent.filter(m => m.type === "python-trial-revalidated" && m.approved).length, 1);
  const originalRun = client.runPythonTrial.bind(client);
  client.runPythonTrial = async () => ({ state: "failed", error: "Python process FAILED: exit; exit 4.",
    runId: `python-${randomUUID()}`, exitCode: 4 });
  await run();
  assert.equal(messages.length, 1, "Failed Runtime result is not announced as success.");
  assert.match(errors[1], /Python process FAILED.*exit 4/);
  client.runPythonTrial = originalRun;
  const handle = f.authority.select(workspaceId, "local:owner", f.env.id);
  client.child.send = (message, ...args) => originalSend(message.type === "python-trial"
    ? { ...message, handle: { ...message.handle, environmentId: "forged-environment" } } : message, ...args);
  await assert.rejects(client.runPythonTrial(f.authority, handle), /rejected before admission/);
  client.child.send = (message, ...args) => originalSend(message, ...args);
  const validate = f.authority.validate.bind(f.authority);
  let validations = 0;
  f.authority.validate = (...args) => {
    validations++;
    if (validations > 1) throw new Error("Synthetic host trust revoked before child admission.");
    return validate(...args);
  };
  await assert.rejects(client.runPythonTrial(f.authority, handle), /rejected before admission/);
  f.authority.validate = validate;
  assert.equal(validations, 2, "Host authority is checked again by private child challenge, not just before sending.");
  await assert.rejects(client.request({ type: "python-trial", approvalId: randomUUID(), handle }), /rejected before admission/);
  await assert.rejects(client.request({ type: "python-trial", approvalId: randomUUID(), handle, script: "print(8)" }), /rejected before admission/);
  for (const patch of [{ workspaceId: randomUUID() }, { actorId: "other-actor" }, { rootPin: { ...handle.rootPin, ino: "0" } }])
    await assert.rejects(client.request({ type: "python-trial", approvalId: randomUUID(), handle: { ...handle, ...patch } }), /rejected before admission/);
  const scan = directory => fs.readdirSync(directory).flatMap(name => {
    const file = path.join(directory, name);
    return fs.statSync(file).isDirectory() ? scan(file) : [fs.readFileSync(file)];
  });
  for (const bytes of scan(path.join(trial, "workspace"))) assert(!bytes.includes(Buffer.from(f.envRoot)), "environment paths must not enter workspace/backup inputs");
  const { Storage } = await import(pathToFileURL(path.join(nextBuild, "storage.js")));
  const { createWorkspaceBackup, restoreWorkspaceBackup } = await import(pathToFileURL(path.join(nextBuild, "workspace-backup.js")));
  await client.close();
  const storage = await Storage.open(path.join(trial, "workspace"));
  const backupPath = path.join(f.root, "backup"), restored = path.join(f.root, "restored");
  try {
    await createWorkspaceBackup(storage, backupPath, {
      async acquireQuiescence() { return { assertHeld() {}, release() {} }; },
    }, { pythonExecutable: f.env.python });
  } finally { await storage.close(); }
  await restoreWorkspaceBackup(backupPath, restored, { pythonExecutable: f.env.python, nativeRestoreAuthority: {
    actorId: "local:owner",
    async authorize(request) {
      return { authorityId: "synthetic-restore", actorId: request.actorId,
        requestSha256: createHash("sha256").update(JSON.stringify(request)).digest("hex"),
        expiresAt: Date.now() + 60_000, lineage: "unrelated", trustedEpoch: null };
    },
  } });
  for (const directory of [backupPath, restored])
    for (const bytes of scan(directory)) assert(!bytes.includes(Buffer.from(f.envRoot)));
  const restartedAuthority = new PythonEnvironmentAuthority(() => true);
  assert.throws(() => restartedAuthority.validate(structuredClone(handle), workspaceId, "local:owner"), /unavailable/);
  const restoredClient = new NextManagedClient(); clients.push(restoredClient);
  await assert.rejects(restoredClient.start(extensionRoot, restored, fs.realpathSync(process.execPath), legacy), /empty/);
  assert.throws(() => restoredClient.pythonWorkspaceId(), /fresh isolated/);
  const fresh = new NextManagedClient(); clients.push(fresh);
  const freshId = await fresh.start(extensionRoot, makeDir("fresh-trial"), fs.realpathSync(process.execPath), legacy);
  assert.notEqual(freshId, workspaceId);
  await assert.rejects(fresh.runPythonTrial(f.authority, handle), /workspace or actor/);
  await assert.rejects(fresh.request({ type: "python-trial", approvalId: randomUUID(), handle }), /rejected before admission/);
  const remapped = restartedAuthority.select(freshId, "local:owner", f.env.id);
  assert.equal((await fresh.runPythonTrial(restartedAuthority, remapped)).stdout, "7\n");
  assert.equal(modals, 3);
});
