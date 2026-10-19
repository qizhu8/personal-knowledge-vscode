const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { ApiChatStore } = require("../dist/chat/api-chat-store");
const { captureExecutionContext } = require("../dist/chat/execution-context");
const { workerLimits } = require("../dist/chat/worker-tree");
const { memoryPolicy, memoryAgeAllows, validMemoryPolicy } = require("../dist/chat/chat-memory-policy");
const { recallScopedChatMemory, scopedMemorySegment } = require("../dist/chat/chat-memory-scope");
const { retrieveChatMemory, recentChatDialogue } = require("../dist/chat/chat-memory");
const { chatRetrievalReceipt } = require("../dist/chat/chat-retrieval");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-memory-scope-"));
  t.after(() => fs.rmSync(root, { recursive:true, force:true }));
  const store = new ApiChatStore(root, "0123456789abcdef");
  const owner = store.create();
  const executionContext = captureExecutionContext(randomUUID(), [], root, true, "read-only");
  const treeId = store.workerTrees.create(owner.id);
  owner.workerState = { treeId, executionContext, sleeping:false, stopped:false, events:[] };
  store.save(owner);
  const addWorker = (parent, title) => {
    const [slot] = store.workerTrees.reserve(treeId, parent.id, [title], workerLimits(10, 10));
    const worker = store.createWorker(parent, slot.chatId, title, { treeId, parentChatId:parent.id,
      receiptId:slot.receiptId, executionContext, sleeping:false, stopped:false, events:[] });
    worker.messages.push({ id:randomUUID(), role:"assistant", status:"complete", content:`${title}: research checksum verified.`, recordedAt:new Date().toISOString() });
    store.save(worker);
    return worker;
  };
  return { root, store, owner, addWorker };
}

test("default authorization includes descendant workers, never parent, siblings or unrelated Chats", t => {
  const { store, owner, addWorker } = fixture(t);
  const first = addWorker(owner, "first"), sibling = addWorker(owner, "sibling"), child = addWorker(first, "child");
  const unrelated = store.create();
  assert.deepEqual(new Set(store.memorySourceIds(owner)), new Set([first.id, sibling.id, child.id]));
  assert.deepEqual(store.memorySourceIds(first), [child.id]);
  assert(!store.memorySourceIds(first).includes(owner.id));
  assert(!store.memorySourceIds(first).includes(sibling.id));
  assert(!store.memorySourceIds(owner).includes(unrelated.id));
  const recall = recallScopedChatMemory(store, owner, "research checksum");
  assert.equal(recall.references.length, 3);
  assert(recall.references.every(reference => reference.candidate.kind === "memory" && reference.isCurrent()));
  assert.equal(memoryPolicy(owner).recallDays, 30);
});

test("cross-workspace grants are explicit membership snapshots and are not inherited into workers", t => {
  const { root, store, owner, addWorker } = fixture(t);
  const other = new ApiChatStore(root, "fedcba9876543210");
  const source = other.create();
  source.messages.push({ id:randomUUID(), role:"user", status:"complete", content:"PRIVATE research checksum", recordedAt:new Date().toISOString() });
  other.save(source);
  assert.equal(recallScopedChatMemory(store, owner, "research checksum").references.length, 0);
  const grant = store.memoryScopeChoices().find(scope => scope.kind === "workspace" && scope.id === other.namespace);
  owner.memoryPolicy = { ...memoryPolicy(owner), grants:[{ kind:grant.kind, id:grant.id, chatIds:grant.chatIds }] };
  store.save(owner);
  const reference = recallScopedChatMemory(store, owner, "research checksum").references[0];
  assert(reference && reference.isCurrent());
  const worker = addWorker(owner, "worker");
  assert.equal(memoryPolicy(worker).grants.length, 0);
  assert(!store.memorySourceIds(worker).includes(source.id));
  const later = other.create();
  assert(!store.memorySourceIds(owner).includes(later.id));
  owner.memoryPolicy.grants = [];
  store.save(owner);
  assert.equal(reference.isCurrent(), false);
  assert.equal(scopedMemorySegment(store, owner, reference.candidate.id), undefined);
});

test("assigning an existing Chat as a worker does not authorize its unrelated private history", t => {
  const { store, owner } = fixture(t);
  const existing = store.create();
  existing.messages.push({ id:randomUUID(), role:"user", status:"complete", content:"PRIVATE research archive" });
  const treeId = owner.workerState.treeId;
  const [slot] = store.workerTrees.reserve(treeId, owner.id, ["Existing Chat"], workerLimits(10, 10), undefined, [existing.id]);
  existing.workerActivity = { id:randomUUID(), treeId, managerChatId:owner.id, receiptId:slot.receiptId, temporary:false, state:"completed" };
  store.save(existing);
  assert(!store.memorySourceIds(owner).includes(existing.id));
  assert.equal(recallScopedChatMemory(store, owner, "research").references.length, 0);
  owner.memoryPolicy = { ...memoryPolicy(owner), grants:[{ kind:"chat", id:existing.id, chatIds:[existing.id] }] };
  store.save(owner);
  assert.equal(recallScopedChatMemory(store, owner, "research").references.length, 1);
});

