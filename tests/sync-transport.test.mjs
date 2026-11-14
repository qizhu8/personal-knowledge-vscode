import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, writeFileSync, readFileSync, rmSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fixture, file, manifest } from "./sync-transport-fixture.mjs";
import { syncPlanHash } from "../dist/sync-plan.js";
import { initializeSyncPlanStore, SyncPlanStore } from "../dist/sync-plan-store.js";
import { applySyncPlan, initializeSyncApplyJournal, recoverSyncApply } from "../dist/sync-apply.js";
import { prepareSyncTransportPublication, syncTransportApplyStaging } from "../dist/sync-transport-plan.js";
import { GitHubSyncTransport } from "../dist/sync-transport.js";
import { manifestJson, MANIFEST_PATH, GITHUB_SYNC_EXTENSION_VERSION } from "../dist/domain/sync-transport-original.js";

test("pins actual ref/tree/blob REST responses, preserving original BOM/newline bytes", async () => {
  const f = await fixture();
  try {
    const pin = await f.pin();
    assert.equal(pin.commit, f.baseCommit);
    assert.equal(pin.tree, f.baseTree);
    assert.equal(pin.manifestHash, syncPlanHash(pin.manifest));
    assert.deepEqual(Buffer.from(pin.manifest.files[0].contentBase64, "base64"), f.baseBytes);
    assert(f.requests.some(request => request.route === "/git/ref/heads/approved/branch"));
    assert(f.requests.some(request => request.route === `/git/trees/${f.baseTree}?recursive=1`));
    assert(f.requests.every(request => request.method === "GET"));
  } finally { await f.close(); }
});

test("large Note blobs above the former transport response cap remain readable", async () => {
  const bytes = Buffer.alloc(9_000_001, 97);
  const f = await fixture({ manifest: manifest([file(bytes)]) });
  try {
    const pin = await f.pin();
    assert.deepEqual(Buffer.from(pin.manifest.files[0].contentBase64, "base64"), bytes);
  } finally { await f.close(); }
});

test("publication intent precedes real REST mutation; original wire manifest, parent and nonforce ref update are exact", async () => {
  const f = await fixture();
  try {
    const plan = await f.plan();
    const result = await f.transport.publish(plan);
    assert.equal(result.state, "published");
    assert.equal(f.ref, result.commit);
    const mutations = f.requests.filter(request => request.method !== "GET");
    assert.deepEqual(mutations.map(request => request.route), ["/git/blobs", "/git/blobs", "/git/trees", "/git/commits", "/git/refs/heads/approved/branch"]);
    assert.deepEqual(mutations.at(-1).body, { sha: result.commit, force: false });
    assert.deepEqual(mutations.find(request => request.route === "/git/commits").body.parents, [f.baseCommit]);
    assert.equal(mutations.find(request => request.route === "/git/commits").body.message, plan.message);
    const manifestPost = mutations[1].body;
    assert.equal(manifestPost.encoding, "base64");
    assert.equal(Buffer.from(manifestPost.content, "base64").toString(),
      manifestJson(plan.manifest.files.map(({ contentBase64, ...file }) => file), []));
    const finalEntries = f.trees.get(result.tree);
    assert(finalEntries.some(entry => entry.path === "README.md"));
    assert(finalEntries.some(entry => entry.path === MANIFEST_PATH));
    const before = mutations.length;
    assert.deepEqual(await f.transport.publish(plan), result);
    assert.equal(f.requests.filter(request => request.method !== "GET").length, before);
    assert.equal(f.transport.status(plan.operationId, "other-actor"), undefined);
    assert(!JSON.stringify(f.transport.status(plan.operationId, plan.actorId)).includes("contentBase64"));
  } finally { await f.close(); }
});

for (const drop of ["blob", "tree", "commit", "ref"]) test(`unknown ${drop} response reconciles exact objects without replaying mutations`, async () => {
  const f = await fixture({ drop });
  try {
    const plan = await f.plan();
    await assert.rejects(f.transport.publish(plan), /transport network/);
    const pending = f.transport.status(plan.operationId, plan.actorId);
    assert(pending.state.endsWith("pending"));
    const before = f.requests.filter(request => request.method !== "GET").length;
    assert.deepEqual(await f.transport.publish(plan), pending);
    const candidate = [...f.commits.keys()].find(sha => sha !== f.baseCommit);
    const result = await f.transport.reconcile(plan.operationId, plan.actorId, candidate);
    assert.equal(result.state, drop === "ref" ? "published" : "needs-review");
    assert.equal(f.requests.filter(request => request.method !== "GET").length, before);
  } finally { await f.close(); }
});

