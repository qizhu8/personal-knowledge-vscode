#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { stage } = require("./next-rehearsal-runtime");

const root = path.resolve(__dirname, "..");
const identity = "pkm-experimental.pkm-next-rehearsal";

function run(command, args, options) {
  const result = spawnSync(command, args, { stdio: "inherit", timeout: 180000, ...options });
  if (result.error || result.status !== 0) throw result.error || new Error(`${command} failed with status ${result.status}`);
}

function packageRehearsal(output, { env = process.env } = {}) {
  if (!path.isAbsolute(output)) throw new Error("An absolute output path is required.");
  const work = fs.mkdtempSync(path.join(root, ".next-rehearsal-package-"));
  try {
    stage(path.join(work, "next-runtime"));
    fs.writeFileSync(path.join(work, "package.json"), JSON.stringify({
      name: "pkm-next-rehearsal", publisher: "pkm-experimental",
      version: require("../package.json").version,
      displayName: "PKM Next Rehearsal (Experimental)",
      description: "Isolated migration rehearsal payload; no production integration.",
      engines: { vscode: "^1.90.0" },
    }, null, 2));
    fs.writeFileSync(path.join(work, "README.md"), "# PKM Next Rehearsal\n\nExperimental payload only. No production migration or activation.\n");
    fs.copyFileSync(path.join(root, "LICENSE"), path.join(work, "LICENSE"));
    const npx = process.platform === "win32" ? "npx.cmd" : "npx";
    run(npx, ["--no-install", "vsce", "package", "--no-dependencies", "--allow-missing-repository", "--out", output], {
      cwd: work, env,
    });
    run(env.PYTHON || (process.platform === "win32" ? "python" : "python3"), [
      "-B", path.join(root, "scripts", "verify-next-rehearsal.py"), output,
    ], { cwd: work, env });
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

if (require.main === module) {
  packageRehearsal(path.join(root, `pkm-next-rehearsal-${require("../package.json").version}.vsix`));
}
module.exports = { packageRehearsal, identity };
