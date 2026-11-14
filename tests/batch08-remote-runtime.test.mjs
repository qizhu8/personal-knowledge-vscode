import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import test from "node:test";
import { MANIFEST_PATH } from "../dist/domain/sync-transport-original.js";
import { subscriptionTransportSocketFetch } from "../dist/subscription-transport.js";
import { httpCall, nativeWorkspace } from "./batch06-manager-fixtures.mjs";
import { subscriptionTransportFixture } from "./subscription-transport-fixtures.mjs";
import { fixture as syncFixture } from "./sync-transport-fixture.mjs";

const actorId = "native-actor";
const operation = () => randomUUID();
const sourceSnapshot = pin => ({ manifest: pin.pin.manifest, sha256: pin.pin.manifestHash });

async function openRemoteWorkspace(t, publisherPolicy = true) {
  let composed;
  const fixture = await syncFixture({
    requireFixtureReceipt: false,
    onRequest({ method }) {
      if (method === "GET") return;
      assert.ok(composed, "remote mutation cannot precede native workspace initialization");
      const database = composed.storage.connectNative();
      try {
        const intent = database.prepare(`SELECT state FROM remote_runtime_intents
          WHERE kind='remote.sync.publish' AND actor_id=? ORDER BY rowid DESC LIMIT 1`).get(actorId);
        const staged = database.prepare(`SELECT journal_json FROM sync_transport_intents
          WHERE actor_id=? ORDER BY rowid DESC LIMIT 1`).get(actorId);
        assert.ok(intent, "native publish intent must be durable before every mocked GitHub mutation");
        assert.ok(staged, "native transport journal must be durable before every mocked GitHub mutation");
      } finally {
        database.close();
      }
    },
  });
  composed = await nativeWorkspace(t, async root => {
    await mkdir(join(root, "notes"), { recursive: true });
    await writeFile(join(root, "notes/source.md"), fixture.baseBytes);
    return {
      remote: {
        authorize: async (id, action) => id === actorId && ["read", "plan", "apply", "publish"].includes(action),
        sync: fixture.host,
        ...(publisherPolicy ? {
          publisherPolicy: {
            policyId: fixture.host.policy.policyId,
            enforcement: "all-repository-ref-writers",
          },
        } : {}),
      },
    };
  });
  t.after(() => fixture.close());
  return { fixture, composed, remote: composed.runtime.services.remote };
}

async function createNoopSession(remote) {
  const pinned = await remote.pin(actorId);
  const snapshot = sourceSnapshot(pinned);
  const session = await remote.plan(actorId, {
    operationId: operation(),
    sessionId: operation(),
    pinId: pinned.pinId,
    base: snapshot,
    local: snapshot,
  });
  return { pinned, snapshot, session };
}

function mutations(fixture) {
  return fixture.requests.filter(request => request.method !== "GET");
}

test("native remote wrapper pins, applies and publishes through the local GitHub HTTP transport", async t => {
  const { fixture, composed, remote } = await openRemoteWorkspace(t);
  const { session } = await createNoopSession(remote);
  const applied = await remote.apply(actorId, { operationId: operation(), sessionId: session.sessionId });
  const published = await remote.publish(actorId, {
    operationId: operation(),
    sessionId: session.sessionId,
    stagedReceiptId: applied.applyId,
  });

  assert.equal(published.state, "published");
  assert.equal(fixture.ref, published.commit);
  assert(mutations(fixture).some(item => item.route === "/git/refs/heads/approved/branch"));
  const commit = fixture.commits.get(published.commit);
  assert(commit, "published commit is present in the mock GitHub object graph");
  const paths = new Set(fixture.trees.get(commit.tree.sha).map(item => item.path));
  assert(paths.has("notes/source.md"), "unchanged managed source remains in the published tree");
  assert(paths.has("README.md"), "unmanaged content remains in the published tree");
  assert(paths.has(MANIFEST_PATH), "the verified manifest remains in the published tree");

  const url = await composed.listen({ id: actorId, canWrite: true });
  const denied = await httpCall(url, composed.bearer, "capability_call", {
    operation: "remote.runtime.publish", version: 1, arguments: {},
  });
  assert.notEqual(denied.status, 200, "native-only publication is unavailable through the public HTTP/MCP gateway");
});

test("native publication fails closed without an all-writer policy and after a stale ref", async t => {
  const unguarded = await openRemoteWorkspace(t, false);
  const { session: unguardedSession } = await createNoopSession(unguarded.remote);
  const unguardedApply = await unguarded.remote.apply(actorId, {
    operationId: operation(), sessionId: unguardedSession.sessionId,
  });
  await assert.rejects(unguarded.remote.publish(actorId, {
    operationId: operation(), sessionId: unguardedSession.sessionId, stagedReceiptId: unguardedApply.applyId,
  }), error => error.code === "DENIED");
  assert.deepEqual(mutations(unguarded.fixture), [], "uncontrolled publication makes no remote writes");

  const stale = await openRemoteWorkspace(t);
  const { session } = await createNoopSession(stale.remote);
  const applied = await stale.remote.apply(actorId, { operationId: operation(), sessionId: session.sessionId });
  stale.fixture.ref = "b".repeat(40);
  const staleResult = await stale.remote.publish(actorId, {
    operationId: operation(), sessionId: session.sessionId, stagedReceiptId: applied.applyId,
  });
  assert.equal(staleResult.state, "stale");
  assert.deepEqual(mutations(stale.fixture), [], "a foreign ref advance is detected before any GitHub mutation");
});

