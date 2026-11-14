const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm"), http = require("node:http");
const { execFileSync, execFile } = require("node:child_process"), { promisify } = require("node:util");
const { randomUUID } = require("node:crypto"), ts = require("typescript");
const { prepare, digest } = require("./helpers/ordinary-environment-profile-fixture");
const build = process.env.PKM_ENV_AUTHORITY_BUILD, python = process.env.PKM_BROWSER_PYTHON;
assert(build && path.isAbsolute(build) && python && path.isAbsolute(python),
  "Explicit isolated source build and existing native Python Playwright interpreter required.");
const current = require(path.join(build, "servers/pyenvs.js"));
const source = fs.readFileSync("src/extension.ts", "utf8");
const oldSource = execFileSync("unzip", ["-p", "personal-knowledge-4.0.22.vsix", "extension/dist/extension.js"], { encoding: "utf8", maxBuffer: 20 << 20 });
const readUi = (stage, file) => stage === "old"
  ? execFileSync("unzip", ["-p", "personal-knowledge-4.0.22.vsix", `extension/src/webview/panel/${file}`], { encoding: "utf8" })
  : fs.readFileSync(path.join("src/webview/panel", file), "utf8");
function functions(text, names) {
  const tree = ts.createSourceFile("fixture.ts", text, ts.ScriptTarget.Latest, true);
  return names.map(name => {
    const node = tree.statements.find(item => ts.isFunctionDeclaration(item) && item.name?.text === name);
    assert(node, `Actual function ${name} required`); return node.getText(tree);
  }).join("\n");
}
function host(stage, f) {
  const text = stage === "old" ? oldSource.replace(/pyenvs_1\./g, "").replace(/\(0, (\w+)\)/g, "$1") : source;
  const context = vm.createContext({ fs, path, log: { warn() {} }, pyenvsRoot: () => path.join(f.root, "managed-files"),
    managedMcpRuntimePath: () => path.join(f.root, "unused-mcp"), environmentProbeErrors: new Map(), environmentSizeProbeErrors: new Map(),
    mcp_1: { managedMcpRuntimePath: () => path.join(f.root, "unused-mcp") },
    _sizeSweeping: false, _verSweeping: false, ...(stage === "old" ? f.old : current) });
  vm.runInContext(ts.transpileModule(functions(text, ["envListForUi", "refreshEnvironmentVersion", "refreshEnvironmentSize",
    "sweepEnvVersions", "sweepEnvSizes"]), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
  if (stage === "current") {
    const expression = source.match(/const stateBase = context\.globalStorageUri\.fsPath;\s*(initPyenvs\(path\.join\(stateBase, "environments"\), [^\n]+\);)/);
    assert(expression, "Actual ordinary initialization required");
    vm.runInContext(`const context={globalStorageUri:{fsPath:${JSON.stringify(f.storage)}}};const stateBase=context.globalStorageUri.fsPath;${expression[1]}`,
      vm.createContext({ path, initPyenvs: current.initPyenvs, log: { info() {} } }));
  }
  const start = text.indexOf('case "envList":'), end = text.indexOf('case "envCompare":', start);
  assert(start > 0 && end > start);
  const cases = text.slice(start, end);
  return vm.runInContext(ts.transpileModule(`(async function(msg,respond){switch(msg.command){${cases}}})`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
}
function html(stage) {
  const core = readUi(stage, "00-core.js");
  const begin = core.indexOf("else if (command === 'envList')"), end = core.indexOf("else if (command === 'envCompare')", begin);
  assert(begin > 0 && end > begin);
  const initial = readUi(stage, "60-init.js").match(/else if \(state\.tab === 'environments'\) (ask\('envList', \{\}\);)/);
  assert(initial, "Actual ordinary initial UI request required");
  return `<html><body><div id="detail"></div><script>
const state={tab:'environments'}, catExpanded={}, githubSyncTypes=[];
const esc=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const uiIcon=(icon,label='')=>'<span>'+esc(label)+'</span>', helpText=en=>en;
const privacyInherited=()=>false, privacyLock=()=>'', folkDisplayName=esc, brokerFolderMarker=()=>'';
const problemGuidanceHtml=(message,next,actions)=>'<div role="alert">'+esc(message)+next+actions+'</div>';
window.__messages=[];
function deliver(e){const command=e.data.command,data=e.data.data; if(false){} ${core.slice(begin, end)} }
function ask(command,data){fetch(location.pathname+'/message',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({command,...data})})
.then(async r=>{if(!r.ok)throw Error(await r.text());return r.json();}).then(messages=>messages.forEach(message=>{window.__messages.push(message);deliver({data:message});})).catch(error=>{throw error;});}
${functions(readUi(stage, "20-knowledge.js"), ["buildCatTree", "countTreeLeaves", "expandedCategoryKey", "renderCatTree", "toggleCat"])}
${readUi(stage, "30-environments.js")}
${initial[1]}
</script></body></html>`;
}
test("same original profile/Root: actual old registry, ordinary List/card clicks, retained cache, package Refresh and permission errors across old/current UI stages", async t => {
  const root = path.resolve(".migration-test-work", `ordinary-env-ui-${randomUUID()}`);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const f = await prepare(root), hosts = { old: host("old", f), current: host("current", f) };
  const pages = { old: html("old"), current: html("current") };
  const safeEnv = { PATH: f.hostBin, HOME: root, TMPDIR: root, PYTHONDONTWRITEBYTECODE: "1", PIP_CONFIG_FILE: "/dev/null",
    PIP_NO_INDEX: "1", PIP_DISABLE_PIP_VERSION_CHECK: "1", PIP_LIST_OUTDATED: "0", PIP_LIST_UPTODATE: "0", PIP_CACHE_DIR: path.join(root, "pip-cache") };
  const originalEnv = Object.fromEntries(Object.keys(safeEnv).map(key => [key, process.env[key]]));
  Object.assign(process.env, safeEnv);
  t.after(() => { for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  } });
  const token = randomUUID();
  const state = () => ({ calls: fs.readFileSync(f.calls, "utf8").trim().split("\n").length,
    cacheSha256: digest(fs.readFileSync(f.cache)), registry: JSON.parse(fs.readFileSync(f.registry)), nextCatalog: fs.existsSync(path.join(f.storage, "next-local-environments")) });
  const server = http.createServer(async (req, res) => {
    try {
      assert(req.url.startsWith(`/${token}/`), "Private fixture route only");
      let body = ""; for await (const chunk of req) body += chunk;
      const route = req.url.slice(token.length + 2), parts = route.split("/");
      if (route === "fixture") {
        if (body) {
          const action = JSON.parse(body); assert(["deny", "restore"].includes(action.permission));
          fs.chmodSync(f.tool, action.permission === "deny" ? 0o600 : 0o700);
        }
        res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(state()));
      } else {
        assert(["old", "current"].includes(parts[0]));
        if (parts[1] === "message") {
          const msg = JSON.parse(body); assert(["envList", "envPackages"].includes(msg.command), "No install/move/delete commands");
          if (msg.command === "envPackages") assert([f.id, f.venvId].includes(msg.id));
          const messages = []; await hosts[parts[0]](msg, message => messages.push(message));
          res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(messages));
        } else {
          res.setHeader("Content-Type", "text/html"); res.end(pages[parts[0]]);
        }
      }
    } catch (error) { res.statusCode = 500; res.end(String(error.stack || error)); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const runtime = path.join(root, "browser-runtime"); fs.mkdirSync(runtime);
  const browser = execFileSync(python, ["-I", "-B", "-c",
    "from playwright.sync_api import sync_playwright\nwith sync_playwright() as p: print(p.chromium.executable_path)"],
  { encoding: "utf8", env: { ...process.env, HOME: originalEnv.HOME, TMPDIR: runtime } }).trim();
  assert(fs.existsSync(browser), "An already installed Chromium is required; never download it.");
  const output = await promisify(execFile)(python, ["-I", "-B", path.resolve("tests/ordinary_environment_profile_ui.py"),
    "--base", `http://127.0.0.1:${server.address().port}/${token}`, "--id", f.id, "--venv-id", f.venvId, "--chromium", browser],
  { cwd: runtime, env: { ...process.env, TMPDIR: ".", HOME: root, XDG_CONFIG_HOME: path.join(runtime, "config"),
    XDG_CACHE_HOME: path.join(runtime, "cache") }, timeout: 60000, maxBuffer: 1 << 20 });
  const result = JSON.parse(output.stdout);
  assert.equal(result.length, 2); assert.equal(result[0].state.cacheSha256, f.cacheSha256);
  assert.equal(result[1].state.calls, result[0].state.calls + 1);
  for (const stage of result) {
    assert.equal(stage.state.registry[0].id, f.id); assert.equal(stage.state.registry[0].path, f.prefix);
    assert.equal(stage.state.registry[0].customReference.owner, "original-profile"); assert.equal(stage.state.nextCatalog, false);
    assert.equal(stage.state.registry[1].id, f.venvId); assert.equal(stage.state.registry[1].path, f.venv);
    assert.equal(stage.state.registry[1].customReference.owner, "original-profile");
  }
  assert.equal(digest(fs.readFileSync(path.join(f.knowledgeRoot, "untouched-root.txt"))), f.rootSha256);
  console.log(JSON.stringify({ qualification: "offline real DOM, not installed Extension Host", result }));
});
