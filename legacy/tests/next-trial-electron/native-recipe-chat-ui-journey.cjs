"use strict";
const fs = require("node:fs"), path = require("node:path"), assert = require("node:assert/strict");
const { spawn } = require("node:child_process"), { once } = require("node:events");
const { createServer } = require("node:http");
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

exports.run = async context => {
  const { fixture, root, target, nonce, actorId, prepared, archive, descriptor, rootStat,
    env, processes, startCode, stopCode, python } = context;
  const original = JSON.parse(fs.readFileSync(path.join(fixture, "original-recipe-evidence.json")));
  const manager = archive.chats.find(item => item.id === descriptor.workerManager);
  const identity = { namespace: manager.namespace, chatId: manager.id };
  let broker, grant, modelCalls = 0, brokerReadyAt;
  const held = [];
  const provider = createServer((_request, response) => {
    modelCalls++; response.writeHead(500); response.end("Recipe controls must not invoke a model.");
  });
  await new Promise(resolve => provider.listen(0, "127.0.0.1", resolve));
  const grantFile = path.join(fixture, "u/User/globalStorage/uone.personal-knowledge/next-chat-ui-experiment.json");
  fs.mkdirSync(path.dirname(grantFile), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(fixture, "native-managed-host.json"), JSON.stringify({
    root, nonce, workspaceId: prepared.workspaceId, actorId, sourceFingerprint: archive.sourceFingerprint,
    sourceSessionId: manager.metadata.sessionId, chat: identity, chatRecipe: true,
    providerEndpoint: `http://127.0.0.1:${provider.address().port}/v1`,
  }), { mode: 0o600 });
  const rpc = async () => {
    const response = await fetch(`${grant.endpoint}/rpc`, { method: "POST",
      headers: { authorization: `Bearer ${grant.bearer}`, "x-pkm-native-actor": actorId, "content-type": "application/json" },
      body: JSON.stringify({ method: "recipe-state", ...identity }) });
    const data = await response.json(); assert.equal(response.status, 200, JSON.stringify(data)); return data.value;
  };
  async function start() {
    broker = spawn(process.execPath, [path.join(__dirname, "native-managed-chat-ui-host.cjs"), fixture, root, target, nonce],
      { cwd: fixture, env: { ...env, PKM_NATIVE_UI_PRIVATE_FIXTURE: nonce }, stdio: ["ignore", "inherit", "inherit", "ipc"] });
    processes.add(broker); broker.once("exit", () => processes.delete(broker));
    const ready = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error("Recipe broker startup timed out.")), 30000);
      broker.on("message", item => {
        if (item.type === "actual-recipe-held") held.push(item);
        if (item.type === "ready") { clearTimeout(timer); brokerReadyAt = Date.now(); resolve(item); }
      });
      broker.once("error", reject);
      broker.once("exit", code => { clearTimeout(timer); reject(Error(`Recipe broker exited ${code}`)); });
    });
    grant = { schema: "pkm.private-native-chat-ui/v1", kind: "synthetic-only", fixture, root,
      rootDevice: String(rootStat.dev), rootInode: String(rootStat.ino), nonce, workspaceId: prepared.workspaceId,
      actorId, sourceFingerprint: archive.sourceFingerprint, endpoint: ready.endpoint, bearer: ready.bearer };
    fs.writeFileSync(grantFile, JSON.stringify(grant), { mode: 0o600 });
    const state = await rpc();
    assert.equal(state.recipes.length, 17);
    assert.deepEqual(state.recipes.filter(item => item.available).map(item => item.recipeId), [original.recipeId]);
    assert.equal(state.originalRuns.find(item => item.runId === original.unknownRunId).state, "unknown");
    assert.equal(state.originalRuns.find(item => item.runId === original.completedRunId).name, original.recipe.name);
    assert(!fs.existsSync(path.join(root, "recipes")), "Never project a fake filesystem library.");
    await startCode({ PKM_PRIVATE_NATIVE_CHAT_UI_GRANT: grantFile });
  }
  async function stop(signal = "SIGTERM") {
    await stopCode();
    if (broker && broker.exitCode === null && broker.signalCode === null) {
      const exited = once(broker, "exit"); broker.kill(signal);
      const result = await exited; if (signal === "SIGTERM") assert.deepEqual(result, [0, null]);
    }
    broker = undefined;
  }
  const effects = () => {
    const file = path.join(fixture, "native-recipe-effects.jsonl");
    return fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map(row => JSON.parse(row)) : [];
  };
  const waitHeld = async mode => {
    const deadline = Date.now() + 15000;
    while (!held.some(item => item.mode === mode) && Date.now() < deadline) await sleep(50);
    const found = held.find(item => item.mode === mode); assert(found); return found;
  };
  try {
    await start(); await python("native-recipe-start");
    let state = await rpc();
    assert.equal(state.runs.length, 2);
    const completedRuns = state.runs.filter(run => run.state === "succeeded");
    assert.equal(completedRuns.length, 1);
    const completeId = completedRuns[0].runId;
    assert.deepEqual(effects().map(row => row.runId), [completeId]);
    const cancelled = await waitHeld("cancel"); state = await rpc();
    const cancelledRun = state.runs.find(item => item.runId === cancelled.runId);
    assert.equal(cancelledRun.state, "cancelled");
    assert.equal(cancelledRun.nodes.find(item => item.nodeId === "record").effect, "unknown");
    assert.equal(effects().length, 1);
    await stop(); await start();
    assert.equal((await rpc()).runs.length, 2); assert.equal(effects().length, 1);
    await python("native-recipe-reopen-crash");
    const crashed = await waitHeld("crash");
    assert.deepEqual(effects().map(row => row.runId).sort(), [completeId, crashed.runId].sort());
    await stop("SIGKILL"); await start();
    assert(brokerReadyAt < crashed.leaseExpiresAt, "The real restart must fence before the old lease expires.");
    state = await rpc();
    assert.equal(state.runs.find(item => item.runId === crashed.runId).state, "unknown");
    assert.equal(state.runs.find(item => item.runId === crashed.runId).nodes.find(item => item.nodeId === "record").effect, "unknown");
    await python("native-recipe-unknown-reopen");
    assert.equal(effects().length, 2);
    await stop(); await start(); await python("native-recipe-final-reopen");
    assert.equal((await rpc()).runs.length, 3); assert.equal(effects().length, 2); assert.equal(modelCalls, 0);
    const evidence = { kind: "actual-installed-same-root-recipe-controls",
      root, rootDevice: String(rootStat.dev), rootInode: String(rootStat.ino),
      workspaceId: prepared.workspaceId, sourceFingerprint: archive.sourceFingerprint,
      installedExtension: target, original, nativeRuns: (await rpc()).runs, effects: effects(),
      modelCalls, noFilesystemLibraryProjection: true, nativeRunControlsQualified: true,
      interruptedBeforeLeaseExpiry: true, legacyWorkbenchSave: JSON.parse(fs.readFileSync(path.join(fixture, "legacy-recipe-ui-evidence.json"))).save,
      libraryAuthoringQualified: false, fullRecipeParity: false, migrationQualified: false,
      finalRootAndInstalledIdentityVerified: false };
    fs.writeFileSync(path.join(fixture, "native-recipe-installed-evidence.json"), JSON.stringify(evidence), { mode: 0o600 });
    console.log("PASS actual installed same-root original Recipe inventory; fresh-human native run/cancel; full Code/broker restart; SIGKILL before lease expiry; UNKNOWN never replayed. Library authoring/full parity NOT qualified.");
  } finally {
    await stop();
    await new Promise(resolve => provider.close(resolve));
  }
};
