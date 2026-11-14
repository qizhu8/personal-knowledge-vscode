import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { subscriptionTransportFixture, originalMarkdown, hash } from "./subscription-transport-fixtures.mjs";
import { checkCaptureRecords, checkNativeRecords } from "../scripts/migration.mjs";

test("actual socket original signed gateway -> isolated native materialization, exact bytes/aliases, durable receipt retry", async t => {
  const f = await subscriptionTransportFixture(t);
  const receipt = await f.makeHost().run(f.request);
  const mapping = receipt.apply.result.mappings[0];
  assert.equal(readFileSync(join(f.root, "notes", mapping.destinationPath), "utf8"), originalMarkdown);
  assert.deepEqual(readFileSync(join(f.root, "notes", receipt.apply.result.assets[0].destinationPath)), f.asset);
  assert.equal(receipt.apply.identities[0].documentId, "source-original");
  assert(receipt.apply.identities[0].aliases.includes("note:historic/path"));
  assert.equal(receipt.readOnly, false);
  assert.equal(receipt.snapshotSha256, hash(f.snapshot));
  assert.deepEqual(await f.makeHost().run(f.request), receipt);
  assert.deepEqual([f.counts.summary, f.counts.ticket, f.counts.bundle], [2, 1, 1]);
  assert.equal(f.state().phase, "complete");
  assert.equal(f.state().runnerId, null);
  assert(!/http:|fixture_ticket|subscriber_proof|secret-reference|brokerUrl/.test(JSON.stringify(receipt)));
  assert(!/http:|fixture_ticket|subscriber_proof|secret-reference|brokerUrl/.test(f.state().intent));
  f.revoke();
  await assert.rejects(f.makeHost().run(f.request), { code: "ACCESS_DENIED" });
});

test("readonly source mirror is immutable and separate from writable fork identities", async t => {
  const f = await subscriptionTransportFixture(t);
  const request = { ...f.request, mode: "readonly-mirror" };
  const receipt = await f.makeHost().run(request);
  assert.equal(receipt.readOnly, true);
  assert.equal(receipt.apply, null);
  assert.equal((await f.makeHost().readMirror(request)).toString(), f.snapshot);
  assert.deepEqual(readdirSync(join(f.root, "notes")), []);
  assert.equal(JSON.parse((await f.makeHost().readMirror(request)).toString()).notes[0].content, originalMarkdown);
  f.revoke();
  await assert.rejects(f.makeHost().readMirror(request), { code: "ACCESS_DENIED" });
});

test("default disabled, host endpoint SSRF/redirect/metadata/cleartext grant and strict signed version fences", async t => {
  const f = await subscriptionTransportFixture(t);
  await assert.rejects(f.makeHost({ endpoint: undefined }).run(f.request), { code: "UNSUPPORTED" });
  assert.equal(f.counts.requests.length, 0);
  for (const endpoint of [
    { ...f.endpoint, connectAddress: "169.254.169.254" },
    { ...f.endpoint, controlUrl: "http://8.8.8.8", connectAddress: "8.8.8.8" },
    { ...f.endpoint, controlUrl: `http://user:password@127.0.0.1:8000` },
    { ...f.endpoint, controlUrl: "http://localhost:8000" },
  ]) assert.throws(() => f.makeHost({ endpoint }), { code: "ACCESS_DENIED" });
  for (const mode of ["redirect", "summary-403", "summary-304", "signature-bad", "version-change", "ticket-change", "ticket-expired", "grant-ssrf", "protected", "data-403", "archive"]) {
    const other = await subscriptionTransportFixture(t, { mode });
    await assert.rejects(other.makeHost().run(other.request), undefined, mode);
    assert.deepEqual(readdirSync(join(other.root, "notes")), [], mode);
  }
});

test("digest mismatch, async source ACL/revision revocation and cancellation never publish knowledge bytes", async t => {
  for (const mode of ["digest-bad", "revoke", "native-change", "abort", "remote-revoke"]) {
    const controller = new AbortController();
    const f = await subscriptionTransportFixture(t, { mode, controller });
    await assert.rejects(f.makeHost().run(f.request, controller.signal));
    assert.deepEqual(readdirSync(join(f.root, "notes")), [], mode);
    if (mode !== "remote-revoke") assert(!existsSync(join(f.root, "transport-staging", `${f.request.operationId}.snapshot`)), mode);
    if (mode === "abort") assert.equal(f.state().phase, "cancelled");
  }
});