test("stale preflight has no writes, and native CAS rejects a racing ref rather than pretending GET/PATCH is atomic", async () => {
  const f = await fixture();
  try {
    const plan = await f.plan();
    f.ref = "c".repeat(40);
    assert.equal((await f.transport.publish(plan)).state, "stale");
    assert(f.requests.every(request => request.method === "GET"));
  } finally { await f.close(); }
  let racing;
  const g = await fixture({ beforeCAS: () => { racing.ref = "d".repeat(40); } });
  racing = g;
  try {
    const plan = await g.plan();
    await assert.rejects(g.transport.publish(plan), /transport review/);
    assert(!g.requests.some(request => request.method === "PATCH"));
    const before = g.requests.length;
    assert.equal((await g.transport.publish(plan)).state, "commit-created");
    assert.equal(g.requests.length, before);
  } finally { await g.close(); }
});

test("durable receipt hook failure rolls back intent and forbids all remote mutations", async () => {
  const f = await fixture({ receiptHook: () => { throw new Error("shared receipt failed"); } });
  try {
    const plan = await f.plan();
    await assert.rejects(f.transport.publish(plan), /transport review/);
    assert(f.requests.every(request => request.method === "GET"));
    assert.equal(f.transport.status(plan.operationId, plan.actorId), undefined);
  } finally { await f.close(); }
});

test("post-publication shared receipt failure preserves pending ref intent for exact reconciliation", async () => {
  let failed = false;
  const f = await fixture({ receiptHook: journal => {
    if (journal.status.state === "published" && !failed) { failed = true; throw new Error("receipt failed after accepted ref"); }
  } });
  try {
    const plan = await f.plan();
    await assert.rejects(f.transport.publish(plan), /transport review/);
    assert.equal(f.transport.status(plan.operationId, plan.actorId).state, "ref-pending");
    const writes = f.requests.filter(request => request.method !== "GET").length;
    assert.equal((await f.transport.reconcile(plan.operationId, plan.actorId)).state, "published");
    assert.equal(f.requests.filter(request => request.method !== "GET").length, writes);
  } finally { await f.close(); }
});

test("malformed mutation success remains pending, never accepted or replayed", async () => {
  const f = await fixture({ intercept: ({ request, send }) => {
    if (request.method === "POST") { send(201, { success: true }); return true; }
  } });
  try {
    const plan = await f.plan();
    await assert.rejects(f.transport.publish(plan), /transport malformed/);
    assert.equal((await f.transport.publish(plan)).state, "tree-pending");
    assert.equal(f.requests.filter(request => request.method === "POST").length, 1);
  } finally { await f.close(); }
});

test("source wire metadata strips original private review-only fields and includes capability-gated profiles/assets", () => {
  const input = file(Buffer.from("bytes"), { content: "in-memory", sourceDigest: "secret", rawSnapshot: "bytes",
    sourceLocator: { path: "/private/path" }, baseIntegrityEvidence: "review" });
  const wire = manifestJson([input], []);
  assert(!wire.includes("/private/path"));
  assert(!wire.includes("sourceDigest"));
  assert(!wire.includes("baseIntegrityEvidence"));
  const parsed = JSON.parse(wire);
  assert.equal(parsed.schema, 3);
  assert.equal(parsed.minimumExtensionVersion, GITHUB_SYNC_EXTENSION_VERSION);
  assert.deepEqual(parsed.capabilities.required, ["explicit-deletions", "stable-entity-identity", "entity-partial-progress"]);
  assert.equal(parsed.capabilities.storage, "pkm.github.publication/v1");
  const profile = { ...input, type: "profiles", privacy: "private" };
  assert(JSON.parse(manifestJson([profile], [])).capabilities.required.includes("profile-cards"));
});

