#!/usr/bin/env node
"use strict";
const fs = require("node:fs"), path = require("node:path"), { randomUUID, createHash } = require("node:crypto");
const { spawnSync } = require("node:child_process");
const project = path.resolve(__dirname, "..");
const arg = key => process.argv.find(item => item.startsWith(`--${key}=`))?.slice(key.length + 3);
async function main() {
  const build = arg("root-build"), conda = arg("conda"), cache = arg("cache"), python = arg("python"), vsix = arg("legacy-vsix");
  if ([build, conda, cache, python, vsix].some(item => !item || !path.isAbsolute(item)))
    throw new Error("Explicit absolute local --root-build, --conda, --cache, --python and --legacy-vsix are required; no installers.");
  if (createHash("sha256").update(fs.readFileSync(vsix)).digest("hex") !== "1804071cb3b9fc86edc5933d5001db6ea1a8d7a9adf30d6d2b3166fcd6048f27")
    throw new Error("The frozen exact old 4.0.22 VSIX pin does not match; no old code was executed.");
  const root = arg("root") || path.join(project, ".migration-test-work", `environment-managers-qualification-${randomUUID()}`);
  const run = (command, args, env) => {
    const result = spawnSync(command, args, { cwd: root, env, encoding: "utf8", timeout: 180000, maxBuffer: 2 * 1024 * 1024 });
    if (result.error || result.status) throw new Error(`${result.stdout}\n${result.stderr}\n${result.error ?? result.status}`);
    return result.stdout;
  };
  if (!process.argv.includes("--inside")) {
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    for (const name of ["home", "scratch", "managers"]) fs.mkdirSync(path.join(root, name), { mode: 0o700 });
    const output = run("unshare", require("./run-next-trial-private-display").privateNamespaceArgs([
      process.execPath, __filename, ...process.argv.slice(2), `--root=${root}`, "--inside",
    ]), { PATH: process.env.PATH, HOME: path.join(root, "home"), TMPDIR: path.join(root, "scratch") });
    console.log(output.trim()); console.log(`Manager/old Recipe qualification evidence: ${root}`); return;
  }
  const env = { PATH: "/usr/bin:/bin", HOME: path.join(root, "home"), TMPDIR: path.join(root, "scratch"),
    PYTHONDONTWRITEBYTECODE: "1", PYTHONNOUSERSITE: "1" };
  require("../tests/private-linux-account-fixture.cjs")(root, env.HOME);
  const managers = JSON.parse(run(process.execPath, [path.join(project, "tests/local-python-manager-fixture.cjs"),
    build, path.join(root, "managers"), conda, cache], env));
  fs.writeFileSync(path.join(root, "manager-lifecycle-evidence.json"), JSON.stringify(managers, null, 2));
  const old = await require("../tests/old-conda-create-fixture.cjs")({ root: path.join(root, "old-manager"),
    vsix, executable: conda, channel: `${managers.success.actualPrefix}-provision/channel` });
  const output = run(python, ["-I", "-B", path.join(project, "tests/old-python-recipe-journey.py"),
    root, vsix, fs.realpathSync(process.execPath), old.environment.path], env);
  console.log(output.trim());
}
main().catch(error => { console.error(error); process.exitCode = 1; });
