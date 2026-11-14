import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:https";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { networkInterfaces } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const require = createRequire(import.meta.url);
const original = require("../legacy/dist/sync/github-sync.js");
const nextDist = resolve(process.env.PKM_TEST_NEXT_DIST || "next-server/dist");
const { LegacyGitLease } = await import(pathToFileURL(join(nextDist, "legacy-github-git-lease.js")));
const { SyncTransportStore, initializeSyncTransportStore } = await import(pathToFileURL(join(nextDist, "sync-transport-store.js")));
const { syncPlanHash } = await import(pathToFileURL(join(nextDist, "sync-plan.js")));

test("Git HTTPS uses a real credential helper against a network-isolated TLS Git server", {
  timeout: 90000, skip: process.env.PKM_TEST_ISOLATED_NETWORK !== "1" ? "requires a private user/mount/network namespace" : false,
}, async t => {
  assert.equal(process.getuid(), 0);
  assert.match(await readFile("/proc/self/uid_map", "utf8"), /^\s*0\s+\d+\s+1\s*$/);
  assert.ok(Object.values(networkInterfaces()).flat().every(address => address.internal));
  const dir = resolve(".migration-test-work", `git-https-${randomUUID()}`);
  const home = join(dir, "home"), bin = join(dir, "bin"), cache = join(dir, "cache.git");
  const seed = join(dir, "seed"), repos = join(dir, "repos"), owner = join(repos, "fixture"), remote = join(owner, "fixture.git");
  const cert = join(dir, "cert.pem"), key = join(dir, "key.pem"), hosts = join(dir, "hosts"), helper = join(bin, "helper");
  for (const folder of [home, bin, seed, owner]) await mkdir(folder, { recursive: true, mode: 0o700 });
  let hostsMounted = false, caMounted = false, server;
  t.after(async () => {
    if (server) await new Promise(resolve => server.close(resolve));
    if (caMounted) spawnSync("umount", ["/etc/ssl/certs/ca-certificates.crt"]);
    if (hostsMounted) spawnSync("umount", ["/etc/hosts"]);
    await rm(dir, { recursive: true, force: true });
  });
  const command = (program, args, cwd = dir, env = process.env) => {
    const result = spawnSync(program, args, { cwd, env, encoding: "utf8" });
    assert.equal(result.status, 0, `${program} failed: ${result.stderr}`); return result.stdout.trim();
  };
  const env = { PATH: process.env.PATH, HOME: home, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
    GIT_ALLOW_PROTOCOL: "file", GIT_TERMINAL_PROMPT: "0", GIT_AUTHOR_NAME: "Personal Knowledge Manager",
    GIT_AUTHOR_EMAIL: "pkm@localhost", GIT_COMMITTER_NAME: "Personal Knowledge Manager", GIT_COMMITTER_EMAIL: "pkm@localhost",
    GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z" };
  const git = (cwd, args) => command("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args], cwd, env);
  git(seed, ["init", "-q"]); git(seed, ["config", "user.name", "Fixture"]); git(seed, ["config", "user.email", "fixture@example.invalid"]);
  await writeFile(join(seed, "file"), "synthetic\n"); git(seed, ["add", "."]); git(seed, ["commit", "-qm", "base"]);
  git(seed, ["branch", "-M", "main"]); git(dir, ["clone", "--bare", "-q", seed, remote]);
  git(dir, ["--git-dir", remote, "config", "http.receivepack", "true"]);
  git(dir, ["init", "--bare", "-q", cache]); await chmod(cache, 0o700);
  await writeFile(join(cache, "config"), "[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n\tbare = true\n");
  await chmod(join(cache, "config"), 0o600);
  command("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
    "-keyout", key, "-out", cert, "-subj", "/CN=github.com", "-addext", "subjectAltName=DNS:github.com"]);
  await writeFile(hosts, "127.0.0.1 localhost github.com\n");
  command("mount", ["--bind", hosts, "/etc/hosts"]); hostsMounted = true;
  command("mount", ["--bind", cert, "/etc/ssl/certs/ca-certificates.crt"]); caMounted = true;
  await writeFile(helper, "#!/bin/sh\ncat >/dev/null\nif [ \"$1\" = get ]; then printf 'username=fixture\\npassword=synthetic-https-token\\n\\n'; fi\n", { mode: 0o700 });

  let authenticated = 0, challenged = 0, redirect = false;
  const authorization = `Basic ${Buffer.from("fixture:synthetic-https-token").toString("base64")}`;
  server = createServer({ key: await readFile(key), cert: await readFile(cert) }, (req, res) => {
    if (req.headers.authorization !== authorization) {
      challenged++; res.writeHead(401, { "WWW-Authenticate": 'Basic realm="synthetic"' }); res.end(); return;
    }
    authenticated++;
    if (redirect) { res.writeHead(302, { Location: "https://evil.invalid/fixture.git" }); res.end(); return; }
    const body = [];
    req.on("data", chunk => body.push(chunk));
    req.on("end", () => {
      const input = Buffer.concat(body), url = new URL(req.url, "https://github.com");
      const child = spawn("git", ["http-backend"], { env: { PATH: process.env.PATH,
        GIT_PROJECT_ROOT: repos, GIT_HTTP_EXPORT_ALL: "1", REQUEST_METHOD: req.method,
        PATH_INFO: url.pathname, QUERY_STRING: url.search.slice(1), CONTENT_TYPE: req.headers["content-type"] || "",
        CONTENT_LENGTH: String(input.length), HTTP_CONTENT_ENCODING: req.headers["content-encoding"] || "",
        REMOTE_USER: "fixture" }, stdio: ["pipe", "pipe", "ignore"] });
      let output = Buffer.alloc(0), sent = false;
      child.stdout.on("data", chunk => {
        if (sent) { res.write(chunk); return; }
        output = Buffer.concat([output, chunk]);
        const index = output.indexOf("\r\n\r\n");
        if (index < 0) return;
        const headers = output.subarray(0, index).toString("utf8").split("\r\n");
        let status = 200;
        for (const line of headers) {
          const colon = line.indexOf(":");
          if (colon < 0) continue;
          const name = line.slice(0, colon), value = line.slice(colon + 1).trim();
          if (name.toLowerCase() === "status") status = Number(value.slice(0, 3));
          else res.setHeader(name, value);
        }
        res.writeHead(status); res.write(output.subarray(index + 4)); sent = true;
      });
      child.on("error", () => { if (!res.headersSent) res.writeHead(500); res.end(); });
      child.on("close", () => { if (!res.headersSent) res.writeHead(500); res.end(); });
      child.stdin.on("error", () => {}); child.stdin.end(input);
    });
  });
  await new Promise((ok, fail) => server.once("error", fail).listen(443, "127.0.0.1", ok));
  const policy = { policyId: randomUUID(), owner: "fixture", repository: "fixture", branch: "main",
    secretRef: randomUUID(), expectedLogin: "fixture", visibility: "public", allowPrivate: false,
    extensionVersion: "4.0.22", approvalId: randomUUID() };
  const db = new DatabaseSync(join(dir, "journal.sqlite")); t.after(() => db.close());
  initializeSyncTransportStore(db);
  const store = new SyncTransportStore(db, () => {});
  const transport = new LegacyGitLease({ policy, gitDir: cache, repository: "https://github.com/fixture/fixture.git",
    authentication: { method: "https", expectedLogin: "fixture" }, credentialHelpers: [helper],
    legacyGitArguments: original.githubSyncGitArguments, legacySshCommand: original.githubSyncSshCommand,
    verifyPublication(publication) { assert.equal(publication.policyId, policy.policyId); }, path: process.env.PATH, home }, store);
  await transport.verifyHttpsHelper();
  const base = await transport.fetch();
  assert.equal(base, git(dir, ["--git-dir", remote, "rev-parse", "main"]));
  assert.ok(challenged > 0 && authenticated > 0);
  redirect = true;
  await assert.rejects(transport.fetch(), error => error.message === "Git lease operation failed; outcome may require review.");
  redirect = false;
  const manifest = { schema: 3, capabilities: { storage: "pkm.github.publication/v1",
    required: ["explicit-deletions", "stable-entity-identity"] }, files: [], deletions: [] };
  const sha = createHash("sha256").update("fixture").digest("hex");
  const prepare = (expected, commit, tree) => {
    const unsigned = { schema: "pkm.sync-transport-publication/v1", operationId: randomUUID(), policyId: policy.policyId,
      actorId: "fixture-actor", sessionId: randomUUID(), revision: 1, sessionHash: sha,
      sourcePins: { base: sha, local: sha, remote: sha }, expectedCommit: expected,
      expectedTree: git(dir, ["--git-dir", cache, "rev-parse", `${expected}^{tree}`]),
      manifest, manifestHash: syncPlanHash(manifest), stagedReceiptId: randomUUID(), message: "PKM sync 2026-01-01T00:00:00.000Z" };
    const journal = store.prepare({ ...unsigned, planHash: syncPlanHash(unsigned) });
    return store.transition(journal, "commit-created", { status: { ...journal.status, tree, commit } });
  };
  await writeFile(join(seed, "file"), "published synthetic\n"); git(seed, ["add", "."]);
  git(seed, ["commit", "-qm", "PKM sync 2026-01-01T00:00:00.000Z"]);
  const commit = git(seed, ["rev-parse", "HEAD"]), tree = git(seed, ["rev-parse", "HEAD^{tree}"]);
  git(dir, ["--git-dir", cache, "fetch", "-q", seed, commit]);
  const journal = prepare(base, commit, tree);
  assert.equal((await transport.push(journal.publication.operationId, "fixture-actor")).state, "published");
  assert.equal(git(dir, ["--git-dir", remote, "rev-parse", "main"]), commit);

  await writeFile(join(seed, "file"), "rejected synthetic\n"); git(seed, ["add", "."]);
  git(seed, ["commit", "-qm", "PKM sync 2026-01-01T00:00:00.000Z"]);
  const deniedCommit = git(seed, ["rev-parse", "HEAD"]), deniedTree = git(seed, ["rev-parse", "HEAD^{tree}"]);
  git(dir, ["--git-dir", cache, "fetch", "-q", seed, deniedCommit]);
  const denied = prepare(commit, deniedCommit, deniedTree);
  await writeFile(helper, "#!/bin/sh\ncat >/dev/null\nif [ \"$1\" = get ]; then printf 'username=fixture\\npassword=wrong-synthetic-token\\n\\n'; fi\n");
  await assert.rejects(transport.push(denied.publication.operationId, "fixture-actor"),
    error => error.message === "Git lease operation failed; outcome may require review.");
  assert.equal(store.read(denied.publication.operationId, "fixture-actor").status.state, "ref-pending");
  assert.equal(git(dir, ["--git-dir", remote, "rev-parse", "main"]), commit);
});