test("native privacy, profile consent, path type, membership, version and plan integrity fail closed", async () => {
  const f = await fixture();
  try {
    const plan = await f.plan();
    const mutate = changes => {
      const { planHash, ...unsigned } = { ...plan, ...changes };
      return { ...unsigned, planHash: syncPlanHash(unsigned) };
    };
    for (const badManifest of [
      manifest([{ ...plan.manifest.files[0], privacy: "private" }]),
      manifest([{ ...plan.manifest.files[0], path: "papers/source.md" }]),
      manifest([{ ...plan.manifest.files[0], path: "notes/../source.md" }]),
      { ...plan.manifest, minimumExtensionVersion: "9999.0.0" },
      manifest([{ ...plan.manifest.files[0], contentBase64: "INVALID" }]),
    ]) await assert.rejects(f.transport.publish(mutate({ manifest: badManifest, manifestHash: syncPlanHash(badManifest) })), /transport/);
    await assert.rejects(f.transport.publish({ ...plan, actorId: "forged" }), /transport denied/);
    const profileId = randomUUID();
    const profileManifest = {
      ...manifest([file(Buffer.from("{}"), { type: "profiles", path: `profiles/user/${profileId}.json`,
        itemId: `user/${profileId}`, category: "user", privacy: "private" })]),
      capabilities: { storage: "pkm.github.publication/v1", required: ["explicit-deletions", "stable-entity-identity", "profile-cards"] },
    };
    await assert.rejects(f.transport.publish(mutate({ manifest: profileManifest, manifestHash: syncPlanHash(profileManifest) })), /transport denied/);
    const denied = new GitHubSyncTransport({ ...f.host, authorizeMember: () => { throw new Error("not selected"); } }, f.store);
    await assert.rejects(denied.publish(plan), /transport denied/);
    assert(f.requests.every(request => request.method === "GET"));
  } finally { await f.close(); }
});

test("explicit deletion uses original tombstone wire shape and only removes managed paths", async () => {
  const f = await fixture();
  try {
    const deleted = { ...manifest([]), deletions: [{
      type: "notes", itemId: "source", deletedAt: "2026-11-07T00:00:00.000Z", privacy: "public", category: "",
    }] };
    const plan = await f.plan({ manifest: deleted, manifestHash: syncPlanHash(deleted) });
    const result = await f.transport.publish(plan);
    const treeBody = f.requests.find(request => request.route === "/git/trees" && request.method === "POST").body;
    assert.deepEqual(treeBody.tree.find(entry => entry.path === "notes/source.md"),
      { path: "notes/source.md", mode: "100644", type: "blob", sha: null });
    assert(f.trees.get(result.tree).some(entry => entry.path === "README.md"));
    const manifestEntry = f.trees.get(result.tree).find(entry => entry.path === MANIFEST_PATH);
    assert.deepEqual(JSON.parse(f.blobs.get(manifestEntry.sha).toString()).deletions, deleted.deletions);
  } finally { await f.close(); }
});

test("captured original profile bounds/identity/redaction are enforced even with a native-authorized private repository", async () => {
  const id = randomUUID();
  const profile = {
    schema: "pkm.profile/v1", id, revision: 1, updatedAt: "2026-11-07T00:00:00Z",
    kind: "user", name: "Fixture", role: "Tester", focus: "Portable protocol", preferences: "", boundaries: "",
  };
  const makeManifest = record => ({
    ...manifest([file(Buffer.from(JSON.stringify(record)), {
      path: `profiles/user/${id}.json`, type: "profiles", itemId: `user/${id}`, category: "user", privacy: "private",
    })]),
    capabilities: { storage: "pkm.github.publication/v1", required: ["explicit-deletions", "stable-entity-identity", "profile-cards"] },
  });
  const privatePolicy = { visibility: "private", allowPrivate: true, profileConsentScope: "a".repeat(64) };
  for (const record of [profile, { ...profile, secret: "not-a-portable-profile-field" }, { ...profile, name: "x".repeat(121) },
    { ...profile, deleted: true }, { ...profile, focus: "x".repeat(2001) }, { ...profile, id: randomUUID() }]) {
    const f = await fixture({ manifest: makeManifest(record), policy: privatePolicy });
    try {
      if (record === profile) assert.equal((await f.pin()).manifest.files[0].privacy, "private");
      else await assert.rejects(f.pin(), /transport malformed/);
    } finally { await f.close(); }
  }
});

test("redirects, malformed success, truncated trees and auth errors never leak credentials or follow locations", async () => {
  for (const behavior of ["redirect", "malformed", "truncated"]) {
    const f = await fixture({ intercept: ({ route, response, send }) => {
      if (behavior === "redirect" && route === "") { response.writeHead(302, { location: "http://127.0.0.1:1/secret" }); response.end(); return true; }
      if (behavior === "malformed" && route.startsWith("/git/ref/")) { send(200, {}); return true; }
      if (behavior === "truncated" && route.startsWith("/git/trees/")) { send(200, { sha: "a".repeat(40), tree: [], truncated: true }); return true; }
    } });
    try { await assert.rejects(f.pin(), /transport (redirect|malformed)/); assert(f.requests.length <= 4); }
    finally { await f.close(); }
  }
  const f = await fixture({ host: { readSecret: async () => { throw new Error("secret=NEVER_LOG"); } } });
  try {
    await assert.rejects(f.pin(), error => !error.message.includes("NEVER_LOG") && error.code === "AUTH");
    assert.equal(f.requests.length, 0);
  } finally { await f.close(); }
});

