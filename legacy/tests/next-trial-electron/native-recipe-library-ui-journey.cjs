"use strict";
const fs = require("node:fs"), path = require("node:path"), assert = require("node:assert/strict");
const { spawn } = require("node:child_process"), { once } = require("node:events");
const { createServer } = require("node:http");
exports.run = async context => {
  const { fixture, root, target, nonce, actorId, prepared, archive, descriptor, rootStat,
    env, processes, startCode, stopCode, python } = context;
  const manager = archive.chats.find(row => row.id === descriptor.workerManager);
  const expectedEffects = context.recipePublic ? 3 : 1;
  if (context.recipePublic) {
    descriptor.recipePublic = true; descriptor.recipePublicNode = process.execPath;
    fs.writeFileSync(path.join(fixture, "api-chat-fixture.json"), JSON.stringify(descriptor), { mode: 0o600 });
  }
  const identity = { namespace: manager.namespace, chatId: manager.id };
  let broker, grant, modelCalls = 0;
  const provider = createServer((_request, response) => {
    modelCalls++; response.writeHead(500); response.end("Library authoring must not invoke a model.");
  });
  await new Promise(resolve => provider.listen(0, "127.0.0.1", resolve));
  const grantFile = path.join(fixture, "u/User/globalStorage/uone.personal-knowledge/next-chat-ui-experiment.json");
  fs.mkdirSync(path.dirname(grantFile), { recursive: true, mode: 0o700 });
  const rpc = async input => {
    const response = await fetch(`${grant.endpoint}/rpc`, { method: "POST",
      headers: { authorization: `Bearer ${grant.bearer}`, "x-pkm-native-actor": actorId, "content-type": "application/json" },
      body: JSON.stringify(input) });
    const data = await response.json(); assert.equal(response.status, 200, JSON.stringify(data)); return data.value;
  };
  const state = () => rpc({ method: "recipe-state", ...identity });
  const editor = id => rpc({ method: "recipe-editor", input: { ...identity, recipeId: id } });
  async function start(crash = false) {
    fs.writeFileSync(path.join(fixture, "native-managed-host.json"), JSON.stringify({
      root, nonce, workspaceId: prepared.workspaceId, actorId, sourceFingerprint: archive.sourceFingerprint,
      sourceSessionId: manager.metadata.sessionId, chat: identity, chatRecipe: true, recipeLibrary: true,
      ...(context.recipePublic ? { recipePublic: true } : {}),
      ...(crash ? { recipeLibraryCrash: "after-commit" } : {}),
      providerEndpoint: `http://127.0.0.1:${provider.address().port}/v1`,
    }), { mode: 0o600 });
    broker = spawn(process.execPath, [path.join(__dirname, "native-managed-chat-ui-host.cjs"), fixture, root, target, nonce],
      { cwd: fixture, env: { ...env, PKM_NATIVE_UI_PRIVATE_FIXTURE: nonce }, stdio: ["ignore", "inherit", "inherit", "ipc"] });
    processes.add(broker); broker.once("exit", () => processes.delete(broker));
    const ready = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error("Library host startup timeout.")), 30000);
      broker.on("message", item => { if (item.type === "ready") { clearTimeout(timer); resolve(item); } });
      broker.once("error", reject);
      broker.once("exit", code => { clearTimeout(timer); reject(Error(`Library host exited ${code}`)); });
    });
    grant = { schema: "pkm.private-native-chat-ui/v1", kind: "synthetic-only", fixture, root,
      rootDevice: String(rootStat.dev), rootInode: String(rootStat.ino), nonce, workspaceId: prepared.workspaceId,
      actorId, sourceFingerprint: archive.sourceFingerprint, endpoint: ready.endpoint, bearer: ready.bearer };
    fs.writeFileSync(grantFile, JSON.stringify(grant), { mode: 0o600 });
    assert.equal((await state()).libraryEnabled, true);
    await startCode({ PKM_PRIVATE_NATIVE_CHAT_UI_GRANT: grantFile });
  }
  async function stop() {
    await stopCode();
    if (broker && broker.exitCode === null && broker.signalCode === null) {
      const exited = once(broker, "exit"); broker.kill("SIGTERM"); assert.deepEqual(await exited, [0, null]);
    }
    broker = undefined;
  }
  const ui = () => JSON.parse(fs.readFileSync(path.join(fixture, "native-library-ui-state.json")));
  const effects = () => fs.readFileSync(path.join(fixture, "native-recipe-effects.jsonl"), "utf8").trim().split("\n").map(row => JSON.parse(row));
  try {
    await start(); await python("native-library-author");
    const authored = ui(), record = (await editor(authored.recipeId)).recipe;
    assert.equal(record.revision, 3); assert.equal(record.description, "Native library conflict winner.");
    assert.equal(record.knowledgeId, authored.knowledgeId); assert.deepEqual(record.aliases, authored.aliases);
    assert.equal((await state()).recipes.length, 18);
    assert.equal((await state()).runs.length, expectedEffects);
    assert((await state()).runs.every(run => run.state === "succeeded"));
    assert.equal(effects().length, expectedEffects); assert(!fs.existsSync(path.join(root, "recipes")));
    await stop(); await start(true); await python("native-library-crash");
    const marker = JSON.parse(fs.readFileSync(path.join(fixture, "native-recipe-library-committed.json")));
    assert.equal(marker.point, "after-commit");
    await stop(); await start(); await python("native-library-recovered");
    const recovered = (await editor(authored.recipeId)).recipe;
    assert.equal(recovered.revision, 4); assert.equal(recovered.description, "Native library COMMIT before SIGKILL.");
    assert.equal(recovered.knowledgeId, record.knowledgeId); assert.deepEqual(recovered.aliases, record.aliases);
    assert.equal((await state()).runs.length, expectedEffects); assert.equal(effects().length, expectedEffects);
    await stop(); await start(); await python("native-library-final");
    assert.deepEqual((await editor(authored.recipeId)).recipe, recovered);
    assert.equal((await state()).runs.length, expectedEffects); assert.equal(effects().length, expectedEffects); assert.equal(modelCalls, 0);
    const evidence = { kind: "actual-installed-native-recipe-library", root,
      rootDevice: String(rootStat.dev), rootInode: String(rootStat.ino), installedExtension: target,
      workspaceId: prepared.workspaceId, sourceFingerprint: archive.sourceFingerprint,
      record: recovered, ui: authored, effects: effects(), modelCalls,
      libraryAuthoringQualified: true, noFilesystemLibraryProjection: true, invalidGraphAndConflictRejected: true,
      actualCommitThenSIGKILLRecovered: true, fullRecipeParity: false, migrationQualified: false,
      publicProtocolQualified: !!context.recipePublic,
      ...(context.recipePublic ? { oldMcpDiscovery: JSON.parse(fs.readFileSync(path.join(fixture, "legacy-recipe-public-discovery.json"))),
        publicProtocols: ["mcp", "http", "read-mcp", "read-http"].map(mode =>
          JSON.parse(fs.readFileSync(path.join(fixture, `native-recipe-public-${mode}-result.json`)))) } : {}),
      finalRootAndInstalledIdentityVerified: false };
    fs.writeFileSync(path.join(fixture, "native-recipe-installed-evidence.json"), JSON.stringify(evidence), { mode: 0o600 });
    console.log(`PASS actual installed same-root native Recipe LIBRARY create/save/update/reopen/invalid graph/CAS conflict/COMMIT→SIGKILL recovery; ${expectedEffects} real fresh native runs, public protocols=${!!context.recipePublic}, no save or effect replay.`);
  } finally { try { await stop(); } finally { await new Promise(resolve => provider.close(resolve)); } }
};
