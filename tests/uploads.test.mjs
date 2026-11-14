import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile, readFile, readdir, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { initialize, Storage } from "../dist/storage.js";
import { Core } from "../dist/core.js";
import { sha256 } from "../dist/file-write.js";
import { encodeMarkdown } from "../dist/markdown.js";

const owner = { id: "local:owner", canWrite: true };
const digest = bytes => `sha256:${sha256(bytes)}`;
async function fixture(t) {
  const parent = join(dirname(fileURLToPath(import.meta.url)), `.uploads-${randomUUID()}`);
  const directory = join(parent, "workspace"), stores = [];
  await mkdir(parent, { recursive: true });
  await initialize(directory);
  t.after(async () => { try { for (const storage of stores) await storage.close(); } finally { await rm(parent, { recursive: true, force: true }); } });
  async function open() {
    const storage = await Storage.open(directory); stores.push(storage);
    const core = new Core(storage);
    const dispatch = (method, operation, args, actor = owner) => core.dispatch(method, { operation, version: 1, arguments: args }, actor);
    const write = (operation, args, actor) => dispatch("capability_call", operation, args, actor);
    const read = (operation, args, actor) => dispatch("capability_read", operation, args, actor);
    async function create(area = "notes") {
      const result = await write("knowledge.document.create", {
        operationId: randomUUID(), id: `${area}-upload-doc`, area, path: "Team/Doc.md", title: area, content: "Authoritative body",
      });
      assert(!result.error, JSON.stringify(result.error)); return result.result;
    }
    async function begin(document, bytes, name = "image.bin", actor = owner, overrides = {}) {
      const args = { operationId: randomUUID(), id: document.id, expectedRevision: document.revision, expectedSha256: document.sha256, name, size: bytes.length, digest: digest(bytes), ...overrides };
      const result = await write("knowledge.upload.begin", args, actor);
      assert(!result.error, JSON.stringify(result.error)); return { args, upload: result.result };
    }
    async function append(upload, bytes, offset = 0, actor = owner) {
      const args = { operationId: randomUUID(), uploadId: upload.uploadId, offset, data: bytes.toString("base64") };
      const result = await write("knowledge.upload.append", args, actor);
      assert(!result.error, JSON.stringify(result.error)); return { args, upload: result.result };
    }
    return { storage, core, read, write, create, begin, append };
  }
  return { directory, open };
}

for (const area of ["notes", "skills", "papers"]) {
  test(`${area} upload survives reconnect, appends exact chunks and commits once without editing Markdown`, async t => {
    const { directory, open } = await fixture(t);
    const first = await open(), document = await first.create(area);
    const raw = await readFile(join(directory, area, document.path), "utf8"), bytes = Buffer.alloc(131_073, 173);
    const started = await first.begin(document, bytes, "plot(1)# one.bin");
    assert.deepEqual((await first.write("knowledge.upload.begin", started.args)).result, started.upload);
    const one = await first.append(started.upload, bytes.subarray(0, 65_536));
    await first.append(started.upload, bytes.subarray(65_536, 131_072), 65_536);
    assert.deepEqual((await first.write("knowledge.upload.append", one.args)).result, one.upload);
    assert.equal((await first.read("knowledge.upload.get", { uploadId: started.upload.uploadId })).result.receivedBytes, 131_072);
    await first.storage.close();
    const second = await open();
    await second.append(started.upload, bytes.subarray(131_072), 131_072);
    const args = { operationId: randomUUID(), uploadId: started.upload.uploadId };
    const committed = await second.write("knowledge.upload.commit", args);
    assert(!committed.error, JSON.stringify(committed.error));
    assert.equal(committed.result.status, "committed");
    assert.equal(committed.result.resource.uri, "Doc.assets/plot%281%29%23%20one.bin");
    const path = join(directory, area, committed.result.resource.path);
    assert.deepEqual(await readFile(path), bytes);
    assert.equal(await readFile(join(directory, area, document.path), "utf8"), raw);
    assert.equal((await second.read("knowledge.asset.list", { id: document.id })).result.items[0].digest, digest(bytes));
    await second.storage.close();
    const third = await open();
    assert.deepEqual((await third.write("knowledge.upload.commit", args)).result, committed.result);
    assert.deepEqual((await third.read("knowledge.upload.get", { uploadId: started.upload.uploadId })).result, committed.result);
    await writeFile(path, "Later external resource");
    assert.deepEqual((await third.write("knowledge.upload.commit", args)).result, committed.result);
    assert.equal(await readFile(path, "utf8"), "Later external resource");
    await third.storage.close();
    const check = new DatabaseSync(join(directory, "core.sqlite"));
    try {
      assert.equal(check.prepare("SELECT count(*) AS total FROM upload_chunks").get().total, 0);
      assert.equal(check.prepare("SELECT count(*) AS total FROM pending_asset").get().total, 0);
      assert.equal(check.prepare("PRAGMA user_version").get().user_version, 23);
    } finally { check.close(); }
  });
}

