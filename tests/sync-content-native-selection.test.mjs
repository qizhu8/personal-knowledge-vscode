import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, rm, rmdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { manifestJson, MANIFEST_PATH } from "../dist/domain/sync-transport-original.js";
import { adoptLegacyRootInPlaceExperimental, legacyRootAdoptionLockDirectory } from "../dist/legacy-root-adoption.js";
import { openExperimentalLegacySyncHost } from "../dist/legacy-github-sync-experimental-host.js";
import { localGitSyncProvider } from "./local-git-sync-provider.mjs";
import { typedSyncFiles } from "./sync-content-fixtures.mjs";
import { Storage } from "../dist/storage.js";

const hash = bytes => createHash("sha256").update(bytes).digest("hex");
function git(cwd, args) {
  const result = spawnSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args], {
    cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" },
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
test("current native original target reviews broader exact typed content while preserving unselected remote state", async t => {
  const dir = resolve(".migration-test-work", `sync-content-selection-${randomUUID()}`);
  const root = join(dir, "root"), seed = join(dir, "seed"), bare = join(dir, "remote.git");
  const globalStorage = join(dir, "profile"), sync = join(globalStorage, "github-sync");
  for (const folder of [join(root, "notes"), join(root, "scripts"), join(seed, "scripts"), join(seed, "notes"), sync])
    await mkdir(folder, { recursive: true });
  let storage, host;
  t.after(async () => {
    if (host) await host.close();
    if (storage) await storage.close();
    const locks = legacyRootAdoptionLockDirectory(root);
    for (const suffix of [".sqlite", ".writer.lock", ".writer-fenced.json"])
      await rm(join(locks, hash(root).slice(0, 40) + suffix), { force: true });
    await rmdir(locks).catch(error => { if (!["ENOENT", "ENOTEMPTY"].includes(error.code)) throw error; });
    await rm(dir, { recursive: true, force: true });
  });
  const script = "# synthetic script: never execute\r\n";
  const scriptId = "script_" + "c".repeat(24);
  const scriptSidecar = JSON.stringify({ schema: "pkm.script/v1", knowledgeId: scriptId, aliases: ["pkm://scripts/example.py"] });
  const untouched = "---\ntitle: Untouched\n---\nremote only\n";
  const local = "---\ntitle: Local\ndocumentId: synthetic-sync-note\nrevision: 1\n---\nlocal only\n";
  const typed = typedSyncFiles();
  const files = [
    { path: "scripts/example.py", type: "scripts", itemId: scriptId, member: "", category: "", privacy: "public",
      digest: hash(script), contentBase64: Buffer.from(script).toString("base64") },
    { path: "scripts/.example.py.pkm.json", type: "scripts", itemId: scriptId, member: "identity-sidecar", category: "", privacy: "public",
      digest: hash(scriptSidecar), contentBase64: Buffer.from(scriptSidecar).toString("base64") },
    { path: "notes/Untouched.md", type: "notes", itemId: "Untouched", member: "", category: "", privacy: "public",
      digest: hash(untouched), contentBase64: Buffer.from(untouched).toString("base64") }, ...typed,
  ];
  for (const file of files) {
    await mkdir(join(seed, file.path, ".."), { recursive: true });
    await writeFile(join(seed, file.path), Buffer.from(file.contentBase64, "base64"));
  }
  await writeFile(join(seed, MANIFEST_PATH), manifestJson(files.map(({ contentBase64: _bytes, ...file }) => file), []));
  await writeFile(join(root, "notes/Local.md"), local);
  git(seed, ["init", "-q"]); git(seed, ["config", "user.name", "Synthetic"]);
  git(seed, ["config", "user.email", "synthetic@example.invalid"]);
  git(seed, ["add", "."]); git(seed, ["commit", "-qm", "synthetic source"]);
  git(seed, ["branch", "-M", "main"]); git(dir, ["clone", "--bare", "-q", seed, bare]);
  const target = { schema: 1, id: "fixture-target", name: "Synthetic",
    repository: "https://github.com/fixture/fixture.git", branch: "main",
    authentication: { method: "vscode", expectedLogin: "fixture" },
    selection: { public: { notes: { items: ["Local"], folders: [] }, scripts: { items: [scriptId], folders: [] },
      ...Object.fromEntries(["prompts", "packages", "servers", "recipes", "actions", "action-module-sets"].map(type =>
        [type, { items: [], folders: [""] }])) },
      private: { profiles: { items: [], folders: ["user"] } } } };
  const profileScope = hash(JSON.stringify({ repository: target.repository, branch: target.branch, items: [], folders: ["user"] }));
  target.profileSyncConsent = { root, scope: profileScope, authorizedAt: "2026-11-24T00:00:00Z" };
  const config = join(sync, "targets.json"), originalConfig = JSON.stringify({ schema: 1, targets: [target] }) + "\n";
  await writeFile(config, originalConfig, { mode: 0o600 });
  const provider = localGitSyncProvider(dir, bare);
  provider.host.policy.visibility = "private"; provider.host.policy.allowPrivate = true;
  provider.host.policy.profileConsentScope = profileScope;
  const fixtureFetch = provider.host.fetch;
  let approvedPins, approvedSource;
  const transport = { ...provider.host,
    async fetch(url, init) {
      if (new URL(url).pathname === "/repos/fixture/fixture") return new Response(JSON.stringify({
        full_name: "fixture/fixture", private: true }), { headers: { "content-type": "application/json" } });
      return fixtureFetch(url, init);
    },
    withRepositoryVisibilityFence: async (_policy, work) => work(),
    contentAuthority: { root, actorId: "native:synthetic-sync-selection", epoch: randomUUID(), profileSha256: "e".repeat(64),
      assertCurrent(review) {
        assert.deepEqual(review.sourcePins, approvedPins, "only the explicitly reviewed exact native source is admitted");
        approvedSource ??= review.sourceSha256;
        assert.equal(review.sourceSha256, approvedSource);
        assert.deepEqual(review.entities.map(value => value.type).sort(),
          ["action-module-sets", "actions", "packages", "profiles", "recipes", "servers"]);
      } } };
  storage = (await adoptLegacyRootInPlaceExperimental(root, {})).storage;
  host = await openExperimentalLegacySyncHost({ mode: "isolated-experiment", storage, globalStorage,
    targetId: target.id, actorId: "native:synthetic-sync-selection",
    transport,
    publisherPolicy: { policyId: provider.host.policy.policyId, enforcement: "all-repository-ref-writers" },
    readSecret: async () => JSON.stringify({ accountLabel: "fixture", accessToken: "fixture-token" }) });
  const preview = await host.sync();
  assert.equal(preview.state, "comparison");
  assert.deepEqual(preview.session.plan.proposals.map(value => value.type).sort(),
    ["action-module-sets", "actions", "notes", "packages", "profiles", "prompts", "recipes", "scripts", "servers"]);
  assert.equal(preview.session.plan.conflicts.length, 0);
  const changed = structuredClone(target);
  changed.selection.public.notes.items.push("Untouched");
  await writeFile(config, JSON.stringify({ schema: 1, targets: [changed] }));
  await assert.rejects(host.confirmComparison(preview.session.sessionId), /configuration changed/);
  await writeFile(config, originalConfig);
  approvedPins = preview.session.plan.pins;
  const result = await host.confirmComparison(preview.session.sessionId);
  assert.equal(result.state, "published");
  assert.equal(await readFile(join(root, "scripts/example.py"), "utf8"), script);
  assert.equal(git(dir, ["--git-dir", bare, "show", "main:notes/Local.md"]), local.trim());
  assert.equal(git(dir, ["--git-dir", bare, "show", "main:notes/Untouched.md"]), untouched.trim());
  for (const file of typed) assert.deepEqual(await readFile(join(root, file.path)), Buffer.from(file.contentBase64, "base64"));
  await assert.rejects(readFile(join(root, "notes/Untouched.md")), { code: "ENOENT" });
  await host.close(); host = undefined;
  await storage.close(); storage = await Storage.open(root);
  for (const file of typed) assert.deepEqual(await readFile(join(root, file.path)), Buffer.from(file.contentBase64, "base64"));
});
