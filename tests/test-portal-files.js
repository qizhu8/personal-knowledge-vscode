const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { randomBytes, createHash, randomUUID } = require("node:crypto");
const {
  PortalFiles, preparePortalBatch, validatePortalManifest, assertSafePortalFileName, PORTAL_FILE_KIND,
} = require("../dist/chatroom/portal-files");
const { MAX_PEER_BYTES } = require("../dist/chatroom/peer-protocol");

const sha = bytes => createHash("sha256").update(bytes).digest("hex");
function tempDir(t, name) {
  const dir = fs.mkdtempSync(path.join(__dirname, `.portal-files-${name}-`));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return fs.realpathSync(dir);
}
function writeFile(dir, name, bytes) { const file = path.join(dir, name); fs.writeFileSync(file, bytes); return file; }

/** Two engines linked by an ordered async in-memory transport. */
function link({ a = {}, b = {}, tamper } = {}) {
  const wire = [];
  const errors = [];
  const make = (side, opts) => {
    let chain = Promise.resolve();
    const statuses = [];
    const approvals = [];
    const engine = new PortalFiles({
      controlled: false,
      destination: undefined,
      approve: async request => { approvals.push(request); return true; },
      onStatus: s => statuses.push(s),
      ...opts,
      send: payload => {
        const size = Buffer.byteLength(JSON.stringify({ protocol: "pkm.peer/v1", operation: "task", pairId: randomUUID(), requestId: randomUUID(), payload }));
        assert.ok(size < MAX_PEER_BYTES, `payload ${size} exceeds peer limit`);
        wire.push({ from: side, payload });
        const delivered = tamper ? tamper(payload, side) : payload;
        if (delivered === null) return;
        chain = chain.then(() => new Promise(r => setImmediate(r)))
          .then(() => (side === "a" ? pair.b : pair.a).handle(JSON.parse(JSON.stringify(delivered))))
          .catch(error => errors.push(error));
        return chain;
      },
    });
    engine.statuses = statuses; engine.approvals = approvals;
    return engine;
  };
  const pair = { wire, errors };
  pair.a = make("a", a);
  pair.b = make("b", b);
  return pair;
}
async function until(predicate, ms = 5000) {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for condition.");
    await new Promise(r => setTimeout(r, 5));
  }
}
const ops = (wire, side) => wire.filter(w => !side || w.from === side).map(w => w.payload.op);
const visible = dir => fs.readdirSync(dir).sort();
const lastState = engine => engine.statuses.at(-1)?.state;

test("controller uploads to controlled peer after the controlled receiver approves", async t => {
  const src = tempDir(t, "src"); const dst = tempDir(t, "dst");
  const big = randomBytes(70 * 1024 + 13);
  const files = [writeFile(src, "data.bin", big), writeFile(src, "empty.txt", ""), writeFile(src, "notes ü.md", "hello")];
  const pair = link({ b: { controlled: true, destination: dst } });
  const { done } = await pair.a.offer(files);
  const result = await done;
  assert.equal(result.state, "completed");
  await until(() => lastState(pair.b) === "completed");
  assert.equal(pair.b.approvals.length, 1);
  const request = pair.b.approvals[0];
  assert.equal(request.direction, "incoming");
  assert.equal(request.destination, dst);
  assert.deepEqual(request.files.map(f => [f.name, f.size, f.sha256]), [["data.bin", big.length, sha(big)], ["empty.txt", 0, sha(Buffer.alloc(0))], ["notes ü.md", 5, sha(Buffer.from("hello"))]]);
  assert.equal(pair.a.approvals.length, 0, "non-controlled sender is not prompted");
  assert.deepEqual(visible(dst), ["data.bin", "empty.txt", "notes ü.md"], "no temporary files remain");
  assert.ok(fs.readFileSync(path.join(dst, "data.bin")).equals(big));
  const chunks = pair.wire.filter(w => w.payload.op === "chunk");
  assert.ok(chunks.length >= 4);
  assert.ok(chunks.every(c => c.payload.data.length <= 24 * 1024));
  assert.deepEqual(pair.b.statuses.at(-1).savedPaths, files.map(f => path.join(dst, path.basename(f))));
  assert.deepEqual(pair.errors, []);
});

