const assert = require("assert");
const hostLoad = require("child_process").spawnSync(process.execPath, ["-e", `
  const assert = require("assert");
  const Module = require("module");
  const originalLoad = Module._load;
  Module._load = function(name, ...args) {
    if (name === "vscode") return {};
    return originalLoad.call(this, name, ...args);
  };
  let navigatorReads = 0;
  Object.defineProperty(globalThis, "navigator", { configurable: true, get() {
    navigatorReads++;
    throw new Error("PendingMigrationError: navigator is now a global in nodejs");
  }});
  require(${JSON.stringify(require.resolve("../dist/chat/api-chat-mcp"))});
  assert.strictEqual(navigatorReads, 0);
  const { ApiChatView } = require(${JSON.stringify(require.resolve("../dist/chat/api-chat-view"))});
  let pong;
  ApiChatView.prototype.handle.call({
    disposed: false,
    view: { webview: { postMessage: message => { pong = message; } } },
    initialize() { throw new Error("Heartbeat must not initialize or access Chat storage"); },
  }, { type: "hostHealth", id: "fixture-ping" }).then(() => {
    assert.deepStrictEqual(pong, { type: "hostHealth", id: "fixture-ping" });
  }).catch(error => { console.error(error); process.exitCode = 1; });
`], { encoding: "utf8", timeout: 10_000 });
assert.strictEqual(hostLoad.status, 0, hostLoad.stderr || String(hostLoad.error || "Chat module failed to load in the extension host"));
const { streamApiChat, decodeChatImage, toolBudgetSummary } = require("../dist/chat/api-chat-client");
const { ApiChatStore, agentSessionOrigin, apiChatStatus, apiChatDiagnostics, apiChatSessionDiagnostics } = require("../dist/chat/api-chat-store");
const { modelProfiles, validateBudget, estimateInputTokens, estimateCost, assertModelAvailable } = require("../dist/chat/api-chat-models");
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");

const encoder = new TextEncoder();
function events(chunks) {
  return new Response(new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  }), { headers: { "Content-Type": "text/event-stream" } });
}
const delta = text => `data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: null }] })}\n\n`;
const done = 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
const testImage = { label: "fixture.png", mimeType: "image/png", dataBase64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5wAAAABJRU5ErkJggg==" };
const base = {
  provider: "openai-compatible", endpoint: "https://example.test/v1", apiKey: "test-key", model: "test-model",
  messages: [{ role: "user", content: "Hello" }], signal: new AbortController().signal,
};

if (process.argv.includes("--preview") || process.argv.includes("--browser-check")) startPreview();
else (async () => {
  assert(decodeChatImage(testImage).length > 0);
  for (const image of [{ ...testImage, mimeType: "image/jpeg" }, { ...testImage, mimeType: "image/svg+xml" }, { ...testImage, dataBase64: "invalid" }, { ...testImage, dataBase64: testImage.dataBase64 + "\n" }, { ...testImage, label: "unsafe\nlabel" }, { ...testImage, dataBase64: Buffer.alloc(512 * 1024 + 1).toString("base64") }]) assert.throws(() => decodeChatImage(image));
  const tooWide = decodeChatImage(testImage); tooWide.writeUInt32BE(4097, 16);
  assert.throws(() => decodeChatImage({ ...testImage, dataBase64: tooWide.toString("base64") }), /4096/);
  await assert.rejects(streamApiChat({ ...base, messages: [{ role: "user", content: "Look", images: [testImage] }], fetch: async () => { throw new Error("Must not call HTTP"); } }, () => {}), /Direct HTTP image/);
  const source = fs.readFileSync(path.join(__dirname, "../src/webview/api-chat.js"), "utf8");
  const contextFunction = source.match(/function contextLengthLabel\(value\) \{[\s\S]*?\n  \}/);
  assert(contextFunction);
  const contextLengthLabel = vm.runInNewContext(`(${contextFunction[0]})`);
  for (const [tokens, label] of [[256, "256"], [4096, "4K"], [115250, "115K"], [128000, "128K"], [1000000, "1M"], [7500000, "7.5M"]]) assert.strictEqual(contextLengthLabel(tokens), label);
  const tokenFunction = source.match(/function messageTokenLabel\(message, pending\) \{[\s\S]*?\n  \}/);
  assert(tokenFunction);
  const messageTokenLabel = vm.runInNewContext(`(${tokenFunction[0]})`);
  assert.strictEqual(messageTokenLabel({ usage: { inputTokens: 100, outputTokens: 20 } }, true), "Awaiting token usage");
  assert.strictEqual(messageTokenLabel({ estimatedTokens: 123, content: "hello" }, false), "Token usage not reported");
  assert.strictEqual(messageTokenLabel({ usage: { inputTokens: 100, outputTokens: 20 } }, false), "100 in / 20 out tokens");
  assert.strictEqual(messageTokenLabel({ usage: { inputTokens: 0, outputTokens: 0 } }, false), "0 in / 0 out tokens");
  for (const usage of [{ inputTokens: -1, outputTokens: 2 }, { inputTokens: 2.5, outputTokens: 1 }, { inputTokens: 1 }, { inputTokens: NaN, outputTokens: 2 }]) assert.strictEqual(messageTokenLabel({ usage }, false), "Token usage not reported");
  const presetFunction = source.match(/function contextPresets\(maximum\) \{[\s\S]*?\n  \}/);
  assert(presetFunction);
  const contextPresets = vm.runInNewContext(`(${presetFunction[0]})`);
  for (const maximum of [256, 257, 512, 4096, 8192, 16000, 128000, 1048576]) {
    const levels = Array.from(contextPresets(maximum));
    assert(levels.length <= 5 && levels.length >= 1);
    assert(levels.every((value, index) => Number.isSafeInteger(value) && value >= 256 && value <= maximum && (!index || value > levels[index - 1])));
    assert.strictEqual(levels.at(-1), maximum);
  }
  assert.deepStrictEqual(Array.from(contextPresets(16384)), [1024, 2048, 4096, 8192, 16384]);
  const profiles = modelProfiles([
    { id: "active", status: "active", contextWindow: 8192, maxOutputTokens: 2048, inputPricePerMillion: 2, outputPricePerMillion: 8 },
    { id: "retired", status: "deprecated", contextWindow: 8192 },
    { id: "expired", status: "active", contextWindow: 8192, deprecatedAt: "2020-01-01" },
  ], ["unknown"]);
  assert.strictEqual(profiles[3].status, "unknown");
  assert.strictEqual(profiles[3].contextWindow, 4096);
  assert.throws(() => assertModelAvailable(profiles[1]), /deprecated/);
  assert.throws(() => assertModelAvailable(profiles[2]), /deprecated/);
  assert.throws(() => validateBudget(profiles[0], 16384, 1024, base.messages), /window/);
  assert.throws(() => validateBudget(profiles[0], 8192, 4096, base.messages), /output/i);
  assert.throws(() => validateBudget(profiles[0], 256, 128, [{ role: "user", content: "x".repeat(200) }]), /exceeded/);
  assert.strictEqual(estimateInputTokens([{ role: "user", content: "\u4f60\u597d" }]), 70);
  assert.strictEqual(estimateCost(profiles[0], 1000, 500), 0.006);
  assert.strictEqual(estimateCost(profiles[3], 1000, 500), undefined);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-api-chat-"));
  try {
    testControlRegistration(directory);
    const lifecycle = require("../dist/agent-sessions/agent-session-lifecycle");
    const { apiChatGroupSnapshots } = require("../dist/chat/api-chat-store");
    const groupState = path.join(directory, "chat-group-lifecycle");
    const groupStore = new ApiChatStore(groupState, "0123456789abcdef");
    const groupChat = groupStore.create();
    const chatGroup = lifecycle.agentSessionGroup({ sessionId: "", hostKind: "pkm", hostSessionId: groupChat.id });
    assert.strictEqual(apiChatGroupSnapshots(groupState).length, 1, "A Chat without a Task must still own one Group");
    assert.strictEqual(apiChatGroupSnapshots(groupState)[0].groupId, chatGroup.groupId);
    groupChat.title = "E2E 2026-10-06 16:29:06.822 UTC " + "exact title ".repeat(20); groupStore.save(groupChat);
    assert.strictEqual(apiChatGroupSnapshots(groupState)[0].title, groupChat.title, "Group title must not be truncated");
    const chatGroupPath = path.join(groupState, "agent-groups", `${chatGroup.groupId}.json`);
    fs.writeFileSync(chatGroupPath, JSON.stringify({ ...JSON.parse(fs.readFileSync(chatGroupPath)), deletedAt: "old-tombstone" }));
    assert.strictEqual(apiChatGroupSnapshots(groupState)[0].deletedAt, undefined, "A real live Chat overrides a stale Group tombstone");
    await assert.rejects(lifecycle.deleteAgentSessionGroup(groupState, chatGroup.groupId), /follows its Chat/);
    groupStore.startTask(groupChat, "Preserved Task");
    const groupTaskPath = path.join(groupState, "agent-sessions", `${groupChat.sessionId}.json`);
    const stoppedTask = { ...JSON.parse(fs.readFileSync(groupTaskPath)), status: "stopped" };
    fs.writeFileSync(groupTaskPath, JSON.stringify(stoppedTask));
    const taskEvidence = fs.readFileSync(groupTaskPath);
    assert.strictEqual(groupStore.list()[0].status, "stopped");
    groupStore.trashChat(groupChat.id);
    assert(apiChatGroupSnapshots(groupState)[0].deletedAt);
    assert.strictEqual(groupStore.list().length, 0);
    groupStore.restoreChat(groupChat.id);
    assert.strictEqual(apiChatGroupSnapshots(groupState)[0].deletedAt, undefined);
    assert.strictEqual(new ApiChatStore(groupState, "0123456789abcdef").list()[0].id, groupChat.id);
    groupStore.trashChat(groupChat.id); groupStore.deleteChat(groupChat.id);
    assert.strictEqual(apiChatGroupSnapshots(groupState).length, 0);
    assert(JSON.parse(fs.readFileSync(chatGroupPath)).deletedAt, "Permanent deletion leaves a Group tombstone");
    assert(fs.readFileSync(groupTaskPath).equals(taskEvidence), "Chat lifecycle never deletes or rewrites Task evidence");
    const { chatMemoryTree, retrieveChatMemory } = require("../dist/chat/chat-memory");
    const memoryChat = { ...groupChat, includeHistory: true, messages: [
      { id: "old-memory", taskId: "task-cache", role: "assistant", status: "complete", content: "AAGL cache design uses immutable manifests. " + "segment body ".repeat(130) },
      { id: "failed-memory", taskId: "task-cache", role: "assistant", status: "failed", content: "AAGL failed secret must not be recalled" },
      ...Array.from({ length: 20 }, (_, index) => ({ id: `recent-${index}`, role: "user", status: "complete", content: `Recent message ${index}` })),
    ], memoryTasks: [{ id: "task-cache", title: "Cache design", createdAt: groupChat.createdAt }] };
    const memoryTree = chatMemoryTree(memoryChat);
    assert.strictEqual(memoryTree.chatId, groupChat.id);
    assert(memoryTree.tasks.find(task => task.id === "task-cache").segments.length > 1);
    assert(!JSON.stringify(memoryTree).includes("immutable manifests"), "Tree previews do not expose full message bodies");
    assert(memoryTree.tasks.flatMap(task => task.segments).every(segment => Array.from(segment.preview).length <= 30));
    assert.strictEqual(memoryTree.tasks.find(task => task.id === "task-cache").segments[0].preview,
      Array.from(memoryChat.messages[0].content).slice(0, 30).join(""));
    const unicodeResult = "\u{1f642}".repeat(35) + "tool result";
    const previewTree = chatMemoryTree({ ...groupChat, messages: [
      { id: "preview-message", role: "assistant", status: "complete", content: unicodeResult, toolCalls: [
        { id: "call", name: "run_process", arguments: "{}", result: "First result", status: "complete" },
        { id: "call:other", name: "run_process", arguments: "{}", result: unicodeResult, status: "complete" },
      ] },
    ] });
    const previewSegments = previewTree.tasks.flatMap(task => task.segments);
    assert.strictEqual(previewSegments[0].preview, "\u{1f642}".repeat(30), "Dialogue previews count Unicode code points");
    assert.strictEqual(previewSegments[1].preview, "First result", "Tool previews show results, not provenance headers");
    assert.strictEqual(previewSegments[2].preview, "\u{1f642}".repeat(30), "Tool IDs with common prefixes resolve exact source revisions");
    assert.strictEqual(previewSegments[2].sourceKind, "tool");
    const memoryMatches = retrieveChatMemory(memoryChat, "AAGL cache design");
    assert(memoryMatches.length > 0 && memoryMatches.length <= 4);
    assert(memoryMatches.every(segment => segment.messageId === "old-memory"));
    assert(memoryMatches.some(segment => segment.content.includes("immutable manifests")));
    assert.deepStrictEqual(retrieveChatMemory({ ...memoryChat, includeHistory: false }, "AAGL cache"), []);
    assert.deepStrictEqual(retrieveChatMemory({ ...memoryChat, messages: memoryChat.messages.slice(-20) }, "AAGL cache"), []);
    assert.deepStrictEqual(retrieveChatMemory({ ...groupChat, messages: [] }, "AAGL cache"), [], "A different Chat never borrows the first Chat's Memory");
    const { chatRetrievalReceipt, validChatRetrievalReceipt } = require("../dist/chat/chat-retrieval");
    const knowledge = Array.from({ length: 30 }, (_, index) => ({ id: `pkm://fixture/${index}`, kind: ["skill", "note", "script", "recipe", "research", "api", "function"][index % 7],
      label: `Cache reference ${index}`, sourceUri: `pkm://fixture/${index}`, method: "lexical:unified-retrieval", score: 30 - index,
      scoreComponents: { lexical: 30 - index, semantic: 0 }, selected: index < 3, reason: index < 3 ? "Included in bounded context" : "Outside budget", content: "reference-body-must-not-be-copied" }));
    const receipt = chatRetrievalReceipt(memoryChat, "AAGL cache design", "actual-model", knowledge);
    assert.strictEqual(receipt.model, "actual-model"); assert.strictEqual(receipt.sessionId, groupChat.sessionId);
    assert.strictEqual(receipt.candidates.length, 20); assert(validChatRetrievalReceipt(receipt, memoryChat.id));
    assert(!JSON.stringify(receipt).includes("reference-body-must-not-be-copied"));
    assert(receipt.candidates.some(candidate => candidate.kind === "api") && receipt.candidates.some(candidate => candidate.kind === "function"), "Candidate contract accepts future source types without executing them");
    assert(receipt.candidates.some(candidate => candidate.kind === "memory" && candidate.method === "rule:recent-history" && candidate.selected));
    assert(receipt.candidates.some(candidate => candidate.kind === "note" && candidate.selected && candidate.score === 29));
    assert(!validChatRetrievalReceipt(receipt, "different-chat"));
    assert(!validChatRetrievalReceipt({ ...receipt, candidates: [...receipt.candidates, receipt.candidates[0]] }, memoryChat.id));
    for (const candidate of [null, "malformed", 42, { ...receipt.candidates[0], score: NaN }, { ...receipt.candidates[0], content: "private duplicated body" }]) {
      assert.strictEqual(validChatRetrievalReceipt({ ...receipt, candidates: [candidate] }, memoryChat.id), false);
    }
    const isolated = chatRetrievalReceipt({ ...groupChat, messages: [], memoryTasks: [] }, "AAGL cache", "another-model");
    assert.deepStrictEqual(isolated.candidates, []);
    const withoutHistory = chatRetrievalReceipt({ ...memoryChat, includeHistory: false }, "AAGL cache", "actual-model");
    assert(withoutHistory.candidates.every(candidate => !candidate.selected));
    const { ApiChatAgentControl } = require("../dist/chat/agent-control");
    let controlCalls = 0;
    const control = new ApiChatAgentControl(directory, { workspacePaths: [directory] }, async (_operation, args) => { controlCalls++; return { echoed: args.title }; });
    const controlDirectory = path.join(directory, "api-chat-control", "requests", control.hostId);
    const controlRequest = { schema: "pkm.api-chat.request/v1", requestId: "a".repeat(64), hostId: control.hostId, operation: "create", arguments: { title: "Visible fixture" }, status: "queued", expiresAt: Date.now() + 30_000 };
    const controlPath = path.join(controlDirectory, controlRequest.requestId + ".json");
    fs.writeFileSync(controlPath, JSON.stringify(controlRequest)); control.poll(); control.poll();
    await new Promise(resolve => setImmediate(resolve));
    assert.strictEqual(controlCalls, 1); assert.strictEqual(JSON.parse(fs.readFileSync(controlPath)).result.echoed, "Visible fixture");
    control.poll(); assert.strictEqual(controlCalls, 1, "Completed control requests must never be replayed");
    const expiredControlPath = path.join(controlDirectory, "b".repeat(64) + ".json");
    fs.writeFileSync(expiredControlPath, JSON.stringify({ ...controlRequest, requestId: "b".repeat(64), expiresAt: 0 })); control.poll();
    assert.strictEqual(JSON.parse(fs.readFileSync(expiredControlPath)).status, "failed"); assert.strictEqual(controlCalls, 1);
    const wrongControlPath = path.join(controlDirectory, "c".repeat(64) + ".json");
    fs.writeFileSync(wrongControlPath, JSON.stringify({ ...controlRequest, requestId: "c".repeat(64), hostId: "other-host" })); control.poll();
    assert.strictEqual(JSON.parse(fs.readFileSync(wrongControlPath)).status, "failed"); assert.strictEqual(controlCalls, 1);
    control.dispose(); assert(!fs.existsSync(path.join(directory, "api-chat-control", "hosts", control.hostId + ".json")));
    const store = new ApiChatStore(directory, "0123456789abcdef");
    const chat = store.create();
    const secondWorkspace = new ApiChatStore(directory, "fedcba9876543210");
    const sharedUrl = `pkm://chats/${store.namespace}/${chat.id}`;
    assert.strictEqual(secondWorkspace.resolveChat(sharedUrl).id, chat.id, "a stored Chat URL must resolve from another workspace without copying history");
    assert.strictEqual(secondWorkspace.list().find(item => item.id === chat.id).workspaceNamespace, store.namespace);
    assert.throws(() => secondWorkspace.resolveChat(`pkm://chats/${secondWorkspace.namespace}/${chat.id}`), /stored identity/);
    assert.throws(() => secondWorkspace.resolveChat(`pkm://chats/${store.namespace}/../${chat.id}`), /traversal/);
    const { captureExecutionContext, validExecutionContext } = require("../dist/chat/execution-context");
    const contextRoot = path.join(directory, "execution-context-fixture");
    const contextStore = new ApiChatStore(path.join(contextRoot, ".pkm", "state"), store.namespace);
    const contextViewer = new ApiChatStore(contextStore.stateDirectory, secondWorkspace.namespace);
    const contextChat = contextStore.create();
    const executionContext = captureExecutionContext(require("crypto").randomUUID(), [{ uri: { scheme: "file", fsPath: directory, toString: () => require("url").pathToFileURL(directory).toString() } }], contextRoot, true, "protective");
    assert(validExecutionContext(executionContext));
    assert(Object.isFrozen(executionContext) && Object.isFrozen(executionContext.workspacePaths));
    assert(!validExecutionContext({ ...executionContext, trusted: false }));
    assert.strictEqual(executionContext.cwd, fs.realpathSync(directory));
    contextChat.messages.push({ id: "context-user", role: "user", content: "origin", status: "complete", executionContext });
    contextChat.progress = { startedAt: Date.now(), status: "complete", model: "fixture", steps: [], executionContext };
    contextChat.queuedInputs = [{ id: require("crypto").randomUUID(), text: "queued origin", mode: "task", executionContext }];
    contextStore.save(contextChat);
    const contextBytes = fs.readFileSync(contextStore.file(contextChat.id));
    const contextRestored = contextViewer.load(contextChat.id, false);
    assert.deepStrictEqual(contextRestored.messages[0].executionContext, executionContext);
    assert.deepStrictEqual(contextRestored.progress.executionContext, executionContext);
    assert.deepStrictEqual(contextRestored.queuedInputs[0].executionContext, executionContext);
    assert.throws(() => contextViewer.assertRunnable(contextRestored), /another workspace/);
    assert.doesNotThrow(() => contextViewer.assertRunnable(contextRestored, undefined, executionContext));
    assert.throws(() => contextViewer.assertRunnable(contextRestored, undefined, { ...executionContext, accountId: "0".repeat(64) }), /Knowledge Root/);
    const otherContextRoot = path.join(directory, "other-execution-root");
    fs.mkdirSync(path.join(otherContextRoot, ".pkm", "state"), { recursive: true });
    const otherExecutionContext = captureExecutionContext(require("crypto").randomUUID(), [], otherContextRoot, true, "protective");
    assert.throws(() => contextViewer.assertRunnable(contextRestored, undefined, otherExecutionContext), /Knowledge Root/);
    const queuedChat = contextStore.create();
    queuedChat.progress = { attemptId: require("crypto").randomUUID(), executionContext, attempt: 1, ownerPid: process.pid, ownerHost: require("os").hostname(), startedAt: Date.now(), status: "running", model: "fixture", steps: [] };
    queuedChat.messages.push({ id: "queue-reply", role: "assistant", content: "partial", status: "streaming" });
    contextStore.save(queuedChat);
    const foreignQueueContext = captureExecutionContext(require("crypto").randomUUID(), [], contextRoot, true, "protective");
    const foreignQueuedInput = { id: require("crypto").randomUUID(), text: "From another window", mode: "task", executionContext: foreignQueueContext };
    const staleViewerChat = contextViewer.load(queuedChat.id, false);
    contextViewer.enqueueInput(staleViewerChat, foreignQueuedInput);
    contextViewer.enqueueInput(staleViewerChat, foreignQueuedInput);
    assert.strictEqual(contextViewer.load(queuedChat.id, false).queuedInputs.length, 1, "duplicate foreign delivery must be idempotent");
    assert.throws(() => contextViewer.enqueueInput(staleViewerChat, { ...foreignQueuedInput, text: "Retargeted text" }), /different text or execution context/);
    assert.throws(() => contextViewer.enqueueInput(staleViewerChat, { ...foreignQueuedInput, id: require("crypto").randomUUID(), mode: "steer" }), /different execution context/);
    queuedChat.messages[0].content += " output";
    contextStore.save(queuedChat);
    assert.strictEqual(contextViewer.load(queuedChat.id, false).messages[0].content, "partial output");
    assert.deepStrictEqual(queuedChat.queuedInputs, [foreignQueuedInput], "active output must preserve concurrently submitted work");
    const secondForeignInput = { ...foreignQueuedInput, id: require("crypto").randomUUID(), text: "Second foreign task" };
    contextViewer.enqueueInput(staleViewerChat, secondForeignInput);
    contextStore.assertRunnable(queuedChat, queuedChat.progress.attemptId, executionContext);
    assert.deepStrictEqual(queuedChat.queuedInputs.map(input => input.id), [foreignQueuedInput.id, secondForeignInput.id]);
    const queueWriter = require("child_process").spawnSync(process.execPath, ["-e", `
      const { ApiChatStore } = require(${JSON.stringify(path.join(__dirname, "../dist/chat/api-chat-store"))});
      const { captureExecutionContext } = require(${JSON.stringify(path.join(__dirname, "../dist/chat/execution-context"))});
      const root = process.argv[1];
      const store = new ApiChatStore(require("path").join(root, ".pkm", "state"), process.argv[2]);
      const input = { id: require("crypto").randomUUID(), text: "Independent process input", mode: "task", executionContext: captureExecutionContext(require("crypto").randomUUID(), [], root, true, "protective") };
      store.enqueueInput(store.load(process.argv[3], false), input);
      process.stdout.write(JSON.stringify(input));
    `, contextRoot, contextViewer.namespace, queuedChat.id], { encoding: "utf8" });
    assert.strictEqual(queueWriter.status, 0, queueWriter.stderr);
    const crossProcessInput = JSON.parse(queueWriter.stdout);
    queuedChat.progress.status = "complete";
    queuedChat.messages[0].status = "complete";
    contextStore.save(queuedChat);
    assert.deepStrictEqual(contextViewer.load(queuedChat.id, false).queuedInputs.map(input => input.id), [foreignQueuedInput.id, secondForeignInput.id, crossProcessInput.id], "finishing the owner request must preserve independently submitted work");
    const concurrentChange = contextViewer.load(queuedChat.id, false);
    concurrentChange.title = "Changed elsewhere";
    contextViewer.save(concurrentChange);
    queuedChat.title = "Stale overwrite";
    assert.throws(() => contextStore.save(queuedChat), /changed in another window/, "queue reconciliation must not merge unrelated changes");
    for (const location of ["message", "progress", "queue"]) {
      const damaged = JSON.parse(contextBytes);
      const holder = location === "message" ? damaged.messages[0] : location === "progress" ? damaged.progress : damaged.queuedInputs[0];
      holder.executionContext.cwd = path.join(directory, "different-root");
      fs.writeFileSync(contextStore.file(contextChat.id), JSON.stringify(damaged));
      assert.throws(() => contextViewer.load(contextChat.id, false), /Unsupported chat history/);
    }
    fs.writeFileSync(contextStore.file(contextChat.id), contextBytes);
    const delegationParent = contextStore.create();
    const delegationTarget = contextViewer.create();
    const delegation = { id: require("crypto").randomUUID(), chatId: delegationTarget.id, chatUrl: `pkm://chats/${contextViewer.namespace}/${delegationTarget.id}`, status: "complete", answer: "Across workspace aliases" };
    delegationParent.messages.push({ id: "cross-namespace-reply", role: "assistant", content: "Delegated result", status: "complete", delegations: [delegation] });
    contextStore.save(delegationParent);
    assert.strictEqual(contextViewer.list().find(item => item.id === delegationParent.id).workerManager, true,
      "Dispatch receipts expose durable manager identity in every window's library");
    assert.strictEqual(contextViewer.list().find(item => item.id === delegationTarget.id).workerManager, undefined,
      "Ordinary Chats are not promoted to manager by being listed");
    assert.deepStrictEqual(contextViewer.load(delegationParent.id, false).messages[0].delegations[0], delegation, "target aliases must not be rewritten to the parent's namespace");
    assert.strictEqual(chat.sessionId, undefined);
    assert(!fs.existsSync(path.join(directory, "agent-sessions")));
    store.assertRunnable(chat); assert.strictEqual(store.load(chat.id).sessionId, undefined);
    store.startTask(chat, "Explicit coding Task");
    assert.throws(() => store.startTask(chat, "Another Task"), /current Task/);
    const diagnosisRoot = path.join(directory, "diagnostics");
    const diagnosisStore = new ApiChatStore(path.join(diagnosisRoot, ".pkm/state"), "0123456789abcdef");
    const diagnosisChat = diagnosisStore.create(); diagnosisStore.startTask(diagnosisChat, "Diagnostics Task");
    assert.strictEqual(diagnosisChat.permissionMode, "protective");
    assert.strictEqual(diagnosisChat.toolSelection, undefined);
    const sessionFile = path.join(diagnosisRoot, ".pkm/state/agent-sessions", `${diagnosisChat.sessionId}.json`);
    const sessionBytes = fs.readFileSync(sessionFile);
    const command = require("child_process").spawnSync(process.execPath, [path.join(__dirname, "../scripts/export-chat-diagnostics.js"), diagnosisRoot, diagnosisChat.sessionId], { encoding: "utf8" });
    assert.strictEqual(command.status, 0, command.stderr); assert.strictEqual(JSON.parse(command.stdout).sessionId, diagnosisChat.sessionId);
    assert(fs.readFileSync(sessionFile).equals(sessionBytes));
    assert.throws(() => apiChatSessionDiagnostics({ ...JSON.parse(sessionBytes), origin: "external", runtimeOwner: "external" }, diagnosisChat.sessionId), /PKM-native/);
    assert.throws(() => apiChatSessionDiagnostics(JSON.parse(sessionBytes), "../outside"), /PKM-native/);
    assert.strictEqual(apiChatStatus(chat), "idle");
    assert.strictEqual(apiChatStatus(chat, true), "running");
    assert.strictEqual(apiChatStatus(chat, true, true), "awaiting-input");
    chat.title = "Custom saved title"; chat.customTitle = true; chat.lastResultId = "unread-result";
    assert.strictEqual(apiChatStatus(chat), "new-result");
    const completedChat = { ...chat, readResultId: chat.lastResultId, messages: [{ id: "complete", role: "assistant", content: "done", status: "complete" }] };
    assert.strictEqual(apiChatStatus(completedChat), "completed", "reading a result must not erase successful completion");
    assert.strictEqual(apiChatStatus({ ...completedChat, messages: [{ ...completedChat.messages[0], delegations: [{ status: "running" }] }] }), "awaiting-result");
    assert.strictEqual(apiChatStatus({ ...completedChat, messages: [{ ...completedChat.messages[0], status: "cancelled" }] }), "stopped");
    assert.strictEqual(apiChatStatus({ ...completedChat, progress: { status: "running", steps: [{ status: "waiting" }] } }), "awaiting-input");
    chat.messages.push({ id: "reply", role: "assistant", content: "partial", status: "streaming" });
    store.save(chat);
    const sourcePath = path.join(directory, "agent-sessions", chat.sessionId + ".json");
    const session = JSON.parse(fs.readFileSync(sourcePath, "utf8"));
    assert.deepStrictEqual(agentSessionOrigin(session), { origin: "pkm-native", runtimeOwner: "pkm" });
    assert.strictEqual(session.hostKind, "pkm");
    assert.strictEqual(session.status, "running");
    assert.deepStrictEqual(session.todos, []);
    assert.strictEqual(session.task, "Explicit coding Task");
    const groupPath = path.join(directory, "agent-groups", session.groupId + ".json");
    assert.strictEqual(JSON.parse(fs.readFileSync(groupPath)).title, chat.title);
    assert.strictEqual(session.nativeChat.messages[0].content, "partial");
    if (process.platform !== "win32") assert.strictEqual(fs.statSync(sourcePath).mode & 0o777, 0o600);
    const restored = store.load(chat.id);
    assert.strictEqual(restored.title, "Custom saved title"); assert.strictEqual(restored.customTitle, true);
    assert.strictEqual(apiChatStatus(restored), "failed");
    restored.readResultId = restored.lastResultId;
    assert.strictEqual(apiChatStatus(restored), "failed");
    assert.strictEqual(restored.messages[0].status, "interrupted");
    const diagnostic = apiChatDiagnostics({ ...restored, context: [{ id: "private", label: "private", content: "context-secret" }], images: [testImage], mcpServers: [{ url: "https://endpoint-secret", label: "label-secret", enabled: true, tools: ["lookup"] }], messages: [{ ...restored.messages[0], content: "prompt-secret", error: "server-secret", toolCalls: [{ name: "lookup", status: "failed", arguments: "argument-secret", result: "result-secret" }] }] });
    for (const secret of ["context-secret", "endpoint-secret", "label-secret", "prompt-secret", "server-secret", "argument-secret", "result-secret", testImage.dataBase64]) assert(!JSON.stringify(diagnostic).includes(secret));
    assert.strictEqual(diagnostic.attempts[0].errorKind, "other");
    const usageDiagnostic = apiChatDiagnostics({ ...restored, messages: [{ ...restored.messages[0], usage: { inputTokens: 12, outputTokens: 3, private: "usage-secret" }, usageMetadata: { frames: 2, validFrames: 1, invalidFrames: 1, private: "metadata-secret" } }] });
    assert.deepStrictEqual(usageDiagnostic.attempts[0].reportedTokenUsage, { inputTokens: 12, outputTokens: 3 });
    assert.deepStrictEqual(usageDiagnostic.attempts[0].usageMetadata, { frames: 2, validFrames: 1, invalidFrames: 1 });
    assert(!JSON.stringify(usageDiagnostic).includes("usage-secret")); assert(!JSON.stringify(usageDiagnostic).includes("metadata-secret"));
    store.save(restored);
    assert.strictEqual(JSON.parse(fs.readFileSync(sourcePath)).status, "paused");
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(sourcePath)).todos, []);
    assert.strictEqual(store.list()[0].id, chat.id);
    assert.strictEqual(store.list()[0].status, "failed");
    restored.images = [testImage]; restored.messages[0].images = [testImage];
    restored.messages[0].changes = [{ path: "file.ts", workspace: 0, appliedAt: new Date().toISOString(), beforeHash: "a".repeat(64), afterHash: "b".repeat(64), added: 2, removed: 1, saved: false, attribution: "exact" }];
    store.save(restored);
    assert.strictEqual(store.load(chat.id).images[0].dataBase64, testImage.dataBase64);
    assert.strictEqual(store.load(chat.id).messages[0].changes[0].added, 2);
    assert.strictEqual(JSON.parse(fs.readFileSync(sourcePath)).nativeChat.messages[0].images[0].dataBase64, testImage.dataBase64);
    restored.images.push(testImage, testImage); assert.throws(() => store.save(restored), /two images/); restored.images = [];
    const external = { ...JSON.parse(fs.readFileSync(sourcePath)), origin: "external", runtimeOwner: "external", hostKind: "copilot" };
    fs.writeFileSync(sourcePath, JSON.stringify(external));
    assert.throws(() => store.assertRunnable(restored), /not owned/);
    assert.throws(() => store.save(restored), /not owned/);
    assert.strictEqual(JSON.parse(fs.readFileSync(sourcePath)).origin, "external");
    fs.writeFileSync(sourcePath, JSON.stringify(session));
    const corrupt = store.create();
    corrupt.updatedAt = 42; corrupt.context = [{ id: "bad", label: "bad", content: null }];
    fs.writeFileSync(path.join(directory, "api-chats", "0123456789abcdef", `${corrupt.id}.json`), JSON.stringify(corrupt));
    assert.throws(() => store.load(corrupt.id), /format/);
    assert.deepStrictEqual(store.list().map(item => item.id), [chat.id]);
    assert.throws(() => store.load("../secret"), /identity/);
    assert.deepStrictEqual(agentSessionOrigin({ hostKind: "copilot" }), { origin: "external", runtimeOwner: "external" });
    assert.deepStrictEqual(agentSessionOrigin({ agent: { name: "PKM" } }), { origin: "unknown", runtimeOwner: "unknown" });
    session.status = "stopped";
    fs.writeFileSync(sourcePath, JSON.stringify(session));
    assert.throws(() => store.assertAvailable(restored), /stopped/);
    store.save(restored);
    assert.strictEqual(JSON.parse(fs.readFileSync(sourcePath)).status, "stopped");
    const trash = path.join(directory, "agent-sessions-trash"); fs.mkdirSync(trash);
    fs.renameSync(sourcePath, path.join(trash, chat.sessionId + ".json"));
    assert.throws(() => store.assertAvailable(restored), /Trash/);
    store.save(restored);
    assert(!fs.existsSync(sourcePath), "Saving partial chat output must not restore a trashed Session");
    fs.unlinkSync(path.join(trash, chat.sessionId + ".json"));
    store.save(restored);
    assert(!fs.existsSync(sourcePath), "Saving a chat must not recreate a deleted Session");
    store.completeTask(restored); store.assertRunnable(restored);
    store.startTask(restored, "Second Task in the same Chat");
    const secondPath = path.join(directory, "agent-sessions", restored.sessionId + ".json");
    assert.strictEqual(JSON.parse(fs.readFileSync(secondPath)).groupId, session.groupId);
    assert.notStrictEqual(restored.sessionId, chat.sessionId);
    store.completeTask(restored);
    assert.strictEqual(JSON.parse(fs.readFileSync(secondPath)).status, "completed");
    assert.strictEqual(restored.sessionId, undefined); store.assertRunnable(restored);
    store.startTask(restored, "Task with real Todo evidence");
    const evidencePath = path.join(directory, "agent-sessions", restored.sessionId + ".json");
    const evidence = JSON.parse(fs.readFileSync(evidencePath));
    evidence.todos = [{ todoId: "legacy", nativeChatMessageId: "reply", status: "running", title: "Preserved evidence" }];
    fs.writeFileSync(evidencePath, JSON.stringify(evidence));
    store.save(restored);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(evidencePath)).todos, evidence.todos);
    assert.throws(() => store.completeTask(restored), /unfinished Todos/);
    assert(restored.sessionId);
    evidence.todos[0].status = "succeeded"; fs.writeFileSync(evidencePath, JSON.stringify(evidence));
    store.completeTask(restored);
    assert.strictEqual(JSON.parse(fs.readFileSync(evidencePath)).todos[0].status, "succeeded");
    const otherWindow = new ApiChatStore(directory, "fedcba9876543210");
    assert(otherWindow.list().some(item => item.id === restored.id));
    const stale = otherWindow.load(restored.id);
    restored.title = "Newest title"; store.save(restored);
    assert.throws(() => otherWindow.save(stale), /another window/);
    assert.strictEqual(otherWindow.load(restored.id).title, "Newest title");
    const folder = store.library.createGroup("Coding");
    otherWindow.library.move(restored.id, folder);
    assert.strictEqual(store.list().find(item => item.id === restored.id).groupId, folder);
    assert.throws(() => store.library.createGroup("coding"), /already exists/);
    store.library.renameGroup(folder, "Work");
    assert.strictEqual(otherWindow.library.read().groups[0].name, "Work");
    store.trashChat(restored.id); assert(!otherWindow.list().some(item => item.id === restored.id));
    assert(otherWindow.list(true).find(item => item.id === restored.id).trashedAt);
    assert.throws(() => store.assertRunnable(restored), /Trash/);
    assert.throws(() => store.save(restored), /Trash/);
    otherWindow.library.restore(restored.id);
    assert(otherWindow.list().some(item => item.id === restored.id));
    store.library.deleteGroup(folder);
    assert.strictEqual(otherWindow.list().find(item => item.id === restored.id).groupId, "ungroup");
    assert.throws(() => store.deleteChat(restored.id), /Trash/);
    store.trashChat(restored.id); store.deleteChat(restored.id);
    assert(!otherWindow.list(true).some(item => item.id === restored.id));
    assert.throws(() => otherWindow.save(restored), /deleted in another window/);
    const running = store.create();
    running.progress = { attemptId: "owned-attempt", startedAt: Date.now(), status: "running", model: "test", steps: [] };
    store.save(running);
    const remote = otherWindow.load(running.id, false);
    assert.strictEqual(remote.progress.status, "running");
    assert.throws(() => otherWindow.assertRunnable(remote), /already running/);
    assert.throws(() => otherWindow.assertRunnable(remote, "wrong-attempt"), /already running/);
    store.assertRunnable(running, "owned-attempt");
    assert.throws(() => otherWindow.trashChat(running.id), /running Chat/);
    assert.strictEqual(store.recoverAbandoned(running), false, "Legacy requests without owner evidence must not be recovered automatically");
    running.progress.ownerPid = process.pid; running.progress.ownerHost = os.hostname(); store.save(running);
    assert.strictEqual(otherWindow.recoverAbandoned(otherWindow.load(running.id, false)), false);
    const exited = require("child_process").spawnSync(process.execPath, ["-e", ""], { stdio: "ignore" });
    assert.strictEqual(exited.status, 0);
    running.progress.ownerPid = exited.pid; store.save(running);
    const abandoned = otherWindow.load(running.id, false);
    assert.strictEqual(otherWindow.recoverAbandoned(abandoned), true);
    assert.strictEqual(abandoned.progress.status, "failed");
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  let body;
  let output = "";
  await streamApiChat({ ...base, fetch: async (url, options) => {
    assert.strictEqual(String(url), "https://example.test/v1/chat/completions");
    body = JSON.parse(options.body);
    const response = delta("hello ") + delta("world") + done;
    return events([response.slice(0, 17), response.slice(17, 43), response.slice(43)]);
  } }, text => { output += text; });
  assert.strictEqual(output, "hello world");
  assert.strictEqual(body.stream, true);
  assert.strictEqual(body.model, "test-model");
  assert.deepStrictEqual(body.messages, base.messages);
  const stages = [];
  let usage;
  await streamApiChat({ ...base, maxOutputTokens: 256, outputTokenParameter: "max_completion_tokens", includeUsage: true,
    onStage: stage => stages.push(stage), onUsage: value => { usage = value; }, fetch: async (_, options) => {
      const payload = JSON.parse(options.body);
      assert.strictEqual(payload.max_completion_tokens, 256);
      assert.deepStrictEqual(payload.stream_options, { include_usage: true });
      return events([delta("usage"), 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n', 'data: {"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":20,"total_tokens":120}}\n\ndata: [DONE]\n\n']);
    } }, () => {});
  assert.deepStrictEqual(stages, ["connecting", "waiting"]);
  assert.strictEqual(usage.inputTokens, 100);
  assert.strictEqual(usage.outputTokens, 20);

  await streamApiChat({ ...base, provider: "azure-openai", model: "deployment name", fetch: async (url, options) => {
    const parsed = new URL(url);
    assert.strictEqual(parsed.pathname, "/v1/openai/deployments/deployment%20name/chat/completions");
    assert.strictEqual(parsed.searchParams.get("api-version"), "2024-06-01");
    assert.strictEqual(new Headers(options.headers).get("api-key"), "test-key");
    return events([delta("Azure"), done]);
  } }, () => {});

  await assert.rejects(streamApiChat({ ...base, endpoint: "http://example.test/v1" }, () => {}), /HTTPS/);
  await assert.rejects(streamApiChat({ ...base, endpoint: "https://user:secret@example.test" }, () => {}), /credentials/);
  await assert.rejects(streamApiChat({ ...base, fetch: async () => { throw new Error("private connection details"); } }, () => {}), /Cannot connect to the model API/);
  await assert.rejects(streamApiChat({ ...base, fetch: async () => new Response("private server error", { status: 401 }) }, () => {}), error => {
    assert(!error.message.includes("private server error"));
    return /HTTP 401/.test(error.message);
  });
  await assert.rejects(streamApiChat({ ...base, fetch: async () => events([delta("partial")]) }, () => {}), /before completion/);
  const hang = async (url, options) => new Promise((resolve, reject) => {
    const abort = () => reject(new DOMException("Aborted", "AbortError"));
    options.signal.addEventListener("abort", abort, { once: true });
    if (options.signal.aborted) abort();
  });
  await assert.rejects(streamApiChat({ ...base, fetch: hang, timeoutMs: 10 }, () => {}), /timed out/);
  const cancelled = new AbortController();
  const waiting = streamApiChat({ ...base, signal: cancelled.signal, fetch: hang }, () => {});
  cancelled.abort();
  await assert.rejects(waiting, /cancelled/);
  const healthy = streamApiChat({ ...base, fetch: async () => events([delta("independent"), done]) }, () => {});
  await healthy;
  let controllerTimeout;
  try {
    await Promise.race([testController(), new Promise((_, reject) => { controllerTimeout = setTimeout(() => reject(new Error("Chat controller test timed out with an unresolved operation")), 10_000); })]);
  } finally { clearTimeout(controllerTimeout); }
  await testCrossProcessStore();
  await testAcceptanceIsolation();
  await testVscodeModels();
  await testToolLoop();
  await testNativeTools();
  await testMcp();
  await testVscodeTools();
  console.log("API chat transport tests passed: streaming, Azure, validation, redaction, truncation, timeout and cancellation.");
})().catch(error => { console.error(error); process.exitCode = 1; });