test("upload state and chunks are actor-bound, abort releases bytes and invalid chunks never advance progress", async t => {
  const { directory, open } = await fixture(t);
  const api = await open(), document = await api.create(), bytes = Buffer.from("data");
  const { upload } = await api.begin(document, bytes);
  const other = { id: "local:other", canWrite: true };
  assert.equal((await api.read("knowledge.upload.list", {})).result.items[0].uploadId, upload.uploadId);
  assert.equal((await api.read("knowledge.upload.list", {}, other)).result.total, 0);
  for (const operation of ["knowledge.upload.get", "knowledge.upload.append", "knowledge.upload.abort", "knowledge.upload.commit"]) {
    const args = operation.endsWith("get") ? { uploadId: upload.uploadId } : {
      operationId: randomUUID(), uploadId: upload.uploadId, ...(operation.endsWith("append") ? { offset: 0, data: bytes.toString("base64") } : {}),
    };
    assert.equal((await (operation.endsWith("get") ? api.read : api.write)(operation, args, other)).error.code, "ACCESS_DENIED");
  }
  for (const [data, offset, code] of [["a===", 0, "INVALID_ARGUMENT"], ["!!!!", 0, "INVALID_ARGUMENT"], [bytes.toString("base64"), 1, "CONFLICT"]]) {
    assert.equal((await api.write("knowledge.upload.append", { operationId: randomUUID(), uploadId: upload.uploadId, offset, data })).error.code, code);
  }
  assert.equal((await api.write("knowledge.upload.append", { operationId: randomUUID(), uploadId: upload.uploadId, offset: 0, data: Buffer.alloc(65_537).toString("base64") })).error.code, "INVALID_ARGUMENT");
  assert.equal((await api.write("knowledge.upload.commit", { operationId: randomUUID(), uploadId: upload.uploadId })).error.code, "CONFLICT");
  assert.equal((await api.read("knowledge.upload.get", { uploadId: upload.uploadId })).result.receivedBytes, 0);
  await api.append(upload, bytes);
  const abort = { operationId: randomUUID(), uploadId: upload.uploadId };
  const result = await api.write("knowledge.upload.abort", abort);
  assert.equal(result.result.status, "aborted");
  assert.equal((await api.read("knowledge.upload.list", {})).result.total, 0);
  assert.deepEqual((await api.write("knowledge.upload.abort", abort)).result, result.result);
  await assert.rejects(readdir(join(directory, "notes/Team/Doc.assets")), { code: "ENOENT" });
  await api.storage.close();
  const check = new DatabaseSync(join(directory, "core.sqlite"));
  try { assert.equal(check.prepare("SELECT count(*) AS total FROM upload_chunks").get().total, 0); }
  finally { check.close(); }
});

test("upload checksum and resource collision failures preserve original bytes and require explicit abort/restart", async t => {
  const { directory, open } = await fixture(t);
  const api = await open(), document = await api.create(), bytes = Buffer.from("payload");
  const bad = await api.begin(document, bytes, "wrong.bin", owner, { digest: `sha256:${"0".repeat(64)}` });
  await api.append(bad.upload, bytes);
  assert.equal((await api.write("knowledge.upload.commit", { operationId: randomUUID(), uploadId: bad.upload.uploadId })).error.code, "CONFLICT");
  await api.write("knowledge.upload.abort", { operationId: randomUUID(), uploadId: bad.upload.uploadId });
  await mkdir(join(directory, "notes/Team/Doc.assets"));
  await writeFile(join(directory, "notes/Team/Doc.assets/existing.bin"), "original");
  const conflicting = await api.begin(document, bytes, "existing.bin");
  await api.append(conflicting.upload, bytes);
  assert.equal((await api.write("knowledge.upload.commit", { operationId: randomUUID(), uploadId: conflicting.upload.uploadId })).error.code, "CONFLICT");
  assert.equal(await readFile(join(directory, "notes/Team/Doc.assets/existing.bin"), "utf8"), "original");
  const same = await api.begin(document, Buffer.from("original"), "existing.bin");
  await api.append(same.upload, Buffer.from("original"));
  assert.equal((await api.write("knowledge.upload.commit", { operationId: randomUUID(), uploadId: same.upload.uploadId })).result.status, "committed");
});

