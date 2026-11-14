const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const { createHash } = require("node:crypto");
const { captureValidationArtifacts, validationArtifactState, validationArtifactPaths, verifyValidationArtifacts } = require("../dist/chat/validation-artifacts");
const { createHarnessReportTool } = require("../dist/chat/chat-harness-records");
const { apiChatHarnessSnapshot, apiChatSessionHarnessSnapshot, verifyHarnessArtifacts } = require("../dist/chat/api-chat-store");
const { ChatHistoryStorage } = require("../dist/chat/chat-history-storage");
const { build } = require("../src/webview/agent-harness");

const guardScope = { guard:require("../dist/chat/tool-paths").relativeToolPath };
const signal = () => new AbortController().signal;

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-validation-artifacts-"));
  t.after(() => fs.rmSync(directory, { recursive:true, force:true }));
  const file = path.join(directory, "output.txt");
  fs.writeFileSync(file, "version one");
  const taskId = `agent_session_${"a".repeat(32)}`;
  const reply = { id:"reply", role:"assistant", taskId, status:"streaming", content:"",
    progress:{ attemptId:"attempt", status:"running", steps:[] },
    toolCalls:[{ id:"test", name:"run_process", arguments:"{}", status:"complete", result:"tests passed" }] };
  const chat = { version:1, id:"11111111-1111-4111-8111-111111111111", sessionId:taskId,
    messages:[{ id:"input", role:"user", taskId, status:"complete", content:"Check this saved artifact." }, reply] };
  const capture = (files, cancellation) => captureValidationArtifacts(files, [directory], cancellation, guardScope.guard);
  const tool = createHarnessReportTool(chat, reply, report => (reply.harnessReports ||= []).push(report), capture);
  const report = (status, extra = {}) => {
    const callId = status === "complete" ? `test-${reply.toolCalls.length}` : "test";
    if (status === "complete") reply.toolCalls.push({ id:callId, name:"run_process", arguments:"{}", status:"complete",
      result:"tests passed", startedAt:Date.now(), finishedAt:Date.now() });
    return tool.execute({ kind:"validation", stepId:"check", summary:"Check saved file", status,
      ...(status === "complete" || status === "failed" ? { evidenceCallIds:[callId] } : {}), ...extra }, signal());
  };
  const lifecycle = async (value = chat) => build({ sessionId:taskId, origin:"pkm-native", status:"completed", todos:[],
    harness:await verifyHarnessArtifacts(apiChatHarnessSnapshot(value), [directory]) }).lifecycle;
  return { directory, file, chat, reply, tool, capture, report, lifecycle };
}

test("Host hashes saved bytes, outcomes inherit files, and reloaded snapshots invalidate changed versions", async t => {
  const f = fixture(t);
  await f.report("start", { artifactPaths:[{ path:"output.txt" }] });
  const start = f.reply.harnessReports[0];
  assert.equal(start.artifactVersions[0].sha256, createHash("sha256").update("version one").digest("hex"));
  await f.report("complete");
  f.reply.status = "complete"; f.reply.progress.status = "complete";
  assert.equal((await f.lifecycle()).current, "end");
  const storage = new ChatHistoryStorage(f.directory);
  const packed = storage.pack(f.chat);
  const record = JSON.parse(JSON.stringify({ schema:"pkm.agent.session/v1", sessionId:f.chat.sessionId,
    origin:"pkm-native", runtimeOwner:"pkm", hostKind:"pkm", nativeChat:packed }));
  fs.writeFileSync(f.file, "version two");
  for (const unverified of [apiChatHarnessSnapshot(f.chat), apiChatHarnessSnapshot(storage.unpack(packed)),
    apiChatSessionHarnessSnapshot(record, f.chat.sessionId, f.directory)]) {
    const snapshot = await verifyHarnessArtifacts(unverified, [f.directory]);
    const state = build({ sessionId:f.chat.sessionId, origin:"pkm-native", status:"completed", todos:[], harness:snapshot }).lifecycle;
    assert.deepEqual([state.current, state.outcome], ["check", "unverified"]);
    assert.match(state.reason, /artifacts changed/);
    assert.equal(snapshot.attempts.at(-1).harnessReports.at(-1).status, "complete", "historical receipt must remain immutable");
  }
});

