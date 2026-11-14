const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), http = require("node:http"), ts = require("typescript");
const { randomUUID } = require("node:crypto"), { pathToFileURL } = require("node:url");
const { execFileSync, execFile } = require("node:child_process"), { promisify } = require("node:util");
const { prepare } = require("./helpers/ordinary-environment-profile-fixture");
const build = process.env.PKM_ENV_AUTHORITY_BUILD, nextDist = process.env.PKM_TEST_NEXT_SERVER_DIST;
assert(build && path.isAbsolute(build) && nextDist && path.isAbsolute(nextDist),
  "Explicit isolated Environment and Next source builds required; no default dist or production owner.");
const { attachOrdinaryEnvironmentsToOwner: attach } = require(path.join(build, "runtime/ordinary-environment-owner.js"));
function fixture(t) {
  const root = path.resolve(".migration-test-work", `ordinary-owner-unit-${randomUUID()}`),
    profile = path.join(root, "profile"), knowledge = path.join(root, "knowledge"), directory = path.join(profile, "environments");
  fs.mkdirSync(directory, { recursive: true }); fs.mkdirSync(knowledge);
  const rows = [{ id: "original-id", name: "Original", manager: "conda", path: path.join(root, "literal alias"),
    python: path.join(root, "literal alias/bin/python"), customReference: { owner: "original-profile" } }];
  fs.writeFileSync(path.join(directory, "registry.json"), JSON.stringify(rows));
  fs.writeFileSync(path.join(directory, "original-id.packages.json"), JSON.stringify({
    capturedAt: "2020-01-02T03:04:05Z", packages: [{ name: "old-package", version: "1.0" }] }));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let child, ownerCurrent = true, authorized = true;
  const revoke = new AbortController(), failures = [];
  const owner = { workspaceId: "own-workspace", storage: { workspaceRoot: () => knowledge },
    assertCurrent() { if (!ownerCurrent) throw Error("owner revoked"); },
    registerChildClose(close) { child = close; return () => { child = undefined; }; } };
  const authority = { workspaceId: owner.workspaceId, actorId: "local:owner", knowledgeRoot: knowledge,
    globalStorageDirectory: profile, scope: "ordinary-environments:read-cache", signal: revoke.signal,
    assertCurrent(binding) { assert.equal(binding.globalStorageDirectory, profile); if (!authorized) throw Error("profile revoked"); } };
  const hostSession = { workspaceId: owner.workspaceId, signal: new AbortController().signal,
    assertCurrent(scope) { assert.equal(scope, "environment"); owner.assertCurrent(); },
    registerChildClose(scope, close) { assert.equal(scope, "environment"); return () => {}; } };
  return { root, profile, knowledge, directory, rows, owner, hostSession, authority, revoke, failures,
    get child() { return child; }, set authorized(value) { authorized = value; }, set ownerCurrent(value) { ownerCurrent = value; },
    open: () => attach({ owner, hostSession, authority, onCloseError: error => failures.push(error) }) };
}
test("original profile IDs/cache are read directly; refresh, missing cache, permissions and malformed input never execute or overwrite", async t => {
  const f = fixture(t), adapter = f.open(); t.after(() => adapter.close());
  const before = fs.readFileSync(path.join(f.directory, "registry.json"));
  assert.deepEqual((await adapter.handleMessage({ command: "envList" })).data, f.rows);
  assert.equal((await adapter.handleMessage({ command: "envPackages", id: "original-id" })).cached, true);
  const refresh = await adapter.handleMessage({ command: "envPackages", id: "original-id", refresh: true });
  assert.match(refresh.error, /separate authorization.*no manager/);
  await assert.rejects(adapter.handleMessage({ command: "envList", refresh: true }), /separate authorization/);
  await assert.rejects(adapter.handleMessage({ command: "envDelete", id: "original-id" }), /Only ordinary/);
  await assert.rejects(adapter.handleMessage({ command: "envPackages", id: "../original-id" }), /registered/);
  await assert.rejects(adapter.handleMessage({ command: "envPackages", id: "other-profile-id" }), /authorized original profile/);
  const cache = path.join(f.directory, "original-id.packages.json"), bytes = fs.readFileSync(cache);
  fs.chmodSync(cache, 0);
  try {
    const denied = await adapter.handleMessage({ command: "envPackages", id: "original-id" });
    assert.match(denied.error, /EACCES/); assert(denied.error.includes(cache));
  } finally { fs.chmodSync(cache, 0o600); }
  assert.deepEqual(fs.readFileSync(cache), bytes);
  fs.unlinkSync(cache);
  assert.match((await adapter.handleMessage({ command: "envPackages", id: "original-id" })).error, /ENOENT/);
  assert.equal(fs.existsSync(cache), false);
  fs.writeFileSync(cache, "bad-json");
  assert.match((await adapter.handleMessage({ command: "envPackages", id: "original-id" })).error, /SyntaxError/);
  assert.equal(fs.readFileSync(cache, "utf8"), "bad-json");
  fs.unlinkSync(cache); fs.symlinkSync(path.join(f.directory, "registry.json"), cache);
  assert.match((await adapter.handleMessage({ command: "envPackages", id: "original-id" })).error, /ELOOP/);
  fs.unlinkSync(cache); execFileSync("mkfifo", [cache]);
  assert.match((await adapter.handleMessage({ command: "envPackages", id: "original-id" })).error, /bounded regular file/);
  assert.deepEqual(fs.readFileSync(path.join(f.directory, "registry.json")), before);
  assert.deepEqual(fs.readdirSync(f.root).sort(), ["knowledge", "profile"]);
});
test("independent owner/profile revocation rejects queued publication and closes only after queued work settles", async t => {
  const f = fixture(t), adapter = f.open(); t.after(() => adapter.close());
  assert(f.child);
  const task = adapter.handleMessage({ command: "envList" });
  f.authorized = false;
  await assert.rejects(task, /profile revoked/);
  f.authorized = true;
  const queued = adapter.handleMessage({ command: "envPackages", id: "original-id" });
  const closing = f.child();
  assert(f.child, "Child stays registered while pending work drains");
  await assert.rejects(queued, /closed/); await closing;
  assert.equal(f.child, undefined);
  await assert.rejects(adapter.handleMessage({ command: "envList" }), /closed/);
  const f2 = fixture(t), a2 = f2.open(); t.after(() => a2.close());
  f2.ownerCurrent = false;
  await assert.rejects(a2.handleMessage({ command: "envList" }), /owner revoked/);
  f2.ownerCurrent = true; f2.revoke.abort(); await a2.close();
  await assert.rejects(a2.handleMessage({ command: "envList" }), /closed/);
});
test("workspace/scope, asynchronous authority and redirected/replaced original profile cannot gain access", async t => {
  const f = fixture(t);
  for (const extra of [{ workspaceId: "other" }, { actorId: "mcp:external" }, { scope: "execute" },
    { assertCurrent: async () => { throw Error("async authority"); } }]) {
    assert.throws(() => attach({ owner: f.owner, hostSession: f.hostSession, authority: { ...f.authority, ...extra }, onCloseError() {} }),
      /match|synchronous/);
  }
  assert.throws(() => attach({ owner: f.owner, hostSession: { ...f.hostSession, workspaceId: "other-session" },
    authority: f.authority, onCloseError() {} }), /match/);
  const alias = path.join(f.root, "profile-alias"); fs.symlinkSync(f.profile, alias);
  assert.throws(() => attach({ owner: f.owner, hostSession: f.hostSession, authority: { ...f.authority, globalStorageDirectory: alias },
    onCloseError() {} }), /canonical/);
  fs.unlinkSync(alias);
  const a = f.open(); t.after(() => a.close());
  fs.renameSync(f.directory, path.join(f.profile, "original"));
  fs.mkdirSync(f.directory); fs.writeFileSync(path.join(f.directory, "registry.json"), "[]");
  await assert.rejects(a.handleMessage({ command: "envList" }), /directory changed/);
  await a.close();
  const a2 = f.open(); t.after(() => a2.close());
  fs.renameSync(f.profile, path.join(f.root, "original-profile")); fs.symlinkSync(path.join(f.root, "original-profile"), f.profile);
  await assert.rejects(a2.handleMessage({ command: "envList" }), /profile binding changed/);
});