async function testCrossProcessStore() {
  const { spawn } = require("child_process");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-chat-process-race-"));
  const children = [];
  try {
    const store = new ApiChatStore(directory, "0123456789abcdef");
    const { handleChatLibraryAction } = require("../dist/chat/library-actions");
    const libraryChat = store.create(); store.startTask(libraryChat, "Preserved Task");
    const sessionFile = path.join(directory, "agent-sessions", libraryChat.sessionId + ".json");
    store.completeTask(libraryChat);
    const inputs = ["Work", "Renamed work"];
    let approval;
    const forgotten = [];
    const host = { window: { showInputBox: async () => inputs.shift(), showQuickPick: async items => items.at(-1), showWarningMessage: async () => approval } };
    const action = message => handleChatLibraryAction(message, store, host, () => false, id => forgotten.push(id));
    await action({ type: "groupCreate" });
    const folder = store.library.read().groups[0].id;
    await action({ type: "groupRename", id: folder });
    assert.strictEqual(store.library.read().groups[0].name, "Renamed work");
    await action({ type: "moveChat", id: libraryChat.id });
    assert.strictEqual(store.list().find(item => item.id === libraryChat.id).groupId, folder);
    await action({ type: "trashChat", id: libraryChat.id });
    assert(store.list().some(item => item.id === libraryChat.id), "Cancelled Trash must not remove a Chat");
    approval = "Move to Trash"; await action({ type: "trashChat", id: libraryChat.id });
    assert(!store.list().some(item => item.id === libraryChat.id));
    await action({ type: "restoreChat", id: libraryChat.id });
    approval = "Delete group"; await action({ type: "groupDelete", id: folder });
    assert.strictEqual(store.list().find(item => item.id === libraryChat.id).groupId, "ungroup");
    approval = "Delete permanently";
    await assert.rejects(action({ type: "deleteChat", id: libraryChat.id }), /Trash/);
    approval = "Move to Trash"; await action({ type: "trashChat", id: libraryChat.id });
    approval = "Empty Trash"; await action({ type: "emptyTrash" });
    assert(!store.list(true).some(item => item.id === libraryChat.id));
    assert(fs.existsSync(sessionFile), "Chat deletion must preserve Task evidence");
    assert(forgotten.includes(libraryChat.id));
    const chat = store.create();
    const source = `const { ApiChatStore } = require(${JSON.stringify(path.resolve(__dirname, "../dist/chat/api-chat-store"))});
      const store = new ApiChatStore(${JSON.stringify(directory)}, "0123456789abcdef");
      const chat = store.load(${JSON.stringify(chat.id)}, false);
      process.on("message", title => { chat.title = title; try { store.save(chat); process.send({saved:true}); }
        catch(error) { process.send({saved:false,error:error.message}); } finally { process.disconnect(); } });
      process.send("ready");`;
    const workers = ["First writer", "Second writer"].map(title => {
      const child = spawn(process.execPath, ["-e", source], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
      children.push(child);
      const ready = new Promise((resolve, reject) => { child.on("message", value => { if (value === "ready") resolve(); }); child.on("error", reject); child.on("exit", code => { if (code !== 0) reject(new Error(`Writer exited ${code}`)); }); });
      const result = new Promise((resolve, reject) => { child.on("message", value => { if (value !== "ready") resolve(value); }); child.on("error", reject); child.on("exit", code => { if (code !== 0) reject(new Error(`Writer exited ${code}`)); }); });
      return { child, ready, result, title };
    });
    await Promise.all(workers.map(worker => worker.ready));
    workers.forEach(worker => worker.child.send(worker.title));
    const results = await Promise.all(workers.map(worker => worker.result));
    assert.strictEqual(results.filter(result => result.saved).length, 1);
    assert.match(results.find(result => !result.saved).error, /another window/);
    assert(["First writer", "Second writer"].includes(store.load(chat.id, false).title));
    console.log("Chat library actions and cross-process tests passed: CRUD, cancelled Trash, evidence retention and exactly one concurrent writer.");
  } finally {
    for (const child of children) if (child.exitCode === null) child.kill();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

async function testAcceptanceIsolation() {
  const Module = require("module");
  const originalLoad = Module._load;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-chat-acceptance-regression-"));
  const modulePath = require.resolve("../dist/chat/api-chat-acceptance");
  try {
    Module._load = function(name, parent, ...rest) {
      if (parent?.filename === modulePath) {
        if (name === "vscode") return { workspace: { isTrusted: true, workspaceFolders: [{ uri: { scheme: "file", fsPath: directory } }] }, window: { showWarningMessage: async () => "Run E2E", showQuickPick: async items => items[0], showInformationMessage: async () => {} } };
        if (name === "./api-chat-vscode") return { discoverVscodeModels: async () => [{ name: "Fixture", vendor: "test" }], vscodeModelProfile: () => ({ id: "fixture", label: "Fixture", contextWindow: 8192, maxOutputTokens: 2048 }) };
        if (name === "./api-chat-mcp") return { vscodeToolCatalog: () => [] };
      }
      return originalLoad.call(this, name, parent, ...rest);
    };
    delete require.cache[modulePath];
    const { runApiChatAcceptance } = require(modulePath);
    Module._load = originalLoad;
    const store = new ApiChatStore(path.join(directory, "state"), "0123456789abcdef");
    let chat;
    await runApiChatAcceptance(() => chat = store.create(), async (target, prompt) => {
      const reply = { id: "fixture-reply-" + target.messages.length, role: "assistant", status: "complete", content: prompt.includes("PKM_E2E_USAGE_OK") ? "PKM_E2E_USAGE_OK" : "Scripted regression", toolCalls: [] };
      if (target.builtinTools?.includes("run_process")) {
        const relative = fs.readdirSync(directory).find(name => name.startsWith("chat-e2e-"));
        const file = path.join(directory, relative, "module.cjs");
        fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("left - right", "left + right"));
        const stdout = require("child_process").execFileSync(process.execPath, [`${relative}/test.cjs`], { cwd: directory, encoding: "utf8" });
        reply.toolCalls = ["read_file", "replace_text", "save_file"].map(name => ({ name, status: "complete", arguments: "{}" }));
        reply.toolCalls.push({ name: "run_process", status: "complete", arguments: JSON.stringify({ program: process.execPath, arguments: [`${relative}/test.cjs`] }), result: JSON.stringify({ exitCode: 0, stdout }) });
      }
      target.messages.push(reply);
    }, target => store.save(target));
    const fixture = fs.readdirSync(directory).find(name => name.startsWith("chat-e2e-"));
    const report = JSON.parse(fs.readFileSync(path.join(directory, fixture, "acceptance.json")));
    assert.strictEqual(report.status, "failed");
    assert.deepStrictEqual(report.steps.map(step => step.name), ["usage", "pkm-mcp", "pkm-documents", "recipe-document", "session-status", "coding"]);
    assert.strictEqual(report.steps.find(step => step.name === "pkm-mcp").verdict, "failed");
    assert.strictEqual(report.steps.find(step => step.name === "coding").verdict, "succeeded");
    assert.strictEqual(report.steps.find(step => step.name === "coding").testUnchanged, true);
    assert.match(chat.title, /^E2E .* UTC$/);
    assert.strictEqual(chat.sessionId, undefined);
    console.log("Chat acceptance regression passed: scripted MCP failure does not skip coding; immutable fixture test ran with Node.");
  } finally { Module._load = originalLoad; delete require.cache[modulePath]; fs.rmSync(directory, { recursive: true, force: true }); }
}

function testControlRegistration(directory) {
  let root = "";
  const timers = [];
  const subscriptions = [];
  const disposable = { dispose() {} };
  const registered = {};
  const workspacePaths = [directory];
  const vscode = {
    workspace: {
      workspaceFolders: workspacePaths.map(fsPath => ({ uri: { scheme: "file", fsPath } })),
      onDidChangeConfiguration: () => disposable,
    },
    window: { registerWebviewViewProvider: () => disposable },
    commands: { registerCommand: () => disposable },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../dist/chat/api-chat-view.js"), "utf8"), {
    exports: registered, console,
    require: name => {
      if (name === "vscode") return vscode;
      if (["fs", "path", "crypto", "os"].includes(name)) return require(name);
      if (name.endsWith("/filestore")) return { getStorePath: () => root };
      if (name === "./agent-control") return require("../dist/chat/agent-control");
      if (name === "./api-chat-shell") {
        const shell = {};
        vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../dist/chat/api-chat-shell.js"), "utf8"), {
          exports: shell, console,
          require: dependency => {
            if (dependency === "vscode") return vscode;
            if (["fs", "path", "crypto", "os"].includes(dependency)) return require(dependency);
            if (dependency.endsWith("/filestore")) return { getStorePath: () => root };
            if (dependency === "./agent-control") return require("../dist/chat/agent-control");
            return {};
          },
          setInterval: callback => { timers.push(callback); return { unref() {} }; },
          clearInterval() {},
        });
        return shell;
      }
      return {};
    },
    setInterval: callback => { timers.push(callback); return { unref() {} }; },
    clearInterval() {}, clearTimeout() {},
  });
  const roots = [path.join(directory, "late-root"), path.join(directory, "changed-root")];
  try {
    registered.registerApiChat({ subscriptions });
    assert.strictEqual(timers.length, 1);
    assert(!fs.existsSync(path.join(roots[0], ".pkm")), "No control directory before Root initialization");
    root = roots[0]; timers[0]();
    const hosts = location => path.join(location, ".pkm", "state", "api-chat-control", "hosts");
    const first = fs.readdirSync(hosts(root));
    assert.strictEqual(first.length, 1, "Root initialization must register a discoverable Host");
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(hosts(root), first[0]))).workspacePaths, workspacePaths);
    timers[0]();
    assert.deepStrictEqual(fs.readdirSync(hosts(root)), first, "An unchanged Root must retain one Host identity");
    root = roots[1]; timers[0]();
    assert.strictEqual(fs.readdirSync(hosts(roots[0])).length, 0, "Root change removes the old heartbeat");
    assert.strictEqual(fs.readdirSync(hosts(root)).length, 1);
    root = "relative-root"; timers[0]();
    assert.strictEqual(fs.readdirSync(hosts(roots[1])).length, 0, "A relative Root cannot publish a Host");
    root = roots[1]; timers[0]();
  } finally {
    for (const subscription of subscriptions) subscription.dispose();
  }
  assert.strictEqual(fs.readdirSync(path.join(roots[1], ".pkm", "state", "api-chat-control", "hosts")).length, 0,
    "Disposal removes the final Host heartbeat");
}

