#!/usr/bin/env node
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  createGitHubSyncIdentity,
  probeGitHubSyncHttpsAuthentication
} = require("../dist/github-sync.js");

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-github-identity-"));
  try {
    await assert.rejects(() => createGitHubSyncIdentity("invalid login", path.join(root, "invalid")), /Enter the GitHub account/);

    const sshDirectory = path.join(root, ".ssh");
    const created = await createGitHubSyncIdentity("yuwang8_microsoft", sshDirectory);
    assert.strictEqual(path.dirname(created.identityFile), sshDirectory);
    assert.match(path.basename(created.identityFile), /^pkm_github_yuwang8_microsoft_[0-9a-f]{8}$/);
    assert.strictEqual(fs.existsSync(created.identityFile), true);
    assert.strictEqual(fs.existsSync(`${created.identityFile}.pub`), true);
    assert.strictEqual(created.publicKey, fs.readFileSync(`${created.identityFile}.pub`, "utf8").trim());
    assert.match(created.publicKey, /^ssh-ed25519\s+\S+\s+pkm:yuwang8_microsoft$/);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(created, "privateKey"), false);

    if (process.platform !== "win32") {
      assert.strictEqual(fs.statSync(sshDirectory).mode & 0o077, 0);
      assert.strictEqual(fs.statSync(created.identityFile).mode & 0o077, 0);
    }

    const fakeBin = path.join(root, "fake-bin");
    const fakeGit = path.join(fakeBin, "git");
    const fakeGitLog = path.join(root, "fake-git.log");
    fs.mkdirSync(fakeBin);
    fs.writeFileSync(fakeGit, `#!/bin/sh
printf 'GIT_TERMINAL_PROMPT=%s\\n' "$GIT_TERMINAL_PROMPT" > "$PKM_FAKE_GIT_LOG"
printf '%s\\n' "$@" >> "$PKM_FAKE_GIT_LOG"
case "$*" in
  *inaccessible*) printf 'repository unavailable\\n' >&2; exit 128 ;;
  *--exit-code*|*" HEAD"*) exit 2 ;;
esac
exit 0
`, { mode: 0o755 });
    const previousPath = process.env.PATH;
    process.env.PATH = `${fakeBin}${path.delimiter}${previousPath}`;
    process.env.PKM_FAKE_GIT_LOG = fakeGitLog;
    try {
      const result = await probeGitHubSyncHttpsAuthentication(
        "https://github.com/yuwang8_microsoft/empty.git",
        "yuwang8_microsoft"
      );
      assert.strictEqual(result.login, "yuwang8_microsoft");
      const argumentsLog = fs.readFileSync(fakeGitLog, "utf8");
      assert.match(argumentsLog, /GIT_TERMINAL_PROMPT=0/);
      assert.match(argumentsLog, /credential\.gitHubAccountFiltering=true/);
      assert.match(argumentsLog, /credential\.username=yuwang8_microsoft/);
      assert.match(argumentsLog, /ls-remote/);
      assert.match(argumentsLog, /https:\/\/github\.com\/yuwang8_microsoft\/empty\.git/);
      assert.doesNotMatch(argumentsLog, /--exit-code|\nHEAD\n/);
      await assert.rejects(
        () => probeGitHubSyncHttpsAuthentication(
          "https://github.com/yuwang8_microsoft/inaccessible.git",
          "yuwang8_microsoft"
        ),
        /repository unavailable/
      );
    } finally {
      process.env.PATH = previousPath;
      delete process.env.PKM_FAKE_GIT_LOG;
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  console.log("github-sync identity tests passed");
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
