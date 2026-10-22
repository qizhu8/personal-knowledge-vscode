const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const http = require("node:http");
const { importGitSource, updateGitSource, validateGitSource } = require("../dist/knowledge/git-source");
const { importGitPackage, updateGitPackage } = require("../dist/knowledge/git-package");
const servers = require("../dist/servers/servers");
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding:"utf8", stdio:["ignore", "pipe", "pipe"] }).trim();

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-git-source-test-"));
  t.after(() => fs.rmSync(root, { recursive:true, force:true }));
  const seed = path.join(root, "seed"), remote = path.join(root, "remote.git");
  fs.mkdirSync(seed);
  git(root, "init", "--bare", remote);
  git(seed, "init", "-b", "feature/source");
  git(seed, "config", "user.email", "fixture@example.test");
  git(seed, "config", "user.name", "Fixture");
  fs.writeFileSync(path.join(seed, "README.md"), "source v1\n");
  fs.writeFileSync(path.join(seed, "__proto__"), "a real source filename\n");
  const marker = path.join(root, "must-not-run");
  fs.mkdirSync(path.join(seed, ".pkm-disabled-hooks"));
  fs.writeFileSync(path.join(seed, ".pkm-disabled-hooks", "post-checkout"), `#!/bin/sh\ntouch '${marker}'\n`, { mode:0o755 });
  fs.writeFileSync(path.join(seed, "package.json"), JSON.stringify({ scripts:{ postinstall:`touch '${marker}'` } }));
  git(seed, "add", ".");
  git(seed, "commit", "-m", "source");
  git(seed, "remote", "add", "origin", remote);
  git(seed, "push", "-u", "origin", "feature/source");
  function advance(text) {
    fs.writeFileSync(path.join(seed, "README.md"), text);
    git(seed, "add", "README.md"); git(seed, "commit", "-m", text); git(seed, "push");
  }
  return { root, seed, remote, marker, advance };
}

test("Git source uses an explicit branch, fast-forwards, refuses local changes/divergence and never executes repository hooks", async t => {
  const { root, remote, marker, advance } = fixture(t);
  const directory = path.join(root, "checkout");
  const source = await importGitSource(directory, remote, "feature/source");
  assert.equal(git(directory, "branch", "--show-current"), "feature/source");
  assert.equal(fs.existsSync(marker), false);
  await assert.rejects(importGitSource(directory, remote, "feature/source"), /exist/i);
  git(directory, "remote", "set-url", "origin", path.join(root, "another.git"));
  await assert.rejects(updateGitSource(directory, source), /origin changed/);
  git(directory, "remote", "set-url", "origin", remote);
  git(directory, "checkout", "-b", "wrong-branch");
  await assert.rejects(updateGitSource(directory, source), /branch changed/);
  git(directory, "checkout", "feature/source");
  fs.writeFileSync(path.join(directory, "extra.txt"), "keep");
  await assert.rejects(updateGitSource(directory, source), /local changes or untracked/);
  fs.unlinkSync(path.join(directory, "extra.txt"));
  fs.writeFileSync(path.join(directory, "README.md"), "local");
  await assert.rejects(updateGitSource(directory, source), /local changes/);
  fs.writeFileSync(path.join(directory, "README.md"), "source v1\n");
  advance("source v2\n");
  const next = await updateGitSource(directory, source);
  assert.notEqual(next.revision, source.revision);
  assert.equal(fs.readFileSync(path.join(directory, "README.md"), "utf8"), "source v2\n");
  git(directory, "config", "user.email", "fixture@example.test"); git(directory, "config", "user.name", "Fixture");
  fs.writeFileSync(path.join(directory, "local.txt"), "local commit");
  git(directory, "add", "local.txt"); git(directory, "commit", "-m", "local");
  const before = git(directory, "rev-parse", "HEAD");
  advance("source v3\n");
  await assert.rejects(updateGitSource(directory, next), /ahead or diverged/);
  assert.equal(git(directory, "rev-parse", "HEAD"), before);
  assert.equal(fs.existsSync(marker), false);
  for (const url of ["https://user:token@example.test/repo", "ext::evil", "-x", "http://example.test/repo"]) assert.throws(() => validateGitSource(url, "main"));
  await assert.rejects(importGitSource(path.join(root, "missing"), remote, "missing-branch"));
  assert.equal(fs.existsSync(path.join(root, "missing")), false);
});

