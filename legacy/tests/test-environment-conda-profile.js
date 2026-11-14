const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const { execFileSync } = require("node:child_process"), { randomUUID } = require("node:crypto");
const build = process.env.PKM_ENV_AUTHORITY_BUILD;
if (!build || !path.isAbsolute(build)) throw Error("Set absolute PKM_ENV_AUTHORITY_BUILD; isolated profile only.");
const current = require(path.join(build, "servers/pyenvs.js"));
const { upgradeLocalEnvironmentProfile } = require(path.join(build, "runtime/local-environment-upgrade.js"));

function fixture(t) {
  const root = path.resolve("tests", `.ordinary-conda-profile-${randomUUID()}`);
  fs.mkdirSync(root, { mode: 0o700 });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const base = path.join(root, "installed conda"), prefix = path.join(base, "envs", "original env");
  execFileSync("/usr/bin/python3", ["-I", "-B", "-m", "venv", "--without-pip", prefix], { env: { HOME: root, TMPDIR: root } });
  const meta = path.join(prefix, "conda-meta");
  fs.mkdirSync(meta); fs.writeFileSync(path.join(meta, "fixture.json"), JSON.stringify({ name: "retained_fixture", version: "1.0" }));
  const calls = path.join(root, "manager-calls"), tool = path.join(base, "bin", "conda");
  fs.mkdirSync(path.dirname(tool), { recursive: true });
  fs.writeFileSync(tool, `#!/bin/bash
set -eu
[ "$#" = 4 ] && [ "$1" = list ] && [ "$2" = --json ] && [ "$3" = -p ] && [ "$4" = ${quote(prefix)} ]
printf '%s\\n' "$4" >> ${quote(calls)}
exec /usr/bin/python3 -I -B -c 'import json,os,sys;print(json.dumps([json.load(open(os.path.join(sys.argv[1],"conda-meta",n))) for n in os.listdir(os.path.join(sys.argv[1],"conda-meta")) if n.endswith(".json")]))' "$4"
`, { mode: 0o700 });
  const oldFile = path.join(root, "old-pyenvs.cjs");
  fs.writeFileSync(oldFile, execFileSync("unzip", ["-p", path.resolve("personal-knowledge-4.0.22.vsix"), "extension/dist/servers/pyenvs.js"]));
  const old = require(oldFile), source = path.join(root, "old-globalStorage");
  old.initPyenvs(path.join(source, "environments"));
  const entry = old.pyenvAdd({ name: "Retained conda", manager: "conda", path: prefix, python: path.join(prefix, "bin/python") });
  const registry = path.join(source, "environments", "registry.json");
  const data = JSON.parse(fs.readFileSync(registry)); data[0].customReference = { workflow: "preserve-original-id" };
  fs.writeFileSync(registry, JSON.stringify(data));
  const storage = path.join(root, "active-globalStorage");
  fs.cpSync(source, storage, { recursive: true });
  const activeRegistry = path.join(storage, "environments", "registry.json");
  const before = fs.readFileSync(activeRegistry, "utf8");
  // This is the existing production initialization expression, not the Next import path.
  const host = fs.readFileSync(path.resolve("src/extension.ts"), "utf8");
  assert(host.includes('initPyenvs(path.join(stateBase, "environments"),'));
  current.initPyenvs(path.join(storage, "environments"));
  const emptyPath = path.join(root, "empty-path"); fs.mkdirSync(emptyPath);
  return { root, base, prefix, calls, tool, old, entry, storage, activeRegistry, before, emptyPath };
}
const quote = value => `'${value.replace(/'/g, "'\\''")}'`;
async function withPath(value, task) {
  const original = process.env.PATH;
  process.env.PATH = value;
  try { return await task(); } finally { if (original === undefined) delete process.env.PATH; else process.env.PATH = original; }
}
function bridge() {
  const source = fs.readFileSync(path.resolve("src/extension.ts"), "utf8");
  const begin = source.indexOf('    case "envPackages": {'), end = source.indexOf('    case "envCompare": {', begin);
  assert(begin > 0 && end > begin);
  return vm.runInNewContext(`(async function(msg, pyenvPackages, respond) { switch(msg.command) { ${source.slice(begin, end)} } })`);
}
function ui() {
  const output = { innerHTML: "" }, requests = [];
  const context = vm.createContext({ document: { getElementById: id => id === "env-out" ? output : undefined },
    ask: (command, data) => requests.push({ command, ...data }), esc: value => String(value), uiIcon: () => "",
    helpText: en => en, problemGuidanceHtml: text => text });
  vm.runInContext(fs.readFileSync(path.resolve("src/webview/panel/30-environments.js"), "utf8"), context);
  const core = fs.readFileSync(path.resolve("src/webview/panel/00-core.js"), "utf8");
  const route = core.match(/else if \(command === 'envPackages'\) \{([^}]+)\}/);
  assert(route);
  vm.runInContext(`function deliver(e) { const command=e.data.command; if(command==='envPackages') { ${route[1]} } }`, context);
  return { context, requests, output };
}

