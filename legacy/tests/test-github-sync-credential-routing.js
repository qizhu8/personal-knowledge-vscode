const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");

const source = fs.readFileSync(path.join(__dirname, "../src/runtime/pkm-service.ts"), "utf8");
const compile = text => ts.transpileModule(text, {
  compilerOptions:{ target:ts.ScriptTarget.ES2022, module:ts.ModuleKind.CommonJS },
}).outputText;
const credentials = { exports:{} };
vm.runInNewContext(compile(fs.readFileSync(path.join(__dirname, "../src/sync/github-sync-credentials.ts"), "utf8")), {
  exports:credentials.exports, setTimeout, clearTimeout,
});
const { readStoredGitHubSyncCredentials, GitHubSyncCredentialError } = credentials.exports;

function fixture() {
  const start = source.indexOf("  function matching(connection: Connection)");
  const end = source.indexOf("  const coordinator = new GitHubSyncCoordinator(coordinatorOptions);", start);
  assert(start > 0 && end > start);
  const scope = {
    connections:new Set(), selected:new Map(), initiating:new Map(), active:new Map(),
    credentialTimeouts:new Map(), draining:false, reverseCount:0, drainWaiters:new Set(),
    HOST_CALLBACKS:["shouldExecute", "execute"], LONG_TIMEOUT:1000,
    identity:{ stateDirectory:"unused", knowledgeRoot:"unused" }, options:{ extensionVersion:"fixture" },
    shortenedTestInterval:(_name, fallback) => fallback,
    randomUUID:() => `execution-${scope.sequence++}`, sequence:0,
    fs:{ rmSync:() => assert.fail("no recovery record should be removed in this fixture") },
    executorState:state => state, notifyError:() => {}, resultPath:() => "unused",
    PkmServiceOfflineError:class extends Error {},
    PkmServiceExecutionUncertainError:class extends Error {},
    GitHubSyncDeferredError:class extends Error {},
    GitHubSyncExtensionCompatibilityError:class extends Error {},
    console,
  };
  vm.createContext(scope);
  vm.runInContext(compile(`${source.slice(start, end)}
    globalThis.callbacks = coordinatorOptions;
    globalThis.chooseHost = choose;`), scope);
  function host(name, execute = async () => {}) {
    const calls = [];
    const connection = { registered:true, callbacks:new Set(scope.HOST_CALLBACKS), peer:{
      connected:true, emit:() => {},
      request:async (method, value) => {
        calls.push({method, ...value});
        if (method === "shouldExecute") return true;
        if (method === "execute") return execute(scope.active.get(value.executionId), value);
      },
    } };
    connection.name = name;
    connection.calls = calls;
    scope.connections.add(connection);
    return connection;
  }
  async function run(reason = "interval", requester, targetId = "share") {
    if (requester) scope.initiating.set(targetId, {connection:requester, reason});
    assert.equal(await scope.callbacks.shouldExecute(targetId, reason), true);
    return scope.callbacks.execute(targetId, reason, 1);
  }
  return { scope, host, run };
}
const timeout = () => new GitHubSyncCredentialError("CREDENTIAL_READ_TIMEOUT", "Local credential channel timed out");

test("confirmed credential timeout prefers another eligible host only on the next automatic attempt", async () => {
  const f = fixture();
  const first = f.host("unresponsive renderer", async () => { throw timeout(); });
  const incompatible = f.host("incompatible");
  incompatible.callbacks.delete("execute");
  const disconnected = f.host("disconnected");
  disconnected.peer.connected = false;
  const second = f.host("healthy");
  await assert.rejects(f.run(), {code:"CREDENTIAL_READ_TIMEOUT"});
  assert.equal(first.calls.filter(call => call.method === "execute").length, 1);
  assert.equal(second.calls.length, 0, "the failed synchronization is never replayed");
  assert.equal(f.scope.active.size, 0);
  assert.equal(f.scope.chooseHost("other-target", "interval"), first, "channel health is target-specific");
  await f.run();
  assert.equal(second.calls.filter(call => call.method === "execute").length, 1);
  assert.equal(incompatible.calls.length, 0);
  assert.equal(disconnected.calls.length, 0);
});

