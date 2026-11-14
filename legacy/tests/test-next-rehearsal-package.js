const assert = require("node:assert/strict");
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { packageRehearsal, identity } = require("../scripts/package-next-rehearsal");

const root = path.resolve(__dirname, "..");
const verifier = path.join(root, "scripts", "verify-next-rehearsal.py");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 120000, maxBuffer: 8 * 1024 * 1024, ...options });
  assert.equal(result.status, 0, `${command}: ${result.stderr || result.error || result.stdout}`);
  return result.stdout.trim();
}

test("pinned VSIX payload imports a disposable workspace without repository dependencies", { timeout: 240000 }, async t => {
  const work = fs.mkdtempSync(path.join(root, ".next-rehearsal-test-"));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const project = path.join(work, "extension-project");
  fs.mkdirSync(project);
  const archive = path.join(work, "payload.vsix");
  const python = run("python3", ["-I", "-B", "-c", "import sys; print(sys.executable)"]);
  const isolatedEnv = { PATH: process.env.PATH, HOME: work, TMPDIR: work, TMP: work, TEMP: work,
    XDG_CONFIG_HOME: path.join(work, "config"), XDG_CACHE_HOME: path.join(work, "cache"),
    XDG_DATA_HOME: path.join(work, "data"), PYTHON: python,
    HTTP_PROXY: "http://127.0.0.1:1", HTTPS_PROXY: "http://127.0.0.1:1", ALL_PROXY: "http://127.0.0.1:1" };
  fs.writeFileSync(path.join(project, "package.json"), JSON.stringify({
    name: "pkm-next-rehearsal-test", displayName: "PKM Next Rehearsal Test",
    publisher: "pkm-test", version: "0.0.1", engines: { vscode: "^1.90.0" },
    description: "Isolated synthetic packaging test",
  }));
  fs.writeFileSync(path.join(project, "README.md"), "# Isolated rehearsal fixture\n");
  fs.mkdirSync(path.join(project, "next-runtime"));
  fs.writeFileSync(path.join(project, "next-runtime", "private-fixture.txt"), "not for packaging");
  fs.mkdirSync(path.join(project, "next-server"));
  fs.writeFileSync(path.join(project, "next-server", "private-fixture.txt"), "not for packaging");
  fs.copyFileSync(path.join(root, ".vscodeignore"), path.join(project, ".vscodeignore"));
  const normalFiles = run("vsce", ["ls", "--no-dependencies"], {
    cwd: project, env: { ...process.env, HOME: work, TMPDIR: work, TMP: work, TEMP: work },
  });
  assert.doesNotMatch(normalFiles, /next-server\//);
  packageRehearsal(archive, { env: isolatedEnv });
  await t.test("install and uninstall in an isolated VS Code profile", subtest => {
    const configured = process.env.PKM_VSCODE_EXECUTABLE;
    const cached = path.join(process.env.HOME || "", ".cache/pkm-vscode-test/vscode-linux-x64-1.143.0/bin/code");
    const launcher = configured
      ? path.basename(configured) === "code" && fs.existsSync(path.join(path.dirname(configured), "bin", "code"))
        ? path.join(path.dirname(configured), "bin", "code") : configured
      : cached;
    if (!fs.existsSync(launcher)) return subtest.skip("VS Code CLI unavailable; isolated installation not exercised");
    const extensions = path.join(work, "vscode-extensions"), userData = path.join(work, "vscode-user-data");
    fs.mkdirSync(extensions); fs.mkdirSync(userData);
    const common = ["--extensions-dir", extensions, "--user-data-dir", userData];
    run(launcher, [...common, "--install-extension", archive, "--force"], { cwd: work, env: isolatedEnv });
    const list = run(launcher, [...common, "--list-extensions", "--show-versions"], { cwd: work, env: isolatedEnv });
    assert.match(list, new RegExp(`^${identity.replaceAll(".", "\\.")}@`, "m"));
    assert.doesNotMatch(list, /^Uone\.personal-knowledge@/im);
    const installed = fs.readdirSync(extensions).find(name => name.toLowerCase().startsWith(`${identity}-`));
    assert.ok(installed, "experimental VSIX must be installed in the isolated extensions directory");
    const installedRoot = path.join(extensions, installed);
    const installedManifest = JSON.parse(fs.readFileSync(path.join(installedRoot, "package.json")));
    assert.equal(`${installedManifest.publisher}.${installedManifest.name}`, identity);
    run(process.execPath, [path.join(installedRoot, "next-runtime", "check.cjs"), python], { cwd: work, env: isolatedEnv });
    const installedServer = path.join(installedRoot, "next-runtime", "server");
    const installedGuard = path.join(work, "installed-guard.mjs");
    const installedPreload = path.join(work, "installed-guard.cjs");
    fs.writeFileSync(installedGuard, `
import {fileURLToPath} from "node:url";
import path from "node:path";
export async function resolve(specifier, context, nextResolve) {
 const result = await nextResolve(specifier, context);
 if (result.url.startsWith("file:") && !fileURLToPath(result.url).startsWith(process.env.PKM_TEST_RUNTIME + path.sep))
  throw new Error("ESM escaped installed runtime: " + result.url);
 return result;
}
`);
    fs.writeFileSync(installedPreload, `
const Module = require("node:module"), path = require("node:path"), original = Module._resolveFilename;
Module._resolveFilename = function(request, parent, ...rest) {
 const value = original.call(this, request, parent, ...rest), root = process.env.PKM_TEST_RUNTIME + path.sep;
 if (parent?.filename?.startsWith(root) && path.isAbsolute(value) && !value.startsWith(root))
  throw new Error("CommonJS escaped installed runtime: " + value);
 return value;
};
`);
    const installSource = path.join(work, "installed-source");
    fs.mkdirSync(path.join(installSource, "notes"), { recursive: true });
    fs.writeFileSync(path.join(installSource, "notes", "Installed.md"), "---\ntitle: Installed fixture\n---\n");
    const installedPlan = JSON.parse(run(process.execPath, [
      path.join(installedServer, "dist", "cli.js"), "import-plan", "--source", installSource,
      "--acknowledge-quiescent-disposable-copy",
    ], { cwd: work, env: { ...isolatedEnv, PKM_TEST_RUNTIME: installedServer,
      NODE_OPTIONS: `--require=${installedPreload} --experimental-loader=${installedGuard}` } }));
    assert.equal(installedPlan.plan.ready, true, JSON.stringify(installedPlan.plan.blockers));
    run(launcher, [...common, "--uninstall-extension", identity], { cwd: work, env: isolatedEnv });
    const after = run(launcher, [...common, "--list-extensions"], { cwd: work, env: isolatedEnv });
    assert.doesNotMatch(after, new RegExp(`^${identity.replaceAll(".", "\\.")}$`, "m"));
  });
  const extracted = path.join(work, "isolated");
  fs.mkdirSync(extracted);
  run(python, ["-I", "-B", verifier, archive, extracted]);
  const runtimeRoot = path.join(extracted, "extension", "next-runtime");
  const check = path.join(runtimeRoot, "check.cjs");
  run(process.execPath, [check, python], { cwd: work, env: isolatedEnv });
  if (process.platform === "linux") {
    const probe = run(process.execPath, [check, python, "--probe-parent", work], { cwd: work, env: isolatedEnv });
    assert.match(probe, /collision and directory fsync/);
    assert.deepEqual(fs.readdirSync(work).filter(name => name.startsWith(".pkm-next-probe-")), []);
    const fake = path.join(work, "fake-python");
    fs.writeFileSync(fake, "#!/bin/sh\nif [ \"$#\" -ge 5 ]; then echo simulated-kernel-denial >&2; exit 73; fi\nprintf '3.11.0\\n'\n", { mode: 0o700 });
    const blockedFs = spawnSync(process.execPath, [check, fake, "--probe-parent", work], { cwd: work, env: isolatedEnv, encoding: "utf8" });
    assert.notEqual(blockedFs.status, 0);
    assert.match(blockedFs.stderr, /Linux filesystem publication probe failed.*simulated-kernel-denial/);
    assert.deepEqual(fs.readdirSync(work).filter(name => name.startsWith(".pkm-next-probe-")), []);
  }
  const noPython = spawnSync(process.execPath, [check, path.join(work, "missing-python")], { cwd: work, env: isolatedEnv, encoding: "utf8" });
  assert.notEqual(noPython.status, 0);
  assert.match(noPython.stderr, /Python >=3.10, standard library or ctypes no-replace API unavailable/);
  const noPathPython = spawnSync(process.execPath, [check, python], { cwd: work, env: { ...isolatedEnv, PATH: work }, encoding: "utf8" });
  assert.notEqual(noPathPython.status, 0);
  assert.match(noPathPython.stderr, /PATH python3 >=3.10 with the standard library is required/);
  const zod = path.join(runtimeRoot, "server", "node_modules", "zod", "package.json");
  const zodBytes = fs.readFileSync(zod);
  fs.unlinkSync(zod);
  const noZod = spawnSync(process.execPath, [check, python], { cwd: work, env: isolatedEnv, encoding: "utf8" });
  assert.notEqual(noZod.status, 0);
  assert.match(noZod.stderr, /Missing runtime dependency: server\/node_modules\/zod\/package.json/);
  fs.writeFileSync(zod, zodBytes);
  run(process.execPath, [check, python], { cwd: work, env: isolatedEnv });
  const runtime = path.join(extracted, "extension", "next-runtime", "server");
  const loader = path.join(work, "guard.mjs"), preload = path.join(work, "guard.cjs");
  fs.writeFileSync(loader, `
import { fileURLToPath } from "node:url";
import path from "node:path";
const root = process.env.PKM_TEST_RUNTIME + path.sep;
export async function resolve(specifier, context, nextResolve) {
 const result = await nextResolve(specifier, context);
 if (result.url.startsWith("file:") && !fileURLToPath(result.url).startsWith(root))
  throw new Error("ESM escaped isolated runtime: " + result.url);
 return result;
}
`);
  fs.writeFileSync(preload, `
const Module = require("node:module"), path = require("node:path");
const resolve = Module._resolveFilename, root = process.env.PKM_TEST_RUNTIME + path.sep;
Module._resolveFilename = function(request, parent, ...rest) {
 const value = resolve.call(this, request, parent, ...rest);
 if (parent?.filename?.startsWith(root) && path.isAbsolute(value) && !value.startsWith(root))
  throw new Error("CommonJS escaped isolated runtime: " + value);
 return value;
};
`);
  const env = {
    PATH: process.env.PATH, HOME: work, TMPDIR: work, TMP: work, TEMP: work,
    PYTHONDONTWRITEBYTECODE: "1", PKM_TEST_RUNTIME: runtime,
    NODE_OPTIONS: `--require=${preload} --experimental-loader=${loader}`,
  };
  const cli = path.join(runtime, "dist", "cli.js");
  const source = path.join(work, "source"), destination = path.join(work, "destination");
  fs.mkdirSync(path.join(source, "notes", "Team", "_assets"), { recursive: true });
  fs.mkdirSync(path.join(source, "skills", "Team"), { recursive: true });
  fs.mkdirSync(path.join(source, "papers", "Topic"), { recursive: true });
  fs.mkdirSync(path.join(source, "prompts", "project", "task", "v1"), { recursive: true });
  const note = "---\ntitle: Design\ndocumentId: design-note\nrevision: 3\naliases: [note:Old/Design]\n---\n![image](_assets/0123456789abcdef.png)\n";
  const asset = Buffer.from([0, 255, 7, 42]);
  fs.writeFileSync(path.join(source, "notes", "Team", "Design.md"), note);
  fs.writeFileSync(path.join(source, "notes", "Team", "_assets", "0123456789abcdef.png"), asset);
  fs.writeFileSync(path.join(source, "skills", "Team", "Skill.md"), "---\nname: Skill\ndocumentId: skill-a\n---\nSkill body\n");
  fs.writeFileSync(path.join(source, "papers", "Topic", "Paper.md"), "---\ntitle: Paper\ndocumentId: paper-a\n---\nPaper body\n");
  fs.writeFileSync(path.join(source, "prompts", "project", "task", "v1", "template.jinja2"), "Hello {{ name }}\n");
  const ack = "--acknowledge-quiescent-disposable-copy";
  const removedZod = path.join(work, "missing-zod");
  fs.renameSync(path.join(runtime, "node_modules", "zod"), removedZod);
  try {
    const missingModule = spawnSync(process.execPath, [cli, "import-plan", "--source", source, ack], {
      cwd: work, env, encoding: "utf8", timeout: 30000,
    });
    assert.notEqual(missingModule.status, 0);
    assert.match(missingModule.stderr, /ERR_MODULE_NOT_FOUND|Cannot find package|escaped isolated runtime/);
  } finally { fs.renameSync(removedZod, path.join(runtime, "node_modules", "zod")); }
  const cliRun = (...args) => JSON.parse(run(process.execPath, [cli, ...args], { cwd: work, env }));
  const plan = cliRun("import-plan", "--source", source, ack).plan;
  assert.equal(plan.ready, true, JSON.stringify(plan.blockers));
  const changedNote = path.join(source, "notes", "Team", "Design.md");
  fs.appendFileSync(changedNote, "Changed\n");
  const stale = spawnSync(process.execPath, [cli, "import", "--source", source, "--destination", destination,
    "--plan-sha256", plan.planSha256, "--python", python, ack], { cwd: work, env, encoding: "utf8", timeout: 30000 });
  assert.notEqual(stale.status, 0);
  assert.match(stale.stderr, /no longer matches|blocked/i);
  assert.equal(fs.existsSync(destination), false);
  fs.writeFileSync(changedNote, note);
  const finalPlan = cliRun("import-plan", "--source", source, ack).plan;
  cliRun("import", "--source", source, "--destination", destination, "--plan-sha256", finalPlan.planSha256, "--python", python, ack);
  assert.equal(cliRun("import-status", "--destination", destination).outcome.status, "published");
  const collision = spawnSync(process.execPath, [cli, "import", "--source", source, "--destination", destination,
    "--plan-sha256", finalPlan.planSha256, "--python", python, ack], { cwd: work, env, encoding: "utf8", timeout: 30000 });
  assert.notEqual(collision.status, 0);
  assert.match(collision.stderr, /DESTINATION_EXISTS|destination already exists/i);
  assert.equal(fs.readFileSync(path.join(destination, "notes", "Team", "Design.md"), "utf8"), note);
  assert.deepEqual(fs.readFileSync(path.join(destination, "notes", "Team", "_assets", "0123456789abcdef.png")), asset);
  assert.equal(fs.readFileSync(path.join(destination, "prompts", "project", "task", "v1", "template.jinja2"), "utf8"), "Hello {{ name }}\n");
  const inventory = JSON.parse(run(python, ["-I", "-B", path.join(runtime, "compat", "legacy-note-inventory.py"), destination], {
    cwd: work, env, input: "{}",
  }));
  assert.equal(inventory.ok, true);
  assert.equal(inventory.notes[0].slug, "Team/Design");

  const token = "rehearsal-only-0123456789abcdef0123456789abcdef";
  const child = spawn(process.execPath, [cli, "http", "--data", destination, "--port", "0", "--read-only"], {
    cwd: work, env: { ...env, PKM_NEXT_TOKEN: token }, stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "", stderr = "";
  child.stdout.on("data", data => { stdout += data; });
  child.stderr.on("data", data => { stderr += data; });
  try {
    let url;
    for (let i = 0; i < 300 && !url; i++) {
      for (const line of stdout.split("\n")) {
        try { const value = JSON.parse(line); if (value.ready) url = value.url; } catch {}
      }
      if (child.exitCode !== null) throw new Error(`server exited: ${stderr}`);
      if (!url) await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.match(url || "", /^http:\/\/127\.0\.0\.1:\d+$/);
    const response = await fetch(url + "/v1/server_info", {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: "{}",
    });
    assert.equal(response.status, 200);
    const read = await fetch(url + "/v1/capability_read", {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ operation: "knowledge.document.get", version: 1, arguments: { id: "design-note" } }),
    });
    const body = await read.json();
    assert.equal(read.status, 200, JSON.stringify(body));
    assert.equal(body.result.revision, 3);
    assert.match(body.result.content, /0123456789abcdef/);
  } finally {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await new Promise(resolve => {
        const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
        child.once("exit", () => { clearTimeout(timer); resolve(); });
      });
    }
    const backup = path.join(work, "backup"), restored = path.join(work, "restored");
    cliRun("backup", "--data", destination, "--destination", backup);
    const restoreScript = path.join(work, "restore-fixture.mjs");
    fs.writeFileSync(restoreScript, `
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
const { restoreWorkspaceBackup } = await import(pathToFileURL(process.argv[2]).href);
const nativeRestoreAuthority = {
 actorId: "disposable-fixture-owner",
 authorize(request) {
    return { authorityId: "disposable-fixture", actorId: request.actorId,
     requestSha256: createHash("sha256").update(JSON.stringify(request)).digest("hex"),
     expiresAt: Date.now() + 60000, lineage: "unrelated", trustedEpoch: null };
 },
};
await restoreWorkspaceBackup(process.argv[3], process.argv[4], {pythonExecutable: process.argv[5], nativeRestoreAuthority});
`);
    // The driver is outside the runtime; its dynamic imports remain guarded.
    const restoreEnv = { ...env, NODE_OPTIONS: `--require=${preload} --experimental-loader=${loader}` };
    const restoreLoader = fs.readFileSync(loader, "utf8").replace(
      'if (result.url.startsWith("file:") && !fileURLToPath(result.url).startsWith(root))',
      'if (result.url.startsWith("file:") && !fileURLToPath(result.url).startsWith(root) && fileURLToPath(result.url) !== process.env.PKM_FIXTURE_DRIVER)');
    fs.writeFileSync(loader, restoreLoader);
    run(process.execPath, [restoreScript, path.join(runtime, "dist", "workspace-backup.js"), backup, restored, python], {
      cwd: work, env: { ...restoreEnv, PKM_FIXTURE_DRIVER: restoreScript }, timeout: 60000,
    });
    assert.equal(fs.readFileSync(path.join(restored, "notes", "Team", "Design.md"), "utf8"), note);
    assert.deepEqual(fs.readFileSync(path.join(restored, "notes", "Team", "_assets", "0123456789abcdef.png")), asset);
    assert.match(fs.readFileSync(path.join(restored, "skills", "Team", "Skill.md"), "utf8"), /Skill body/);
    assert.match(fs.readFileSync(path.join(restored, "papers", "Topic", "Paper.md"), "utf8"), /Paper body/);
    assert.equal(fs.readFileSync(path.join(restored, "prompts", "project", "task", "v1", "template.jinja2"), "utf8"), "Hello {{ name }}\n");
    assert.equal(fs.readFileSync(changedNote, "utf8"), note);
    assert.deepEqual(fs.readFileSync(path.join(source, "notes", "Team", "_assets", "0123456789abcdef.png")), asset);
    const nativeReadScript = path.join(work, "restored-read-fixture.mjs");
    fs.writeFileSync(nativeReadScript, `
import {pathToFileURL} from "node:url";
const {Storage} = await import(pathToFileURL(process.argv[2] + "/storage.js"));
const {Core} = await import(pathToFileURL(process.argv[2] + "/core.js"));
const storage = await Storage.open(process.argv[3]);
try {
 const result = await new Core(storage).dispatch("capability_read", {
    operation: "knowledge.document.get", version: 1, arguments: {id:"design-note"},
 }, {id:"fixture:reader", canWrite:false});
 if (result.error || result.result.revision !== 3 || !result.result.content.includes("0123456789abcdef"))
    throw new Error(JSON.stringify(result));
} finally { await storage.close(); }
`);
    run(process.execPath, [nativeReadScript, path.join(runtime, "dist"), restored], {
      cwd: work, env: { ...restoreEnv, PKM_FIXTURE_DRIVER: nativeReadScript }, timeout: 60000,
    });
  }
  const corrupt = path.join(work, "corrupt.vsix");
  run(python, ["-I", "-B", "-c", `
import sys, zipfile
with zipfile.ZipFile(sys.argv[1]) as source, zipfile.ZipFile(sys.argv[2], "w") as target:
 for item in source.infolist():
  data = source.read(item)
  if item.filename.endswith("/server/dist/cli.js"): data += b"tampered"
  target.writestr(item, data)
`, archive, corrupt]);
  const rejected = spawnSync(python, ["-I", "-B", verifier, corrupt], { encoding: "utf8" });
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /digest mismatch/);
  const extra = path.join(work, "extra.vsix");
  run(python, ["-I", "-B", "-c", `
import sys, zipfile
with zipfile.ZipFile(sys.argv[1]) as source, zipfile.ZipFile(sys.argv[2], "w") as target:
 for item in source.infolist(): target.writestr(item, source.read(item))
 target.writestr("extension/next-runtime/unlisted.txt", "unexpected")
`, archive, extra]);
  const rejectedExtra = spawnSync(python, ["-I", "-B", verifier, extra], { encoding: "utf8" });
  assert.notEqual(rejectedExtra.status, 0);
  assert.match(rejectedExtra.stderr, /inventory differs/);
  const missing = path.join(work, "missing.vsix");
  run(python, ["-I", "-B", "-c", `
import sys, zipfile
with zipfile.ZipFile(sys.argv[1]) as source, zipfile.ZipFile(sys.argv[2], "w") as target:
 for item in source.infolist():
  if not item.filename.endswith("/server/compat/legacy-knowledge-mcp.py"): target.writestr(item, source.read(item))
`, archive, missing]);
  const rejectedMissing = spawnSync(python, ["-I", "-B", verifier, missing], { encoding: "utf8" });
  assert.notEqual(rejectedMissing.status, 0);
  assert.match(rejectedMissing.stderr, /inventory differs/);
  const wrongIdentity = path.join(work, "wrong-identity.vsix");
  run(python, ["-I", "-B", "-c", `
import json, sys, zipfile
with zipfile.ZipFile(sys.argv[1]) as source, zipfile.ZipFile(sys.argv[2], "w") as target:
 for item in source.infolist():
  data = source.read(item)
  if item.filename == "extension/package.json":
   obj = json.loads(data); obj["publisher"] = "Uone"; obj["name"] = "personal-knowledge"
   data = json.dumps(obj).encode()
  target.writestr(item, data)
`, archive, wrongIdentity]);
  const rejectedIdentity = spawnSync(python, ["-I", "-B", verifier, wrongIdentity], { encoding: "utf8" });
  assert.notEqual(rejectedIdentity.status, 0);
  assert.match(rejectedIdentity.stderr, /Incorrect experimental extension identity/);
});