test("partial transfers restart only with fresh one-use ticket and same signed source; no unsafe Range resume", async t => {
  const f = await subscriptionTransportFixture(t, { mode: "partial" });
  await assert.rejects(f.makeHost().run(f.request));
  assert.equal(f.state().phase, "downloading");
  assert.deepEqual(readdirSync(join(f.root, "transport-staging")), []);
  f.setMode("normal");
  const receipt = await f.makeHost().run(f.request);
  assert.equal(receipt.bytes, Buffer.byteLength(f.snapshot));
  assert.equal(f.counts.ticket, 2);
  assert(f.counts.requests.every(request => request.range === undefined && request.conditional === undefined));
});

test("verified durable transfer resumes without redownload after source/digest revalidation; unknown applying state never replays", async t => {
  const f = await subscriptionTransportFixture(t);
  const host = f.makeApplyHost();
  host.preview = async () => { throw new Error("fixture after verified download"); };
  await assert.rejects(f.makeHost({ applyHost: host }).run(f.request), /after verified/);
  assert.equal(f.state().phase, "verified");
  const abandoned = f.state();
  abandoned.runnerId = "fixture-process-killed";
  abandoned.leaseUntil = Date.now() - 1;
  writeFileSync(join(f.root, "fixture-global-journal", `${f.request.operationId}.transport`), JSON.stringify(abandoned));
  const receipt = await f.makeHost().run(f.request);
  assert.equal(receipt.apply.result.mappings.length, 1);
  assert.equal(f.counts.ticket, 1);
  const g = await subscriptionTransportFixture(t);
  const unknown = g.makeApplyHost();
  unknown.apply = async () => { throw new Error("unknown before native apply intent"); };
  await assert.rejects(g.makeHost({ applyHost: unknown }).run(g.request), /unknown before/);
  assert.equal(g.state().phase, "applying");
  await assert.rejects(g.makeHost().run(g.request), { code: "NOT_FOUND" });
  assert.equal(g.counts.ticket, 1);
  assert.deepEqual(readdirSync(join(g.root, "notes")), []);
  const committed = await subscriptionTransportFixture(t);
  const applyHost = committed.makeApplyHost(), realApply = applyHost.apply.bind(applyHost);
  applyHost.apply = (input, id, revision) => realApply(input, id, revision, event => {
    if (event === "commit") throw new Error("fixture lost apply response after durable commit");
  });
  await assert.rejects(committed.makeHost({ applyHost }).run(committed.request), /lost apply response/);
  assert.equal(committed.state().phase, "applying");
  const recovered = await committed.makeHost().run(committed.request);
  assert.equal(recovered.apply.identities[0].documentId, "source-original");
  assert.equal(committed.counts.ticket, 1);
});

test("linked staging/destination, traversal, zip/package protocols and tampered verified receipts fail closed", async t => {
  const f = await subscriptionTransportFixture(t);
  symlinkSync(join(f.root, "notes"), join(f.root, "linked-stage"));
  assert.throws(() => f.makeHost({ stagingRoot: join(f.root, "linked-stage") }), { code: "INVALID_WORKSPACE" });
  symlinkSync(join(f.root, "notes"), join(f.root, "transport-staging", `${f.request.operationId}.partial`));
  await assert.rejects(f.makeHost().run(f.request), { code: "RECOVERY_CONFLICT" });
  for (const bundle of [
    { notes: [{ slug: "../escape", content: "# Bad" }] },
    { notes: [{ slug: "A", content: "# A" }], assets: [{ type: "notes", path: "../A.assets/x", data: "AA==", digest: `sha256:${hash(Buffer.from([0]))}` }] },
    { packages: [{ name: "archive", files: [{ path: "../../bad", content: "x" }] }] },
  ]) {
    const g = await subscriptionTransportFixture(t, { bundle });
    await assert.rejects(g.makeHost().run(g.request));
    assert.deepEqual(readdirSync(join(g.root, "notes")), []);
  }
  const g = await subscriptionTransportFixture(t);
  await g.makeHost().run(g.request);
  writeFileSync(join(g.root, "transport-staging", `${g.request.operationId}.snapshot`), "{}");
  await assert.rejects(g.makeHost().run(g.request), { code: "RECOVERY_CONFLICT" });
  const destination = await subscriptionTransportFixture(t);
  symlinkSync(join(destination.root, "subscriptions"), join(destination.root, "notes", "folk-linked"));
  await assert.rejects(destination.makeHost().run(destination.request), { code: "RECOVERY_CONFLICT" });
});

