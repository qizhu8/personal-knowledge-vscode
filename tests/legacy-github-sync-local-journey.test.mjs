import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, rm, rmdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { manifestJson, MANIFEST_PATH } from "../dist/domain/sync-transport-original.js";
import { legacyRootAdoptionLockDirectory, adoptLegacyRootInPlaceExperimental } from "../dist/legacy-root-adoption.js";
import { createNativeRuntime } from "../dist/native-runtime.js";
import { syncPlanHash } from "../dist/sync-plan.js";
import { projectSkillsOnlySyncInput } from "../dist/sync-skills-only.js";
import { localGitSyncProvider } from "./local-git-sync-provider.mjs";

const digest = value => createHash("sha256").update(value).digest("hex");
const git = (cwd, args, input) => {
  const result = spawnSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args], {
    cwd, input, encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" },
  });
  if (result.status !== 0) throw new Error(`Private Git fixture failed: ${args[0]} ${result.stderr}`);
  return result.stdout.trim();
};
const file = (type, itemId, content) => ({
  path: `${type}/${itemId}.md`, type, itemId, member: "", category: "", privacy: "public",
  digest: digest(content), contentBase64: Buffer.from(content).toString("base64"),
});
const snapshot = manifest => ({ manifest, sha256: syncPlanHash(manifest) });
const bytes = item => Buffer.from(item.contentBase64, "base64");
const manifest = files => ({
  schema: 3, capabilities: { storage: "pkm.github.publication/v1",
    required: ["explicit-deletions", "stable-entity-identity", "entity-partial-progress"] },
  files, deletions: [],
});
const actor = "private-sync-fixture";

