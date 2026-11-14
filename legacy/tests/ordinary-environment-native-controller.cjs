"use strict";
const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), assert = require("node:assert/strict");
const { spawn, spawnSync, execFileSync } = require("node:child_process");
const { randomUUID, randomBytes } = require("node:crypto");
const project = process.cwd(), pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const { launcher } = require("./helpers/ordinary-environment-native-effects.cjs");
const { startNativeParent } = require("./helpers/ordinary-environment-native-parent.cjs");
function checked(program, args, options = {}) {
  const result = spawnSync(program, args, { encoding: "utf8", timeout: 120000, ...options });
  if (result.status !== 0 || result.error) throw result.error || Error(`${program}: ${result.stderr}`);
}
async function wait(probe, name, timeout = 90000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = probe(); if (value) return value; await pause(100); }
  throw Error(`Timeout: ${name}`);
}
function html() {
  const ts = require("typescript"), read = name => fs.readFileSync(path.join(project, "src/webview/panel", name), "utf8");
  const tree = ts.createSourceFile("knowledge.js", read("20-knowledge.js"), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const names = ["buildCatTree", "countTreeLeaves", "expandedCategoryKey", "renderCatTree", "toggleCat"];
  const functions = names.map(name => {
    const node = tree.statements.find(item => ts.isFunctionDeclaration(item) && item.name?.text === name); assert(node); return node.getText(tree);
  }).join("\n");
  const core = read("00-core.js"), begin = core.indexOf("else if (command === 'envList')"), end = core.indexOf("else if (command === 'envCompare')", begin);
  assert(begin > 0 && end > begin);
  return `<html><body><div id="detail"></div><script>
const state={tab:'environments'},catExpanded={},githubSyncTypes=[],vscode=acquireVsCodeApi();
const esc=v=>String(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const uiIcon=(icon,label='')=>'<span>'+esc(label)+'</span>',helpText=en=>en;
const privacyInherited=()=>false,privacyLock=()=>'',folkDisplayName=esc,brokerFolderMarker=()=>'';
const problemGuidanceHtml=(message,next,actions)=>'<div role="alert">'+esc(message)+next+actions+'</div>';
function deliver(e){const command=e.data.command,data=e.data.data;if(false){} ${core.slice(begin,end)}}
function ask(command,data){vscode.postMessage({command,...data});}
window.addEventListener('message',deliver);
${functions}
${read("30-environments.js")}
ask('envList',{});
</script></body></html>`;
}
function prepare() {
  const root = path.join(project, ".migration-test-work", `native-env-code-${randomUUID()}`);
  fs.mkdirSync(root, { mode: 0o700 });
  const f = { project, root, build: path.join(project, ".migration-test-work/environment-native-issuer/build"),
    next: path.join(project, ".migration-test-work/environment-native-issuer/next"),
    profileVolume: path.join(root, "profile-volume"), runtimeVolume: path.join(root, "runtime-volume"),
    knowledgeRoot: path.join(root, "knowledge"), config: path.join(root, "host.json"),
    oldDriver: path.join(root, "old-driver"), nativeDriver: path.join(root, "native-driver"),
    workspace: path.join(root, "workspace"), extensions: path.join(root, "extensions") };
  f.userData = path.join(f.profileVolume, "user-data");
  f.storage = path.join(f.userData, "User/globalStorage/uone.personal-knowledge");
  f.capsules = path.join(f.runtimeVolume, "capsules");
  f.prefix = path.join(f.capsules, "miniconda/envs/RetainedConda");
  f.venv = path.join(f.capsules, "retained-venv"); f.hostBin = path.join(f.capsules, "tools");
  f.condaExecutable = path.join(f.capsules, "miniconda/bin/conda");
  fs.writeFileSync(path.join(root, "ordinary.html"), html());
  for (const directory of [f.oldDriver, f.nativeDriver]) fs.mkdirSync(directory);
  fs.writeFileSync(path.join(f.oldDriver, "package.json"), JSON.stringify({ name: "native-env-old-driver", publisher: "fixture",
    version: "0.0.1", engines: { vscode: "^1.90.0" }, main: "./extension.cjs", activationEvents: ["*"] }));
  fs.copyFileSync(path.join(project, "tests/ordinary-environment-installed-host.cjs"), path.join(f.oldDriver, "extension.cjs"));
  fs.writeFileSync(path.join(f.nativeDriver, "package.json"), JSON.stringify({ name: "personal-knowledge", publisher: "Uone",
    version: "0.0.1", engines: { vscode: "^1.90.0" }, main: "./extension.cjs", activationEvents: ["*"] }));
  fs.copyFileSync(path.join(project, "tests/ordinary-environment-native-code-host.cjs"), path.join(f.nativeDriver, "extension.cjs"));
  fs.writeFileSync(path.join(root, "contract.json"), JSON.stringify(f, null, 2));
  console.log(root);
}
const rows = () => fs.readdirSync("/proc").filter(name => /^\d+$/.test(name)).flatMap(name => {
  try {
    const data = fs.readFileSync(`/proc/${name}/stat`, "utf8"), fields = data.slice(data.lastIndexOf(")") + 2).trim().split(/\s+/);
    return [{ pid: Number(name), start: fields[19], state: fields[0] }];
  } catch { return []; }
});
const live = row => rows().some(current => current.pid === row.pid && current.start === row.start && !["Z", "X"].includes(current.state));
async function inside(f, editor, xvfb, python) {
  assert(fs.readFileSync("/proc/1/cmdline", "utf8").includes("pkm-private-init"));
  assert(!fs.existsSync(path.join(f.root, "started"))); fs.writeFileSync(path.join(f.root, "started"), "");
  const setupHome = path.join(f.root, "setup-home"), setupTemp = path.join(f.root, "setup-runtime");
  fs.mkdirSync(setupHome); fs.mkdirSync(setupTemp);
  Object.assign(process.env, { HOME: setupHome, USERPROFILE: setupHome, TMPDIR: setupTemp, TMP: setupTemp, TEMP: setupTemp,
    XDG_CONFIG_HOME: path.join(setupHome, "config"), XDG_CACHE_HOME: path.join(setupHome, "cache"),
    PIP_NO_INDEX: "1", PIP_DISABLE_PIP_VERSION_CHECK: "1", PIP_CONFIG_FILE: "/dev/null", PYTHONDONTWRITEBYTECODE: "1" });
  for (const directory of [f.profileVolume, f.runtimeVolume, f.knowledgeRoot, f.workspace, f.extensions]) fs.mkdirSync(directory, { mode: 0o700 });
  checked("/usr/bin/mount", ["-t", "tmpfs", "-o", "mode=0700", "tmpfs", f.profileVolume]);
  checked("/usr/bin/mount", ["-t", "tmpfs", "-o", "mode=0700", "tmpfs", f.runtimeVolume]);
  fs.mkdirSync(f.capsules);
  for (const prefix of [f.prefix, f.venv]) {
    checked("/usr/bin/python3", ["-m", "venv", "--without-pip", "--system-site-packages", prefix]);
    fs.renameSync(path.join(prefix, "bin/python"), path.join(prefix, "bin/python-real"));
    fs.writeFileSync(path.join(prefix, "bin/python"), launcher(path.join(prefix, "bin/python-real")), { mode: 0o700 });
  }
  fs.mkdirSync(path.join(f.prefix, "conda-meta"));
  fs.writeFileSync(path.join(f.prefix, "conda-meta/retained.json"), JSON.stringify({ name: "retained_fixture", version: "1.0" }));
  const library = fs.readdirSync(path.join(f.venv, "lib")).find(name => /^python/.test(name));
  const marker = path.join(f.venv, "lib", library, "site-packages/retained_fixture-1.0.dist-info");
  fs.mkdirSync(marker, { recursive: true });
  fs.writeFileSync(path.join(marker, "METADATA"), "Metadata-Version: 2.1\nName: retained_fixture\nVersion: 1.0\n");
  fs.mkdirSync(path.dirname(f.condaExecutable), { recursive: true }); fs.mkdirSync(f.hostBin);
  const inner = path.join(path.dirname(f.condaExecutable), "conda-inner");
  fs.writeFileSync(inner, `#!/usr/bin/python3\nimport sys,json,os\nassert sys.argv[1:4]==['list','--json','-p']\np=sys.argv[4]\nprint(json.dumps([json.load(open(os.path.join(p,'conda-meta',n))) for n in os.listdir(os.path.join(p,'conda-meta')) if n.endswith('.json')]))\n`, { mode: 0o700 });
  fs.writeFileSync(f.condaExecutable, launcher(inner), { mode: 0o700 });
  const du = path.join(f.hostBin, "du"); fs.writeFileSync(du, launcher("/usr/bin/du"), { mode: 0o700 });
  f.programs = [{ filename: du, executable: "/usr/bin/du" }, { filename: f.condaExecutable, executable: inner },
    ...[f.prefix, f.venv].map(prefix => ({ filename: path.join(prefix, "bin/python"), executable: path.join(prefix, "bin/python-real") }))];
  fs.mkdirSync(f.storage, { recursive: true });
  const oracle = path.join(f.root, "legacy-pyenvs.cjs");
  fs.writeFileSync(oracle, execFileSync("unzip", ["-p", path.join(project, "personal-knowledge-4.0.22.vsix"), "extension/dist/servers/pyenvs.js"]));
  const old = require(oracle); old.initPyenvs(path.join(f.storage, "environments"));
  const conda = old.pyenvAdd({ name: "Retained Conda", manager: "conda", path: f.prefix, python: path.join(f.prefix, "bin/python") });
  const venv = old.pyenvAdd({ name: "Retained Venv", manager: "venv", path: f.venv, python: path.join(f.venv, "bin/python") });
  const saved = process.env.PATH; process.env.PATH = path.dirname(f.condaExecutable);
  assert(!(await old.pyenvPackages(conda.id, true)).error); assert(!(await old.pyenvPackages(venv.id, true)).error);
  process.env.PATH = saved;
  old.pyenvUpdate(conda.id, { pyVersion: "0.0", sizeBytes: 0 }); old.pyenvUpdate(venv.id, { pyVersion: "0.0", sizeBytes: 0 });
  f.id = conda.id; f.venvId = venv.id;
  fs.writeFileSync(path.join(f.root, "fixture-receipt.json"), JSON.stringify({ ...f, directory: path.join(f.storage, "environments") }));
  fs.mkdirSync(path.join(f.knowledgeRoot, "notes"));
  fs.writeFileSync(path.join(f.knowledgeRoot, "notes/Existing.md"), "---\ntitle: Existing\nrevision: 1\n---\nOriginal isolated Root.\n");
  fs.writeFileSync(f.config, JSON.stringify({ schema: "pkm.native-host-config/v1", provider: "openai-compatible", endpoint: "http://127.0.0.1:9/v1",
    secretRef: "secret:fixture/model", model: "fixture", contextWindow: 16384, maxOutputTokens: 4096,
    outputTokenParameter: "max_tokens", includeUsage: true, tools: ["knowledge.document.list"] }), { mode: 0o600 });
  checked("/usr/bin/mount", ["--bind", f.capsules, f.capsules]);
  checked("/usr/bin/mount", ["-o", "remount,bind,ro", f.capsules]);
  f.mountNamespace = fs.readlinkSync("/proc/self/ns/mnt"); f.pidNamespace = fs.readlinkSync("/proc/self/ns/pid");
  fs.writeFileSync(path.join(f.userData, "User/settings.json"), JSON.stringify({ "personalKnowledge.storePath": f.knowledgeRoot,
    "personalKnowledge.openOnStartup": false, "personalKnowledge.experimental.localEnvironmentUpgrade": false,
    "security.workspace.trust.enabled": false, "window.dialogStyle": "custom", "workbench.startupEditor": "none",
    "telemetry.telemetryLevel": "off", "update.mode": "none", "extensions.autoUpdate": false }));
  process.chdir(f.root);
  const short = `/proc/${process.pid}/cwd`, home = path.join(f.root, "home"), temp = path.join(f.root, "runtime");
  fs.mkdirSync(home); fs.mkdirSync(temp); fs.mkdirSync(path.join(home, "run"));
  const env = { PATH: `/usr/bin:/bin:${path.dirname(process.execPath)}`, HOME: "/proc/self/cwd/home", USERPROFILE: "/proc/self/cwd/home",
    TMPDIR: "/proc/self/cwd/runtime", TMP: "/proc/self/cwd/runtime", TEMP: "/proc/self/cwd/runtime", XDG_RUNTIME_DIR: "/proc/self/cwd/home/run",
    XDG_CONFIG_HOME: "/proc/self/cwd/home/config", XDG_CACHE_HOME: "/proc/self/cwd/home/cache", NO_PROXY: "127.0.0.1",
    HTTP_PROXY: "http://127.0.0.1:1", HTTPS_PROXY: "http://127.0.0.1:1", PYTHONDONTWRITEBYTECODE: "1",
    PIP_NO_INDEX: "1", PIP_DISABLE_PIP_VERSION_CHECK: "1", PIP_CONFIG_FILE: "/dev/null",
    PKM_ORDINARY_ENV_FIXTURE: f.root, PKM_NATIVE_ENV_FIXTURE: f.root, PKM_NATIVE_ENV_PROJECT: project };
  f.executionEnvironment = { ...env, PATH: f.hostBin, HOME: home, TMPDIR: temp };
  const authority = path.join(f.root, "Xauthority"), display = "127.0.0.1:98";
  fs.writeFileSync(authority, "", { mode: 0o600 });
  checked("ip", ["link", "set", "lo", "up"]); checked("xauth", ["-f", authority, "add", display, "MIT-MAGIC-COOKIE-1", randomBytes(16).toString("hex")]);
  env.DISPLAY = display; env.XAUTHORITY = authority;
  const captured = new Map(), original = new Map(); let tracker, parent, x;
  const capture = () => { for (const row of rows()) if (row.pid !== 1 && row.pid !== process.pid) captured.set(row.pid, row); };
  try {
    x = spawn(xvfb, [":98", "-screen", "0", "1280x800x24", "-nolock", "-nolisten", "unix", "-nolisten", "local",
      "-listen", "tcp", "-auth", authority], { env, stdio: "ignore" });
    await wait(() => spawnSync("xdpyinfo", ["-display", display], { env, stdio: "ignore" }).status === 0, "private display");
    tracker = setInterval(capture, 100);
    const cli = path.join(path.dirname(editor), "bin/code");
    const base = [`--user-data-dir=${f.userData}`, `--extensions-dir=${f.extensions}`, "--no-sandbox"];
    checked(cli, [...base, "--install-extension", path.join(project, "personal-knowledge-4.0.22.vsix"), "--force"], { env });
    for (const phase of ["original", "native", "restart"]) {
      f.phase = phase; fs.writeFileSync(path.join(f.root, "phase"), phase); fs.writeFileSync(path.join(f.root, "contract.json"), JSON.stringify(f, null, 2));
      if (phase !== "original") {
        parent = await startNativeParent(f, () => assert.equal([...original.values()].filter(live).length, 0, "Original known owned host still lives."));
        env.PKM_NATIVE_ENV_CHANNEL_KEY = parent.key; env.PKM_NATIVE_ENV_ENDPOINT = JSON.stringify(parent.endpoint);
      }
      const log = fs.openSync(path.join(temp, `code-${phase}.log`), "wx");
      const code = spawn("setpriv", ["--bounding-set=-dac_override,-dac_read_search", "--no-new-privs", editor, f.workspace, ...base,
        `--extensionDevelopmentPath=${phase === "original" ? f.oldDriver : f.nativeDriver}`, "--new-window",
        "--disable-gpu", "--disable-dev-shm-usage", "--disable-telemetry", "--disable-updates", "--disable-workspace-trust",
        "--skip-welcome", "--skip-release-notes", "--password-store=basic", "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=19685"],
      { env, stdio: ["ignore", log, log] }); fs.closeSync(log);
      if (phase === "original") {
        await wait(() => {
          const error = path.join(f.root, "host-error-original.txt"); if (fs.existsSync(error)) throw Error(fs.readFileSync(error, "utf8"));
          return fs.existsSync(path.join(f.root, "host-original.json"));
        }, "actual 4.0.22 profile activation");
      } else {
        const actor = spawn(python, ["-I", "-B", path.join(project, "tests/ordinary_environment_native_actor.py"),
          "--fixture", f.root, "--phase", phase, "--cdp", "http://127.0.0.1:19685"], { env, stdio: ["ignore", "pipe", "pipe"] });
        let output = ""; actor.stdout.on("data", data => { output += data; }); actor.stderr.on("data", data => { output += data; });
        const exit = await new Promise(resolve => actor.once("close", resolve));
        fs.writeFileSync(path.join(f.root, `actor-${phase}.log`), output); assert.equal(exit, 0, output);
      }
      capture();
      if (phase === "original") for (const row of captured.values()) if (row.pid !== x.pid && live(row)) original.set(row.pid, row);
      fs.writeFileSync(path.join(f.root, `close-${phase}`), "");
      await wait(() => code.exitCode !== null, "actual Code window exit", 30000);
      if (phase === "original") await wait(() => [...original.values()].every(row => !live(row)), "all known original host descendants exit");
      if (parent) { await parent.close(); parent = undefined; }
      await pause(300);
    }
    fs.writeFileSync(path.join(f.root, "profile-final.json"), JSON.stringify(fs.readdirSync(path.join(f.storage, "environments"))
      .filter(name => name.endsWith(".json")).map(name => ({ name, content: fs.readFileSync(path.join(f.storage, "environments", name), "utf8") })), null, 2));
    console.log("PASS bounded prestarted actual owner + native Code consent + isolated Refresh + restart (not production/cross-process closure)");
  } finally {
    clearInterval(tracker); capture();
    if (parent) { try { await parent.close(); } catch (error) { fs.writeFileSync(path.join(f.root, "parent-close-error.txt"), String(error)); } }
    for (const row of [...captured.values()].reverse()) if (live(row)) { try { process.kill(row.pid, "SIGTERM"); } catch {} }
    await pause(1000);
    for (const row of captured.values()) if (live(row)) { try { process.kill(row.pid, "SIGKILL"); } catch {} }
    await pause(300);
    const remaining = [...captured.values()].filter(live);
    fs.writeFileSync(path.join(f.root, "cleanup.json"), JSON.stringify({ captured: [...captured.values()], remaining }, null, 2));
    assert.equal(remaining.length, 0);
  }
}
async function main() {
  if (process.argv.includes("--prepare")) return prepare();
  if (process.argv.includes("--help")) { console.log("--prepare | --run <fresh contract.json> (requires formal Code handoff)"); return; }
  const position = process.argv.indexOf("--run"); assert(position >= 0, "Explicit --run is mandatory.");
  const f = JSON.parse(fs.readFileSync(process.argv[position + 1]));
  assert(f.root.startsWith(path.join(project, ".migration-test-work") + path.sep));
  if (process.argv.includes("--inside")) {
    const index = process.argv.indexOf("--inside"); return inside(f, ...process.argv.slice(index + 1));
  }
  const args = require("../scripts/run-next-trial-private-display").privateNamespaceArgs([
    process.execPath, __filename, "--run", process.argv[position + 1], "--inside",
    path.join(os.homedir(), ".cache/pkm-vscode-test/vscode-linux-x64-1.143.0/code"),
    path.join(os.homedir(), ".cache/pkm-vscode-test/tools/xvfb/usr/bin/Xvfb"), process.env.PKM_BROWSER_PYTHON,
  ]);
  const result = spawnSync("unshare", args, { cwd: project, env: { PATH: process.env.PATH || "",
    TMPDIR: path.join(project, ".migration-test-work/environment-native-issuer/t") }, stdio: "inherit", timeout: 480000 });
  fs.writeFileSync(path.join(f.root, "controller-exit.json"), JSON.stringify({ status: result.status, signal: result.signal }));
  if (result.status !== 0 || result.error) throw result.error || Error(`Private namespace exited ${result.status}`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