async function openSubscriptionWorkspace(t, subscriptionFixture, options = {}) {
  let composed;
  composed = await nativeWorkspace(t, async root => {
    const subscriptionRoot = join(root, "subscriptions");
    await mkdir(subscriptionRoot, { recursive: true });
    for (const name of await readdir(join(subscriptionFixture.root, "subscriptions"))) {
      await writeFile(join(subscriptionRoot, name), await readFile(join(subscriptionFixture.root, "subscriptions", name)));
    }
    const stagingRoot = resolve(dirname(root), `${basename(root)}-transport-staging`);
    await mkdir(stagingRoot, { recursive: true });
    t.after(() => rm(stagingRoot, { recursive: true, force: true }));
    return {
      subscription: {
        endpoint: subscriptionFixture.endpoint,
        stagingRoot,
        secrets: { async resolve() { return { subscriberProof: "fixture_signed_subscriber_proof" }; } },
        authorityForActor: async id => ({
          actorId: id,
          sourceIp: "192.0.2.10",
          subscriptionId: subscriptionFixture.source.subscriptionId,
          capabilityId: subscriptionFixture.source.capabilityId,
        }),
        nativePolicy: async () => options.nativeAllowed?.() ?? true,
        authorize: async () => options.authorize?.() ?? "fixture-native-revision",
        ...(options.fetch ? { fetch: options.fetch } : {}),
      },
    };
  });
  return { composed, subscription: composed.runtime.services.subscription };
}

test("native subscription wrapper applies verified fork data and keeps mirror reads immutable", async t => {
  const fork = await subscriptionTransportFixture(t);
  const forkWorkspace = await openSubscriptionWorkspace(t, fork);
  const receipt = await forkWorkspace.subscription.run("fixture:reader", fork.request);
  assert.equal(receipt.mode, "fork");
  assert.equal(receipt.readOnly, false);
  assert.equal(fork.counts.bundle, 1);
  assert(receipt.apply, "fork receipt carries the native materialization result");
  const note = receipt.apply.result.mappings[0].destinationPath;
  const asset = receipt.apply.result.assets[0].destinationPath;
  assert.equal(await readFile(join(forkWorkspace.composed.root, "notes", note), "utf8"), JSON.parse(fork.snapshot).notes[0].content);
  assert.deepEqual(await readFile(join(forkWorkspace.composed.root, "notes", asset)), fork.asset);

  const mirror = await subscriptionTransportFixture(t);
  const mirrorWorkspace = await openSubscriptionWorkspace(t, mirror);
  const mirrorRequest = { ...mirror.request, operationId: operation(), mode: "readonly-mirror" };
  const mirrored = await mirrorWorkspace.subscription.run("fixture:reader", mirrorRequest);
  assert.equal(mirrored.mode, "readonly-mirror");
  assert.equal(mirrored.readOnly, true);
  assert.equal(mirrored.apply, null);
  await assert.rejects(mirrorWorkspace.subscription.readMirror("fixture:reader", mirror.request), /mirror|mode|fork/i);
  assert.equal(mirror.counts.bundle, 1, "a fork request is rejected by readMirror before another remote fetch");
  await assert.rejects(readFile(join(mirrorWorkspace.composed.root, "notes/Team/A.md")), { code: "ENOENT" });
});

test("native subscription rechecks source authorization after fetch and rejects digest, version and path drift", async t => {
  let authorized = true;
  const revoked = await subscriptionTransportFixture(t);
  const revokeWorkspace = await openSubscriptionWorkspace(t, revoked, {
    fetch: async (url, method, headers, signal, address) => {
      const response = await subscriptionTransportSocketFetch(url, method, headers, signal, address);
      if (new URL(url).pathname === "/sync/bundle") authorized = false;
      return response;
    },
    authorize: () => authorized ? "fixture-native-revision" : (() => { throw new Error("native ACL revoked"); })(),
  });
  await assert.rejects(revokeWorkspace.subscription.run("fixture:reader", revoked.request), /revoked|denied|authorized/i);
  assert.equal(revoked.counts.bundle, 1, "the source was fetched before the native ACL changed");
  await assert.rejects(readFile(join(revokeWorkspace.composed.root, "notes/Team/A.md")), { code: "ENOENT" });

  for (const mode of ["digest-bad", "version-change"]) {
    const source = await subscriptionTransportFixture(t, { mode });
    const sourceWorkspace = await openSubscriptionWorkspace(t, source);
    await assert.rejects(sourceWorkspace.subscription.run("fixture:reader", source.request));
    assert.equal(source.counts.bundle, mode === "digest-bad" ? 1 : 0);
    await assert.rejects(readFile(join(sourceWorkspace.composed.root, "notes/Team/A.md")), { code: "ENOENT" });
  }

  const repinned = await subscriptionTransportFixture(t);
  const repinnedWorkspace = await openSubscriptionWorkspace(t, repinned);
  const subscriptionsPath = join(repinnedWorkspace.composed.root, "subscriptions/subscriptions.json");
  const subscriptions = JSON.parse(await readFile(subscriptionsPath, "utf8"));
  subscriptions.subscriptions[0].revision++;
  await writeFile(subscriptionsPath, JSON.stringify(subscriptions));
  await assert.rejects(repinnedWorkspace.subscription.run("fixture:reader", repinned.request));
  assert.equal(repinned.counts.bundle, 1, "the native source pin is rechecked after transfer and before local application");
  assert.deepEqual(await readdir(join(repinnedWorkspace.composed.root, "notes"), { recursive: true }), [],
    "a changed local subscription pin cannot materialize transferred content");

  const invalidPath = await subscriptionTransportFixture(t);
  const invalidWorkspace = await openSubscriptionWorkspace(t, invalidPath);
  await assert.rejects(invalidWorkspace.subscription.run("fixture:reader", {
    ...invalidPath.request,
    paths: ["../escape.md"],
  }));
  assert.equal(invalidPath.counts.requests.length, 0, "invalid local paths are rejected before any source fetch");
});