test("incoming batch publishes awaiting approval before the destination picker resolves", async t => {
  const src = tempDir(t, "trace-src");
  let release;
  const selection = new Promise(resolve => { release = resolve; });
  const pair = link({ b: { controlled: true, destination: () => selection } });
  t.after(() => { pair.a.dispose(); pair.b.dispose(); });
  const offered = pair.a.offer([writeFile(src, "test.txt", "trace")]);
  await until(() => pair.b.statuses.length > 0);
  assert.equal(lastState(pair.a), "offered");
  assert.equal(lastState(pair.b), "awaiting-approval");
  assert.equal(pair.b.statuses[0].files[0].name, "test.txt");
  assert.equal(pair.wire.some(item => item.payload.op === "chunk"), false);
  release(undefined);
  assert.equal((await (await offered).done).state, "cancelled");
  assert.match(pair.b.statuses.at(-1).reason, /No destination chosen/);
});

test("controlled sender approves before publishing anything, then controller receiver chooses destination", async t => {
  const src = tempDir(t, "src"); const dst = tempDir(t, "dst");
  const bytes = randomBytes(30000);
  const file = writeFile(src, "report.pdf", bytes);
  let wireAtApproval;
  const pair = link({
    a: { controlled: true, approve: async request => { wireAtApproval = pair.wire.length; pair.a.approvals.push(request); return true; } },
    b: { controlled: false, destination: async manifest => { assert.equal(manifest.files[0].name, "report.pdf"); return dst; } },
  });
  const result = await (await pair.a.offer([file])).done;
  assert.equal(result.state, "completed");
  assert.equal(wireAtApproval, 0, "controlled sender approval happens before the manifest is sent");
  assert.equal(pair.a.approvals[0].direction, "outgoing");
  assert.deepEqual(pair.a.approvals[0].sources, [file]);
  assert.equal(pair.b.approvals[0].direction, "incoming");
  assert.ok(fs.readFileSync(path.join(dst, "report.pdf")).equals(bytes));
});

test("controlled sender denial publishes neither manifest nor content", async t => {
  const src = tempDir(t, "src"); const dst = tempDir(t, "dst");
  const pair = link({ a: { controlled: true, approve: async () => false }, b: { destination: dst } });
  const result = await (await pair.a.offer([writeFile(src, "secret.txt", "secret")])).done;
  assert.equal(result.state, "cancelled");
  assert.deepEqual(pair.wire, []);
  assert.deepEqual(visible(dst), []);
});

test("truthy non-boolean approval is not consent", async t => {
  const src = tempDir(t, "src");
  const pair = link({ a: { controlled: true, approve: async () => "yes" } });
  const result = await (await pair.a.offer([writeFile(src, "a.txt", "x")])).done;
  assert.equal(result.state, "cancelled");
  assert.deepEqual(pair.wire, []);
});

test("receiver denial sends no file content and creates no files", async t => {
  const src = tempDir(t, "src"); const dst = tempDir(t, "dst");
  const pair = link({ b: { controlled: true, destination: dst, approve: async () => false } });
  const result = await (await pair.a.offer([writeFile(src, "secret.txt", "top secret content")])).done;
  assert.equal(result.state, "cancelled");
  assert.deepEqual(ops(pair.wire), ["manifest", "cancel"]);
  assert.ok(!JSON.stringify(pair.wire).includes(Buffer.from("top secret content").toString("base64")));
  assert.deepEqual(visible(dst), []);
});

test("chunks before approval are ignored and create nothing", async t => {
  const dst = tempDir(t, "dst");
  let release;
  const sent = [];
  const engine = new PortalFiles({ controlled: true, destination: dst, send: p => { sent.push(p); }, approve: () => new Promise(r => { release = r; }) });
  const transferId = randomUUID();
  const data = Buffer.from("abc");
  const pending = engine.handle({ kind: PORTAL_FILE_KIND, op: "manifest", transferId, files: [{ name: "a.txt", size: 3, sha256: sha(data) }], totalBytes: 3 });
  await until(() => release);
  await engine.handle({ kind: PORTAL_FILE_KIND, op: "chunk", transferId, index: 0, offset: 0, data: data.toString("base64") });
  assert.deepEqual(visible(dst), []);
  release(false);
  await pending;
  await until(() => sent.length);
  assert.deepEqual(sent.map(p => p.op), ["cancel"]);
  assert.deepEqual(visible(dst), []);
});