test("changed or missing files reject completion without mutating reports; failed outcome permits explicit retry", async t => {
  const f = fixture(t);
  await f.report("start", { artifactPaths:[{ path:"output.txt" }] });
  fs.writeFileSync(f.file, "version two");
  await assert.rejects(f.report("complete"), /artifacts changed since start/);
  assert.equal(f.reply.harnessReports.length, 1);
  await f.report("failed");
  await f.report("start", { artifactPaths:[{ path:"output.txt" }] });
  fs.unlinkSync(f.file);
  await assert.rejects(f.report("complete"), /ENOENT/);
  assert.equal(f.reply.harnessReports.length, 3);
  await f.report("ignored", { reason:"Artifact removed; check revised output." });
  fs.writeFileSync(f.file, "version three");
  await f.report("start", { artifactPaths:[{ path:"output.txt" }] });
  await f.report("complete");
  f.reply.status = "complete"; f.reply.progress.status = "complete";
  assert.equal((await f.lifecycle()).current, "end");
  fs.unlinkSync(f.file);
  assert.equal((await f.lifecycle()).outcome, "unverified");
});

test("file capture preserves source-input and cancellation gates across asynchronous reads", async t => {
  const f = fixture(t);
  const cancelled = new AbortController();
  cancelled.abort();
  await assert.rejects(f.tool.execute({ kind:"validation", status:"start", stepId:"check", summary:"Check",
    artifactPaths:[{ path:"output.txt" }] }, cancelled.signal), /cancelled/);
  assert.equal(f.reply.harnessReports, undefined);
  const tool = createHarnessReportTool(f.chat, f.reply, () => assert.fail("inputs changed; must not commit"), async (files, signal) => {
    const versions = await f.capture(files, signal);
    f.chat.messages[0].content = "Revised requirement";
    return versions;
  });
  await assert.rejects(tool.execute({ kind:"validation", status:"start", stepId:"check", summary:"Check",
    artifactPaths:[{ path:"output.txt" }] }, signal()), /source inputs changed/);
});

test("artifact arguments cannot supply hashes, replace outcome paths or bypass existing file exclusions", async t => {
  const f = fixture(t);
  for (const value of [[], Array(17).fill({ path:"output.txt" }), [{ path:"output.txt", sha256:"forged" }],
    [{ path:"output.txt", workspace:-1 }], [{ path:"output.txt" }, { path:"output.txt" }]]) {
    assert.throws(() => validationArtifactPaths(value));
  }
  for (const name of ["../outside", ".env", "node_modules/file", "credentials.json", "/etc/passwd", "C:\\outside"]) {
    await assert.rejects(f.capture([{ path:name, workspace:0 }], signal()));
  }
  await f.report("start", { artifactPaths:[{ path:"output.txt" }] });
  await assert.rejects(f.report("complete", { artifactPaths:[{ path:"other.txt" }] }), /Only validation start/);
  const noCapture = createHarnessReportTool(f.chat, f.reply, () => assert.fail("Host capability missing"));
  await assert.rejects(noCapture.execute({ kind:"validation", stepId:"other", status:"start", summary:"Check",
    artifactPaths:[{ path:"output.txt" }] }, signal()), /Host cannot capture/);
});

test("symlink escapes, aliases, oversized files and non-file artifacts are explicitly rejected", async t => {
  const f = fixture(t);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-artifact-outside-"));
  t.after(() => fs.rmSync(outside, { recursive:true, force:true }));
  fs.writeFileSync(path.join(outside, "file"), "outside");
  fs.symlinkSync(path.join(outside, "file"), path.join(f.directory, "escape"));
  await assert.rejects(f.capture([{ path:"escape", workspace:0 }], signal()), /inside their workspace/);
  fs.symlinkSync(f.file, path.join(f.directory, "alias"));
  await assert.rejects(f.capture([{ path:"output.txt", workspace:0 }, { path:"alias", workspace:0 }], signal()), /same file/);
  fs.mkdirSync(path.join(f.directory, "folder"));
  await assert.rejects(f.capture([{ path:"folder", workspace:0 }], signal()), /regular files/);
  fs.writeFileSync(path.join(f.directory, "large"), Buffer.alloc(4 * 1024 * 1024 + 1));
  await assert.rejects(f.capture([{ path:"large", workspace:0 }], signal()), /4 MiB/);
});

test("same-length rewrites with restored mtime still invalidate the captured file identity", async t => {
  const f = fixture(t);
  const versions = await f.capture([{ path:"output.txt", workspace:0 }], signal());
  const before = fs.statSync(f.file);
  fs.writeFileSync(f.file, "version two");
  fs.utimesSync(f.file, before.atime, before.mtime);
  assert.equal(validationArtifactState(versions).status, "stale");
  assert.equal(validationArtifactState([{ ...versions[0], host:"different-host" }]).status, "stale");
  assert.equal(validationArtifactState([]).status, "unavailable");
});

