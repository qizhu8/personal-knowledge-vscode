import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const require = createRequire(import.meta.url);
const original = require("../legacy/dist/sync/github-sync.js");
const nextDist = resolve(process.env.PKM_TEST_NEXT_DIST || "dist");
const { LegacyGitLease } = await import(pathToFileURL(join(nextDist, "legacy-github-git-lease.js")));
const { SyncTransportStore, initializeSyncTransportStore } = await import(pathToFileURL(join(nextDist, "sync-transport-store.js")));
const { syncPlanHash } = await import(pathToFileURL(join(nextDist, "sync-plan.js")));

test("native Git lease uses retained SSH/helper arguments and durable no-replay receipts", { timeout: 90000 }, async t => {
  const dir = resolve(".migration-test-work", `git-lease-${randomUUID()}`);
  const seed = join(dir, "seed"), bare = join(dir, "remote.git"), cache = join(dir, "cache.git");
  const bin = join(dir, "bin"), home = join(dir, "home"), identity = join(dir, "identity"), log = join(dir, "ssh.log"), drop = join(dir, "drop");
  for (const folder of [seed, bin, home]) await mkdir(folder, { recursive: true, mode: 0o700 });
  t.after(() => rm(dir, { recursive: true, force: true }));
  const env = { PATH: process.env.PATH, HOME: home, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
    GIT_ALLOW_PROTOCOL: "file", GIT_TERMINAL_PROMPT: "0", GIT_AUTHOR_NAME: "Personal Knowledge Manager",
    GIT_AUTHOR_EMAIL: "pkm@localhost", GIT_COMMITTER_NAME: "Personal Knowledge Manager", GIT_COMMITTER_EMAIL: "pkm@localhost",
    GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z" };
  const git = (cwd, args) => {
    const result = spawnSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args],
      { cwd, env, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
  };
  git(seed, ["init", "-q"]); git(seed, ["config", "user.name", "Fixture"]); git(seed, ["config", "user.email", "fixture@example.invalid"]);
  await writeFile(join(seed, "file"), "base\n");
  git(seed, ["add", "."]); git(seed, ["commit", "-qm", "base"]); git(seed, ["branch", "-M", "main"]);
  git(dir, ["clone", "--bare", "-q", seed, bare]); git(dir, ["init", "--bare", "-q", cache]);
  await chmod(cache, 0o700);
  await writeFile(join(cache, "config"), "[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n\tbare = true\n", { mode: 0o600 });
  await chmod(join(cache, "config"), 0o600);
  await writeFile(identity, "synthetic identity\n", { mode: 0o600 });
  const ssh = join(bin, "ssh");
  const script = login => `#!/bin/sh
if [ "$1" = "-T" ]; then printf "Hi ${login}! You've successfully authenticated\\n" >&2; exit 1; fi
case "$*" in
  *git-upload-pack*) exec git-upload-pack '${bare}' ;;
  *git-receive-pack*) printf 'push\\n' >> '${log}'; git-receive-pack '${bare}'; result=$?; if [ -f '${drop}' ]; then exit 1; fi; exit "$result" ;;
  *) exit 1 ;;
esac
`;
  await writeFile(ssh, script("fixture"), { mode: 0o700 });
  const policy = { policyId: randomUUID(), owner: "fixture", repository: "fixture", branch: "main",
    secretRef: randomUUID(), expectedLogin: "fixture", visibility: "public", allowPrivate: false,
    extensionVersion: "4.0.22", approvalId: randomUUID() };
  let db = new DatabaseSync(join(dir, "journal.sqlite"));
  initializeSyncTransportStore(db);
  let store = new SyncTransportStore(db, () => {});
  const baseOptions = { policy, gitDir: cache, legacyGitArguments: original.githubSyncGitArguments,
    legacySshCommand: original.githubSyncSshCommand, path: `${bin}:${process.env.PATH}`, home,
    verifyPublication(publication, plannedTree) { assert.equal(publication.policyId, policy.policyId); assert.match(plannedTree, /^[a-f0-9]{40}$/); } };
  const sshOptions = { ...baseOptions, repository: "git@github.com:fixture/fixture.git",
    authentication: { method: "ssh", expectedLogin: "fixture", identityFile: identity } };
  assert.throws(() => new LegacyGitLease({ ...sshOptions, policy: { ...policy, allowPrivate: true } }, store), /binding denied/);
  assert.doesNotThrow(() => new LegacyGitLease({ ...sshOptions,
    policy: { ...policy, visibility: "private", allowPrivate: true } }, store));
  let transport = new LegacyGitLease(sshOptions, store);
  await transport.verifySshAccount();
  const base = await transport.fetch();
  for (const repository of [
    "git@github.com:fixture/fixture",
    "ssh://git@github.com/fixture/fixture.git",
    "ssh://git@github.com:22/fixture/fixture",
  ]) {
    const variant = new LegacyGitLease({ ...sshOptions, repository }, store);
    assert.equal(await variant.fetch(), base);
  }
  for (const repository of [
    "ssh://other@github.com/fixture/fixture.git", "git@github.com:fixture/fixture.git?x",
    "ssh://git@github.com/fixture/../fixture", "git@github.com.evil:fixture/fixture.git",
    "ssh://git@github.com:2222/fixture/fixture.git", "git@github.com:other/fixture.git",
  ]) assert.throws(() => new LegacyGitLease({ ...sshOptions, repository }, store), /endpoint denied/);
  await writeFile(join(seed, "file"), "desired\n"); git(seed, ["add", "."]); git(seed, ["commit", "-qm", "PKM sync 2026-01-01T00:00:00.000Z"]);
  const candidate = git(seed, ["rev-parse", "HEAD"]), tree = git(seed, ["rev-parse", "HEAD^{tree}"]);
  git(dir, ["--git-dir", cache, "fetch", "-q", seed, candidate]);
  const manifest = { schema: 3, capabilities: { storage: "pkm.github.publication/v1",
    required: ["explicit-deletions", "stable-entity-identity"] }, files: [], deletions: [] };
  const sha = createHash("sha256").update("fixture").digest("hex");
  const createJournal = (expected, commit, treeId) => {
    const unsigned = { schema: "pkm.sync-transport-publication/v1", operationId: randomUUID(), policyId: policy.policyId,
      actorId: "fixture-actor", sessionId: randomUUID(), revision: 1, sessionHash: sha,
      sourcePins: { base: sha, local: sha, remote: sha }, expectedCommit: expected,
      expectedTree: git(dir, ["--git-dir", cache, "rev-parse", `${expected}^{tree}`]),
      manifest, manifestHash: syncPlanHash(manifest), stagedReceiptId: randomUUID(), message: "PKM sync 2026-01-01T00:00:00.000Z" };
    const journal = store.prepare({ ...unsigned, planHash: syncPlanHash(unsigned) });
    return store.transition(journal, "commit-created", { status: { ...journal.status, tree: treeId, commit } });
  };
  const first = createJournal(base, candidate, tree);
  const denied = new LegacyGitLease({ ...sshOptions, verifyPublication() { throw new Error("sensitive verifier detail"); } }, store);
  await assert.rejects(denied.push(first.publication.operationId, "fixture-actor"), error =>
    error.message === "Git lease publication verification denied.");
  assert.equal(store.read(first.publication.operationId, "fixture-actor").status.state, "commit-created");
  await assert.rejects(transport.push(first.publication.operationId, "other-actor"), /intent denied/);
  assert.equal((await transport.push(first.publication.operationId, "fixture-actor")).state, "published");
  assert.equal(git(dir, ["--git-dir", bare, "rev-parse", "main"]), candidate);
  assert.equal((await transport.push(first.publication.operationId, "fixture-actor")).state, "published");
  assert.equal((await readFile(log, "utf8")).split("\n").filter(Boolean).length, 1);

  git(seed, ["reset", "-q", "--hard", candidate]);
  await writeFile(join(seed, "file"), "local candidate\n"); git(seed, ["add", "."]); git(seed, ["commit", "-qm", "PKM sync 2026-01-01T00:00:00.000Z"]);
  const next = git(seed, ["rev-parse", "HEAD"]), nextTree = git(seed, ["rev-parse", "HEAD^{tree}"]);
  git(dir, ["--git-dir", cache, "fetch", "-q", seed, next]);
  const conflict = createJournal(candidate, next, nextTree);
  git(seed, ["reset", "-q", "--hard", candidate]);
  await writeFile(join(seed, "file"), "concurrent writer\n"); git(seed, ["add", "."]); git(seed, ["commit", "-qm", "concurrent"]);
  const concurrent = git(seed, ["rev-parse", "HEAD"]); git(seed, ["push", "-q", bare, "main"]);
  await assert.rejects(transport.push(conflict.publication.operationId, "fixture-actor"), /require review/);
  assert.equal(store.read(conflict.publication.operationId, "fixture-actor").status.state, "ref-pending");
  assert.equal(git(dir, ["--git-dir", bare, "rev-parse", "main"]), concurrent);
  assert.equal((await transport.reconcile(conflict.publication.operationId, "fixture-actor")).state, "needs-review");
  assert.equal((await transport.push(conflict.publication.operationId, "fixture-actor")).state, "needs-review");
  assert.equal((await readFile(log, "utf8")).split("\n").filter(Boolean).length, 2);

  assert.equal(await transport.fetch(), concurrent);
  await writeFile(join(seed, "file"), "delivered but response lost\n"); git(seed, ["add", "."]);
  git(seed, ["commit", "-qm", "PKM sync 2026-01-01T00:00:00.000Z"]);
  const delivered = git(seed, ["rev-parse", "HEAD"]), deliveredTree = git(seed, ["rev-parse", "HEAD^{tree}"]);
  git(dir, ["--git-dir", cache, "fetch", "-q", seed, delivered]);
  const unknown = createJournal(concurrent, delivered, deliveredTree);
  await writeFile(drop, "drop\n");
  await assert.rejects(transport.push(unknown.publication.operationId, "fixture-actor"), /require review/);
  assert.equal(git(dir, ["--git-dir", bare, "rev-parse", "main"]), delivered);
  assert.equal(store.read(unknown.publication.operationId, "fixture-actor").status.state, "ref-pending");
  db.close();
  db = new DatabaseSync(join(dir, "journal.sqlite")); store = new SyncTransportStore(db, () => {});
  transport = new LegacyGitLease(sshOptions, store);
  assert.equal((await transport.reconcile(unknown.publication.operationId, "fixture-actor")).state, "published");
  assert.equal((await transport.push(unknown.publication.operationId, "fixture-actor")).state, "published");
  assert.equal((await readFile(log, "utf8")).split("\n").filter(Boolean).length, 3);

  await writeFile(ssh, script("wrong-account"), { mode: 0o700 });
  await assert.rejects(transport.fetch(), /identity differs/);
  assert.throws(() => new LegacyGitLease({ ...sshOptions, repository: "git@evil.invalid:fixture/fixture.git" }, store), /endpoint denied/);
  const helperLog = join(dir, "helper.log"), helper = join(bin, "synthetic-helper");
  await writeFile(helper, `#!/bin/sh\ncat > '${helperLog}'\nprintf 'username=fixture\\npassword=synthetic-token\\n\\n'\n`, { mode: 0o700 });
  const https = new LegacyGitLease({ ...baseOptions, repository: "https://github.com/fixture/fixture.git",
    authentication: { method: "https", expectedLogin: "fixture" }, credentialHelpers: [helper] }, store);
  for (const repository of ["https://github.com/fixture/fixture", "https://github.com:443/fixture/fixture.git"])
    assert.doesNotThrow(() => new LegacyGitLease({ ...baseOptions, repository,
      authentication: { method: "https", expectedLogin: "fixture" }, credentialHelpers: [helper] }, store));
  for (const repository of ["https://fixture@github.com/fixture/fixture.git", "https://github.com/fixture/fixture.git#fragment",
    "https://github.com/fixture/fixture%2egit", "https://github.com:8443/fixture/fixture.git"])
    assert.throws(() => new LegacyGitLease({ ...baseOptions, repository,
      authentication: { method: "https", expectedLogin: "fixture" }, credentialHelpers: [helper] }, store), /endpoint denied/);
  await https.verifyHttpsHelper();
  const query = await readFile(helperLog, "utf8");
  assert.match(query, /host=github\.com/); assert.match(query, /username=fixture/);
  assert.doesNotMatch(query, /synthetic-token/);
  await writeFile(helper, "#!/bin/sh\nprintf 'username=other\\npassword=synthetic-token\\n\\n'\n", { mode: 0o700 });
  await assert.rejects(https.verifyHttpsHelper(), /account differs/);
  assert.throws(() => new LegacyGitLease({ ...baseOptions, repository: "https://evil.invalid/fixture/fixture.git",
    authentication: { method: "https", expectedLogin: "fixture" }, credentialHelpers: [helper] }, store), /endpoint denied/);
  await writeFile(`${identity}.replacement`, "replacement\n", { mode: 0o600 });
  await rename(`${identity}.replacement`, identity);
  await assert.rejects(transport.verifySshAccount(), /identity changed/);
  await writeFile(join(cache, "config"), "[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n\tbare = true\n[alias]\n\tbad = value\n");
  await assert.rejects(https.fetch(), /object store changed/);
  db.close();
});