test("source changed after approval is never sent", async t => {
  const src = tempDir(t, "src"); const dst = tempDir(t, "dst");
  const original = Buffer.from("approved bytes!!");
  const file = writeFile(src, "doc.txt", original);
  const pair = link({ b: { destination: dst, approve: async () => {
    fs.writeFileSync(file, "CHANGED bytes!!!"); // same size
    const later = new Date(Date.now() + 5000); fs.utimesSync(file, later, later);
    return true;
  } } });
  const result = await (await pair.a.offer([file])).done;
  assert.equal(result.state, "failed");
  assert.match(result.reason, /changed after approval/);
  assert.ok(!ops(pair.wire).includes("chunk"));
  await until(() => lastState(pair.b) === "cancelled");
  assert.deepEqual(visible(dst), []);
});

test("same-size, same-mtime content changes are caught by the digest", async t => {
  const src = tempDir(t, "src"); const dst = tempDir(t, "dst");
  const file = writeFile(src, "doc.txt", "aaaa");
  const stat = fs.statSync(file);
  const pair = link({ b: { destination: dst, approve: async () => {
    fs.writeFileSync(file, "bbbb"); fs.utimesSync(file, stat.atime, stat.mtime); return true;
  } } });
  const result = await (await pair.a.offer([file])).done;
  assert.equal(result.state, "failed");
  assert.ok(!ops(pair.wire).includes("chunk"));
  await until(() => lastState(pair.b) === "cancelled");
  assert.deepEqual(visible(dst), []);
});

test("tampered chunk fails digest verification and cleans partial receipt", async t => {
  const src = tempDir(t, "src"); const dst = tempDir(t, "dst");
  const bytes = randomBytes(40000);
  const tamper = payload => {
    if (payload.op !== "chunk" || payload.offset !== 0) return payload;
    const data = Buffer.from(payload.data, "base64"); data[10] ^= 0xff;
    return { ...payload, data: data.toString("base64") };
  };
  const pair = link({ b: { destination: dst }, tamper });
  const result = await (await pair.a.offer([writeFile(src, "x.bin", bytes)])).done;
  assert.notEqual(result.state, "completed");
  await until(() => lastState(pair.b) === "failed");
  assert.match(pair.b.statuses.at(-1).reason, /Digest mismatch/);
  assert.deepEqual(visible(dst), []);
});

async function receiver(t, size = 40000) {
  const dst = tempDir(t, "dst");
  const sent = [];
  const statuses = [];
  const engine = new PortalFiles({ controlled: true, destination: dst, approve: async () => true, send: p => { sent.push(p); }, onStatus: s => statuses.push(s) });
  const transferId = randomUUID();
  const bytes = randomBytes(size);
  await engine.handle({ kind: PORTAL_FILE_KIND, op: "manifest", transferId, files: [{ name: "f.bin", size, sha256: sha(bytes) }], totalBytes: size });
  assert.equal(sent.at(-1).op, "approved");
  assert.equal(visible(dst).length, 1, "one exclusive temp file");
  const chunk = (offset, len = 18 * 1024, extra = {}) => ({ kind: PORTAL_FILE_KIND, op: "chunk", transferId, index: 0, offset, data: bytes.subarray(offset, offset + len).toString("base64"), ...extra });
  return { engine, dst, sent, statuses, transferId, bytes, chunk };
}

for (const [label, mutate] of [
  ["duplicate chunk", (r) => [r.chunk(0), r.chunk(0)]],
  ["skipped offset", (r) => [r.chunk(18 * 1024)]],
  ["wrong file index", (r) => [r.chunk(0, 18 * 1024, { index: 1 })]],
  ["non-base64 data", (r) => [r.chunk(0, 18 * 1024, { data: "!!!notbase64" })]],
  ["non-canonical base64", (r) => [r.chunk(0, 18 * 1024, { data: "QQ=a" })]],
  ["oversized chunk", (r) => [r.chunk(0, 18 * 1024, { data: randomBytes(30 * 1024).toString("base64") })]],
  ["empty data", (r) => [r.chunk(0, 18 * 1024, { data: "" })]],
  ["bytes beyond approved size", (r) => [r.chunk(0), r.chunk(18 * 1024), r.chunk(36 * 1024, 18 * 1024, { data: randomBytes(18 * 1024).toString("base64") })]],
  ["premature complete", (r) => [r.chunk(0), { kind: PORTAL_FILE_KIND, op: "complete", transferId: r.transferId }]],
  ["unknown op", (r) => [{ kind: PORTAL_FILE_KIND, op: "exec", transferId: r.transferId }]],
]) {
  test(`malformed input rejected and cleaned: ${label}`, async t => {
    const r = await receiver(t);
    for (const payload of mutate(r)) await r.engine.handle(payload);
    assert.equal(r.statuses.at(-1).state, "failed");
    await until(() => r.sent.at(-1).op === "cancel");
    assert.deepEqual(visible(r.dst), []);
  });
}

