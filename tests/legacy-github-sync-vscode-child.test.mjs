import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { fork, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";
import { initialize } from "../dist/storage.js";

const require = createRequire(import.meta.url);
const { prepare } = require("../legacy/tests/next-trial-electron/sync-installed.cjs");
const hash = value => createHash("sha256").update(value).digest("hex");
const git = (cwd, ...args) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
  cwd, encoding: "utf8", env: { PATH: process.env.PATH, HOME: cwd, GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null", GIT_ALLOW_PROTOCOL: "file", GIT_TERMINAL_PROMPT: "0" },
}).trim();

test("private child uses requested credential, reconciles lost push and retains conflict without a secret", { timeout: 120000 }, async t => {
  const fixture = path.resolve(".migration-test-work", `pkm-sync-fixture-${randomUUID()}`);
  const root = path.join(fixture, "native-root");
  const profile = path.join(fixture, "u/User/globalStorage/uone.personal-knowledge");
  fs.mkdirSync(profile, { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(fixture, "provider"), { mode: 0o700 });
  await initialize(root);
  fs.mkdirSync(path.join(root, "skills"), { mode: 0o700 });
  for (const name of ["InstallAlpha", "InstallBeta"])
    fs.writeFileSync(path.join(root, `skills/${name}.md`), `---\nname: ${name}\n---\nbase\n`);
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  prepare({ fixture, root, globalStorage: profile });
  const data = JSON.parse(fs.readFileSync(path.join(fixture, "sync-installed/fixture.json")));
  const bare = path.join(fixture, "remote.git");
  fs.renameSync(data.bare, bare); fs.chmodSync(bare, 0o700);
  const alpha = path.join(root, "skills/InstallAlpha.md");
  const run = action => new Promise((resolve, reject) => {
    const session = randomUUID(), child = fork(path.resolve("dist/legacy-github-sync-vscode-child.js"), [], {
      env: { PATH: process.env.PATH, HOME: fixture, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_ALLOW_PROTOCOL: "file", GIT_TERMINAL_PROMPT: "0" }, stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    let result, reads = 0, error = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), 30000);
    child.stderr.on("data", bytes => { error += bytes.toString(); });
    child.on("message", message => {
      assert.equal(message.session, session);
      if (message.type === "credential-request") {
        assert.equal(message.key, "personalKnowledge.githubSync.vscode.fixture-target"); reads++;
        child.send({ type: "credential-response", session, requestId: message.requestId,
          value: JSON.stringify({ accountLabel: "fixture", accessToken: "fixture-token" }) });
      } else if (message.type === "result") result = message;
      else if (message.type === "error") error += message.code;
      else assert.fail("Unexpected child message");
    });
    child.once("error", reject);
    child.once("exit", code => {
      clearTimeout(timer);
      if (action === "crash" && code === 77) return resolve({ reads });
      if (code !== 0 || !result) return reject(new Error(`child ${action} ${code}: ${error}`));
      resolve({ ...result, reads });
    });
    child.send({ type: "start", session, fixture, action, policy: data.policy });
  });
  fs.appendFileSync(alpha, "local push\n");
  const first = await run("sync");
  assert.equal(first.result.state, "published"); assert(first.reads > 0);
  assert.match(git(fixture, "--git-dir", bare, "show", "main:skills/InstallAlpha.md"), /local push/);
  fs.appendFileSync(alpha, "lost response\n");
  assert((await run("crash")).reads > 0);
  const commit = git(fixture, "--git-dir", bare, "rev-parse", "refs/heads/main");
  const recovered = await run("resume");
  assert.deepEqual(recovered.result, { state: "published", commit }); assert.equal(recovered.pushes, 0);
  assert.equal(git(fixture, "--git-dir", bare, "rev-parse", "refs/heads/main"), commit);

  git(data.seed, "remote", "add", "origin", bare);
  const remoteChange = text => {
    git(data.seed, "fetch", "-q", "origin", "main"); git(data.seed, "reset", "-q", "--hard", "FETCH_HEAD");
    const file = path.join(data.seed, "skills/InstallAlpha.md"), manifest = path.join(data.seed, ".pkm-github-sync.json");
    fs.appendFileSync(file, text);
    const wire = JSON.parse(fs.readFileSync(manifest));
    wire.files.find(entry => entry.path === "skills/InstallAlpha.md").digest = hash(fs.readFileSync(file));
    fs.writeFileSync(manifest, JSON.stringify(wire) + "\n");
    git(data.seed, "add", "."); git(data.seed, "commit", "-qm", "remote edit"); git(data.seed, "push", "-q", "origin", "main");
  };
  remoteChange("remote pull\n");
  assert.equal((await run("sync")).result.state, "published");
  assert.match(fs.readFileSync(alpha, "utf8"), /remote pull/);
  fs.appendFileSync(alpha, "local conflict\n"); remoteChange("remote conflict\n");
  const conflict = await run("sync"); assert.equal(conflict.result.state, "conflict");
  const resumed = await run("resume");
  assert.deepEqual(resumed.result, conflict.result); assert.equal(resumed.reads, 0); assert.equal(resumed.pushes, 0);
  assert.match(git(fixture, "--git-dir", bare, "show", "main:notes/Remote.md"), /remote note unchanged/);
  assert(!fs.readFileSync(path.join(profile, "github-sync/experimental-next/fixture-target.json"), "utf8").includes("fixture-token"));
  fs.appendFileSync(path.join(fixture, "provider/provider.git/config"), "\n[include]\npath = evil\n");
  await assert.rejects(run("sync"), /FIXTURE_DENIED/);
});
