import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import test from "node:test";
import { httpCall, invocation, nativeWorkspace } from "./batch06-manager-fixtures.mjs";
import { syncPlanHash, planSync } from "../dist/sync-plan.js";
import { typedSyncFiles as typedFixture } from "./sync-content-fixtures.mjs";
import { originalDigest } from "../dist/domain/action-compiler-validation.js";
import { DatabaseSync } from "node:sqlite";
import { coreDatabasePath } from "../dist/workspace-storage-paths.js";

const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const actor = { id: "native:sync-content-owner", canWrite: true };
const manifest = (files = [], deletions = []) => ({ schema: 3,
  capabilities: { storage: "pkm.github.publication/v1", required: ["explicit-deletions", "stable-entity-identity"] },
  files, deletions });
const snapshot = value => ({ manifest: value, sha256: syncPlanHash(value) });
const member = (path, itemId, bytes, extra = {}) => ({ path, type: path.split("/")[0], itemId,
  member: "", category: path.split("/").slice(1, -1).join("/"), privacy: "public",
  digest: hash(bytes), contentBase64: Buffer.from(bytes).toString("base64"), ...extra });
const inputFor = (files, local = [], base = [], deletions = []) => ({
  base: snapshot(manifest(base)), local: snapshot(manifest(local)), remote: snapshot(manifest(files, deletions)),
});
async function plan(f, input) {
  const url = await f.listen(actor), sessionId = randomUUID();
  const created = await httpCall(url, f.bearer, "capability_call",
    invocation("sync.plan.create", { sessionId, operationId: randomUUID(), input }));
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const preview = await httpCall(url, f.bearer, "capability_read",
    invocation("sync.apply.preview", { sessionId, input }));
  return { url, sessionId, preview, input };
}
async function apply(f, p, extra = {}) {
  return httpCall(p.url, f.bearer, "capability_call", invocation("sync.apply", {
    sessionId: p.sessionId, input: p.input, operationId: randomUUID(),
    expectedPlanHash: p.preview.body.result?.planHash ?? "a".repeat(64), ...extra,
  }));
}

test("genuine original Script manifest reaches authenticated public apply without executing bytes", async t => {
  const bytes = Buffer.from("# synthetic inert script\r\nraise RuntimeError('MUST NOT EXECUTE')\r\n");
  const file = member("scripts/tools/example.py", "tools/example", bytes);
  const input = inputFor([file]);
  const originalPath = process.env.PKM_LEGACY_422_PATH ?? process.env.PKM_ORIGINAL_EXTENSION;
  assert.ok(originalPath, "qualification requires the verified genuine 4.0.22 extract");
  const original = createRequire(import.meta.url)(join(originalPath, "dist/sync/github-sync.js"));
  const { contentBase64: _bytes, ...wire } = file;
  const parsed = original.parseManagedManifest(original.manifestJson([wire], []));
  assert.equal(parsed.files[0].itemId, file.itemId);
  original.validateGitHubSyncCandidate(file.path, bytes);
  assert.equal(planSync(input).conflicts.length, 0);
  const f = await nativeWorkspace(t);
  const p = await plan(f, input);
  assert.equal(p.preview.status, 200, JSON.stringify(p.preview.body));
  const result = await apply(f, p);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.deepEqual(fs.readFileSync(join(f.root, file.path)), bytes);
  assert.equal(fs.statSync(join(f.root, file.path)).mode & 0o111, 0);
});

test("Script sidecars and binary dependencies apply atomically; identity mismatch and target CAS remain closed", async t => {
  const id = "script_" + "b".repeat(24);
  const body = member("scripts/tools/example.py", id, "# inert\n");
  const sidecar = member("scripts/tools/.example.py.pkm.json", id,
    JSON.stringify({ schema: "pkm.script/v1", knowledgeId: id, aliases: ["pkm://scripts/tools/example.py"] }),
    { member: "identity-sidecar" });
  const binary = member("scripts/tools/example.assets/data.bin", id, Buffer.from([0, 255, 1, 128]),
    { member: "scripts/tools/example.assets/data.bin", category: "tools" });
  const f = await nativeWorkspace(t), p = await plan(f, inputFor([body, sidecar, binary]));
  assert.equal(p.preview.status, 200, JSON.stringify(p.preview.body));
  assert.equal((await apply(f, p)).status, 200);
  assert.deepEqual(fs.readFileSync(join(f.root, binary.path)), Buffer.from(binary.contentBase64, "base64"));
  const bad = structuredClone(sidecar);
  const badBytes = Buffer.from(JSON.stringify({ schema: "pkm.script/v1", knowledgeId: "script_" + "c".repeat(24), aliases: [] }));
  bad.digest = hash(badBytes); bad.contentBase64 = badBytes.toString("base64");
  const rejected = await plan(f, inputFor([body, bad]));
  assert.notEqual(rejected.preview.status, 200);
  const replacement = member(body.path, id, "# changed\n");
  const cas = await plan(f, inputFor([replacement, sidecar, binary], [body, sidecar, binary], [body, sidecar, binary]));
  assert.equal(cas.preview.status, 200, JSON.stringify(cas.preview.body));
  fs.writeFileSync(join(f.root, body.path), "# external\n");
  assert.notEqual((await apply(f, cas)).status, 200);
  assert.equal(fs.readFileSync(join(f.root, body.path), "utf8"), "# external\n");
});