test("matching metadata cannot mask different saved bytes in asynchronous inspection", async t => {
  const f = fixture(t);
  const versions = await f.capture([{ path:"output.txt", workspace:0 }], signal());
  const previous = fs.statSync(f.file, { bigint:true });
  fs.writeFileSync(f.file, "version two");
  const stat = fs.statSync;
  fs.statSync = function(file, ...args) {
    return file === f.file ? previous : stat.call(this, file, ...args);
  };
  try {
    assert.equal(validationArtifactState(versions).status, "unchecked", "simulate a timestamp/metadata collision");
    const state = await verifyValidationArtifacts(versions, signal(), [f.directory]);
    assert.equal(state.status, "stale");
    assert.match(state.files[0].reason, /Saved bytes changed/);
  } finally { fs.statSync = stat; }
});

test("synchronous snapshots with matching metadata never claim verified current bytes", async t => {
  const f = fixture(t);
  await f.report("start", { artifactPaths:[{ path:"output.txt" }] });
  await f.report("complete");
  f.reply.status = "complete"; f.reply.progress.status = "complete";
  const snapshot = apiChatHarnessSnapshot(f.chat);
  assert.equal(snapshot.attempts.at(-1).validation.artifactState.status, "unchecked");
  assert.equal(build({ sessionId:f.chat.sessionId, origin:"pkm-native", status:"completed", todos:[], harness:snapshot }).lifecycle.outcome, "unverified");
  const verified = await verifyHarnessArtifacts(snapshot, [f.directory]);
  assert.equal(verified.attempts.at(-1).validation.artifactState.status, "unchanged");
});

test("artifact-bound completion rejects old-attempt and pre-start tool evidence", async t => {
  const f = fixture(t);
  await f.report("start", { artifactPaths:[{ path:"output.txt" }] });
  const complete = () => f.tool.execute({ kind:"validation", stepId:"check", status:"complete", summary:"Check",
    evidenceCallIds:["test"] }, signal());
  Object.assign(f.reply.toolCalls[0], { startedAt:1, finishedAt:2 });
  await assert.rejects(complete(), /after its recorded start/);
  const start = f.reply.harnessReports[0];
  Object.assign(f.reply.toolCalls[0], { startedAt:start.at, finishedAt:start.at });
  await assert.rejects(complete(), /after its recorded start/, "equal millisecond timestamps cannot reuse pre-start evidence");
  const old = f.reply.toolCalls.pop();
  f.chat.messages.splice(1, 0, { id:"old", role:"assistant", taskId:f.chat.sessionId, toolCalls:[old] });
  Object.assign(old, { startedAt:Date.now(), finishedAt:Date.now() });
  await assert.rejects(complete(), /in this attempt/);
  assert.equal(f.reply.harnessReports.length, 1);
});

test("all workspace indices bind their actual root and total byte limits are enforced", async t => {
  const f = fixture(t);
  const second = path.join(f.directory, "second");
  fs.mkdirSync(second);
  fs.writeFileSync(path.join(second, "output.txt"), "second root");
  const versions = await captureValidationArtifacts([{ path:"output.txt", workspace:1 }],
    [f.directory, second], signal(), guardScope.guard);
  assert.equal(versions[0].root, second);
  assert.equal(versions[0].sha256, createHash("sha256").update("second root").digest("hex"));
  await assert.rejects(f.capture([{ path:"output.txt", workspace:1 }], signal()), /existing artifact workspace/);
  const files = Array.from({ length:5 }, (_, index) => ({ path:`large-${index}`, workspace:0 }));
  for (const file of files) fs.writeFileSync(path.join(f.directory, file.path), Buffer.alloc(4 * 1024 * 1024));
  await assert.rejects(f.capture(files, signal()), /16 MiB total/);
});

test("metadata-only snapshots never reread artifact contents or rewrite a completed Task", async t => {
  const f = fixture(t);
  await f.report("start", { artifactPaths:[{ path:"output.txt" }] });
  await f.report("complete");
  f.reply.status = "complete"; f.reply.progress.status = "complete";
  fs.writeFileSync(f.file, "version two");
  const read = fs.readFileSync;
  fs.readFileSync = function(file, ...args) {
    if (file === f.file) assert.fail("Snapshot must not synchronously read artifact bytes");
    return read.call(this, file, ...args);
  };
  try {
    const snapshot = await verifyHarnessArtifacts(apiChatHarnessSnapshot(f.chat), [f.directory]);
    assert.notEqual(snapshot.attempts.at(-1).validation.artifactState.status, "unchanged");
    const session = { sessionId:f.chat.sessionId, origin:"pkm-native", status:"completed",
      todos:[{ status:"succeeded" }], harness:snapshot };
    assert.equal(build(session).lifecycle.outcome, "unverified");
    assert.equal(session.status, "completed");
  } finally { fs.readFileSync = read; }
});