test("payloads without a valid transfer id throw for the parent to log", async () => {
  const engine = new PortalFiles({ controlled: true, destination: "/", approve: async () => true, send() {} });
  await assert.rejects(engine.handle({ kind: PORTAL_FILE_KIND, op: "chunk", transferId: "../x" }));
  await assert.rejects(engine.handle(null));
});

test("cancellation removes exactly this transfer's temporary files", async t => {
  const r = await receiver(t);
  const bystander = path.join(r.dst, `.pkm-part-${randomUUID()}-0`);
  fs.writeFileSync(bystander, "not ours");
  await r.engine.handle(r.chunk(0));
  await r.engine.handle({ kind: PORTAL_FILE_KIND, op: "cancel", transferId: r.transferId, reason: "stop" });
  assert.equal(r.statuses.at(-1).state, "cancelled");
  assert.deepEqual(visible(r.dst), [path.basename(bystander)]);
  assert.ok(!r.sent.some(p => p.op === "cancel"), "remote cancel is not echoed");
});

test("local cancel mid-transfer stops sender and cleans receiver", async t => {
  const src = tempDir(t, "src"); const dst = tempDir(t, "dst");
  let pair;
  let chunks = 0;
  pair = link({ b: { destination: dst }, tamper: (payload, side) => {
    if (payload.op === "chunk" && ++chunks === 2) pair.b.cancel(payload.transferId, "user stopped");
    return payload;
  } });
  const result = await (await pair.a.offer([writeFile(src, "big.bin", randomBytes(200 * 1024))])).done;
  assert.equal(result.state, "cancelled");
  await until(() => lastState(pair.b) === "cancelled");
  await new Promise(r => setTimeout(r, 50));
  assert.ok(ops(pair.wire, "a").filter(op => op === "chunk").length < 12);
  assert.deepEqual(visible(dst), []);
});

test("dispose cancels pending transfers and cleans temps", async t => {
  const r = await receiver(t);
  await r.engine.handle(r.chunk(0));
  r.engine.dispose();
  assert.deepEqual(visible(r.dst), []);
  await until(() => r.sent.at(-1).op === "cancel");
});

test("existing targets and symlinks are never overwritten", async t => {
  const src = tempDir(t, "src"); const dst = tempDir(t, "dst"); const outside = tempDir(t, "outside");
  fs.writeFileSync(path.join(dst, "keep.txt"), "original");
  fs.symlinkSync(path.join(outside, "victim.txt"), path.join(dst, "link.txt"));
  for (const name of ["keep.txt", "link.txt"]) {
    const pair = link({ b: { destination: dst } });
    const result = await (await pair.a.offer([writeFile(src, name, "attack")])).done;
    assert.equal(result.state, "cancelled");
    assert.equal(pair.b.approvals.length, 0, "conflicts fail before prompting");
    assert.ok(!ops(pair.wire).includes("chunk"));
  }
  assert.equal(fs.readFileSync(path.join(dst, "keep.txt"), "utf8"), "original");
  assert.deepEqual(visible(outside), []);
  assert.deepEqual(visible(dst), ["keep.txt", "link.txt"]);
});

test("target created during transfer is not overwritten", async t => {
  const src = tempDir(t, "src"); const dst = tempDir(t, "dst");
  const pair = link({ b: { destination: dst }, tamper: payload => {
    if (payload.op === "complete" && !fs.existsSync(path.join(dst, "race.txt"))) fs.writeFileSync(path.join(dst, "race.txt"), "racer");
    return payload;
  } });
  const result = await (await pair.a.offer([writeFile(src, "race.txt", "incoming")])).done;
  assert.notEqual(result.state, "completed");
  assert.equal(fs.readFileSync(path.join(dst, "race.txt"), "utf8"), "racer");
  assert.deepEqual(visible(dst), ["race.txt"]);
});

