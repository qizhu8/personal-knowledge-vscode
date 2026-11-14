"use strict";
const fs = require("node:fs"), path = require("node:path"), assert = require("node:assert/strict");
const { spawn } = require("node:child_process"), { once } = require("node:events");
const { createServer } = require("node:http"), { createHash } = require("node:crypto");
const { pathToFileURL } = require("node:url");
const { DatabaseSync } = require("node:sqlite");
const sha = value => createHash("sha256").update(value).digest("hex");
exports.run = async context => {
  const { fixture, root, target, nonce, actorId, prepared, archive, descriptor, rootStat,
    env, processes, startCode, stopCode, python } = context;
  const old = descriptor.legacyMemory, manager = archive.chats.find(item => item.id === descriptor.workerManager);
  assert.equal(manager.metadata.permissionMode, "allow-all");
  assert.equal(sha(fs.readFileSync(old.database)), old.sourceSha256);
  const identity = { namespace: manager.namespace, chatId: manager.id };
  const observations = [], operations = [];
  let broker, grant, calls = 0;
  const provider = createServer(async (request, response) => {
    try {
      assert.equal(request.headers.authorization, "Bearer synthetic-fresh-managed-provider");
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString()); calls++;
      const input = body.messages.findLast(item => item.role === "user").content;
      const references = body.messages.flatMap(item => {
        try { const data = JSON.parse(item.content); return data.schema === "pkm.chat.memory-context/v1" ? [data] : []; }
        catch { return []; }
      });
      assert(!JSON.stringify(references).includes("SATURN_PENDING_SECRET"));
      assert(!JSON.stringify(references).includes("SATURN_FOREIGN_SECRET"));
      assert(body.tools.every(item => item.function.name.startsWith("memory_record_")), "No legacy executable authority.");
      observations.push({ input, references });
      const results = body.messages.slice(body.messages.findLastIndex(item => item.role === "user") + 1)
        .filter(item => item.role === "tool").map(item => JSON.parse(item.content));
      const tool = (name, args) => ({ tool_calls: [{ index: 0, id: `native-${name}`, type: "function",
        function: { name, arguments: JSON.stringify(args) } }] });
      let delta;
      if (input.includes("NATIVE_MEMORY_UPDATE")) {
        if (!results.length) delta = tool("memory_record_revise", { id: old.original.id, expected_revision: 2,
          content: "SATURN updated convention: use cobalt envelopes.", sources: old.original.sources });
        else { assert.equal(results[0].status, "pending"); assert.equal(references.length, 0); delta = { content: "NATIVE_MEMORY_UPDATE_PENDING" }; }
      } else if (input.includes("NATIVE_MEMORY_CONFIRM")) {
        if (!results.length) delta = tool("memory_record_confirm", { id: old.original.id, expected_revision: 3 });
        else { assert.equal(results[0].status, "confirmed"); assert(references.some(item => item.quotedText.includes("cobalt")));
          delta = { content: "NATIVE_MEMORY_CONFIRM_COMPLETE" }; }
      } else if (input.includes("NATIVE_MEMORY_REVOKE")) {
        if (!results.length) delta = tool("memory_record_revoke", { id: old.original.id, expected_revision: 4 });
        else { assert.equal(results[0].status, "revoked"); assert.equal(references.length, 0); delta = { content: "NATIVE_MEMORY_REVOKED" }; }
      } else if (input.includes("NATIVE_MEMORY_UNKNOWN")) {
        if (!results.length) delta = tool("memory_record_propose", {
          content: "SATURN unacknowledged but actually human-confirmed fact.", sources: old.original.sources });
        else {
          assert.equal(results.length, 1); assert.equal(results[0].status, "pending");
          delta = tool("memory_record_confirm", { id: results[0].id, expected_revision: 1 });
        }
      } else if (input.includes("NATIVE_MEMORY_RECALL_OLD")) {
        assert.deepEqual(references.map(item => item.quotedText), [old.original.content]);
        assert(references[0].sourcePins[0].references.length);
        delta = { content: "NATIVE_MEMORY_OLD_RECALLED" };
      } else if (input.includes("NATIVE_MEMORY_RECALL_COBALT")) {
        assert.deepEqual(references.map(item => item.quotedText), ["SATURN updated convention: use cobalt envelopes."]);
        delta = { content: "NATIVE_MEMORY_COBALT_RECALLED" };
      } else if (input.includes("NATIVE_MEMORY_RECALL_NONE")) {
        assert.equal(references.length, 0); delta = { content: "NATIVE_MEMORY_NO_ACTIVE_RECORD" };
      } else if (input.includes("NATIVE_MEMORY_FRESH_AFTER_UNKNOWN")) {
        assert.deepEqual(references.map(item => item.quotedText), ["SATURN unacknowledged but actually human-confirmed fact."]);
        delta = { content: "NATIVE_MEMORY_FRESH_RECORD_RECALLED_NO_REPLAY" };
      } else throw Error(`Unexpected Memory input ${input}`);
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`
        + `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: delta.tool_calls ? "tool_calls" : "stop" }] })}\n\n`
        + "data: [DONE]\n\n");
    } catch (error) { console.error("MEMORY_PROVIDER_REFUSED", error); response.writeHead(500); response.end(String(error)); }
  });
  await new Promise(resolve => provider.listen(0, "127.0.0.1", resolve));
  const grantFile = path.join(fixture, "u/User/globalStorage/uone.personal-knowledge/next-chat-ui-experiment.json");
  fs.writeFileSync(path.join(fixture, "native-managed-host.json"), JSON.stringify({
    root, nonce, workspaceId: prepared.workspaceId, actorId, sourceFingerprint: archive.sourceFingerprint,
    sourceSessionId: manager.metadata.sessionId, chat: identity, chatMemory: true,
    providerEndpoint: `http://127.0.0.1:${provider.address().port}/v1`,
  }), { mode: 0o600 });
  const rpc = async input => {
    const response = await fetch(`${grant.endpoint}/rpc`, { method: "POST",
      headers: { authorization: `Bearer ${grant.bearer}`, "x-pkm-native-actor": actorId, "content-type": "application/json" },
      body: JSON.stringify(input) });
    const data = await response.json(); assert.equal(response.status, 200, JSON.stringify(data)); return data.value;
  };
  async function start() {
    broker = spawn(process.execPath, [path.join(__dirname, "native-managed-chat-ui-host.cjs"), fixture, root, target, nonce],
      { cwd: fixture, env: { ...env, PKM_NATIVE_UI_PRIVATE_FIXTURE: nonce }, stdio: ["ignore", "inherit", "inherit", "ipc"] });
    processes.add(broker); broker.once("exit", () => processes.delete(broker));
    const ready = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error("Memory broker startup timeout")), 30000);
      broker.on("message", item => {
        if (item.type === "actual-memory-operation") operations.push(item);
        if (item.type === "ready") { clearTimeout(timer); resolve(item); }
      });
      broker.once("error", reject);
      broker.once("exit", code => { clearTimeout(timer); reject(Error(`Memory broker exited ${code}`)); });
    });
    grant = { schema: "pkm.private-native-chat-ui/v1", kind: "synthetic-only", fixture, root,
      rootDevice: String(rootStat.dev), rootInode: String(rootStat.ino), nonce, workspaceId: prepared.workspaceId,
      actorId, sourceFingerprint: archive.sourceFingerprint, endpoint: ready.endpoint, bearer: ready.bearer };
    fs.writeFileSync(grantFile, JSON.stringify(grant), { mode: 0o600 });
    assert.equal((await rpc({ method: "memory-state", ...identity })).adopted, false);
    await startCode({ PKM_PRIVATE_NATIVE_CHAT_UI_GRANT: grantFile });
  }
  async function stop(signal = "SIGTERM") {
    await stopCode();
    if (broker) { const exited = once(broker, "exit"); broker.kill(signal);
      const result = await exited; if (signal === "SIGTERM") assert.deepEqual(result, [0, null]); broker = undefined; }
  }
  try {
    await start(); await python("native-memory-start");
    assert.equal(calls, 6);
    await stop(); const before = operations.length;
    await start(); assert.equal(operations.length, before); await python("native-memory-reopen");
    const denied = (await rpc({ method: "history", ...identity })).nativeTurns
      .filter(item => item.text === "NATIVE_MEMORY_REVOKE_DENIED SATURN");
    assert.equal(denied.length, 1);
    assert.equal(denied[0].status, "failed"); assert.equal(denied[0].uncertain, false);
    const marker = path.join(fixture, "native-memory-committed-unack.json"), deadline = Date.now() + 20000;
    while (!fs.existsSync(marker) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
    assert(fs.existsSync(marker));
    const committed = JSON.parse(fs.readFileSync(marker));
    assert.equal(committed.result.status, "confirmed"); assert.equal(committed.result.revision, 2);
    const memoryWrites = operations.filter(item => !["memory_record_get", "memory_record_search", "memory_record_audit"].includes(item.name));
    assert.equal(memoryWrites.length, 5);
    await stop("SIGKILL");
    const stoppedCalls = calls, stoppedOps = operations.length;
    await start();
    const unknown = await rpc({ method: "history", ...identity });
    assert.equal(unknown.nativeTurns.at(-1).id, committed.turnId);
    assert.equal(unknown.nativeTurns.at(-1).status, "unknown");
    assert.equal(unknown.nativeTurns.at(-1).replay, "never");
    assert.equal(calls, stoppedCalls); assert.equal(operations.length, stoppedOps);
    await python("native-memory-unknown-reopen");
    const reviewed = await rpc({ method: "history", ...identity });
    const abandoned = reviewed.nativeTurns.find(item => item.id === committed.turnId);
    assert.equal(abandoned.status, "unknown"); assert.equal(abandoned.uncertain, true);
    assert.equal(abandoned.userReview.decision, "abandon-without-replay");
    assert.equal(operations.length, stoppedOps); assert.equal(calls, 14);
    await stop(); await start(); await python("native-memory-final-reopen");
    assert.equal(calls, 14); assert.equal(operations.length, stoppedOps);
    const history = await rpc({ method: "history", ...identity });
    await stop();
    const database = new DatabaseSync(path.join(root, "core.sqlite"), { readOnly: true });
    let deniedRecord;
    try { deniedRecord = JSON.parse(database.prepare("SELECT record FROM chat_turn_records WHERE id=?")
      .get(denied[0].id).record); }
    finally { database.close(); }
    assert.equal(deniedRecord.failure, "MEMORY_ACCESS_DENIED"); assert.equal(deniedRecord.uncertain, false);
    assert.equal(deniedRecord.pendingTool.call.name, "memory_record_revoke");
    assert.equal(deniedRecord.pendingTool.call.arguments.id, old.original.id);
    const load = name => import(pathToFileURL(path.join(target, "next-runtime/server/dist", `${name}.js`)).href);
    const { scanMarkdown } = await load("markdown"), { readMemoryRecord } = await load("memory");
    const { readKnowledgeMetadata } = await load("metadata");
    const parent = path.join(fixture, "u/User/globalStorage/uone.personal-knowledge/next-chat-memory");
    const owners = fs.readdirSync(parent, { withFileTypes: true });
    assert.equal(owners.length, 1); assert(owners[0].isDirectory());
    const workspace = path.join(parent, owners[0].name, "workspace");
    const documents = scanMarkdown(workspace).filter(item => item.record.path.startsWith("System/Memory/"));
    const records = documents.map(item => readMemoryRecord(item));
    assert.equal(records.length, 4);
    const states = documents.map(item => readKnowledgeMetadata(item).metadata.memory);
    const original = states.find(item => item.id === old.original.id);
    assert.deepEqual(original.versions.map(item => item.event.action),
      ["proposed", "confirmed", "revised", "confirmed", "revoked"]);
    assert.equal(original.versions.at(-1).status, "revoked");
    assert.equal(original.versions[1].event.actor, "user:synthetic-original");
    assert(original.versions.slice(2).every(item => item.event.actor === `user:${actorId}`));
    const confirmed = states.find(item => item.id === committed.result.id);
    assert.deepEqual(confirmed.versions.map(item => item.event.action), ["proposed", "confirmed"]);
    assert.equal(confirmed.versions.at(-1).status, "confirmed");
    const exactCommit = states.flatMap(item => item.versions).filter(item => item.event.operation_id === committed.operationId);
    assert.equal(exactCommit.length, 1);
    assert.equal(exactCommit[0].event.actor, `user:${actorId}`);
    assert.equal(records.find(item => item.id === old.pendingId).status, "pending");
    assert.equal(records.find(item => item.id === old.foreignId).status, "confirmed");
    const userRequired = fs.readFileSync(path.join(fixture, "native-workflow-user-required.jsonl"), "utf8")
      .trim().split("\n").map(line => JSON.parse(line));
    assert.equal(userRequired.length, 1);
    assert.equal(userRequired[0].decision, "abandon-without-replay");
    assert.equal(userRequired[0].userRequired, true);
    assert.equal(sha(fs.readFileSync(old.database)), old.sourceSha256);
    assert.deepEqual(require("./legacy-chat-memory-fixture.cjs").sourceIdentity(old.database), old.sourceIdentity);
    fs.writeFileSync(path.join(fixture, "native-memory-installed-evidence.json"), JSON.stringify({
      calls, operations, observations, committed, history, records, states, userRequired, deniedRecord,
      sourceSha256: old.sourceSha256, sourceIdentity: old.sourceIdentity, originalAllowAllNeverInherited: true,
    }), { flag: "wx", mode: 0o600 });
    console.log("PASS installed original Memory: recall/revise/pending exclusion/confirm/revoke; fresh scope after full restarts; actual confirmed commit SIGKILL before ack remains UNKNOWN/never replay; original Engine unchanged.");
  } finally {
    try { await stop(); } finally { provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve)); }
  }
};
