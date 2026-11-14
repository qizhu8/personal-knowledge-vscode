import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { githubSyncGitArguments, githubSyncSshCommand } = require("../legacy/dist/sync/github-sync.js");

test("legacy credential helper and SSH arguments exercise only synthetic local transports", async t => {
  const dir = resolve(".migration-test-work", `legacy-auth-${randomUUID()}`);
  const bare = join(dir, "remote.git"), seed = join(dir, "seed"), bin = join(dir, "bin");
  await mkdir(seed, { recursive: true }); await mkdir(bin);
  t.after(() => rm(dir, { recursive: true, force: true }));
  const env = { PATH: `${bin}:${process.env.PATH}`, HOME: dir, GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: join(dir, "config"), GIT_TERMINAL_PROMPT: "0", SSH_AUTH_SOCK: "" };
  function git(args, extra = {}, input) {
    const result = spawnSync("git", args, { cwd: seed, env: { ...env, ...extra }, input, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr); return result.stdout;
  }
  git(["init", "-q"]); git(["config", "user.name", "Fixture"]); git(["config", "user.email", "fixture@example.invalid"]);
  await writeFile(join(seed, "fixture.txt"), "synthetic\n");
  git(["add", "."]); git(["commit", "-qm", "seed"]); git(["branch", "-M", "main"]);
  git(["clone", "--bare", "-q", seed, bare]);
  const sshLog = join(dir, "ssh.log"), identity = join(dir, "synthetic-identity");
  await writeFile(identity, "not a real key\n", { mode: 0o600 });
  await writeFile(join(bin, "ssh"), `#!/bin/sh
printf '%s\\n' "$@" >> "$PKM_FAKE_SSH_LOG"
case "$*" in
  *git-upload-pack*) exec git-upload-pack "$PKM_FAKE_BARE" ;;
  *git-receive-pack*) exec git-receive-pack "$PKM_FAKE_BARE" ;;
  *) exit 1 ;;
esac
`, { mode: 0o700 });
  const sshTarget = { authentication: { method: "ssh", identityFile: identity, expectedLogin: "fixture" } };
  const sshEnv = { GIT_SSH_COMMAND: githubSyncSshCommand(identity), GIT_SSH_VARIANT: "ssh",
    PKM_FAKE_SSH_LOG: sshLog, PKM_FAKE_BARE: bare };
  git(githubSyncGitArguments(["ls-remote", "git@fixture.invalid:repository"], sshTarget), sshEnv);
  await writeFile(join(seed, "fixture.txt"), "updated\n"); git(["add", "."]); git(["commit", "-qm", "update"]);
  git(githubSyncGitArguments(["push", "git@fixture.invalid:repository", "main:main"], sshTarget), sshEnv);
  const calls = await readFile(sshLog, "utf8");
  assert.match(calls, /IdentitiesOnly=yes/); assert(calls.includes(identity));
  assert.match(calls, /git-upload-pack/); assert.match(calls, /git-receive-pack/);

  const helperLog = join(dir, "helper.log"), helper = join(bin, "credential-fixture");
  await writeFile(helper, `#!/bin/sh
cat > "$PKM_FAKE_HELPER_LOG"
printf 'username=fixture\\npassword=synthetic-token\\n\\n'
`, { mode: 0o700 });
  await writeFile(env.GIT_CONFIG_GLOBAL, `[credential]\n\thelper = ${helper}\n`);
  const httpsTarget = { authentication: { method: "https", expectedLogin: "fixture" } };
  const output = git(githubSyncGitArguments(["credential", "fill"], httpsTarget),
    { PKM_FAKE_HELPER_LOG: helperLog }, "protocol=https\nhost=github.com\n\n");
  assert.match(output, /username=fixture/); assert.match(output, /password=synthetic-token/);
  const request = await readFile(helperLog, "utf8");
  assert.match(request, /host=github\.com/); assert.match(request, /username=fixture/);
});