function functions(text, names) {
  const tree = ts.createSourceFile("ui.js", text, ts.ScriptTarget.Latest, true);
  return names.map(name => {
    const node = tree.statements.find(item => ts.isFunctionDeclaration(item) && item.name?.text === name);
    assert(node); return node.getText(tree);
  }).join("\n");
}
function ordinaryHtml() {
  const read = name => fs.readFileSync(path.join("src/webview/panel", name), "utf8"), core = read("00-core.js");
  const begin = core.indexOf("else if (command === 'envList')"), end = core.indexOf("else if (command === 'envCompare')", begin);
  const initial = read("60-init.js").match(/else if \(state\.tab === 'environments'\) (ask\('envList', \{\}\);)/);
  assert(begin > 0 && end > begin && initial);
  return `<html><body><div id="detail"></div><script>
const state={tab:'environments'}, catExpanded={}, githubSyncTypes=[];
const esc=v=>String(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const uiIcon=(icon,label='')=>'<span>'+esc(label)+'</span>', helpText=en=>en;
const privacyInherited=()=>false,privacyLock=()=>'',folkDisplayName=esc,brokerFolderMarker=()=>'';
const problemGuidanceHtml=(message,next,actions)=>'<div role="alert">'+esc(message)+next+actions+'</div>';
function deliver(e){const command=e.data.command,data=e.data.data;if(false){} ${core.slice(begin,end)}}
function ask(command,data){fetch(location.pathname+'/message',{method:'POST',body:JSON.stringify({command,...data})})
.then(async r=>{if(!r.ok)throw Error(await r.text());return r.json();}).then(message=>deliver({data:message}));}
${functions(read("20-knowledge.js"), ["buildCatTree","countTreeLeaves","expandedCategoryKey","renderCatTree","toggleCat"])}
${read("30-environments.js")}
${initial[1]}
</script></body></html>`;
}
test("real adopted Next owner feeds the ordinary init/List/card/Packages UI from the same real 4.0.22 profile without a copy", { timeout: 90000 }, async t => {
  const load = name => import(pathToFileURL(path.join(nextDist, `${name}.js`)).href);
  const { adoptLegacyRootInPlaceExperimental } = await load("legacy-root-adoption");
  const { startAdoptedRootUnifiedHost } = await load("managed-client-host");
  const { createOwnerHostSessions } = await load("owner-host-sessions");
  const root = path.resolve(".migration-test-work", `ordinary-owner-native-${randomUUID()}`);
  const f = await prepare(root), python = process.env.PKM_BROWSER_PYTHON;
  assert(python && path.isAbsolute(python), "Existing Python Playwright required; never install automatically.");
  let unified, adoption;
  t.after(async () => {
    if (unified) await unified.managed.close(); else if (adoption) await adoption.storage.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  fs.mkdirSync(path.join(f.knowledgeRoot, "notes"), { mode: 0o700 });
  fs.renameSync(path.join(f.knowledgeRoot, "untouched-root.txt"), path.join(root, "offline-root-placeholder.txt"));
  fs.writeFileSync(path.join(f.knowledgeRoot, "notes", "Existing.md"), "---\ntitle: Existing\nrevision: 1\n---\nIsolated old Root.\n");
  const config = path.join(root, "native-host.json"), endpoint = "http://127.0.0.1:9/v1";
  fs.writeFileSync(config, JSON.stringify({ schema: "pkm.native-host-config/v1", provider: "openai-compatible", endpoint,
    secretRef: "secret:fixture/model", model: "fixture", contextWindow: 16384, maxOutputTokens: 4096,
    outputTokenParameter: "max_tokens", includeUsage: true, tools: ["knowledge.document.list"] }), { mode: 0o600 });
  adoption = await adoptLegacyRootInPlaceExperimental(f.knowledgeRoot, {});
  unified = await startAdoptedRootUnifiedHost({ optIn: true, dataPath: f.knowledgeRoot, configPath: config,
    expectedWorkspaceId: adoption.workspaceId, policy: { authorizedConfigPath: config,
      allowedProviders: ["openai-compatible"], allowedEndpoints: [endpoint], allowedModels: ["fixture"],
      allowedTools: ["knowledge.document.list"], allowInsecureLoopback: true }, resolveSecret: async () => "fixture" }, adoption);
  const owner = unified.ownerResourceContext();
  assert.equal(owner.storage, adoption.storage);
  const revoke = new AbortController(), closeErrors = [];
  const connection = new AbortController(), sessions = createOwnerHostSessions(owner, owner.workspaceId);
  let mcpAllowed = true, environmentAllowed = true;
  const hostSession = sessions.open({ hostKey: "isolated-env-ui", connection: connection.signal, assertHostCurrent() {},
    assertScopeCurrent(scope) { if (scope === "mcp" && !mcpAllowed || scope === "environment" && !environmentAllowed)
      throw Error("host scope revoked"); }, onCloseError: error => closeErrors.push(error) });
  const mcpSignal = hostSession.signalFor("mcp"), environmentSignal = hostSession.signalFor("environment");
  const adapter = attach({ owner, hostSession, authority: { workspaceId: owner.workspaceId, actorId: "local:owner",
    knowledgeRoot: f.knowledgeRoot, globalStorageDirectory: f.storage, scope: "ordinary-environments:read-cache",
    signal: revoke.signal, assertCurrent(binding) { assert.equal(binding.globalStorageDirectory, f.storage); } },
    onCloseError: error => closeErrors.push(error) });
  t.after(() => adapter.close());
  const before = [f.registry, f.cache, f.calls].map(file => fs.readFileSync(file));
  const served = [], token = randomUUID(), html = ordinaryHtml();
  const server = http.createServer(async (req, res) => {
    try {
      assert(req.url.startsWith(`/${token}`));
      if (req.url.endsWith("/message")) {
        let body = ""; for await (const chunk of req) body += chunk;
        const message = JSON.parse(body); served.push(message);
        res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(await adapter.handleMessage(message)));
      } else { res.setHeader("Content-Type", "text/html"); res.end(html); }
    } catch (error) { res.statusCode = 500; res.end(String(error)); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const runtime = path.join(root, "browser"); fs.mkdirSync(runtime);
  const chromium = execFileSync(python, ["-I", "-B", "-c",
    "from playwright.sync_api import sync_playwright\nwith sync_playwright() as p: print(p.chromium.executable_path)"],
  { encoding: "utf8", env: { ...process.env, TMPDIR: runtime } }).trim();
  assert(fs.existsSync(chromium), "Already installed Chromium required.");
  const result = await promisify(execFile)(python, ["-I", "-B", path.resolve("tests/ordinary_environment_owner_ui.py"),
    "--base", `http://127.0.0.1:${server.address().port}/${token}`, "--chromium", chromium,
    "--helper", path.resolve("tests/ordinary_environment_profile_ui.py"), "--id", f.id, "--venv-id", f.venvId],
  { cwd: runtime, env: { ...process.env, TMPDIR: ".", HOME: root, XDG_CONFIG_HOME: path.join(runtime, "config"),
    XDG_CACHE_HOME: path.join(runtime, "cache"), PYTHONDONTWRITEBYTECODE: "1" }, timeout: 40000 });
  assert(JSON.parse(result.stdout).ordinaryOwnerUi);
  assert(served.some(message => message.command === "envList"));
  assert(served.some(message => message.command === "envPackages" && message.refresh === true));
  const rows = (await adapter.handleMessage({ command: "envList" })).data;
  assert.deepEqual(rows.map(({ id, path: prefix, python, customReference }) => ({ id, prefix, python, customReference })),
    JSON.parse(before[0]).map(({ id, path: prefix, python, customReference }) => ({ id, prefix, python, customReference })));
  [f.registry, f.cache, f.calls].forEach((file, i) => assert.deepEqual(fs.readFileSync(file), before[i]));
  assert.equal(fs.existsSync(path.join(f.storage, "next-local-environments")), false);
  mcpAllowed = false;
  await hostSession.revokeScope("mcp");
  assert.equal(mcpSignal.aborted, true);
  assert.throws(() => hostSession.assertCurrent("mcp"), /scope|unavailable/);
  assert.equal((await adapter.handleMessage({ command: "envList" })).data.length, 2);
  environmentAllowed = false;
  await assert.rejects(adapter.handleMessage({ command: "envList" }), /scope revoked/);
  environmentAllowed = true;
  const scopePending = adapter.handleMessage({ command: "envList" });
  const scopeClosed = hostSession.revokeScope("environment");
  await assert.rejects(scopePending, /closed|unavailable|revoked/); await scopeClosed;
  assert.equal(environmentSignal.aborted, true);
  adoption.storage.assertWorkspaceLease();
  connection.abort(); await hostSession.revoke();
  assert.throws(() => hostSession.assertCurrent("environment"), /unavailable/);
  const replacementConnection = new AbortController();
  const connected = sessions.open({ hostKey: "isolated-env-ui", connection: replacementConnection.signal,
    assertHostCurrent() {}, assertScopeCurrent() {}, onCloseError: error => closeErrors.push(error) });
  await assert.rejects(adapter.handleMessage({ command: "envList" }), /closed/);
  const rebound = attach({ owner, hostSession: connected, authority: { workspaceId: owner.workspaceId,
    actorId: "local:owner", knowledgeRoot: f.knowledgeRoot, globalStorageDirectory: f.storage,
    scope: "ordinary-environments:read-cache", signal: new AbortController().signal, assertCurrent() {} },
    onCloseError: error => closeErrors.push(error) });
  t.after(() => rebound.close());
  const disconnectPending = rebound.handleMessage({ command: "envList" });
  replacementConnection.abort();
  await assert.rejects(disconnectPending, /closed|unavailable/); await connected.revoke();
  const finalSession = sessions.open({ hostKey: "isolated-env-ui", connection: new AbortController().signal,
    assertHostCurrent() {}, assertScopeCurrent() {}, onCloseError: error => closeErrors.push(error) });
  const finalAdapter = attach({ owner, hostSession: finalSession, authority: { workspaceId: owner.workspaceId,
    actorId: "local:owner", knowledgeRoot: f.knowledgeRoot, globalStorageDirectory: f.storage,
    scope: "ordinary-environments:read-cache", signal: new AbortController().signal, assertCurrent() {} },
    onCloseError: error => closeErrors.push(error) });
  t.after(() => finalAdapter.close());
  const pending = finalAdapter.handleMessage({ command: "envList" }), closed = unified.managed.close();
  await assert.rejects(pending, /closed|admission/); await closed;
  await assert.rejects(adapter.handleMessage({ command: "envList" }), /closed/);
  await assert.rejects(rebound.handleMessage({ command: "envList" }), /closed/);
  assert.deepEqual(closeErrors, []);
  console.log("PASS experimental adopted native owner + independent profile authority + ordinary cached Environments UI; not production activation/Code/real conda.");
});

test("ordinary owner Refresh uses finite intent grants and real workflows; concurrent revoke/drain, unknown cleanup and restart never replay or overwrite", { timeout: 120000 }, async t => {
  const load = name => import(pathToFileURL(path.join(nextDist, `${name}.js`)).href);
  const { adoptLegacyRootInPlaceExperimental, resumeLegacyRootAdoptionExperimental } = await load("legacy-root-adoption");
  const { startAdoptedRootUnifiedHost } = await load("managed-client-host");
  const { createOwnerHostSessions } = await load("owner-host-sessions");
  const root = path.resolve(".migration-test-work", `ordinary-refresh-native-${randomUUID()}`), f = await prepare(root);
  const python = process.env.PKM_BROWSER_PYTHON;
  assert(python && path.isAbsolute(python), "Existing native Python/Chromium required.");
  let adoption, unified, session, adapter, owner, verifyFailure = false, writer = Promise.resolve();
  const ledger = [], claimed = new Set(), closeErrors = [];
  t.after(async () => { verifyFailure = false; if (unified) await unified.managed.close(); else if (adoption) await adoption.storage.close();
    fs.rmSync(root, { recursive: true, force: true }); });
  fs.renameSync(path.join(f.knowledgeRoot, "untouched-root.txt"), path.join(root, "offline-root-placeholder.txt"));
  fs.mkdirSync(path.join(f.knowledgeRoot, "notes"));
  fs.writeFileSync(path.join(f.knowledgeRoot, "notes", "Existing.md"), "---\ntitle: Existing\nrevision: 1\n---\nIsolated.\n");
  const config = path.join(root, "host.json"), endpoint = "http://127.0.0.1:9/v1";
  fs.writeFileSync(config, JSON.stringify({ schema: "pkm.native-host-config/v1", provider: "openai-compatible", endpoint,
    secretRef: "secret:fixture/model", model: "fixture", contextWindow: 16384, maxOutputTokens: 4096,
    outputTokenParameter: "max_tokens", includeUsage: true, tools: ["knowledge.document.list"] }), { mode: 0o600 });
  const openAdapter = () => attach({ owner, hostSession: session, authority: { workspaceId: owner.workspaceId,
    actorId: "local:owner", knowledgeRoot: f.knowledgeRoot, globalStorageDirectory: f.storage,
    scope: "ordinary-environments:read-cache", signal: new AbortController().signal, assertCurrent() {} },
    onCloseError: error => closeErrors.push(error) });
  async function start(restarting = false) {
    adoption = await (restarting ? resumeLegacyRootAdoptionExperimental : adoptLegacyRootInPlaceExperimental)(f.knowledgeRoot, {});
    unified = await startAdoptedRootUnifiedHost({ optIn: true, dataPath: f.knowledgeRoot, configPath: config,
      expectedWorkspaceId: adoption.workspaceId, policy: { authorizedConfigPath: config, allowedProviders: ["openai-compatible"],
        allowedEndpoints: [endpoint], allowedModels: ["fixture"], allowedTools: ["knowledge.document.list"],
        allowInsecureLoopback: true }, resolveSecret: async () => "fixture" }, adoption);
    owner = unified.ownerResourceContext();
    session = createOwnerHostSessions(owner, owner.workspaceId).open({ hostKey: "owned-refresh-ui",
      connection: new AbortController().signal, assertHostCurrent() {}, assertScopeCurrent() {},
      onCloseError: error => closeErrors.push(error) });
    adapter = openAdapter();
  }
  await start();
  function permitFor(message) {
    const rows = JSON.parse(fs.readFileSync(f.registry)), boundSession = session, signal = new AbortController();
    const intent = { requestId: randomUUID(), workspaceId: owner.workspaceId, actorId: "local:owner",
      knowledgeRoot: f.knowledgeRoot, globalStorageDirectory: f.storage, operation: message.command === "envList" ? "metadata" : "packages",
      refresh: !!message.refresh, environments: (message.command === "envList" ? rows : rows.filter(row => row.id === message.id))
        .map(({ id, path, python, manager }) => ({ id, path, python, manager })) };
    const permit = {
      intent, signal: signal.signal, expiresAtMs: Date.now() + 30000,
      environment: { PATH: f.hostBin, HOME: root, TMPDIR: root, PIP_CONFIG_FILE: "/dev/null", PIP_CACHE_DIR: path.join(root, "pip-cache") },
      claim(actual) { assert.deepEqual(actual, intent); assert(!claimed.has(intent.requestId));
        boundSession.assertCurrent("environment"); claimed.add(intent.requestId); ledger.push({ request: intent }); },
      assertCurrent(effect, id, kind) { boundSession.assertCurrent("environment");
        assert(intent.environments.some(entry => entry.id === id)); ledger.push({ effect, id, kind }); },
      assertProfileWriter() { boundSession.assertCurrent("environment"); assert.equal(fs.realpathSync(f.storage), f.storage); },
      assertExecution(trace) {
        boundSession.assertCurrent("environment");
        assert([f.tool, path.join(f.venv, "bin/python"), path.join(f.prefix, "bin/python"), "du"].includes(trace.program));
        const target = intent.environments.find(entry => entry.id === trace.environmentId); assert(target);
        if (trace.kind === "packages") assert.deepEqual(trace.args, target.manager === "conda"
          ? ["list", "--json", "-p", target.path] : ["-m", "pip", "list", "--format=json"]);
        if (trace.kind === "size") assert.deepEqual(trace.args, ["-sk", target.path]);
      },
      recordExecution(child, trace) { ledger.push({ started: trace, pid: child.pid }); },
      async verifyDrained(child, trace) {
        if (verifyFailure) throw Error("fixture verifier deliberately cannot confirm drain");
        assert(child.exitCode !== null || child.signalCode !== null, "The real execFile child must finish before owner drain");
        ledger.push({ drained: trace, pid: child.pid });
      },
      async withProfileWrite(id, kind, write) {
        const previous = writer; let release;
        writer = new Promise(resolve => { release = resolve; });
        await previous;
        try { boundSession.assertCurrent("environment"); write(); ledger.push({ committed: id, kind }); }
        finally { release(); }
      },
    };
    return { permit, signal };
  }
  const packagesMessage = id => ({ command: "envPackages", id, refresh: true });
  const metadataMessage = { command: "envList", refresh: true };
  const initialRows = JSON.parse(fs.readFileSync(f.registry));
  fs.writeFileSync(f.registry, JSON.stringify(initialRows.map(row => ({ ...row, pyVersion: "0.0", sizeBytes: 0, sizeAt: "old" }))));
  fs.writeFileSync(path.join(f.prefix, "conda-meta/fixture.json"), JSON.stringify({ name: "retained_fixture", version: "2.0" }));
  const served = [], token = randomUUID(), html = ordinaryHtml();
  const server = http.createServer(async (req, res) => {
    try {
      assert(req.url.startsWith(`/${token}`));
      if (req.url.endsWith("/message")) {
        let body = ""; for await (const chunk of req) body += chunk;
        const message = JSON.parse(body); served.push(message);
        const grant = message.refresh || message.command === "envPackages" ? permitFor(message).permit : undefined;
        res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(await adapter.handleMessage(message, grant)));
      } else { res.setHeader("Content-Type", "text/html"); res.end(html); }
    } catch (error) { res.statusCode = 500; res.end(String(error)); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const runtime = path.join(root, "browser"); fs.mkdirSync(runtime);
  const chromium = execFileSync(python, ["-I", "-B", "-c",
    "from playwright.sync_api import sync_playwright\nwith sync_playwright() as p: print(p.chromium.executable_path)"],
  { encoding: "utf8", env: { ...process.env, TMPDIR: runtime } }).trim();
  assert(fs.existsSync(chromium));
  await promisify(execFile)(python, ["-I", "-B", path.resolve("tests/ordinary_environment_owner_ui.py"),
    "--base", `http://127.0.0.1:${server.address().port}/${token}`, "--chromium", chromium,
    "--helper", path.resolve("tests/ordinary_environment_profile_ui.py"), "--id", f.id, "--venv-id", f.venvId, "--refresh-owner"],
  { cwd: runtime, env: { ...process.env, TMPDIR: ".", HOME: root, XDG_CONFIG_HOME: path.join(runtime, "config"),
    XDG_CACHE_HOME: path.join(runtime, "cache"), PYTHONDONTWRITEBYTECODE: "1" }, timeout: 40000 });
  assert(served.some(message => message.command === "envList" && message.refresh));
  assert(JSON.parse(fs.readFileSync(f.registry)).every(row => row.pyVersion === "3.8.10" && row.sizeBytes > 0 && row.sizeAt !== "old"));
  assert(JSON.parse(fs.readFileSync(f.cache)).packages.some(pkg => pkg.name === "retained_fixture" && pkg.version === "2.0"));
  const success = permitFor(packagesMessage(f.id)).permit;
  assert.equal((await adapter.handleMessage(packagesMessage(f.id), success)).error, undefined);
  const executions = () => ledger.filter(row => row.started).length;
  const count = executions();
  await assert.rejects(adapter.handleMessage(packagesMessage(f.id), success), /consumed/);
  const expired = permitFor(packagesMessage(f.id)).permit; expired.expiresAtMs = Date.now() - 1;
  await assert.rejects(adapter.handleMessage(packagesMessage(f.id), expired), /finite deadline/);
  const wrong = permitFor(packagesMessage(f.id)).permit;
  await assert.rejects(adapter.handleMessage(packagesMessage(f.venvId), wrong), /exact profile/);
  assert.equal(executions(), count);
  fs.unlinkSync(f.cache);
  const uncached = { command: "envPackages", id: f.id, refresh: false };
  const captured = await adapter.handleMessage(uncached, permitFor(uncached).permit);
  assert.equal(captured.error, undefined); assert.equal(captured.cached, false);
  const cachedCount = executions();
  assert.equal((await adapter.handleMessage(uncached)).cached, true);
  assert.equal(executions(), cachedCount);
  const registryBeforeBinding = fs.readFileSync(f.registry), cacheBeforeBinding = fs.readFileSync(f.cache);
  const reboundPermit = permitFor(packagesMessage(f.id)).permit, beforeRebound = executions();
  const normalFence = reboundPermit.assertCurrent;
  reboundPermit.assertCurrent = (effect, id, kind) => {
    normalFence(effect, id, kind);
    if (effect === "probe") fs.writeFileSync(f.registry, JSON.stringify(JSON.parse(registryBeforeBinding)
      .map(row => row.id === f.id ? { ...row, path: f.venv } : row)));
  };
  try {
    const rebound = await adapter.handleMessage(packagesMessage(f.id), reboundPermit);
    assert.match(rebound.error, /target binding changed/);
    assert.equal(executions(), beforeRebound); assert.deepEqual(fs.readFileSync(f.cache), cacheBeforeBinding);
  } finally { fs.writeFileSync(f.registry, registryBeforeBinding); }
  const conflicting = permitFor(packagesMessage(f.id)).permit, normalWriter = conflicting.assertProfileWriter;
  let writerChecks = 0;
  const outsideCache = Buffer.from(JSON.stringify({ capturedAt: "outside", packages: [{ name: "external", version: "7" }] }));
  conflicting.assertProfileWriter = () => {
    normalWriter();
    if (++writerChecks === 3) fs.writeFileSync(f.cache, outsideCache);
  };
  const conflict = await adapter.handleMessage(packagesMessage(f.id), conflicting);
  assert.match(conflict.error, /changed before Refresh commit; no overwrite/);
  assert.deepEqual(fs.readFileSync(f.cache), outsideCache);
  assert(!fs.readdirSync(path.dirname(f.cache)).some(name => name.startsWith(".refresh-")));
  fs.writeFileSync(f.cache, cacheBeforeBinding);
  fs.chmodSync(f.cache, 0o400);
  try {
    const cacheDenied = await adapter.handleMessage(packagesMessage(f.id), permitFor(packagesMessage(f.id)).permit);
    assert.match(cacheDenied.error, /EACCES/); assert(cacheDenied.error.includes(f.cache));
    assert.deepEqual(fs.readFileSync(f.cache), cacheBeforeBinding);
  } finally { fs.chmodSync(f.cache, 0o600); }
  const cacheBytes = fs.readFileSync(f.cache);
  fs.chmodSync(f.tool, 0o600);
  try {
    const denied = await adapter.handleMessage(packagesMessage(f.id), permitFor(packagesMessage(f.id)).permit);
    assert.match(denied.error, /EACCES/); assert(denied.error.includes(f.tool)); assert.deepEqual(fs.readFileSync(f.cache), cacheBytes);
  } finally { fs.chmodSync(f.tool, 0o700); }
  verifyFailure = true;
  const unknown = await adapter.handleMessage(packagesMessage(f.id), permitFor(packagesMessage(f.id)).permit);
  assert.match(unknown.error, /drain is unknown; no replay/); assert.deepEqual(fs.readFileSync(f.cache), cacheBytes);
  await assert.rejects(adapter.close(), /cannot confirm drain/);
  adoption.storage.assertWorkspaceLease();
  const beforeRetry = executions(); verifyFailure = false; await adapter.close(); assert.equal(executions(), beforeRetry);
  adapter = openAdapter();
  const hold = path.join(root, "hold-query"), started = path.join(root, "query-started"), originalTool = fs.readFileSync(f.tool);
  fs.writeFileSync(hold, "hold");
  fs.writeFileSync(f.tool, `#!/bin/bash\nprintf started > ${JSON.stringify(started)}\nwhile [ -e ${JSON.stringify(hold)} ]; do /bin/sleep 0.02; done\n${originalTool.toString().split("\n").slice(1).join("\n")}`);
  const canceled = permitFor(packagesMessage(f.id)), cacheBeforeRevoke = fs.readFileSync(f.cache);
  const pending = adapter.handleMessage(packagesMessage(f.id), canceled.permit);
  const until = async check => { for (let i = 0; i < 400; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 20)); } throw Error("Fixture query did not start"); };
  await until(() => fs.existsSync(started));
  const otherProfile = path.join(root, "unrelated-profile"); fs.mkdirSync(otherProfile);
  fs.writeFileSync(path.join(otherProfile, "registry.json"), "[]");
  require(path.join(build, "servers/pyenvs.js")).initPyenvs(otherProfile);
  const concurrent = await Promise.all([
    adapter.handleMessage(metadataMessage, permitFor(metadataMessage).permit),
    adapter.handleMessage(packagesMessage(f.venvId), permitFor(packagesMessage(f.venvId)).permit),
  ]);
  assert.deepEqual(concurrent[0].refreshErrors, []); assert(concurrent[1].packages.some(pkg => pkg.name === "pip"));
  assert.equal(fs.readFileSync(path.join(otherProfile, "registry.json"), "utf8"), "[]");
  canceled.signal.abort();
  let closed = false; const closing = unified.managed.close().then(() => { closed = true; });
  await new Promise(resolve => setTimeout(resolve, 100)); assert.equal(closed, false, "Owner cannot drain an active real query");
  assert.deepEqual(fs.readFileSync(f.cache), cacheBeforeRevoke);
  fs.unlinkSync(hold);
  await assert.rejects(pending, /closed|admission/); await closing;
  assert.deepEqual(fs.readFileSync(f.cache), cacheBeforeRevoke);
  fs.writeFileSync(f.tool, originalTool);
  const workspaceId = owner.workspaceId; await start(true); assert.equal(owner.workspaceId, workspaceId);
  assert.equal((await adapter.handleMessage({ command: "envPackages", id: f.id })).cached, true);
  const afterRestart = await adapter.handleMessage(packagesMessage(f.id), permitFor(packagesMessage(f.id)).permit);
  assert.equal(afterRestart.error, undefined); assert(afterRestart.packages.some(pkg => pkg.version === "2.0"));
  assert.deepEqual((await adapter.handleMessage(metadataMessage, permitFor(metadataMessage).permit)).refreshErrors, []);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.registry)).map(({ id, path, python, manager, customReference }) =>
    ({ id, path, python, manager, customReference })), initialRows.map(({ id, path, python, manager, customReference }) =>
    ({ id, path, python, manager, customReference })));
  assert.equal(fs.existsSync(path.join(f.storage, "next-local-environments")), false);
  assert.deepEqual(closeErrors, []);
  console.log("PASS real UI/venv/controlled-conda Refresh + finite synthetic intent grants + actual owner concurrent drain/restart; production issuer remains unqualified.");
});