test("file name safety and manifest validation", () => {
  for (const bad of ["", ".", "..", "../x", "a/b", "a\\b", "x\u0000", "CON", "lpt1.txt", "trail.", "trail ", "a:b", "x".repeat(256), "e\u0301"]) {
    assert.throws(() => assertSafePortalFileName(bad), undefined, JSON.stringify(bad));
  }
  for (const good of ["a.txt", ".env", "résumé.pdf", "file (1).tar.gz"]) assert.equal(assertSafePortalFileName(good), good);
  const id = randomUUID();
  const f = (name, size = 1) => ({ name, size, sha256: "a".repeat(64) });
  const ok = { transferId: id, files: [f("a"), f("b", 2)], totalBytes: 3 };
  assert.deepEqual(validatePortalManifest(ok).files.length, 2);
  for (const bad of [
    { ...ok, transferId: "nope" },
    { ...ok, files: [] },
    { ...ok, files: [f("A"), f("a", 2)] },
    { ...ok, totalBytes: 4 },
    { ...ok, files: [f("a", -1), f("b", 4)] },
    { ...ok, files: [{ name: "a", size: 1, sha256: "zz" }, f("b", 2)] },
    { ...ok, files: [f("../a"), f("b", 2)] },
  ]) assert.throws(() => validatePortalManifest(bad));
  assert.throws(() => validatePortalManifest(ok, { maxFiles: 1 }));
  assert.throws(() => validatePortalManifest(ok, { maxBatchBytes: 2 }));
  assert.throws(() => validatePortalManifest(ok, { maxFileBytes: 1 }));
});

test("receiver rejects manifests over its own limits without prompting", async () => {
  const sent = []; const approvals = [];
  const engine = new PortalFiles({ controlled: true, destination: __dirname, limits: { maxBatchBytes: 10 }, approve: async r => { approvals.push(r); return true; }, send: p => { sent.push(p); } });
  await engine.handle({ kind: PORTAL_FILE_KIND, op: "manifest", transferId: randomUUID(), files: [{ name: "a", size: 11, sha256: "a".repeat(64) }], totalBytes: 11 });
  await until(() => sent.length);
  assert.equal(sent[0].op, "cancel");
  assert.equal(approvals.length, 0);
});

test("preparePortalBatch rejects symlinks, directories, relative paths and oversize batches", async t => {
  const src = tempDir(t, "src");
  const real = writeFile(src, "real.txt", "12345");
  fs.symlinkSync(real, path.join(src, "link.txt"));
  await assert.rejects(preparePortalBatch([path.join(src, "link.txt")]), /regular file/);
  await assert.rejects(preparePortalBatch([src]), /regular file/);
  await assert.rejects(preparePortalBatch(["real.txt"]), /absolute/);
  await assert.rejects(preparePortalBatch([real, writeFile(src, "b.txt", "123456")], { maxBatchBytes: 10 }), /limit/);
  await assert.rejects(preparePortalBatch([real, path.join(tempDir(t, "other"), "real.txt")].map((p, i) => i ? (fs.writeFileSync(p, "x"), p) : p)), /Duplicate/);
  const batch = await preparePortalBatch([real]);
  assert.deepEqual(batch.files.map(f => [f.name, f.size, f.sha256]), [["real.txt", 5, sha(Buffer.from("12345"))]]);
});

test("controlled may be a function evaluated per offer", async t => {
  const src = tempDir(t, "src"); const dst = tempDir(t, "dst");
  let controlled = false;
  const pair = link({ a: { controlled: () => controlled, approve: async r => { pair.a.approvals.push(r); return false; } }, b: { destination: dst } });
  assert.equal((await (await pair.a.offer([writeFile(src, "one.txt", "1")])).done).state, "completed");
  assert.equal(pair.a.approvals.length, 0);
  controlled = true;
  assert.equal((await (await pair.a.offer([writeFile(src, "two.txt", "2")])).done).state, "cancelled");
  assert.equal(pair.a.approvals.length, 1);
  assert.deepEqual(visible(dst), ["one.txt"]);
});