test("production Host capture enforces trust, dirty editors and execution-context checks", async t => {
  const f = fixture(t);
  const source = fs.readFileSync(path.join(__dirname, "../src/chat/api-chat-view.ts"), "utf8");
  const ast = ts.createSourceFile("api-chat-view.ts", source, ts.ScriptTarget.Latest, true);
  let callback;
  const visit = node => {
    if (ts.isCallExpression(node) && node.expression.getText(ast) === "createHarnessReportTool") callback = node.arguments[3].getText(ast);
    ts.forEachChild(node, visit);
  };
  visit(ast);
  assert(callback, "production report tool must wire the Host file capture");
  let checked = 0;
  const host = { fs, path, captureValidationArtifacts, relativeToolPath:guardScope.guard,
    chat:f.chat, reply:f.reply, executionContext:{}, executionRoots:[{ scheme:"file", fsPath:f.directory }],
    assertRunnable() { checked++; },
    vscode:{ workspace:{ isTrusted:true, textDocuments:[] } } };
  vm.runInNewContext(ts.transpileModule(`globalThis.capture = ${callback};`,
    { compilerOptions:{ target:ts.ScriptTarget.ES2022 } }).outputText, host);
  const versions = await host.capture([{ path:"output.txt", workspace:0 }], signal());
  assert.equal(versions[0].sha256, createHash("sha256").update("version one").digest("hex"));
  assert.equal(checked, 2);
  host.vscode.workspace.isTrusted = false;
  await assert.rejects(host.capture([{ path:"output.txt", workspace:0 }], signal()), /trusted workspace/);
  host.vscode.workspace.isTrusted = true;
  host.vscode.workspace.textDocuments = [{ isDirty:true, uri:{ scheme:"file", fsPath:f.file } }];
  await assert.rejects(host.capture([{ path:"output.txt", workspace:0 }], signal()), /Save the artifact/);
});

test("native Harness snapshot request awaits exact hashes and cannot read closed-workspace artifacts", async t => {
  const f = fixture(t);
  await f.report("start", { artifactPaths:[{ path:"output.txt" }] });
  await f.report("complete");
  f.reply.status = "complete"; f.reply.progress.status = "complete";
  const source = fs.readFileSync(path.join(__dirname, "../src/extension.ts"), "utf8");
  const ast = ts.createSourceFile("extension.ts", source, ts.ScriptTarget.Latest, true);
  const declaration = ast.statements.find(node => node.name?.text === "nativeHarnessRequest");
  const host = { path, verifyHarnessArtifacts, nativeHarnessAccess() {}, getStorePath:() => f.directory,
    currentProjectStore:() => ({ list:() => ({ recipes:[] }) }),
    agentSessionSnapshots:() => [{ harness:apiChatHarnessSnapshot(f.chat) }],
    readHarnessActions:() => ({}), agentSessionJsonCache:{ read() { assert.fail("No Action references"); } },
    vscode:{ workspace:{ isTrusted:true, workspaceFolders:[{ uri:{ fsPath:f.directory } }] } } };
  vm.runInNewContext(ts.transpileModule(declaration.getText(ast)
    + "\nglobalThis.request = nativeHarnessRequest;", { compilerOptions:{ target:ts.ScriptTarget.ES2022 } }).outputText, host);
  const first = await host.request("snapshot", { sessionId:f.chat.sessionId });
  assert.equal(first.harness.attempts.at(-1).validation.artifactState.status, "unchanged");
  host.vscode.workspace.workspaceFolders = [];
  const closed = await host.request("snapshot", { sessionId:f.chat.sessionId });
  assert.equal(closed.harness.attempts.at(-1).validation.artifactState.status, "unavailable");
  assert.match(closed.harness.attempts.at(-1).validation.artifactState.files[0].reason, /not open and trusted/);
  host.vscode.workspace.workspaceFolders = [{ uri:{ fsPath:f.directory } }];
  host.vscode.workspace.isTrusted = false;
  const untrusted = await host.request("snapshot", { sessionId:f.chat.sessionId });
  assert.equal(untrusted.harness.attempts.at(-1).validation.artifactState.status, "unavailable");
});