async function testController() {
  const Module = require("module");
  const client = require("../dist/chat/api-chat-client");
  const originalStream = client.streamApiChat;
  let builtin; let originalBuiltin;
  const approvalCallbacks = [];
  const originalLoad = Module._load;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-api-chat-view-"));
  const externalSkill = path.join(directory, "external.md"); fs.writeFileSync(externalSkill, "external skill snapshot");
  const imageFile = path.join(directory, "fixture.png"); fs.writeFileSync(imageFile, decodeChatImage(testImage));
  let selectedFiles = [{ scheme: "file", fsPath: externalSkill, toString: () => "file:" + externalSkill }];
  let saveDestination; let imageWrites = 0;
  let readImage = uri => fs.promises.readFile(uri.fsPath);
  const configuration = { apiChatProvider: "openai-compatible", aiEndpoint: "https://example.test/v1", aiModel: "test", apiChatModels: [], apiChatModelProfiles: [
    { id: "test", status: "active", contextWindow: 8192, maxOutputTokens: 2048, inputPricePerMillion: 1, outputPricePerMillion: 2 },
    { id: "next", model: "next-api", status: "active", contextWindow: 32768, maxOutputTokens: 1024 },
    { id: "retired-alias", model: "retired-api", status: "deprecated", contextWindow: 8192 },
  ] };
  const userState = new Map();
  const context = { globalState: { get: (key, fallback) => userState.has(key) ? userState.get(key) : fallback, update: async (key, value) => { userState.set(key, value); } }, workspaceState: { get: () => undefined, update: async () => {} }, secrets: { get: async () => "test-key" } };
  const posts = [];
  const requests = [];
  const copiedChatIds = [];
  const picks = [];
  const inputs = [];
  let sessionApproval = "Ask Session";
  let automaticPermissionApproval = true;
  let automaticDecisionApproval = true;
  const nativeConfirmations = [];
  const nativeInvocations = [];
  const registeredTools = [{ name: "mcp_pkm_list_notes", description: "List notes" }, { name: "mcp_pkm_list_skills", description: "List skills" }, { name: "foreign_list_notes", description: "Foreign tool" }];
  class MockFileSystemError extends Error { constructor(code) { super(code); this.code = code; } }
  context.globalStorageUri = { fsPath: directory, path: directory };
  let nativeClient; let originalNativeDiscovery; let originalNativeStream;
  let started;
  let provider;
  try {
    Module._load = function(name, parent, ...rest) {
      if (parent?.filename.endsWith("api-chat-view.js") && name === "../knowledge/filestore" || parent?.filename.endsWith("knowledge-reader.js") && name === "../knowledge/filestore") return { getStorePath: () => directory, noteList: () => [{ title: "Selected memory", slug: "note", content: "memory" }], noteGet: () => ({ content: "memory snapshot" }), skillList: () => [{ name: "Selected skill" }], skillGet: () => ({ content: "pkm skill snapshot" }) };
      if (parent?.filename.endsWith("knowledge-reader.js") && name === "../workflows/recipe-filesystem-store") return { RecipeFilesystemStore: class { list() { return { recipes: [{ recipeId: "recipe_fixture", name: "Selected Recipe", revision: 3, executableDigest: "a".repeat(64), definition: { spec: { nodes: [{ nodeId: "inspect", instructions: "Read actual evidence" }] } } }] }; } } };
      if (name === "vscode") return { commands: { executeCommand: async () => {} }, QuickPickItemKind: { Separator: -1 }, FileSystemError: MockFileSystemError, Uri: { joinPath: (uri, ...parts) => ({ fsPath: path.join(uri.fsPath, ...parts), path: path.join(uri.fsPath, ...parts) }) }, LanguageModelTextPart: class {}, CancellationTokenSource: class { constructor() { this.token = {}; } cancel() { this.token.cancelled = true; } dispose() {} }, lm: { tools: registeredTools, invokeTool: async (name, options) => { nativeInvocations.push({ name, options }); return { content: [] }; } }, window: { showTextDocument: async () => {}, showInformationMessage: async () => {}, showWarningMessage: async title => { nativeConfirmations.push(title); return sessionApproval; }, showQuickPick: async items => picks.length ? picks.shift()(items) : typeof items[0] === "string" ? items[0] : items.filter(item => ["read_file", "note", "Selected skill"].includes(item.id)), showInputBox: async options => { if (inputs.length) return inputs.shift()(options); throw new Error("VS Code connection must not request API credentials"); }, showOpenDialog: async () => selectedFiles, showSaveDialog: async () => saveDestination }, workspace: { workspaceFolders: [], fs: { stat: async uri => { try { return await fs.promises.stat(uri.fsPath); } catch (error) { if (error.code === "ENOENT" && uri.path?.endsWith(".toolsets.jsonc")) throw new MockFileSystemError("FileNotFound"); throw error; } }, readFile: uri => readImage(uri), writeFile: async (uri, bytes) => { imageWrites++; await fs.promises.writeFile(uri.fsPath, bytes); } }, openTextDocument: async uri => ({ getText: () => fs.readFileSync(uri.fsPath, "utf8") }), asRelativePath: uri => path.relative(directory, uri.fsPath), getConfiguration: () => ({ get: (key, fallback) => configuration[key] ?? fallback }) } };
      return originalLoad.call(this, name, parent, ...rest);
    };
    const mockedLoad = Module._load;
    const openedPkmPaths = [];
    Module._load = function(name, ...args) {
      const loaded = mockedLoad.call(this, name, ...args);
      if (name === "vscode") {
        loaded.env = { clipboard: { writeText: async value => { copiedChatIds.push(value); } } };
        loaded.commands.executeCommand = async (command, value) => { if (command === "personalKnowledge.goToPkmPath") openedPkmPaths.push(value); };
      }
      return loaded;
    };
    delete require.cache[require.resolve("../dist/chat/api-chat-view")];
    const { ApiChatView } = require("../dist/chat/api-chat-view");
    builtin = require("../dist/chat/api-chat-tools"); originalBuiltin = builtin.createBuiltinTools;
    Module._load = originalLoad;
    client.streamApiChat = (request, onText) => new Promise((resolve, reject) => {
      request.signal.addEventListener("abort", () => reject(new Error("Request cancelled.")), { once: true });
      requests.push({ request, onText, resolve, reject }); started();
    });
    builtin.createBuiltinTools = (...args) => { if (args[2]) approvalCallbacks.push(args[2]); return originalBuiltin(...args); };
    provider = new ApiChatView(context);
    provider.view = { webview: { postMessage: value => {
      posts.push(value);
      if (automaticPermissionApproval) for (const approval of value.approvals || []) queueMicrotask(() => { if (provider.approvals.has(approval.id)) void provider.handle({ type: "approval", id: approval.id, value: sessionApproval ? "approve" : "deny" }); });
      if (automaticDecisionApproval) for (const decision of value.decisions || []) queueMicrotask(() => {
        if (!provider.decisions.has(decision.id)) return;
        const choice = decision.choices.find(item => item.label === sessionApproval) || decision.choices.find(item => item.value === "cancel");
        void provider.handle({ type: "decision", id: decision.id, value: choice.value });
      });
      return Promise.resolve(true);
    } } };
    assert.deepStrictEqual(await provider.agentControl("list", {}), { chats: [], truncated: false });
    assert.strictEqual(provider.chat, undefined, "Read-only discovery must not create or adopt a Chat");
    const toolStatus = await provider.agentControl("tools", {});
    assert.strictEqual(toolStatus.toolsApiAvailable, true);
    assert.strictEqual(toolStatus.registeredCount, registeredTools.length);
    assert.deepStrictEqual(toolStatus.pkmTools, ["mcp_pkm_list_notes", "mcp_pkm_list_skills"]);
    assert.strictEqual(toolStatus.pkmCount, 2);
    assert.strictEqual(toolStatus.startupRequested, false);
    assert.strictEqual(provider.chat, undefined, "Tool diagnostics must not create or adopt a Chat");
    await assert.rejects(provider.agentControl("tools", { start: "true" }), /boolean/);
    await assert.rejects(provider.agentControl("get", { chatId: "invalid" }), /existing non-Trash/);
    assert.strictEqual(provider.store.list().length, 0);
    await provider.handle({ type: "ready" });
    assert.strictEqual(provider.chat, undefined, "Opening an empty library must not create a Chat");
    assert.strictEqual(posts.at(-1).chat, null);
    await provider.handle({ type: "libraryRefresh" });
    assert.strictEqual(provider.store.list(true).length, 0);
    await provider.handle({ type: "new" });
    const deleteFixture = provider.chat.id;
    assert.strictEqual(provider.store.list().length, 1, "Explicit New must create exactly one Chat");
    const deleteFixtureUrl = `pkm://chats/${provider.store.namespace}/${deleteFixture}`;
    await provider.openPkmChat(deleteFixtureUrl);
    assert.strictEqual(provider.chat.id, deleteFixture);
    assert.strictEqual(provider.store.list().length, 1, "Opening a URL must not create a Chat");
    assert.strictEqual((await provider.agentControl("get", { chatId: deleteFixtureUrl })).chatUrl, deleteFixtureUrl);
    assert.strictEqual((await provider.agentControl("list", {})).chats[0].chatUrl, deleteFixtureUrl);
    await provider.handle({ type: "openLink", value: deleteFixtureUrl });
    assert.deepStrictEqual(openedPkmPaths, [deleteFixtureUrl]);
    await assert.rejects(provider.handle({ type: "openLink", value: deleteFixtureUrl + "?secret=anything" }), /queries/);
    await assert.rejects(provider.openPkmChat(`pkm://chats/aaaaaaaaaaaaaaaa/${deleteFixture}`), /stored identity/);
    await assert.rejects(provider.agentControl("get", { chatId: `pkm://chats/aaaaaaaaaaaaaaaa/${deleteFixture}` }), /stored identity/);
    await assert.rejects(provider.openPkmChat(`pkm://chats/${provider.store.namespace}/00000000-0000-0000-0000-000000000000`), /existing non-Trash/);
    assert.strictEqual(requests.length, 0, "Opening and reading URLs must not invoke a model");
    const otherWindow = new ApiChatView(context);
    otherWindow.store = new ApiChatStore(provider.store.stateDirectory, "fedcba9876543210");
    const otherPosts = [];
    otherWindow.view = { webview: { postMessage: value => { otherPosts.push(value); return Promise.resolve(true); } } };
    await otherWindow.handle({ type: "ready" });
    await otherWindow.openPkmChat(deleteFixtureUrl);
    assert.strictEqual(otherWindow.chat.id, deleteFixture);
    assert.strictEqual((await otherWindow.agentControl("list", {})).chats[0].chatUrl, deleteFixtureUrl);
    assert.strictEqual(requests.length, 0, "Cross-workspace viewers must not dispatch or replay requests");
    sessionApproval = undefined;
    await provider.handle({ type: "trashChat", id: deleteFixture });
    assert.strictEqual(provider.store.list().length, 1, "Cancelled deletion must retain the Chat");
    sessionApproval = "Move to Trash";
    await provider.handle({ type: "trashChat", id: deleteFixture });
    otherWindow.refresh();
    await provider.handle({ type: "libraryRefresh" });
    await otherWindow.handle({ type: "ready" });
    assert.strictEqual(provider.store.list().length, 0, "Deleting the last Chat and refreshing two windows must create no blank Chats");
    assert.strictEqual(provider.store.list(true).length, 1, "Only the original trashed record may remain");
    assert.strictEqual(posts.at(-1).chat, null);
    assert.strictEqual(otherPosts.at(-1).chat, null);
    await provider.handle({ type: "restoreChat", id: deleteFixture });
    assert.strictEqual(provider.chat.id, deleteFixture, "Restoration must adopt the original Chat, not create another");
    sessionApproval = "Move to Trash";
    await provider.handle({ type: "trashChat", id: deleteFixture });
    sessionApproval = undefined;
    await provider.handle({ type: "deleteChat", id: deleteFixture });
    assert.strictEqual(provider.store.list(true).length, 1, "Cancelled permanent deletion must retain Trash");
    sessionApproval = "Delete permanently";
    await provider.handle({ type: "deleteChat", id: deleteFixture });
    await otherWindow.handle({ type: "ready" });
    assert.strictEqual(provider.store.list(true).length, 0, "Permanent deletion and reopen must not leave replacement Chats");
    otherWindow.dispose(); sessionApproval = "Ask Session";
    await provider.handle({ type: "new" });
    const first = provider.chat.id;
    assert.strictEqual(provider.chat.sessionId, undefined);
    assert.strictEqual(provider.chat.permissionMode, "protective");
    await provider.handle({ type: "permissionMode", value: "allow-all" });
    assert(provider.toolGroups(provider.chat).every(group => group.tools.every(tool => tool.enabled)));
    assert(provider.toolGroups(provider.chat).reduce((count, group) => count + group.tools.length, 0) > 4);
    await provider.handle({ type: "permissionMode", value: "ask" });
    const { toolPermissionScope } = require("../dist/chat/permissions");
    assert.strictEqual(toolPermissionScope("mcp", "inspect", { readOnlyHint: true }), "read-only");
    assert.strictEqual(toolPermissionScope("mcp", "write", { destructiveHint: false }), "non-destructive");
    assert.notStrictEqual(toolPermissionScope("mcp", "unknown"), "read-only");
    assert.notStrictEqual(toolPermissionScope("mcp", "contradictory", { readOnlyHint: true, destructiveHint: true }), "read-only");
    automaticPermissionApproval = false;
    const permissionController = new AbortController(); provider.running.set(first, permissionController);
    const permission = (scope, title = "Permission fixture") => provider.requestPermission(provider.chat, scope, title, "bounded input", permissionController.signal);
    await provider.handle({ type: "permissionMode", value: "protective" });
    assert.strictEqual(await provider.requestPermission(provider.chat, "non-destructive", "Local edit", "", permissionController.signal, true), true);
    assert.strictEqual(provider.approvals.size, 0);
    const outsideRead = permission("read-only", "External MCP read");
    const outsideReadId = [...provider.approvals.keys()][0]; assert(outsideReadId);
    assert.match(posts.at(-1).approvals[0].detail, /only in this Chat and sending-window context/);
    await provider.handle({ type: "approval", id: outsideReadId, value: "approve" });
    assert.strictEqual(await outsideRead, true);
    assert.strictEqual(await permission(toolPermissionScope("builtin", "run_process")), true);
    assert.strictEqual(provider.approvals.size, 0, "Protective remembers one outside-workspace grant per Chat");
    const protectiveOther = provider.store.create(); const protectiveOtherController = new AbortController();
    provider.running.set(protectiveOther.id, protectiveOtherController);
    const otherOutsideRead = provider.requestPermission(protectiveOther, "read-only", "Other Chat external read", "", protectiveOtherController.signal);
    assert.strictEqual(provider.approvals.size, 1, "A different Chat must not inherit the outside grant");
    protectiveOtherController.abort(); await assert.rejects(otherOutsideRead, /cancelled/); provider.running.delete(protectiveOther.id);
    await provider.handle({ type: "resetPermissions" }); await provider.handle({ type: "permissionMode", value: "ask" });
    assert.strictEqual(await permission("read-only"), true); assert.strictEqual(provider.approvals.size, 0);
    const firstPermission = permission("non-destructive");
    const firstApproval = [...provider.approvals.keys()][0]; assert(firstApproval);
    assert.strictEqual(posts.at(-1).approvals[0].scope, "Non-destructive operations");
    await provider.handle({ type: "approval", id: firstApproval, value: "approve" }); assert.strictEqual(await firstPermission, true);
    assert.deepStrictEqual(provider.store.load(first, false).permissionGrants, ["non-destructive"]);
    assert.strictEqual(await permission(toolPermissionScope("mcp", "different write", { destructiveHint: false })), true);
    assert.strictEqual(provider.approvals.size, 0, "Non-destructive tools share a single remembered permission");
    const unknownScope = toolPermissionScope("native", "unknown");
    const deniedPermission = permission(unknownScope); const deniedId = [...provider.approvals.keys()][0];
    await provider.handle({ type: "approval", id: deniedId, value: "deny" }); assert.strictEqual(await deniedPermission, false);
    assert(!provider.chat.permissionGrants.includes(unknownScope));
    await assert.rejects(provider.handle({ type: "approval", id: deniedId, value: "approve" }), /no longer pending/);
    await provider.handle({ type: "permissionMode", value: "allow-all" });
    assert.strictEqual(await permission(unknownScope), true); assert.strictEqual(provider.approvals.size, 0);
    assert.strictEqual(provider.store.load(first, false).permissionMode, "allow-all");
    const batchScope = toolPermissionScope("builtin", "create_chats");
    const batchPermission = provider.requestPermission(provider.chat, batchScope, "Create 2 Chats?", "Two named Chats in one group", permissionController.signal, false, true);
    const batchApprovalId = [...provider.approvals.keys()][0]; assert(batchApprovalId);
    assert.strictEqual(posts.at(-1).approvals[0].once, true);
    assert.strictEqual(posts.at(-1).approvals[0].scope, "Only this batch");
    await provider.handle({ type: "permissionMode", value: "allow-all" });
    assert(provider.approvals.has(batchApprovalId), "Switching to Allow All must not approve a batch");
    await assert.rejects(provider.handle({ type: "approval", id: batchApprovalId, value: "allow-all" }), /explicitly/);
    await provider.handle({ type: "approval", id: batchApprovalId, value: "approve" });
    assert.strictEqual(await batchPermission, true);
    assert(!provider.store.load(first, false).permissionGrants.includes(batchScope), "Batch approval must not be remembered");
    const nextBatchPermission = provider.requestPermission(provider.chat, batchScope, "Create 1 Chat?", "A different batch", permissionController.signal, false, true);
    const nextBatchApprovalId = [...provider.approvals.keys()][0]; assert(nextBatchApprovalId);
    await provider.handle({ type: "approval", id: nextBatchApprovalId, value: "deny" });
    assert.strictEqual(await nextBatchPermission, false);
    await provider.handle({ type: "permissionMode", value: "ask" });
    const readonlyPending = permission(unknownScope);
    await provider.handle({ type: "permissionMode", value: "read-only" }); assert.strictEqual(await readonlyPending, false);
    await assert.rejects(permission(unknownScope), /read-only/);
    await provider.handle({ type: "permissionMode", value: "ask" }); await provider.handle({ type: "resetPermissions" });
    const isolatedChat = provider.store.create(); const isolatedController = new AbortController(); provider.running.set(isolatedChat.id, isolatedController);
    isolatedChat.permissionMode = "ask"; provider.store.save(isolatedChat);
    const isolatedPermission = provider.requestPermission(isolatedChat, "non-destructive", "Other Chat", "", isolatedController.signal);
    const isolatedId = [...provider.approvals.keys()][0];
    assert.deepStrictEqual(posts.at(-1).approvals, [], "Another Chat's permission prompt must not appear here");
    await assert.rejects(provider.handle({ type: "approval", id: isolatedId, value: "approve" }), /no longer pending/);
    isolatedController.abort(); await assert.rejects(isolatedPermission, /cancelled/); provider.running.delete(isolatedChat.id);
    const cancelledPermission = permission(unknownScope); const cancelledId = [...provider.approvals.keys()][0];
    permissionController.abort(); await assert.rejects(cancelledPermission, /cancelled/);
    assert.strictEqual(provider.approvals.size, 0); assert.deepStrictEqual(provider.store.load(first, false).permissionGrants, []);
    await assert.rejects(provider.handle({ type: "approval", id: cancelledId, value: "approve" }), /no longer pending/);
    provider.running.delete(first); automaticPermissionApproval = true;
    const ordinarySourceState = structuredClone(provider.chat);
    const ordinaryRequestCount = requests.length;
    const ordinaryApprovalCount = approvalCallbacks.length;
    const ordinaryBuiltins = provider.chat.builtinTools;
    const ordinaryVscodeTools = provider.chat.vscodeTools;
    const ordinarySelection = provider.chat.toolSelection;
    delete provider.chat.toolSelection;
    provider.chat.builtinTools = ["list_chats", "ask_chat", "ask_session"];
    provider.chat.vscodeTools = [];
    protectiveOther.builtinTools = ["ask_chat", "ask_session", "list_chats"];
    protectiveOther.permissionMode = "ask";
    protectiveOther.includeHistory = false; protectiveOther.images = [testImage]; provider.persist(protectiveOther);
    sessionApproval = "Ask Chat";
    const ordinaryStarted = new Promise(resolve => { started = resolve; });
    const ordinaryRun = provider.handle({ type: "send", text: "ordinary-source private history" });
    await Promise.race([ordinaryStarted, ordinaryRun.then(() => { throw new Error("Ordinary Chat source finished before invoking the model: " + provider.chat.messages.at(-1)?.error); })]);
    const ordinaryRequest = requests.at(-1);
    const listChats = ordinaryRequest.request.tools.find(tool => tool.name === "list_chats");
    const askChat = ordinaryRequest.request.tools.find(tool => tool.name === "ask_chat");
    assert(listChats && askChat);
    assert(!ordinaryRequest.request.tools.some(tool => tool.name === "ask_session"), "A Task-free Chat must not advertise Session delegation");
    const chatMetadata = JSON.parse(await listChats.execute({}, ordinaryRequest.request.signal));
    assert(chatMetadata.chats.some(item => item.chatId === first && item.current && item.status === "running"));
    assert(chatMetadata.chats.some(item => item.chatId === protectiveOther.id && !item.current));
    assert(chatMetadata.chats.every(item => Object.keys(item).every(key => ["chatId", "chatUrl", "title", "status", "current"].includes(key))), "Discovery returns metadata only; titles may derive from the first prompt");
    assert(chatMetadata.chats.every(item => item.chatUrl === `pkm://chats/${provider.store.namespace}/${item.chatId}`));
    assert(chatMetadata.chats.every(item => !Object.hasOwn(item, "messages")));
    const chatPage = JSON.parse(await listChats.execute({ limit: 1 }, ordinaryRequest.request.signal));
    assert.strictEqual(chatPage.chats.length, 1); assert.strictEqual(chatPage.nextOffset, 1);
    await assert.rejects(listChats.execute({ offset: -1 }, ordinaryRequest.request.signal), /offset/);
    await assert.rejects(listChats.execute({ limit: 51 }, ordinaryRequest.request.signal), /limit/);
    await provider.handle({ type: "copyChatId" });
    await provider.handle({ type: "copyChatId", id: protectiveOther.id });
    assert.deepStrictEqual(copiedChatIds, [first, protectiveOther.id].map(id => `pkm://chats/${provider.store.namespace}/${id}`));
    assert.strictEqual(provider.chat.id, first);
    await assert.rejects(provider.handle({ type: "copyChatId", id: "not-a-chat" }), /existing Chat/);
    const chatQuestion = { chatId: `pkm://chats/${provider.store.namespace}/${protectiveOther.id}`, question: "Inspect delegated evidence" };
    await assert.rejects(askChat.execute({ ...chatQuestion, chatId: first }, ordinaryRequest.request.signal), /advertised/);
    await assert.rejects(askChat.execute({ ...chatQuestion, chatId: "outside-workspace" }, ordinaryRequest.request.signal), /advertised/);
    protectiveOther.paused = true; provider.persist(protectiveOther);
    await assert.rejects(askChat.execute(chatQuestion, ordinaryRequest.request.signal), /paused/);
    protectiveOther.paused = false; provider.persist(protectiveOther);
    provider.running.set(protectiveOther.id, new AbortController());
    await assert.rejects(askChat.execute(chatQuestion, ordinaryRequest.request.signal), /busy/); provider.running.delete(protectiveOther.id);
    registeredTools.push({ name: "mcp_pkm_api_chat_send", description: "Nested cooperation fixture" });
    const ordinaryTargetStarted = new Promise(resolve => { started = resolve; });
    const ordinaryAnswer = askChat.execute(chatQuestion, ordinaryRequest.request.signal); await ordinaryTargetStarted;
    const ordinaryTarget = requests.at(-1);
    assert(!ordinaryTarget.request.tools.some(tool => ["ask_chat", "ask_session"].includes(tool.name)));
    const ordinaryFinder = ordinaryTarget.request.tools.find(tool => tool.name === "find_vscode_tools");
    if (ordinaryFinder) assert(!JSON.parse(await ordinaryFinder.execute({ query: "api_chat_send" }, ordinaryTarget.request.signal)).tools.some(tool => tool.name === "mcp_pkm_api_chat_send"));
    assert(!ordinaryTarget.request.messages.some(message => message.content.includes("ordinary-source private history") || message.images?.length));
    const persistedOrdinaryTarget = provider.store.load(protectiveOther.id, false);
    assert.strictEqual(persistedOrdinaryTarget.messages.at(-2).fromChatId, first);
    assert.strictEqual(persistedOrdinaryTarget.messages.at(-2).fromSessionId, undefined);
    assert.deepStrictEqual(persistedOrdinaryTarget.images[0], testImage);
    const ordinaryReceipt = JSON.parse(await ordinaryAnswer);
    assert.strictEqual(ordinaryReceipt.status, "running", "delegation must return before the child completes");
    const readOrdinaryResult = ordinaryRequest.request.tools.find(tool => tool.name === "read_chat_result");
    assert.strictEqual(JSON.parse(await readOrdinaryResult.execute({ receiptId: ordinaryReceipt.receiptId }, ordinaryRequest.request.signal)).status, "running");
    ordinaryTarget.onText("Verified ordinary Chat answer"); ordinaryTarget.resolve();
    await new Promise(setImmediate);
    const ordinaryResult = JSON.parse(await readOrdinaryResult.execute({ receiptId: ordinaryReceipt.receiptId }, ordinaryRequest.request.signal));
    assert.strictEqual(ordinaryResult.answer, "Verified ordinary Chat answer"); assert.strictEqual(ordinaryResult.status, "complete");
    registeredTools.pop();
    assert.strictEqual(provider.store.load(first, false).sessionId, undefined);
    assert.strictEqual(provider.store.load(protectiveOther.id, false).sessionId, undefined);
    assert.strictEqual(provider.store.load(protectiveOther.id, false).messages.at(-2).fromChatId, first);
    assert.strictEqual(provider.chat.id, first);
    await assert.rejects(askChat.execute(chatQuestion, ordinaryRequest.request.signal), /One Chat/);
    ordinaryRequest.resolve(); await ordinaryRun;
    await provider.handle({ type: "resetPermissions" });
    const ordinaryDeclineStarted = new Promise(resolve => { started = resolve; });
    const ordinaryDeclineRun = provider.handle({ type: "send", text: "Decline ordinary Chat delegation" }); await ordinaryDeclineStarted;
    const ordinaryDecline = requests.at(-1); sessionApproval = undefined;
    const beforeOrdinaryDecline = requests.length;
    await assert.rejects(ordinaryDecline.request.tools.find(tool => tool.name === "ask_chat").execute(chatQuestion, ordinaryDecline.request.signal), /declined/);
    assert.strictEqual(requests.length, beforeOrdinaryDecline); ordinaryDecline.resolve(); await ordinaryDeclineRun;
    sessionApproval = "Ask Chat";
    const ordinaryCancelStarted = new Promise(resolve => { started = resolve; });
    const ordinaryCancelRun = provider.handle({ type: "send", text: "Cancel ordinary Chat delegation" }); await ordinaryCancelStarted;
    const ordinaryCancel = requests.at(-1);
    const ordinaryCancelTargetStarted = new Promise(resolve => { started = resolve; });
    const ordinaryCancelledAnswer = ordinaryCancel.request.tools.find(tool => tool.name === "ask_chat").execute(chatQuestion, ordinaryCancel.request.signal); await ordinaryCancelTargetStarted;
    const ordinaryCancelledTarget = requests.at(-1);
    assert.strictEqual(JSON.parse(await ordinaryCancelledAnswer).status, "running");
    await provider.handle({ type: "pause" }); await ordinaryCancelRun;
    assert.strictEqual(ordinaryCancelledTarget.request.signal.aborted, false, "an approved child must remain independent");
    ordinaryCancelledTarget.onText("Independent result"); ordinaryCancelledTarget.resolve(); await new Promise(setImmediate);
    await provider.handle({ type: "resume" }); await provider.handle({ type: "resetPermissions" });
    provider.chat.builtinTools = ordinaryBuiltins; provider.chat.vscodeTools = ordinaryVscodeTools; provider.chat.toolSelection = ordinarySelection; sessionApproval = "Ask Session";
    for (const key of Object.keys(provider.chat)) delete provider.chat[key];
    Object.assign(provider.chat, ordinarySourceState, { revision: provider.store.load(first, false).revision });
    provider.persist(provider.chat);
    requests.splice(ordinaryRequestCount);
    approvalCallbacks.splice(ordinaryApprovalCount);
    const { chatToolGroups, selectChatTools } = require("../dist/chat/tool-selection");
    const selectionFixture = { ...provider.chat, builtinTools: undefined, vscodeTools: undefined, toolSelection: undefined };
    const groupsFor = chat => chatToolGroups(chat, builtin.builtinToolCatalog, registeredTools);
    assert(groupsFor(selectionFixture).every(group => group.tools.every(tool => tool.enabled)), "Unset selection enables all configured tools");
    selectionFixture.mcpServers = [{ id: "http-fixture", label: "HTTP fixture", url: "https://fixture.invalid/mcp", enabled: false, tools: ["inspect", "write"] }];
    selectChatTools(selectionFixture, groupsFor(selectionFixture), "mcp:http-fixture:inspect", true, false);
    assert.strictEqual(selectionFixture.mcpServers[0].enabled, true);
    assert.deepStrictEqual(groupsFor(selectionFixture).find(group => group.id === "mcp:http-fixture").tools.map(tool => tool.enabled), [true, false]);
    selectChatTools(selectionFixture, groupsFor(selectionFixture), "vscode:mcp:pkm", false, false);
    assert(groupsFor(selectionFixture)[0].tools.every(tool => tool.enabled), "A source toggle must preserve other sources");
    selectChatTools(selectionFixture, groupsFor(selectionFixture), "vscode:mcp_pkm_list_notes", true, false);
    assert.deepStrictEqual(groupsFor(selectionFixture).find(group => group.id === "vscode:mcp:pkm").tools.map(tool => tool.enabled), [true, false]);
    selectChatTools(selectionFixture, groupsFor(selectionFixture), "builtin", true, true);
    assert(groupsFor(selectionFixture).filter(group => group.id !== "builtin").every(group => group.tools.every(tool => !tool.enabled)));
    selectionFixture.permissionMode = "allow-all";
    assert(groupsFor(selectionFixture).filter(group => group.id !== "builtin").every(group => group.tools.every(tool => !tool.enabled)), "Allow All is not tool enablement");
    const explicitlyEmpty = { ...provider.chat, builtinTools: [], vscodeTools: [], toolSelection: undefined };
    assert(groupsFor(explicitlyEmpty).every(group => group.tools.every(tool => !tool.enabled)), "An explicit saved empty selection remains disabled");
    selectChatTools(explicitlyEmpty, groupsFor(explicitlyEmpty), "builtin:read_file", true, false);
    assert.deepStrictEqual(groupsFor(explicitlyEmpty)[0].tools.filter(tool => tool.enabled).map(tool => tool.name), ["read_file"]);
    await provider.handle({ type: "toolSelection", id: "builtin:save_file", value: false });
    assert(provider.store.load(first, false).toolSelection.disabledTools.includes("builtin:save_file"));
    await assert.rejects(provider.handle({ type: "toolSelection", id: "unknown source", value: true }), /no longer available/);
    delete provider.chat.toolSelection; provider.persist(provider.chat);
    inputs.push(() => "Controller coding Task");
    await provider.handle({ type: "startTask" });
    assert(provider.chat.sessionId);
    picks.push(items => {
      assert.deepStrictEqual(items.filter(item => item.kind === -1).map(item => item.label), ["PKM Skills (1)", "PKM Notes (1)", "Other VS Code / MCP (1)"]);
      return [items[0], items.find(item => item.id === "mcp_pkm_list_notes")];
    });
    await provider.configureAgent(provider.chat.sessionId, "vscodeTools");
    assert.deepStrictEqual(provider.store.load(first).vscodeTools, ["mcp_pkm_list_notes"]);
    picks.push(items => { assert.strictEqual(items.find(item => item.id === "mcp_pkm_list_notes").picked, true); return undefined; });
    await provider.configureAgent(provider.chat.sessionId, "vscodeTools");
    assert.deepStrictEqual(provider.chat.vscodeTools, ["mcp_pkm_list_notes"]);
    const exportFile = path.join(directory, "pkm.toolsets.jsonc");
    saveDestination = { fsPath: exportFile, path: exportFile };
    const permissionBeforeExport = provider.chat.permissionMode;
    await provider.exportMcpToolSets();
    const exported = fs.readFileSync(exportFile, "utf8");
    assert.deepStrictEqual(JSON.parse(exported)["pkm-notes"].tools, ["pkm/list_notes"]);
    assert.strictEqual(provider.chat.permissionMode, permissionBeforeExport);
    assert.deepStrictEqual(provider.chat.vscodeTools, ["mcp_pkm_list_notes"]);
    await assert.rejects(provider.exportMcpToolSets(), /already exists/);
    assert.strictEqual(fs.readFileSync(exportFile, "utf8"), exported);
    saveDestination = undefined;
    await provider.exportMcpToolSets();
    provider.chat.vscodeTools = []; provider.persist(provider.chat); imageWrites = 0;
    assert.strictEqual(posts.at(-1).chats.find(item => item.id === first).status, "idle");
    inputs.push(options => { assert.strictEqual(options.value, "New chat"); assert(options.validateInput(" ")); assert(options.validateInput("name\nline")); assert(options.validateInput("x".repeat(121))); return "  Named chat  "; });
    await provider.handle({ type: "rename" });
    assert.strictEqual(provider.chat.title, "Named chat"); assert.strictEqual(provider.store.load(first).customTitle, true);
    inputs.push(() => undefined); await provider.handle({ type: "rename" }); assert.strictEqual(provider.chat.title, "Named chat");
    inputs.push(() => "Named chat"); await provider.handle({ type: "rename", id: first });
    assert.strictEqual(posts.filter(message => message.type === "state").at(-1).chat.title, "Named chat");
    picks.push(items => { assert(!items.some(item => item.id === "retired-alias")); return items.find(item => item.id === "test"); });
    await provider.handle({ type: "chooseModel" }); assert.strictEqual(provider.chat.modelProfileId, "test");
    assert.strictEqual(userState.get("apiChat.defaultModel").profile.id, "test");
    const firstDefault = JSON.stringify(userState.get("apiChat.defaultModel"));
    picks.push(() => undefined); await provider.handle({ type: "chooseModel" });
    assert.strictEqual(JSON.stringify(userState.get("apiChat.defaultModel")), firstDefault);
    await provider.handle({ type: "new" });
    assert.strictEqual(provider.chat.modelProfileId, "test");
    assert.strictEqual(provider.chat.contextWindow, undefined);
    await provider.handle({ type: "select", id: first });
    await provider.handle({ type: "pause" });
    assert.strictEqual(provider.store.load(first).paused, true);
    assert.strictEqual(posts.at(-1).chats.find(item => item.id === first).status, "paused");
    await assert.rejects(provider.handle({ type: "send", text: "must not start" }), /paused/);
    assert.strictEqual(requests.length, 0);
    await provider.handle({ type: "resume" });
    assert.strictEqual(provider.store.load(first).paused, false);
    picks.push(items => items.find(item => item.id === "read-only"));
    await provider.handle({ type: "permissions" });
    assert.strictEqual(provider.store.load(first).permissionMode, "read-only");
    provider.chat.builtinTools = ["replace_text", "run_process"];
    provider.chat.context = [{ id: "explicit", label: "selection.ts:1", content: "chosen context" }];
    const firstStarted = new Promise(resolve => { started = resolve; });
    provider.chat.permissionContextId = "0".repeat(64);
    provider.chat.permissionGrants = [toolPermissionScope("builtin", "run_process")];
    const firstRun = provider.handle({ type: "send", text: "first question" });
    await firstStarted;
    const firstExecution = provider.chat.progress.executionContext;
    assert(require("../dist/chat/execution-context").validExecutionContext(firstExecution));
    assert.strictEqual(firstExecution.knowledgeRoot, fs.realpathSync(directory));
    assert.deepStrictEqual(provider.chat.messages.at(-2).executionContext, firstExecution);
    assert.strictEqual(provider.chat.permissionContextId, firstExecution.contextId);
    assert.deepStrictEqual(provider.chat.permissionGrants, [], "permissions from a previous sender must not transfer");
    assert.strictEqual(provider.chat.title, "Named chat", "First prompt must not overwrite a manual title");
    assert.strictEqual(posts.at(-1).chats.find(item => item.id === first).status, "running");
    approvalCallbacks[0]("run_process", true);
    assert.strictEqual(posts.at(-1).chats.find(item => item.id === first).status, "running", "Pre-policy builtin callbacks do not indicate a real approval wait");
    approvalCallbacks[0]("run_process", false);
    assert.strictEqual(posts.at(-1).chats.find(item => item.id === first).status, "running");
    assert.strictEqual(requests[0].request.messages[1].content, "Context: selection.ts:1\nchosen context");
    await provider.handle({ type: "model", value: "next" });
    await provider.configureAgent(provider.chat.sessionId, "tools");
    await provider.configureAgent(provider.chat.sessionId, "memory");
    await provider.configureAgent(provider.chat.sessionId, "pkmSkills");
    await provider.configureAgent(provider.chat.sessionId, "externalSkills");
    assert.strictEqual(requests[0].request.model, "test"); assert.deepStrictEqual(requests[0].request.tools, []);
    picks.push(items => items.find(item => item.id === "ask"));
    await provider.handle({ type: "permissions" });
    assert.strictEqual(provider.chat.permissionMode, "ask");
    assert.deepStrictEqual(requests[0].request.tools, [], "Mid-run permission changes must not grant the existing request new tools");
    assert.doesNotThrow(() => provider.assertExecution(provider.chat, firstExecution),
      "an explicit permission-only change must not look like retargeting an owned active request");
    const activePermission = provider.requestPermission(provider.chat, "destructive", "Fixture permission", "", requests[0].request.signal);
    const activeApprovalId = [...provider.approvals.keys()][0];
    assert(activeApprovalId);
    const priorBuiltinTools = provider.chat.builtinTools;
    const priorVscodeTools = provider.chat.vscodeTools;
    const priorToolSelection = provider.chat.toolSelection;
    await provider.handle({ type: "approval", id: activeApprovalId, value: "allow-all" });
    assert.strictEqual(await activePermission, true,
      "Allow All from an active approval must resume that request instead of raising execution-context changed");
    assert.doesNotThrow(() => provider.assertExecution(provider.chat, firstExecution));
    assert.deepStrictEqual(requests[0].request.tools, [], "Allow All cannot add tools to the captured request");
    const capture = provider.captureExecution;
    const factory = require("../dist/chat/execution-context").captureExecutionContext;
    provider.captureExecution = chat => factory(provider.executionHostId, [], directory, false, chat.permissionMode || "ask");
    assert.throws(() => provider.assertExecution(provider.chat, firstExecution), /execution context changed.*trusted/,
      "an active permission change must not bypass a changed workspace trust boundary");
    provider.captureExecution = chat => factory(require("crypto").randomUUID(), [], directory, true, chat.permissionMode || "ask");
    assert.throws(() => provider.assertExecution(provider.chat, firstExecution), /execution context changed.*hostId/,
      "an owned active request must still reject another sending window");
    provider.captureExecution = capture;
    assert.throws(() => provider.assertExecution(provider.chat, { ...firstExecution, permissionMode: "allow-all" }), /execution context changed/,
      "a forged context with stale hashes must not pass the active permission exception");
    await provider.handle({ type: "permissionMode", value: "ask" });
    provider.chat.builtinTools = priorBuiltinTools;
    provider.chat.vscodeTools = priorVscodeTools;
    provider.chat.toolSelection = priorToolSelection;
    provider.persist(provider.chat);
    assert.strictEqual(requests[0].request.maxToolRounds, 30);
    automaticDecisionApproval = false;
    const modalCount = nativeConfirmations.length;
    const summarizeLoop = requests[0].request.onToolLoopNotice({ reason: "round-limit", rounds: 30, limit: 30 }, requests[0].request.signal);
    const loopDecisionId = [...provider.decisions.keys()][0]; assert(loopDecisionId);
    assert(provider.awaitingInput.has(first), "loop review must be a Chat waiting state");
    assert.deepStrictEqual(posts.at(-1).decisions[0].choices.map(choice => choice.value), ["continue", "summarize", "cancel"]);
    await assert.rejects(provider.handle({ type: "decision", id: loopDecisionId, value: "allow-all" }), /available decision/);
    await provider.handle({ type: "permissionMode", value: "allow-all" });
    assert(provider.decisions.has(loopDecisionId), "Allow All must not auto-approve a loop decision");
    await provider.handle({ type: "select", id: protectiveOther.id });
    assert.deepStrictEqual(posts.filter(post => post.type === "state").at(-1).decisions, [], "loop decisions are shown only in their owning Chat");
    await assert.rejects(provider.handle({ type: "decision", id: loopDecisionId, value: "continue" }), /no longer pending/);
    await provider.handle({ type: "select", id: first });
    await provider.handle({ type: "decision", id: loopDecisionId, value: "summarize" });
    assert.strictEqual(await summarizeLoop, "summarize");
    assert(!provider.awaitingInput.has(first));
    await assert.rejects(provider.handle({ type: "decision", id: loopDecisionId, value: "continue" }), /no longer pending/);
    const continueLoop = requests[0].request.onToolLoopNotice({ reason: "round-limit", rounds: 30, limit: 30 }, requests[0].request.signal);
    await provider.handle({ type: "decision", id: [...provider.decisions.keys()][0], value: "continue" });
    assert.strictEqual(await continueLoop, "continue");
    assert.strictEqual(nativeConfirmations.length, modalCount, "PKM loop decisions must not invoke VS Code modal confirmations");
    automaticDecisionApproval = true;
    await provider.handle({ type: "permissionMode", value: "ask" });
    provider.chat.builtinTools = priorBuiltinTools;
    provider.chat.vscodeTools = priorVscodeTools;
    provider.chat.toolSelection = priorToolSelection;
    provider.persist(provider.chat);
    sessionApproval = "Ask Session";
    assert.strictEqual(provider.chat.modelProfileId, "next"); assert.deepStrictEqual(provider.chat.builtinTools, ["read_file"]);
    assert(!requests[0].request.messages.some(item => item.content.includes("memory snapshot")));
    requests[0].request.onUsage({ inputTokens: 100, outputTokens: 10 }); requests[0].request.onUsage({ inputTokens: 20, outputTokens: 5 });
    assert.strictEqual(provider.chat.messages[1].usage.inputTokens, 120); assert.strictEqual(provider.chat.messages[1].usage.outputTokens, 15);
    assert.strictEqual(provider.chat.messages[1].estimatedCost, estimateCost(modelProfiles(configuration.apiChatModelProfiles, [])[0], 120, 15));
    await provider.handle({ type: "send", text: "queued while running", mode: "task" });
    assert.strictEqual(provider.chat.queuedInputs.length, 1);
    assert.strictEqual(requests.length, 1, "busy input must not start a second concurrent stream");
    await provider.handle({ type: "removeQueuedInput", id: provider.chat.queuedInputs[0].id });
    assert.strictEqual(provider.chat.queuedInputs.length, 0);
    await provider.handle({ type: "new" });
    const second = provider.chat.id;
    assert.notStrictEqual(first, second);
    let finishRename; let renameOpened;
    const opened = new Promise(resolve => { renameOpened = resolve; });
    inputs.push(() => new Promise(resolve => { finishRename = resolve; renameOpened(); }));
    const renaming = provider.handle({ type: "rename" }); await opened;
    await provider.handle({ type: "select", id: first });
    finishRename("Background renamed"); await renaming;
    assert.strictEqual(provider.chat.title, "Named chat");
    assert.strictEqual(provider.store.load(second).title, "Background renamed");
    inputs.push(options => { assert.strictEqual(options.value, "Background renamed"); return "List renamed"; });
    await provider.handle({ type: "rename", id: second });
    assert.strictEqual(provider.chat.id, first, "List rename must not open or rename the selected Chat");
    assert.strictEqual(provider.chat.title, "Named chat");
    assert.strictEqual(provider.store.load(second).title, "List renamed");
    assert.strictEqual(posts.filter(message => message.type === "state").at(-1).library.chats.find(item => item.id === second).title, "List renamed");
    await provider.handle({ type: "select", id: second });
    const secondStarted = new Promise(resolve => { started = resolve; });
    const secondRun = provider.handle({ type: "send", text: "second question" });
    await secondStarted;
    assert(posts.at(-1).chats.filter(item => [first, second].includes(item.id)).every(item => item.status === "running"));
    requests[0].onText("first partial"); requests[1].onText("second partial");
    assert(posts.filter(item => item.type === "delta").every(item => item.chatId === second));
    assert.match(fs.readFileSync(path.join(__dirname, "../src/webview/api-chat.js"), "utf8"), /element\("stop"\)\.onclick = \(\) => post\("cancel"\)/);
    await provider.handle({ type: "cancel" }); await secondRun;
    assert.strictEqual(provider.chat.messages[1].status, "cancelled");
    assert.strictEqual(provider.chat.messages[1].content, "second partial");
    assert.notStrictEqual(provider.store.load(second).paused, true, "Stopping a response must not pause the Chat");
    provider.store.assertRunnable(provider.chat);
    assert.strictEqual(requests.length, 2, "Stopping must not automatically retry the request");
    await provider.handle({ type: "pause" });
    assert.strictEqual(provider.store.load(second).paused, true);
    assert.strictEqual(posts.at(-1).chats.find(item => item.id === second).status, "paused");
    await assert.rejects(provider.handle({ type: "send", text: "must stay paused" }), /paused/);
    assert.strictEqual(requests[0].request.signal.aborted, false);
    await provider.handle({ type: "resume" });
    await provider.handle({ type: "select", id: first });
    assert.strictEqual(provider.chat.messages[1].content, "first partial");
    requests[0].resolve(); await firstRun;
    assert.strictEqual(provider.chat.messages[1].status, "complete");
    assert.strictEqual(provider.running.size, 0);
    assert.strictEqual(posts.at(-1).chats.find(item => item.id === first).status, "new-result");
    const resultId = provider.chat.lastResultId;
    await provider.handle({ type: "read", id: first, value: "stale-result" }); assert.notStrictEqual(provider.chat.readResultId, resultId);
    provider.view.visible = false;
    await provider.handle({ type: "read", id: first, value: resultId }); assert.notStrictEqual(provider.chat.readResultId, resultId);
    provider.view.visible = true;
    await provider.handle({ type: "read", id: second, value: resultId }); assert.notStrictEqual(provider.chat.readResultId, resultId);
    await provider.handle({ type: "read", id: first, value: resultId });
    assert.strictEqual(posts.at(-1).chats.find(item => item.id === first).status, "completed");
    assert.strictEqual(provider.store.load(first).readResultId, resultId);
    const nextStarted = new Promise(resolve => { started = resolve; });
    const nextRun = provider.handle({ type: "send", text: "next request Selected skill" }); await nextStarted;
    const nextRequest = requests[requests.length - 1];
    assert.strictEqual(nextRequest.request.model, "next-api"); assert.strictEqual(nextRequest.request.tools[0].name, "read_file");
    assert(!nextRequest.request.messages.some(item => item.content.includes("memory snapshot")), "Global Notes are not automatic Chat memory");
    assert(nextRequest.request.messages.some(item => item.content.includes("pkm skill snapshot")));
    assert(nextRequest.request.messages.some(item => item.content.includes("external skill snapshot")));
    assert(!posts.filter(item => item.type === "state").some(item => JSON.stringify(item.chat?.agentContext || {}).includes("memory snapshot")));
    nextRequest.resolve(); await nextRun;
    provider.chat.builtinTools = ["session_info", "pkm_search", "pkm_read"];
    provider.chat.images = [testImage];
    const pkmStarted = new Promise(resolve => { started = resolve; });
    const pkmRun = provider.handle({ type: "send", text: "Inspect own Session and selected knowledge" }); await pkmStarted;
    const pkmRequest = requests.at(-1);
    assert.deepStrictEqual(pkmRequest.request.tools.map(tool => tool.name).sort(), ["pkm_read", "pkm_search", "session_info"]);
    assert(pkmRequest.request.messages[0].content.includes(provider.chat.sessionId));
    const info = JSON.parse(await pkmRequest.request.tools.find(tool => tool.name === "session_info").execute({}, pkmRequest.request.signal));
    assert.strictEqual(info.sessionId, provider.chat.sessionId); assert.strictEqual(info.tools.length, 3); assert(!JSON.stringify(info).includes("test-key"));
    const search = pkmRequest.request.tools.find(tool => tool.name === "pkm_search");
    sessionApproval = undefined;
    assert((await search.execute({ kind: "note", query: "Selected" }, pkmRequest.request.signal)).includes("Selected memory"), "Read-only PKM search must not request approval");
    sessionApproval = "Read PKM";
    const found = JSON.parse(await search.execute({ kind: "note", query: "Selected" }, pkmRequest.request.signal));
    assert.strictEqual(found.items[0].id, "note"); assert(!JSON.stringify(found).includes("memory snapshot"));
    const read = pkmRequest.request.tools.find(tool => tool.name === "pkm_read");
    assert.strictEqual(JSON.parse(await read.execute({ kind: "note", id: "note" }, pkmRequest.request.signal)).content, "memory snapshot");
    const skills = JSON.parse(await search.execute({ kind: "skill", query: "Selected" }, pkmRequest.request.signal));
    assert.strictEqual(skills.items[0].id, "Selected skill");
    assert(!JSON.stringify(skills).includes("pkm skill snapshot"));
    assert.strictEqual(JSON.parse(await read.execute({ kind: "skill", id: skills.items[0].id }, pkmRequest.request.signal)).content, "pkm skill snapshot");
    const recipes = JSON.parse(await search.execute({ kind: "recipe", query: "Selected Recipe" }, pkmRequest.request.signal));
    assert.strictEqual(recipes.items[0].id, "recipe_fixture");
    const recipe = JSON.parse(await read.execute({ kind: "recipe", id: recipes.items[0].id }, pkmRequest.request.signal));
    assert.strictEqual(recipe.revision, 3); assert.strictEqual(recipe.executableDigest, "a".repeat(64));
    assert.strictEqual(recipe.definition.spec.nodes[0].instructions, "Read actual evidence");
    await assert.rejects(read.execute({ kind: "recipe", id: "../outside" }, pkmRequest.request.signal), /existing local knowledge/);
    await assert.rejects(read.execute({ kind: "note", id: "../../outside" }, pkmRequest.request.signal), /existing local knowledge/);
    pkmRequest.onText("Failed inference output must not enter retry memory.");
    pkmRequest.reject(new Error("Fixture failure")); await pkmRun;
    const failedReply = provider.chat.messages.at(-1); const originalProgress = JSON.stringify(failedReply.progress);
    const retryInput = provider.chat.messages.at(-2);
    const originalInput = JSON.stringify(retryInput);
    const beforeRetryHistory = provider.chat.messages.map(message => message.id);
    const imageDraft = { ...testImage, label: "unsent-retry-draft.png" };
    provider.chat.images = [imageDraft];
    sessionApproval = undefined; const beforeRetry = requests.length;
    await provider.handle({ type: "retry", id: failedReply.id }); assert.strictEqual(requests.length, beforeRetry);
    assert.deepStrictEqual(provider.chat.messages.map(message => message.id), beforeRetryHistory, "cancelled confirmation retains the failed response");
    sessionApproval = "Retry";
    automaticDecisionApproval = false;
    const beforeRetryModals = nativeConfirmations.length;
    const staleConfirmation = provider.handle({ type: "retry", id: failedReply.id });
    const staleDecisionId = [...provider.decisions.keys()][0];
    assert(staleDecisionId);
    const unchangedTitle = provider.chat.title;
    provider.chat.title = "Changed during inline Retry confirmation";
    provider.persist(provider.chat);
    await assert.rejects(provider.handle({ type: "decision", id: staleDecisionId, value: "confirm" }), /changed while awaiting confirmation/);
    await staleConfirmation;
    assert.strictEqual(requests.length, beforeRetry, "a stale inline confirmation must not run inference");
    assert.strictEqual(provider.chat.messages.at(-1).id, failedReply.id);
    assert.strictEqual(nativeConfirmations.length, beforeRetryModals, "Retry confirmation is inline, not a VS Code modal");
    provider.chat.title = unchangedTitle; provider.persist(provider.chat);
    automaticDecisionApproval = true;
    const previousDiscovery = provider.pkmMcpDiscovery;
    let finishDiscovery;
    provider.pkmMcpDiscovery = new Promise(resolve => { finishDiscovery = resolve; });
    const staleRetry = provider.handle({ type: "retry", id: failedReply.id });
    await new Promise(setImmediate);
    provider.chat.messages[provider.chat.messages.length - 1] = { ...failedReply, id: "superseded-retry-fixture" };
    provider.persist(provider.chat);
    finishDiscovery();
    await assert.rejects(staleRetry, /conversation changed/);
    assert.strictEqual(requests.length, beforeRetry, "stale async preparation must not dispatch a retry");
    assert.strictEqual(provider.chat.messages.at(-1).id, "superseded-retry-fixture");
    provider.chat.messages[provider.chat.messages.length - 1] = failedReply;
    provider.pkmMcpDiscovery = previousDiscovery;
    provider.persist(provider.chat);
    const retryStarted = new Promise(resolve => { started = resolve; });
    const retryRun = provider.handle({ type: "retry", id: failedReply.id }); await retryStarted;
    assert.strictEqual(provider.chat.messages.length, beforeRetryHistory.length, "Retry replaces the failed response in place");
    assert.deepStrictEqual(provider.chat.messages.slice(0, -1).map(message => message.id), beforeRetryHistory.slice(0, -1),
      "Retry must preserve every earlier message, including the original user ID");
    assert.strictEqual(provider.chat.messages.at(-2).id, retryInput.id);
    assert.strictEqual(provider.chat.messages.at(-2), retryInput, "Retry preserves the original user message object");
    assert.strictEqual(JSON.stringify(retryInput), originalInput, "images and provenance remain unchanged");
    assert.deepStrictEqual(provider.chat.images, [imageDraft], "Retry does not consume the unsent image draft");
    assert(!provider.chat.messages.some(message => message.id === failedReply.id), "the failed inference response is removed");
    assert.strictEqual(requests.at(-1).request.messages.filter(message => message.role === "user" && message.content === retryInput.content).length, 1,
      "the model receives the retried user message exactly once");
    assert.deepStrictEqual(requests.at(-1).request.messages.at(-1).images, [testImage]);
    assert(!requests.at(-1).request.messages.some(message => message.content.includes("Failed inference output must not enter retry memory.")),
      "failed output must not enter dialogue or retrieved memory");
    assert.deepStrictEqual(provider.store.load(first, false).messages.map(message => message.id), provider.chat.messages.map(message => message.id),
      "persisted history must not resurrect the deleted response");
    assert.notStrictEqual(provider.chat.progress.attemptId, failedReply.progress.attemptId);
    assert.strictEqual(provider.chat.progress.retryOf, failedReply.id); assert.strictEqual(JSON.stringify(failedReply.progress), originalProgress);
    assert(provider.chat.progress.steps.some(step => step.status === "running"));
    await assert.rejects(provider.handle({ type: "retry", id: failedReply.id }), /latest failed/);
    requests.at(-1).reject(new Error("Repeated retry failure")); await retryRun;
    const repeatedFailure = provider.chat.messages.at(-1);
    const repeatedStarted = new Promise(resolve => { started = resolve; });
    const repeatedRun = provider.handle({ type: "retry", id: repeatedFailure.id }); await repeatedStarted;
    assert.strictEqual(provider.chat.messages.length, beforeRetryHistory.length, "repeated retries do not grow the conversation");
    assert.strictEqual(provider.chat.messages.at(-2), retryInput);
    assert.strictEqual(provider.chat.progress.retryOf, repeatedFailure.id);
    assert.strictEqual(provider.chat.progress.attempt, repeatedFailure.progress.attempt + 1);
    assert(!provider.chat.messages.some(message => message.id === failedReply.id || message.id === repeatedFailure.id));
    requests.at(-1).resolve(); await repeatedRun;
    assert.deepStrictEqual(provider.store.load(first, false).messages.map(message => message.id), provider.chat.messages.map(message => message.id));
    assert.strictEqual(provider.chat.messages.at(-1).progress.status, "complete");
    assert.strictEqual(failedReply.progress.status, "failed");
    provider.chat.images = [];
    const savedNativeSettings = { builtinTools: provider.chat.builtinTools, vscodeTools: provider.chat.vscodeTools, toolSelection: provider.chat.toolSelection, permissionMode: provider.chat.permissionMode };
    registeredTools.push({ name: "pylanceRunCodeSnippet", description: "Native Python snippet fixture" });
    await provider.handle({ type: "permissionMode", value: "allow-all" });
    provider.chat.builtinTools = []; provider.chat.vscodeTools = ["pylanceRunCodeSnippet"]; delete provider.chat.toolSelection;
    const nativeToolStarted = new Promise(resolve => { started = resolve; });
    const nativeToolRun = provider.handle({ type: "send", text: "Verify native Pylance approval boundary" });
    await Promise.race([nativeToolStarted, nativeToolRun.then(() => { throw new Error("Native approval fixture finished before model dispatch: " + provider.chat.messages.at(-1)?.error); })]);
    const nativeToolRequest = requests.at(-1).request;
    const nativeFinder = nativeToolRequest.tools.find(tool => tool.name === "find_vscode_tools");
    assert(JSON.parse(await nativeFinder.execute({ query: "pylanceRunCodeSnippet" }, nativeToolRequest.signal)).tools.some(tool => tool.name === "pylanceRunCodeSnippet"));
    const beforeNativeToolModals = nativeConfirmations.length;
    const beforeNativeToolApprovals = posts.filter(post => post.type === "state" && post.approvals?.length).length;
    await nativeToolRequest.tools.find(tool => tool.name === "invoke_vscode_tool").execute({ name: "pylanceRunCodeSnippet", input: { code: "1 + 1" } }, nativeToolRequest.signal);
    assert.strictEqual(provider.approvals.size, 0, "Allow All must skip PKM approval for Pylance");
    assert.strictEqual(posts.filter(post => post.type === "state" && post.approvals?.length).length, beforeNativeToolApprovals);
    assert.strictEqual(nativeConfirmations.length, beforeNativeToolModals, "PKM must not add a native confirmation of its own");
    assert.strictEqual(nativeInvocations.at(-1).name, "pylanceRunCodeSnippet");
    assert.deepStrictEqual(Object.keys(nativeInvocations.at(-1).options).sort(), ["input", "toolInvocationToken"]);
    assert.strictEqual(nativeInvocations.at(-1).options.toolInvocationToken, undefined, "native host confirmation must not be bypassed with a fabricated token");
    requests.at(-1).resolve(); await nativeToolRun;
    registeredTools.pop();
    Object.assign(provider.chat, savedNativeSettings); provider.persist(provider.chat);
    sessionApproval = "Ask Session";
    const targetChat = provider.chats.get(second); targetChat.builtinTools = ["ask_session"]; targetChat.includeHistory = false; targetChat.images = [testImage];
    provider.store.startTask(targetChat, "Cooperation target Task");
    provider.chat.builtinTools = ["read_file", "ask_session"];
    const sourceReady = new Promise(resolve => { started = resolve; });
    const sourceRun = provider.handle({ type: "send", text: "source-only private question" }); await sourceReady;
    const sourceRequest = requests.at(-1); const sessionTool = sourceRequest.request.tools.find(tool => tool.name === "ask_session");
    assert(sessionTool); assert(sessionTool.parameters.properties.sessionId.enum.includes(targetChat.sessionId));
    const sessionQuestion = { sessionId: targetChat.sessionId, question: "Check parser cancellation" };
    await assert.rejects(sessionTool.execute({ ...sessionQuestion, sessionId: "external-session" }, sourceRequest.request.signal), /advertised/);
    targetChat.paused = true; provider.persist(targetChat);
    await assert.rejects(sessionTool.execute(sessionQuestion, sourceRequest.request.signal), /paused/);
    targetChat.paused = false; provider.persist(targetChat);
    provider.running.set(second, new AbortController());
    await assert.rejects(sessionTool.execute(sessionQuestion, sourceRequest.request.signal), /busy/); provider.running.delete(second);
    const targetReady = new Promise(resolve => { started = resolve; });
    const sessionAnswer = sessionTool.execute(sessionQuestion, sourceRequest.request.signal); await targetReady;
    const targetRequest = requests.at(-1);
    assert.strictEqual(provider.chat.id, first, "Wake must not change the selected chat");
    assert(!targetRequest.request.tools.some(tool => tool.name === "ask_session"), "Target must not recursively wake another Session");
    assert(!targetRequest.request.messages.some(message => message.content.includes("source-only private question")));
    assert(!targetRequest.request.messages.some(message => message.images?.length), "Session questions must not transmit unsent target images");
    assert.strictEqual(targetChat.images[0], testImage);
    assert.strictEqual(targetChat.messages.at(-2).fromSessionId, provider.chat.sessionId);
    const sessionReceipt = JSON.parse(await sessionAnswer); assert.strictEqual(sessionReceipt.status, "running");
    targetRequest.onText("line\n\"\\".repeat(3000)); targetRequest.resolve();
    await new Promise(setImmediate);
    const answered = await sourceRequest.request.tools.find(tool => tool.name === "read_chat_result").execute({ receiptId: sessionReceipt.receiptId }, sourceRequest.request.signal);
    assert(answered.length <= 16_000); assert.strictEqual(JSON.parse(answered).truncated, true);
    assert.strictEqual(provider.store.load(first, false).permissionGrants.length, 1, "Approval must survive Chat reload");
    await assert.rejects(sessionTool.execute(sessionQuestion, sourceRequest.request.signal), /One Session/);
    sourceRequest.resolve(); await sourceRun;
    const cancelSourceReady = new Promise(resolve => { started = resolve; });
    const cancelSourceRun = provider.handle({ type: "send", text: "cancel nested question" }); await cancelSourceReady;
    const cancelSource = requests.at(-1); const cancelTool = cancelSource.request.tools.find(tool => tool.name === "ask_session");
    const cancelTargetReady = new Promise(resolve => { started = resolve; });
    const cancelAnswer = cancelTool.execute(sessionQuestion, cancelSource.request.signal); await cancelTargetReady;
    const cancelTarget = requests.at(-1);
    assert.strictEqual(JSON.parse(await cancelAnswer).status, "running");
    await provider.handle({ type: "pause" }); await cancelSourceRun;
    assert.strictEqual(cancelTarget.request.signal.aborted, false, "Pausing the source must not cancel an approved independent child");
    cancelTarget.onText("Independent Session result"); cancelTarget.resolve(); await new Promise(setImmediate);
    await provider.handle({ type: "resume" });
    await provider.handle({ type: "resetPermissions" });
    const declineReady = new Promise(resolve => { started = resolve; });
    const declineRun = provider.handle({ type: "send", text: "declined wake" }); await declineReady;
    const declineRequest = requests.at(-1); const beforeDecline = requests.length; sessionApproval = undefined;
    await assert.rejects(declineRequest.request.tools.find(tool => tool.name === "ask_session").execute(sessionQuestion, declineRequest.request.signal), /declined/);
    assert.strictEqual(requests.length, beforeDecline); declineRequest.resolve(); await declineRun; sessionApproval = "Ask Session";
    provider.chat.workerState.events = [];
    provider.persist(provider.chat);
    provider.chat.builtinTools = ["read_file"];
    const receiptId = require("crypto").randomUUID();
    const receiptStart = posts.length;
    const receiptReady = new Promise(resolve => { started = resolve; });
    const receiptRun = provider.handle({ type: "send", text: "accepted before busy", chatId: provider.chat.id, submissionId: receiptId }); await receiptReady;
    const receiptPosts = posts.slice(receiptStart);
    const acceptedIndex = receiptPosts.findIndex(item => item.type === "sendAccepted" && item.submissionId === receiptId);
    const busyIndex = receiptPosts.findIndex(item => item.type === "state" && item.busy);
    assert(acceptedIndex >= 0 && busyIndex > acceptedIndex, "Acceptance must precede the first running state");
    assert(receiptPosts[busyIndex].chat.messages.some(item => item.role === "user" && item.content === "accepted before busy"));
    const liveReceiptRequest = requests.at(-1);
    const steerId = require("crypto").randomUUID();
    await provider.handle({ type: "send", text: "Use the revised boundary", mode: "steer", submissionId: steerId });
    await provider.handle({ type: "send", text: "Use the revised boundary", mode: "steer", submissionId: steerId });
    assert.strictEqual(provider.chat.queuedInputs.length, 1, "duplicate delivery must not duplicate a queued steer");
    assert.strictEqual(provider.store.load(first, false).queuedInputs[0].id, steerId, "steer must be saved before acknowledgement");
    assert.deepStrictEqual(provider.chat.queuedInputs[0].executionContext, provider.chat.progress.executionContext);
    liveReceiptRequest.request.beforeRound(liveReceiptRequest.request.messages, liveReceiptRequest.request.maxOutputTokens);
    assert(liveReceiptRequest.request.messages.some(message => message.content === "Use the revised boundary"));
    assert.strictEqual(provider.chat.messages.filter(message => message.submissionId === steerId).length, 1);
    assert.strictEqual(provider.chat.queuedInputs.length, 0);
    const queuedRequestCount = requests.length;
    for (const text of ["Queued task A", "Queued task B"]) await provider.handle({ type: "send", text, mode: "task", submissionId: require("crypto").randomUUID() });
    assert.strictEqual(requests.length, queuedRequestCount, "new tasks must not overlap the active stream");
    const queuedAReady = new Promise(resolve => { started = resolve; });
    liveReceiptRequest.resolve(); await receiptRun; await queuedAReady;
    const queuedA = requests.at(-1);
    assert.strictEqual(queuedA.request.messages.at(-1).content, "Queued task A");
    const queuedBReady = new Promise(resolve => { started = resolve; }); queuedA.resolve(); await queuedBReady;
    const queuedB = requests.at(-1); assert.strictEqual(queuedB.request.messages.at(-1).content, "Queued task B");
    queuedB.resolve(); await new Promise(setImmediate);
    assert.strictEqual(provider.chat.queuedInputs.length, 0); assert.strictEqual(provider.running.size, 0);
    const senderViewer = new ApiChatView(context);
    senderViewer.store = provider.store;
    senderViewer.chat = provider.store.load(first, false);
    senderViewer.chats.set(first, senderViewer.chat);
    const senderPosts = [];
    senderViewer.view = { webview: { postMessage: value => { senderPosts.push(value); return Promise.resolve(true); } } };
    try {
      assert.notStrictEqual(senderViewer.captureExecution(senderViewer.chat).hostId, provider.captureExecution(provider.chat).hostId);
      const ownerReady = new Promise(resolve => { started = resolve; });
      const ownerRun = provider.handle({ type: "send", text: "A owns this request" }); await ownerReady;
      const ownerRequest = requests.at(-1);
      senderViewer.publish();
      const senderSubmission = require("crypto").randomUUID();
      const activeCount = requests.length;
      await senderViewer.handle({ type: "send", text: "B owns the queued task", mode: "task", submissionId: senderSubmission });
      assert.strictEqual(requests.length, activeCount, "foreign submission must not overlap the active stream");
      assert(senderPosts.some(post => post.type === "sendAccepted" && post.submissionId === senderSubmission));
      await assert.rejects(senderViewer.handle({ type: "send", text: "Foreign steer", mode: "steer", submissionId: require("crypto").randomUUID() }), /different execution context/);
      ownerRequest.onText("A output after B submitted");
      const senderReady = new Promise(resolve => { started = resolve; });
      ownerRequest.resolve(); await ownerRun;
      senderViewer.publish(); await senderReady;
      assert.strictEqual(provider.running.size, 0);
      assert.strictEqual(senderViewer.running.size, 1, "only the sending viewer may own the queued request");
      assert.strictEqual(requests.at(-1).request.messages.at(-1).content, "B owns the queued task");
      assert.strictEqual(senderViewer.chat.progress.executionContext.hostId, senderViewer.captureExecution(senderViewer.chat).hostId);
      requests.at(-1).resolve(); await new Promise(setImmediate);
      provider.publish();
      const cancelOwnerReady = new Promise(resolve => { started = resolve; });
      const cancelOwnerRun = provider.handle({ type: "send", text: "Stop A before B" }); await cancelOwnerReady;
      senderViewer.publish();
      const cancelledForeignId = require("crypto").randomUUID();
      await senderViewer.handle({ type: "send", text: "Do not replay after stop", mode: "task", submissionId: cancelledForeignId });
      const beforeForeignCancel = requests.length;
      await provider.handle({ type: "cancel" }); await cancelOwnerRun;
      senderViewer.publish(); await new Promise(setImmediate);
      assert.strictEqual(requests.length, beforeForeignCancel);
      assert.strictEqual(senderViewer.chat.queuedInputs[0].id, cancelledForeignId);
      assert.strictEqual(senderViewer.pendingForeignInputs.size, 0, "a stopped predecessor must disarm automatic dispatch");
      await senderViewer.handle({ type: "removeQueuedInput", id: cancelledForeignId });
      provider.publish();
    } finally { senderViewer.dispose(); }
    const stoppedReady = new Promise(resolve => { started = resolve; });
    const stoppedRun = provider.handle({ type: "send", text: "Stop before queued work" }); await stoppedReady;
    const stoppedCount = requests.length;
    const retainedInput = require("crypto").randomUUID();
    await provider.handle({ type: "send", text: "Retain after stop", mode: "task", submissionId: retainedInput });
    await provider.handle({ type: "cancel" }); await stoppedRun; await new Promise(setImmediate);
    assert.strictEqual(requests.length, stoppedCount, "stop must not automatically launch queued work");
    assert.strictEqual(provider.store.load(first, false).queuedInputs[0].id, retainedInput);
    await provider.handle({ type: "select", id: first });
    assert.strictEqual(requests.length, stoppedCount, "reopening must not replay saved inputs");
    assert.strictEqual(provider.chat.queuedInputs[0].id, retainedInput);
    const retainedReady = new Promise(resolve => { started = resolve; });
    const retainedRun = provider.handle({ type: "runQueued" }); await retainedReady;
    assert.strictEqual(requests.at(-1).request.messages.at(-1).content, "Retain after stop");
    requests.at(-1).resolve(); await retainedRun;
    assert.strictEqual(provider.chat.queuedInputs.length, 0);
    const originalQueuedCount = requests.length;
    const legacyId = require("crypto").randomUUID();
    provider.chat.queuedInputs = [{ id: legacyId, text: "Legacy input", mode: "task" }];
    provider.persist(provider.chat);
    await assert.rejects(provider.handle({ type: "runQueued" }), /legacy queued input/);
    assert.strictEqual(requests.length, originalQueuedCount);
    assert.strictEqual(provider.chat.queuedInputs[0].id, legacyId);
    const foreignContext = require("../dist/chat/execution-context").captureExecutionContext(require("crypto").randomUUID(), [], directory, true, provider.chat.permissionMode || "ask");
    provider.chat.queuedInputs[0].executionContext = foreignContext;
    provider.persist(provider.chat);
    await assert.rejects(provider.handle({ type: "runQueued" }), /execution context changed/);
    assert.strictEqual(requests.length, originalQueuedCount, "another window must not take over a queued input");
    await provider.handle({ type: "removeQueuedInput", id: legacyId });
    const localContext = provider.captureExecution(provider.chat);
    assert.throws(() => provider.assertExecution(provider.chat, foreignContext), /execution context changed/);
    const savedPermissionMode = provider.chat.permissionMode;
    provider.chat.permissionMode = savedPermissionMode === "read-only" ? "ask" : "read-only";
    assert.throws(() => provider.assertExecution(provider.chat, localContext), /execution context changed/);
    provider.chat.permissionMode = savedPermissionMode;
    await assert.rejects(provider.handle({ type: "send", text: "wrong Chat", chatId: "another-chat", submissionId: require("crypto").randomUUID() }), /selected Chat changed/);
    await assert.rejects(provider.handle({ type: "model", value: "retired-api" }), /deprecated/);
    const profiles = configuration.apiChatModelProfiles; configuration.apiChatModelProfiles = [{ id: "invalid", status: "active", contextWindow: 0 }];
    await assert.rejects(provider.handle({ type: "send", text: "invalid profile" })); assert.strictEqual(provider.running.size, 0); configuration.apiChatModelProfiles = profiles;
    context.secrets.get = () => new Promise(() => {});
    const credentialsRun = provider.handle({ type: "send", text: "cancel credentials" });
    await provider.handle({ type: "cancel" }); await credentialsRun; assert.strictEqual(provider.running.size, 0);
    context.secrets.get = async () => "test-key";
    configuration.aiEndpoint = "";
    const count = provider.chat.messages.length;
    const rejectedStart = posts.length;
    await assert.rejects(provider.handle({ type: "send", text: "draft remains", chatId: provider.chat.id, submissionId: require("crypto").randomUUID() }), /endpoint/);
    assert.strictEqual(provider.chat.messages.length, count);
    assert(!posts.slice(rejectedStart).some(item => item.type === "sendAccepted" || item.type === "state" && item.busy));
    assert.strictEqual(provider.running.size, 0);
    nativeClient = require("../dist/chat/api-chat-vscode"); originalNativeDiscovery = nativeClient.discoverVscodeModels; originalNativeStream = nativeClient.streamVscodeChat;
    const models = [{ id: "current-native", name: "Current model", vendor: "copilot", maxInputTokens: 8192, capabilities: { toolCalling: true, imageInput: true } }, { id: "next-native", name: "Next model", vendor: "fixture", maxInputTokens: 16384, capabilities: { toolCalling: true, imageInput: true } }];
    nativeClient.discoverVscodeModels = async () => models;
    picks.push(items => items.find(item => item.id === "__vscode__"), items => items.find(item => item.id === nativeClient.vscodeModelProfile(models[0]).id));
    await provider.handle({ type: "chooseModel" });
    assert.strictEqual(provider.chat.modelProvider, "vscode"); assert.strictEqual(configuration.apiChatProvider, "openai-compatible");
    assert.strictEqual(provider.settings().selectedProfile.inputPricePerMillion, undefined);
    let credentialReads = 0; context.secrets.get = async () => { credentialReads++; throw new Error("No native API key reads"); };
    picks.push(items => { assert.deepStrictEqual(items.map(item => item.label), models.map(model => model.name)); return items[0]; });
    await provider.handle({ type: "chooseModel" }); assert.strictEqual(credentialReads, 0);
    const nativeRequests = []; let nativeStarted;
    nativeClient.streamVscodeChat = (model, request, onText) => new Promise((resolve, reject) => { nativeRequests.push({ model, request, onText, resolve }); request.signal.addEventListener("abort", () => reject(new Error("Request cancelled.")), { once: true }); nativeStarted(); });
    let resolveModels; let discoveryStarted;
    const checking = new Promise(resolve => { discoveryStarted = resolve; });
    nativeClient.discoverVscodeModels = () => new Promise(resolve => { resolveModels = resolve; discoveryStarted(); });
    const originalContext = provider.chat.context[0].content;
    provider.chat.images = [testImage];
    const startedNative = new Promise(resolve => { nativeStarted = resolve; });
    const nativeRun = provider.handle({ type: "send", text: "native question" }); await checking;
    provider.chat.context[0].content = "changed during access check";
    const nextDraftImage = { ...testImage, label: "next-request.png" }; provider.chat.images = [nextDraftImage];
    await provider.handle({ type: "model", value: nativeClient.vscodeModelProfile(models[1]).id });
    resolveModels(models); await startedNative;
    assert.strictEqual(nativeRequests[0].model.id, "current-native"); assert(nativeRequests[0].request.messages.some(item => item.content.includes(originalContext))); assert(!nativeRequests[0].request.messages.some(item => item.content.includes("changed during access check")));
    assert.strictEqual(nativeRequests[0].request.messages.at(-1).images[0].label, testImage.label);
    assert.strictEqual(provider.chat.messages.at(-2).images[0].label, testImage.label);
    assert.strictEqual(provider.chat.images[0], nextDraftImage);
    nativeRequests[0].request.onImage({ ...testImage, label: "output.png" });
    nativeRequests[0].onText("native reply"); nativeRequests[0].resolve(); await nativeRun;
    assert.strictEqual(credentialReads, 0); assert.strictEqual(provider.chat.messages.at(-1).usage, undefined); assert.strictEqual(provider.chat.messages.at(-1).estimatedCost, undefined);
    assert.strictEqual(provider.store.load(first).messages.at(-1).images[0].label, "output.png");
    provider.chat.images = [];
    assert.strictEqual(provider.store.load(provider.chat.id).modelProvider, "vscode");
    nativeClient.discoverVscodeModels = async () => models;
    const nextNativeStarted = new Promise(resolve => { nativeStarted = resolve; }); const nextNative = provider.handle({ type: "send", text: "next native question" }); await nextNativeStarted;
    assert.strictEqual(nativeRequests[1].model.id, "next-native");
    automaticDecisionApproval = false;
    const cancelledLoop = nativeRequests[1].request.onToolLoopNotice({ reason: "stalled", tool: "fixture", rounds: 3, repeats: 3 }, nativeRequests[1].request.signal);
    const cancelledLoopId = [...provider.decisions.keys()][0]; assert(cancelledLoopId);
    const cancelledLoopCheck = assert.rejects(cancelledLoop, /cancelled/);
    await provider.handle({ type: "cancel" }); await cancelledLoopCheck; await nextNative;
    assert.strictEqual(provider.decisions.size, 0, "stopping a request clears its inline decision");
    await assert.rejects(provider.handle({ type: "decision", id: cancelledLoopId, value: "continue" }), /no longer pending/);
    automaticDecisionApproval = true;
    nativeClient.discoverVscodeModels = async () => [models[0]];
    const beforeMissing = provider.chat.messages.length; await provider.handle({ type: "send", text: "missing model" });
    assert.strictEqual(provider.chat.messages.length, beforeMissing + 2);
    assert.strictEqual(provider.chat.messages.at(-2).content, "missing model");
    assert.strictEqual(provider.chat.messages.at(-1).status, "failed");
    assert.strictEqual(nativeRequests.length, 2);
    assert.match(provider.chat.messages.at(-1).error, /no longer available/);
    assert.match(provider.store.load(provider.chat.id, false).messages.at(-1).error, /no longer available/);
    const previousChat = provider.chat.id;
    const previousModel = provider.chat.vscodeModelId;
    const previousBudget = provider.chat.contextWindow;
    await provider.handle({ type: "new" }); assert.strictEqual(provider.settings().provider, "vscode");
    assert.strictEqual(provider.chat.vscodeModelId, previousModel);
    assert.strictEqual(provider.chat.contextWindow, undefined);
    assert.strictEqual(provider.chat.builtinTools, undefined);
    assert.strictEqual(provider.chat.mcpServers, undefined);
    assert.strictEqual(provider.chat.permissionMode, "protective");
    assert.strictEqual(provider.store.load(previousChat).contextWindow, previousBudget);
    const freshView = new ApiChatView(context);
    freshView.initialize();
    assert.strictEqual(freshView.settings().selectedProfile.id, previousModel);
    assert.strictEqual(freshView.settings().needsModelConnection, false);
    assert.strictEqual(freshView.vscodeModels.length, 0, "Remembering a model does not perform provider discovery on initialization.");
    const disposedDecision = freshView.requestDecision(freshView.chat, "Fixture pending confirmation", "No work may be performed after disposal.", [{ value: "confirm", label: "Confirm" }, { value: "cancel", label: "Cancel" }]);
    assert.strictEqual(freshView.decisions.size, 1);
    freshView.dispose();
    assert.strictEqual(await disposedDecision, undefined, "disposing an idle Chat cancels rather than approves its decision");
    assert.strictEqual(freshView.decisions.size, 0);
    picks.push(items => items.find(item => item.id === "read-only"));
    await provider.configureAgent(provider.chat.sessionId || provider.chat.id, "permissions");
    assert.strictEqual(provider.store.load(provider.chat.id).permissionMode, "read-only");
    provider.chat.builtinTools = ["session_info", "pkm_search", "pkm_read", "list_chats", "replace_text", "run_process", "ask_session", "ask_chat"];
    provider.chat.mcpServers = [{ id: "disabled-by-permission", label: "No connection", url: "https://example.test/mcp", enabled: true, tools: ["echo"] }];
    nativeClient.discoverVscodeModels = async () => models;
    const readonlyStarted = new Promise(resolve => { nativeStarted = resolve; });
    const readonlyRun = provider.handle({ type: "send", text: "Check readonly tool permissions" }); await readonlyStarted;
    assert.deepStrictEqual(nativeRequests.at(-1).request.tools.map(tool => tool.name).sort(), ["list_chats", "pkm_read", "pkm_search", "session_info"]);
    assert(!provider.chat.progress.steps.some(step => step.label.startsWith("Connecting MCP")));
    nativeRequests.at(-1).onText("Read-only tools verified"); nativeRequests.at(-1).resolve(); await readonlyRun;
    const completedTaskId = provider.chat.sessionId;
    const taskModalCount = nativeConfirmations.length;
    sessionApproval = undefined;
    await provider.handle({ type: "completeTask" });
    assert.strictEqual(provider.chat.sessionId, completedTaskId, "cancelled inline Task completion preserves the Task");
    sessionApproval = "Complete Task";
    await provider.handle({ type: "completeTask" });
    assert.strictEqual(provider.chat.sessionId, undefined);
    assert.strictEqual(nativeConfirmations.length, taskModalCount, "Task completion must not invoke a VS Code modal");
    sessionApproval = "Ask Session";
    picks.push(items => { assert(items.some(item => item.value === "permissions")); return items.find(item => item.value === "permissions"); }, items => items.find(item => item.id === "ask"));
    await provider.configureAgent(provider.chat.sessionId || provider.chat.id, "choose");
    assert.strictEqual(provider.chat.permissionMode, "ask");
    for (const secret of ["test-key", "memory snapshot", "pkm skill snapshot", "external skill snapshot"]) assert(!JSON.stringify(userState.get("apiChat.defaultModel")).includes(secret));
    await provider.handle({ type: "select", id: first }); assert.strictEqual(provider.settings().provider, "vscode");
    nativeClient.discoverVscodeModels = async () => models;
    picks.push(items => items.find(item => item.value === "vscode"), () => undefined);
    const selection = provider.chat.vscodeModelId; await provider.handle({ type: "settings" }); assert.strictEqual(provider.chat.vscodeModelId, selection);
    selectedFiles = [{ scheme: "file", fsPath: imageFile }];
    const originalReadImage = readImage; let imageReading; let releaseImage;
    const imageReady = new Promise(resolve => { imageReading = resolve; });
    readImage = () => { imageReading(); return new Promise(resolve => { releaseImage = resolve; }); };
    const loadingImage = provider.handle({ type: "image" }); await imageReady;
    provider.chat.images = [{ ...testImage, label: "latest draft.png" }]; releaseImage(decodeChatImage(testImage));
    await assert.rejects(loadingImage, /changed while files/); assert.strictEqual(provider.chat.images[0].label, "latest draft.png");
    provider.chat.images = []; readImage = originalReadImage;
    await provider.handle({ type: "image" }); assert.strictEqual(provider.store.load(first).images[0].dataBase64, testImage.dataBase64);
    selectedFiles = undefined; await provider.handle({ type: "image" }); assert.strictEqual(provider.chat.images.length, 1);
    selectedFiles = [{ scheme: "file", fsPath: imageFile }, { scheme: "file", fsPath: imageFile }];
    await assert.rejects(provider.handle({ type: "image" }), /two images/); assert.strictEqual(provider.chat.images.length, 1);
    await provider.handle({ type: "removeImage", value: 0 }); assert.strictEqual(provider.store.load(first).images.length, 0);
    const imageReply = provider.chat.messages.find(message => message.role === "assistant" && message.images?.length);
    await provider.handle({ type: "saveImage", id: imageReply.id, value: 0 }); assert.strictEqual(imageWrites, 0, "Dismissed save dialog must not write");
    saveDestination = { scheme: "file", fsPath: path.join(directory, "saved.png") };
    await provider.handle({ type: "saveImage", id: imageReply.id, value: 0 }); assert.strictEqual(imageWrites, 1);
    assert(fs.readFileSync(saveDestination.fsPath).equals(decodeChatImage(testImage)));
    const beforeCatalog = { messages: provider.chat.messages.length, requests: nativeRequests.length };
    const recordedAttempt = provider.chat.messages.filter(message => message.role === "assistant").at(-1);
    assert(recordedAttempt.progress.attemptId);
    assert.strictEqual(recordedAttempt.progress.status, recordedAttempt.status);
    assert(recordedAttempt.progress.steps.every(step => step.status !== "running" && step.status !== "waiting"));
    assert.deepStrictEqual(provider.store.load(provider.chat.id).messages.find(message => message.id === recordedAttempt.id).progress, recordedAttempt.progress);
    provider.chat.vscodeModelId = "vscode:copilotcli:gpt-6.1-sol";
    const catalogPosts = posts.length;
    await assert.rejects(provider.handle({ type: "send", text: "catalog-only saved model" }), /catalog-only/);
    assert.strictEqual(provider.chat.messages.length, beforeCatalog.messages);
    assert.strictEqual(nativeRequests.length, beforeCatalog.requests);
    assert(!posts.slice(catalogPosts).some(item => item.type === "sendAccepted" || item.type === "state" && item.busy));
    provider.chat.vscodeModelId = selection;
    provider.invalidateModels(); assert.strictEqual(provider.settings().needsModelConnection, false);
    const refreshedStarted = new Promise(resolve => { nativeStarted = resolve; });
    const refreshedRun = provider.handle({ type: "send", text: "verify remembered model after refresh" }); await refreshedStarted;
    assert.strictEqual(nativeRequests.at(-1).model.id, models[1].id);
    nativeRequests.at(-1).onText("Verified after fresh discovery"); nativeRequests.at(-1).resolve(); await refreshedRun;
    provider.view.visible = true;
    const programmableModels = await provider.agentControl("models", {});
    const programmableModelId = programmableModels.models[1].id;
    const createdControl = await provider.agentControl("create", { title: "Agent-driven visible Chat", modelId: programmableModelId });
    assert.strictEqual(createdControl.sessionId, null); assert.strictEqual(createdControl.title, "Agent-driven visible Chat");
    assert((await provider.agentControl("list", {})).chats.some(chat => chat.id === createdControl.chatId));
    await assert.rejects(provider.agentControl("create", { title: "No fallback", modelId: "missing-model" }), /unavailable/);
    const controlledStarted = new Promise(resolve => { nativeStarted = resolve; });
    registeredTools.push({ name: "mcp_pkm_api_chat_send", description: "Programmable Chat send" });
    const controlledRun = provider.agentControl("send", { chatId: createdControl.chatId, prompt: "Read actual AAGL notes and skills" });
    await Promise.race([controlledStarted, controlledRun.then(result => { throw new Error("Agent-controlled send completed without starting the model: " + result.reply?.error); })]);
    assert.strictEqual((await provider.agentControl("get", { chatId: createdControl.chatId })).status, "running");
    await assert.rejects(provider.agentControl("send", { chatId: createdControl.chatId, prompt: "No duplicate" }), /busy/);
    assert(!nativeRequests.at(-1).request.tools.some(tool => tool.name === "ask_session"), "Agent-driven turns cannot recursively wake Sessions");
    assert(!nativeRequests.at(-1).request.tools.some(tool => tool.name === "ask_chat"), "Agent-driven turns cannot recursively delegate to Chats");
    const finder = nativeRequests.at(-1).request.tools.find(tool => tool.name === "find_vscode_tools");
    if (finder) assert(!JSON.parse(await finder.execute({ query: "api_chat_send" }, nativeRequests.at(-1).request.signal)).tools.some(tool => tool.name === "mcp_pkm_api_chat_send"), "Agent-driven turns cannot recursively create/send Chats");
    nativeRequests.at(-1).onText("Actual controller fixture answer"); nativeRequests.at(-1).resolve();
    const controlledResult = await controlledRun; assert.strictEqual(controlledResult.reply.status, "complete");
    assert.strictEqual(controlledResult.reply.content, "Actual controller fixture answer"); assert.strictEqual(controlledResult.reply.credits, null);
    assert.strictEqual(provider.store.load(createdControl.chatId, false).sessionId, undefined);
    const cancellingStarted = new Promise(resolve => { nativeStarted = resolve; });
    const cancellingRun = provider.agentControl("send", { chatId: createdControl.chatId, prompt: "Explicitly cancelled fixture" }); await cancellingStarted;
    nativeRequests.at(-1).onText("Preserved partial output");
    await provider.agentControl("cancel", { chatId: createdControl.chatId });
    const cancelledControl = await cancellingRun;
    assert.strictEqual(cancelledControl.reply.status, "cancelled"); assert.strictEqual(cancelledControl.reply.content, "Preserved partial output");
    assert(!provider.chat.paused, "Response cancellation must not pause or stop the Chat");
    await provider.handle({ type: "pause" });
    await assert.rejects(provider.agentControl("send", { chatId: createdControl.chatId, prompt: "Do not auto-resume" }), /paused/);
    const rememberedModel = context.workspaceState.get("apiChat.defaultModel");
    await context.workspaceState.update("apiChat.defaultModel", undefined);
    const restartedView = new ApiChatView(context);
    try {
      await restartedView.handle({ type: "new" });
      restartedView.chat.modelProvider = "vscode";
      restartedView.chat.vscodeModelId = nativeClient.vscodeModelProfile(models[0]).id;
      restartedView.chat.permissionMode = "read-only";
      restartedView.store.save(restartedView.chat);
      assert.strictEqual(restartedView.vscodeModels.length, 0);
      assert.strictEqual(restartedView.settings().needsModelConnection, true);
      nativeClient.discoverVscodeModels = async () => models;
      const startupStarted = new Promise(resolve => { nativeStarted = resolve; });
      const startupRun = restartedView.handle({ type: "send", text: "Cold worker startup fixture" });
      await Promise.race([startupStarted, startupRun.then(() => { throw new Error("Cold startup completed without using its saved model"); })]);
      assert.strictEqual(nativeRequests.at(-1).model.id, models[0].id);
      nativeRequests.at(-1).onText("Saved worker model discovered"); nativeRequests.at(-1).resolve(); await startupRun;
      assert.strictEqual(restartedView.chat.messages.at(-1).status, "complete");
      restartedView.chat.vscodeModelId = "vscode:copilot:missing-worker";
      restartedView.store.save(restartedView.chat); restartedView.vscodeModels = [];
      const beforeColdMissing = restartedView.chat.messages.length;
      const beforeColdRequests = nativeRequests.length;
      await assert.rejects(restartedView.handle({ type: "send", text: "Missing worker model fixture" }), /no longer available/);
      assert.strictEqual(restartedView.chat.messages.length, beforeColdMissing);
      assert.strictEqual(nativeRequests.length, beforeColdRequests);
      assert.strictEqual(restartedView.running.size, 0);
    } finally {
      restartedView.dispose();
      await context.workspaceState.update("apiChat.defaultModel", rememberedModel);
    }
    console.log("API chat controller tests passed: rename persistence/ownership, run/approval/unread status, model picker, request ownership, memory privacy, budgets and cancellation.");
    console.log("VS Code controller tests passed: no API key, per-chat source, captured context/model, next-request switching, persistence and no silent fallback.");
  } finally {
    if (nativeClient) { nativeClient.discoverVscodeModels = originalNativeDiscovery; nativeClient.streamVscodeChat = originalNativeStream; }
    provider?.dispose(); client.streamApiChat = originalStream; if (builtin) builtin.createBuiltinTools = originalBuiltin; Module._load = originalLoad;
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

async function testVscodeModels() {
  const Module = require("module"); const originalLoad = Module._load;
  let adapter;
  try {
    Module._load = function(name, ...rest) { return name === "vscode" ? {} : originalLoad.call(this, name, ...rest); };
    adapter = require("../dist/chat/api-chat-vscode");
  } finally { Module._load = originalLoad; }
  const { discoverVscodeModels, streamVscodeChat, vscodeModelProfile } = adapter;
  class TextPart { constructor(value) { this.value = value; } }
  class CallPart { constructor(callId, name, input) { Object.assign(this, { callId, name, input }); } }
  class ResultPart { constructor(callId, content) { Object.assign(this, { callId, content }); } }
  class DataPart { constructor(data, mimeType) { Object.assign(this, { data, mimeType }); } }
  let cancelled = 0;
  const host = { lm: { selectChatModels: async () => [model] }, LanguageModelChatMessage: { User: content => ({ role: "user", content }), Assistant: content => ({ role: "assistant", content }) }, LanguageModelTextPart: TextPart, LanguageModelToolCallPart: CallPart, LanguageModelToolResultPart: ResultPart, CancellationTokenSource: class { token = {}; cancel() { cancelled++; } dispose() {} } };
  const prompts = []; let rounds = 0; let execution = 0; let output = "";
  const model = { id: "live-id", name: "Available model", vendor: "fixture", maxInputTokens: 8192, capabilities: { toolCalling: true }, sendRequest: async (messages, options) => { prompts.push({ messages, options }); const parts = ++rounds === 1 ? [new CallPart("call-1", "read_file", { path: "file.txt" })] : [new TextPart("done")]; return { stream: (async function* () { yield* parts; })() }; } };
  assert.strictEqual((await discoverVscodeModels(host))[0], model);
  const catalogOnly = { ...model, vendor: "copilotcli", id: "gpt-6.1-sol", sendRequest: async () => { throw new Error("Catalog-only provider must not be called"); } };
  assert.deepStrictEqual(await discoverVscodeModels({ ...host, lm: { selectChatModels: async () => [catalogOnly, model] } }), [model]);
  await assert.rejects(discoverVscodeModels({ ...host, lm: { selectChatModels: async () => [catalogOnly] } }), /catalog-only/);
  await assert.rejects(streamVscodeChat(catalogOnly, { messages: [{ role: "user", content: "test" }], signal: new AbortController().signal }, () => {}, host), /catalog-only/);
  const profile = vscodeModelProfile(model); assert.strictEqual(profile.status, "active"); assert.strictEqual(profile.contextWindow, 8192); assert.strictEqual(profile.inputPricePerMillion, undefined);
  const events = []; const request = { messages: [{ role: "system", content: "Instructions" }, { role: "user", content: "question" }], signal: new AbortController().signal, maxOutputTokens: 1024, tools: [{ name: "read_file", description: "Read", parameters: { type: "object" }, execute: async () => { execution++; return "file contents"; } }], onTool: event => events.push(event) };
  await streamVscodeChat(model, request, text => { output += text; }, host);
  assert.strictEqual(output, "done"); assert.strictEqual(execution, 1); assert.strictEqual(events[1].status, "complete"); assert.strictEqual(prompts[0].options.tools[0].inputSchema.type, "object");
  let outputBudgetRounds = 0;
  let outputBudgetAnswer = "";
  const roundBudgets = [];
  const outputBudgetModel = { ...model, sendRequest: async () => ({ stream: (async function* () {
    yield new TextPart("x".repeat(800));
    if (++outputBudgetRounds === 1) yield new CallPart("budget-round-1", "read_file", { path: "file.txt" });
  })() }) };
  await streamVscodeChat(outputBudgetModel, { ...request, beforeRound: (_messages, budget) => roundBudgets.push(budget) }, text => { outputBudgetAnswer += text; }, host);
  assert.strictEqual(outputBudgetAnswer.length, 1600, "Tool rounds must not consume the next response's output budget");
  assert.deepStrictEqual(roundBudgets, [1024, 1024]);
  let boundedRounds = 0;
  const beforeBounded = execution;
  let boundedAnswer = "";
  const boundedModel = { ...model, sendRequest: async (messages, options) => {
    boundedRounds++;
    if (boundedRounds === 3) {
      assert.strictEqual(options.tools, undefined);
      assert(messages.some(message => message.content.some(part => part.value?.includes(toolBudgetSummary))));
    }
    const parts = options.tools ? [new CallPart(`bounded-${boundedRounds}`, "read_file", { path: "file.txt" })] : [new TextPart("Summary from completed results")];
    return { stream: (async function* () { yield* parts; })() };
  } };
  await streamVscodeChat(boundedModel, { ...request, maxToolRounds: 2 }, text => { boundedAnswer += text; }, host);
  assert.strictEqual(boundedRounds, 3); assert.strictEqual(execution - beforeBounded, 2);
  assert.strictEqual(boundedAnswer, "Summary from completed results");
  let continuationRounds = 0; const continuationNotices = []; const beforeContinuation = execution;
  const continuationModel = { ...model, sendRequest: async (_messages, options) => ({ stream: (async function* () {
    continuationRounds++;
    if (continuationRounds <= 3) yield new CallPart(`continue-${continuationRounds}`, "read_file", { path: `file-${continuationRounds}` });
    else yield new TextPart("Continued after confirmation");
  })() }) };
  await streamVscodeChat(continuationModel, { ...request, maxToolRounds: 2, onToolLoopNotice: async notice => { continuationNotices.push(notice); assert.strictEqual(execution - beforeContinuation, 2); return "continue"; } }, () => {}, host);
  assert.strictEqual(execution - beforeContinuation, 3);
  assert.deepStrictEqual(continuationNotices, [{ reason: "round-limit", rounds: 2, limit: 2 }]);
  let nativeBatchRounds = 0; const beforeNativeBatch = execution; const nativeBatchNotices = [];
  const batchModel = { ...model, sendRequest: async (_messages, options) => ({ stream: (async function* () {
    nativeBatchRounds++;
    if (nativeBatchRounds === 1) for (let index = 0; index < 5; index++) yield new CallPart(`batch-${index}`, "read_file", { path: "same.txt" });
    else { assert.strictEqual(options.tools, undefined); yield new TextPart("Three results retained"); }
  })() }) };
  await streamVscodeChat(batchModel, { ...request, maxOutputTokens: 4096, onToolLoopNotice: async notice => { nativeBatchNotices.push(notice); assert.strictEqual(execution - beforeNativeBatch, 3); return "summarize"; } }, () => {}, host);
  assert.strictEqual(execution - beforeNativeBatch, 3, "The fourth native call in the same batch must await approval");
  assert.strictEqual(nativeBatchNotices.length, 1);
  assert.strictEqual(nativeBatchNotices[0].reason, "stalled");
  const imageHost = { ...host, LanguageModelDataPart: DataPart };
  const metadataModel = parts => ({ ...model, sendRequest: async () => ({ stream: (async function* () { yield* parts; })() }) });
  const metadata = ["usage", "stateful_marker", "thinking", "context_management", "phase_data", "cache_control"].map(mime => new DataPart(new Uint8Array([1, 2]), mime));
  let metadataOutput = "";
  await streamVscodeChat(metadataModel([new TextPart("hello"), ...metadata]), { ...request, tools: [] }, text => { metadataOutput += text; }, imageHost);
  assert.strictEqual(metadataOutput, "hello");
  let partialCodingOutput = "";
  await assert.rejects(streamVscodeChat(metadataModel([new TextPart("partial"), new TextPart("x".repeat(1024))]), { ...request, tools: [], maxOutputTokens: 1024 }, text => { partialCodingOutput += text; }, imageHost), /Local output budget exhausted/);
  assert.strictEqual(partialCodingOutput, "partial");
  await assert.rejects(streamVscodeChat(metadataModel([new TextPart("\u4e2d".repeat(342))]), { ...request, tools: [], maxOutputTokens: 1024 }, () => {}, imageHost), /Local output budget exhausted/);
  let chineseOutput = "";
  const countedModel = { ...metadataModel([new TextPart("\u4e2d".repeat(900))]), countTokens: async text => Array.from(text).length };
  await streamVscodeChat(countedModel, { ...request, tools: [], maxOutputTokens: 1024 }, text => { chineseOutput += text; }, imageHost);
  assert.strictEqual(chineseOutput.length, 900, "The model tokenizer, not UTF-8 bytes, determines the native output budget");
  await assert.rejects(streamVscodeChat({ ...countedModel, countTokens: async () => NaN }, { ...request, tools: [] }, () => {}, imageHost), /Output token count is unavailable/);
  await assert.rejects(streamVscodeChat({ ...countedModel, countTokens: async () => 1025 }, { ...request, tools: [] }, () => {}, imageHost), /Local output budget exhausted/);
  const outputCountingAbort = new AbortController();
  const outputCountingFallback = setTimeout(() => outputCountingAbort.abort(), 250);
  try {
    await assert.rejects(streamVscodeChat({ ...metadataModel([new TextPart("short response")]), countTokens: () => new Promise(() => {}) }, { ...request, tools: [], timeoutMs: 25, loopReviewAfterMs: 0, signal: outputCountingAbort.signal }, () => {}, imageHost), /timed out/);
  } finally { clearTimeout(outputCountingFallback); }
  let countedTools = 0;
  await assert.rejects(streamVscodeChat({ ...model, countTokens: async () => 1025, sendRequest: async () => ({ stream: (async function* () { yield new CallPart("over-budget", "read_file", { path: "file.txt" }); })() }) }, { ...request, tools: [{ ...request.tools[0], execute: async () => { countedTools++; return "contents"; } }] }, () => {}, host), /Local output budget exhausted/);
  assert.strictEqual(countedTools, 0, "Over-budget output must never execute pending tools");
  const usagePart = usage => new DataPart(new TextEncoder().encode(JSON.stringify(usage)), "usage");
  const reportedUsage = [];
  const observedUsage = [];
  const nativeUsageRequest = { ...request, tools: [], onUsage: usage => reportedUsage.push(usage), onUsageMetadata: valid => observedUsage.push(valid) };
  await streamVscodeChat(metadataModel([new TextPart("hello"), usagePart({ prompt_tokens: 100, completion_tokens: 20 }), usagePart({ prompt_tokens: 110, completion_tokens: 25, prompt_tokens_details: { cached_tokens: 8 }, reasoning: "not recorded" })]), nativeUsageRequest, () => {}, imageHost);
  assert.deepStrictEqual(reportedUsage, [{ inputTokens: 110, outputTokens: 25, cachedInputTokens: 8 }]);
  assert.deepStrictEqual(observedUsage, [true, true]);
  for (const usage of [null, [], { inputTokens: 100, outputTokens: 20 }, { prompt_tokens: -1, completion_tokens: 2 }, { prompt_tokens: 1.5, completion_tokens: 2 }, { prompt_tokens: 2 }, { prompt_tokens: Number.MAX_SAFE_INTEGER + 1, completion_tokens: 2 }]) {
    await streamVscodeChat(metadataModel([new TextPart("hello"), usagePart(usage)]), nativeUsageRequest, () => {}, imageHost);
    assert.strictEqual(reportedUsage.length, 1);
  }
  assert.deepStrictEqual(observedUsage, [true, true, false, false, false, false, false, false, false]);
  await streamVscodeChat(metadataModel([new TextPart("hello"), usagePart({ prompt_tokens: 0, completion_tokens: 0 })]), nativeUsageRequest, () => {}, imageHost);
  assert.deepStrictEqual(reportedUsage.at(-1), { inputTokens: 0, outputTokens: 0 });
  await assert.rejects(streamVscodeChat(metadataModel([usagePart({ prompt_tokens: 10, completion_tokens: 0 })]), nativeUsageRequest, () => {}, imageHost), /empty response/);
  assert.deepStrictEqual(reportedUsage.at(-1), { inputTokens: 10, outputTokens: 0 });
  await assert.rejects(streamVscodeChat(metadataModel(metadata), { ...request, tools: [] }, () => {}, imageHost), /empty response/);
  await assert.rejects(streamVscodeChat(metadataModel([new DataPart(new Uint8Array(65537), "usage")]), { ...request, tools: [] }, () => {}, imageHost), /metadata exceeded/);
  await assert.rejects(streamVscodeChat(metadataModel(Array(129).fill(metadata[0])), { ...request, tools: [] }, () => {}, imageHost), /metadata exceeded/);
  await assert.rejects(streamVscodeChat(metadataModel([new DataPart(new Uint8Array([1]), "application/pdf")]), { ...request, tools: [] }, () => {}, imageHost), /Unsupported model data/);
  let imageCalls = 0; const imageOutputs = [];
  const imageModel = { ...model, capabilities: { imageInput: true }, countTokens: async () => 100, sendRequest: async prompt => {
    imageCalls++; assert(prompt[0].content.some(part => part instanceof DataPart && Buffer.from(part.data).equals(decodeChatImage(testImage))));
    return { stream: (async function* () { yield new DataPart(decodeChatImage(testImage), "image/png"); })() };
  } };
  const imageRequest = { ...request, tools: [], contextWindow: 8192, messages: [{ role: "user", content: "Inspect", images: [testImage] }], onImage: image => imageOutputs.push(image) };
  await streamVscodeChat(imageModel, imageRequest, () => {}, imageHost);
  assert.strictEqual(imageCalls, 1); assert.strictEqual(imageOutputs[0].dataBase64, testImage.dataBase64); assert.strictEqual(vscodeModelProfile(imageModel).imageInput, true);
  await assert.rejects(streamVscodeChat({ ...imageModel, capabilities: {} }, imageRequest, () => {}, imageHost), /image input/);
  await assert.rejects(streamVscodeChat(imageModel, imageRequest, () => {}, host), /image input/);
  await assert.rejects(streamVscodeChat({ ...imageModel, countTokens: async () => 8192 }, imageRequest, () => {}, imageHost), /Image context budget/);
  await assert.rejects(streamVscodeChat({ ...imageModel, countTokens: async () => NaN }, imageRequest, () => {}, imageHost), /token count/);
  assert.strictEqual(imageCalls, 1, "Unsupported/over-budget images must not call the model");
  const badImageResponse = { ...imageModel, sendRequest: async () => ({ stream: (async function* () { yield new DataPart(new Uint8Array([1, 2]), "image/svg+xml"); })() }) };
  await assert.rejects(streamVscodeChat(badImageResponse, imageRequest, () => {}, imageHost), /image response/);
  const countAbort = new AbortController(); let counting;
  const countingStarted = new Promise(resolve => { counting = resolve; });
  const countingRun = streamVscodeChat({ ...imageModel, countTokens: () => { counting(); return new Promise(() => {}); } }, { ...imageRequest, signal: countAbort.signal }, () => {}, imageHost);
  await countingStarted; countAbort.abort(); await assert.rejects(countingRun, /cancelled/);
  assert(prompts[1].messages.some(message => message.content.some(part => part instanceof ResultPart && part.callId === "call-1" && part.content[0].value === "file contents"))); assert.doesNotThrow(() => JSON.stringify(prompts)); assert(cancelled > 0);
  await assert.rejects(discoverVscodeModels({}), /version/);
  await assert.rejects(discoverVscodeModels({ lm: { selectChatModels: async () => [] } }), /No VS Code models/);
  await assert.rejects(discoverVscodeModels({ lm: { selectChatModels: async () => { throw new Error("secret-token"); } } }), error => !error.message.includes("secret-token") && /permission/.test(error.message));
  for (const capabilities of [undefined, {}]) {
    let requests = 0; const before = execution;
    const unknownModel = { ...model, capabilities, sendRequest: async (_messages, options) => {
      assert.strictEqual(options.tools[0].name, "read_file");
      const parts = ++requests === 1 ? [new CallPart("unknown-capability", "read_file", { path: "file.txt" })] : [new TextPart("done")];
      return { stream: (async function* () { yield* parts; })() };
    } };
    await streamVscodeChat(unknownModel, request, () => {}, host);
    assert.strictEqual(requests, 2); assert.strictEqual(execution, before + 1);
  }
  await assert.rejects(streamVscodeChat({ ...model, capabilities: { toolCalling: false } }, request, () => {}, host), /tool calling/);
  await assert.rejects(streamVscodeChat({ ...model, capabilities: undefined }, request, () => {}, { ...host, LanguageModelToolCallPart: undefined }), /tool calling/);
  let unavailableRequests = 0;
  await assert.rejects(streamVscodeChat({ ...model, capabilities: undefined, sendRequest: async () => { unavailableRequests++; throw new Error("secret-token"); } }, request, () => {}, host), error => !error.message.includes("secret-token") && /quota/.test(error.message));
  assert.strictEqual(unavailableRequests, 1, "Unknown capability is not permission to retry or fall back");
  await assert.rejects(streamVscodeChat({ ...model, capabilities: { toolCalling: -1 } }, request, () => {}, host), /tool calling/);
  await assert.rejects(streamVscodeChat({ ...model, capabilities: { toolCalling: 0.5 } }, request, () => {}, host), /tool calling/);
  await assert.rejects(streamVscodeChat({ ...model, capabilities: { toolCalling: 1 } }, { ...request, tools: [...request.tools, { ...request.tools[0], name: "second" }] }, () => {}, host), /tool calling/);
  await assert.rejects(streamVscodeChat(model, { ...request, beforeRound: () => { throw new Error("Context budget exceeded"); } }, () => {}, host), /Context budget/);
  await assert.rejects(streamVscodeChat({ ...model, sendRequest: async () => { throw new Error("secret-token"); } }, request, () => {}, host), error => !error.message.includes("secret-token") && /quota/.test(error.message));
  await assert.rejects(streamVscodeChat({ ...model, sendRequest: async () => ({ text: (async function* () { yield "too long"; })() }) }, { ...request, tools: [], maxOutputTokens: 2 }, () => {}, host), /budget/);
  const controller = new AbortController(); let entered;
  const waiting = new Promise(resolve => { entered = resolve; });
  const run = streamVscodeChat({ ...model, sendRequest: async () => ({ text: { [Symbol.asyncIterator]: () => ({ next: () => { entered(); return new Promise(() => {}); } }) } }) }, { ...request, tools: [], signal: controller.signal }, () => {}, host);
  await waiting; controller.abort(); await assert.rejects(run, /cancelled/);
  const already = new AbortController(); already.abort();
  await assert.rejects(discoverVscodeModels(host, already.signal), /cancelled/);
  console.log("VS Code model adapter tests passed: discovery/access errors, native tool results, unavailable capabilities, budget and hung-stream cancellation.");
}

function toolEvents(name = "read_file", arguments_ = '{"path":"sample.txt"}') {
  return events([
    `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_", type: "function", function: { name: name.slice(0, 3), arguments: arguments_.slice(0, 8) } }] }, finish_reason: null }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "1", function: { name: name.slice(3), arguments: arguments_.slice(8) } }] }, finish_reason: "tool_calls" }] })}\n\n`,
    'data: {"choices":[],"usage":{"prompt_tokens":64,"completion_tokens":10,"total_tokens":74}}\n\ndata: [DONE]\n\n',
  ]);
}

async function testToolLoop() {
  const { ChatToolLoopGuard, chatToolRoundLimit } = require("../dist/chat/api-chat-client");
  assert.strictEqual(chatToolRoundLimit(), 30);
  const signal = new AbortController().signal;
  let reviewTime = 0;
  const timedNotices = [];
  const timedGuard = new ChatToolLoopGuard({ maxToolRounds: 1, loopReviewAfterMs: 1800000, loopReviewClock: () => reviewTime,
    onToolLoopNotice: async notice => { timedNotices.push(notice); return "continue"; } });
  for (let index = 0; index < 3; index++) timedGuard.record(undefined, "read_file", "{}", "same");
  reviewTime = 1799999; await timedGuard.beforeRound(100, signal);
  assert.strictEqual(timedNotices.length, 0, "Loop evidence alone and round count must not trigger time-based review");
  reviewTime = 1800000; await timedGuard.beforeRound(101, signal);
  assert.strictEqual(timedNotices.length, 1); assert.strictEqual(timedNotices[0].reason, "stalled");
  for (let index = 0; index < 3; index++) timedGuard.record(undefined, "read_file", "{}", "same");
  await timedGuard.beforeRound(102, signal);
  assert.strictEqual(timedNotices.length, 1, "Continuation starts a fresh active-time window");
  timedGuard.record(undefined, "read_file", "{}", "changed");
  reviewTime = 3600000; await timedGuard.beforeRound(103, signal);
  assert.strictEqual(timedNotices.length, 1, "Fresh results invalidate that tool's earlier loop evidence");
  for (let index = 0; index < 3; index++) timedGuard.record(undefined, "read_file", "{}", "same again");
  await timedGuard.beforeRound(104, signal); assert.strictEqual(timedNotices.length, 2);
  const timedCancellation = new ChatToolLoopGuard({ loopReviewAfterMs: 0, onToolLoopNotice: async () => "cancel" });
  for (let index = 0; index < 3; index++) timedCancellation.record(undefined, "read_file", "{}", "same");
  await assert.rejects(timedCancellation.beforeRound(0, signal), /cancelled by the user/);
  assert.throws(() => new ChatToolLoopGuard({ loopReviewAfterMs: NaN }), /non-negative/);
  const guardNotices = [];
  const guard = new ChatToolLoopGuard({ onToolLoopNotice: async notice => { guardNotices.push(notice); return "continue"; } });
  for (let index = 0; index < 30; index++) {
    guard.record(undefined, "read_file", JSON.stringify({ path: `file-${index}` }), "unchanged contents");
    await guard.beforeRound(index, signal);
  }
  assert.strictEqual(guardNotices.length, 0, "Different arguments represent progress, not a loop");
  await guard.beforeRound(30, signal);
  assert.deepStrictEqual(guardNotices, [{ reason: "round-limit", rounds: 30, limit: 30 }]);
  await guard.beforeRound(59, signal);
  assert.strictEqual(guardNotices.length, 1);
  await guard.beforeRound(60, signal);
  assert.strictEqual(guardNotices.length, 2, "Continuation grants a bounded new block, not unlimited execution");
  const progressNotices = [];
  const progressGuard = new ChatToolLoopGuard({ onToolLoopNotice: async notice => { progressNotices.push(notice); return "continue"; } });
  for (let index = 0; index < 6; index++) { progressGuard.record(undefined, "read_file", "{}", JSON.stringify({ progress: index })); await progressGuard.beforeRound(index, signal); }
  assert.strictEqual(progressNotices.length, 0, "Changing results must reset repetition detection");
  progressGuard.record(undefined, "read_file", '{"a":1,"b":2}', '{"content":"same","status":"ready"}');
  progressGuard.record(undefined, "read_file", '{"b":2,"a":1}', '{"status":"ready","content":"same"}');
  await progressGuard.beforeRound(7, signal);
  assert.strictEqual(progressNotices.length, 0);
  progressGuard.record(undefined, "read_file", '{"a":1,"b":2}', '{"content":"same","status":"ready"}');
  await progressGuard.beforeRound(8, signal);
  assert.strictEqual(progressNotices[0].reason, "stalled");
  assert.strictEqual(progressNotices[0].repeats, 3, "Canonical argument/result equality detects three unchanged attempts");
  const pollNotices = [];
  const pollGuard = new ChatToolLoopGuard({ maxToolRounds: 4, loopExemptTools: ["poll_status"], onToolLoopNotice: async notice => { pollNotices.push(notice); return "summarize"; } });
  for (let index = 0; index < 4; index++) { pollGuard.record(undefined, "poll_status", "{}", "waiting"); await pollGuard.beforeRound(index, signal); }
  assert.strictEqual(pollNotices.length, 0);
  await pollGuard.beforeRound(4, signal);
  assert.strictEqual(pollNotices[0].reason, "round-limit", "Polling exemptions must not bypass the round limit");
  assert.strictEqual(pollGuard.summarizing, true);
  const cancelledGuard = new ChatToolLoopGuard({ maxToolRounds: 1, onToolLoopNotice: async () => "cancel" });
  await assert.rejects(cancelledGuard.beforeRound(1, signal), /cancelled by the user/);
  let enteredDecision;
  const decisionEntered = new Promise(resolve => { enteredDecision = resolve; });
  const waitingController = new AbortController();
  const waitingGuard = new ChatToolLoopGuard({ maxToolRounds: 1, onToolLoopNotice: () => { enteredDecision(); return new Promise(() => {}); } });
  const pendingDecision = waitingGuard.beforeRound(1, waitingController.signal);
  await decisionEntered; waitingController.abort(); await assert.rejects(pendingDecision, /cancelled/);
  const calls = []; const stages = []; let round = 0; let output = "";
  const tools = [{ name: "read_file", description: "Read", parameters: { type: "object" }, execute: async args => { calls.push(args); return '{"content":"sample"}'; } }];
  await streamApiChat({ ...base, tools, maxOutputTokens: 100, onTool: event => stages.push(event), fetch: async (_, options) => {
    const payload = JSON.parse(options.body);
    if (round++ === 0) { assert.strictEqual(payload.tools[0].function.name, "read_file"); return toolEvents(); }
    assert.strictEqual(payload.messages[1].tool_calls[0].id, "call_1");
    assert.strictEqual(payload.messages[2].role, "tool");
    assert.strictEqual(payload.messages[2].content, '{"content":"sample"}');
    assert.strictEqual(payload.max_completion_tokens, 90);
    return events([delta("verified"), done]);
  } }, text => { output += text; });
  assert.deepStrictEqual(calls, [{ path: "sample.txt" }]); assert.strictEqual(output, "verified");
  assert.deepStrictEqual(stages.map(event => event.status), ["running", "complete"]);
  let thirtyFetches = 0; let thirtyExecutions = 0; const thirtyNotices = [];
  await streamApiChat({ ...base, maxOutputTokens: 1024, tools: [{ ...tools[0], execute: async () => { thirtyExecutions++; return "completed"; } }], onToolLoopNotice: async notice => {
    thirtyNotices.push(notice); assert.strictEqual(thirtyExecutions, 30, "The 31st tool must not execute before confirmation"); return "continue";
  }, fetch: async () => ++thirtyFetches <= 31 ? toolEvents("read_file", JSON.stringify({ path: `sample-${thirtyFetches}` })) : events([delta("done"), done]) }, () => {});
  assert.strictEqual(thirtyExecutions, 31);
  assert.deepStrictEqual(thirtyNotices, [{ reason: "round-limit", rounds: 30, limit: 30 }]);
  let batchFetches = 0; let batchExecutions = 0; const batchNotices = [];
  await streamApiChat({ ...base, maxOutputTokens: 4096, tools: [{ ...tools[0], execute: async () => { batchExecutions++; return "same result"; } }], onToolLoopNotice: async notice => {
    batchNotices.push(notice); assert.strictEqual(batchExecutions, 3); return "summarize";
  }, fetch: async (_url, options) => {
    if (++batchFetches === 1) return events([`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: Array.from({ length: 5 }, (_, index) => ({ index, id: `batch-${index}`, type: "function", function: { name: "read_file", arguments: "{}" } })) }, finish_reason: "tool_calls" }] })}\n\n`, "data: [DONE]\n\n"]);
    const payload = JSON.parse(options.body); assert.strictEqual(payload.tools, undefined);
    assert.strictEqual(payload.messages.filter(message => message.role === "tool" && message.content.includes("Not executed")).length, 2);
    return events([delta("Three results retained"), done]);
  } }, () => {});
  assert.strictEqual(batchExecutions, 3, "The fourth HTTP call in the same batch must await approval");
  assert.strictEqual(batchNotices.length, 1);
  assert.strictEqual(batchNotices[0].reason, "stalled");
  round = 0;
  await streamApiChat({ ...base, tools, fetch: async (_, options) => {
    if (round++ === 0) return toolEvents("disabled_tool");
    assert.match(JSON.parse(options.body).messages[2].content, /not enabled/);
    return events([delta("blocked"), done]);
  } }, () => {});
  assert.strictEqual(calls.length, 1);
  await assert.rejects(streamApiChat({ ...base, fetch: async () => toolEvents() }, () => {}), /not enabled/);
  const beforeRoundLimit = calls.length;
  await assert.rejects(streamApiChat({ ...base, tools, maxToolRounds: 2, fetch: async () => toolEvents(), maxOutputTokens: 100 }, () => {}), /final summary/);
  assert.strictEqual(calls.length - beforeRoundLimit, 2, "A noncompliant final summary must never execute an extra tool");
  let summaryRounds = 0;
  let summaryAnswer = "";
  const beforeSummary = calls.length;
  const repeatedNotices = [];
  await streamApiChat({ ...base, tools, maxToolRounds: 9, maxOutputTokens: 1024, onToolLoopNotice: async notice => { repeatedNotices.push(notice); return notice.reason === "stalled" ? "continue" : "summarize"; }, fetch: async (_, options) => {
    const payload = JSON.parse(options.body);
    summaryRounds++;
    if (payload.tools) return toolEvents();
    assert.strictEqual(summaryRounds, 10);
    assert.match(payload.messages.at(-1).content, /tool-call round budget/);
    return events([delta("Notes found in completed retrieval results"), done]);
  } }, text => { summaryAnswer += text; });
  assert.strictEqual(calls.length - beforeSummary, 9);
  assert.strictEqual(summaryAnswer, "Notes found in completed retrieval results");
  assert.deepStrictEqual(repeatedNotices.map(notice => notice.reason), ["stalled", "stalled", "round-limit"]);
  for (const maxToolRounds of [0, -1, 1001, 1.5]) await assert.rejects(streamApiChat({ ...base, maxToolRounds }, () => {}), /tool round limit/);
  const beforeBudgetLimit = calls.length;
  await assert.rejects(streamApiChat({ ...base, tools, fetch: async () => toolEvents(), maxOutputTokens: 10 }, () => {}), /budget exhausted/);
  assert.strictEqual(calls.length - beforeBudgetLimit, 1, "Characterize exhausted HTTP budget: the tool executes but there is no remaining model round.");
  let partialWritingOutput = "";
  await assert.rejects(streamApiChat({ ...base, maxOutputTokens: 1024, fetch: async (_, options) => {
    assert.strictEqual(JSON.parse(options.body).max_completion_tokens, 1024);
    return events([delta("partial writing"), 'data: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\ndata: [DONE]\n\n']);
  } }, text => { partialWritingOutput += text; }), /stopped with length/);
  assert.strictEqual(partialWritingOutput, "partial writing");
  let checks = 0;
  await assert.rejects(streamApiChat({ ...base, tools, beforeRound: () => { if (++checks > 1) throw new Error("context exhausted"); }, fetch: async () => toolEvents() }, () => {}), /context exhausted/);
  let executing;
  const entered = new Promise(resolve => { executing = resolve; });
  const controller = new AbortController();
  const pending = streamApiChat({ ...base, signal: controller.signal, tools: [{ ...tools[0], execute: () => { executing(); return new Promise(() => {}); } }], fetch: async () => toolEvents() }, () => {});
  await entered; controller.abort(); await assert.rejects(pending, /cancelled/);
  console.log("API chat tool loop tests passed: fragmented calls, disabled tools, budgets, round limits and cancellation.");
}

async function testNativeTools() {
  const { createBuiltinTools, relativeToolPath } = require("../dist/chat/api-chat-tools");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pkm builtin tools "));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-outside-"));
  fs.mkdirSync(path.join(directory, "nested"));
  fs.writeFileSync(path.join(directory, "nested", "sample.txt"), "first\nneedle\nlast");
  fs.writeFileSync(path.join(outside, "secret.txt"), "outside");
  const documents = new Map(); let approval = "Apply edit"; let applied = 0; let pendingApproval;
  const uri = fsPath => ({ fsPath, scheme: "file" });
  const host = {
    Uri: { file: uri, joinPath: (root, ...parts) => uri(path.join(root.fsPath, ...parts)) },
    CancellationTokenSource: class { token = {}; cancel() {} dispose() {} },
    RelativePattern: class { constructor(root, glob) { this.root = root; this.glob = glob; } },
    Range: class { constructor(start, end) { this.start = start; this.end = end; } },
    WorkspaceEdit: class { replace(target, range, replacement) { this.change = { target, range, replacement }; } },
    window: { showWarningMessage: async () => {
      if (approval === "stale") { documents.get(path.join(directory, "nested", "sample.txt")).version++; return "Apply edit"; }
      if (approval === "save-stale") { documents.get(path.join(directory, "nested", "sample.txt")).version++; return "Save file"; }
      if (approval === "pending") { pendingApproval(); return new Promise(() => {}); }
      return approval;
    } },
    workspace: {
      isTrusted: true, workspaceFolders: [{ uri: uri(directory) }], fs: { stat: async target => fs.promises.stat(target.fsPath) },
      findFiles: async () => [uri(path.join(directory, "nested", "sample.txt"))],
      openTextDocument: async target => {
        if (!documents.has(target.fsPath)) { const document = { uri: target, text: fs.readFileSync(target.fsPath, "utf8"), version: 1, getText() { return this.text; }, positionAt: value => value, async save() { fs.writeFileSync(this.uri.fsPath, this.text); return true; } }; documents.set(target.fsPath, document); }
        return documents.get(target.fsPath);
      },
      applyEdit: async edit => { applied++; const { target, range, replacement } = edit.change; const document = documents.get(target.fsPath); document.text = document.text.slice(0, range.start) + replacement + document.text.slice(range.end); document.version++; return true; },
    },
  };
  try {
    assert.deepStrictEqual(createBuiltinTools([], host), []);
    const questionStates = []; let selectQuestion = items => items[0]; let answerQuestion = () => "custom answer";
    const questionHost = { ...host, window: { ...host.window, showQuickPick: async (items, options) => selectQuestion(items, options), showInputBox: async options => answerQuestion(options) } };
    const ask = createBuiltinTools(["ask_user"], questionHost, (name, waiting) => questionStates.push({ name, waiting }))[0];
    const question = { question: "Choose validation", options: ["Unit test", "Browser check"] };
    const askResult = await ask.execute(question, new AbortController().signal);
    assert.deepStrictEqual(JSON.parse(askResult), { selected: ["Unit test"], freeText: null, cancelled: false });
    selectQuestion = items => items.slice(0, 2);
    assert.deepStrictEqual(JSON.parse(await ask.execute({ ...question, multiSelect: true }, new AbortController().signal)).selected, question.options);
    selectQuestion = items => items[2];
    assert.strictEqual(JSON.parse(await ask.execute(question, new AbortController().signal)).freeText, "custom answer");
    answerQuestion = () => undefined;
    assert.strictEqual(JSON.parse(await ask.execute(question, new AbortController().signal)).cancelled, true);
    selectQuestion = () => undefined;
    assert.strictEqual(JSON.parse(await ask.execute(question, new AbortController().signal)).cancelled, true);
    await assert.rejects(ask.execute({ ...question, options: ["same", "same"] }, new AbortController().signal), /distinct/);
    let questionOpened; const questionReady = new Promise(resolve => { questionOpened = resolve; });
    selectQuestion = () => { questionOpened(); return new Promise(() => {}); };
    const questionController = new AbortController(); const pendingQuestion = ask.execute(question, questionController.signal);
    await questionReady; questionController.abort(); await assert.rejects(pendingQuestion, /cancelled/);
    assert.deepStrictEqual(questionStates.slice(-2), [{ name: "ask_user", waiting: true }, { name: "ask_user", waiting: false }]);
    assert.strictEqual(relativeToolPath("nested\\sample.txt"), "nested/sample.txt");
    for (const value of ["../outside", "/etc/passwd", "C:\\secret", ".env", "nested/.secret", "key.pem", "node_modules/a"]) assert.throws(() => relativeToolPath(value));
    const approvals = [];
    const changes = [];
    const tools = createBuiltinTools(["read_file", "find_files", "search_text", "replace_text", "save_file", "run_process"], host, (name, waiting) => approvals.push({ name, waiting }), change => changes.push(change));
    const run = (name, args, signal = new AbortController().signal) => tools.find(tool => tool.name === name).execute(args, signal);
    assert.strictEqual(JSON.parse(await run("read_file", { path: "nested\\sample.txt", startLine: 2, endLine: 2 })).content, "needle");
    assert.deepStrictEqual(JSON.parse(await run("find_files", {})).files, ["nested/sample.txt"]);
    assert.strictEqual(JSON.parse(await run("search_text", { query: "needle" })).matches[0].line, 2);
    await assert.rejects(run("read_file", { path: path.join(outside, "secret.txt") }), /declined/);
    assert.strictEqual(documents.has(path.join(outside, "secret.txt")), false, "Unapproved outside files must not be opened");
    await assert.rejects(run("read_file", { path: "nested/sample.txt", endLine: 201 }), /200/);
    if (process.platform !== "win32") {
      fs.symlinkSync(path.join(outside, "secret.txt"), path.join(directory, "linked.txt"));
      await assert.rejects(run("read_file", { path: "linked.txt" }), /outside/i);
    }
    const boundaryCalls = [];
    let grantOutside = false;
    const boundaryTools = createBuiltinTools(["read_file", "replace_text", "save_file"], host, undefined, undefined, async (name, prompt, detail, signal, boundary) => {
      boundaryCalls.push({ name, boundary });
      return boundary === "workspace" || grantOutside;
    });
    const boundaryRun = (name, args) => boundaryTools.find(tool => tool.name === name).execute(args, new AbortController().signal);
    await boundaryRun("read_file", { path: "nested/sample.txt" });
    assert.strictEqual(boundaryCalls.length, 0, "Local reads need no outside grant");
    await assert.rejects(boundaryRun("read_file", { path: path.join(outside, "secret.txt") }), /declined/);
    grantOutside = true;
    assert.strictEqual(JSON.parse(await boundaryRun("read_file", { path: path.join(outside, "secret.txt") })).content, "outside");
    assert.strictEqual(JSON.parse(await boundaryRun("read_file", { path: path.relative(directory, path.join(outside, "secret.txt")) })).content, "outside");
    if (process.platform !== "win32") assert.strictEqual(JSON.parse(await boundaryRun("read_file", { path: "linked.txt" })).content, "outside");
    const outsideEdit = JSON.parse(await boundaryRun("replace_text", { path: path.join(outside, "secret.txt"), oldText: "outside", newText: "authorized edit" }));
    await boundaryRun("save_file", { path: path.join(outside, "secret.txt"), expectedHash: outsideEdit.afterHash });
    assert.strictEqual(fs.readFileSync(path.join(outside, "secret.txt"), "utf8"), "authorized edit");
    assert.ok(boundaryCalls.every(call => call.boundary === "outside-workspace"));
    fs.writeFileSync(path.join(outside, ".env"), "fixture-only");
    await assert.rejects(boundaryRun("read_file", { path: path.join(outside, ".env") }), /excluded/);
    if (process.platform !== "win32") {
      fs.symlinkSync(path.join(outside, ".env"), path.join(directory, "sensitive-link.txt"));
      await assert.rejects(boundaryRun("read_file", { path: "sensitive-link.txt" }), /excluded/);
      const swapping = createBuiltinTools(["read_file"], host, undefined, undefined, async () => {
        fs.unlinkSync(path.join(directory, "linked.txt"));
        fs.symlinkSync(path.join(outside, ".env"), path.join(directory, "linked.txt"));
        return true;
      })[0];
      await assert.rejects(swapping.execute({ path: "linked.txt" }, new AbortController().signal), /changed after approval/);
    }
    applied = 0;
    const edit = { path: "nested/sample.txt", oldText: "needle", newText: "changed" };
    approval = undefined; await assert.rejects(run("replace_text", edit), /declined/); assert.strictEqual(applied, 0);
    approval = "stale"; await assert.rejects(run("replace_text", edit), /changed after/); assert.strictEqual(applied, 0);
    approval = "pending"; const entered = new Promise(resolve => { pendingApproval = resolve; }); const controller = new AbortController();
    const pending = run("replace_text", edit, controller.signal); await entered; controller.abort(); await assert.rejects(pending, /cancelled/); assert.strictEqual(applied, 0);
    assert.deepStrictEqual(approvals.slice(-2), [{ name: "replace_text", waiting: true }, { name: "replace_text", waiting: false }]);
    assert.deepStrictEqual(changes, [], "Declined, stale or cancelled edits must not be attributed");
    approval = "Apply edit"; const result = JSON.parse(await run("replace_text", edit));
    assert.strictEqual(result.saved, false); assert.strictEqual(applied, 1);
    assert.strictEqual(changes.length, 1); assert.strictEqual(result.added, 1); assert.strictEqual(result.removed, 1);
    assert.strictEqual(result.attribution, "exact"); assert.notStrictEqual(result.beforeHash, result.afterHash);
    assert.strictEqual(result.beforeHash.length, 64);
    const noChange = JSON.parse(await run("replace_text", { ...edit, oldText: "changed", newText: "changed" }));
    assert.strictEqual(noChange.added, 0); assert.strictEqual(noChange.removed, 0);
    const literal = JSON.parse(await run("replace_text", { ...edit, oldText: "changed", newText: "$&\nsecond" }));
    assert.strictEqual(literal.added, 2); assert.strictEqual(literal.removed, 1);
    assert.match(fs.readFileSync(path.join(directory, "nested", "sample.txt"), "utf8"), /needle/);
    await assert.rejects(run("save_file", { path: "nested/sample.txt", expectedHash: result.afterHash }), /content changed/);
    approval = undefined; await assert.rejects(run("save_file", { path: "nested/sample.txt", expectedHash: literal.afterHash }), /declined/);
    assert.match(fs.readFileSync(path.join(directory, "nested", "sample.txt"), "utf8"), /needle/);
    approval = "save-stale"; await assert.rejects(run("save_file", { path: "nested/sample.txt", expectedHash: literal.afterHash }), /changed after/);
    approval = "Save file"; const saved = JSON.parse(await run("save_file", { path: "nested/sample.txt", expectedHash: literal.afterHash }));
    assert.strictEqual(saved.saved, true); assert.strictEqual(saved.afterHash, literal.afterHash);
    assert.match(fs.readFileSync(path.join(directory, "nested", "sample.txt"), "utf8"), /\$&\nsecond/);
    const program = { program: process.execPath, arguments: ["-e", "console.log(JSON.stringify({cwd:process.cwd(),args:process.argv.slice(1),secret:!!process.env.PKM_TOOL_FIXTURE_SECRET}))", "argument with spaces", "literal;not-a-shell"] };
    approval = undefined; await assert.rejects(run("run_process", program), /declined/);
    const oldSecret = process.env.PKM_TOOL_FIXTURE_SECRET; process.env.PKM_TOOL_FIXTURE_SECRET = "test-only";
    try {
      approval = "Run program"; const processResult = JSON.parse(await run("run_process", program));
      assert.deepStrictEqual(approvals.slice(-2), [{ name: "run_process", waiting: true }, { name: "run_process", waiting: false }]);
      assert.strictEqual(processResult.exitCode, 0); const printed = JSON.parse(processResult.stdout);
      assert.deepStrictEqual(printed.args, ["argument with spaces", "literal;not-a-shell"]); assert.strictEqual(printed.secret, false);
      assert.strictEqual(printed.cwd, fs.realpathSync(directory));
      approval = undefined;
      await assert.rejects(run("run_process", { ...program, cwd: outside }), /declined/);
      approval = "Run program";
      const outsideProcess = JSON.parse(await run("run_process", { ...program, cwd: outside }));
      assert.strictEqual(JSON.parse(outsideProcess.stdout).cwd, fs.realpathSync(outside));
      await assert.rejects(run("run_process", { ...program, arguments: ["-e", "setInterval(()=>{},1000)"], timeoutSeconds: 1 }), /timed out/);
      const controller = new AbortController(); const marker = path.join(directory, "started");
      const started = new Promise(resolve => { fs.watchFile(marker, { interval: 50, persistent: false }, current => { if (current.size) resolve(); }); });
      const pending = run("run_process", { ...program, arguments: ["-e", "require('fs').writeFileSync('started',String(process.pid));setInterval(()=>{},1000)"] }, controller.signal);
      try { await started; controller.abort(); await assert.rejects(pending, /cancelled/); } finally { fs.unwatchFile(marker); controller.abort(); }
    } finally { if (oldSecret === undefined) delete process.env.PKM_TOOL_FIXTURE_SECRET; else process.env.PKM_TOOL_FIXTURE_SECRET = oldSecret; }
    host.workspace.isTrusted = false; await assert.rejects(run("read_file", { path: "nested/sample.txt" }), /trusted/);
    host.workspace.isTrusted = true; host.workspace.workspaceFolders[0].uri.scheme = "virtual";
    await assert.rejects(run("read_file", { path: "nested/sample.txt" }), /filesystem-backed/);
    console.log("API chat builtin tests passed: workspace boundaries, Windows path syntax, symlinks, approved edits/processes, argv/environment isolation, timeout and cancellation.");
  } finally { fs.rmSync(directory, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true }); }
}