test("pending unapproved incoming transfer times out, cancels peer, and ignores late approval", async t => {
  const dst = tempDir(t, "dst");
  const sent = []; const statuses = [];
  let release;
  const engine = new PortalFiles({ controlled: true, destination: dst, timeoutMs: 40, send: p => { sent.push(p); }, onStatus: s => statuses.push(s),
    approve: () => new Promise(r => { release = r; }) });
  const transferId = randomUUID();
  const pending = engine.handle({ kind: PORTAL_FILE_KIND, op: "manifest", transferId, files: [{ name: "a.txt", size: 1, sha256: sha(Buffer.from("a")) }], totalBytes: 1 });
  await until(() => statuses.at(-1)?.state === "cancelled");
  assert.match(statuses.at(-1).reason, /timed out/);
  await until(() => sent.length);
  release(true);
  await pending;
  assert.deepEqual(sent.map(p => p.op), ["cancel"]);
  assert.deepEqual(visible(dst), []);
});

test("unapproved outgoing offer times out with no bytes sent", async t => {
  const src = tempDir(t, "src");
  const sent = [];
  const engine = new PortalFiles({ controlled: false, destination: src, timeoutMs: 40, approve: async () => true, send: p => { sent.push(p); } });
  const keepAlive = setInterval(() => {}, 10); // engine timers are unref'd
  const result = await (await engine.offer([writeFile(src, "a.txt", "abc")])).done;
  clearInterval(keepAlive);
  assert.equal(result.state, "cancelled");
  assert.match(result.reason, /timed out/);
  assert.deepEqual(sent.map(p => p.op), ["manifest", "cancel"]);
});

test("stalled incoming transfer times out and removes partial temps", async t => {
  const dst = tempDir(t, "dst");
  const sent = []; const statuses = [];
  const engine = new PortalFiles({ controlled: true, destination: dst, timeoutMs: 60, approve: async () => true, send: p => { sent.push(p); }, onStatus: s => statuses.push(s) });
  const transferId = randomUUID();
  const bytes = randomBytes(40000);
  await engine.handle({ kind: PORTAL_FILE_KIND, op: "manifest", transferId, files: [{ name: "f.bin", size: bytes.length, sha256: sha(bytes) }], totalBytes: bytes.length });
  await engine.handle({ kind: PORTAL_FILE_KIND, op: "chunk", transferId, index: 0, offset: 0, data: bytes.subarray(0, 18 * 1024).toString("base64") });
  assert.equal(visible(dst).length, 1);
  await until(() => statuses.at(-1).state === "cancelled");
  assert.deepEqual(visible(dst), []);
  await until(() => sent.at(-1).op === "cancel");
});

test("invalid timeout is rejected", () => {
  assert.throws(() => new PortalFiles({ controlled: true, destination: "/", timeoutMs: 0, approve: async () => true, send() {} }), /timeout/);
});

test("destination swapped for a symlink before finalize is rejected without writing outside", async t => {
  const src = tempDir(t, "src"); const root = tempDir(t, "root"); const outside = tempDir(t, "outside");
  const dst = path.join(root, "inbox"); fs.mkdirSync(dst);
  const moved = path.join(root, "moved");
  const pair = link({ b: { destination: dst }, tamper: payload => {
    if (payload.op === "complete" && !fs.existsSync(moved)) { fs.renameSync(dst, moved); fs.symlinkSync(outside, dst); }
    return payload;
  } });
  const result = await (await pair.a.offer([writeFile(src, "payload.txt", "data")])).done;
  assert.notEqual(result.state, "completed");
  await until(() => lastState(pair.b) === "failed");
  assert.match(pair.b.statuses.at(-1).reason, /destination changed/);
  assert.deepEqual(visible(outside), []);
  assert.ok(!visible(moved).includes("payload.txt"));
});

test("destination swapped mid-transfer stops further chunk writes", async t => {
  const src = tempDir(t, "src"); const root = tempDir(t, "root"); const outside = tempDir(t, "outside");
  const dst = path.join(root, "inbox"); fs.mkdirSync(dst);
  let chunks = 0;
  const pair = link({ b: { destination: dst }, tamper: payload => {
    if (payload.op === "chunk" && ++chunks === 2) { fs.renameSync(dst, path.join(root, "moved")); fs.mkdirSync(dst); }
    return payload;
  } });
  const result = await (await pair.a.offer([writeFile(src, "big.bin", randomBytes(100 * 1024))])).done;
  assert.notEqual(result.state, "completed");
  await until(() => lastState(pair.b) === "failed");
  assert.match(pair.b.statuses.at(-1).reason, /destination changed/);
  assert.deepEqual(visible(dst), []);
  assert.deepEqual(visible(outside), []);
});