test("adopted original root uses native Sync with real private bare Git push and pull", { timeout: 90000 }, async t => {
  const directory = resolve(".migration-test-work", `native-git-sync-${randomUUID()}`);
  const root = join(directory, "knowledge"), seed = join(directory, "seed"), bare = join(directory, "remote.git");
  const profile = join(directory, "profile"), config = join(profile, "targets.json");
  const oldConfig = JSON.stringify({ schema: 1, targets: [{ id: "fixture-target", name: "Fixture", branch: "main",
    repository: bare, selection: { public: { skills: { folders: [""] } }, private: {} } }] });
  const skillBase = "---\nname: One\n---\nbase\n";
  const skillLocal = "---\nname: One\n---\nlocal\n";
  const skillRemote = "---\nname: One\n---\nremote pull\n";
  const remoteNote = "---\ntitle: Note\n---\nremote note\n";
  const remotePrompt = "---\ntitle: Prompt\n---\nremote prompt\n";
  const localNote = "---\ntitle: Local Note\ndocumentId: fixture-note\nrevision: 1\n---\nlocal note\n";
  const localPrompt = "---\ntitle: Local Prompt\n---\nlocal prompt\n";
  for (const dir of [root, seed, profile, join(root, "notes"), join(root, "skills"),
    join(root, "prompts"), join(seed, "skills"), join(seed, "notes"), join(seed, "prompts")]) await mkdir(dir, { recursive: true });
  let storage, runtime;
  t.after(async () => {
    if (runtime) await runtime.close();
    if (storage) await storage.close();
    const locks = legacyRootAdoptionLockDirectory(root);
    const prefix = digest(root).slice(0, 40);
    for (const suffix of [".sqlite", ".writer.lock", ".writer-fenced.json"]) await rm(join(locks, prefix + suffix), { force: true });
    await rmdir(locks).catch(error => { if (!["ENOENT", "ENOTEMPTY"].includes(error.code)) throw error; });
    await rm(directory, { recursive: true, force: true });
  });
  await writeFile(config, oldConfig, { mode: 0o600 });
  await writeFile(join(root, "notes/Note.md"), localNote);
  await writeFile(join(root, "skills/One.md"), skillLocal);
  await writeFile(join(root, "prompts/Prompt.md"), localPrompt);
  const remoteFiles = [file("skills", "One", skillBase), file("notes", "Note", remoteNote), file("prompts", "Prompt", remotePrompt)];
  for (const item of remoteFiles) await writeFile(join(seed, item.path), bytes(item));
  await writeFile(join(seed, MANIFEST_PATH), manifestJson(remoteFiles.map(({ contentBase64: _, ...item }) => item), []));
  git(seed, ["init", "-q"]);
  git(seed, ["config", "user.name", "Fixture"]); git(seed, ["config", "user.email", "fixture@example.invalid"]);
  git(seed, ["add", "."]); git(seed, ["commit", "-qm", "seed"]); git(seed, ["branch", "-M", "main"]);
  git(directory, ["clone", "--bare", "-q", seed, bare]);

  const provider = localGitSyncProvider(directory, bare);
  const adopted = await adoptLegacyRootInPlaceExperimental(root, {});
  storage = adopted.storage;
  runtime = await createNativeRuntime({ storage, remote: {
    authorize: async id => id === actor,
    sync: provider.host,
    publisherPolicy: { policyId: provider.host.policy.policyId, enforcement: "all-repository-ref-writers" },
  } });
  const remote = runtime.services.remote;
  const first = await remote.pin(actor);
  const local = manifest([file("skills", "One", skillLocal), file("notes", "Note", localNote), file("prompts", "Prompt", localPrompt)]);
  const source = snapshot(first.pin.manifest);
  const projected = projectSkillsOnlySyncInput({ base: source, local: snapshot(local), remote: source });
  const session = await remote.plan(actor, { operationId: randomUUID(), sessionId: randomUUID(), pinId: first.pinId,
    base: projected.input.base, local: projected.input.local });
  const applied = await remote.apply(actor, { operationId: randomUUID(), sessionId: session.sessionId });
  const pushed = await remote.publish(actor, { operationId: randomUUID(), sessionId: session.sessionId, stagedReceiptId: applied.applyId });
  assert.equal(pushed.state, "published");
  assert.equal(provider.pushes, 1);
  assert.equal(git(directory, ["--git-dir", bare, "show", "main:skills/One.md"]), skillLocal.trim());
  assert.equal(git(directory, ["--git-dir", bare, "show", "main:notes/Note.md"]), remoteNote.trim());
  assert.equal(git(directory, ["--git-dir", bare, "show", "main:prompts/Prompt.md"]), remotePrompt.trim());

  git(seed, ["remote", "add", "origin", bare]);
  git(seed, ["fetch", "-q", "origin", "main"]); git(seed, ["reset", "-q", "--hard", "FETCH_HEAD"]);
  const wire = JSON.parse(await readFile(join(seed, MANIFEST_PATH), "utf8"));
  wire.files.find(item => item.path === "skills/One.md").digest = digest(skillRemote);
  await writeFile(join(seed, "skills/One.md"), skillRemote);
  await writeFile(join(seed, MANIFEST_PATH), JSON.stringify(wire) + "\n");
  git(seed, ["add", "."]); git(seed, ["commit", "-qm", "remote edit"]); git(seed, ["push", "-q", "origin", "main"]);
  const next = await remote.pin(actor);
  const before = snapshot(next.pin.manifest);
  // Read the actual former commit; a historical base must not become a current-remote pin.
  const prior = await remote.readHistoricalBase(actor, pushed.commit);
  assert.equal(prior.commit, pushed.commit);
  assert.notEqual(prior.commit, next.pin.commit);
  assert.equal("pinId" in prior, false);
  await assert.rejects(remote.readHistoricalBase("unauthorized", pushed.commit), /authority denied/);
  await assert.rejects(remote.readHistoricalBase(actor, "not-a-commit"));
  const currentLocal = manifest([file("skills", "One", skillLocal), file("notes", "Note", localNote), file("prompts", "Prompt", localPrompt)]);
  const input = projectSkillsOnlySyncInput({ base: snapshot(prior.manifest), local: snapshot(currentLocal), remote: before });
  const pull = await remote.plan(actor, { operationId: randomUUID(), sessionId: randomUUID(), pinId: next.pinId,
    base: input.input.base, local: input.input.local });
  const pullReceipt = await remote.apply(actor, { operationId: randomUUID(), sessionId: pull.sessionId });
  assert.equal(await readFile(join(root, "skills/One.md"), "utf8"), skillRemote);
  assert.equal(await readFile(join(root, "notes/Note.md"), "utf8"), localNote);
  assert.equal(await readFile(join(root, "prompts/Prompt.md"), "utf8"), localPrompt);
  assert.equal(await readFile(config, "utf8"), oldConfig);

  const interruptedId = randomUUID();
  await runtime.close(); runtime = undefined;
  await storage.close(); storage = undefined;
  const crash = spawnSync(process.execPath, [
    resolve("next-server/tests/legacy-github-sync-publish-crash-child.mjs"), root, directory, bare,
    JSON.stringify(provider.host.policy), actor, interruptedId, pull.sessionId, pullReceipt.applyId,
  ], { encoding: "utf8", timeout: 60000, env: process.env });
  assert.equal(crash.status, 77, crash.stderr);
  const remoteCommit = git(directory, ["--git-dir", bare, "rev-parse", "refs/heads/main"]);
  const child = spawnSync(process.execPath, [
    resolve("next-server/tests/legacy-github-sync-reconcile-child.mjs"), root, directory, bare,
    JSON.stringify(provider.host.policy), actor, interruptedId,
  ], { encoding: "utf8", timeout: 60000, env: process.env });
  assert.equal(child.status, 0, child.stderr);
  const recovered = JSON.parse(child.stdout.trim());
  assert.equal(recovered.result.state, "published");
  assert.equal(recovered.result.commit, remoteCommit);
  assert.equal(recovered.pushes, 0, "Restart reconciliation must never repeat an uncertain push.");
  assert.equal(git(directory, ["--git-dir", bare, "rev-parse", "refs/heads/main"]), remoteCommit);
  assert.equal(await readFile(config, "utf8"), oldConfig);

  const conflictLocal = "---\nname: One\n---\nconflicting local\n";
  const conflictRemote = "---\nname: One\n---\nconflicting remote\n";
  await writeFile(join(root, "skills/One.md"), conflictLocal);
  git(seed, ["fetch", "-q", "origin", "main"]); git(seed, ["reset", "-q", "--hard", "FETCH_HEAD"]);
  const conflictWire = JSON.parse(await readFile(join(seed, MANIFEST_PATH), "utf8"));
  conflictWire.files.find(item => item.path === "skills/One.md").digest = digest(conflictRemote);
  await writeFile(join(seed, "skills/One.md"), conflictRemote);
  await writeFile(join(seed, MANIFEST_PATH), JSON.stringify(conflictWire) + "\n");
  git(seed, ["add", "."]); git(seed, ["commit", "-qm", "conflicting edit"]); git(seed, ["push", "-q", "origin", "main"]);
  storage = await (await import("../dist/storage.js")).Storage.open(root);
  runtime = await createNativeRuntime({ storage, remote: {
    authorize: async id => id === actor,
    sync: provider.host,
    publisherPolicy: { policyId: provider.host.policy.policyId, enforcement: "all-repository-ref-writers" },
  } });
  const restartedRemote = runtime.services.remote;
  const latest = await restartedRemote.pin(actor);
  const conflictInput = projectSkillsOnlySyncInput({
    base: snapshot(next.pin.manifest),
    local: snapshot(manifest([file("skills", "One", conflictLocal), file("notes", "Note", localNote), file("prompts", "Prompt", localPrompt)])),
    remote: snapshot(latest.pin.manifest),
  });
  const conflict = await restartedRemote.plan(actor, { operationId: randomUUID(), sessionId: randomUUID(), pinId: latest.pinId,
    base: conflictInput.input.base, local: conflictInput.input.local });
  assert.equal(conflict.plan.conflicts.length, 1);
  assert.equal(conflict.plan.conflicts[0].reason, "concurrent-change");
  assert.equal(conflict.plan.conflicts[0].type, "skills");
  assert.equal(await readFile(join(root, "skills/One.md"), "utf8"), conflictLocal);
  assert.equal(await readFile(join(root, "notes/Note.md"), "utf8"), localNote);
  assert.equal(await readFile(join(root, "prompts/Prompt.md"), "utf8"), localPrompt);
});