test("optional GET retry is bounded; rate-limited mutation is never replayed", async () => {
  const f = await fixture({ transport: { safeGetRetries: 1, maxBackoffMs: 0 }, intercept: ({ route, send, requests }) => {
    if (route === "" && requests.filter(request => request.route === "").length === 1) { send(429, {}, { "retry-after": "0" }); return true; }
  } });
  try { await f.pin(); assert.equal(f.requests.filter(request => request.route === "").length, 2); }
  finally { await f.close(); }
  const g = await fixture({ transport: { safeGetRetries: 2 }, intercept: ({ request, send }) => {
    if (request.method === "POST") { send(429, { message: "secret remote text" }); return true; }
  } });
  try {
    const plan = await g.plan();
    await assert.rejects(g.transport.publish(plan), error => error.code === "RATE_LIMIT" && !error.message.includes("secret"));
    await g.transport.publish(plan);
    assert.equal(g.requests.filter(request => request.method === "POST").length, 1);
  } finally { await g.close(); }
  const h = await fixture({ transport: { safeGetRetries: 2, maxBackoffMs: 100 }, intercept: ({ send }) => {
    send(429, {}, { "retry-after": "60" }); return true;
  } });
  try {
    await assert.rejects(h.pin(), /transport rate_limit/);
    assert.equal(h.requests.length, 1);
  } finally { await h.close(); }
});

test("timeout/cancel do not replay POST, and late secret resolution cannot contact the network", async () => {
  const f = await fixture({ transport: { timeoutMs: 25 }, host: {
    readSecret: async () => { await new Promise(resolve => setTimeout(resolve, 60)); return { login: "approved-login", accessToken: "local-fixture-token" }; },
  } });
  try {
    await assert.rejects(f.pin(), /transport timeout/);
    await new Promise(resolve => setTimeout(resolve, 70));
    assert.equal(f.requests.length, 0);
  } finally { await f.close(); }
  const g = await fixture({ transport: { timeoutMs: 30 }, intercept: ({ request }) => request.method === "POST" });
  try {
    const plan = await g.plan();
    await assert.rejects(g.transport.publish(plan), /transport timeout/);
    const count = g.requests.filter(request => request.method === "POST").length;
    await g.transport.publish(plan);
    assert.equal(g.requests.filter(request => request.method === "POST").length, count);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(g.transport.readPin(undefined, controller.signal), /transport canceled/);
  } finally { await g.close(); }
  const controller = new AbortController();
  const h = await fixture({ intercept: ({ request }) => {
    if (request.method === "POST") { controller.abort(); return true; }
  } });
  try {
    const plan = await h.plan();
    await assert.rejects(h.transport.publish(plan, controller.signal), /transport canceled/);
    assert.equal((await h.transport.publish(plan)).state, "tree-pending");
    assert.equal(h.requests.filter(request => request.method === "POST").length, 1);
  } finally { await h.close(); }
});

test("persisted sync-plan decisions -> exact apply staging receipt -> publication source pins", async () => {
  const f = await fixture();
  const directory = resolve("tests", `.sync-transport-staging-${randomUUID()}`);
  try {
    mkdirSync(resolve(directory, "notes"), { recursive: true });
    initializeSyncPlanStore(f.db);
    initializeSyncApplyJournal(f.db);
    const store = new SyncPlanStore(f.db);
    const pin = await f.pin();
    const localManifest = manifest([file(Buffer.from("local edit\r\n"))]);
    const remoteManifest = pin.manifest;
    const baseManifest = manifest([file(Buffer.from("base\n"))]);
    const snapshot = manifest => ({ manifest, sha256: syncPlanHash(manifest) });
    const input = { base: snapshot(baseManifest), local: snapshot(localManifest), remote: snapshot(remoteManifest) };
    const request = { sessionId: randomUUID(), actorId: "native-actor", input };
    const session = store.create({ ...request, operationId: randomUUID() });
    f.db.prepare("INSERT INTO sync_plan_owners VALUES (?, ?)").run(request.sessionId, request.actorId);
    const staging = { verifyStaged: () => {} };
    assert.throws(() => prepareSyncTransportPublication(f.db, store, { ...request, stagedReceiptId: randomUUID() }, pin, staging), /conflict/);
    store.decide({ sessionId: request.sessionId, operationId: randomUUID(), actorId: request.actorId,
      expectedRevision: 1, conflictId: session.plan.conflicts[0].id, choice: "remote", reason: "Native approved pinned remote bytes" });
    writeFileSync(resolve(directory, "notes/source.md"), Buffer.from("local edit\r\n"));
    const receipt = applySyncPlan(store, request, directory);
    assert.deepEqual(readFileSync(resolve(directory, "notes/source.md")), f.baseBytes);
    const publication = prepareSyncTransportPublication(f.db, store, { ...request, stagedReceiptId: receipt.applyId }, pin,
      syncTransportApplyStaging(f.db, store, request), new Date("2026-11-07T05:59:20.314Z"));
    assert.equal(publication.sourcePins.remote, pin.manifestHash);
    assert.equal(publication.revision, 2);
    const result = await f.transport.publish(publication);
    assert.equal(result.state, "published");
    assert.throws(() => prepareSyncTransportPublication(f.db, store, { ...request, actorId: "caller-forged", stagedReceiptId: receipt.applyId }, pin, staging), /owner/);
  } finally { rmSync(directory, { recursive: true, force: true }); await f.close(); }
});

