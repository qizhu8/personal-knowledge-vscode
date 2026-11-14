const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { verifyGitHubSyncBaseDigest } = require("../dist/sync/github-sync-base-integrity");
const sync = require("../dist/sync/github-sync");
const hash = value => createHash("sha256").update(value).digest("hex");
const lf = Buffer.from("before\nline\n");
const crlf = Buffer.from("before\r\nline\r\n");
const verified = verifyGitHubSyncBaseDigest("historical-commit", "notes/Test.md", hash(crlf), lf);
assert.equal(verified.digest, hash(lf));
assert.deepEqual(verified.evidence, { commit: "historical-commit", manifestDigest: hash(crlf),
  blobDigest: hash(lf), comparisonDigest: hash(lf), reason: "verified-line-endings" });
assert.equal(verifyGitHubSyncBaseDigest("base", "notes/Test.md", hash(lf), lf).evidence, undefined);
assert.throws(() => verifyGitHubSyncBaseDigest("base", "notes/Test.md", hash("other\n"), lf), /Base manifest digest/);
assert.throws(() => verifyGitHubSyncBaseDigest("base", "notes/Test.md", hash(Buffer.from([0xff, 13, 10])), Buffer.from([0xff, 10])), /Base manifest digest/);
assert.throws(() => verifyGitHubSyncBaseDigest("base", "notes/Test.md", hash("a\rb\n"), Buffer.from("a\nb\n")), /Base manifest digest/);
const serialized = JSON.parse(sync.manifestJson([{ path: "notes/Test.md", type: "notes", itemId: "test",
  member: "", category: "", privacy: "public", digest: hash(lf), sourceDigest: hash(crlf),
  baseIntegrityEvidence: verified.evidence, content: lf }]));
assert.equal(serialized.files[0].sourceDigest, undefined, "source-byte guards are local review data, not manifest fields");
assert.equal(serialized.files[0].baseIntegrityEvidence, undefined, "historical evidence is retained outside managed content");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-base-integrity-"));
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
(async () => {
  const remote = path.join(root, "remote.git"), seed = path.join(root, "seed"), local = path.join(root, "local");
  fs.mkdirSync(seed); fs.mkdirSync(path.join(seed, "notes"));
  git(root, "init", "--bare", remote); git(seed, "init");
  git(seed, "config", "user.name", "Test"); git(seed, "config", "user.email", "test@example.com");
  git(seed, "config", "core.autocrlf", "false");
  fs.writeFileSync(path.join(seed, "notes/Test.md"), lf);
  const entry = { path: "notes/Test.md", type: "notes", itemId: "note_test", member: "", category: "", privacy: "public", digest: hash(crlf) };
  // Use the actual manifest path from the public serializer's production convention.
  const source = fs.readFileSync(path.join(__dirname, "../src/sync/github-sync.ts"), "utf8");
  const actualManifest = /const MANIFEST_PATH = "([^"]+)"/.exec(source)[1];
  fs.mkdirSync(path.dirname(path.join(seed, actualManifest)), { recursive: true });
  const writeManifest = digest => fs.writeFileSync(path.join(seed, actualManifest), sync.manifestJson([{ ...entry, digest }]));
  writeManifest(hash(crlf));
  git(seed, "add", "."); git(seed, "commit", "-m", "historical CRLF manifest");
  const base = git(seed, "rev-parse", "HEAD");
  writeManifest(hash(lf)); git(seed, "add", "."); git(seed, "commit", "-m", "current byte-strict manifest");
  const latest = git(seed, "rev-parse", "HEAD");
  git(seed, "branch", "-M", "main"); git(seed, "remote", "add", "origin", remote); git(seed, "push", "-u", "origin", "main");
  git(root, "--git-dir", remote, "symbolic-ref", "HEAD", "refs/heads/main");
  fs.mkdirSync(path.join(local, "notes"), { recursive: true }); fs.writeFileSync(path.join(local, "notes/Test.md"), lf);
  const catalog = Object.fromEntries(sync.GITHUB_SYNC_CONTENT_TYPES.map(type => [type, []]));
  catalog.notes.push({ id: entry.itemId, cat: "", label: "Test", isPrivate: false, source: path.join(local, entry.path), destination: entry.path });
  const target = sync.normalizeGitHubSyncTarget({ id: "primary", name: "Primary", repository: remote });
  target.lastSync = { commit: base, at: new Date().toISOString(), fingerprints: {} };
  const checkouts = path.join(root, "checkouts");
  const result = await sync.syncGitHubTarget(target, catalog, checkouts, undefined, local);
  assert.equal(result.changed, false, "historical line ending mismatch must not manufacture a commit");
  assert.equal(result.commit, latest);
  const records = fs.readdirSync(path.join(checkouts, target.id, "base-integrity"));
  const evidence = JSON.parse(fs.readFileSync(path.join(checkouts, target.id, "base-integrity", records[0])));
  assert.equal(evidence.commit, base);
  assert.equal(evidence.files[0].manifestDigest, hash(crlf));
  assert.equal(evidence.files[0].blobDigest, hash(lf));
  target.lastSync.commit = latest;
  assert.equal((await sync.syncGitHubTarget(target, catalog, checkouts, undefined, local)).changed, false);
  // Latest Remote is never allowed the Base compatibility exception.
  writeManifest(hash(crlf)); git(seed, "add", "."); git(seed, "commit", "-m", "corrupt latest manifest"); git(seed, "push");
  await assert.rejects(() => sync.syncGitHubTarget(target, catalog, checkouts, undefined, local), /content digest does not match/);
  // A genuine mismatch in historical Base also fails before reconciliation.
  writeManifest(hash("different\n")); git(seed, "add", "."); git(seed, "commit", "-m", "corrupt historical Base");
  const corruptBase = git(seed, "rev-parse", "HEAD");
  writeManifest(hash(lf)); git(seed, "add", "."); git(seed, "commit", "-m", "valid current Remote"); git(seed, "push");
  target.lastSync.commit = corruptBase;
  await assert.rejects(() => sync.syncGitHubTarget(target, catalog, checkouts, undefined, local), /Base manifest digest does not match/);
  console.log("Historical Base evidence, no-change reconciliation and strict Remote integrity passed");
})().finally(() => fs.rmSync(root, { recursive: true, force: true })).catch(error => { console.error(error); process.exitCode = 1; });
