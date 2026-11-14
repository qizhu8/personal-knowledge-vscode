"use strict";
const fs = require("node:fs"), path = require("node:path"), assert = require("node:assert/strict");
const { spawn } = require("node:child_process"), { once } = require("node:events");
const { createServer } = require("node:http"), { createRequire } = require("node:module");
const { pathToFileURL } = require("node:url");
exports.run = async context => {
  const { fixture, root, target, nonce, actorId, prepared, archive, descriptor, rootStat,
    env, processes, startCode, stopCode, python } = context;
  const load = name => import(pathToFileURL(path.join(target, "next-runtime/server/dist", `${name}.js`)));
  const original = JSON.parse(fs.readFileSync(path.join(fixture, "original-recipe-evidence.json")));
  const manager = archive.chats.find(row => row.id === descriptor.workerManager);
  const identity = { namespace: manager.namespace, chatId: manager.id };
  const storage = await (await load("storage")).Storage.open(root, { deferRecovery: true });
  let documentIds;
  const database = storage.connectNative();
  try {
    documentIds = database.prepare("SELECT id FROM documents WHERE (area='notes' AND path='Bound.md') OR (area='skills' AND path='Testing/Proof.md')").all().map(row => row.id);
    assert.equal(documentIds.length, 2);
  } finally { database.close(); await storage.close(); }
  let broker, grant, codeStarted = false, modelCalls = 0;
  const provider = createServer((_request, response) => {
    modelCalls++; response.writeHead(500); response.end("Knowledge/history must not invoke a model.");
  });
  await new Promise(resolve => provider.listen(0, "127.0.0.1", resolve));
  const grantFile = path.join(fixture, "u/User/globalStorage/uone.personal-knowledge/next-chat-ui-experiment.json");
  fs.mkdirSync(path.dirname(grantFile), { recursive: true, mode: 0o700 });
  const rpc = async request => {
    const response = await fetch(`${grant.endpoint}/rpc`, { method: "POST",
      headers: { authorization: `Bearer ${grant.bearer}`, "x-pkm-native-actor": actorId, "content-type": "application/json" },
      body: JSON.stringify(request) });
    const data = await response.json(); assert.equal(response.status, 200, JSON.stringify(data)); return data.value;
  };
  const state = () => rpc({ method: "recipe-state", ...identity });
  const effects = () => {
    const file = path.join(fixture, "native-recipe-effects.jsonl");
    return fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : [];
  };
  async function start(knowledge = true, code = true) {
    fs.writeFileSync(path.join(fixture, "native-managed-host.json"), JSON.stringify({
      root, nonce, workspaceId: prepared.workspaceId, actorId, sourceFingerprint: archive.sourceFingerprint,
      sourceSessionId: manager.metadata.sessionId, chat: identity, chatRecipe: true, recipeLibrary: true, recipePublic: true,
      ...(knowledge ? { recipeKnowledgeDocumentIds: documentIds } : {}),
      providerEndpoint: `http://127.0.0.1:${provider.address().port}/v1`,
    }), { mode: 0o600 });
    broker = spawn(process.execPath, [path.join(__dirname, "native-managed-chat-ui-host.cjs"), fixture, root, target, nonce],
      { cwd: fixture, env: { ...env, PKM_NATIVE_UI_PRIVATE_FIXTURE: nonce }, stdio: ["ignore", "inherit", "inherit", "ipc"] });
    processes.add(broker); broker.once("exit", () => processes.delete(broker));
    const ready = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error("Knowledge host startup timeout.")), 30000);
      broker.on("message", item => { if (item.type === "ready") { clearTimeout(timer); resolve(item); } });
      broker.once("error", reject);
      broker.once("exit", exit => { clearTimeout(timer); reject(Error(`Knowledge host exited ${exit}`)); });
    });
    grant = { schema: "pkm.private-native-chat-ui/v1", kind: "synthetic-only", fixture, root,
      rootDevice: String(rootStat.dev), rootInode: String(rootStat.ino), nonce, workspaceId: prepared.workspaceId,
      actorId, sourceFingerprint: archive.sourceFingerprint, endpoint: ready.endpoint, bearer: ready.bearer };
    fs.writeFileSync(grantFile, JSON.stringify(grant), { mode: 0o600 });
    if (code) { await startCode({ PKM_PRIVATE_NATIVE_CHAT_UI_GRANT: grantFile }); codeStarted = true; }
  }
  async function stop() {
    if (codeStarted) { await stopCode(); codeStarted = false; }
    if (broker && broker.exitCode === null && broker.signalCode === null) {
      const exited = once(broker, "exit"); broker.kill("SIGTERM"); assert.deepEqual(await exited, [0, null]);
    }
    broker = undefined;
  }
  const reads = [];
  async function history() {
    const endpoints = JSON.parse(fs.readFileSync(path.join(fixture, "native-recipe-public-endpoints.json")));
    const sdk = createRequire(path.join(target, "next-runtime/server/package.json"));
    const { Client } = sdk("@modelcontextprotocol/sdk/client/index.js");
    const { StreamableHTTPClientTransport } = sdk("@modelcontextprotocol/sdk/client/streamableHttp.js");
    const client = new Client({ name: "actual-installed-original-history", version: "1" });
    const headers = { authorization: `Bearer ${endpoints.token}`, "content-type": "application/json" };
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(endpoints.mcp), { requestInit: { headers } }));
      for (const run of (await state()).originalRuns) {
        const args = { runId: run.runId, expectedSha256: run.sha256 };
        const mcp = await client.callTool({ name: "capability_read", arguments: { operation: "recipe.history.get", version: 1, arguments: args } });
        assert(!mcp.isError, JSON.stringify(mcp));
        const response = await fetch(`${endpoints.http}/v1/capability_read`, { method: "POST", headers,
          body: JSON.stringify({ operation: "recipe.history.get", version: 1, arguments: args }) });
        const http = await response.json(); assert(!http.error, JSON.stringify(http));
        const value = mcp.structuredContent.result;
        const raw = fs.readFileSync(path.join(root, ".pkm/state/recipe-runs", `${run.runId}.json`), "utf8");
        assert.equal(value.raw, raw); assert.deepEqual(value.record, JSON.parse(raw));
        assert.equal(http.result.raw, raw);
        assert.deepEqual(await rpc({ method: "recipe-history-get", input: { ...identity, ...args } }), value);
        if (value.record.status === "running") assert.equal(value.state, "unknown");
        assert.equal(value.ownership, "unattributed-original-record");
        reads.push({ runId: run.runId, sha256: value.sourceSha256, state: value.state, rawBytesEqual: true });
      }
    } finally { await client.close(); }
  }
  try {
    await start(false, false);
    assert.equal((await state()).recipes.find(row => row.recipeId === original.recipeId).available, false);
    assert.equal(effects().length, 0);
    await stop(); await start();
    assert.equal((await state()).recipes.find(row => row.recipeId === original.recipeId).recipeKnowledge.knowledge.length, 2);
    await history(); await python("native-knowledge-start");
    assert.equal(effects().length, 1);
    const contexts = fs.readFileSync(path.join(fixture, "native-recipe-knowledge-context.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
    assert.equal(contexts.length, 2);
    assert.equal(contexts.find(row => row.nodeId === "inspect").context.knowledge.length, 2);
    assert.equal(contexts.find(row => row.nodeId === "record").context.knowledge.length, 0);
    assert(contexts.every(row => row.context.executionAuthority === false));
    await stop(); await start(); await history(); await python("native-knowledge-reopen");
    assert.equal(effects().length, 1); assert.equal((await state()).runs.length, 1); assert.equal(modelCalls, 0);
    assert(!fs.existsSync(path.join(root, "recipes")), "Never project a fake filesystem library.");
    fs.writeFileSync(path.join(fixture, "native-recipe-knowledge-installed-evidence.json"), JSON.stringify({
      kind: "actual-installed-same-root-recipe-knowledge-history", root, rootDevice: String(rootStat.dev), rootInode: String(rootStat.ino),
      workspaceId: prepared.workspaceId, sourceFingerprint: archive.sourceFingerprint, installedExtension: target,
      documentIds, contexts, reads, effects: effects(), ui: JSON.parse(fs.readFileSync(path.join(fixture, "native-knowledge-ui-state.json"))),
      modelCalls, noFilesystemLibraryProjection: true, fullRecipeParity: false, migrationQualified: false,
      finalRootAndInstalledIdentityVerified: false,
    }), { mode: 0o600 });
    console.log("PASS actual installed same-root Note/Skill context, exact native modal/run, complete original history SDK+HTTP+private UI reads and restart without replay.");
  } finally { try { await stop(); } finally { await new Promise(resolve => provider.close(resolve)); } }
};
