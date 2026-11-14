import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { chmod, mkdir, readFile, readdir, rm, rmdir, stat, symlink, writeFile } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { networkInterfaces } from "node:os";
import { pathToFileURL } from "node:url";
import test from "node:test";

const require = createRequire(import.meta.url), legacy = require("../legacy/dist/sync/github-sync.js");
const dist = resolve(process.env.PKM_TEST_NEXT_DIST || "next-server/dist");
const load = name => import(pathToFileURL(join(dist, `${name}.js`)));
const { SyncNativeGitProvider } = await load("sync-native-git-provider");
const { adoptLegacyRootInPlaceExperimental, legacyRootAdoptionLockDirectory } = await load("legacy-root-adoption");
const { openExperimentalLegacySyncHost } = await load("legacy-github-sync-experimental-host");
const { Storage } = await load("storage");
const { createNativeRuntime } = await load("native-runtime");
const { manifestJson, MANIFEST_PATH } = await import(pathToFileURL(join(dist, "domain/sync-transport-original.js")));
const digest = value => createHash("sha256").update(value).digest("hex");

test("native Skills Sync uses real Git CAS and native staged receipts", { timeout: 90000 }, async t => {
  const https = process.env.PKM_TEST_NATIVE_HTTPS === "1";
  const privateSkills = process.env.PKM_TEST_PRIVATE_SKILLS === "1";
  const skillsMount = process.env.PKM_TEST_SKILLS_MOUNT === "1";
  if (skillsMount) assert(privateSkills);
  const skillAssets = process.env.PKM_TEST_SKILL_ASSETS === "1";
  if (skillAssets) assert(skillsMount);
  const badMountAsset = process.env.PKM_TEST_BAD_MOUNT_ASSET === "1";
  const badMountSymlink = process.env.PKM_TEST_BAD_MOUNT_SYMLINK === "1";
  const badMountIdentity = process.env.PKM_TEST_BAD_MOUNT_IDENTITY === "1";
  if (badMountAsset || badMountSymlink || badMountIdentity) assert(skillsMount);
  const partialSelection = process.env.PKM_TEST_PARTIAL_SELECTION === "1";
  const visibilityApi = process.env.PKM_TEST_VISIBILITY_API === "1";
  if (partialSelection) assert(privateSkills);
  if (https) {
    assert.equal(process.env.PKM_TEST_ISOLATED_NETWORK, "1"); assert.equal(process.getuid(), 0);
    assert.match(await readFile("/proc/self/uid_map", "utf8"), /^\s*0\s+\d+\s+1\s*$/);
    assert.ok(Object.values(networkInterfaces()).flat().every(address => address.internal));
  }
  const dir = resolve(".migration-test-work", `${https ? "pkm-native-sync-ui" : "sync-native-git"}-${randomUUID()}`);
  const root = join(dir, "root"), seed = join(dir, "seed"), bare = join(dir, "remote.git"), cache = join(dir, "cache.git");
  const profile = join(dir, "profile"), home = join(dir, https ? "h" : "home"), bin = join(dir, "bin");
  const identity = join(dir, "identity"), drop = join(dir, https ? "git-drop" : "drop");
  const race = join(dir, https ? "git-race" : "race"), pushes = join(dir, https ? "git-pushes" : "pushes");
  const remoteSkills = skillsMount ? "Skills" : "skills";
  const remoteManifest = skillsMount ? `Skills/${MANIFEST_PATH}` : MANIFEST_PATH;
  for (const folder of [join(root, "skills"), join(root, "notes"), join(root, "prompts"),
    join(seed, remoteSkills), join(seed, "notes"), join(seed, "prompts"), join(profile, "github-sync"), home, bin])
    await mkdir(folder, { recursive: true, mode: 0o700 });
  let storage, host, server, hostsMounted = false, caMounted = false;
  t.after(async () => {
    if (host) await host.close();
    if (storage) await storage.close();
    if (server && server.exitCode === null) {
      const exited = new Promise(done => server.once("exit", done));
      server.kill("SIGTERM"); await exited;
    }
    if (caMounted) spawnSync("umount", ["/etc/ssl/certs/ca-certificates.crt"]);
    if (hostsMounted) spawnSync("umount", ["/etc/hosts"]);
    const locks = legacyRootAdoptionLockDirectory(root);
    for (const suffix of [".sqlite", ".writer.lock", ".writer-fenced.json"]) await rm(join(locks, digest(root).slice(0, 40) + suffix), { force: true });
    await rmdir(locks).catch(error => { if (!["ENOENT", "ENOTEMPTY"].includes(error.code)) throw error; });
    await rm(dir, { recursive: true, force: true });
  });
  const env = { PATH: process.env.PATH, HOME: home, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
    GIT_ALLOW_PROTOCOL: "file", GIT_TERMINAL_PROMPT: "0" };
  const git = (cwd, args) => {
    const result = spawnSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args],
      { cwd, env, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
  };
  const skill = text => `---\nname: One\n---\n${text}\n`;
  const privateSkill = text => `---\nname: Secret\n---\n${text}\n`;
  const unselectedSkill = text => `---\nname: Unselected\n---\n${text}\n`;
  const remoteNote = "remote note\n", remotePrompt = "remote prompt\n", localNote = "local note\n", localPrompt = "local prompt\n";
  const item = (type, name, data) => ({ path: `${type}/${name}.md`, type, itemId: name,
    member: "", category: "", privacy: "public", digest: digest(data) });
  await writeFile(join(seed, remoteSkills, "One.md"), skill("remote"));
  await writeFile(join(seed, "notes/Note.md"), remoteNote); await writeFile(join(seed, "prompts/Prompt.md"), remotePrompt);
  const privateItem = text => ({ path: "skills/Private/Secret.md", type: "skills", itemId: "Secret",
    member: "", category: "Private", privacy: "private", digest: digest(privateSkill(text)) });
  const privacyJson = JSON.stringify({ schema: 1, private: { skills: ["Private"] } });
  if (privateSkills) {
    await mkdir(join(root, ".pkm"), { mode: 0o700 });
    await writeFile(join(root, ".pkm/content-privacy.json"), privacyJson, { mode: 0o600 });
    await mkdir(join(root, "skills/Private")); await mkdir(join(seed, remoteSkills, "Private"));
    await writeFile(join(root, "skills/Private/Secret.md"), privateSkill("shared"), { mode: 0o600 });
    if (!skillsMount) await writeFile(join(seed, remoteSkills, "Private/Secret.md"), privateSkill("shared"), { mode: 0o600 });
  }
  if (partialSelection) {
    await writeFile(join(root, "skills/Unselected.md"), unselectedSkill("local only"));
    await writeFile(join(seed, remoteSkills, "Unselected.md"), unselectedSkill("remote only"));
  }
  if (!skillsMount) await writeFile(join(seed, MANIFEST_PATH), manifestJson([item("skills", "One", skill("remote")),
    item("notes", "Note", remoteNote), item("prompts", "Prompt", remotePrompt),
    ...(privateSkills ? [privateItem("shared")] : []),
    ...(partialSelection ? [item("skills", "Unselected", unselectedSkill("remote only"))] : [])], []));
  await writeFile(join(root, "skills/One.md"), skill("local"));
  if (skillAssets) {
    await mkdir(join(root, "skills/One.assets")); await mkdir(join(seed, remoteSkills, "One.assets"));
    await writeFile(join(root, "skills/One.assets/icon.png"), Buffer.from("synthetic image base"));
    await writeFile(join(seed, remoteSkills, "One.assets/icon.png"), Buffer.from("synthetic image base"));
  }
  if (badMountAsset) await writeFile(join(seed, remoteSkills, "unowned.png"), "unowned synthetic asset");
  if (badMountSymlink) await symlink("../notes/Note.md", join(seed, remoteSkills, "link.md"));
  if (badMountIdentity) {
    await writeFile(join(root, "skills/One.md"), "---\nname: One\nknowledgeId: knowledge_aaaaaaaaaaaaaaaaaaaaaaaa\n---\nlocal\n");
    await writeFile(join(seed, remoteSkills, "One.md"), "---\nname: One\nknowledgeId: knowledge_bbbbbbbbbbbbbbbbbbbbbbbb\n---\nremote\n");
  }
  await writeFile(join(root, "notes/Note.md"), localNote); await writeFile(join(root, "prompts/Prompt.md"), localPrompt);
  git(seed, ["init", "-q"]); git(seed, ["config", "user.name", "Fixture"]); git(seed, ["config", "user.email", "fixture@example.invalid"]);
  git(seed, ["add", "."]); git(seed, ["commit", "-qm", "base"]); git(seed, ["branch", "-M", "main"]);
  git(dir, ["clone", "--bare", "-q", seed, bare]); git(seed, ["remote", "add", "origin", bare]);
  git(dir, ["init", "--bare", "-q", cache]); await chmod(cache, 0o700);
  await writeFile(join(cache, "config"), "[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n\tbare = true\n");
  await chmod(join(cache, "config"), 0o600); await writeFile(identity, "synthetic\n", { mode: 0o600 });
  await writeFile(join(bin, "ssh"), `#!/bin/sh
printf '%s\\n' "$*" >> '${dir}/ssh-args'
if [ "$1" = "-T" ]; then printf "Hi fixture! You've successfully authenticated\\n" >&2; exit 1; fi
case "$*" in
 *git-upload-pack*) exec git-upload-pack '${bare}' ;;
 *git-receive-pack*) printf 'push\\n' >> '${pushes}'; if [ -f '${dir}/wait-for-target-writer' ]; then n=0; while [ ! -f '${dir}/target-writer-attempt' ] && [ "$n" -lt 200 ]; do sleep .05; n=$((n+1)); done; [ -f '${dir}/target-writer-attempt' ] || exit 1; [ ! -f '${dir}/target-writer-done' ] || exit 1; fi; if [ -f '${race}' ]; then git --git-dir '${bare}' update-ref refs/heads/main "$(git --git-dir '${bare}' rev-parse refs/heads/race)"; fi; git-receive-pack '${bare}'; result=$?; if [ -f '${drop}' ]; then exit 1; fi; exit "$result" ;;
 *) exit 1 ;;
esac
`, { mode: 0o700 });
  process.env.GIT_CONFIG_GLOBAL = "/dev/null";
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  process.env.GIT_ALLOW_PROTOCOL = "file:ssh:https";
  if (https) {
    const openssl = spawnSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
      "-keyout", join(dir, "tls-key.pem"), "-out", join(dir, "tls-cert.pem"),
      "-subj", "/CN=github.com", "-addext", "subjectAltName=DNS:github.com"], { env, encoding: "utf8" });
    assert.equal(openssl.status, 0);
    await writeFile(join(dir, "hosts"), "127.0.0.1 localhost github.com\n");
    const hostsMount = spawnSync("mount", ["--bind", join(dir, "hosts"), "/etc/hosts"]);
    assert.equal(hostsMount.status, 0); hostsMounted = true;
    const caMount = spawnSync("mount", ["--bind", join(dir, "tls-cert.pem"), "/etc/ssl/certs/ca-certificates.crt"]);
    assert.equal(caMount.status, 0); caMounted = true;
    await writeFile(join(bin, "credential-helper"),
      `#!/bin/sh\ncat >/dev/null\nprintf '%s\\n' "$1" >> '${dir}/helper-actions'\nif [ "$1" = get ]; then printf 'username=fixture\\npassword=synthetic-https-token\\n\\n'; fi\n`, { mode: 0o700 });
    await writeFile(join(home, ".gitconfig"), `[credential]\n\thelper = ${join(bin, "credential-helper")}\n`);
    process.env.GIT_CONFIG_GLOBAL = join(home, ".gitconfig");
    process.env.GIT_CONFIG_NOSYSTEM = "1";
    process.env.GIT_ALLOW_PROTOCOL = "file:ssh:https";
    git(dir, ["--git-dir", bare, "config", "http.receivepack", "true"]);
    server = spawn(process.execPath, [resolve("next-server/tests/legacy-github-sync-https-server.mjs")], {
      env: { ...process.env, PKM_PRIVATE_SYNC_UI_FIXTURE: dir }, stdio: ["ignore", "pipe", "ignore"],
    });
    let output = "";
    server.stdout.on("data", chunk => { output += chunk; });
    for (let attempt = 0; attempt < 100 && !output.includes("READY\n"); attempt++) {
      if (server.exitCode !== null) throw new Error("Private HTTPS server exited.");
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.match(output, /READY/);
  }
  const policy = { policyId: randomUUID(), owner: "fixture", repository: "fixture", branch: "main",
    secretRef: randomUUID(), expectedLogin: "fixture", visibility: privateSkills ? "private" : "public", allowPrivate: privateSkills,
    extensionVersion: "4.0.22", approvalId: randomUUID() };
  const target = { schema: 1, id: "fixture-target", name: "Synthetic",
    repository: https ? "https://github.com/fixture/fixture.git" : "git@github.com:fixture/fixture.git", branch: "main",
    authentication: https ? { method: "https", expectedLogin: "fixture" } : { method: "ssh", expectedLogin: "fixture", identityFile: identity },
    ...(skillsMount ? { skillsMount: { path: "Skills", adoption: "explicit" } } : {}),
    selection: { public: { skills: partialSelection ? { items: ["One"], folders: [] } : { items: [], folders: [""] } },
      private: privateSkills ? { skills: { items: [], folders: [partialSelection ? "Private" : ""] } } : {} } };
  const config = JSON.stringify({ schema: 1, targets: [target] });
  await writeFile(join(profile, "github-sync/targets.json"), config, { mode: 0o600 });
  let testedStagedReceipt = false, changeConfigBeforePush = false, startTargetWriter = false, competingWriter;
  let repositoryAnswer = { full_name: "fixture/fixture", private: privateSkills }, repositoryRequests = 0, visibilityFenceHeld = false;
  const open = async () => {
    const nativeGit = new SyncNativeGitProvider({ policy, repository: target.repository, gitDir: cache,
      authentication: target.authentication, legacyGitArguments: legacy.githubSyncGitArguments,
      legacySshCommand: legacy.githubSyncSshCommand, inheritLegacyEnvironment: true,
      path: `${bin}:${process.env.PATH}`, home },
    async () => { assert.equal(policy.owner, "fixture"); });
    const bind = nativeGit.bind.bind(nativeGit);
    nativeGit.bind = (store, verify, authority) => bind(store, (publication, tree) => {
      if (!testedStagedReceipt) {
        const db = storage.connectNative();
        try {
          assert.equal(db.prepare("UPDATE sync_apply_journal SET state='needs-review' WHERE apply_id=?")
            .run(publication.stagedReceiptId).changes, 1);
          assert.throws(() => verify(publication, tree), /completed durable apply receipt/);
        } finally {
          db.prepare("UPDATE sync_apply_journal SET state='completed' WHERE apply_id=?").run(publication.stagedReceiptId);
          db.close();
        }
        testedStagedReceipt = true;
      }
      verify(publication, tree);
      if (startTargetWriter) {
        startTargetWriter = false;
        const code = `
          const fs = require("node:fs"), { spawnSync } = require("node:child_process");
          const { withCrossProcessLock } = require(process.argv[1]);
          const [lock, config, attempt, done, remote] = process.argv.slice(2);
          fs.writeFileSync(attempt, "attempt");
          withCrossProcessLock(lock, "legacy target mutation", 10000, async () => {
            const result = spawnSync("git", ["--git-dir", remote, "rev-parse", "refs/heads/main"], { encoding: "utf8" });
            if (result.status !== 0) throw new Error("Cannot inspect synthetic ref");
            fs.writeFileSync(done, result.stdout.trim());
            const target = JSON.parse(fs.readFileSync(config, "utf8"));
            target.targets[0].branch = "other";
            fs.writeFileSync(config, JSON.stringify(target));
          }).catch(() => { process.exitCode = 1; });
        `;
        competingWriter = spawn(process.execPath, ["-e", code, resolve("dist/runtime/cross-process-lock.js"),
          join(profile, "github-sync/targets-state.lock"), join(profile, "github-sync/targets.json"),
          join(dir, "target-writer-attempt"), join(dir, "target-writer-done"), bare],
        { env, stdio: "ignore" });
      }
      if (changeConfigBeforePush) {
        changeConfigBeforePush = false;
        if (process.env.PKM_TEST_PRIVACY_RACE === "1")
          writeFileSync(join(root, ".pkm/content-privacy.json"), JSON.stringify({ schema: 1, private: {} }));
        else writeFileSync(join(profile, "github-sync/targets.json"), config.replace('"branch":"main"', '"branch":"other"'));
      }
    }, authority);
    const transport = { policy, nativeGit, ...(visibilityApi ? { nativeGitRepositoryViaApi: true } : {}),
      ...(visibilityApi && process.env.PKM_TEST_NO_VISIBILITY_FENCE !== "1" ? {
        async withRepositoryVisibilityFence(_policy, work) {
          assert.equal(visibilityFenceHeld, false);
          visibilityFenceHeld = true;
          try { return await work(); } finally { visibilityFenceHeld = false; }
        },
      } : {}),
      fetch: async (url, options) => {
        assert(visibilityApi); assert.equal(url, "https://api.github.com/repos/fixture/fixture");
        assert.equal(options.redirect, "manual");
        assert.equal(options.headers.Authorization, "Bearer synthetic-api-token");
        repositoryRequests++;
        if (repositoryAnswer === "redirect") return new Response(null, { status: 302, headers: { location: "https://evil.invalid/" } });
        return Response.json(repositoryAnswer);
      },
      authorizeMember() {}, validateDomainContent() {}, verifyStagedPublication() {},
      async approvePublication() { return true; }, async withExpectedCommitCAS() { throw new Error("REST CAS not used"); } };
    return openExperimentalLegacySyncHost({ mode: "isolated-experiment", storage, globalStorage: profile,
      targetId: target.id, actorId: "fixture-actor", transport,
      ...(process.env.PKM_TEST_NATIVE_TRASH_SYNC === "1" ? { experimentalNativeTrash: true } : {}),
      publisherPolicy: { policyId: policy.policyId, enforcement: "atomic-git-lease" },
      readSecret: async () => {
        if (!visibilityApi) throw new Error("VS Code token must not be used");
        return JSON.stringify({ accountLabel: "fixture", accessToken: "synthetic-api-token" });
      } });
  };
  storage = (await adoptLegacyRootInPlaceExperimental(root, privateSkills ? {
    snapshotAdmission: {
      authorityId: "synthetic-root-snapshot-authority", allowedTools: ["knowledge_snapshot_status"],
      authorize: binding => binding.workspaceRoot === root && binding.operation === "admit",
    },
  } : {})).storage; host = await open();
  if (badMountAsset || badMountSymlink || badMountIdentity) {
    const before = git(dir, ["--git-dir", bare, "rev-parse", "main"]);
    await assert.rejects(host.sync());
    assert.equal(git(dir, ["--git-dir", bare, "rev-parse", "main"]), before);
    assert.equal(await readFile(pushes, "utf8").catch(() => ""), "");
    assert.equal(await readFile(join(root, "skills/One.md"), "utf8"), badMountIdentity
      ? "---\nname: One\nknowledgeId: knowledge_aaaaaaaaaaaaaaaaaaaaaaaa\n---\nlocal\n" : skill("local"));
    return;
  }
  const initial = await host.sync();
  assert.equal(initial.state, "comparison"); assert.equal(initial.session.plan.conflicts.length, 1);
  await host.decide({ sessionId: initial.session.sessionId, operationId: randomUUID(), expectedRevision: initial.session.revision,
    conflictId: initial.session.plan.conflicts[0].id, choice: "local", reason: "Synthetic decision" });
  if (visibilityApi && privateSkills && process.env.PKM_TEST_NO_VISIBILITY_FENCE === "1") {
    const before = git(dir, ["--git-dir", bare, "rev-parse", "main"]);
    await assert.rejects(host.confirmComparison(initial.session.sessionId), /denied/);
    assert.equal(git(dir, ["--git-dir", bare, "rev-parse", "main"]), before);
    assert.equal(await readFile(pushes, "utf8").catch(() => ""), "");
    return;
  }
  assert.equal((await host.confirmComparison(initial.session.sessionId)).state, "published");
  assert.equal(testedStagedReceipt, true);
  assert.equal(git(dir, ["--git-dir", bare, "show", `main:${remoteSkills}/One.md`]), skill("local").trim());

  if (process.env.PKM_TEST_NATIVE_TRASH_SYNC === "1") {
    assert(skillsMount && skillAssets);
    const syncOrCrash = async direction => {
      if (process.env.PKM_TEST_TRASH_CRASH_DIRECTION !== direction) return host.sync();
      await host.close(); host = undefined; await storage.close(); storage = undefined;
      const configFile = join(dir, "crash-worker.json");
      await writeFile(configFile, JSON.stringify({ root, profile, cache, bin, home, target, policy,
        fault: process.env.PKM_TEST_TRASH_CRASH_POINT }), { mode: 0o600 });
      const child = spawnSync(process.execPath, [resolve("next-server/tests/legacy-github-sync-trash-worker.mjs"), configFile],
        { env: { ...env, GIT_ALLOW_PROTOCOL: "file:ssh", TMPDIR: process.env.TMPDIR }, encoding: "utf8", timeout: 60000 });
      assert.equal(child.signal, "SIGKILL", `${child.stdout}\n${child.stderr}`);
      const journalDirectory = join(profile, "github-sync/experimental-next");
      const staging = (await readdir(journalDirectory)).filter(name => name.endsWith(".staging"));
      if (["trash-journal-written", "trash-journal-synced"].includes(process.env.PKM_TEST_TRASH_CRASH_POINT))
        assert(staging.length > 0);
      storage = await Storage.open(root, { deferRecovery: true }); host = await open();
      const state = await host.resume();
      const result = state.state === "idle" ? await host.sync() : state;
      for (const file of staging) assert((await readdir(journalDirectory)).includes(file), "Unknown staged journal must be preserved");
      return result;
    };
    await host.close(); host = undefined;
    let runtime = await createNativeRuntime({ storage, trash: { layoutVersion: "pkm.trash-lifecycle/v1" } });
    const request = { operation: "knowledge.trash.lifecycle.preview", actorId: "fixture-actor",
      args: { area: "skills", path: "One.md", kind: "document" } };
    const preview = await runtime.services.migration.read(request);
    const receipt = await runtime.services.migration.mutate({ operation: "knowledge.trash.move", actorId: "fixture-actor",
      args: { ...request.args, operationId: randomUUID(), expectedTreeSha256: preview.treeSha256,
        expectedScanRevision: preview.scanRevision, entryIdFormat: "original" } });
    await runtime.close(); host = await open();
    assert.equal((await host.sync()).state, "published");
    const manifest = JSON.parse(git(dir, ["--git-dir", bare, "show", `main:${remoteManifest}`]));
    assert(manifest.deletions.some(item => item.type === "skills" && item.itemId === "One"));
    assert(!git(dir, ["--git-dir", bare, "ls-tree", "-r", "--name-only", "main"]).split("\n").includes(`${remoteSkills}/One.md`));
    await host.close(); host = undefined;
    runtime = await createNativeRuntime({ storage, trash: { layoutVersion: "pkm.trash-lifecycle/v1" } });
    const scan = await runtime.services.migration.read({ operation: "knowledge.trash.lifecycle.preview", actorId: "fixture-actor",
      args: { area: "skills", path: "Private/Secret.md", kind: "document" } });
    await runtime.services.migration.mutate({ operation: "knowledge.trash.restore", actorId: "fixture-actor",
      args: { operationId: randomUUID(), entryId: receipt.entryId, expectedScanRevision: scan.scanRevision } });
    await runtime.close(); host = await open();
    assert.equal((await host.sync()).state, "published");
    assert.equal(git(dir, ["--git-dir", bare, "show", `main:${remoteSkills}/One.md`]), skill("local").trim());
    assert.equal(git(dir, ["--git-dir", bare, "show", `main:${remoteSkills}/One.assets/icon.png`]), "synthetic image base");
    git(seed, ["fetch", "-q", "origin", "main"]); git(seed, ["reset", "-q", "--hard", "FETCH_HEAD"]);
    const remoteManifestFile = join(seed, remoteManifest);
    const remoteDelete = JSON.parse(await readFile(remoteManifestFile, "utf8"));
    const savedMembers = remoteDelete.files.filter(item => item.type === "skills" && item.itemId === "One");
    remoteDelete.files = remoteDelete.files.filter(item => !(item.type === "skills" && item.itemId === "One"));
    remoteDelete.deletions.push({ type: "skills", itemId: "One", category: "", privacy: "public",
      deletedAt: "2025-01-02T03:04:05.000Z" });
    await rm(join(seed, remoteSkills, "One.md"));
    await rm(join(seed, remoteSkills, "One.assets"), { recursive: true });
    await writeFile(remoteManifestFile, JSON.stringify(remoteDelete) + "\n");
    git(seed, ["add", "-A"]); git(seed, ["commit", "-qm", "remote deletion"]); git(seed, ["push", "-q", "origin", "main"]);
    if (process.env.PKM_TEST_TRASH_CONFLICT === "1") {
      await writeFile(join(root, "skills/One.md"), skill("concurrent local edit"));
      const conflict = await host.sync();
      assert.equal(conflict.state, "conflict");
      const comparison = await host.inspectComparison();
      const item = comparison.session.plan.conflicts.find(value => value.itemId === "One");
      assert(item);
      await host.decide({ sessionId: comparison.session.sessionId, operationId: randomUUID(),
        expectedRevision: comparison.session.revision, conflictId: item.id, choice: "remote", reason: "Synthetic reviewed deletion" });
      assert.equal((await host.confirmComparison(comparison.session.sessionId)).state, "published");
      const entries = await readdir(join(root, "skills/.trash"));
      assert.equal(entries.length, 1);
      assert.equal(await readFile(join(root, "skills/.trash", entries[0], "payload"), "utf8"), skill("concurrent local edit"));
      assert.equal(await readFile(join(root, "skills/.trash", entries[0], "assets/icon.png"), "utf8"), "synthetic image base");
      assert.equal(await readFile(join(root, "notes/Note.md"), "utf8"), localNote);
      assert.equal(await readFile(join(root, "prompts/Prompt.md"), "utf8"), localPrompt);
      return;
    }
    if (process.env.PKM_TEST_TRASH_UNKNOWN === "1") {
      await writeFile(drop, "drop\n");
      await assert.rejects(host.sync());
      const delivered = git(dir, ["--git-dir", bare, "rev-parse", "main"]);
      const pushCount = await readFile(pushes, "utf8");
      await host.close(); host = undefined; await storage.close(); storage = undefined;
      await rm(drop, { force: true });
      storage = await Storage.open(root, { deferRecovery: true }); host = await open();
      assert.equal((await host.resume()).state, "published");
      assert.equal(git(dir, ["--git-dir", bare, "rev-parse", "main"]), delivered);
      assert.equal(await readFile(pushes, "utf8"), pushCount);
    } else assert.equal((await syncOrCrash("delete")).state, "published");
    const entries = await readdir(join(root, "skills/.trash"));
    assert.equal(entries.length, 1);
    assert.equal(await readFile(join(root, "skills/.trash", entries[0], "payload"), "utf8"), skill("local"));
    assert.equal(await readFile(join(root, "skills/.trash", entries[0], "assets/icon.png"), "utf8"), "synthetic image base");
    await host.close(); host = undefined; await storage.close(); storage = undefined;
    storage = await Storage.open(root, { deferRecovery: true }); host = await open();
    assert.equal((await host.resume()).state, "idle");
    assert.equal((await host.sync()).state, "published");
    const currentManifest = JSON.parse(git(dir, ["--git-dir", bare, "show", `main:${remoteManifest}`]));
    assert.equal(currentManifest.deletions.find(item => item.type === "skills" && item.itemId === "One").deletedAt,
      "2025-01-02T03:04:05.000Z");
    assert.deepEqual(await readdir(join(root, "skills/.trash")), entries);
    git(seed, ["fetch", "-q", "origin", "main"]); git(seed, ["reset", "-q", "--hard", "FETCH_HEAD"]);
    const remoteRestore = JSON.parse(await readFile(remoteManifestFile, "utf8"));
    remoteRestore.deletions = remoteRestore.deletions.filter(item => !(item.type === "skills" && item.itemId === "One"));
    if (process.env.PKM_TEST_TRASH_DIVERGENT_RESTORE === "1")
      savedMembers.find(item => item.path === "skills/One.md").digest = digest(skill("different remote restore"));
    remoteRestore.files.push(...savedMembers);
    await mkdir(join(seed, remoteSkills, "One.assets"));
    await writeFile(join(seed, remoteSkills, "One.md"), skill(process.env.PKM_TEST_TRASH_DIVERGENT_RESTORE === "1"
      ? "different remote restore" : "local"));
    await writeFile(join(seed, remoteSkills, "One.assets/icon.png"), "synthetic image base");
    await writeFile(remoteManifestFile, JSON.stringify(remoteRestore) + "\n");
    git(seed, ["add", "-A"]); git(seed, ["commit", "-qm", "remote restore"]); git(seed, ["push", "-q", "origin", "main"]);
    if (process.env.PKM_TEST_TRASH_DIVERGENT_RESTORE === "1") {
      await assert.rejects(host.sync(), /Trash|trash|restore/i);
      assert.deepEqual(await readdir(join(root, "skills/.trash")), entries);
      assert.equal(await readFile(join(root, "skills/.trash", entries[0], "payload"), "utf8"), skill("local"));
      assert.equal(await readFile(join(root, "skills/.trash", entries[0], "assets/icon.png"), "utf8"), "synthetic image base");
      assert.equal(await readFile(join(root, "notes/Note.md"), "utf8"), localNote);
      assert.equal(await readFile(join(root, "prompts/Prompt.md"), "utf8"), localPrompt);
      return;
    }
    assert.equal((await syncOrCrash("restore")).state, "published");
    assert.equal(await readFile(join(root, "skills/One.md"), "utf8"), skill("local"));
    assert.equal(await readFile(join(root, "skills/One.assets/icon.png"), "utf8"), "synthetic image base");
    assert.deepEqual(await readdir(join(root, "skills/.trash")), []);
    assert.equal(await readFile(join(root, "notes/Note.md"), "utf8"), localNote);
    assert.equal(await readFile(join(root, "prompts/Prompt.md"), "utf8"), localPrompt);
    return;
  }

  if (process.env.PKM_TEST_ORIGINAL_TRASH_GUARD === "1") {
    assert(skillsMount && skillAssets);
    const before = git(dir, ["--git-dir", bare, "rev-parse", "main"]);
    await host.close(); host = undefined; await storage.close(); storage = undefined;
    const original = require("../legacy/dist/knowledge/filestore.js");
    original.setStorePath(root);
    assert.throws(() => original.skillMoveToTrash("One"), /legacy writes are fenced/);
    const oldRoot = join(dir, "original-root");
    await mkdir(join(oldRoot, "skills/One.assets"), { recursive: true });
    await mkdir(join(oldRoot, ".pkm/state"), { recursive: true });
    await writeFile(join(oldRoot, "skills/One.md"), skill("local"));
    await writeFile(join(oldRoot, "skills/One.assets/icon.png"), "synthetic image base");
    original.setStorePath(oldRoot);
    const deletionFile = join(oldRoot, ".pkm/state/knowledge-deletions.json");
    const unrelated = { path: "notes/Unknown.md", deletedAt: "2025-01-02T03:04:05.000Z" };
    await writeFile(deletionFile, JSON.stringify({ schema: 1, records: [unrelated] }) + "\n", { mode: 0o600 });
    const entry = original.skillMoveToTrash("One");
    assert(entry);
    const bucket = join(oldRoot, "skills/.trash", entry.id);
    assert.equal(await readFile(join(bucket, "payload"), "utf8"), skill("local"));
    assert.equal(await readFile(join(bucket, "assets/icon.png"), "utf8"), "synthetic image base");
    const deletedJournal = await readFile(deletionFile, "utf8");
    assert.deepEqual(JSON.parse(deletedJournal).records[0], unrelated);
    assert.equal(await readFile(deletionFile, "utf8"), deletedJournal);
    assert.deepEqual(original.skillTrashRestore(entry.id), { ok: true, path: "One.md" });
    assert.equal(await readFile(join(oldRoot, "skills/One.md"), "utf8"), skill("local"));
    assert.equal(await readFile(join(oldRoot, "skills/One.assets/icon.png"), "utf8"), "synthetic image base");
    assert.deepEqual(JSON.parse(await readFile(deletionFile, "utf8")).records, [unrelated]);
    assert.equal(await readFile(join(root, "notes/Note.md"), "utf8"), localNote);
    assert.equal(await readFile(join(root, "prompts/Prompt.md"), "utf8"), localPrompt);
    assert.equal(git(dir, ["--git-dir", bare, "rev-parse", "main"]), before);
    return;
  }

  if (process.env.PKM_TEST_LEGACY_DELETION_GUARD === "1") {
    const journal = JSON.stringify({ schema: 1, records: [
      { path: "skills/One.md", deletedAt: "2025-01-02T03:04:05.000Z" },
      { path: "notes/Unknown.md", deletedAt: "2025-01-02T03:04:05.000Z", futureField: "preserve" },
    ], futureField: "preserve" }) + "\n";
    await mkdir(join(root, ".pkm/state"), { recursive: true, mode: 0o700 });
    await writeFile(join(root, ".pkm/state/knowledge-deletions.json"), journal, { mode: 0o600 });
    await rm(join(root, "skills/One.md"));
    const before = git(dir, ["--git-dir", bare, "rev-parse", "main"]);
    const pushCount = await readFile(pushes, "utf8");
    await assert.rejects(host.sync(), /original Skills deletion requires recoverable reconciliation/);
    await host.close(); host = undefined; await storage.close(); storage = undefined;
    await assert.rejects(Storage.open(root, { deferRecovery: true }));
    assert.equal(await readFile(join(root, ".pkm/state/knowledge-deletions.json"), "utf8"), journal);
    assert.equal(await readFile(join(root, "notes/Note.md"), "utf8"), localNote);
    assert.equal(await readFile(join(root, "prompts/Prompt.md"), "utf8"), localPrompt);
    assert.equal(await readFile(pushes, "utf8"), pushCount);
    assert.equal(git(dir, ["--git-dir", bare, "rev-parse", "main"]), before);
    return;
  }
  if (process.env.PKM_TEST_UNRELATED_DELETION === "1") {
    const journal = JSON.stringify({ schema: 1, records: [
      { path: "notes/Unknown.md", deletedAt: "2025-01-02T03:04:05.000Z", futureField: "preserve" },
    ], futureField: "preserve" }) + "\n";
    const file = join(root, ".pkm/state/knowledge-deletions.json");
    await mkdir(join(root, ".pkm/state"), { recursive: true, mode: 0o700 });
    await writeFile(file, journal, { mode: 0o600 });
    await writeFile(join(root, "skills/One.md"), skill("journal-safe push"));
    assert.equal((await host.sync()).state, "published");
    assert.equal(await readFile(file, "utf8"), journal);
    assert.equal(await readFile(join(root, "notes/Note.md"), "utf8"), localNote);
    assert.equal(await readFile(join(root, "prompts/Prompt.md"), "utf8"), localPrompt);
    assert.equal(git(dir, ["--git-dir", bare, "show", `main:${remoteSkills}/One.md`]), skill("journal-safe push").trim());
    return;
  }

  if (visibilityApi) {
    assert(repositoryRequests > 0);
    const before = git(dir, ["--git-dir", bare, "rev-parse", "main"]);
    for (const answer of [{ full_name: "fixture/fixture", private: !privateSkills },
      { full_name: "other/fixture", private: privateSkills }, "redirect"]) {
      repositoryAnswer = answer;
      await assert.rejects(host.sync(), error => !/synthetic-api-token/.test(error.message));
      assert.equal(git(dir, ["--git-dir", bare, "rev-parse", "main"]), before);
    }
    repositoryAnswer = { full_name: "fixture/fixture", private: privateSkills };
  }
  if (process.env.PKM_TEST_TARGET_FENCE === "1") {
    assert.equal(https, false);
    await writeFile(join(dir, "wait-for-target-writer"), "armed");
    await writeFile(join(root, "skills/One.md"), skill("fenced target update"));
    startTargetWriter = true;
    const result = await host.sync();
    assert.equal(result.state, "published");
    assert(competingWriter);
    const exit = competingWriter.exitCode === null
      ? await new Promise(resolve => competingWriter.once("exit", resolve)) : competingWriter.exitCode;
    assert.equal(exit, 0);
    assert.equal(await readFile(join(dir, "target-writer-done"), "utf8"), result.commit);
    assert.equal(git(dir, ["--git-dir", bare, "rev-parse", "main"]), result.commit);
    assert.equal(JSON.parse(await readFile(join(profile, "github-sync/targets.json"), "utf8")).targets[0].branch, "other");
    return;
  }
  if (privateSkills) {
    const before = git(dir, ["--git-dir", bare, "rev-parse", "main"]);
    await writeFile(join(root, ".pkm/content-privacy.json"), JSON.stringify({ schema: 1, private: {} }));
    await assert.rejects(host.sync(), /privacy/);
    assert.equal(git(dir, ["--git-dir", bare, "rev-parse", "main"]), before);
    await writeFile(join(root, ".pkm/content-privacy.json"), privacyJson);
  }
  await writeFile(join(root, "skills/One.md"), skill("local push"));
  if (skillAssets) await writeFile(join(root, "skills/One.assets/icon.png"), Buffer.from("synthetic image pushed"));
  if (privateSkills) await writeFile(join(root, "skills/Private/Secret.md"), privateSkill("private push"));
  assert.equal((await host.sync()).state, "published");
  if (privateSkills)
    assert.equal(git(dir, ["--git-dir", bare, "show", `main:${remoteSkills}/Private/Secret.md`]), privateSkill("private push").trim());
  if (skillAssets) assert.equal(git(dir, ["--git-dir", bare, "show", `main:${remoteSkills}/One.assets/icon.png`]), "synthetic image pushed");
  if (process.env.PKM_TEST_CONFIG_RACE === "1" || process.env.PKM_TEST_PRIVACY_RACE === "1") {
    if (process.env.PKM_TEST_PRIVACY_RACE === "1") assert.equal(privateSkills, true);
    const before = (await readFile(pushes, "utf8")).split("\n").filter(Boolean).length;
    const remoteBefore = git(dir, ["--git-dir", bare, "rev-parse", "main"]);
    await writeFile(join(root, "skills/One.md"), skill("configuration race"));
    changeConfigBeforePush = true;
    await assert.rejects(host.sync());
    assert.equal(git(dir, ["--git-dir", bare, "rev-parse", "main"]), remoteBefore);
    assert.equal((await readFile(pushes, "utf8")).split("\n").filter(Boolean).length, before);
    if (process.env.PKM_TEST_PRIVACY_RACE === "1") await writeFile(join(root, ".pkm/content-privacy.json"), privacyJson);
    else await writeFile(join(profile, "github-sync/targets.json"), config);
    assert.equal((await host.resume()).state, "review");
    await host.close(); host = undefined; await storage.close(); storage = undefined;
    storage = await Storage.open(root, { deferRecovery: true }); host = await open();
    assert.equal((await host.resume()).state, "review");
    return;
  }
  git(seed, ["fetch", "-q", "origin", "main"]); git(seed, ["reset", "-q", "--hard", "FETCH_HEAD"]);
  await writeFile(join(seed, remoteSkills, "One.md"), skill("remote pull"));
  const manifest = JSON.parse(await readFile(join(seed, remoteManifest), "utf8"));
  manifest.files.find(file => file.path === "skills/One.md").digest = digest(skill("remote pull"));
  if (process.env.PKM_TEST_ASSET_REMOVAL === "1") {
    assert(skillAssets);
    await rm(join(seed, remoteSkills, "One.assets/icon.png"));
    manifest.files = manifest.files.filter(file => file.path !== "skills/One.assets/icon.png");
    await writeFile(join(seed, remoteManifest), JSON.stringify(manifest) + "\n");
    git(seed, ["add", "-A"]); git(seed, ["commit", "-qm", "remove asset"]); git(seed, ["push", "-q", "origin", "main"]);
    const before = git(dir, ["--git-dir", bare, "rev-parse", "main"]);
    const result = await host.sync();
    assert.equal(result.state, "conflict");
    const comparison = await host.inspectComparison();
    for (const conflict of comparison.session.plan.conflicts) {
      await host.decide({ sessionId: comparison.session.sessionId, operationId: randomUUID(),
        expectedRevision: (await host.inspectComparison()).session.revision,
        conflictId: conflict.id, choice: "remote", reason: "Synthetic removal" });
    }
    await assert.rejects(host.confirmComparison(comparison.session.sessionId), /requires recoverable Trash integration/);
    assert.equal(await readFile(join(root, "skills/One.assets/icon.png"), "utf8"), "synthetic image pushed");
    assert.equal(await readFile(join(root, "skills/One.md"), "utf8"), skill("local push"));
    assert.equal(git(dir, ["--git-dir", bare, "rev-parse", "main"]), before);
    return;
  }
  if (privateSkills) {
    await writeFile(join(seed, remoteSkills, "Private/Secret.md"), privateSkill("private pull"));
    manifest.files.find(file => file.path === "skills/Private/Secret.md").digest = digest(privateSkill("private pull"));
  }
  if (skillAssets) {
    const bytes = Buffer.from("synthetic image pulled");
    await writeFile(join(seed, remoteSkills, "One.assets/icon.png"), bytes);
    manifest.files.find(file => file.path === "skills/One.assets/icon.png").digest = digest(bytes);
  }
  await writeFile(join(seed, remoteManifest), JSON.stringify(manifest) + "\n");
  git(seed, ["add", "."]); git(seed, ["commit", "-qm", "remote"]); git(seed, ["push", "-q", "origin", "main"]);
  assert.equal((await host.sync()).state, "published");
  assert.equal(await readFile(join(root, "skills/One.md"), "utf8"), skill("remote pull"));
  if (privateSkills) {
    assert.equal(await readFile(join(root, "skills/Private/Secret.md"), "utf8"), privateSkill("private pull"));
    assert.equal((await stat(join(root, "skills/Private/Secret.md"))).mode & 0o077, 0);
    assert.equal(await readFile(join(root, ".pkm/content-privacy.json"), "utf8"), privacyJson);
  }
  if (skillAssets) assert.equal(await readFile(join(root, "skills/One.assets/icon.png"), "utf8"), "synthetic image pulled");
  await writeFile(join(root, "skills/One.md"), skill("unknown response"));
  await writeFile(drop, "drop\n");
  await assert.rejects(host.sync());
  const delivered = git(dir, ["--git-dir", bare, "rev-parse", "main"]);
  const count = (await readFile(pushes, "utf8")).split("\n").filter(Boolean).length;
  await host.close(); host = undefined; await storage.close(); storage = undefined; await rm(drop, { force: true });
  storage = await Storage.open(root, { deferRecovery: true }); host = await open();
  assert.equal((await host.resume()).state, "published");
  assert.equal(git(dir, ["--git-dir", bare, "rev-parse", "main"]), delivered);
  assert.equal((await readFile(pushes, "utf8")).split("\n").filter(Boolean).length, count);
  assert.equal(await readFile(join(root, "notes/Note.md"), "utf8"), localNote);
  assert.equal(await readFile(join(root, "prompts/Prompt.md"), "utf8"), localPrompt);
  if (partialSelection) {
    assert.equal(await readFile(join(root, "skills/Unselected.md"), "utf8"), unselectedSkill("local only"));
    assert.equal(git(dir, ["--git-dir", bare, "show", `main:${remoteSkills}/Unselected.md`]), unselectedSkill("remote only").trim());
  }
  assert.equal(git(dir, ["--git-dir", bare, "show", "main:notes/Note.md"]), remoteNote.trim());
  assert.equal(git(dir, ["--git-dir", bare, "show", "main:prompts/Prompt.md"]), remotePrompt.trim());
  assert.equal(await readFile(join(profile, "github-sync/targets.json"), "utf8"), config);

  if (https) {
    const helper = join(bin, "credential-helper");
    const valid = await readFile(helper, "utf8");
    await writeFile(helper, "#!/bin/sh\ncat >/dev/null\nif [ \"$1\" = get ]; then printf 'username=fixture\\npassword=wrong-synthetic-token\\n\\n'; fi\n");
    await assert.rejects(host.sync(), error => !/synthetic-token/.test(error.message));
    assert.equal(git(dir, ["--git-dir", bare, "rev-parse", "main"]), delivered);
    await writeFile(helper, valid);
    await writeFile(join(dir, "git-redirect"), "redirect\n");
    await assert.rejects(host.sync());
    await rm(join(dir, "git-redirect"));
    assert.equal(git(dir, ["--git-dir", bare, "rev-parse", "main"]), delivered);
    const configPath = join(home, ".gitconfig"), original = await readFile(configPath, "utf8");
    const helperBefore = await readFile(join(dir, "helper-actions"), "utf8");
    await writeFile(configPath, `${original}\n[url "https://evil.invalid/"]\n\tinsteadOf = https://github.com/\n`);
    await assert.rejects(host.sync());
    assert.equal(await readFile(join(dir, "helper-actions"), "utf8"), helperBefore);
    await writeFile(configPath, original);
  } else {
    const args = await readFile(join(dir, "ssh-args"), "utf8");
    assert.match(args, /IdentitiesOnly=yes/);
    assert.doesNotMatch(args, /-F \/dev\/null/);
  }

  git(seed, ["fetch", "-q", "origin", "main"]); git(seed, ["reset", "-q", "--hard", "FETCH_HEAD"]);
  git(seed, ["commit", "--allow-empty", "-qm", "concurrent"]); git(seed, ["push", "-q", "origin", "HEAD:refs/heads/race"]);
  const concurrent = git(seed, ["rev-parse", "HEAD"]);
  await writeFile(join(root, "skills/One.md"), skill("racing local"));
  await writeFile(race, "race\n");
  await assert.rejects(host.sync());
  assert.equal(git(dir, ["--git-dir", bare, "rev-parse", "main"]), concurrent);
  await rm(race);
  assert.equal((await host.resume()).state, "review");
});
