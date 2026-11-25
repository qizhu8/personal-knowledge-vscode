import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { initialize, Storage } from "../dist/storage.js";
import { chatSessionDefinitions } from "../dist/chat-session-contracts.js";
import { chatSessionFixture } from "./chat-session-fixtures.mjs";

const digest = value => createHash("sha256").update(value).digest("hex");
const bodyHash = (operation, args) => digest(JSON.stringify({ operation, version: 1, arguments: args }));
const pinFor = (request, bodySha256 = bodyHash(request.operation, request.args)) => ({
  actorId: request.actorId, operationId: request.args.operationId, operation: request.operation, bodySha256,
});
const create = (id = "entry", operationId = randomUUID()) => ({
  operation: "knowledge.document.create", actorId: "test:receipt-owner",
  args: { operationId, id, title: "Private document title", content: "private-body-must-not-leak" },
});
async function fixture(t) {
  const parent = resolve(".migration-test-work", `receipt-read-${randomUUID()}`);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const root = await initialize(join(parent, "root"), { storageLayout: "separated" });
  let storage = await Storage.open(root);
  t.after(async () => { await storage.close(); await rm(parent, { recursive: true, force: true }); });
  return { root, get storage() { return storage; }, async reopen() { await storage.close(); storage = await Storage.open(root); } };
}
function workerReply(storage, message) {
  const id = 1_000_000 + Math.floor(Math.random() * 1_000_000);
  return new Promise(resolve => {
    const listener = value => {
      if (value.id !== id) return;
      storage.worker.off("message", listener);
      resolve(value);
    };
    storage.worker.on("message", listener);
    storage.worker.postMessage({ ...message, id });
  });
}

test("actual actor-private committed receipt pins survive restart without returning arguments or replaying writes", async t => {
  const f = await fixture(t), request = create(), pin = pinFor(request);
  await f.storage.bindBrowserMutationPin(request, pin.bodySha256);
  assert.deepEqual(await f.storage.readBrowserMutationReceipt(pin), { state: "unknown" });
  await f.storage.request(request);
  const bytes = await readFile(join(f.root, "notes/entry.md"));
  const first = await f.storage.readBrowserMutationReceipt(pin);
  assert.equal(first.state, "committed");
  assert.deepEqual({ ...first, state: undefined, receiptSha256: undefined }, { ...pin, state: undefined, receiptSha256: undefined });
  assert.match(first.receiptSha256, /^[a-f0-9]{64}$/);
  assert.ok(!JSON.stringify(first).includes(request.args.title));
  assert.ok(!JSON.stringify(first).includes(request.args.content));
  await f.reopen();
  assert.deepEqual(await f.storage.readBrowserMutationReceipt(pin), first);
  assert.deepEqual(await readFile(join(f.root, "notes/entry.md")), bytes);
  for (const other of [{ ...pin, actorId: "test:other" }, { ...pin, operation: "knowledge.document.update" },
    { ...pin, operationId: randomUUID() }, { ...pin, bodySha256: digest("another body") }])
    assert.deepEqual(await f.storage.readBrowserMutationReceipt(other), { state: "unknown" });
});

test("competing pre-bound UUID bodies cannot claim the winner and valid wire aliases retain exact receipt proof", async t => {
  const f = await fixture(t), winner = create(), loser = {
    ...winner, args: { ...winner.args, content: "different content" },
  }, a = pinFor(winner), b = pinFor(loser);
  await f.storage.bindBrowserMutationPin(winner, a.bodySha256);
  await f.storage.bindBrowserMutationPin(loser, b.bodySha256);
  await f.storage.request(winner);
  await assert.rejects(f.storage.request(loser), { code: "CONFLICT" });
  assert.equal((await f.storage.readBrowserMutationReceipt(a)).state, "committed");
  assert.deepEqual(await f.storage.readBrowserMutationReceipt(b), { state: "unknown" });
  const changed = { ...winner, args: { ...winner.args, title: "changed title" } }, changedPin = pinFor(changed);
  await assert.rejects(f.storage.bindBrowserMutationPin(changed, changedPin.bodySha256), { code: "CONFLICT" });
  assert.deepEqual(await f.storage.readBrowserMutationReceipt(changedPin), { state: "unknown" });

  const alias = pinFor(winner, bodyHash(winner.operation, { title: winner.args.title, ...winner.args }));
  assert.notEqual(alias.bodySha256, a.bodySha256);
  await f.storage.bindBrowserMutationPin(winner, alias.bodySha256);
  assert.equal((await f.storage.readBrowserMutationReceipt(alias)).state, "committed");
  const unsupported = pinFor(winner, digest("unsupported native dispatch context"));
  await f.storage.bindBrowserMutationPin(winner, unsupported.bodySha256, "unknown");
  assert.deepEqual(await f.storage.readBrowserMutationReceipt(unsupported), { state: "unknown" });
});