for (const change of ["edited", "moved", "trashed"]) {
  test(`upload commit refuses a document ${change} after reservation`, async t => {
    const { directory, open } = await fixture(t);
    const api = await open(), document = await api.create(), bytes = Buffer.from("payload");
    const { upload } = await api.begin(document, bytes); await api.append(upload, bytes);
    if (change === "moved") await rename(join(directory, "notes/Team/Doc.md"), join(directory, "notes/Team/Moved.md"));
    else await api.write(change === "edited" ? "knowledge.document.update" : "knowledge.document.trash", {
      operationId: randomUUID(), id: document.id, expectedRevision: document.revision, expectedSha256: document.sha256,
      ...(change === "edited" ? { title: "Changed", content: "New body" } : {}),
    });
    assert.equal((await api.write("knowledge.upload.commit", { operationId: randomUUID(), uploadId: upload.uploadId })).error.code, "CONFLICT");
    assert.equal((await api.write("knowledge.upload.abort", { operationId: randomUUID(), uploadId: upload.uploadId })).result.status, "aborted");
    await assert.rejects(readdir(join(directory, "notes/Team/Doc.assets")), { code: "ENOENT" });
  });
}

test("upload admission enforces 4 per actor, 8 globally and exactly 64 MiB reserved without allocating file data", async t => {
  const { open } = await fixture(t); const api = await open(), document = await api.create(), bytes = Buffer.from("x");
  const one = { id: "actor:one", canWrite: true }, two = { id: "actor:two", canWrite: true }, three = { id: "actor:three", canWrite: true };
  const reservations = [];
  for (const actor of [one, one, two, two]) reservations.push(await api.begin(document, bytes, randomUUID(), actor, { size: 16_777_216 }));
  const rejected = await api.write("knowledge.upload.begin", { ...reservations[0].args, operationId: randomUUID(), size: 1 }, three);
  assert.equal(rejected.error.code, "BUSY");
  for (let index = 0; index < reservations.length; index++) await api.write("knowledge.upload.abort", { operationId: randomUUID(), uploadId: reservations[index].upload.uploadId }, index < 2 ? one : two);
  const small = [];
  for (let index = 0; index < 4; index++) small.push(await api.begin(document, bytes, randomUUID(), one));
  assert.equal((await api.write("knowledge.upload.begin", { ...small[0].args, operationId: randomUUID() }, one)).error.code, "BUSY");
  for (let index = 0; index < 4; index++) small.push(await api.begin(document, bytes, randomUUID(), two));
  assert.equal((await api.write("knowledge.upload.begin", { ...small[0].args, operationId: randomUUID() }, three)).error.code, "BUSY");
});

test("upload begin rejects unsafe/reserved names, oversized reservations, read-only callers and System resources", async t => {
  const { directory, open } = await fixture(t);
  const api = await open(), document = await api.create(), bytes = Buffer.from("x");
  const base = { operationId: randomUUID(), id: document.id, expectedRevision: document.revision, expectedSha256: document.sha256, name: "image.bin", size: 1, digest: digest(bytes) };
  for (const change of [{ name: "../escape" }, { name: "CON.bin" }, { name: "\uD800.bin" }, { size: 16_777_217 }, { actorId: "spoof" }]) {
    assert.equal((await api.write("knowledge.upload.begin", { ...base, ...change })).error.code, "INVALID_ARGUMENT");
  }
  assert.equal((await api.write("knowledge.upload.begin", { ...base, name: "pkm-todo-board.json" })).error.code, "ACCESS_DENIED");
  assert.equal((await api.write("knowledge.upload.begin", base, { id: owner.id, canWrite: false })).error.code, "ACCESS_DENIED");
  await mkdir(join(directory, "notes/System"));
  await writeFile(join(directory, "notes/System/Protected.md"), encodeMarkdown("system", "System", "Protected", 1, false));
  const system = (await api.read("knowledge.document.get", { id: "system" })).result;
  assert.equal((await api.write("knowledge.upload.begin", { ...base, id: system.id, expectedRevision: system.revision, expectedSha256: system.sha256 })).error.code, "ACCESS_DENIED");
  await assert.rejects(readdir(join(directory, "notes/System/Protected.assets")), { code: "ENOENT" });
});

