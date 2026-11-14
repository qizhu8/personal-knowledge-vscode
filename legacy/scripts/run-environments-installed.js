#!/usr/bin/env node
"use strict";
// Focused installed overlay, not the production release/package qualification gate.
const fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const { spawn, spawnSync, execFileSync } = require("node:child_process");
const { randomUUID, randomBytes, createHash } = require("node:crypto");
const assert = require("node:assert/strict");
const sourceProject = path.resolve(__dirname, "..");
const arg = key => process.argv.find(item => item.startsWith(`--${key}=`))?.slice(key.length + 3);
const project = arg("fixture-parent") ?? sourceProject;
if (arg("fixture-parent") && (!path.isAbsolute(project) || fs.realpathSync(project) !== fs.realpathSync(process.cwd())))
  throw new Error("Explicit fixture parent must be the current authorized checkout; frozen sources remain separate.");
const hash = file => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
async function main() {
  const baseline = arg("legacy-vsix"), candidate = arg("candidate-vsix"), build = arg("root-build");
  const condaCrash = process.argv.includes("--conda-installed-crash");
  const prepareOnly = process.argv.includes("--prepare-only");
  const condaPackages = process.argv.includes("--conda-packages");
  const pythonDeleteOnly = process.argv.includes("--python-delete-only");
  const pythonDelete = pythonDeleteOnly || process.argv.includes("--python-delete");
  const pythonPackages = !pythonDeleteOnly && (pythonDelete || process.argv.includes("--python-packages"));
  const privatePythonUser = pythonDeleteOnly || pythonPackages;
  const condaLifecycle = condaCrash || process.argv.includes("--conda-lifecycle");
  const managers = condaLifecycle || condaPackages || pythonPackages || process.argv.includes("--managers");
  const pythonProgram = process.argv.includes("--python-program");
  const nodeProject = process.argv.includes("--node-project");
  if (nodeProject && (managers || pythonProgram || pythonDeleteOnly))
    throw new Error("Node project and Python manager/reviewed-program qualifications require separate fixtures.");
  const management = managers || pythonProgram || nodeProject || pythonDeleteOnly || process.argv.includes("--management");
  const upgrade = management || process.argv.includes("--upgrade");
  const execution = upgrade || process.argv.includes("--execution");
  if (process.platform !== "linux" || [baseline, candidate, build].some(item => !item || !path.isAbsolute(item)))
    throw new Error("Require absolute --legacy-vsix, --candidate-vsix and --root-build. Offline local resources only.");
  if (managers && [arg("conda"), arg("conda-cache")].some(item => !item || !path.isAbsolute(item)))
    throw new Error("Manager qualification additionally requires explicit installed absolute --conda and --conda-cache; no downloads.");
  if (pythonPackages && (!arg("pip-python") || !path.isAbsolute(arg("pip-python"))))
    throw new Error("Pip qualification requires explicit installed --pip-python; never install/seed pip.");
  const editor = process.env.PKM_VSCODE_EXECUTABLE || path.join(os.homedir(), ".cache/pkm-vscode-test/vscode-linux-x64-1.143.0/code");
  const xvfb = process.env.PKM_TRIAL_XVFB || path.join(os.homedir(), ".cache/pkm-vscode-test/tools/xvfb/usr/bin/Xvfb");
  if (!process.argv.includes("--inside")) {
    const command = [process.execPath, __filename, ...process.argv.slice(2), "--inside"];
    const result = spawnSync(privatePythonUser ? "/usr/bin/python3" : "unshare",
      privatePythonUser ? ["-I", "-B", path.join(__dirname, "run-private-python-user.py"), ...command]
        : require("./run-next-trial-private-display").privateNamespaceArgs(command), { cwd: project, stdio: "inherit", timeout: 360000,
      env: { PATH: process.env.PATH, PKM_VSCODE_EXECUTABLE: editor, PKM_TRIAL_XVFB: xvfb } });
    if (result.error || result.status) throw result.error || new Error(`Private installed test exited ${result.status ?? result.signal}`);
    return;
  }
  process.umask(0o077);
  const environmentSourceNames = ["src/runtime/local-environment-catalog.ts", "src/runtime/local-runtime-authority.ts",
    "src/runtime/local-node-project.ts", "src/runtime/next-managed-client.ts", "src/ui/next-local-environments.ts",
    "src/ui/next-local-runtime.ts", "src/ui/next-local-runtime-management.ts",
    "next-server/src/host-local-environment-workflow.ts", "next-server/src/host-node-project.ts",
    "src/runtime/local-python-lifecycle.ts", "src/ui/next-python-lifecycle.ts",
    "src/runtime/local-conda-lifecycle.ts", "src/ui/next-conda-lifecycle.ts",
    "src/runtime/local-conda-packages.ts", "src/ui/next-conda-packages.ts",
    "src/runtime/local-python-managers.ts", "src/servers/pyenvs.ts",
    "src/runtime/local-python-packages.ts", "src/runtime/local-python-analytics.ts",
    "src/runtime/local-python-inspection.ts", "src/runtime/local-python-merge.ts",
    "src/ui/next-python-packages.ts", "src/ui/next-python-inspection.ts"];
  const environmentSources = Object.fromEntries(environmentSourceNames.map(name => [name, hash(path.join(sourceProject, name))]));
  const environmentSourceSha256 = createHash("sha256").update(JSON.stringify(environmentSources)).digest("hex");
  const controlNames = ["scripts/run-environments-installed.js", "tests/next-trial-electron/environments-installed.cjs",
    "tests/next-trial-electron/environments-management-installed.cjs", "tests/next-trial-electron/environments-python-program-installed.cjs",
    "tests/next-trial-electron/environments-execution-installed.cjs",
    "tests/next-trial-electron/environments-node-project-installed.cjs", "tests/next-trial-electron/environments-lifecycle-installed.cjs",
    "tests/next-trial-electron/environments-conda-lifecycle-installed.cjs", "tests/next-trial-electron/environments-managers-installed.cjs",
    "tests/next-trial-electron/environments-conda-crash-installed.cjs", "scripts/environments-installed-crash-control.cjs",
    "tests/next-trial-electron/environments-upgrade-installed.cjs",
    "tests/next-trial-electron/environments-conda-packages-installed.cjs",
    "tests/next-trial-electron/environments-python-packages-installed.cjs",
    "tests/next-trial-electron/environments-python-deletion-installed.cjs", "scripts/run-private-python-user.py"];
  const controllerSources = Object.fromEntries(controlNames.map(name => [name, hash(path.join(sourceProject, name))]));
  const root = path.join(project, ".migration-test-work", `${managers ? "em" : "environments-installed"}-${randomUUID()}`);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const cacheSnapshot = require("../tests/local-python-manager-cache-snapshot.cjs");
  const sourceCacheBefore = managers ? cacheSnapshot(arg("conda-cache")) : undefined;
  process.chdir(root);
  for (const dir of ["h", "u/User", "x", "t", "knowledge", "workspace", "driver"])
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (managers && process.getuid() === 0) require("../tests/private-linux-account-fixture.cjs")(root, path.join(root, "h"));
  const short = `/proc/${process.pid}/cwd`;
  const env = { PATH: process.env.PATH, HOME: `${short}/h`, USERPROFILE: `${short}/h`,
    TMPDIR: path.join(root, "t"), TMP: path.join(root, "t"), TEMP: path.join(root, "t"),
    XDG_RUNTIME_DIR: `${short}/t`, DISPLAY: "127.0.0.1:91", XAUTHORITY: path.join(root, "Xauthority"),
    HTTP_PROXY: "http://127.0.0.1:1", HTTPS_PROXY: "http://127.0.0.1:1", ALL_PROXY: "http://127.0.0.1:1" };
  Object.assign(process.env, env);
  const run = (command, args, extra = {}) => execFileSync(command, args,
    { cwd: root, env: { ...env, ...extra }, encoding: "utf8", timeout: 120000, maxBuffer: 8 * 1024 * 1024 });
  if (privatePythonUser) {
    assert(process.getuid() !== 0, "Inventory must not run as namespace admin.");
    assert.match(run("ip", ["link", "show", "lo"]), /UP/);
  } else run("ip", ["link", "set", "lo", "up"]);
  const overlay = path.join(root, "environments-focused.vsix");
  const modules = ["runtime/local-environment-catalog", "runtime/local-environment-upgrade", "runtime/local-python-management", "runtime/local-python-managers", "runtime/local-runtime-authority", "runtime/next-managed-client",
    "runtime/local-node-project", "ui/next-local-runtime-management", "runtime/local-python-lifecycle", "ui/next-python-lifecycle",
    "runtime/local-conda-lifecycle", "ui/next-conda-lifecycle",
    "runtime/local-conda-packages", "ui/next-conda-packages", "servers/pyenvs",
    "runtime/local-python-packages", "runtime/local-python-analytics", "runtime/local-python-inspection",
    "runtime/local-python-merge", "ui/next-python-packages", "ui/next-python-inspection",
    "chatroom/next-room-host-bridge", "chatroom/chat-room-credentials", "chatroom/next-room-recovery",
    "runtime/python-program-authority", "ui/next-python-program",
    "ui/next-local-runtime", "ui/next-local-environments", "ui/next-python-environment"];
  const moduleSources = Object.fromEntries(modules.map(module =>
    [module, hash(path.join(sourceProject, "src", `${module}.ts`))]));
  const staged = path.join(root, "fresh-next-runtime");
  const frozenRuntime = arg("frozen-next-runtime");
  if (frozenRuntime) {
    if (!path.isAbsolute(frozenRuntime) || !path.resolve(frozenRuntime).startsWith(project + path.sep))
      throw new Error("Frozen test runtime must be an explicit absolute path inside this checkout.");
    fs.cpSync(frozenRuntime, staged, { recursive: true, errorOnExist: true, force: false });
  } else require("./next-rehearsal-runtime").stage(staged, { production: true });
  run("python3", ["-B", "-c", `
import json,sys,zipfile,pathlib,xml.etree.ElementTree as ET
candidate,build,output,staged,setting,version=sys.argv[1:]
modules=${JSON.stringify(modules)}
replacements={}
for module in modules:
 for suffix in ['.js','.js.map']:
  replacements['extension/dist/'+module+suffix]=(pathlib.Path(build)/(module+suffix)).read_bytes()
with zipfile.ZipFile(candidate) as source,zipfile.ZipFile(output,'w',zipfile.ZIP_DEFLATED) as target:
 manifest=json.loads(source.read('extension/package.json'))
 if version:
  if len(version.split('.'))!=3 or not all(part.isdigit() for part in version.split('.')): raise ValueError('Explicit overlay version must be numeric semver')
  manifest['version']=version
  ET.register_namespace('', 'http://schemas.microsoft.com/developer/vsx-schema/2011')
  metadata=ET.fromstring(source.read('extension.vsixmanifest'))
  identities=[item for item in metadata.iter() if item.tag.rsplit('}',1)[-1]=='Identity']
  if len(identities)!=1: raise ValueError('Expected exactly one VSIX package identity')
  identities[0].set('Version',version)
  replacements['extension.vsixmanifest']=ET.tostring(metadata,encoding='utf-8',xml_declaration=True)
 manifest['contributes']['configuration']['properties']['personalKnowledge.experimental.localEnvironmentUpgrade']=json.loads(setting)
 for command in [
  {'command':'personalKnowledge.nextTrialEnvironments','title':'PKM: Manage Isolated Trial Local Environments'},
  {'command':'personalKnowledge.nextTrialRuntime','title':'PKM: Run or Recover Registered Local Runtime Workflow'}]:
  if not any(item['command']==command['command'] for item in manifest['contributes']['commands']):
   manifest['contributes']['commands'].append(command)
 replacements['extension/package.json']=json.dumps(manifest,indent=2).encode()
 for file in pathlib.Path(staged).rglob('*'):
  if file.is_file():
   data=file.read_bytes()
   if file.name=='manifest.json' and file.parent==pathlib.Path(staged):
    payload=json.loads(data);payload['extensionVersion']=manifest['version'];data=json.dumps(payload,indent=2).encode()
   replacements['extension/next-runtime/'+file.relative_to(staged).as_posix()]=data
 for item in source.infolist():
  if item.filename not in replacements and not item.filename.startswith('extension/next-runtime/'):
   target.writestr(item,source.read(item.filename))
 for name,data in replacements.items(): target.writestr(name,data)
`, candidate, build, overlay, staged, JSON.stringify(require(path.join(sourceProject, "package.json"))
    .contributes.configuration.properties["personalKnowledge.experimental.localEnvironmentUpgrade"]), arg("overlay-version") ?? ""]);
  if (prepareOnly) {
    fs.writeFileSync(path.join(root, "prepared-overlay.json"), JSON.stringify({
      scope: "immutable focused overlay preparation only; no Code/installation or workflow qualification",
      overlay, overlaySha256: hash(overlay), baseCandidateSha256: hash(candidate),
      environmentSourceSha256, environmentSources, controllerSources,
      runtimeBuildId: JSON.parse(fs.readFileSync(path.join(staged, "manifest.json"))).buildId,
      codeStarted: false, installedJourneyVerified: false,
    }, null, 2));
    console.log(`Prepared focused overlay without Code: ${overlay}`);
    return;
  }
  // Use the real old package's registry writer against a private profile; never activate its MCP.
  fs.writeFileSync("old-pyenvs.cjs", run("unzip", ["-p", baseline, "extension/dist/servers/pyenvs.js"]));
  if (management) fs.writeFileSync("old-environments-ui.js", run("unzip", ["-p", baseline, "extension/src/webview/panel/30-environments.js"]));
  const old = require(path.join(root, "old-pyenvs.cjs"));
  const venv = path.join(root, "legacy-venv");
  run("/usr/bin/python3", ["-m", "venv", "--without-pip", venv]);
  old.initPyenvs(path.join(root, "u/User/globalStorage/uone.personal-knowledge/environments"));
  const entry = old.pyenvAdd({ name: "legacy-python", manager: "venv", path: venv, python: path.join(venv, "bin/python") });
  await old.pyenvSize(entry.id, true);
  if (managers) {
    const seed = path.join(root, "offline-channel-seed"); fs.mkdirSync(seed, { mode: 0o700 });
    const { LocalEnvironmentCatalog } = require(path.join(build, "runtime/local-environment-catalog.js"));
    const { LocalPythonManagerAuthority } = require(path.join(build, "runtime/local-python-managers.js"));
    const { planPythonCreation, createOfflinePythonEnvironment } = require(path.join(build, "runtime/local-python-management.js"));
    const store = new LocalEnvironmentCatalog(path.join(seed, "catalog"));
    const authority = new LocalPythonManagerAuthority(() => true);
    const handle = authority.select("conda", arg("conda"), arg("conda-cache"));
    const planned = planPythonCreation(seed, "private-channel-seed", "", "conda");
    try {
      await createOfflinePythonEnvironment({ storage: seed, entry: planned, store, expected: store.read().digest,
        provider: authority.provider(handle, { pythonVersion: "3.11" }), check() { authority.validate(handle); } });
    } finally { authority.revoke(); }
    await require("../tests/old-conda-create-fixture.cjs")({ root: path.join(root, "old-manager"), old,
      executable: arg("conda"), channel: `${planned.root}-provision/channel` });
  }
  const legacyRegistry = path.join(root, "u/User/globalStorage/uone.personal-knowledge/environments/registry.json");
  let legacyRegistrySha256 = hash(legacyRegistry);
  const missingPython = path.join(root, "deliberately-unconfigured-mcp-python");
  fs.writeFileSync("u/User/settings.json", JSON.stringify({
    "personalKnowledge.storePath": path.join(root, "knowledge"),
    "personalKnowledge.mcpPythonPath": missingPython,
    "personalKnowledge.environmentsPath": path.join(root, "h/pkm-envs"),
    "personalKnowledge.experimental.localEnvironmentUpgrade": upgrade,
    "security.workspace.trust.enabled": false, "workbench.startupEditor": "none",
    "telemetry.telemetryLevel": "off", "update.mode": "none", "extensions.autoUpdate": false,
    "extensions.autoCheckUpdates": false, "extensions.ignoreRecommendations": true,
    "git.enabled": false, "github.gitAuthentication": false,
  }));
  const cliArgs = ["--no-sandbox", `--user-data-dir=${short}/u`, `--extensions-dir=${short}/x`];
  const install = vsix => {
    console.log(run(path.join(path.dirname(editor), "bin/code"), [...cliArgs, "--install-extension", vsix, "--force"]));
    const version = JSON.parse(run("unzip", ["-p", vsix, "extension/package.json"])).version;
    const installed = fs.readdirSync("x").find(name => /^uone\.personal-knowledge-/i.test(name)
      && JSON.parse(fs.readFileSync(path.join(root, "x", name, "package.json"))).version === version);
    assert(installed);
    const extension = path.join(root, "x", installed);
    for (const harness of ["environments-installed.cjs", "environments-execution-installed.cjs", "environments-upgrade-installed.cjs", "environments-management-installed.cjs", "environments-managers-installed.cjs", "environments-python-program-installed.cjs", "environments-node-project-installed.cjs", "environments-lifecycle-installed.cjs", "environments-conda-lifecycle-installed.cjs", "environments-conda-crash-installed.cjs", "environments-conda-packages-installed.cjs", "environments-python-packages-installed.cjs", "environments-python-deletion-installed.cjs"])
      fs.copyFileSync(path.join(sourceProject, "tests/next-trial-electron", harness), path.join(extension, harness));
    if (execution) fs.writeFileSync(path.join(extension, "environments-combined.cjs"), `exports.run=async()=>{
      if(process.env.PKM_ENV_INSTALLED_PHASE==='initial')await require('./environments-installed.cjs').run();
      await require('./environments-execution-installed.cjs').run();};`);
    return extension;
  };
  let extension = install(upgrade ? baseline : overlay);
  fs.writeFileSync("driver/package.json", JSON.stringify({
    name: "pkm-environments-test-driver", publisher: "fixture", version: "0.0.1", engines: { vscode: "^1.90.0" },
  }));
  fs.writeFileSync("Xauthority", "", { mode: 0o600 });
  run("xauth", ["-f", env.XAUTHORITY, "add", env.DISPLAY, "MIT-MAGIC-COOKIE-1", randomBytes(16).toString("hex")]);
  const display = spawn(xvfb, [":91", "-screen", "0", "1280x800x24", "-nolock", "-nolisten", "unix",
    "-nolisten", "local", "-listen", "tcp", "-auth", env.XAUTHORITY], { cwd: root, env, stdio: ["ignore", "ignore", "pipe"] });
  try {
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      if (display.exitCode !== null) break;
      if (spawnSync("xdpyinfo", ["-display", env.DISPLAY], { env, stdio: "ignore", timeout: 1000 }).status === 0) { ready = true; break; }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert(ready, "Private display failed readiness check.");
    for (const phase of upgrade ? ["legacy", "initial", "reopen"] : ["initial", "reopen"]) {
      if (upgrade && phase === "initial") extension = install(overlay);
      if (execution && phase === "reopen") await new Promise(resolve => setTimeout(resolve, 4500));
      const journey = require("@vscode/test-electron").runTests({
        vscodeExecutablePath: editor, extensionDevelopmentPath: path.join(root, "driver"),
        extensionTestsPath: path.join(extension, upgrade ? "environments-upgrade-installed.cjs"
          : execution ? "environments-combined.cjs" : "environments-installed.cjs"),
        extensionTestsEnv: { ...env, PKM_ENV_INSTALLED_ROOT: root, PKM_ENV_INSTALLED_NODE: fs.realpathSync(process.execPath),
          PKM_ENV_INSTALLED_PHASE: phase, PKM_ENV_INSTALLED_AUTO_UPGRADE: upgrade ? "1" : "0",
          PKM_ENV_INSTALLED_MANAGEMENT: management ? "1" : "0", PKM_ENV_INSTALLED_MANAGERS: managers ? "1" : "0",
          PKM_ENV_INSTALLED_PYTHON_PROGRAM: pythonProgram ? "1" : "0",
          PKM_ENV_INSTALLED_NODE_PROJECT: nodeProject ? "1" : "0",
          PKM_ENV_INSTALLED_CONDA_LIFECYCLE: condaLifecycle ? "1" : "0",
          PKM_ENV_INSTALLED_CONDA_CRASH: condaCrash ? "1" : "0",
          PKM_ENV_INSTALLED_CONDA_PACKAGES: condaPackages ? "1" : "0",
          PKM_ENV_INSTALLED_PYTHON_PACKAGES: pythonPackages ? "1" : "0", PKM_ENV_INSTALLED_PIP_PYTHON: arg("pip-python") ?? "",
          PKM_ENV_INSTALLED_PYTHON_DELETE: pythonDelete ? "1" : "0",
          PKM_ENV_INSTALLED_PYTHON_DELETE_ONLY: pythonDeleteOnly ? "1" : "0",
          PKM_ENV_INSTALLED_CONDA: arg("conda") ?? "", PKM_ENV_INSTALLED_CONDA_CACHE: arg("conda-cache") ?? "" },
        launchArgs: [path.join(root, "workspace"), ...cliArgs, "--disable-gpu", "--disable-dev-shm-usage",
          "--disable-telemetry", "--disable-updates", "--skip-welcome", "--skip-release-notes", "--password-store=basic"],
      });
      if (condaCrash && phase === "initial")
        await require("./environments-installed-crash-control.cjs").awaitInstalledCrash(journey,
          { root, editor, userDataArgument: `--user-data-dir=${short}/u` });
      else await journey;
      if (phase === "legacy") legacyRegistrySha256 = hash(legacyRegistry);
    }
    assert.equal(hash(legacyRegistry), legacyRegistrySha256, "The old writer's emitted profile must stay byte-identical across activation/restart.");
    const sourceCacheAfter = managers ? cacheSnapshot(arg("conda-cache")) : undefined;
    if (managers) assert.equal(sourceCacheAfter, sourceCacheBefore, "Selected original cache changed during installed journey.");
    for (const [name, digest] of Object.entries(environmentSources))
      assert.equal(hash(path.join(sourceProject, name)), digest, "Environment source changed during this isolated installed qualification.");
    fs.writeFileSync(path.join(root, "overlay-evidence.json"), JSON.stringify({
      scope: "focused overlay installed candidate, not full production release or interactive UI qualification",
      baselineSha256: hash(baseline), baseCandidateSha256: hash(candidate), overlaySha256: hash(overlay),
      legacyRegistrySha256,
      freshRuntimeBuildId: JSON.parse(fs.readFileSync(path.join(staged, "manifest.json"))).buildId,
      executionJourney: execution && !condaCrash && !pythonDeleteOnly,
      nodeProjectJourney: nodeProject,
      condaLifecycleJourney: condaLifecycle,
      installedCondaSIGKILLJourney: condaCrash,
      condaPackageTableJourney: condaPackages,
      pythonPackageAnalyticsInspectionJourney: pythonPackages, qualificationUnixUid: process.getuid(),
      pythonPermanentDeletionJourney: pythonDelete,
      pythonPermanentDeletionOnlyJourney: pythonDeleteOnly,
      environmentSourceSha256, environmentSources, controllerSources,
      ...(frozenRuntime ? { frozenRuntimeSource: frozenRuntime } : {}),
      automaticUpgradeJourney: upgrade,
      pythonManagementJourney: management,
      offlineManagersJourney: managers,
      reviewedNextPythonWorkflowJourney: pythonProgram,
      modules: Object.fromEntries(modules.map(module => [module, hash(path.join(build, `${module}.js`))])),
      sources: moduleSources,
      controller: { runner: hash(__filename), installedHarness: hash(path.join(sourceProject, "tests/next-trial-electron",
        upgrade ? "environments-upgrade-installed.cjs" : "environments-installed.cjs")),
        executionHarness: hash(path.join(sourceProject, "tests/next-trial-electron/environments-execution-installed.cjs")),
        managementHarness: hash(path.join(sourceProject, "tests/next-trial-electron/environments-management-installed.cjs")),
        managersHarness: hash(path.join(sourceProject, "tests/next-trial-electron/environments-managers-installed.cjs")),
        oldCondaFixture: hash(path.join(sourceProject, "tests/old-conda-create-fixture.cjs")) },
      noPackageInstallation: !managers, explicitOfflineLocalCondaProvisioning: managers,
      ...(managers ? { sourceCacheSnapshot: { before: sourceCacheBefore, after: sourceCacheAfter,
        scope: "cache root/top-level identities and attributes, repodata bytes; not an all-files forensic hash" } } : {}),
      noNetworkDownload: true, mcpPythonDeliberatelyUnconfigured: true,
    }, null, 2));
    assert(!fs.existsSync(path.join(root, "h/pkm-envs/pkm-mcp")), "No MCP runtime may be silently created.");
    console.log(`Environment installed evidence: ${root}`);
  } finally {
    if (display.exitCode === null && display.signalCode === null) {
      const stopped = new Promise(resolve => display.once("exit", resolve));
      display.kill("SIGTERM"); await stopped;
    }
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
