import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, rm, rmdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { manifestJson, MANIFEST_PATH } from "../dist/domain/sync-transport-original.js";
import { adoptLegacyRootInPlaceExperimental, legacyRootAdoptionLockDirectory } from "../dist/legacy-root-adoption.js";
import { openExperimentalLegacySyncHost } from "../dist/legacy-github-sync-experimental-host.js";
import { Storage } from "../dist/storage.js";
import { localGitSyncProvider } from "./local-git-sync-provider.mjs";

const digest = value => createHash("sha256").update(value).digest("hex");
function git(cwd, args) {
  const result = spawnSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args], {
    cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" },
  });
  assert.equal(result.status, 0, `private Git ${args[0]}: ${result.stderr}`);
  return result.stdout.trim();
}
const skill = body => `---\nname: One\n---\n${body}\n`;
const file = (type, name, content) => ({
  path: `${type}/${name}.md`, type, itemId: name, member: "", category: "", privacy: "public", digest: digest(content),
});

test("isolated host binds legacy target, secret and recovery, preserving non-Skills across crash and conflict", { timeout: 90000 }, async t => {
  const dir = resolve(".migration-test-work", `legacy-sync-host-${randomUUID()}`);
  const root = join(dir, "root"), seed = join(dir, "seed"), bare = join(dir, "remote.git");
  const globalStorage = join(dir, "profile"), sync = join(globalStorage, "github-sync");
  const config = join(sync, "targets.json"), transaction = join(sync, "checkouts/fixture-target/transactions/latest.json");
  for (const dir of [join(root, "skills"), join(root, "notes"), join(root, "prompts"),
    join(seed, "skills"), join(seed, "notes"), join(seed, "prompts"), join(sync, "checkouts/fixture-target/transactions")])
    await mkdir(dir, { recursive: true });
  let storage, host;
  t.after(async () => {
    if (host) await host.close();
    if (storage) await storage.close();
    const locks = legacyRootAdoptionLockDirectory(root);
    for (const suffix of [".sqlite", ".writer.lock", ".writer-fenced.json"]) await rm(join(locks, digest(root).slice(0, 40) + suffix), { force: true });
    await rmdir(locks).catch(error => { if (!["ENOENT", "ENOTEMPTY"].includes(error.code)) throw error; });
    await rm(dir, { recursive: true, force: true });
  });

  await t.test("first Skills comparison requires reviewed decisions and a fresh explicit confirmation", { timeout: 90000 }, async t => {
    const dir = resolve(".migration-test-work", `legacy-sync-first-${randomUUID()}`);
    const root = join(dir, "root"), seed = join(dir, "seed"), bare = join(dir, "remote.git");
    const globalStorage = join(dir, "profile"), sync = join(globalStorage, "github-sync");
    for (const folder of [join(root, "skills"), join(root, "notes"), join(root, "prompts"),
      join(seed, "skills"), join(seed, "notes"), join(seed, "prompts"), sync]) await mkdir(folder, { recursive: true });
    let storage, host;
    t.after(async () => {
      if (host) await host.close();
      if (storage) await storage.close();
      const locks = legacyRootAdoptionLockDirectory(root);
      for (const suffix of [".sqlite", ".writer.lock", ".writer-fenced.json"]) await rm(join(locks, digest(root).slice(0, 40) + suffix), { force: true });
      await rmdir(locks).catch(error => { if (!["ENOENT", "ENOTEMPTY"].includes(error.code)) throw error; });
      await rm(dir, { recursive: true, force: true });
    });
    const content = (name, body) => `---\nname: ${name}\n---\n${body}\n`;
    const remoteNote = "---\ntitle: Note\n---\nremote note\n";
    const remotePrompt = "---\ntitle: Prompt\n---\nremote prompt\n";
    const localNote = "---\ntitle: Note\ndocumentId: fixture-note\nrevision: 1\n---\nlocal note\n";
    const localPrompt = "---\ntitle: Prompt\n---\nlocal prompt\n";
    const files = [file("skills", "One", content("One", "remote")), file("skills", "Two", content("Two", "remote")),
      file("skills", "Remote", content("Remote", "remote only")),
      file("notes", "Note", remoteNote), file("prompts", "Prompt", remotePrompt)];
    for (const entry of files) {
      const value = entry.type === "notes" ? remoteNote : entry.type === "prompts" ? remotePrompt
        : entry.itemId === "Remote" ? content("Remote", "remote only") : content(entry.itemId, "remote");
      await writeFile(join(seed, entry.path), value);
    }
    await writeFile(join(seed, MANIFEST_PATH), manifestJson(files, []));
    await writeFile(join(root, "skills/One.md"), content("One", "local"));
    await writeFile(join(root, "skills/Two.md"), content("Two", "local"));
    await writeFile(join(root, "skills/Local.md"), content("Local", "local only"));
    await writeFile(join(root, "notes/Note.md"), localNote); await writeFile(join(root, "prompts/Prompt.md"), localPrompt);
    git(seed, ["init", "-q"]); git(seed, ["config", "user.name", "Fixture"]); git(seed, ["config", "user.email", "fixture@example.invalid"]);
    git(seed, ["add", "."]); git(seed, ["commit", "-qm", "initial"]); git(seed, ["branch", "-M", "main"]);
    git(dir, ["clone", "--bare", "-q", seed, bare]); git(seed, ["remote", "add", "origin", bare]);
    const target = { schema: 1, id: "fixture-target", name: "Synthetic", repository: "https://github.com/fixture/fixture.git", branch: "main",
      authentication: { method: "vscode", expectedLogin: "fixture" },
      selection: { public: { skills: { items: [], folders: [""] } }, private: {} } };
    const config = JSON.stringify({ schema: 1, targets: [target] }) + "\n";
    await writeFile(join(sync, "targets.json"), config, { mode: 0o600 });
    const provider = localGitSyncProvider(dir, bare);
    const options = () => ({ mode: "isolated-experiment", storage, globalStorage, targetId: target.id, actorId: "fixture-actor",
      transport: provider.host, publisherPolicy: { policyId: provider.host.policy.policyId, enforcement: "all-repository-ref-writers" },
      readSecret: async () => JSON.stringify({ accountLabel: "fixture", accessToken: "fixture-token" }) });
    storage = (await adoptLegacyRootInPlaceExperimental(root, {})).storage;
    host = await openExperimentalLegacySyncHost(options());
    const before = git(dir, ["--git-dir", bare, "rev-parse", "main"]);
    const invalid = content("Other", "remote");
    const invalidManifest = JSON.parse(await readFile(join(seed, MANIFEST_PATH), "utf8"));
    invalidManifest.files.find(entry => entry.path === "skills/One.md").digest = digest(invalid);
    await writeFile(join(seed, "skills/One.md"), invalid);
    await writeFile(join(seed, MANIFEST_PATH), JSON.stringify(invalidManifest) + "\n");
    git(seed, ["add", "."]); git(seed, ["commit", "-qm", "invalid identity"]); git(seed, ["push", "-q", "origin", "main"]);
    await assert.rejects(host.sync(), /Skill identity or category requires review/);
    assert.equal(await readFile(join(root, "skills/One.md"), "utf8"), content("One", "local"));
    git(seed, ["reset", "-q", "--hard", before]); git(seed, ["push", "-q", "--force", "origin", "main"]);
    const preview = await host.sync();
    assert.equal(preview.state, "comparison"); assert.equal(preview.commit, before);
    assert.deepEqual(preview.session.plan.proposals.map(item => [item.itemId, item.source]), [["Local", "local"], ["Remote", "remote"]]);
    assert.equal(preview.session.plan.conflicts[0].itemId, "One");
    assert.equal(git(dir, ["--git-dir", bare, "rev-parse", "main"]), before);
    assert.equal(await readFile(join(root, "skills/One.md"), "utf8"), content("One", "local"));
    await assert.rejects(host.confirmComparison(preview.session.sessionId), /unresolved conflicts/);
    await host.close(); host = undefined; await storage.close(); storage = undefined;
    storage = await Storage.open(root); host = await openExperimentalLegacySyncHost(options());
    assert.deepEqual(await host.resume(), preview);
    await host.decide({ sessionId: preview.session.sessionId, operationId: randomUUID(), expectedRevision: preview.session.revision,
      conflictId: preview.session.plan.conflicts[0].id, choice: "local", reason: "Keep reviewed local Skill" });
    await host.close(); host = undefined; await storage.close(); storage = undefined;
    storage = await Storage.open(root); host = await openExperimentalLegacySyncHost(options());
    const partial = (await host.inspectComparison()).session;
    assert.equal(partial.decisions.length, 1);
    await assert.rejects(host.confirmComparison(preview.session.sessionId), /unresolved conflicts/);
    await host.decide({ sessionId: partial.sessionId, operationId: randomUUID(), expectedRevision: partial.revision,
      conflictId: partial.plan.conflicts[1].id, choice: "remote", reason: "Use reviewed remote Skill" });
    git(seed, ["commit", "--allow-empty", "-qm", "advance"]); git(seed, ["push", "-q", "origin", "main"]);
    await assert.rejects(host.confirmComparison(preview.session.sessionId), /branch advanced/);
    assert.equal(await readFile(join(root, "skills/One.md"), "utf8"), content("One", "local"));
    await host.discardComparison(preview.session.sessionId);
    const fresh = await host.sync();
    const freshDecision = await host.decide({ sessionId: fresh.session.sessionId, operationId: randomUUID(), expectedRevision: fresh.session.revision,
      conflictId: fresh.session.plan.conflicts[0].id, choice: "local", reason: "Keep reviewed local Skill" });
    await host.decide({ sessionId: fresh.session.sessionId, operationId: randomUUID(), expectedRevision: freshDecision.revision,
      conflictId: fresh.session.plan.conflicts[1].id, choice: "remote", reason: "Use reviewed remote Skill" });
    const result = await host.confirmComparison(fresh.session.sessionId);
    assert.equal(result.state, "published");
    assert.equal(await readFile(join(root, "skills/Remote.md"), "utf8"), content("Remote", "remote only"));
    assert.equal(await readFile(join(root, "skills/Two.md"), "utf8"), content("Two", "remote"));
    assert.equal(git(dir, ["--git-dir", bare, "show", "main:skills/One.md"]), content("One", "local").trim());
    assert.equal(git(dir, ["--git-dir", bare, "show", "main:skills/Local.md"]), content("Local", "local only").trim());
    assert.equal(await readFile(join(root, "notes/Note.md"), "utf8"), localNote);
    assert.equal(await readFile(join(root, "prompts/Prompt.md"), "utf8"), localPrompt);
    assert.equal(git(dir, ["--git-dir", bare, "show", "main:notes/Note.md"]), remoteNote.trim());
    assert.equal(git(dir, ["--git-dir", bare, "show", "main:prompts/Prompt.md"]), remotePrompt.trim());
    assert.equal(await readFile(join(sync, "targets.json"), "utf8"), config);
    await host.close(); host = undefined; await storage.close(); storage = undefined;
    storage = await Storage.open(root); host = await openExperimentalLegacySyncHost(options());
    assert.deepEqual(await host.resume(), { state: "idle", baseline: result.commit });
  });
  const localNote = "---\ntitle: Note\ndocumentId: fixture-note\nrevision: 1\n---\nlocal note\n";
  const localPrompt = "---\ntitle: Prompt\n---\nlocal prompt\n";
  const remoteNote = "---\ntitle: Remote\n---\nremote note\n";
  const remotePrompt = "---\ntitle: Remote\n---\nremote prompt\n";
  await writeFile(join(root, "notes/Note.md"), localNote);
  await writeFile(join(root, "prompts/Prompt.md"), localPrompt);
  await writeFile(join(root, "skills/One.md"), skill("local change"));
  const files = [file("skills", "One", skill("base")), file("notes", "Note", remoteNote), file("prompts", "Prompt", remotePrompt)];
  for (const item of files) await writeFile(join(seed, item.path), item.type === "skills" ? skill("base") : item.type === "notes" ? remoteNote : remotePrompt);
  await writeFile(join(seed, MANIFEST_PATH), manifestJson(files, []));
  git(seed, ["init", "-q"]); git(seed, ["config", "user.name", "Fixture"]); git(seed, ["config", "user.email", "fixture@example.invalid"]);
  git(seed, ["add", "."]); git(seed, ["commit", "-qm", "base"]); git(seed, ["branch", "-M", "main"]);
  git(dir, ["clone", "--bare", "-q", seed, bare]);
  const baseline = git(dir, ["--git-dir", bare, "rev-parse", "refs/heads/main"]);
  const target = { schema: 1, id: "fixture-target", name: "Synthetic", repository: "https://github.com/fixture/fixture.git", branch: "main",
    authentication: { method: "vscode", expectedLogin: "fixture" },
    selection: { public: { skills: { items: [], folders: [""] } }, private: {} },
    lastSync: { at: "2026-01-01T00:00:00Z", commit: baseline, repository: "https://github.com/fixture/fixture.git", branch: "main", storeRoot: root, fingerprints: {} } };
  const rawConfig = JSON.stringify({ schema: 1, targets: [target] }) + "\n";
  const recorded = JSON.stringify({ schema: 1, targetId: target.id, transactionId: randomUUID(), repository: target.repository,
    branch: target.branch, state: "recorded", operation: "sync", pushedCommit: baseline,
    outbox: [{ entity: "skills\u0000One", snapshot: JSON.stringify([{ path: "skills/One.md", digest: digest(skill("base")) }]) }] }) + "\n";
  await writeFile(config, rawConfig, { mode: 0o600 }); await writeFile(transaction, recorded, { mode: 0o600 });
  const provider = localGitSyncProvider(dir, bare);
  const secretKeys = [];
  const options = () => ({
    mode: "isolated-experiment", storage, globalStorage, targetId: target.id, actorId: "fixture-actor",
    transport: provider.host, publisherPolicy: { policyId: provider.host.policy.policyId, enforcement: "all-repository-ref-writers" },
    readSecret: async key => { secretKeys.push(key); return JSON.stringify({ accountLabel: "fixture", accessToken: "fixture-token" }); },
  });
  storage = (await adoptLegacyRootInPlaceExperimental(root, {})).storage;
  await writeFile(transaction, recorded.replace('"recorded"', '"prepared"'));
  await assert.rejects(openExperimentalLegacySyncHost(options()), /legacy transaction requires recovery/);
  await writeFile(transaction, recorded);
  const privateTarget = structuredClone(target);
  privateTarget.selection.private.skills = { items: [], folders: [""] };
  await writeFile(config, JSON.stringify({ schema: 1, targets: [privateTarget] }));
  await assert.rejects(openExperimentalLegacySyncHost(options()), /private Skills require an authorized private repository/);
  for (const authentication of [
    { method: "https", expectedLogin: "fixture" },
    { method: "ssh", expectedLogin: "fixture", identityFile: join(dir, "synthetic-identity") },
  ]) {
    await writeFile(config, JSON.stringify({ schema: 1, targets: [{ ...target, authentication }] }));
    await assert.rejects(openExperimentalLegacySyncHost(options()), /target, account or baseline differs/);
    assert.deepEqual(secretKeys, []);
  }
  await writeFile(config, rawConfig);
  const coordinator = join(sync, "coordinators", digest(root), "coordinator.json");
  await mkdir(join(sync, "coordinators", digest(root)), { recursive: true });
  await writeFile(coordinator, JSON.stringify({ schema: 1, intents: { [target.id]: {} }, claims: {}, blocked: {} }));
  await assert.rejects(openExperimentalLegacySyncHost(options()), /legacy coordinator requires recovery/);
  await rm(coordinator);
  const serviceResults = join(globalStorage, "pkm-service", "fixture", "results");
  await mkdir(serviceResults, { recursive: true });
  await writeFile(join(serviceResults, "pending.json"), "{}");
  await assert.rejects(openExperimentalLegacySyncHost(options()), /legacy service result requires recovery/);
  await rm(join(serviceResults, "pending.json"));
  const badOptions = { ...options(), readSecret: async () => JSON.stringify({ accountLabel: "other", accessToken: "fixture-token" }) };
  host = await openExperimentalLegacySyncHost(badOptions);
  await assert.rejects(host.sync(), /transport auth/);
  assert.equal(await readFile(join(root, "skills/One.md"), "utf8"), skill("local change"));
  await host.close(); host = undefined;
  host = await openExperimentalLegacySyncHost(options());
  const pushed = await host.sync();
  assert.equal(pushed.state, "published"); assert(secretKeys.length > 0);
  assert(secretKeys.every(key => key === "personalKnowledge.githubSync.vscode.fixture-target"));
  assert.equal(git(dir, ["--git-dir", bare, "show", "main:skills/One.md"]), skill("local change").trim());
  assert.equal(git(dir, ["--git-dir", bare, "show", "main:notes/Note.md"]), remoteNote.trim());
  assert.equal(git(dir, ["--git-dir", bare, "show", "main:prompts/Prompt.md"]), remotePrompt.trim());
  await host.close(); host = undefined; await storage.close(); storage = undefined;

  await writeFile(join(root, "skills/One.md"), skill("crash change"));
  const crash = spawnSync(process.execPath, [resolve("tests/legacy-github-sync-experimental-child.mjs"),
    root, globalStorage, dir, bare, JSON.stringify(provider.host.policy)], { encoding: "utf8", timeout: 60000, env: process.env });
  assert.equal(crash.status, 77, crash.stderr);
  const afterCrash = git(dir, ["--git-dir", bare, "rev-parse", "refs/heads/main"]);
  storage = await Storage.open(root, { deferRecovery: true });
  host = await openExperimentalLegacySyncHost(options());
  const recovered = await host.resume();
  assert.deepEqual(recovered, { state: "published", commit: afterCrash });
  assert.equal(provider.pushes, 1, "Recovery must not repeat the child process push");
  await host.close(); host = undefined; await storage.close(); storage = undefined;

  git(seed, ["remote", "add", "origin", bare]); git(seed, ["fetch", "-q", "origin", "main"]); git(seed, ["reset", "-q", "--hard", "FETCH_HEAD"]);
  const wire = JSON.parse(await readFile(join(seed, MANIFEST_PATH), "utf8"));
  wire.files.find(item => item.path === "skills/One.md").digest = digest(skill("remote change"));
  await writeFile(join(seed, "skills/One.md"), skill("remote change"));
  await writeFile(join(seed, MANIFEST_PATH), JSON.stringify(wire) + "\n");
  git(seed, ["add", "."]); git(seed, ["commit", "-qm", "remote change"]); git(seed, ["push", "-q", "origin", "main"]);
  storage = await Storage.open(root);
  host = await openExperimentalLegacySyncHost(options());
  assert.equal((await host.sync()).state, "published");
  assert.equal(await readFile(join(root, "skills/One.md"), "utf8"), skill("remote change"));
  await host.close(); host = undefined; await storage.close(); storage = undefined;

  await writeFile(join(root, "skills/One.md"), skill("local conflict"));
  git(seed, ["fetch", "-q", "origin", "main"]); git(seed, ["reset", "-q", "--hard", "FETCH_HEAD"]);
  const conflictWire = JSON.parse(await readFile(join(seed, MANIFEST_PATH), "utf8"));
  conflictWire.files.find(item => item.path === "skills/One.md").digest = digest(skill("remote conflict"));
  await writeFile(join(seed, "skills/One.md"), skill("remote conflict"));
  await writeFile(join(seed, MANIFEST_PATH), JSON.stringify(conflictWire) + "\n");
  git(seed, ["add", "."]); git(seed, ["commit", "-qm", "conflict"]); git(seed, ["push", "-q", "origin", "main"]);
  storage = await Storage.open(root); host = await openExperimentalLegacySyncHost(options());
  const conflict = await host.sync();
  assert.equal(conflict.state, "conflict"); assert.equal(conflict.conflicts[0].reason, "concurrent-change");
  await host.close(); host = undefined; await storage.close(); storage = undefined;
  storage = await Storage.open(root); host = await openExperimentalLegacySyncHost(options());
  assert.deepEqual(await host.resume(), conflict);
  const inspection = await host.inspectComparison();
  const conflictSession = inspection.session;
  await assert.rejects(host.confirmComparison(conflictSession.sessionId), /unresolved conflicts/);
  await writeFile(join(root, "skills/One.md"), skill("changed after comparison"));
  const decision = { sessionId: conflictSession.sessionId, operationId: randomUUID(),
    expectedRevision: conflictSession.revision, conflictId: conflictSession.plan.conflicts[0].id,
    choice: "remote", reason: "Use reviewed remote version" };
  await assert.rejects(host.decide(decision), /local Skills changed/);
  await writeFile(join(root, "skills/One.md"), skill("local conflict"));
  const decided = await host.decide(decision);
  assert.equal(decided.decisions[0].choice, "remote");
  assert.deepEqual(await host.decide(decision), decided);
  await assert.rejects(host.decide({ ...decision, operationId: randomUUID() }), /revision/i);
  await host.close(); host = undefined; await storage.close(); storage = undefined;
  storage = await Storage.open(root); host = await openExperimentalLegacySyncHost(options());
  assert.deepEqual((await host.inspectComparison()).session, decided);
  const resolved = await host.confirmComparison(conflictSession.sessionId);
  assert.equal(resolved.state, "published");
  assert.equal(await readFile(join(root, "skills/One.md"), "utf8"), skill("remote conflict"));
  assert.equal(git(dir, ["--git-dir", bare, "show", "main:skills/One.md"]), skill("remote conflict").trim());
  assert.equal(await readFile(join(root, "notes/Note.md"), "utf8"), localNote);
  assert.equal(await readFile(join(root, "prompts/Prompt.md"), "utf8"), localPrompt);
  assert.equal(await readFile(config, "utf8"), rawConfig);
  assert.equal(await readFile(transaction, "utf8"), recorded);
  await host.close(); host = undefined;
  const journal = join(sync, "experimental-next", "fixture-target.json");
  const originalJournal = await readFile(journal, "utf8");
  assert(!originalJournal.includes("fixture-token"));
  const tampered = JSON.parse(originalJournal); tampered.baseline = "a".repeat(40);
  await writeFile(journal, JSON.stringify(tampered));
  await assert.rejects(openExperimentalLegacySyncHost(options()), /baseline receipt does not match/);
  await writeFile(journal, originalJournal);
  await writeFile(transaction, recorded.replace('"recorded"', '"pushed"'));
  await assert.rejects(openExperimentalLegacySyncHost(options()), /legacy transaction requires recovery/);
});