test("permission-only staging receipt survives interrupted apply recovery", () => {
  const directory = resolve("tests", `.sync-transport-permission-staging-${randomUUID()}`);
  const f = { db: undefined, store: undefined };
  try {
    mkdirSync(resolve(directory, "notes"), { recursive: true });
    const bytes = Buffer.from("same portable bytes\n");
    const destination = resolve(directory, "notes/source.md");
    writeFileSync(destination, bytes);
    chmodSync(destination, 0o644);
    const publicManifest = manifest([file(bytes)]);
    const privateManifest = manifest([file(bytes, { privacy: "private" })]);
    const snapshot = manifest => ({ manifest, sha256: syncPlanHash(manifest) });
    const input = {
      base: snapshot(publicManifest), local: snapshot(publicManifest), remote: snapshot(privateManifest),
    };
    f.db = new DatabaseSync(":memory:");
    initializeSyncPlanStore(f.db);
    initializeSyncApplyJournal(f.db);
    f.store = new SyncPlanStore(f.db);
    const request = { sessionId: randomUUID(), actorId: "native-actor", input };
    f.store.create({ ...request, operationId: randomUUID() });
    f.db.prepare("INSERT INTO sync_plan_owners VALUES (?, ?)").run(request.sessionId, request.actorId);
    const pin = {
      schema: "pkm.sync-transport-pin/v1", policyId: randomUUID(), commit: "c".repeat(40),
      tree: "d".repeat(40), manifestBlob: "e".repeat(40), manifest: privateManifest,
      manifestHash: syncPlanHash(privateManifest),
    };
    const publicationRequest = { ...request, stagedReceiptId: "" };
    assert.throws(() => applySyncPlan(f.store, request, directory, {
      faultInjector: (_action, _index, phase) => {
        if (phase === undefined) throw new Error("interrupted after chmod");
      },
    }), /interrupted after chmod/);
    const pending = f.db.prepare("SELECT apply_id, state FROM sync_apply_journal").get();
    assert.equal(pending.state, "prepared");
    assert.equal(statSync(destination).mode & 0o777, 0o600);
    publicationRequest.stagedReceiptId = pending.apply_id;
    assert.throws(() => prepareSyncTransportPublication(f.db, f.store, publicationRequest, pin,
      syncTransportApplyStaging(f.db, f.store, request)), /completed durable apply receipt/);

    const [receipt] = recoverSyncApply(f.store, directory);
    assert.equal(receipt.operations[0].beforeMode, 0o644);
    assert.equal(receipt.operations[0].afterMode, 0o600);
    const publication = prepareSyncTransportPublication(f.db, f.store, publicationRequest, pin,
      syncTransportApplyStaging(f.db, f.store, request), new Date("2026-11-07T05:59:20.314Z"));
    assert.equal(publication.stagedReceiptId, receipt.applyId);
    assert.equal(publication.manifest.files[0].privacy, "private");
    const tampered = structuredClone(receipt);
    tampered.operations[0].beforeMode = 0o640;
    f.db.prepare("UPDATE sync_apply_journal SET receipt_json=? WHERE apply_id=?")
      .run(JSON.stringify(tampered), receipt.applyId);
    assert.throws(() => prepareSyncTransportPublication(f.db, f.store, publicationRequest, pin,
      syncTransportApplyStaging(f.db, f.store, request)), /receipt does not match its journaled result/);
  } finally {
    f.db?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