test("resolved spawned-worker archives remain recallable without resetting evidence age or deleting originals", t => {
  const { store, owner, addWorker } = fixture(t);
  const worker = addWorker(owner, "archived");
  const { treeId, receiptId } = worker.workerState;
  worker.workerActivity = { id:randomUUID(), managerChatId:owner.id, treeId, receiptId, temporary:true, state:"completed" };
  store.save(worker);
  const reference = recallScopedChatMemory(store, owner, "research").references[0];
  store.archiveWorker(worker, { id:receiptId, chatId:worker.id, chatUrl:`pkm://chats/${store.namespace}/${worker.id}`, status:"complete" });
  store.workerTrees.release(treeId, receiptId);
  assert(reference.isCurrent());
  assert.equal(recallScopedChatMemory(store, owner, "research").references.length, 1);
  assert.equal(store.workerResult(receiptId).chat.messages[0].recordedAt, worker.messages[0].recordedAt);
  owner.memoryPolicy = { ...memoryPolicy(owner), clearedAt:Date.now() };
  store.save(owner);
  assert.equal(reference.isCurrent(), false);
  assert.equal(recallScopedChatMemory(store, owner, "research").references.length, 0);
  assert(store.hasWorkerResult(receiptId));
  assert.equal(store.workerResult(receiptId).chat.messages[0].content, worker.messages[0].content);
});

test("History off, exclusions, Trash and changed source bytes invalidate prepared worker evidence", t => {
  const { store, owner, addWorker } = fixture(t);
  const worker = addWorker(owner, "worker");
  const get = () => recallScopedChatMemory(store, owner, "research").references[0];
  const original = get();
  worker.messages[0].content = "research corrected; NOT verified";
  store.save(worker);
  assert.equal(original.isCurrent(), false);
  let reference = get();
  worker.includeHistory = false;
  store.save(worker);
  assert.equal(reference.isCurrent(), false);
  assert.equal(recallScopedChatMemory(store, owner, "research").references.length, 0);
  worker.includeHistory = true;
  store.save(worker);
  reference = get();
  owner.memoryPolicy = { ...memoryPolicy(owner), excludedChatIds:[worker.id] };
  store.save(owner);
  assert.equal(reference.isCurrent(), false);
  owner.memoryPolicy.excludedChatIds = [];
  store.save(owner);
  reference = get();
  store.library.trash(worker.id);
  assert.equal(reference.isCurrent(), false);
  store.library.restore(worker.id);
  reference = get();
  owner.includeHistory = false;
  store.save(owner);
  assert.equal(reference.isCurrent(), false);
  assert.deepEqual(recallScopedChatMemory(store, owner, "research").references, []);
});

test("30-day boundary, expansion and clear only affect derived recall, never original history", t => {
  const { store, owner } = fixture(t);
  const now = Date.now(), cutoff = now - 30 * 86400000;
  assert(memoryAgeAllows(owner, cutoff, now));
  assert.equal(memoryAgeAllows(owner, cutoff - 1, now), false);
  assert.equal(memoryAgeAllows(owner, NaN, now), false);
  const old = { id:randomUUID(), role:"assistant", status:"complete", content:"old research evidence",
    recordedAt:new Date(now - 31 * 86400000).toISOString() };
  owner.messages.push(old);
  store.save(owner);
  const raw = JSON.stringify(store.load(owner.id, false).messages);
  assert.equal(retrieveChatMemory(owner, "research").length, 0);
  assert.equal(recentChatDialogue(owner).length, 0);
  const receipt = chatRetrievalReceipt(owner, "research", "fixture");
  assert(receipt.candidates.some(item => item.reason.includes("30-day") && !item.selected));
  owner.memoryPolicy = { ...memoryPolicy(owner), recallDays:90 };
  store.save(owner);
  assert.equal(retrieveChatMemory(owner, "research").length, 1);
  owner.memoryPolicy.clearedAt = now;
  store.save(owner);
  assert.equal(retrieveChatMemory(owner, "research").length, 0);
  assert.equal(JSON.stringify(store.load(owner.id, false).messages), raw);
  assert(validMemoryPolicy(owner.memoryPolicy));
  assert.equal(validMemoryPolicy({ ...owner.memoryPolicy, recallDays:0 }), false);
  assert.equal(validMemoryPolicy({ ...owner.memoryPolicy, grants:[{ kind:"chat", id:"bad", chatIds:["../escape"] }] }), false);
});
