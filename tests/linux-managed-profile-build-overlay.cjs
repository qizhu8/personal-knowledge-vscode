"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { createHash } = require("node:crypto");

const project = path.resolve(__dirname, "../legacy");
const work = path.join(project, ".migration-test-work/profile-named-overlay-v6");
const baseline = path.join(project, ".migration-test-work/profile-automatic-overlay-build-v3/profile-4.0.47.vsix");
const compiled = path.join(project, ".migration-test-work/profile-named-focused/dist");
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", timeout: 120000 });
  if (result.error || result.status !== 0) throw result.error || new Error(`${command}: ${result.stderr}`);
}
fs.mkdirSync(work, { recursive: true, mode: 0o700 });
for (const version of ["4.0.52", "4.0.53"]) {
  const stage = path.join(work, `stage-${version}`), output = path.join(work, `profile-${version}.vsix`);
  if (fs.existsSync(stage) || fs.existsSync(output)) throw new Error(`Private candidate already exists: ${version}`);
  fs.mkdirSync(stage);
  run("unzip", ["-q", baseline, "-d", stage], project);
  const extension = path.join(stage, "extension");
  for (const relative of ["extension.js", "extension.js.map", "runtime/managed-profile-activation.js",
    "runtime/managed-profile-activation.js.map", "runtime/pkm-service.js", "runtime/pkm-service.js.map",
    "runtime/pkm-service-entry.js"]) {
    const target = path.join(extension, "dist", relative);
    if (fs.existsSync(path.join(compiled, relative))) fs.copyFileSync(path.join(compiled, relative), target);
  }
  const manifestPath = path.join(extension, "package.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath));
  if (manifest.version !== "4.0.47") throw new Error("Unexpected baseline package.");
  fs.writeFileSync(manifestPath, JSON.stringify({ ...manifest, version }, null, 2) + "\n");
  const payloadPath = path.join(extension, "next-runtime/manifest.json");
  const payload = JSON.parse(fs.readFileSync(payloadPath));
  if (payload.extensionVersion !== "4.0.33") throw new Error("Unexpected baseline payload.");
  fs.writeFileSync(payloadPath, JSON.stringify({ ...payload, extensionVersion: version }, null, 2));
  const xmlPath = path.join(stage, "extension.vsixmanifest");
  const xml = fs.readFileSync(xmlPath, "utf8");
  if (!xml.includes('Version="4.0.47"')) throw new Error("Unexpected VSIX identity.");
  fs.writeFileSync(xmlPath, xml.replace('Version="4.0.47"', `Version="${version}"`));
  const buildPath = path.join(extension, "dist/build-info.json"), build = JSON.parse(fs.readFileSync(buildPath));
  for (const name of ["dist/extension.js", "dist/runtime/managed-profile-activation.js", "dist/runtime/pkm-service.js",
    "dist/runtime/pkm-service-entry.js", "package.json"])
    build.files[name] = hash(fs.readFileSync(path.join(extension, name)));
  build.version = version;
  build.buildId = hash(JSON.stringify(build.files));
  build.builtAt = new Date().toISOString();
  fs.writeFileSync(buildPath, JSON.stringify(build, null, 2));
  run("zip", ["-qrD", output, "."], stage);
  console.log("PRIVATE_PROFILE_OVERLAY", JSON.stringify({ version, output, sha256: hash(fs.readFileSync(output)), buildId: build.buildId }));
}