test("database v4 workspaces upgrade upload tables without rewriting their authoritative documents", async t => {
  const { directory, open } = await fixture(t);
  const first = await open(), document = await first.create();
  const raw = await readFile(join(directory, "notes", document.path), "utf8");
  await first.storage.close();
  const db = new DatabaseSync(join(directory, "core.sqlite"));
  try { db.exec("DROP TABLE upload_chunks; DROP TABLE pending_asset; DROP TABLE uploads; PRAGMA user_version=4;"); }
  finally { db.close(); }
  const next = await open(), bytes = Buffer.from("upgrade payload");
  const { upload } = await next.begin(document, bytes); await next.append(upload, bytes);
  assert.equal((await next.write("knowledge.upload.commit", { operationId: randomUUID(), uploadId: upload.uploadId })).result.status, "committed");
  assert.equal(await readFile(join(directory, "notes", document.path), "utf8"), raw);
});

test("single workspace owner commits only one competing upload to a resource", async t => {
  const { directory, open } = await fixture(t);
  const one = await open(), document = await one.create(), two = one;
  const a = Buffer.from("first bytes"), b = Buffer.from("second bytes");
  const uploadA = (await one.begin(document, a)).upload, uploadB = (await two.begin(document, b)).upload;
  await one.append(uploadA, a); await two.append(uploadB, b);
  const results = await Promise.all([
    one.write("knowledge.upload.commit", { operationId: randomUUID(), uploadId: uploadA.uploadId }),
    two.write("knowledge.upload.commit", { operationId: randomUUID(), uploadId: uploadB.uploadId }),
  ]);
  assert.equal(results.filter(result => result.result).length, 1);
  assert.equal(results.find(result => result.error).error.code, "CONFLICT");
  assert.deepEqual(await readFile(join(directory, "notes/Team/Doc.assets/image.bin")), results[0].result ? a : b);
});

for (const stage of ["intent-committed", "temporary-written", "resource-replaced", "external-conflict"]) {
  test(`resource upload journal recovers safely at ${stage}`, async t => {
    const { directory, open } = await fixture(t);
    const api = await open(), document = await api.create(), bytes = Buffer.from("journaled image");
    const { upload } = await api.begin(document, bytes); const appended = await api.append(upload, bytes);
    await api.storage.close();
    const args = { operationId: randomUUID(), uploadId: upload.uploadId };
    const expected = {
      ...appended.upload, status: "committed",
      resource: { area: "notes", path: "Team/Doc.assets/image.bin", digest: digest(bytes), size: bytes.length, uri: "Doc.assets/image.bin" },
    };
    const db = new DatabaseSync(join(directory, "core.sqlite"));
    try {
      db.prepare("INSERT INTO pending_asset VALUES(1,?,?,?,?,?,?,?)").run(
        args.operationId, sha256(JSON.stringify({ operation: "knowledge.upload.commit", actorId: owner.id, args })),
        owner.id, "knowledge.upload.commit", upload.uploadId, bytes, JSON.stringify(expected),
      );
    } finally { db.close(); }
    const path = join(directory, "notes/Team/Doc.assets");
    if (stage !== "intent-committed") {
      await mkdir(path);
      await writeFile(join(path, stage === "temporary-written" ? `.pkm-write-${args.operationId}` : "image.bin"), stage === "temporary-written" ? "partial" : stage === "external-conflict" ? "external bytes" : bytes);
    }
    if (stage === "external-conflict") {
      await assert.rejects(Storage.open(directory), /changed outside the server/);
      assert.equal(await readFile(join(path, "image.bin"), "utf8"), "external bytes");
    } else {
      const recovered = await open();
      assert.deepEqual((await recovered.write("knowledge.upload.commit", args)).result, expected);
      assert.deepEqual(await readFile(join(path, "image.bin")), bytes);
      assert.deepEqual(await readdir(path), ["image.bin"]);
      await recovered.storage.close();
    }
    const check = new DatabaseSync(join(directory, "core.sqlite"));
    try {
      assert.equal(check.prepare("SELECT count(*) AS total FROM pending_asset").get().total, stage === "external-conflict" ? 1 : 0);
      assert.equal(check.prepare("SELECT count(*) AS total FROM upload_chunks").get().total, stage === "external-conflict" ? 1 : 0);
    } finally { check.close(); }
  });
}
