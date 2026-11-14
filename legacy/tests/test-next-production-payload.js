const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const test = require("node:test");
const ts = require("typescript");
const { stage } = require("../scripts/next-rehearsal-runtime");

const root = path.resolve(__dirname, "..");
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 180000, maxBuffer: 8 * 1024 * 1024, ...options });
  assert.equal(result.status, 0, `${command}: ${result.stderr || result.error || result.stdout}`);
  return result.stdout.trim();
}

test("production VSIX payload verifies and imports a disposable legacy copy", { timeout: 240000 }, t => {
  const work = fs.mkdtempSync(path.join(root, ".next-payload-test-"));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const project = path.join(work, "project");
  fs.mkdirSync(project);
  const payload = path.join(project, "next-runtime");
  stage(payload, { production: true });
  const extension = require("../package.json");
  fs.writeFileSync(path.join(project, "package.json"), JSON.stringify({
    name: "personal-knowledge", publisher: "Uone", version: extension.version,
    displayName: "PKM synthetic packaging test", description: "Isolated fixture",
    engines: { vscode: "^1.90.0" },
  }));
  fs.writeFileSync(path.join(project, "README.md"), "# Disposable fixture\n");
  fs.copyFileSync(path.join(root, ".vscodeignore"), path.join(project, ".vscodeignore"));
  const archive = path.join(work, "fixture.vsix");
  const env = { PATH: process.env.PATH, HOME: work, TMPDIR: work, TMP: work, TEMP: work };
  run("vsce", ["package", "--allow-missing-repository", "--skip-license", "--out", archive], { cwd: project, env });
  const python = run("python3", ["-I", "-B", "-c", "import sys; print(sys.executable)"]);
  const archiveVerifier = path.join(root, "scripts", "verify-next-payload.py");
  run(python, ["-I", "-B", archiveVerifier, archive], { cwd: work, env });
  const extracted = path.join(work, "unpacked");
  fs.mkdirSync(extracted);
  run(python, ["-I", "-B", "-c", "import sys,zipfile; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])",
    archive, extracted], { cwd: work, env });
  const installed = path.join(extracted, "extension");
  const installedPayload = path.join(installed, "next-runtime");
  const tsFile = path.join(root, "src", "runtime", "next-payload-verifier.ts");
  const output = ts.transpileModule(fs.readFileSync(tsFile, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const verifier = path.join(work, "verify.cjs");
  fs.writeFileSync(verifier, output);
  const verify = require(verifier).verifyNextPayload;
  assert.throws(() => verify(path.join(work, "missing-extension")), /Next-server payload invalid/);
  const value = verify(installed);
  assert.equal(value.entry, path.join(installedPayload, "server", "dist", "managed-client-child.js"));
  assert.equal(value.nodeRequirement, ">=22.18.0");
  if (process.platform === "linux") {
    const server = path.join(installedPayload, "server"), cli = path.join(server, "dist", "cli.js");
    const loader = path.join(work, "guard.mjs"), preload = path.join(work, "guard.cjs");
    fs.writeFileSync(loader, `
import {fileURLToPath} from "node:url";
import path from "node:path";
export async function resolve(specifier, context, nextResolve) {
 const result = await nextResolve(specifier, context);
 if (result.url.startsWith("file:") && !fileURLToPath(result.url).startsWith(process.env.PKM_TEST_RUNTIME + path.sep))
  throw new Error("ESM escaped isolated runtime: " + result.url);
 return result;
}
`);
    fs.writeFileSync(preload, `
const Module = require("node:module"), path = require("node:path"), original = Module._resolveFilename;
Module._resolveFilename = function(request, parent, ...rest) {
 const value = original.call(this, request, parent, ...rest), root = process.env.PKM_TEST_RUNTIME + path.sep;
 if (parent?.filename?.startsWith(root) && path.isAbsolute(value) && !value.startsWith(root))
  throw new Error("CommonJS escaped isolated runtime: " + value);
 return value;
};
`);
    const runtimeEnv = { ...env, PKM_TEST_RUNTIME: server,
      NODE_OPTIONS: `--require=${preload} --experimental-loader=${loader}`, PYTHONDONTWRITEBYTECODE: "1",
      HTTP_PROXY: "http://127.0.0.1:1", HTTPS_PROXY: "http://127.0.0.1:1", ALL_PROXY: "http://127.0.0.1:1" };
    const source = path.join(work, "source"), destination = path.join(work, "destination");
    const note = "---\ntitle: Design\ndocumentId: design-note\nrevision: 3\n---\n![image](_assets/0123456789abcdef.png)\n";
    const asset = Buffer.from([0, 255, 7, 42]);
    fs.mkdirSync(path.join(source, "notes", "Team", "_assets"), { recursive: true });
    fs.mkdirSync(path.join(source, "skills", "Team"), { recursive: true });
    fs.mkdirSync(path.join(source, "papers", "Topic"), { recursive: true });
    fs.mkdirSync(path.join(source, "prompts", "project", "task", "v1"), { recursive: true });
    fs.writeFileSync(path.join(source, "notes", "Team", "Design.md"), note);
    fs.writeFileSync(path.join(source, "notes", "Team", "_assets", "0123456789abcdef.png"), asset);
    fs.writeFileSync(path.join(source, "skills", "Team", "Skill.md"), "---\nname: Skill\ndocumentId: skill-a\n---\nSkill body\n");
    fs.writeFileSync(path.join(source, "papers", "Topic", "Paper.md"), "---\ntitle: Paper\ndocumentId: paper-a\n---\nPaper body\n");
    fs.writeFileSync(path.join(source, "prompts", "project", "task", "v1", "template.jinja2"), "Hello {{ name }}\n");
    const ack = "--acknowledge-quiescent-disposable-copy";
    const cliRun = (...args) => JSON.parse(run(process.execPath, [cli, ...args], { cwd: work, env: runtimeEnv }));
    const planned = cliRun("import-plan", "--source", source, ack).plan;
    assert.equal(planned.ready, true, JSON.stringify(planned.blockers));
    const receipt = cliRun("import", "--source", source, "--destination", destination,
      "--plan-sha256", planned.planSha256, "--python", python, ack).receipt;
    assert.equal(receipt.fingerprint, planned.fingerprint);
    const outcome = cliRun("import-status", "--destination", destination).outcome;
    assert.equal(outcome.status, "published");
    assert.deepEqual(outcome.receipt, receipt);
    assert.equal(fs.readFileSync(path.join(destination, "notes", "Team", "Design.md"), "utf8"), note);
    assert.deepEqual(fs.readFileSync(path.join(destination, "notes", "Team", "_assets", "0123456789abcdef.png")), asset);
    assert.match(fs.readFileSync(path.join(destination, "skills", "Team", "Skill.md"), "utf8"), /Skill body/);
    assert.match(fs.readFileSync(path.join(destination, "papers", "Topic", "Paper.md"), "utf8"), /Paper body/);
    assert.equal(fs.readFileSync(path.join(destination, "prompts", "project", "task", "v1", "template.jinja2"), "utf8"), "Hello {{ name }}\n");
    assert.equal(fs.readFileSync(path.join(source, "notes", "Team", "Design.md"), "utf8"), note);
    const absent = path.join(work, "absent-destination");
    const noPython = spawnSync(process.execPath, [cli, "import", "--source", source, "--destination", absent,
      "--plan-sha256", planned.planSha256, "--python", path.join(work, "missing-python"), ack], {
      cwd: work, env: runtimeEnv, encoding: "utf8", timeout: 60000,
    });
    assert.notEqual(noPython.status, 0);
    assert.match(noPython.stderr, /python|ENOENT|unavailable/i);
    assert.equal(fs.existsSync(absent), false);
    fs.appendFileSync(path.join(source, "notes", "Team", "Design.md"), "changed\n");
    const stale = spawnSync(process.execPath, [cli, "import", "--source", source, "--destination", absent,
      "--plan-sha256", planned.planSha256, "--python", python, ack], {
      cwd: work, env: runtimeEnv, encoding: "utf8", timeout: 60000,
    });
    assert.notEqual(stale.status, 0);
    assert.match(stale.stderr, /source no longer matches the approved plan/i);
    assert.equal(fs.existsSync(absent), false);
    fs.writeFileSync(path.join(source, "notes", "Team", "Design.md"), note);
    const refreshedPlan = cliRun("import-plan", "--source", source, ack).plan;
    assert.equal(refreshedPlan.ready, true);
    const duplicate = spawnSync(process.execPath, [cli, "import", "--source", source, "--destination", destination,
      "--plan-sha256", refreshedPlan.planSha256, "--python", python, ack], {
      cwd: work, env: runtimeEnv, encoding: "utf8", timeout: 60000,
    });
    assert.notEqual(duplicate.status, 0);
    assert.match(duplicate.stderr, /destination.*exist|already exists/i);
    assert.equal(fs.readFileSync(path.join(destination, "notes", "Team", "Design.md"), "utf8"), note);
  }
  const importFile = path.join(installedPayload, "server", "dist", "legacy-import-cli.js");
  const importBytes = fs.readFileSync(importFile);
  const manifestFile = path.join(installedPayload, "manifest.json");
  const manifestBytes = fs.readFileSync(manifestFile);
  const manifest = JSON.parse(manifestBytes);
  delete manifest.files["server/dist/legacy-import-cli.js"];
  manifest.buildId = createHash("sha256").update(JSON.stringify(manifest.files)).digest("hex");
  fs.unlinkSync(importFile);
  fs.writeFileSync(manifestFile, JSON.stringify(manifest));
  assert.throws(() => verify(installed), /required file missing from inventory/);
  fs.writeFileSync(importFile, importBytes);
  fs.writeFileSync(manifestFile, manifestBytes);
  const dependency = path.join(installedPayload, "server", "node_modules", "zod", "package.json");
  const dependencyBytes = fs.readFileSync(dependency);
  fs.unlinkSync(dependency);
  assert.throws(() => verify(installed), /inventory differs|missing/);
  fs.writeFileSync(dependency, dependencyBytes);
  verify(installed);
  const name = path.join(installedPayload, "server", "dist", "managed-client-child.js");
  const bytes = fs.readFileSync(name);
  fs.writeFileSync(name, Buffer.concat([bytes, Buffer.from("tampered")]));
  assert.throws(() => verify(installed), /digest mismatch/);
  fs.unlinkSync(name);
  assert.throws(() => verify(installed), /inventory differs|missing/);
  fs.symlinkSync(path.join(work, "unrelated"), name);
  assert.throws(() => verify(installed), /link forbidden/);
  fs.unlinkSync(name);
  fs.writeFileSync(name, bytes);
  const packageFile = path.join(installed, "package.json");
  const packageBytes = fs.readFileSync(packageFile);
  fs.writeFileSync(packageFile, JSON.stringify({ ...JSON.parse(packageBytes), version: "999.0.0" }));
  assert.throws(() => verify(installed), /version mismatch/);
  fs.writeFileSync(packageFile, packageBytes);
  const missingPython = spawnSync(process.execPath, [path.join(installedPayload, "check.cjs"), path.join(work, "missing-python")], {
    cwd: work, env, encoding: "utf8",
  });
  assert.notEqual(missingPython.status, 0);
  assert.match(missingPython.stderr, /Python >=3.10/);
  const altered = path.join(work, "altered.vsix");
  for (const [mode, target] of [["missing", "managed-client-child.js"], ["tamper", "managed-client-child.js"],
    ["missing", "legacy-import-cli.js"], ["tamper", "legacy-import-cli.js"]]) {
    run(python, ["-I", "-B", "-c", `
import sys, zipfile
with zipfile.ZipFile(sys.argv[1]) as source, zipfile.ZipFile(sys.argv[2], "w") as target:
 for item in source.infolist():
  if item.filename.endswith("/server/dist/" + sys.argv[4]):
   if sys.argv[3] == "missing": continue
   target.writestr(item, source.read(item) + b"bad")
  else: target.writestr(item, source.read(item))
`, archive, altered, mode, target], { cwd: work, env });
    const bad = spawnSync(python, ["-I", "-B", archiveVerifier, altered], { cwd: work, env, encoding: "utf8" });
    assert.notEqual(bad.status, 0);
    assert.match(bad.stderr, /inventory mismatch|digest mismatch/);
  }
});
