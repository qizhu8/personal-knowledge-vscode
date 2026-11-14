"use strict";
const fs = require("node:fs"), path = require("node:path"), { createServer } = require("node:http");
const { spawn } = require("node:child_process"), { randomUUID, createHash } = require("node:crypto");
const { once } = require("node:events"), assert = require("node:assert/strict");
const hash = value => createHash("sha256").update(value).digest("hex");
exports.run = async function (context) {
  const { fixture, root, target, nonce, actorId, prepared, archive, descriptor, rootStat,
    env, processes, startCode, stopCode, python, taskControls = false, chatWorkflows = false } = context;
  const manager = archive.chats.find(chat => chat.id === descriptor.workerManager);
  assert.equal(manager.metadata.sessionId, JSON.parse(fs.readFileSync(path.join(fixture, "legacy-chat-worker-evidence.json"))).sessionId);
  const identity = { namespace: manager.namespace, chatId: manager.id }, reads = [];
  const fresh = `actual-native-file-${randomUUID()}`, crash = `actual-native-unacknowledged-${randomUUID()}`;
  fs.writeFileSync(path.join(fixture, "workspace/native-input.txt"), fresh, { flag: "wx", mode: 0o600 });
  fs.writeFileSync(path.join(fixture, "workspace/native-crash.txt"), crash, { flag: "wx", mode: 0o600 });
  let calls = 0, broker, activeGrant;
  const workflowInputs = [], steeringPrompts = [];
  const provider = createServer(async (request, response) => {
    try {
      assert.equal(request.url, "/v1/chat/completions");
      assert.equal(request.headers.authorization, "Bearer synthetic-fresh-managed-provider");
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString()); calls++;
      const input = body.messages.findLast(message => message.role === "user").content;
      if (chatWorkflows) {
        workflowInputs.push(input);
        fs.writeFileSync(path.join(fixture, "native-workflow-observations.json"), JSON.stringify({ calls, inputs: workflowInputs }), { mode: 0o600 });
      }
      if (taskControls && input.includes("NATIVE_CONTROL_CANCEL_MODEL") || chatWorkflows && input.includes("NATIVE_WORKFLOW_QUEUE_HOLD")) {
        fs.writeFileSync(path.join(fixture, input.includes("NATIVE_WORKFLOW_QUEUE_HOLD")
          ? "native-workflow-model-observed.json" : "native-control-model-observed.json"), JSON.stringify({ calls }), { flag: "wx", mode: 0o600 });
        await new Promise(resolve => {
          const timer = setTimeout(resolve, 30000);
          response.once("close", () => { clearTimeout(timer); resolve(); });
        });
        assert(response.destroyed, "A real UI Stop must abort the freshly authorized model request.");
        return;
      }
      const child = input.includes("FRESH_NATIVE_CHILD"), unknown = input.includes("NATIVE_MANAGED_UNKNOWN");
      const results = body.messages.slice(body.messages.findLastIndex(message => message.role === "user") + 1)
        .filter(message => message.role === "tool").map(message => JSON.parse(message.content));
      const read = results.find(result => result.path), spawned = results.find(result => result.workers);
      let delta, finished = false;
      if (read) assert.equal(read.content, fresh);
      if (chatWorkflows && input.includes("NATIVE_WORKFLOW_FIFO_")) {
        assert(["NATIVE_WORKFLOW_FIFO_A_EDITED", "NATIVE_WORKFLOW_FIFO_B"].includes(input));
        delta = { content: `${input}_RESULT` }; finished = true;
      } else if (chatWorkflows && input === "NATIVE_WORKFLOW_AFTER_KNOWN_FAILURE") {
        delta = { content: "NATIVE_WORKFLOW_AFTER_KNOWN_FAILURE_RESULT" }; finished = true;
      } else if (chatWorkflows && input.includes("NATIVE_WORKFLOW_STEER_NEXT:")) {
        assert(body.messages.some(message => message.role === "user" && message.content.includes("NATIVE_WORKFLOW_STEER:")));
        const actual = body.messages.filter(message => message.role === "tool").map(message => JSON.parse(message.content)).findLast(result => result.path);
        assert.equal(actual.content, fresh); steeringPrompts.push(body.messages);
        delta = { content: `NATIVE_WORKFLOW_STEER_RESULT sha256:${hash(actual.content)}` }; finished = true;
      } else if (chatWorkflows && read && input.includes("NATIVE_WORKFLOW_AFTER_REVIEW:")) {
        delta = { content: `NATIVE_WORKFLOW_AFTER_REVIEW_RESULT sha256:${hash(read.content)}` }; finished = true;
      } else if (read && input.includes("NATIVE_CONTROL_SINGLE")) { delta = { content: `NATIVE_CONTROL_READ sha256:${hash(read.content)}` }; finished = true; }
      else if (child && read) { delta = { content: `NATIVE_MANAGED_CHILD sha256:${hash(read.content)}` }; finished = true; }
      else if (spawned) {
        assert.equal(spawned.workers[0].output, `NATIVE_MANAGED_CHILD sha256:${hash(read.content)}`);
        delta = { content: `NATIVE_MANAGED_PARENT sha256:${hash(read.content)}` }; finished = true;
      } else {
        const name = read ? "spawn_workers" : "read_file";
        const arguments_ = read ? { tasks: [{ title: unknown ? "Native uncertain worker" : "Native independent worker",
          question: unknown ? "FRESH_NATIVE_CHILD NATIVE_MANAGED_UNKNOWN: Read native-crash.txt once. Never write or retry."
            : "FRESH_NATIVE_CHILD: Read native-input.txt once. Never write or retry." }] }
          : { path: child && unknown ? "native-crash.txt" : chatWorkflows && input.includes("NATIVE_WORKFLOW_KNOWN_FAILURE:")
            ? "native-denied.txt" : "native-input.txt" };
        delta = { tool_calls: [{ index: 0, id: `native-${name}`, type: "function",
          function: { name, arguments: JSON.stringify(arguments_) } }] };
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`
        + `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: finished ? "stop" : "tool_calls" }] })}\n\n`
        + 'data: {"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":30}}\n\ndata: [DONE]\n\n');
    } catch (error) { console.error("MANAGED_PROVIDER_REFUSED", error); response.writeHead(500); response.end(String(error)); }
  });
  await new Promise(resolve => provider.listen(0, "127.0.0.1", resolve));
  const grantFile = path.join(fixture, "u/User/globalStorage/uone.personal-knowledge/next-chat-ui-experiment.json");
  fs.mkdirSync(path.dirname(grantFile), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(fixture, "native-managed-host.json"), JSON.stringify({
    root, nonce, workspaceId: prepared.workspaceId, actorId, sourceFingerprint: archive.sourceFingerprint,
    sourceSessionId: manager.metadata.sessionId, chat: identity, chatWorkflows,
    providerEndpoint: `http://127.0.0.1:${provider.address().port}/v1`,
  }), { mode: 0o600 });
  Object.assign(descriptor, { nativeManagedSha256: hash(fresh), nativeManagedFileContent: fresh,
    nativeManagedSessionId: manager.metadata.sessionId, nativeTaskControls: taskControls, nativeChatWorkflows: chatWorkflows });
  fs.writeFileSync(path.join(fixture, "api-chat-fixture.json"), JSON.stringify(descriptor), { mode: 0o600 });
  const rpc = async input => {
    const response = await fetch(`${activeGrant.endpoint}/rpc`, { method: "POST",
      headers: { authorization: `Bearer ${activeGrant.bearer}`, "x-pkm-native-actor": actorId,
        "content-type": "application/json" }, body: JSON.stringify(input) });
    const result = await response.json(); assert.equal(response.status, 200, JSON.stringify(result)); return result.value;
  };
  async function start() {
    broker = spawn(process.execPath, [path.join(__dirname, "native-managed-chat-ui-host.cjs"), fixture, root, target, nonce],
      { cwd: fixture, env: { ...env, PKM_NATIVE_UI_PRIVATE_FIXTURE: nonce }, stdio: ["ignore", "inherit", "inherit", "ipc"] });
    processes.add(broker); broker.once("exit", () => processes.delete(broker));
    const ready = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Native managed broker readiness timed out.")), 30000);
      broker.on("message", message => {
        if (message.type === "actual-file-read") reads.push(message);
        if (message.type === "ready") { clearTimeout(timer); resolve(message); }
      });
      broker.once("error", reject);
      broker.once("exit", code => { clearTimeout(timer); reject(new Error(`Native managed broker exited ${code}`)); });
    });
    activeGrant = { schema: "pkm.private-native-chat-ui/v1", kind: "synthetic-only", fixture, root,
      rootDevice: String(rootStat.dev), rootInode: String(rootStat.ino), nonce, workspaceId: prepared.workspaceId,
      actorId, sourceFingerprint: archive.sourceFingerprint, endpoint: ready.endpoint, bearer: ready.bearer };
    fs.writeFileSync(`${grantFile}.next`, JSON.stringify(activeGrant), { flag: "wx", mode: 0o600 });
    fs.renameSync(`${grantFile}.next`, grantFile);
    assert.equal((await rpc({ method: "status" })).managed, true);
    await startCode({ PKM_PRIVATE_NATIVE_CHAT_UI_GRANT: grantFile });
  }
  try {
    await start(); await python("native-managed");
    const completed = await rpc({ method: "history", ...identity });
    if (taskControls) {
      const evidence = JSON.parse(fs.readFileSync(path.join(fixture, "native-task-control-ui-evidence.json")));
      assert.equal(completed.metadata.sessionId, evidence.crashTaskSessionId);
      assert.equal(completed.taskControl.tasks.length, 3);
      assert.notEqual(completed.metadata.sessionId, manager.metadata.sessionId);
      assert.equal(completed.nativeTurns[1].status, "cancelled");
      assert.equal(completed.nativeTurns[1].uncertain, false);
      assert.equal(completed.nativeTurns[2].status, "completed");
      assert.equal(evidence.draftRetained, true);
    } else assert.equal(completed.metadata.sessionId, manager.metadata.sessionId);
    assert.equal(completed.nativeTurns[0].status, "completed");
    assert.equal(completed.nativeWorkers[0].status, "completed");
    assert(reads.some(read => read.child && read.sha256 === hash(fresh)));
    assert(reads.some(read => !read.child && read.sha256 === hash(fresh)));
    if (chatWorkflows) {
      assert.equal(steeringPrompts.length, 1);
      assert.equal(completed.nativeTurns.at(-1).status, "cancelled");
      assert.deepEqual(completed.queueControl.items.filter(item => item.status === "queued").map(item => item.text),
        ["NATIVE_WORKFLOW_FIFO_A_EDITED", "NATIVE_WORKFLOW_FIFO_B"]);
      const beforeCalls = calls, beforeReads = reads.length;
      await stopCode();
      const stopped = once(broker, "exit"); broker.kill("SIGTERM"); assert.deepEqual(await stopped, [0, null]); broker = undefined;
      await start();
      const untouched = await rpc({ method: "history", ...identity });
      assert(untouched.queueControl.needsReview); assert.equal(calls, beforeCalls); assert.equal(reads.length, beforeReads);
      await python("native-workflow-resume");
    }
    const deadline = Date.now() + 20000;
    while (!reads.some(read => read.path === "native-crash.txt") && Date.now() < deadline)
      await new Promise(resolve => setTimeout(resolve, 50));
    const effect = reads.find(read => read.path === "native-crash.txt");
    assert.equal(effect?.sha256, hash(crash));
    assert.equal(effect.child, true, "The killed effect must belong to a real delegated native worker.");
    assert.equal(calls, chatWorkflows ? 16 : taskControls ? 11 : 8);
    assert.equal(reads.length, chatWorkflows ? 6 : taskControls ? 5 : 4);
    await stopCode();
    const exited = once(broker, "exit"); broker.kill("SIGKILL");
    assert.deepEqual(await exited, [null, "SIGKILL"]); broker = undefined;
    const priorCalls = calls, priorReads = reads.length;
    await start(); await python("native-managed-reopen");
    let recovered = await rpc({ method: "history", ...identity });
    const unknown = chatWorkflows ? recovered.nativeTurns.find(turn => turn.id ===
      JSON.parse(fs.readFileSync(path.join(fixture, "native-workflow-review-ui-evidence.json"))).unknownTurnId) : recovered.nativeTurns.at(-1);
    assert.equal(unknown.status, "unknown"); assert.equal(unknown.replay, "never");
    if (!chatWorkflows) assert.equal(recovered.pending.at(-1).status, "prepared");
    assert.equal(recovered.nativeWorkers.at(-1).status, "unknown");
    assert.equal(recovered.nativeWorkers.at(-1).replay, "never");
    assert.equal(calls, priorCalls + (chatWorkflows ? 4 : 0));
    assert.equal(reads.length, priorReads + (chatWorkflows ? 1 : 0));
    if (chatWorkflows) {
      assert.equal(reads.filter(read => read.path === "native-crash.txt").length, 1);
      assert.equal(unknown.userReview.decision, "abandon-without-replay");
      assert.equal(recovered.nativeTurns.at(-1).status, "completed");
      assert.equal(recovered.nativeTurns.at(-2).status, "failed");
      assert.equal(recovered.nativeTurns.at(-2).uncertain, false);
      assert.equal(workflowInputs.filter(input => input.startsWith("NATIVE_WORKFLOW_KNOWN_FAILURE:")).length, 1);
      assert.equal(workflowInputs.filter(input => input === "NATIVE_WORKFLOW_AFTER_KNOWN_FAILURE").length, 1);
      const decisions = fs.readFileSync(path.join(fixture, "native-workflow-user-required.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
      assert.equal(decisions.length, 1); assert.equal(decisions[0].userRequired, true);
      const beforeCalls = calls, beforeReads = reads.length;
      await stopCode();
      const stopped = once(broker, "exit"); broker.kill("SIGTERM"); assert.deepEqual(await stopped, [0, null]); broker = undefined;
      await start(); await python("native-workflow-reviewed-reopen");
      recovered = await rpc({ method: "history", ...identity });
      assert.equal(calls, beforeCalls); assert.equal(reads.length, beforeReads);
      assert.deepEqual(recovered.nativeTurns.find(turn => turn.id === unknown.id).userReview, unknown.userReview);
      assert.deepEqual(workflowInputs.filter(input => input.startsWith("NATIVE_WORKFLOW_FIFO_")),
        ["NATIVE_WORKFLOW_FIFO_A_EDITED", "NATIVE_WORKFLOW_FIFO_B"]);
    }
    await stopCode();
    const stopped = once(broker, "exit"); broker.kill("SIGTERM"); assert.deepEqual(await stopped, [0, null]); broker = undefined;
    fs.writeFileSync(path.join(fixture, "native-managed-installed-evidence.json"), JSON.stringify({
      sourceSessionId: manager.metadata.sessionId, chatId: manager.id, calls, reads,
      taskControl: recovered.taskControl, taskControls, chatWorkflows, queueControl: recovered.queueControl,
      steeringPrompts: chatWorkflows ? steeringPrompts : undefined, workflowInputs: chatWorkflows ? workflowInputs : undefined,
      turns: recovered.nativeTurns, workers: recovered.nativeWorkers.map(({ messages, ...worker }) => worker),
    }), { flag: "wx", mode: 0o600 });
    console.log("PASS installed original managed Task/Library/Harness: genuine parent and child filesystem reads; exact source Session retained; actual broker SIGKILL before tool ack and full Code restart remain unknown without replay.");
  } finally {
    await stopCode();
    if (broker && broker.exitCode === null && broker.signalCode === null) {
      const exited = once(broker, "exit"); broker.kill("SIGKILL"); await exited;
    }
    await new Promise(resolve => provider.close(resolve));
  }
};