test("statuses expose expected metadata before completion and verifiedFiles only after verified receipt", async t => {
  const src = tempDir(t, "src"); const dst = tempDir(t, "dst");
  const a = randomBytes(50000); const b = Buffer.from("bee");
  const paths = [writeFile(src, "a.bin", a), writeFile(src, "b.txt", b)];
  const expected = [{ name: "a.bin", size: a.length, sha256: sha(a) }, { name: "b.txt", size: 3, sha256: sha(b) }];
  let senderCompletedBeforeAck = false;
  const pair = link({ b: { destination: dst }, tamper: (payload, side) => {
    if (side === "b" && payload.op === "complete") senderCompletedBeforeAck = pair.a.statuses.some(s => s.state === "completed");
    return payload;
  } });
  const result = await (await pair.a.offer(paths)).done;
  await until(() => lastState(pair.b) === "completed");
  assert.equal(senderCompletedBeforeAck, false);
  assert.deepEqual(result.files, expected);
  assert.deepEqual(result.verifiedFiles, expected);
  for (const engine of [pair.a, pair.b]) {
    const pending = engine.statuses.filter(s => s.state !== "completed");
    assert.ok(pending.length > 0);
    for (const s of pending) { assert.deepEqual(s.files, expected); assert.equal(s.verifiedFiles, undefined); }
    const done = engine.statuses.filter(s => s.state === "completed");
    assert.equal(done.length, 1);
    assert.deepEqual(done[0].files, expected);
    assert.deepEqual(done[0].verifiedFiles, expected);
    assert.ok(!JSON.stringify(engine.statuses).includes(src), "no source paths in statuses");
  }
  const ack = pair.wire.find(w => w.from === "b" && w.payload.op === "complete").payload;
  assert.deepEqual(ack.files, expected);
  assert.equal(ack.totalBytes, a.length + 3);
  assert.equal(pair.wire.find(w => w.from === "a" && w.payload.op === "complete").payload.files, undefined);
});

for (const [label, edit] of [
  ["wrong digest", ack => ({ ...ack, files: ack.files.map(f => ({ ...f, sha256: "0".repeat(64) })) })],
  ["missing metadata", ({ files, totalBytes, ...rest }) => rest],
  ["wrong total", ack => ({ ...ack, totalBytes: ack.totalBytes + 1 })],
]) {
  test(`sender rejects receiver acknowledgement with ${label}`, async t => {
    const src = tempDir(t, "src"); const dst = tempDir(t, "dst");
    const pair = link({ b: { destination: dst }, tamper: (payload, side) => side === "b" && payload.op === "complete" ? edit(payload) : payload });
    const result = await (await pair.a.offer([writeFile(src, "x.txt", "xyz")])).done;
    assert.equal(result.state, "failed");
    assert.match(result.reason, /acknowledgement/);
    assert.equal(result.verifiedFiles, undefined);
    assert.ok(pair.a.statuses.every(s => s.verifiedFiles === undefined && s.state !== "completed"));
  });
}

test("failed and cancelled statuses never carry verifiedFiles", async t => {
  const r = await receiver(t);
  await r.engine.handle(r.chunk(0));
  await r.engine.handle(r.chunk(0));
  assert.equal(r.statuses.at(-1).state, "failed");
  assert.equal(r.statuses.at(-1).files.length, 1);
  assert.ok(r.statuses.every(s => s.verifiedFiles === undefined));
});

test("max-file batch with long names keeps manifest and acknowledgement under the peer limit", async t => {
  const src = tempDir(t, "src"); const dst = tempDir(t, "dst");
  const paths = Array.from({ length: 64 }, (_, i) => writeFile(src, `${"n".repeat(240)}${String(i).padStart(2, "0")}.txt`, `file ${i}`));
  const pair = link({ b: { destination: dst } });
  const result = await (await pair.a.offer(paths)).done;
  assert.equal(result.state, "completed");
  assert.equal(result.verifiedFiles.length, 64);
  assert.equal(visible(dst).length, 64);
});