function typedInput(files, local = [], base = [], deletions = []) {
  const input = inputFor(files, local, base, deletions);
  for (const side of Object.values(input)) {
    side.manifest.capabilities.required.push("action-library-assets", "profile-cards");
    side.sha256 = syncPlanHash(side.manifest);
  }
  return input;
}
test("public typed source classes require exact current native approval and preserve inert binary/private metadata", async t => {
  const files = typedFixture(), input = typedInput(files);
  let active = true;
  const approved = new Map([[syncPlanHash(input), ["action-module-sets", "actions", "packages", "profiles", "recipes", "servers"]]]);
  const f = await nativeWorkspace(t, root => ({ data: { namespace: "synthetic:sync-content",
    syncContent: { root, actorId: actor.id, epoch: randomUUID(), profileSha256: "d".repeat(64),
      assertCurrent(review) {
        assert(active, "current native epoch has been revoked");
        assert.equal(review.actorId, actor.id);
        assert(approved.has(review.sourceSha256), "exact source corpus was not reviewed");
        assert.deepEqual(review.entities.map(value => value.type).sort(), approved.get(review.sourceSha256));
      } } } }));
  const p = await plan(f, input);
  assert.equal(p.preview.status, 200, JSON.stringify(p.preview.body));
  assert.equal((await apply(f, p)).status, 200);
  for (const file of files) assert.deepEqual(fs.readFileSync(join(f.root, file.path)), Buffer.from(file.contentBase64, "base64"));
  assert.equal(fs.statSync(join(f.root, files.at(-1).path)).mode & 0o777, 0o600);
  const changed = structuredClone(files);
  const bytes = Buffer.from([1, 2, 3]);
  changed[0].contentBase64 = bytes.toString("base64"); changed[0].digest = hash(bytes);
  const update = typedInput(changed, files, files); approved.set(syncPlanHash(update), ["packages"]);
  const stale = await plan(f, update);
  assert.equal(stale.preview.status, 200, JSON.stringify(stale.preview.body));
  active = false;
  assert.notEqual((await apply(f, stale)).status, 200);
  assert.deepEqual(fs.readFileSync(join(f.root, files[0].path)), Buffer.from(files[0].contentBase64, "base64"));
  active = true;
  await f.reopen();
  for (const file of files) assert.deepEqual(fs.readFileSync(join(f.root, file.path)), Buffer.from(file.contentBase64, "base64"));
});

test("explicit typed entity tombstones remove pinned members and retain admissible completed empty roots", async t => {
  const files = typedFixture(), firstInput = typedInput(files);
  const entities = [...new Map(files.map(file => [JSON.stringify([file.type, file.itemId]), file])).values()];
  const deletions = entities.map(({ type, itemId, category, privacy }) => ({
    type, itemId, category, privacy, deletedAt: "2026-11-24T01:00:00Z",
  }));
  const removedInput = typedInput([], files, files, deletions);
  const approved = new Set([syncPlanHash(firstInput), syncPlanHash(removedInput)]);
  const f = await nativeWorkspace(t, root => ({ data: { namespace: "synthetic:typed-deletions",
    syncContent: { root, actorId: actor.id, epoch: randomUUID(), profileSha256: "d".repeat(64),
      assertCurrent(review) { assert(approved.has(review.sourceSha256), "unreviewed exact typed deletion source"); } } } }));
  const first = await plan(f, firstInput);
  assert.equal(first.preview.status, 200, JSON.stringify(first.preview.body));
  assert.equal((await apply(f, first)).status, 200);
  const removal = await plan(f, removedInput);
  assert.equal(removal.preview.status, 200, JSON.stringify(removal.preview.body));
  const result = await apply(f, removal);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.result.tombstones.length, entities.length);
  for (const file of files) assert.equal(fs.existsSync(join(f.root, file.path)), false);
  await f.reopen();
  for (const file of files) assert.equal(fs.existsSync(join(f.root, file.path)), false);
});