test("receipt reads report matching pending intent without running recovery or treating absence as not committed", async t => {
  const f = await fixture(t), request = create("pending"), pin = pinFor(request);
  await f.storage.bindBrowserMutationPin(request, pin.bodySha256);
  const db = f.storage.connectNative();
  try {
    const fingerprint = db.prepare("SELECT receipt_fingerprint FROM browser_mutation_pins WHERE operation_id=?")
      .get(pin.operationId).receipt_fingerprint;
    db.prepare(`INSERT INTO pending_write(singleton,operation_id,fingerprint,actor_id,operation,document_id,
      before_sha256,after_markdown,document_path,document_area) VALUES(1,?,?,?,?,?,NULL,?,?,?)`)
      .run(pin.operationId, fingerprint, pin.actorId, pin.operation, "pending", "unpublished-secret-markdown", "pending.md", "notes");
    const before = db.prepare("SELECT * FROM pending_write").get();
    assert.deepEqual(await f.storage.readBrowserMutationReceipt(pin), { state: "pending" });
    assert.deepEqual(db.prepare("SELECT * FROM pending_write").get(), before);
    assert.equal(db.prepare("SELECT 1 FROM receipts WHERE operation_id=?").get(pin.operationId), undefined);
    await assert.rejects(readFile(join(f.root, "notes/pending.md")), { code: "ENOENT" });
    db.prepare("UPDATE pending_write SET fingerprint=?").run(digest("different intent"));
    assert.deepEqual(await f.storage.readBrowserMutationReceipt(pin), { state: "unknown" });
  } finally { db.exec("DELETE FROM pending_write"); db.close(); }
});

test("actual Chat batch receipt uses its canonical fingerprint rather than the browser wire-body digest", async t => {
  const f = await fixture(t), raw = { ...chatSessionFixture.create.args, operationId: randomUUID() };
  const definition = chatSessionDefinitions.find(item => item.id === "chat.session.create");
  const request = { operation: definition.id, actorId: "test:chat-owner", args: definition.input.parse(raw) };
  const pin = pinFor(request, bodyHash(request.operation, raw));
  await f.storage.bindBrowserMutationPin(request, pin.bodySha256);
  await f.storage.request(request);
  assert.equal((await f.storage.readBrowserMutationReceipt(pin)).state, "committed");
  const db = f.storage.connectNative();
  try {
    const receipt = db.prepare("SELECT fingerprint FROM receipts WHERE operation_id=?").get(pin.operationId);
    assert.notEqual(receipt.fingerprint, pin.bodySha256, "different hash domains are explicitly bridged");
    db.prepare("UPDATE receipts SET fingerprint=? WHERE operation_id=?").run(digest("foreign replacement"), pin.operationId);
    assert.deepEqual(await f.storage.readBrowserMutationReceipt(pin), { state: "unknown" });
  } finally { db.close(); }
});

test("private receipt worker rejects stale ownership and mixed business envelopes", async t => {
  const f = await fixture(t), request = create(), pin = pinFor(request);
  const owner = await workerReply(f.storage, { runtimeOwner: { ownerId: randomUUID(), fence: 1 },
    mutationReceipt: { read: pin } });
  assert.equal(owner.error.code, "STORAGE_UNAVAILABLE");
  const mixed = await workerReply(f.storage, { request, mutationReceipt: { read: pin } });
  assert.equal(mixed.error.code, "ACCESS_DENIED");
  await assert.rejects(readFile(join(f.root, "notes/entry.md")), { code: "ENOENT" });
});