test("a single host remains retryable without an inline replay or a cached late credential", async () => {
  const f = fixture();
  let release, writes = 0;
  const target = { authentication:{method:"vscode", expectedLogin:"fixture"} };
  const first = f.host("only host", async () => {
    await readStoredGitHubSyncCredentials(() => new Promise(resolve => { release = resolve; }), target, 5);
    writes++;
  });
  await assert.rejects(f.run(), {code:"CREDENTIAL_READ_TIMEOUT"});
  release(JSON.stringify({accountLabel:"fixture", accessToken:"fixture-token"}));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(writes, 0);
  assert.equal(first.calls.filter(call => call.method === "execute").length, 1);
  assert.equal(f.scope.chooseHost("share", "interval"), first);
});

test("manual and force-local-authority executions keep requester ownership even after its timeout", async () => {
  for (const reason of ["manual", "force-local-authority"]) {
    const f = fixture();
    const first = f.host("automatic fallback");
    const requester = f.host("requester", async () => { throw timeout(); });
    await assert.rejects(f.run(reason, requester), {code:"CREDENTIAL_READ_TIMEOUT"});
    await assert.rejects(f.run(reason, requester), {code:"CREDENTIAL_READ_TIMEOUT"});
    assert.equal(first.calls.length, 0);
    assert.equal(requester.calls.filter(call => call.method === "execute").length, 2);
    requester.peer.connected = false;
    await assert.rejects(f.run(reason, requester), /request.*disconnected/i);
    assert.equal(first.calls.length, 0, "manual requests must never silently swap hosts");
  }
});

test("all failed channels are retried oldest first rather than repeatedly selecting the first host", async () => {
  const f = fixture();
  const first = f.host("first", async () => { throw timeout(); });
  const second = f.host("second", async () => { throw timeout(); });
  await assert.rejects(f.run(), {code:"CREDENTIAL_READ_TIMEOUT"});
  await assert.rejects(f.run(), {code:"CREDENTIAL_READ_TIMEOUT"});
  assert.equal(f.scope.chooseHost("share", "interval"), first);
  await assert.rejects(f.run(), {code:"CREDENTIAL_READ_TIMEOUT"});
  assert.equal(f.scope.chooseHost("share", "interval"), second);
});

test("Git work, uncertain execution, real auth rejection and other credential errors never trigger host failover or replay", async () => {
  for (const mode of ["git-started", "disconnected", "authentication", "canceled", "read-failed", "wrong-phase"]) {
    const f = fixture();
    let first;
    first = f.host("first", async execution => {
      if (mode === "git-started") execution.operations.add("already-submitted");
      if (mode === "disconnected") first.peer.connected = false;
      if (mode === "authentication") throw Object.assign(new Error("Bad credentials"), {code:"AUTH_FAILED", phase:"authenticating"});
      if (mode === "canceled") throw new GitHubSyncCredentialError("CREDENTIAL_READ_CANCELED", "Canceled");
      if (mode === "read-failed") throw new GitHubSyncCredentialError("CREDENTIAL_READ_FAILED", "Unavailable");
      if (mode === "wrong-phase") throw Object.assign(new Error("Timeout"), {code:"CREDENTIAL_READ_TIMEOUT", phase:"push"});
      throw timeout();
    });
    const second = f.host("second");
    await assert.rejects(f.run());
    assert.equal(first.calls.filter(call => call.method === "execute").length, 1);
    assert.equal(second.calls.length, 0, `${mode} must not replay execution`);
    first.peer.connected = true;
    assert.equal(f.scope.chooseHost("share", "interval"), first, `${mode} is not evidence of a safe pre-Git credential timeout`);
    assert.equal(f.scope.credentialTimeouts.size, 0);
  }
});
