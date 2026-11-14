#!/usr/bin/env node
const path = require("path");
const { spawnSync } = require("child_process");
const manifest = require("../package.json");

const root = path.join(__dirname, "..");
const rehearsal = process.env.PKM_PACKAGE_NEXT_REHEARSAL === "1";
const output = path.join(root, `personal-knowledge-${manifest.version}.vsix`);
const npx = process.platform === "win32" ? "npx.cmd" : "npx";

// --prebuilt: the caller already ran the build and tests, so vsce's prepublish hook can skip rebuilding.
const env = { ...process.env, ...(process.argv.includes("--prebuilt") ? { PKM_PACKAGE_PREBUILT: "1" } : {}) };

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit", windowsHide: true, env });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed with status ${result.status}`);
}

if (rehearsal) {
  require("./package-next-rehearsal").packageRehearsal(
    path.join(root, `pkm-next-rehearsal-${manifest.version}.vsix`), { env });
} else {
  let staged = false;
  try {
    require("./next-rehearsal-runtime").stage(path.join(root, "next-runtime"), { production: true });
    staged = true;
    env.PKM_PACKAGE_NEXT_PAYLOAD_STAGED = "1";
    run(npx, ["vsce", "package", "--out", output]);
    run(process.execPath, [
      path.join(__dirname, "verify-vsix-package.js"),
      output,
      manifest.version,
      "stable",
    ]);
  } finally {
    if (staged) require("fs").rmSync(path.join(root, "next-runtime"), { recursive: true, force: true });
  }
}
