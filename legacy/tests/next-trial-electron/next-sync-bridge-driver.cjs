"use strict";
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const vscode = require("vscode");

exports.activate = async () => {
  const marker = process.env.PKM_SYNC_HOST_DRIVER_MARKER, fixture = process.env.PKM_PRIVATE_SYNC_FIXTURE;
  try {
    const target = vscode.extensions.getExtension("uone.personal-knowledge");
    assert(target); await target.activate();
    const data = JSON.parse(fs.readFileSync(path.join(fixture, "sync-installed/fixture.json")));
    const root = path.join(fixture, process.env.PKM_PRIVATE_SYNC_SAME_ROOT === "1" ? "legacy-root" : "native-root"),
      bare = path.join(fixture, "remote.git");
    const alpha = path.join(root, "skills/InstallAlpha.md");
    const run = action => vscode.commands.executeCommand("personalKnowledge.runIsolatedNextSyncFixture",
      { fixture, action, policy: data.policy });
    const git = (cwd, ...args) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
      cwd, encoding: "utf8", env: { PATH: process.env.PATH, HOME: fixture, GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null", GIT_ALLOW_PROTOCOL: "file", GIT_TERMINAL_PROMPT: "0" },
    }).trim();
    if (process.env.PKM_SYNC_ADOPTED_GUARD_TEST === "1") {
      const scanner = path.join(target.extensionPath, "next-runtime/server/dist/linux-legacy-writer-quiescence.js");
      const source = `import { pathToFileURL } from "node:url";
        const m = await import(pathToFileURL(process.argv[1]).href);
        const r = await m.inspectLinuxLegacyWriterQuiescence(process.argv[2]);
        console.log(JSON.stringify(r.blockers.map(x => x.kind)));`;
      const kinds = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", source, scanner, root], {
        env: { PATH: process.env.PATH, HOME: fixture, ELECTRON_RUN_AS_NODE: "1" }, encoding: "utf8", timeout: 30000,
      }));
      assert(kinds.some(kind => kind === "vscode-host-process" || kind === "vscode-extension-host"),
        `Expected live VS Code process blocker, got ${kinds.join(",")}`);
      await assert.rejects(run("sync"), /LEGACY_WRITERS_ACTIVE/);
      fs.writeFileSync(marker, JSON.stringify({ passed: true, guardBlockers: kinds }), { flag: "wx", mode: 0o600 });
      return;
    }
    fs.appendFileSync(alpha, "host push\n");
    const first = await run("sync");
    assert.equal(first.result.state, "published"); assert(first.credentialReads > 0);
    assert.match(git(fixture, "--git-dir", bare, "show", "main:skills/InstallAlpha.md"), /host push/);
    fs.appendFileSync(alpha, "host crash\n");
    const crash = await run("crash"); assert.equal(crash.state, "fixture-crash"); assert(crash.credentialReads > 0);
    const commit = git(fixture, "--git-dir", bare, "rev-parse", "refs/heads/main");
    const recovery = await run("resume");
    assert.deepEqual(recovery.result, { state: "published", commit }); assert.equal(recovery.pushes, 0);
    assert.equal(git(fixture, "--git-dir", bare, "rev-parse", "refs/heads/main"), commit);
    git(data.seed, "remote", "add", "origin", bare);
    const remoteChange = text => {
      git(data.seed, "fetch", "-q", "origin", "main"); git(data.seed, "reset", "-q", "--hard", "FETCH_HEAD");
      const file = path.join(data.seed, "skills/InstallAlpha.md"), manifest = path.join(data.seed, ".pkm-github-sync.json");
      fs.appendFileSync(file, text);
      const wire = JSON.parse(fs.readFileSync(manifest));
      wire.files.find(entry => entry.path === "skills/InstallAlpha.md").digest = createHash("sha256").update(fs.readFileSync(file)).digest("hex");
      fs.writeFileSync(manifest, JSON.stringify(wire) + "\n");
      git(data.seed, "add", "."); git(data.seed, "commit", "-qm", "remote edit"); git(data.seed, "push", "-q", "origin", "main");
    };
    remoteChange("host remote pull\n");
    assert.equal((await run("sync")).result.state, "published");
    assert.match(fs.readFileSync(alpha, "utf8"), /host remote pull/);
    fs.appendFileSync(alpha, "host local conflict\n"); remoteChange("host remote conflict\n");
    const conflict = await run("sync"); assert.equal(conflict.result.state, "conflict");
    const resumed = await run("resume");
    assert.deepEqual(resumed.result, conflict.result); assert.equal(resumed.credentialReads, 0); assert.equal(resumed.pushes, 0);
    assert.match(git(fixture, "--git-dir", bare, "show", "main:notes/Remote.md"), /remote note unchanged/);
    assert.match(git(fixture, "--git-dir", bare, "show", "main:prompts/Remote.md"), /remote prompt unchanged/);
    assert.equal(fs.readFileSync(path.join(data.globalStorage, "github-sync/targets.json"), "utf8"), data.config);
    assert.equal(fs.readFileSync(path.join(data.globalStorage, "github-sync/checkouts/fixture-target/transactions/latest.json"), "utf8"), data.receipt);
    assert(!JSON.stringify({ first, crash, recovery, conflict, resumed }).includes("fixture-token"));
    await assert.rejects(vscode.commands.executeCommand("personalKnowledge.executeNextSyncHost"), /blocked/);
    fs.writeFileSync(marker, JSON.stringify({ passed: true, credentialReads: first.credentialReads,
      recoveryPushes: recovery.pushes, conflictResumeReads: resumed.credentialReads }), { flag: "wx", mode: 0o600 });
  } catch (error) {
    fs.writeFileSync(marker, JSON.stringify({ passed: false, error: String(error?.message ?? error) }), { flag: "wx", mode: 0o600 });
  } finally {
    setTimeout(() => { void vscode.commands.executeCommand("workbench.action.quit"); }, 100);
  }
};