async function testMcp() {
  const { connectApiChatMcp, mcpUrl } = require("../dist/chat/api-chat-mcp");
  const http = require("http"); let executed = 0; let deny = false; let hanging; let discoveryMode = "normal";
  const token = "fixture-bearer-not-a-real-secret";
  const server = http.createServer((request, response) => {
    assert.strictEqual(request.headers.authorization, `Bearer ${token}`);
    if (request.method !== "POST") { response.writeHead(405); response.end(); return; }
    let body = ""; request.on("data", chunk => { body += chunk; });
    request.on("end", () => {
      const message = JSON.parse(body); let result;
      if (message.id === undefined) { response.writeHead(202); response.end(); return; }
      if (message.method === "initialize") result = { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } };
      if (message.method === "tools/list") {
        const tool = { name: message.params?.cursor ? "inspect" : "echo", description: "Fixture tool", inputSchema: { type: "object", properties: { value: { type: "string" } } }, annotations: { readOnlyHint: true } };
        result = discoveryMode === "overflow" ? { tools: Array.from({ length: 513 }, (_, index) => ({ ...tool, name: `tool_${index}` })) }
          : { tools: [tool], ...(!message.params?.cursor || discoveryMode === "repeat" ? { nextCursor: "second-page" } : {}) };
      }
      if (message.method === "tools/call") {
        executed++;
        if (message.params.arguments.value === "hang") { hanging(); return; }
        result = { content: [{ type: "text", text: token + ":" + message.params.arguments.value }] };
      }
      response.writeHead(200, { "Content-Type": "application/json" }); response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
    });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  let connection;
  try {
    assert.throws(() => mcpUrl("http://example.test/mcp"), /HTTPS/);
    assert.throws(() => mcpUrl("https://example.test/mcp?token=secret"), /credentials/);
    const controller = new AbortController();
    connection = await connectApiChatMcp({ id: "fixture", label: "Local fixture", url: `http://127.0.0.1:${server.address().port}/mcp`, enabled: true, tools: ["echo"] }, 0, token, controller.signal, async () => { if (deny) throw new Error("declined"); });
    assert.strictEqual(connection.tools[0].remoteName, "echo");
    assert.deepStrictEqual(connection.tools.map(tool => tool.remoteName), ["echo", "inspect"]);
    assert.strictEqual(connection.truncated, false);
    discoveryMode = "repeat";
    await assert.rejects(connectApiChatMcp({ id: "repeated", label: "Repeated cursor", url: `http://127.0.0.1:${server.address().port}/mcp`, enabled: true, tools: [] }, 1, token, controller.signal, async () => {}), /connection.*failed/i);
    discoveryMode = "overflow";
    await assert.rejects(connectApiChatMcp({ id: "overflow", label: "Overflow", url: `http://127.0.0.1:${server.address().port}/mcp`, enabled: true, tools: [] }, 1, token, controller.signal, async () => {}), /connection.*failed/i);
    discoveryMode = "normal";
    const result = await connection.tools[0].execute({ value: "hello" }, controller.signal);
    assert.match(result, /hello/); assert(!result.includes(token)); assert.strictEqual(executed, 1);
    await assert.rejects(connection.tools[0].execute({ value: "hello" }, controller.signal), /Duplicate/); assert.strictEqual(executed, 1);
    deny = true; await assert.rejects(connection.tools[0].execute({ value: "denied" }, controller.signal), /declined/); assert.strictEqual(executed, 1); deny = false;
    const entered = new Promise(resolve => { hanging = resolve; });
    const pending = connection.tools[0].execute({ value: "hang" }, controller.signal); await entered; controller.abort();
    await assert.rejects(pending, /may already have occurred/);
    console.log("API chat MCP tests passed: HTTP discovery/execution, native approval boundary, duplicate protection, credential redaction and cancellation.");
  } finally { await connection?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}

async function testVscodeTools() {
  const { createVscodeTools, pkmToolGroup, groupVscodeTools, pkmToolSets, ensurePkmMcpTools } = require("../dist/chat/api-chat-mcp");
  const groupedNames = [
    ["mcp_pkm_list_skills", "skills"], ["mcp_pkm_skill_context", "skills"],
    ["mcp_pkm_list_notes", "notes"], ["mcp_pkm_paper_graph", "papers"],
    ["mcp_pkm_chat_post", "chatroom"], ["mcp_pkm_check_chat_version", "chatroom"],
    ["mcp_pkm_recipe_create_from_skill", "recipe"], ["mcp_pkm_agent_session_stop", "sessions"],
    ["mcp_pkm_search_subscribed_content", "subscriptions"], ["mcp_pkm_retrieval_status", "retrieval"],
    ["mcp_pkm_check_version", "runtime"], ["other_list_skills", "other"],
  ];
  for (const [name, group] of groupedNames) assert.strictEqual(pkmToolGroup(name), group, name);
  const groupedCatalog = groupedNames.map(([name]) => ({ name }));
  const snapshot = JSON.stringify(groupedCatalog);
  const groups = groupVscodeTools(groupedCatalog);
  assert.strictEqual(groups.flatMap(group => group.tools).length, groupedCatalog.length);
  assert.strictEqual(JSON.stringify(groupedCatalog), snapshot, "Grouping cannot mutate the registered catalog");
  const sets = pkmToolSets([...groupedCatalog, groupedCatalog[0]]);
  assert.strictEqual(Object.keys(sets).length, 9);
  assert.deepStrictEqual(sets["pkm-skills"].tools, ["pkm/list_skills", "pkm/skill_context"]);
  assert.deepStrictEqual(sets["pkm-recipe"].tools, ["pkm/recipe_create_from_skill"]);
  assert(!Object.values(sets).some(set => set.tools.includes("other_list_skills")));
  assert.deepStrictEqual(pkmToolSets([{ name: "unrelated_tool" }]), {});
  class TextPart { constructor(value) { this.value = value; } }
  let approved = true; const invoked = [];
  const host = { workspace: { isTrusted: true }, LanguageModelTextPart: TextPart,
    CancellationTokenSource: class { constructor() { this.token = {}; } cancel() { this.token.cancelled = true; } dispose() {} },
    lm: { tools: [{ name: "mcp_pkm_search_notes", description: "Search PKM notes", inputSchema: { type: "object", properties: { query: { type: "string" } } } }, { name: "disabled_tool", description: "Not selected" }], invokeTool: async (name, options, token) => { invoked.push({ name, options, token }); return { content: [new TextPart("PKM result")] }; } } };
  const startupCalls = [];
  const discoveryHost = { ...host, lm: { ...host.lm, tools: [] }, commands: { executeCommand: async command => {
    startupCalls.push(command); discoveryHost.lm.tools = [...host.lm.tools];
  } } };
  await ensurePkmMcpTools(discoveryHost);
  assert.deepStrictEqual(startupCalls, ["personalKnowledge.startPkmMcp"], "cold Chat discovery must start only the managed PKM server");
  assert.strictEqual(invoked.length, 0, "discovery must not execute any tool");
  await ensurePkmMcpTools(discoveryHost);
  assert.strictEqual(startupCalls.length, 1, "registered PKM tools must not trigger redundant startup");
  const delayedDiscoveryHost = { ...host, lm: { ...host.lm, tools: [] }, commands: { executeCommand: async command => {
    startupCalls.push(command);
    setTimeout(() => { delayedDiscoveryHost.lm.tools = [...host.lm.tools]; }, 20);
  } } };
  await ensurePkmMcpTools(delayedDiscoveryHost);
  assert.strictEqual(startupCalls.length, 2, "a late catalog must use one startup, not restart the server");
  assert.strictEqual(invoked.length, 0, "waiting for publication must not invoke a tool");
  discoveryHost.lm.tools = [];
  discoveryHost.workspace = { isTrusted: false };
  await ensurePkmMcpTools(discoveryHost);
  assert.strictEqual(startupCalls.length, 2, "untrusted workspaces must not launch MCP");
  discoveryHost.workspace = { isTrusted: true };
  discoveryHost.commands.executeCommand = async () => { startupCalls.push("failed-start"); throw new Error("fixture startup failed"); };
  await assert.rejects(ensurePkmMcpTools(discoveryHost), /fixture startup failed/);
  assert.strictEqual(startupCalls.length, 3, "a failed startup must not retry automatically");
  discoveryHost.commands.executeCommand = async () => undefined;
  await assert.rejects(ensurePkmMcpTools(discoveryHost), /unavailable after startup/);
  await ensurePkmMcpTools({ workspace: { isTrusted: true } });
  const ts = require("typescript");
  const extensionSource = fs.readFileSync(path.join(__dirname, "../src/extension.ts"), "utf8");
  const extensionAst = ts.createSourceFile("extension.ts", extensionSource, ts.ScriptTarget.Latest, true);
  const registration = extensionAst.statements.find(statement => ts.isFunctionDeclaration(statement) && statement.name?.text === "registerNativeMcpProvider");
  assert(registration);
  const nativeStarts = [], nativeCommands = new Map(), startupOrder = [];
  let healthy = true;
  const nativeHost = { workspace: { isTrusted: true }, Uri: { file: value => value },
    lm: { registerMcpServerDefinitionProvider: () => ({ dispose() {} }) },
    McpStdioServerDefinition: class {}, EventEmitter: class { event() {} dispose() {} },
    commands: { registerCommand: (name, handler) => { nativeCommands.set(name, handler); return { dispose() {} }; },
      executeCommand: async (...args) => { startupOrder.push("start"); nativeStarts.push(args); } } };
  const nativeContext = vm.createContext({ vscode: nativeHost, _nativeMcpProvider: false, _mcpDefinitionsChanged: undefined,
    getStorePath: () => "/fixture-knowledge", mcpRuntimeStatus: () => ({ healthy }), mcpStatus: () => ({ installed: true }),
    refreshMcpDefinitions: () => startupOrder.push("definitions"), setImmediate,
    mcpServerDefinitionData: () => ({ label: "pkm", command: "python", args: ["server.py"], cwd: "/fixture-mcp", version: "fixture" }),
    nativeMcpCwdUri: (_extension, cwd, file) => file(cwd) });
  vm.runInContext(ts.transpileModule(registration.getText(extensionAst), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, nativeContext);
  nativeContext.registerNativeMcpProvider({ subscriptions: [], extensionUri: {} });
  assert.strictEqual(nativeStarts.length, 0, "core registration must not wait for or start MCP");
  await nativeCommands.get("personalKnowledge.startPkmMcp")();
  assert.deepStrictEqual(startupOrder, ["definitions", "start"], "the initialized root's definition must be published before native startup");
  assert.deepStrictEqual(JSON.parse(JSON.stringify(nativeStarts)), [["workbench.mcp.startServer", "uone.personal-knowledge/pkm", { waitForLiveTools: true }]], "native startup must preserve VS Code's default trust handling and wait for discovery");
  nativeHost.workspace.isTrusted = false;
  await assert.rejects(nativeCommands.get("personalKnowledge.startPkmMcp")(), /trusted/);
  nativeHost.workspace.isTrusted = true; healthy = false;
  await assert.rejects(nativeCommands.get("personalKnowledge.startPkmMcp")(), /repair/);
  assert.strictEqual(nativeStarts.length, 1, "trust and runtime failures must not launch a server");
  const tools = createVscodeTools(["mcp_pkm_search_notes"], host, async () => { if (!approved) throw new Error("declined"); });
  const controller = new AbortController();
  const invoke = tools.find(tool => tool.name === "invoke_vscode_tool");
  const find = tools.find(tool => tool.name === "find_vscode_tools");
  await assert.rejects(invoke.execute({ name: "mcp_pkm_search_notes", input: { query: "test" } }, controller.signal), /Find an enabled/);
  const catalog = JSON.parse(await find.execute({ query: "pkm notes" }, controller.signal));
  assert.strictEqual(catalog.tools[0].name, "mcp_pkm_search_notes"); assert(catalog.tools[0].inputSchema.properties.query);
  await assert.rejects(invoke.execute({ name: "disabled_tool", input: {} }, controller.signal), /Find an enabled/);
  approved = false; await assert.rejects(invoke.execute({ name: "mcp_pkm_search_notes", input: { query: "test" } }, controller.signal), /declined/); assert.strictEqual(invoked.length, 0);
  approved = true; assert.strictEqual(JSON.parse(await invoke.execute({ name: "mcp_pkm_search_notes", input: { query: "test" } }, controller.signal)).content, "PKM result");
  assert.strictEqual(invoked[0].options.toolInvocationToken, undefined); assert.strictEqual(invoked[0].name, "mcp_pkm_search_notes");
  await assert.rejects(invoke.execute({ name: "mcp_pkm_search_notes", input: { query: "test" } }, controller.signal), /Duplicate/);
  assert.throws(() => createVscodeTools(["missing"], host, async () => {}), /unavailable/);
  host.workspace.isTrusted = false; await assert.rejects(invoke.execute({ name: "mcp_pkm_search_notes", input: {} }, controller.signal), /trusted/);
  host.workspace.isTrusted = true; controller.abort(); await assert.rejects(find.execute({ query: "pkm" }, controller.signal), /cancelled/);
  let entered; let invocationToken;
  const ready = new Promise(resolve => { entered = resolve; });
  host.lm.invokeTool = async (_name, _options, token) => { invocationToken = token; entered(); return new Promise(() => {}); };
  const cancelling = new AbortController();
  const hanging = invoke.execute({ name: "mcp_pkm_search_notes", input: { query: "hang" } }, cancelling.signal);
  await ready; cancelling.abort(); await assert.rejects(hanging, /may already have occurred/); assert.strictEqual(invocationToken.cancelled, true);
  host.lm.invokeTool = async () => ({ content: [new TextPart('"'.repeat(20_000))] });
  const escaped = await invoke.execute({ name: "mcp_pkm_search_notes", input: { query: "escaped" } }, new AbortController().signal);
  assert(escaped.length <= 16_000); assert.strictEqual(JSON.parse(escaped).truncated, true);
  console.log("VS Code/MCP tool bridge tests passed: catalog/schema discovery, real registered names, selection, approvals, no synthetic chat token, duplicate and cancellation guards.");
}

function startPreview() {
  const http = require("http");
  const port = Number(process.env.PKM_CHAT_PREVIEW_PORT || 0);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Invalid Chat preview port.");
  const webview = path.join(__dirname, "..", "dist", "webview");
  const deletion = createDeletionPreview();
  const localeRoot = path.join(__dirname, "..", "resources", "locales");
  const localeManifest = JSON.parse(fs.readFileSync(path.join(localeRoot, "manifest.json"), "utf8"));
  const locales = Object.fromEntries(localeManifest.locales.map(locale => [locale.id, { direction: locale.direction || "ltr", ...JSON.parse(fs.readFileSync(path.join(localeRoot, locale.id + ".json"), "utf8")) }]));
  const fixture = {
    type: "state", busy: false,
    chat: { id: "preview", title: "Review parser boundaries", includeHistory: true, permissionMode: "protective", permissionGrants: [],
      context: [{ id: "context", label: "src/parser.ts:24-58", characters: 1460 }],
      messages: [
        { id: "question", role: "user", status: "complete", content: "Review the selected parser. Which edge cases should we test?", contextLabels: ["src/parser.ts:24-58"] },
        { id: "answer", role: "assistant", model: "fixture-model", status: "complete", elapsedMs: 2300, usage: { inputTokens: 100, outputTokens: 20 }, estimatedCost: 0.00014, currency: "USD", toolCalls: [{ id: "fixture-read", name: "read_file", status: "complete", arguments: '{"path":"src/parser.ts"}', result: '<img src="invalid" onerror="globalThis.__unsafe=true">' }, { id: "fixture-edit", name: "replace_text", status: "failed", arguments: '{"path":"src/parser.ts"}', result: "Edit declined by the user." }], content: "### Parser boundaries\n\nTest an empty input, incomplete records, and delimiters split across chunks.\n\n```ts\nconst result = parse(buffer);\nexpect(result.consumed).toBeLessThanOrEqual(buffer.length);\n```\n\n| Case | Expected |\n| --- | --- |\n| Empty buffer | No records |\n| Partial record | Preserve suffix |\n\nI have not run the tests." },
      ] },
    settings: { model: "fixture-model", models: [], provider: "openai-compatible", endpoint: "https://example.test/v1", contextWindow: 16384, maxOutputTokens: 2048, inputBaseTokens: 1000, profiles: [{ id: "fixture-model", label: "Fixture model", status: "active", contextWindow: 16384, maxOutputTokens: 4096 }, { id: "fixture-retired", label: "Retired fixture", status: "deprecated", contextWindow: 8192, maxOutputTokens: 1024 }], selectedProfile: { id: "fixture-model", status: "active", contextWindow: 16384, maxOutputTokens: 4096, inputPricePerMillion: 1, outputPricePerMillion: 2, currency: "USD" } },
    chats: [{ id: "preview", title: "Review parser boundaries", status: "awaiting-input" }, { id: "running", title: "Parser checks", status: "running" }, { id: "unread", title: "New answer", status: "new-result" }, { id: "idle", title: "New chat", status: "idle" }],
  };
  fixture.settings.maxToolRounds = 30;
  fixture.settings.profiles.push({ id: "fixture-model-b", label: "Fixture model B", status: "active", contextWindow: 16384, maxOutputTokens: 4096 });
  function previewBridge() {
    globalThis.__posts = [];
    const emit = value => globalThis.postMessage(value, location.origin);
    globalThis.acquireVsCodeApi = () => ({
      getState: () => globalThis.__saved,
      setState: value => { globalThis.__saved = value; },
      postMessage: message => {
        globalThis.__posts.push(message);
        const state = globalThis.__fixture;
        if (message.type === "hostHealth") { emit({ type: "hostHealth", id: message.id }); return; }
        if (message.type === "chooseModel") {
          setTimeout(() => {
            const profiles = state.settings.profiles.filter(profile => profile.status === "active");
            const index = profiles.findIndex(profile => profile.id === state.settings.selectedProfile.id);
            const profile = profiles[(index + 1) % profiles.length];
            state.settings.selectedProfile = { ...state.settings.selectedProfile, ...profile };
            state.settings.model = profile.id;
            emit(state);
            emit({ type: "modelPickerClosed" });
          }, 300);
          return;
        }
        if (message.type === "permissionMode" && ["allow-all", "protective", "ask", "read-only"].includes(message.value)) state.chat.permissionMode = message.value;
        else if (message.type === "resetPermissions") state.chat.permissionGrants = [];
        else if (message.type === "toolRounds" && Number.isInteger(message.maxToolRounds) && message.maxToolRounds >= 1 && message.maxToolRounds <= 1000) state.settings.maxToolRounds = message.maxToolRounds;
        else if (message.type === "budget") {
          for (const key of ["contextWindow", "maxOutputTokens"]) if (Number.isInteger(message[key]) && message[key] > 0) state.settings[key] = message[key];
        } else if (message.type === "history") state.chat.includeHistory = message.value === true;
        else if (message.type === "send") {
          emit({ type: "error", message: "This isolated preview has no model connection. No model or tool request was executed.", chatId: message.chatId, submissionId: message.submissionId });
          return;
        } else if (!["ready", "read", "libraryRefresh"].includes(message.type)) {
          emit({ type: "error", message: "This operation requires the installed extension; it is unavailable in the fixture preview." });
          return;
        }
        emit(state);
      },
    });
  }
  const bootstrap = `globalThis.__fixture=${JSON.stringify(fixture)};(${previewBridge.toString()})();`;
  const deletionBootstrap = `globalThis.acquireVsCodeApi=()=>({getState:()=>JSON.parse(sessionStorage.getItem('chatState')||'null'),setState:s=>sessionStorage.setItem('chatState',JSON.stringify(s)),postMessage:async message=>{if(message.type==='hostHealth'){window.dispatchEvent(new MessageEvent('message',{data:{type:'hostHealth',id:message.id}}));return;}const confirm=!['trashChat','deleteChat','emptyTrash'].includes(message.type)||window.confirm('Confirm '+message.type+'?');const response=await fetch('/delete-action',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({message,confirm})});const result=await response.json();if(!response.ok)throw new Error(result.error);globalThis.__deletionSnapshot=result;window.dispatchEvent(new MessageEvent('message',{data:result.state}));}});`;
  const assets = new Set(["api-chat.css", "api-chat.js", "api-chat-library.js", "chat-retrieval-flow.js", "host-health.js", "host-health.css", "codicon.css", "codicon.ttf", "marked.umd.js", "purify.min.js", "katex.js", "katex.css", "mermaid.js", ...fs.readdirSync(path.join(webview, "fonts")).filter(name => name.endsWith(".woff2")).map(name => `fonts/${name}`)]);
  const server = http.createServer((request, response) => {
    const name = new URL(request.url, "http://localhost").pathname.slice(1);
    if (name === "delete-state") { response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify(deletion.snapshot())); return; }
    if (name === "delete-action" && request.method === "POST") {
      let body = "";
      request.on("data", chunk => { body += chunk; if (body.length > 16000) request.destroy(); });
      request.on("end", async () => {
        try {
          const input = JSON.parse(body);
          const result = await deletion.action(input.message, input.confirm);
          response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify(result));
        } catch (error) { response.writeHead(400, { "Content-Type": "application/json" }); response.end(JSON.stringify({ error: error.message })); }
      }); return;
    }
    if (name === "delete-fixture.js") { response.setHeader("Content-Type", "text/javascript"); response.end(deletionBootstrap); return; }
    if (name === "fixture.js") { response.setHeader("Content-Type", "text/javascript"); response.end(bootstrap + "globalThis.__locales=" + JSON.stringify(locales) + ";"); return; }
    if (name === "" || name === "deletion") {
      const values = { nonce: "preview-nonce", cspSource: "'self'", styles: "/api-chat.css", script: "/api-chat.js", libraryScript: "/api-chat-library.js", retrievalScript: "/chat-retrieval-flow.js", hostHealthScript: "/host-health.js", hostHealthStyles: "/host-health.css", icons: "/codicon.css", marked: "/marked.umd.js", purify: "/purify.min.js", katex: "/katex.js", katexStyles: "/katex.css", mermaid: "/mermaid.js" };
      const html = fs.readFileSync(path.join(webview, "api-chat.html"), "utf8")
        .replace(/\{\{(\w+)\}\}/g, (_, key) => values[key])
        .replace('<script nonce="preview-nonce" src="/host-health.js">', `<script nonce="preview-nonce" src="/${name === "deletion" ? "delete-fixture.js" : "fixture.js"}"></script><script nonce="preview-nonce" src="/host-health.js">`);
      response.setHeader("Content-Type", "text/html"); response.end(name === "deletion" ? html.replace("default-src 'none';", "default-src 'none'; connect-src 'self';") : html); return;
    }
    if (!assets.has(name)) { response.writeHead(404); response.end(); return; }
    response.setHeader("Content-Type", name.endsWith(".css") ? "text/css" : name.endsWith(".js") ? "text/javascript" : "font/ttf");
    fs.createReadStream(path.join(webview, name)).pipe(response);
  });
  server.once("close", () => deletion.dispose());
  server.listen(port, "127.0.0.1", () => {
    const url = `http://127.0.0.1:${server.address().port}`;
    console.log(`API chat preview: ${url}`);
    if (!process.argv.includes("--browser-check")) return;
    const code = String.raw`
import sys
from playwright.sync_api import sync_playwright
with sync_playwright() as runtime:
    browser = runtime.chromium.launch(headless=True)
    page = browser.new_page(viewport={"width": 1280, "height": 900})
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.goto(sys.argv[1], wait_until="networkidle")
    page.evaluate("() => window.postMessage({type: 'showChat'}, location.origin)")
    page.locator("#permissions").click()
    page.locator("#permission-mode").select_option("allow-all")
    page.keyboard.press("Escape")
    page.wait_for_function("() => globalThis.__fixture.chat.permissionMode === 'allow-all'")
    page.locator("#permissions").click()
    assert page.locator("#permission-mode").input_value() == "allow-all"
    page.keyboard.press("Escape")
    composer = page.locator("#composer").bounding_box()
    for mode, label in [("protective", "Protective"), ("ask", "Ask before changes"), ("read-only", "Read only"), ("allow-all", "Allow All")]:
      page.locator("#permissions").click()
      page.locator("#permission-mode").select_option(mode)
      page.wait_for_function("mode => document.getElementById('permissions').dataset.permissionMode === mode", arg=mode)
      assert page.locator("#permission-label").count() == 0
      assert page.locator("#permissions .codicon").get_attribute("class") == "codicon codicon-shield"
      assert page.locator("#permissions").get_attribute("title") == "Permissions: " + label + " \u00b7 next request"
      assert page.locator("#allow-all").count() == 0
      assert page.locator("#composer").bounding_box() == composer
      page.keyboard.press("Escape")
      page.locator("#permissions").hover()
      assert page.locator("#permissions").bounding_box()["width"] <= 32
    page.locator("#options").click()
    assert page.locator("#tool-rounds").input_value() == "30"
    page.locator("#tool-rounds").fill("47")
    page.locator("#tool-rounds").press("Tab")
    page.wait_for_function("() => globalThis.__fixture.settings.maxToolRounds === 47")
    page.keyboard.press("Escape")
    page.locator("#model").click()
    assert page.locator("#model").get_attribute("aria-busy") == "true"
    page.wait_for_function("() => !document.getElementById('model').hasAttribute('aria-busy')")
    assert page.evaluate("globalThis.__fixture.settings.selectedProfile.id") == "fixture-model-b"
    page.locator("#prompt").fill("Do not call a model in preview.")
    page.locator("#send").click()
    page.wait_for_function("() => globalThis.__posts.some(message => message.type === 'send') && !document.getElementById('send').disabled")
    assert page.locator("#prompt").input_value() == "Do not call a model in preview."
    assert page.evaluate("globalThis.__fixture.chat.messages.length") == 2
    for width, height in [(1280, 900), (390, 844), (320, 568), (213, 378)]:
        page.set_viewport_size({"width": width, "height": height})
        for text in ["First line\nSecond line", "Long message " * 80 + "x" * 200]:
            page.evaluate("""text => {
              const fixture = globalThis.__fixture;
              fixture.chat.messages.find(message => message.role === "user").content = text;
              window.dispatchEvent(new MessageEvent("message", {data: fixture}));
            }""", text)
            bubble = page.evaluate("""() => {
              const messages = document.querySelector('#messages');
              const user = messages.querySelector('.message.user');
              const content = user.querySelector('.content');
              const parent = messages.getBoundingClientRect();
              const bounds = user.getBoundingClientRect();
              const style = getComputedStyle(user);
              return {right: bounds.right, left: bounds.left,
                edge: parent.left + messages.clientLeft + messages.clientWidth - parseFloat(getComputedStyle(messages).paddingRight),
                textAlign: getComputedStyle(content).textAlign, background: style.backgroundColor,
                border: parseFloat(style.borderLeftWidth), borderStyle: style.borderLeftStyle,
                contentWidth: content.clientWidth, contentScroll: content.scrollWidth,
                pageWidth: innerWidth, pageScroll: document.documentElement.scrollWidth};
            }""")
            assert abs(bubble["right"] - bubble["edge"]) <= 1, bubble
            assert bubble["textAlign"] == "left", bubble
            assert bubble["border"] >= 1 and bubble["borderStyle"] == "solid", bubble
            assert bubble["background"] not in ["transparent", "rgba(0, 0, 0, 0)"], bubble
            assert bubble["contentScroll"] <= bubble["contentWidth"] + 1, bubble
            assert bubble["pageScroll"] <= bubble["pageWidth"], bubble
            if text.startswith("First line"):
                page.locator(".message.user").first.scroll_into_view_if_needed()
                if width in [1280, 390]:
                    page.screenshot(path="/tmp/pkm-user-bubble-" + ("desktop" if width == 1280 else "mobile") + ".png")
    page.set_viewport_size({"width": 1280, "height": 900})
    page.evaluate("""() => {
      const fixture = globalThis.__fixture;
      fixture.chat.messages[1].retrieval = {schema: "pkm.chat.retrieval/v1", chatId: fixture.chat.id, sessionId: "task-cache", model: "Actual fixture model", selectedCount: 7,
        candidates: Array.from({length: 20}, (_, index) => ({id: "source-" + index, kind: ["memory", "skill", "note", "script", "recipe", "research", "api", "function"][index % 8],
          label: "Cache candidate " + index, sourceUri: "pkm://fixture/" + index, score: 20 - index, method: index % 2 ? "lexical:unified-retrieval" : "rule:lexical-overlap",
          selected: index < 7, reason: index < 7 ? "Included in request context" : "Outside selected budget"}))};
      const receipt = fixture.chat.messages[1].retrieval;
      fixture.chat.messages[1].retrievalActivity = {schema: "pkm.chat.retrieval-activity/v1", id: "fixture-activity", droppedRounds: 0,
        attempts: [{id: "memory", kind: "memory", at: 1, durationMs: 2, receipt}, {id: "knowledge", kind: "knowledge", at: 2, durationMs: 3, receipt}],
        rounds: [{index: 0, at: 3, inputTokens: 4000, inputBudget: 8192, countingMethod: "utf8-byte-estimate", receipt},
          {index: 1, at: 4, inputTokens: 7000, inputBudget: 8192, countingMethod: "utf8-byte-estimate", receipt: {...receipt, selectedCount: 2, candidates: receipt.candidates.map((candidate,index) => ({...candidate,selected:index < 2}))}}]};
      window.dispatchEvent(new MessageEvent("message", {data: fixture}));
    }""")
    page.locator("#memory").click()
    page.wait_for_selector("#retrieval-flow svg")
    assert page.locator("[data-retrieval-node]").count() == 11
    assert page.locator("[data-retrieval-link]").count() == 7
    assert page.locator("#retrieval-step option").count() == 5
    page.select_option("#retrieval-step", "attempt-0")
    assert "shortlist" in page.locator("#retrieval-status").inner_text()
    page.select_option("#retrieval-step", "round-1")
    assert page.locator("[data-retrieval-link]").count() == 2
    assert "Sent context" in page.locator("#retrieval-status").inner_text()
    assert "7000/8192" in page.locator("#retrieval-step option:checked").inner_text()
    page.select_option("#retrieval-step", "latest")
    page.evaluate("() => {globalThis.__stableArticle=document.querySelector('.message.assistant'); window.dispatchEvent(new MessageEvent('message',{data:globalThis.__fixture}));}")
    assert page.evaluate("globalThis.__stableArticle === document.querySelector('.message.assistant')"), "Refresh must retain unchanged message DOM"
    page.select_option("#retrieval-top", "20")
    assert page.locator("[data-retrieval-node]").count() == 21
    page.select_option("#retrieval-kind", "note")
    assert page.locator("[data-retrieval-node]").count() == 4
    assert page.locator("[data-retrieval-link]").count() == 1
    page.locator("[data-retrieval-node=source-2]").click()
    assert "lexical-overlap" in page.locator("#memory-preview").inner_text()
    page.select_option("#retrieval-kind", "all")
    page.select_option("#retrieval-top", "10")
    for width, height in [(1280, 900), (390, 844), (320, 568), (213, 378)]:
        page.set_viewport_size({"width": width, "height": height})
        page.wait_for_function("() => Math.abs(document.querySelector('#retrieval-flow svg').width.baseVal.value - Math.max(180, document.querySelector('#retrieval-flow').clientWidth)) < 1")
        geometry = page.evaluate("""() => ({width: innerWidth, scroll: document.documentElement.scrollWidth,
          composer: document.querySelector("#composer").getBoundingClientRect().toJSON(), model: document.querySelector('[data-retrieval-node="model"]').getBoundingClientRect().toJSON(),
          flow: document.querySelector('#retrieval-flow').getBoundingClientRect().toJSON(), height: innerHeight})""")
        assert geometry["scroll"] <= width, geometry
        assert geometry["composer"]["bottom"] <= height + 1, geometry
        assert geometry["model"]["right"] <= geometry["flow"]["right"] + 1, geometry
    assert not errors, errors
    assert page.evaluate("globalThis.__unsafe !== true")
    page.emulate_media(reduced_motion="reduce")
    assert page.locator("#memory-panel").evaluate("node => getComputedStyle(node).animationName") == "none"
    page.emulate_media(reduced_motion="no-preference")
    for width, height in [(1280, 900), (390, 844)]:
      page.set_viewport_size({"width": width, "height": height})
      for locale in ["zh-hans", "es", "ja", "ko", "fr", "de", "pt-br", "it", "ru", "ar", "en"]:
        evidence = page.evaluate("""locale => {
          const fixture = globalThis.__fixture;
          const catalog = globalThis.__locales[locale];
          const before = JSON.stringify(fixture.chat.messages.map(message => message.content));
          fixture.localization = {locale, direction: catalog.direction, strings: catalog.strings, english: globalThis.__locales.en.strings};
          window.dispatchEvent(new MessageEvent('message', {data: fixture}));
          return {
            lang: document.documentElement.lang, dir: document.documentElement.dir, expectedDir: catalog.direction,
            task: document.querySelector('#task').title, expectedTask: catalog.strings['apiChat.startTask'],
            protective: document.querySelector('#permission-mode option[value=protective]').textContent, expectedProtective: catalog.strings['apiChat.protective'],
            prompt: document.querySelector('#prompt').placeholder, expectedPrompt: catalog.strings['apiChat.prompt'],
            messagesUnchanged: before === JSON.stringify(fixture.chat.messages.map(message => message.content)),
            renderedMessage: document.querySelector('.message.user .content').textContent, originalMessage: fixture.chat.messages[0].content,
            cost: document.querySelector('#cost').textContent, tokenDirection: getComputedStyle(document.querySelector('#tokens')).direction,
            overflow: document.documentElement.scrollWidth > innerWidth
          };
        }""", locale)
        assert evidence["lang"] == locale and evidence["dir"] == evidence["expectedDir"], evidence
        for actual, expected in [("task", "expectedTask"), ("protective", "expectedProtective"), ("prompt", "expectedPrompt")]:
          assert evidence[actual] == evidence[expected], evidence
        assert evidence["messagesUnchanged"] and evidence["renderedMessage"] == evidence["originalMessage"], evidence
        assert evidence["cost"].startswith("First-call estimate: USD"), evidence
        assert not evidence["overflow"], evidence
        if locale == "ar":
          assert evidence["tokenDirection"] == "ltr", evidence
          page.screenshot(path="/tmp/pkm-chat-arabic-" + ("desktop" if width == 1280 else "mobile") + ".png")
    print("Chat localization browser gate passed: eleven languages, desktop/mobile, RTL and user-content/billing isolation.")
    for width, height in [(1280, 900), (390, 844)]:
      deletion = browser.new_page(viewport={"width": width, "height": height})
      deletion.on("pageerror", lambda error: errors.append(str(error)))
      decision = {"accept": True}
      deletion.on("dialog", lambda dialog: dialog.accept() if decision["accept"] else dialog.dismiss())
      deletion.goto(sys.argv[1] + "/deletion", wait_until="networkidle")
      assert not errors, errors
      def expect_counts(active, stored):
        deletion.wait_for_function("counts => globalThis.__deletionSnapshot?.active === counts[0] && globalThis.__deletionSnapshot?.stored === counts[1]", arg=[active, stored])
        receipt = deletion.request.get(sys.argv[1] + "/delete-state").json()
        assert receipt["active"] == active and receipt["stored"] == stored, receipt
        assert deletion.locator('.chat-list-group[data-group-id="ungroup"] .chat-list-row').count() == active
        return receipt
      def menu(chat_id, label):
        row = deletion.locator('.chat-list-open[data-chat-id="' + chat_id + '"]').locator("..")
        row.get_by_role("button", name="Chat actions", exact=True).click()
        deletion.get_by_role("menuitem", name=label, exact=True).click()
      expect_counts(0, 0)
      deletion.locator("#list-new").click()
      initial = expect_counts(1, 1)["state"]["chat"]["id"]
      deletion.locator("#back").click()
      decision["accept"] = False
      menu(initial, "Move to Trash")
      expect_counts(1, 1)
      decision["accept"] = True
      menu(initial, "Move to Trash")
      expect_counts(0, 1)
      deletion.reload(wait_until="networkidle")
      expect_counts(0, 1)
      menu(initial, "Restore Chat")
      assert expect_counts(1, 1)["state"]["chat"]["id"] == initial
      deletion.locator("#list-new").click()
      current = expect_counts(2, 2)["state"]["chat"]["id"]
      deletion.locator("#back").click()
      menu(initial, "Move to Trash")
      assert expect_counts(1, 2)["state"]["chat"]["id"] == current
      menu(current, "Move to Trash")
      expect_counts(0, 2)
      decision["accept"] = False
      menu(initial, "Delete permanently")
      expect_counts(0, 2)
      deletion.locator(".chat-trash-delete-all").click()
      expect_counts(0, 2)
      decision["accept"] = True
      menu(initial, "Delete permanently")
      expect_counts(0, 1)
      deletion.locator(".chat-trash-delete-all").click()
      expect_counts(0, 0)
      deletion.reload(wait_until="networkidle")
      expect_counts(0, 0)
      assert deletion.locator(".chat-trash-delete-all").is_disabled()
      assert deletion.evaluate("document.documentElement.scrollWidth <= innerWidth")
      deletion.screenshot(path="/tmp/pkm-chat-deletion-empty-" + ("desktop" if width == 1280 else "mobile") + ".png")
      deletion.close()
    assert not errors, errors
    browser.close()
    print("Chat browser gate passed: user bubbles, retrieval, four viewports; real controller/store deletion E2E passed for cancel, active/inactive/last Chat, restore, permanent delete, Empty Trash and reopen on desktop/mobile.")
`;
    const python = process.env.PKM_BROWSER_PYTHON || "python";
    try {
      require("child_process").execFileSync(python, ["-c", "import sys; compile(sys.stdin.read(), '<chat-browser-gate>', 'exec')"], { input: code, stdio: ["pipe", "inherit", "inherit"] });
    } catch { process.exitCode = 1; server.close(); return; }
    const child = require("child_process").spawn(python, ["-c", code, url], { stdio: "inherit" });
    child.once("error", error => { console.error(error.message); process.exitCode = 1; server.close(); });
    child.once("exit", exitCode => { process.exitCode = exitCode || 0; server.close(); });
  });
}

function createDeletionPreview() {
  const Module = require("module");
  const originalLoad = Module._load;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-chat-deletion-e2e-"));
  const context = { extensionPath: path.join(__dirname, ".."),
    workspaceState: { get: () => undefined, update: async () => {} }, globalState: { get: () => undefined } };
  let confirmed = false;
  let latest;
  let controllers;
  try {
    Module._load = function(name, parent, ...rest) {
      if (parent?.filename.endsWith("api-chat-view.js") && name.endsWith("/filestore")) return { getStorePath: () => directory };
      if (name === "vscode") return {
        workspace: { workspaceFolders: [], getConfiguration: () => ({ get: (key, fallback) => key === "aiModel" ? "fixture-model" : fallback }) },
        window: { showWarningMessage: async (_message, _options, choice) => confirmed ? choice : undefined },
        env: { language: "en" }, extensions: { getExtension: () => undefined },
      };
      return originalLoad.call(this, name, parent, ...rest);
    };
    const { ApiChatView } = require("../dist/chat/api-chat-view");
    controllers = [new ApiChatView(context), new ApiChatView(context)];
    controllers[0].view = { webview: { postMessage: message => { latest = message; return Promise.resolve(true); } } };
    controllers[1].view = { webview: { postMessage: async () => true } };
  } catch (error) { fs.rmSync(directory, { recursive: true, force: true }); throw error; }
  finally { Module._load = originalLoad; }
  const snapshot = () => {
    const records = controllers[0].openStore().list(true);
    return { state: latest, active: records.filter(chat => !chat.trashedAt).length, stored: records.length };
  };
  return {
    snapshot,
    async action(message, choice) {
      if (!["ready", "new", "select", "libraryRefresh", "trashChat", "restoreChat", "deleteChat", "emptyTrash"].includes(message?.type)) throw new Error("This fixture does not run model or tool requests.");
      confirmed = choice === true;
      await controllers[0].handle(message);
      await controllers[1].handle({ type: "ready" }); controllers[0].refresh();
      return snapshot();
    },
    dispose() { for (const controller of controllers) controller.dispose(); fs.rmSync(directory, { recursive: true, force: true }); },
  };
}