test("bounded asset/document counts, expiry, changed retry intent and CAS failure precede native writes", async t => {
  for (const bundle of [
    { notes: Array.from({ length: 513 }, (_, i) => ({ slug: `A${i}`, content: "# Bounded" })) },
    { notes: [{ slug: "Team/A", content: "# A" }], assets: Array.from({ length: 2049 }, () => ({})) },
  ]) {
    const f = await subscriptionTransportFixture(t, { bundle });
    await assert.rejects(f.makeHost().run(f.request));
    assert.deepEqual(readdirSync(join(f.root, "notes")), []);
  }
  const f = await subscriptionTransportFixture(t);
  await assert.rejects(f.makeHost().run({ ...f.request, expiresAt: new Date(Date.now() - 1).toISOString() }), { code: "ACCESS_DENIED" });
  assert.equal(f.counts.requests.length, 0);
  await f.makeHost().run(f.request);
  await assert.rejects(f.makeHost().run({ ...f.request, paths: ["different.md"] }), { code: "RECOVERY_CONFLICT" });
  const g = await subscriptionTransportFixture(t);
  const failingCAS = { runExclusive(id, work) { return g.store.runExclusive(id, tx => work({ ...tx, async compareAndSwap() { return false; } })); } };
  await assert.rejects(g.makeHost({ store: failingCAS }).run(g.request), { code: "RECOVERY_CONFLICT" });
  assert.equal(g.counts.requests.length, 0);
  assert.deepEqual(readdirSync(join(g.root, "notes")), []);
  const clock = { value: Date.now() }, expiry = await subscriptionTransportFixture(t, { mode: "expire", clock });
  await assert.rejects(expiry.makeHost({ now: () => clock.value }).run(expiry.request), { code: "ACCESS_DENIED" });
  assert.equal(expiry.state().phase, "expired");
  assert.deepEqual(readdirSync(join(expiry.root, "notes")), []);
});

test("frozen canonical captures distinguish executable source lineage, read-only references and native implementation", async () => {
  const nextRoot = resolve(dirname(fileURLToPath(import.meta.url)), ".."), originalRoot = resolve(nextRoot, "..");
  const provenance = JSON.parse(readFileSync(join(nextRoot, "migration/subscription-transport-provenance.json"), "utf8"));
  assert.equal(provenance.originalRoot, originalRoot);
  assert.equal(provenance.nextRoot, nextRoot);
  assert.equal(provenance.files.length, 1);
  assert.equal(provenance.files[0].source, "src/subscriptions/subscriptions.ts");
  assert.equal(provenance.files[0].captured, provenance.capture.path);
  assert.equal(provenance.files[0].capturedSha256, provenance.capture.sha256);
  assert.equal(provenance.sourceReferences.length, 6);
  for (const file of [...provenance.files, ...provenance.sourceReferences]) assert.equal(hash(readFileSync(join(originalRoot, file.source))), file.sourceSha256, file.source);
  assert.equal(hash(readFileSync(join(nextRoot, provenance.capture.path))), provenance.capture.sha256);
  assert.deepEqual(await checkCaptureRecords(provenance.files, originalRoot, nextRoot), []);
  assert.deepEqual(await checkNativeRecords(provenance.native, nextRoot), []);
  assert(provenance.native.some(record => record.file === "src/subscription-transport.ts"));
  const malformed = provenance.files.map(({ captured: _captured, ...record }) => record);
  await assert.rejects(checkCaptureRecords(malformed, originalRoot, nextRoot), /Malformed domain-capture provenance/);
});

test("MQTT fake topic grants never authorize, version-pin or trigger socket requests", async t => {
  const f = await subscriptionTransportFixture(t), host = f.makeHost();
  const payload = Buffer.from(JSON.stringify({ shareId: f.source.shareId, revision: 99, allowed: true, brokerUrl: "http://169.254.169.254" }));
  assert.equal(host.notificationHint(`pkm/v1/nodes/${f.source.nodeId}/shares/${f.source.shareId}/summary`, payload, f.source), true);
  assert.equal(host.notificationHint("pkm/v1/nodes/attacker/shares/other/summary", payload, f.source), false);
  assert.equal(f.counts.requests.length, 0);
  assert.equal(f.source.revision, 1);
  f.revoke();
  await assert.rejects(host.run(f.request), { code: "ACCESS_DENIED" });
  assert.equal(f.counts.requests.length, 0);
});
