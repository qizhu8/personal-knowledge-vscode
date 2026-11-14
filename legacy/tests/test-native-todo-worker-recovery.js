"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const ts = require("typescript");

async function recover({ pendingToken = true, backendChanged = false, activeMatches = true, legacyIndex = true } = {}) {
  const workspaceId = crypto.randomUUID(), operationId = crypto.randomUUID();
  const slug = "Team/Board", actorId = "external:copilot:fixture-worker";
  const token = crypto.randomBytes(32).toString("hex");
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
  const pendingKey = `pkm.privateNativeTodo.workerPending:${workspaceId}`;
  const activeKey = `pkm.native-todo-worker:${workspaceId}:${slug}:${actorId}`;
  const input = { kind: "worker-grant", boardSlug: slug, actorId, tokenHash, operationId };
  const state = legacyIndex ? { [pendingKey]: { [operationId]: input } } : {};
  const activeToken = pendingToken || !activeMatches ? crypto.randomBytes(32).toString("hex") : token;
  const secrets = new Map([[activeKey, activeToken]]);
  const tokenKey = legacyIndex ? `${pendingKey}:${operationId}` : `${activeKey}:pending:${tokenHash}`;
  if (pendingToken) secrets.set(tokenKey, token);
  const errors = [], requests = [];
  const vscode = {
    commands: { registerCommand() { return { dispose() {} }; }, executeCommand() {} },
    window: { showErrorMessage(message) { errors.push(message); } },
  };
  const imports = name => name === "vscode" ? vscode
    : name === "./native-todo-library" ? { registerNativeTodoLibrary() { throw new Error("No Library is admitted in this credential fixture."); } }
    : name === "../ui/note-todo-browser" ? {} : require(name);
  const source = fs.readFileSync(path.join(__dirname, "../src/chat/native-todo-ui-experiment.ts"), "utf8");
  const js = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  } }).outputText;
  const module = { exports: {} };
  new Function("require", "module", "exports", js)(imports, module, module.exports);
  const registration = module.exports.registerNativeTodoUiExperiment({
    globalState: {
      get(key, fallback) { return structuredClone(state[key] ?? fallback); },
      async update(key, value) { state[key] = structuredClone(value); },
    },
    secrets: {
      async get(key) { return secrets.get(key); },
      async store(key, value) { secrets.set(key, value); },
      async delete(key) { secrets.delete(key); },
    },
  }, {
    workspaceId, boards: () => [slug],
    async rpc(request) {
      requests.push(request);
      return { workerGrants: { [actorId]: backendChanged ? "f".repeat(64) : tokenHash } };
    },
  });
  await new Promise(resolve => setImmediate(resolve));
  registration.dispose();
  assert.deepEqual(errors, []);
  assert.deepEqual(requests, [{ method: "todo", input: { kind: "read", boardSlug: slug } }]);
  assert.equal(crypto.createHash("sha256").update(secrets.get(`${activeKey}:grant:${tokenHash}`) ?? secrets.get(activeKey) ?? "").digest("hex"),
    crypto.createHash("sha256").update(!backendChanged && (pendingToken || activeMatches) ? token : activeToken).digest("hex"));
  assert.equal(crypto.createHash("sha256").update(secrets.get(activeKey) ?? "").digest("hex"),
    crypto.createHash("sha256").update(activeToken).digest("hex"), "Finalizing one hash must not overwrite a different active grant.");
  return { pending: state[pendingKey] ?? {}, hasPendingToken: secrets.has(tokenKey) };
}

test("worker secret finalization resumes before and after the pending secret deletion", async t => {
  for (const pendingToken of [true, false]) await t.test(`pending token ${pendingToken ? "present" : "already deleted"}`, async () => {
    const result = await recover({ pendingToken });
    assert.deepEqual(result.pending, {});
    assert.equal(result.hasPendingToken, false);
  });
});

test("a changed backend grant cannot finalize a stale pending secret or replace the active token", async () => {
  const result = await recover({ backendChanged: true });
  assert.equal(Object.keys(result.pending).length, 1);
  assert.equal(result.hasPendingToken, true);
});

test("a missing pending token and unrelated active secret cannot falsely finalize an interrupted grant", async () => {
  const result = await recover({ pendingToken: false, activeMatches: false });
  assert.equal(Object.keys(result.pending).length, 1);
  assert.equal(result.hasPendingToken, false);
});

test("the committed native hash recovers pending SecretStorage without Memento or overwriting another grant", async () => {
  const result = await recover({ legacyIndex: false });
  assert.deepEqual(result.pending, {});
  assert.equal(result.hasPendingToken, false);
});

test("verified awaited secret finalization is not downgraded by a stale pending-key cache", async () => {
  const slug="Team/Board", actorId="external:copilot:fixture-worker", values=new Map(), stale=new Map(), posts=[];
  let open, receive, grant;
  const panel={webview:{onDidReceiveMessage(handler){receive=handler;return{dispose(){}};},
    async postMessage(message){posts.push(message);}},onDidDispose(){},dispose(){}};
  const vscode={ViewColumn:{One:1},commands:{executeCommand(){},registerCommand(_id,handler){open=handler;return{dispose(){}};}},
    window:{createWebviewPanel(){return panel;},async showInformationMessage(){},showErrorMessage(){}}};
  const source=fs.readFileSync(path.join(__dirname,"../src/chat/native-todo-ui-experiment.ts"),"utf8");
  const js=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  const module={exports:{}};
  new Function("require","module","exports",js)(name=>name==="vscode"?vscode:name==="../ui/note-todo-browser"
    ?{browserNoteTodo:()=>""}:name==="./native-todo-library"?{}:require(name),module,module.exports);
  const registration=module.exports.registerNativeTodoUiExperiment({
    extensionPath:"unused-private-unit-fixture",
    globalState:{get(_key,fallback){return fallback;},async update(){}},
    secrets:{
      async get(key){return stale.get(key)??values.get(key);},
      async store(key,value){values.set(key,value);},
      async delete(key){if(values.has(key))stale.set(key,values.get(key));values.delete(key);},
    },
  },{
    workspaceId:crypto.randomUUID(),boards:()=>[slug],
    async rpc({input}){
      if(input.kind==="worker-grant")grant=input.tokenHash;
      return {note:{title:"Synthetic Board"},snapshot:{digest:"0".repeat(64),items:[]},
        workerGrants:grant?{[actorId]:grant}:{}};
    },
  });
  try{
    await open(slug);
    await receive({command:"todoBoardGrantWorker",slug,actorId,expectedDigest:"0".repeat(64),requestId:1});
    assert.equal(posts.at(-1).data.error,undefined);
    assert.equal(posts.at(-1).data.workerSecretStatus[actorId],"ready");
    assert.equal([...values.keys()].some(key=>key.includes(":pending:")),false);
    const active=[...values.entries()].find(([key])=>key.endsWith(`:grant:${grant}`));
    assert.equal(crypto.createHash("sha256").update(active[1]).digest("hex"),grant);
  }finally{registration.dispose();}
});
