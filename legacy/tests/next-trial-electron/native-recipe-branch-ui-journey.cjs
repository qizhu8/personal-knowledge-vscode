"use strict";
const fs = require("node:fs"), path = require("node:path"), assert = require("node:assert/strict");
const { spawn } = require("node:child_process"), { once } = require("node:events");
const { createServer } = require("node:http");
exports.run = async context => {
  const { fixture, root, target, nonce, actorId, prepared, archive, descriptor, rootStat,
    env, processes, startCode, stopCode, python } = context;
  const manager = archive.chats.find(row => row.id === descriptor.workerManager);
  descriptor.recipePublicNode = process.execPath;
  descriptor.recipeLazyClient = path.join(__dirname, "native-recipe-lazy-client.cjs");
  descriptor.recipeBranchCaller = path.join(__dirname, "legacy-static-branch-fixture.cjs");
  fs.writeFileSync(path.join(fixture, "api-chat-fixture.json"), JSON.stringify(descriptor), { mode: 0o600 });
  let broker, modelCalls = 0;
  const provider = createServer((_request, response) => {
    modelCalls++; response.writeHead(500); response.end("An external branch report must never launch a model.");
  });
  await new Promise(resolve => provider.listen(0, "127.0.0.1", resolve));
  const grantFile = path.join(fixture, "u/User/globalStorage/uone.personal-knowledge/next-chat-ui-experiment.json");
  fs.mkdirSync(path.dirname(grantFile), { recursive: true, mode: 0o700 });
  async function start() {
    fs.writeFileSync(path.join(fixture, "native-managed-host.json"), JSON.stringify({
      root, nonce, workspaceId: prepared.workspaceId, actorId, sourceFingerprint: archive.sourceFingerprint,
      sourceSessionId: manager.metadata.sessionId, chat: { namespace: manager.namespace, chatId: manager.id },
      chatRecipe: true, recipeLibrary: true, recipePublic: true, recipeBranches: true,
      providerEndpoint: `http://127.0.0.1:${provider.address().port}/v1`,
    }), { mode: 0o600 });
    broker = spawn(process.execPath, [path.join(__dirname, "native-managed-chat-ui-host.cjs"), fixture, root, target, nonce],
      { cwd: fixture, env: { ...env, PKM_NATIVE_UI_PRIVATE_FIXTURE: nonce }, stdio: ["ignore", "inherit", "inherit", "ipc"] });
    processes.add(broker); broker.once("exit", () => processes.delete(broker));
    const ready = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error("Static-branch host startup timeout.")), 30000);
      broker.on("message", item => { if (item.type === "ready") { clearTimeout(timer); resolve(item); } });
      broker.once("error", reject);
      broker.once("exit", code => { clearTimeout(timer); reject(Error(`Static-branch host exited ${code}`)); });
    });
    fs.writeFileSync(grantFile, JSON.stringify({
      schema: "pkm.private-native-chat-ui/v1", kind: "synthetic-only", fixture, root,
      rootDevice: String(rootStat.dev), rootInode: String(rootStat.ino), nonce, workspaceId: prepared.workspaceId,
      actorId, sourceFingerprint: archive.sourceFingerprint, endpoint: ready.endpoint, bearer: ready.bearer,
    }), { mode: 0o600 });
    await startCode({ PKM_PRIVATE_NATIVE_CHAT_UI_GRANT: grantFile });
  }
  async function stop() {
    await stopCode();
    if (broker && broker.exitCode === null && broker.signalCode === null) {
      const exited = once(broker, "exit"); broker.kill("SIGTERM"); assert.deepEqual(await exited, [0, null]);
    }
    broker = undefined;
  }
  const effects = () => fs.readFileSync(path.join(fixture, "native-static-branch-effects.jsonl"), "utf8")
    .trim().split("\n").map(JSON.parse);
  try {
    await start(); await python("native-branch-start");
    const first = JSON.parse(fs.readFileSync(path.join(fixture, "native-branch-ui-state.json")));
    assert(first.originalRuntimeFiveScenarioParity && first.selectedCasePersistedBeforeKill);
    const before = effects();
    assert.equal(before.length, 9);
    const exited = once(broker, "exit"); broker.kill("SIGKILL"); assert.deepEqual(await exited, [null, "SIGKILL"]);
    await stop(); await start(); await python("native-branch-reopen");
    const final = JSON.parse(fs.readFileSync(path.join(fixture, "native-branch-ui-state.json")));
    assert(final.fullRestartUnknownNeverReplayedOrSwitched);
    assert.deepEqual(effects(), before); assert.equal(modelCalls, 0);
    assert(!fs.existsSync(path.join(root, "recipes")));
    fs.writeFileSync(path.join(fixture, "native-recipe-branch-installed-evidence.json"), JSON.stringify({
      kind: "actual-installed-same-root-original-authored-static-branch", root,
      rootDevice: String(rootStat.dev), rootInode: String(rootStat.ino), installedExtension: target,
      workspaceId: prepared.workspaceId, sourceFingerprint: archive.sourceFingerprint,
      originalRecipe: descriptor.recipeBranches, ui: final, effects: before, modelCalls,
      outputAuthority: "external-caller-reported", automaticAgentExecution: false,
      actualBrokerSIGKILL: true, noFilesystemLibraryProjection: true, noSqlGraphInjection: true,
      fullRecipeParity: false, migrationQualified: false, finalRootAndInstalledIdentityVerified: false,
    }), { mode: 0o600 });
    console.log("PASS installed original-authored static branch: real file validation/repair, selected-path join, cooperative cancellation, caller IO failure and SIGKILL UNKNOWN without replay or branch switching.");
  } finally { try { await stop(); } finally { await new Promise(resolve => provider.close(resolve)); } }
};