test("Git package snapshots update atomically and preserve locally edited or additional files", async t => {
  const { root, remote, marker, advance } = fixture(t);
  const packages = path.join(root, "packages"), checkouts = path.join(root, "cache");
  await importGitPackage(packages, checkouts, "example", remote, "feature/source");
  const target = path.join(packages, "example");
  assert.equal(fs.existsSync(path.join(target, ".git")), false);
  assert.equal(fs.readFileSync(path.join(target, "__proto__"), "utf8"), "a real source filename\n");
  advance("package v2\n");
  await updateGitPackage(packages, checkouts, "example");
  assert.equal(fs.readFileSync(path.join(target, "README.md"), "utf8"), "package v2\n");
  fs.writeFileSync(path.join(target, "README.md"), "local");
  await assert.rejects(updateGitPackage(packages, checkouts, "example"), /local changes/);
  assert.equal(fs.readFileSync(path.join(target, "README.md"), "utf8"), "local");
  fs.writeFileSync(path.join(target, "README.md"), "package v2\n");
  fs.writeFileSync(path.join(target, "extra.txt"), "keep");
  await assert.rejects(updateGitPackage(packages, checkouts, "example"), /extra files/);
  assert.equal(fs.readFileSync(path.join(target, "extra.txt"), "utf8"), "keep");
  await assert.rejects(importGitPackage(packages, checkouts, "example", remote, "feature/source"), /already exists/);
  assert.equal(fs.readFileSync(path.join(target, "extra.txt"), "utf8"), "keep");
  assert.equal(fs.existsSync(marker), false);
  await assert.rejects(importGitPackage(packages, checkouts, "../escape", remote, "feature/source"), /package name/);
});

test("managed Git server import persists provenance, never starts, opens checkout and updates only when stopped", async t => {
  const { root, remote, marker, advance } = fixture(t);
  servers.initServers(path.join(root, "servers"), path.join(root, "runtime"), 0);
  t.after(() => servers.disposeServers());
  const slug = await servers.serverImportGit("Example", remote, "feature/source", `touch '${marker}'`);
  const manifestPath = path.join(root, "servers", slug, "server.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath));
  assert.equal(manifest.autostart, false);
  assert.equal(manifest.git.branch, "feature/source");
  assert.equal(servers.serverDir(slug), path.join(root, "runtime", "checkouts", slug));
  assert.equal(fs.existsSync(marker), false);
  servers.serverUpdate(slug, { name:"Renamed" });
  assert.deepEqual(JSON.parse(fs.readFileSync(manifestPath)).git, manifest.git);
  advance("server v2\n");
  await servers.serverUpdateGit(slug);
  assert.equal(fs.readFileSync(path.join(servers.serverDir(slug), "README.md"), "utf8"), "server v2\n");
  const listener = http.createServer();
  await new Promise(resolve => listener.listen(0, "127.0.0.1", resolve));
  try {
    servers.serverUpdate(slug, { port:listener.address().port });
    await assert.rejects(servers.serverUpdateGit(slug), /listener/);
  } finally { await new Promise(resolve => listener.close(resolve)); }
  const checkout = servers.serverDir(slug);
  fs.renameSync(checkout, checkout + "-retained");
  await servers.serverUpdateGit(slug);
  assert.equal(fs.readFileSync(path.join(checkout, "README.md"), "utf8"), "server v2\n", "another Host can explicitly restore a missing local checkout");
  fs.writeFileSync(path.join(servers.serverDir(slug), "README.md"), "local");
  await assert.rejects(servers.serverUpdateGit(slug), /local changes/);
  assert.equal(fs.existsSync(marker), false);
});
