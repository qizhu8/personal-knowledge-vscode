#!/usr/bin/env node
const assert = require("assert");
const { createHash } = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  GITHUB_SYNC_CONTENT_TYPES,
  defaultGitHubSyncSelection,
  discoverGitHubSshIdentities,
  fingerprintGitHubSyncEntries,
  githubSyncGitArguments,
  githubSyncRepositoryHttpsHost,
  githubSyncRepositorySshHost,
  githubSyncSafeRelativePath,
  githubSyncShield,
  githubSyncSshCommand,
  normalizeGitHubSyncTarget,
  parseGitHubCredentialManagerAccounts,
  parseGitHubSshLogin
} = require("../dist/github-sync.js");

const defaults = defaultGitHubSyncSelection();
for (const type of GITHUB_SYNC_CONTENT_TYPES) {
  assert.deepStrictEqual(defaults.public[type], { items: [], folders: ["packages", "servers"].includes(type) ? [] : [""] });
  assert.deepStrictEqual(defaults.private[type], { items: [], folders: [] });
}

const target = normalizeGitHubSyncTarget({
  name: "Primary",
  repository: "git@github.com:owner/knowledge.git",
  branch: "main"
}, () => "target-1");
assert.strictEqual(target.id, "target-1");
assert.deepStrictEqual(target.selection, defaults);
assert.throws(() => normalizeGitHubSyncTarget({ name: "Bad", repository: "repo", branch: "bad..branch" }), /valid Git branch/);
assert.throws(() => normalizeGitHubSyncTarget({ name: "", repository: "repo", branch: "main" }), /name is required/);
const emuTarget = normalizeGitHubSyncTarget({
  name: "EMU",
  repository: "git@github.com:yuwang8_microsoft/uone-knowledge-base.git",
  branch: "main",
  authentication: { identityFile: "/home/user/.ssh/id_emu", expectedLogin: "yuwang8_microsoft" }
}, () => "target-emu");
assert.deepStrictEqual(emuTarget.authentication, { method: "ssh", identityFile: "/home/user/.ssh/id_emu", expectedLogin: "yuwang8_microsoft" });
const homeIdentityTarget = normalizeGitHubSyncTarget({ name: "Home key", repository: "git@github.com:owner/repo.git", branch: "main", authentication: { identityFile: "~/.ssh/id_personal", expectedLogin: "qizhu8" } }, () => "target-home");
assert.strictEqual(homeIdentityTarget.authentication.identityFile, path.join(os.homedir(), ".ssh", "id_personal"));
assert.throws(() => normalizeGitHubSyncTarget({ name: "EMU", repository: "repo", branch: "main", authentication: { identityFile: "/tmp/key" } }), /Expected GitHub login/);
const gcmTarget = normalizeGitHubSyncTarget({
  name: "EMU via GCM",
  repository: "https://github.com/yuwang8_microsoft/uone-knowledge-base.git",
  branch: "main",
  authentication: { method: "https", expectedLogin: "yuwang8_microsoft" }
}, () => "target-gcm");
assert.deepStrictEqual(gcmTarget.authentication, { method: "https", expectedLogin: "yuwang8_microsoft" });
assert.deepStrictEqual(githubSyncGitArguments(["fetch", "origin"], gcmTarget), [
  "-c", "credential.gitHubAccountFiltering=true",
  "-c", "credential.username=yuwang8_microsoft",
  "fetch", "origin"
]);
assert.strictEqual(githubSyncRepositoryHttpsHost(gcmTarget.repository), "github.com");
assert.throws(() => normalizeGitHubSyncTarget({ name: "Bad GCM", repository: "git@github.com:owner/repo.git", branch: "main", authentication: { method: "https", expectedLogin: "owner" } }), /HTTPS repository URL/);
assert.throws(() => githubSyncRepositoryHttpsHost("https://token@github.com/owner/repo.git"), /HTTPS repository URL/);
assert.strictEqual(githubSyncRepositorySshHost("git@github.com:owner/repo.git"), "github.com");
assert.strictEqual(githubSyncRepositorySshHost("ssh://git@github-emu/owner/repo.git"), "github-emu");
assert.throws(() => githubSyncRepositorySshHost("https://github.com/owner/repo.git"), /SSH repository URL/);
assert.strictEqual(githubSyncSafeRelativePath("skills/Research/One.md"), "skills/Research/One.md");
assert.throws(() => githubSyncSafeRelativePath("../outside.md"), /invalid/);
assert.throws(() => githubSyncSafeRelativePath("C:\\outside.md"), /invalid/);
assert.throws(() => githubSyncSafeRelativePath("scripts/CON.txt"), /invalid/);
assert.throws(() => githubSyncSafeRelativePath("notes/trailing. "), /invalid/);
assert.strictEqual(parseGitHubSshLogin("Hi yuwang8_microsoft! You've successfully authenticated, but GitHub does not provide shell access."), "yuwang8_microsoft");
assert.strictEqual(parseGitHubSshLogin("Permission denied (publickey)."), "");
assert.deepStrictEqual(parseGitHubCredentialManagerAccounts("github.com:\n  qizhu8\n  yuwang8_microsoft\n"), ["qizhu8", "yuwang8_microsoft"]);
assert.deepStrictEqual(parseGitHubCredentialManagerAccounts("github.com qizhu8\n* yuwang8_microsoft\n"), ["qizhu8", "yuwang8_microsoft"]);
assert.strictEqual(githubSyncSshCommand("/home/user/My Key's/id_ed25519"), "ssh -o BatchMode=yes -o IdentitiesOnly=yes -o ConnectTimeout=10 -i '/home/user/My Key'\\''s/id_ed25519'");

const sshRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-github-identities-"));
try {
  const sshDirectory = path.join(sshRoot, ".ssh");
  fs.mkdirSync(sshDirectory);
  const scanned = path.join(sshDirectory, "id_personal");
  const configured = path.join(sshRoot, "id_emu");
  fs.writeFileSync(scanned, "-----BEGIN OPENSSH PRIVATE KEY-----\ntest\n");
  fs.writeFileSync(`${scanned}.pub`, "ssh-ed25519 public\n");
  fs.writeFileSync(configured, "-----BEGIN RSA PRIVATE KEY-----\ntest\n");
  fs.writeFileSync(path.join(sshDirectory, "known_hosts"), "github.com ssh-ed25519 host\n");
  fs.writeFileSync(path.join(sshDirectory, "config"), `Host github-emu\n  IdentityFile ${configured}\n`);
  assert.deepStrictEqual(discoverGitHubSshIdentities(sshDirectory), [configured, scanned].sort());
} finally {
  fs.rmSync(sshRoot, { recursive: true, force: true });
}

const entryDigest = value => createHash("sha256").update(value).digest("hex");
const fingerprint = fingerprintGitHubSyncEntries([
  { path: "notes/b.md", digest: entryDigest("b") },
  { path: "skills/a.md", digest: entryDigest("a") }
]);
assert.strictEqual(fingerprint, fingerprintGitHubSyncEntries([
  { path: "skills/a.md", digest: entryDigest("a") },
  { path: "notes/b.md", digest: entryDigest("b") }
]));

assert.strictEqual(githubSyncShield([], "skills", {}), "outline");
assert.strictEqual(githubSyncShield([target], "skills", { "target-1": { skills: fingerprint } }), "yellow");
target.lastSync = { at: "2026-01-01T00:00:00Z", commit: "abc", fingerprints: { skills: fingerprint } };
assert.strictEqual(githubSyncShield([target], "skills", { "target-1": { skills: fingerprint } }), "green");
assert.strictEqual(githubSyncShield([target], "skills", { "target-1": { skills: entryDigest("changed") } }), "yellow");

const notesOnly = normalizeGitHubSyncTarget({
  name: "Notes",
  repository: "repo",
  branch: "main",
  selection: {
    public: { notes: { items: ["Work/One"], folders: [] } },
    private: {}
  }
}, () => "notes-only");
assert.strictEqual(githubSyncShield([notesOnly], "skills", {}), "outline");
assert.strictEqual(githubSyncShield([notesOnly], "notes", {}), "yellow");

console.log("github-sync model tests passed");