test("native source approvals cannot be boolean permissions or unfinished asynchronous checks", async t => {
  const files = typedFixture().filter(file => file.type === "packages"), input = typedInput(files);
  for (const approval of [() => false, () => Promise.resolve()]) {
    const f = await nativeWorkspace(t, root => ({ data: { namespace: "synthetic:invalid-source-assertion",
      syncContent: { root, actorId: actor.id, epoch: randomUUID(), profileSha256: "d".repeat(64), assertCurrent: approval } } }));
    const prepared = await plan(f, input);
    assert.equal(prepared.preview.body.error.code, "ACCESS_DENIED");
    assert.equal(fs.existsSync(join(f.root, files[0].path)), false);
  }
});

test("completed typed custody rejects changed bytes, private mode, unknown directories, receipts and database schemas", async t => {
  for (const mutation of ["bytes", "private-mode", "unknown-directory", "receipt", "foreign-schema"]) {
    const files = typedFixture().filter(file => file.type === "profiles"), input = typedInput(files);
    const f = await nativeWorkspace(t, root => ({ data: { namespace: `synthetic:custody-${mutation}`,
      syncContent: { root, actorId: actor.id, epoch: randomUUID(), profileSha256: "d".repeat(64),
        assertCurrent(review) { assert.equal(review.sourceSha256, syncPlanHash(input)); } } } }));
    const prepared = await plan(f, input);
    assert.equal(prepared.preview.status, 200, JSON.stringify(prepared.preview.body));
    assert.equal((await apply(f, prepared)).status, 200);
    await f.reopen();
    const file = join(f.root, files[0].path);
    if (mutation === "bytes") fs.writeFileSync(file, '{"schema":"not-a-profile"}');
    if (mutation === "private-mode") fs.chmodSync(file, 0o644);
    if (mutation === "unknown-directory") fs.mkdirSync(join(f.root, "profiles", "unowned"), { mode: 0o700 });
    if (mutation === "receipt" || mutation === "foreign-schema") {
      const database = new DatabaseSync(coreDatabasePath(f.root));
      try {
        if (mutation === "receipt") database.prepare("UPDATE receipts SET fingerprint=? WHERE operation='sync.apply'").run("e".repeat(64));
        else database.exec("CREATE TABLE unapproved_sync_schema(value TEXT)");
      } finally { database.close(); }
    }
    const bytes = fs.readFileSync(file);
    await assert.rejects(f.reopen(), /custody|unknown/i, mutation);
    assert.deepEqual(fs.readFileSync(file), bytes, `${mutation} was not repaired or replayed`);
  }
});

test("unapproved typed content, raw private credentials and historical Agent snapshots remain denied", async t => {
  const files = typedFixture(), f = await nativeWorkspace(t);
  const unauthorized = await plan(f, typedInput(files));
  assert.equal(unauthorized.preview.body.error.code, "ACCESS_DENIED");
  const profileId = randomUUID();
  const secret = member(`profiles/user/${profileId}.json`, `user/${profileId}`, JSON.stringify({ accessToken: "synthetic-not-secret" }),
    { privacy: "private", category: "user" });
  const historical = member("agentSnapshots/synthetic.json", "synthetic", JSON.stringify({
    schema: "pkm.agent.snapshot/v1", payload: { algorithm: "A256GCM-PKM-LOCAL-OBFUSCATION/v1", ciphertext: "synthetic" },
  }));
  const unownedPrompt = member("prompts/synthetic/task/prompt.txt", "unowned", "inert",
    { member: "prompt.txt", category: "synthetic" });
  for (const file of [secret, historical, unownedPrompt]) {
    const denied = await plan(f, typedInput([file]));
    assert.notEqual(denied.preview.status, 200);
  }
  const secretInput = typedInput([secret]);
  const serverSecret = member("servers/synthetic/config.json", "synthetic",
    JSON.stringify({ env: { OPENAI_API_KEY: "synthetic-not-secret" } }), { member: "config.json", category: "" });
  const serverSecretInput = typedInput([serverSecret]), reviewed = new Set([syncPlanHash(secretInput), syncPlanHash(serverSecretInput)]);
  const authorized = await nativeWorkspace(t, root => ({ data: { namespace: "synthetic:private-sync",
    syncContent: { root, actorId: actor.id, epoch: randomUUID(), profileSha256: "e".repeat(64),
      assertCurrent(review) { assert(reviewed.has(review.sourceSha256)); } } } }));
  for (const input of [secretInput, serverSecretInput]) {
    const rawSecret = await plan(authorized, input);
    assert.equal(rawSecret.preview.body.error.code, "CONFLICT");
    assert.match(rawSecret.preview.body.error.message, /Raw credentials/);
  }
  assert.equal(fs.existsSync(join(f.root, "packages/synthetic/data.bin")), false);
});

