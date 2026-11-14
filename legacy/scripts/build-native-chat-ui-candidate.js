#!/usr/bin/env node
"use strict";
const fs = require("node:fs"), path = require("node:path"), { execFileSync } = require("node:child_process");
const { randomUUID, createHash } = require("node:crypto");
const assert = require("node:assert/strict");
const project = path.resolve(__dirname, ".."), scratch = path.join(project, ".migration-test-work", `native-chat-ui-build-${randomUUID()}`);
process.umask(0o077);
fs.mkdirSync(scratch, { recursive: true, mode: 0o700 });
const build = path.join(scratch, "build");
fs.mkdirSync(build); fs.mkdirSync(path.join(scratch, "t")); fs.mkdirSync(path.join(scratch, "h"));
const selected = ["package.json", "package-lock.json", "tsconfig.json", ".vscodeignore", "README.md", "CHANGELOG.md", "LICENSE", "FEATURES.md",
  ...fs.readdirSync(project).filter(name => /^package\.nls(?:\.[^.]+)?\.json$/.test(name)),
  "src", "scripts", "resources", "modules", "tools", "tests", "next-server", "docs"];
const accept = file => {
  const parts = file.split(path.sep), tests = parts.lastIndexOf("tests");
  if (tests >= 0 && parts[tests + 1]?.startsWith(".")) return false;
  return !["node_modules", "dist", "__pycache__", ".git"].includes(path.basename(file));
};
function snapshot(root) {
  const rows = {};
  function visit(file, relative) {
    if (!accept(file)) return;
    const stat = fs.lstatSync(file);
    if (stat.isDirectory()) for (const name of fs.readdirSync(file).sort()) visit(path.join(file, name), `${relative}/${name}`);
    else if (stat.isFile()) rows[relative] = createHash("sha256").update(fs.readFileSync(file)).digest("hex");
    else if (stat.isSymbolicLink()) rows[relative] = `link:${fs.readlinkSync(file)}`;
    else throw new Error(`Unexpected build source: ${relative}`);
  }
  for (const name of selected) if (fs.existsSync(path.join(root, name))) visit(path.join(root, name), name);
  return rows;
}
for (const name of selected) if (fs.existsSync(path.join(project, name)))
  fs.cpSync(path.join(project, name), path.join(build, name), { recursive: true, verbatimSymlinks: true, filter: accept });
const inputSource = snapshot(build);
assert.deepEqual(inputSource, snapshot(project), "Source changed during private build snapshot; no candidate was built.");
const inputSourceSha256 = createHash("sha256").update(JSON.stringify(inputSource)).digest("hex");
const candidateVersion = process.argv.find(argument => argument.startsWith("--candidate-version="))?.slice("--candidate-version=".length);
const originalManifest = JSON.parse(fs.readFileSync(path.join(build, "package.json")));
if (candidateVersion !== undefined) {
  const parse = version => {
    assert(/^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/.test(version), "A numeric three-part private candidate version is required.");
    return version.split(".").map(Number);
  };
  const previous = parse(originalManifest.version), next = parse(candidateVersion);
  const difference = next.findIndex((value, index) => value !== previous[index]);
  assert(difference >= 0 && next[difference] > previous[difference], "The private candidate must have a strictly newer version.");
  fs.writeFileSync(path.join(build, "package.json"), JSON.stringify({ ...originalManifest, version: candidateVersion }, null, 2) + "\n");
  const lockFile = path.join(build, "package-lock.json"), lock = JSON.parse(fs.readFileSync(lockFile));
  lock.version = candidateVersion;
  if (lock.packages?.[""]) lock.packages[""].version = candidateVersion;
  fs.writeFileSync(lockFile, JSON.stringify(lock, null, 2) + "\n");
  console.log("PRIVATE_CANDIDATE_VERSION_OVERLAY", originalManifest.version, candidateVersion, "staging only; repository version and historical pins unchanged");
}
const source = snapshot(build);
const sourceSha256 = createHash("sha256").update(JSON.stringify(source)).digest("hex");
fs.writeFileSync(path.join(scratch, "source.json"), JSON.stringify({
  sourceSha256, inputSourceSha256, originalVersion: originalManifest.version,
  candidateVersion: candidateVersion ?? originalManifest.version, files: source,
}), { mode: 0o600 });
console.log("SNAPSHOT_FROZEN", sourceSha256, scratch);
for (const directory of ["node_modules", "next-server/node_modules"])
  fs.cpSync(path.join(project, directory), path.join(build, directory), { recursive: true, verbatimSymlinks: true });
const env = { PATH: process.env.PATH, HOME: path.join(scratch, "h"), USERPROFILE: path.join(scratch, "h"),
  TMPDIR: path.join(scratch, "t"), TMP: path.join(scratch, "t"), TEMP: path.join(scratch, "t") };
Object.assign(process.env, env);
execFileSync("npm", ["run", "build"], { cwd: build, env, stdio: "inherit", timeout: 240000 });
require(path.join(build, "scripts/next-rehearsal-runtime.js")).stage(path.join(build, "next-runtime"), { production: true });
const vsix = path.join(scratch, "native-chat-ui-candidate.vsix");
console.log("FOCUSED EXPERIMENTAL PACKAGE ONLY: full release/package gate is not run.");
execFileSync("npx", ["--no-install", "vsce", "package", ...(candidateVersion ? ["--pre-release"] : []), "--out", vsix], { cwd: build,
  env: { ...env, PKM_PACKAGE_PREBUILT: "1", PKM_PACKAGE_NEXT_PAYLOAD_STAGED: "1" }, stdio: "inherit", timeout: 240000 });
execFileSync("python3", ["-B", "scripts/verify-next-payload.py", vsix], { cwd: build, env, stdio: "inherit", timeout: 60000 });
const vsixSha256 = createHash("sha256").update(fs.readFileSync(vsix)).digest("hex");
fs.writeFileSync(path.join(scratch, "candidate.json"), JSON.stringify({
  sourceSha256, inputSourceSha256, candidateVersion: candidateVersion ?? originalManifest.version, vsixSha256, vsix,
}), { mode: 0o600 });
console.log("PASS: frozen focused native Chat UI candidate", JSON.stringify({ sourceSha256, vsixSha256, vsix }));