test("ordinary legacy UI/host reuses a real 4.0.22 registry with Next disabled and finds a controlled associated conda manager absent from PATH", async t => {
  const f = fixture(t), page = ui(), dispatch = bridge();
  assert.equal(upgradeLocalEnvironmentProfile(f.storage, false, true).state, "disabled");
  assert(!fs.existsSync(path.join(f.storage, "next-local-environments")));
  assert.equal(current.pyenvList()[0].customReference.workflow, "preserve-original-id");
  await withPath(f.emptyPath, async () => {
    const oldResult = await f.old.pyenvPackages(f.entry.id, true);
    assert.match(oldResult.error, /ENOENT/);
    page.context.id = f.entry.id;
    vm.runInContext("viewEnvPackages(id,false)", page.context);
    const request = page.requests.shift(), messages = [];
    await dispatch(request, current.pyenvPackages, message => messages.push(message));
    assert.equal(messages[0].error, undefined);
    assert.equal(messages[0].id, f.entry.id); assert.equal(messages[0].cached, false);
    page.context.message = messages[0]; vm.runInContext("deliver({data:message})", page.context);
    assert.match(page.output.innerHTML, /retained_fixture/); assert.match(page.output.innerHTML, /1\.0/);
    const count = fs.readFileSync(f.calls, "utf8");
    vm.runInContext("viewEnvPackages(id,false)", page.context);
    await dispatch(page.requests.shift(), current.pyenvPackages, message => { assert.equal(message.cached, true); });
    assert.equal(fs.readFileSync(f.calls, "utf8"), count);
    vm.runInContext("viewEnvPackages(id,true)", page.context);
    await dispatch(page.requests.shift(), current.pyenvPackages, message => { assert.equal(message.cached, false); });
    assert.equal(fs.readFileSync(f.calls, "utf8").trim().split("\n").length, 2);
    const alternate = path.join(f.base, "condabin", "conda");
    fs.mkdirSync(path.dirname(alternate)); fs.renameSync(f.tool, alternate);
    vm.runInContext("viewEnvPackages(id,true)", page.context);
    await dispatch(page.requests.shift(), current.pyenvPackages, message => {
      assert.equal(message.error, undefined); assert.equal(message.cached, false);
    });
    assert.equal(fs.readFileSync(f.calls, "utf8").trim().split("\n").length, 3);
  });
  assert.equal(fs.readFileSync(f.activeRegistry, "utf8"), f.before);
  assert(!fs.existsSync(path.join(f.storage, "next-local-environments")));
});

test("ordinary conda query preserves PATH-manager precedence and reports its failure without trying another installation", async t => {
  const f = fixture(t), bin = path.join(f.root, "path-bin"); fs.mkdirSync(bin);
  const tool = path.join(bin, "conda");
  fs.writeFileSync(tool, "#!/bin/bash\nprintf '[{\"name\":\"path_manager\",\"version\":\"2.0\"}]'\n", { mode: 0o700 });
  await withPath(bin, async () => {
    const old = await f.old.pyenvPackages(f.entry.id, true), next = await current.pyenvPackages(f.entry.id, true);
    assert.deepEqual(next.packages, old.packages); assert(!fs.existsSync(f.calls));
    fs.writeFileSync(tool, "#!/bin/bash\nexit 23\n", { mode: 0o700 });
    const failed = await current.pyenvPackages(f.entry.id, true);
    assert.match(failed.error, /conda list failed/); assert(!fs.existsSync(f.calls));
    const cached = await current.pyenvPackages(f.entry.id, false);
    assert.equal(cached.cached, true); assert.equal(cached.packages[0].name, "path_manager");
    fs.chmodSync(tool, 0o600);
    const denied = await current.pyenvPackages(f.entry.id, true);
    assert.match(denied.error, /EACCES/); assert(!fs.existsSync(f.calls));
    fs.unlinkSync(tool); fs.symlinkSync(path.join(bin, "missing-manager"), tool);
    const brokenLink = await current.pyenvPackages(f.entry.id, true);
    assert.match(brokenLink.error, /ENOENT/); assert(!fs.existsSync(f.calls));
  });
  assert.equal(fs.readFileSync(f.activeRegistry, "utf8"), f.before);
});

test("missing associated manager stays an ordinary diagnostic failure, with no download, registration change or Next import", async t => {
  const f = fixture(t); fs.renameSync(f.tool, `${f.tool}.unavailable`);
  await withPath(f.emptyPath, async () => {
    const failed = await current.pyenvPackages(f.entry.id, true);
    assert.match(failed.error, /ENOENT/); assert(!fs.existsSync(f.calls));
  });
  assert.equal(fs.readFileSync(f.activeRegistry, "utf8"), f.before);
  assert(!fs.existsSync(path.join(f.storage, "next-local-environments")));
});