test("binary ModuleSet inventory remains immutable and cannot import unowned members or resource references", async t => {
  const files = typedFixture().filter(file => file.type === "action-module-sets"), input = typedInput(files);
  const approved = new Set([syncPlanHash(input)]);
  const f = await nativeWorkspace(t, root => ({ data: { namespace: "synthetic:immutable-sync",
    syncContent: { root, actorId: actor.id, epoch: randomUUID(), profileSha256: "f".repeat(64),
      assertCurrent(review) { assert(approved.has(review.sourceSha256)); } } } }));
  const first = await plan(f, input);
  assert.equal(first.preview.status, 200, JSON.stringify(first.preview.body));
  assert.equal((await apply(f, first)).status, 200);
  const changed = structuredClone(files), asset = changed.find(file => file.path.endsWith(".bin"));
  const bytes = Buffer.from([9, 0, 255]); asset.digest = hash(bytes); asset.contentBase64 = bytes.toString("base64");
  const primary = changed.find(file => !file.member), metadata = JSON.parse(Buffer.from(primary.contentBase64, "base64"));
  metadata.files["assets/example.bin"] = asset.digest;
  delete metadata.package_hash; metadata.package_hash = originalDigest(metadata);
  const data = Buffer.from(JSON.stringify(metadata)); primary.digest = hash(data); primary.contentBase64 = data.toString("base64");
  const update = typedInput(changed, files, files); approved.add(syncPlanHash(update));
  const rejected = await plan(f, update);
  assert.equal(rejected.preview.body.error.code, "CONFLICT");
  assert.match(rejected.preview.body.error.message, /Immutable ModuleSet/);
  for (const file of files) assert.deepEqual(fs.readFileSync(join(f.root, file.path)), Buffer.from(file.contentBase64, "base64"));
  const bad = structuredClone(files);
  bad.find(file => file.path.endsWith(".bin")).member = "foreign/member.bin";
  const badInput = typedInput(bad); approved.add(syncPlanHash(badInput));
  assert.notEqual((await plan(f, badInput)).preview.status, 200);
});

test("pending privileged filesystem effects are preserved at restart, never automatically replayed under a new epoch", async t => {
  const files = typedFixture().filter(file => file.type === "packages" || file.type === "servers"), input = typedInput(files);
  const f = await nativeWorkspace(t, root => ({ data: { namespace: "synthetic:no-replay-sync",
    syncContent: { root, actorId: actor.id, epoch: randomUUID(), profileSha256: "a".repeat(64),
      assertCurrent(review) { assert.equal(review.sourceSha256, syncPlanHash(input)); } } } }));
  const p = await plan(f, input);
  assert.equal(p.preview.status, 200, JSON.stringify(p.preview.body));
  const rename = fs.renameSync, interrupted = join(f.root, files[1].path);
  fs.renameSync = (source, target) => {
    if (target === interrupted) throw new Error("synthetic unknown filesystem outcome");
    return rename(source, target);
  };
  syncBuiltinESMExports();
  try { assert.notEqual((await apply(f, p)).status, 200); }
  finally { fs.renameSync = rename; syncBuiltinESMExports(); }
  const db = f.storage.connectNative();
  try {
    assert.equal(db.prepare("SELECT state FROM sync_apply_journal").get().state, "prepared");
    assert.equal(db.prepare("SELECT count(*) AS n FROM data_runtime_intents").get().n, 1);
  } finally { db.close(); }
  fs.writeFileSync(join(f.root, files[0].path), Buffer.from([7, 7, 7]));
  await assert.rejects(f.reopen(), /current native|unknown|review|approval|metadata/i);
  assert.deepEqual(fs.readFileSync(join(f.root, files[0].path)), Buffer.from([7, 7, 7]));
  assert.equal(fs.existsSync(interrupted), false);
});

test("explicit Script tombstones remove only pinned owned members and publish durable deletion metadata", async t => {
  const file = member("scripts/delete.py", "delete.py", "# inert\n");
  const f = await nativeWorkspace(t), first = await plan(f, inputFor([file]));
  assert.equal((await apply(f, first)).status, 200);
  const deletion = { type: "scripts", itemId: file.itemId, category: "", privacy: "public", deletedAt: "2026-11-24T00:00:00Z" };
  const p = await plan(f, inputFor([], [file], [file], [deletion]));
  assert.equal(p.preview.status, 200, JSON.stringify(p.preview.body));
  const result = await apply(f, p);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.result.tombstones[0].itemId, file.itemId);
  assert.equal(fs.existsSync(join(f.root, file.path)), false);
});