test("associated conda permission and non-missing errors reach ordinary Packages UI without overwriting cache or trying another manager", async t => {
  const f = fixture(t), page = ui(), dispatch = bridge();
  await withPath(f.emptyPath, async () => {
    await current.pyenvPackages(f.entry.id, true);
    const cache = path.join(f.storage, "environments", `${f.entry.id}.packages.json`);
    const beforeCache = fs.readFileSync(cache, "utf8"), beforeCalls = fs.readFileSync(f.calls, "utf8");
    page.context.id = f.entry.id;
    async function failure(code) {
      vm.runInContext("viewEnvPackages(id,true)", page.context);
      await dispatch(page.requests.shift(), current.pyenvPackages, message => {
        assert.match(message.error, new RegExp(code));
        assert(message.error.includes(f.tool));
        page.context.message = message;
        vm.runInContext("deliver({data:message})", page.context);
      });
      assert.match(page.output.innerHTML, new RegExp(code));
      assert.equal(fs.readFileSync(cache, "utf8"), beforeCache);
      assert.equal(fs.readFileSync(f.calls, "utf8"), beforeCalls);
      assert.equal((await current.pyenvPackages(f.entry.id, false)).cached, true);
    }
    fs.chmodSync(f.tool, 0o600);
    try { await failure("EACCES"); } finally { fs.chmodSync(f.tool, 0o700); }
    const alternate = path.join(f.base, "condabin", "conda");
    fs.mkdirSync(path.dirname(alternate)); fs.copyFileSync(f.tool, alternate);
    if (process.getuid() !== 0) {
      fs.chmodSync(path.dirname(f.tool), 0);
      try { await failure("EACCES"); } finally { fs.chmodSync(path.dirname(f.tool), 0o700); }
    }
    fs.unlinkSync(f.tool); fs.symlinkSync(f.tool, f.tool);
    try { await failure("ELOOP"); } finally {
      fs.unlinkSync(f.tool); fs.copyFileSync(alternate, f.tool);
    }
    const bin = path.dirname(f.tool), savedBin = `${bin}.saved`;
    fs.renameSync(bin, savedBin); fs.writeFileSync(bin, "not a directory");
    try { await failure("ENOTDIR"); } finally {
      fs.unlinkSync(bin); fs.renameSync(savedBin, bin);
    }
    fs.renameSync(f.tool, `${f.tool}.saved`); fs.mkdirSync(f.tool);
    try { await failure("not a regular file"); } finally {
      fs.rmdirSync(f.tool); fs.renameSync(`${f.tool}.saved`, f.tool);
    }
    fs.renameSync(f.tool, `${f.tool}.saved`);
    fs.symlinkSync(path.join(bin, "missing-manager"), f.tool);
    try { await failure("ENOENT"); } finally {
      fs.unlinkSync(f.tool); fs.renameSync(`${f.tool}.saved`, f.tool);
    }
    const repaired = await current.pyenvPackages(f.entry.id, true);
    assert.equal(repaired.error, undefined); assert.equal(repaired.packages[0].name, "retained_fixture");
  });
  assert.equal(fs.readFileSync(f.activeRegistry, "utf8"), f.before);
});

test("ordinary old-profile conda prefix symlink remains registered verbatim while Packages finds its physical installation outside PATH", async t => {
  const f = fixture(t), page = ui(), dispatch = bridge();
  const alias = path.join(f.root, "original profile alias");
  fs.symlinkSync(f.prefix, alias, "dir");
  fs.writeFileSync(f.tool, fs.readFileSync(f.tool, "utf8").replace(quote(f.prefix), quote(alias)), { mode: 0o700 });
  f.old.pyenvUpdate(f.entry.id, { path: alias, python: path.join(alias, "bin/python") });
  await withPath(path.dirname(f.tool), async () => {
    const old = await f.old.pyenvPackages(f.entry.id, true);
    assert.equal(old.error, undefined); assert.equal(old.packages[0].name, "retained_fixture");
  });
  fs.copyFileSync(path.join(f.root, "old-globalStorage/environments/registry.json"), f.activeRegistry);
  const before = fs.readFileSync(f.activeRegistry, "utf8");
  await withPath(f.emptyPath, async () => {
    page.context.id = f.entry.id;
    vm.runInContext("viewEnvPackages(id,true)", page.context);
    await dispatch(page.requests.shift(), current.pyenvPackages, message => {
      assert.equal(message.error, undefined); assert.equal(message.packages[0].name, "retained_fixture");
      page.context.message = message; vm.runInContext("deliver({data:message})", page.context);
    });
    assert.match(page.output.innerHTML, /retained_fixture/);
  });
  assert.equal(current.pyenvGet(f.entry.id).path, alias);
  assert.equal(fs.readFileSync(f.activeRegistry, "utf8"), before);
  assert(!fs.existsSync(path.join(f.storage, "next-local-environments")));
});
