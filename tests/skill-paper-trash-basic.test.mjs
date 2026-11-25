import assert from "node:assert/strict";
import { lstat, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { assetBytes, hash, skillPaperTrashFixture, value } from "./skill-paper-trash-basic-fixture.mjs";

const argsFor = document => document.kind === "skill" ? { name: document.name } : { slug: document.slug };
const businessContract = ({ revision, ...contract }) => contract;
async function successful(reply) {
  const response = await reply;
  assert.notEqual(response.isError, true, JSON.stringify(response));
  const result = value(response);
  assert.notEqual(result.ok, false, JSON.stringify(result));
  assert.equal(result.error, undefined, JSON.stringify(result));
  return result;
}

async function verifyDeletion(f, document, receipt, raw) {
  assert.equal(receipt.ok, true);
  assert.match(receipt.trash.id, /^[0-9]+-[a-f0-9]{10}$/);
  const entry = receipt.trash;
  assert.deepEqual(entry, { id: entry.id, kind: document.kind === "skill" ? "skill" : "item",
    name: document.kind === "skill" ? document.name : `${document.name}.md`,
    originalPath: document.path, deletedAt: entry.deletedAt, assetsPath: `${document.slug}.assets` });
  assert(Number.isFinite(Date.parse(entry.deletedAt)));
  const expected = f.oracle.run(f.oracleRoot, `
    const crypto = require("node:crypto"), NativeDate = Date;
    global.Date = class extends NativeDate {
      constructor(...args) { super(...(args.length ? args : [input.deletedAt])); }
      static now() { return input.idTime; }
    };
    const random = crypto.randomBytes;
    crypto.randomBytes = n => n === 5 ? Buffer.from(input.suffix, "hex") : random(n);
    return { ok: true, trash: store.knowledgePathMoveToTrash(input.area, input.path) };
  `, { area: document.area, path: document.path, idTime: Number(entry.id.split("-")[0]),
    deletedAt: Date.parse(entry.deletedAt), suffix: entry.id.split("-")[1] });
  assert.deepEqual(receipt, expected, "Actual MCP receipt must match independently pinned Original deletion semantics.");
  await assert.rejects(lstat(join(f.root, document.area, document.path)), { code: "ENOENT" });
  await assert.rejects(lstat(join(f.root, document.area, `${document.slug}.assets`)), { code: "ENOENT" });
  const bucket = join(f.root, document.area, ".trash", entry.id);
  assert.deepEqual(await readFile(join(bucket, "payload")), raw);
  assert.deepEqual(await readFile(join(bucket, "assets/bytes.bin")), assetBytes);
  assert.deepEqual(JSON.parse(await readFile(join(bucket, "metadata.json"))), entry);
  const oracleBucket = join(f.oracleRoot, document.area, ".trash", entry.id);
  for (const path of ["payload", "assets/bytes.bin", "metadata.json"])
    assert.deepEqual(await readFile(join(bucket, path)), await readFile(join(oracleBucket, path)));
  assert.deepEqual(JSON.parse(await readFile(join(f.root, ".pkm/state/knowledge-deletions.json"))),
    JSON.parse(await readFile(join(f.oracleRoot, ".pkm/state/knowledge-deletions.json"))));
  const control = f.oracle.run(f.oracleRoot, `
    return { deleted: store[input.kind + "Get"](input.key) || null,
      entries: input.kind === "skill" ? store.skillTrashList() : store.knowledgeTrashList(input.area) };
  `, { kind: document.kind, key: document.kind === "skill" ? document.name : document.slug, area: document.area });
  assert.equal(control.deleted, null);
  assert(control.entries.some(row => row.id === entry.id));
  return entry;
}

for (const kind of ["skill", "paper"]) test(`Pinned Original/A delete_${kind} physically moves exact public pairs, preserves revision/history, and reconnects without replay`,
  { timeout: 150000 }, async t => {
    const f = await skillPaperTrashFixture(t);
    const { client: original } = await f.connect(true), { client: adapter } = await f.connect();
    const description = await f.contract(original, `delete_${kind}`);
    assert.deepEqual(businessContract(await f.contract(adapter, `delete_${kind}`)), businessContract(description),
      "A adds its captured catalog revision; the actual Original business contract must match.");
    assert.equal(description.readOnly, false);
    assert.deepEqual(Object.keys(description.inputSchema.properties), [kind === "skill" ? "name" : "slug"]);
    const publicTools = (await adapter.listTools()).tools;
    assert(!publicTools.some(tool => /trash_(list|restore)|restore_(skill|paper)/.test(tool.name)),
      "Original has no public Trash list/restore alias; closed-oracle controls are not MCP operation coverage.");
    const entries = [];
    for (const [lane, client] of [["Original", original], ["Adapter", adapter]]) {
      const document = f.documents.find(row => row.kind === kind && row.lane === lane);
      const raw = await readFile(join(f.root, document.area, document.path));
      assert.equal(document.before.revision, 2);
      const read = await f.call(client, lane, `get_${kind}`, argsFor(document));
      assert.deepEqual(read, await f.call(original, "Original-read-control", `get_${kind}`, argsFor(document)));
      assert.equal((await successful(read)).content, document.before.content.replaceAll("\r\n", "\n"),
        "Original Python read normalizes newlines, while the physical Trash payload must preserve exact CRLF bytes.");
      const receipt = await successful(f.call(client, lane, `delete_${kind}`, argsFor(document)));
      entries.push({ document, entry: await verifyDeletion(f, document, receipt, raw), raw });
      const beforeAbsent = await f.state();
      const expectedAbsent = kind === "skill" ? { ok: true, name: document.name, absent: true } : { ok: true, absent: true };
      assert.deepEqual(await successful(f.call(adapter, "Adapter-repeat", `delete_${kind}`, argsFor(document))), expectedAbsent);
      assert.deepEqual(await successful(f.call(original, "Original-repeat", `delete_${kind}`, argsFor(document))), expectedAbsent);
      const missing = await f.call(adapter, "Adapter-read-deleted", `get_${kind}`, argsFor(document));
      assert.deepEqual(missing, await f.call(original, "Original-read-deleted", `get_${kind}`, argsFor(document)));
      assert.equal(missing.isError, false, "Original returns not-found as ordinary text, not an MCP error or positive read.");
      assert.match(missing.content.filter(part => part.type === "text").map(part => part.text).join(""), /not found/i);
      assert(!JSON.stringify(missing).includes(document.before.content));
      const listed = await f.call(adapter, "Adapter-list", `list_${kind}s`, {});
      assert.deepEqual(listed, await f.call(original, "Original-list", `list_${kind}s`, {}));
      assert(!JSON.stringify(await successful(listed)).includes(document.name));
      assert.deepEqual(await f.state(), beforeAbsent, "Absent/repeated deletion and reads must not publish another bucket or journal record.");
    }
    await f.close(original); await f.close(adapter);
    const stopped = await f.state();
    const reopened = await f.connect(), reopenedOriginal = await f.connect(true);
    for (const { document, entry, raw } of entries) {
      const expected = kind === "skill" ? { ok: true, name: document.name, absent: true } : { ok: true, absent: true };
      assert.deepEqual(await successful(f.call(reopened.client, "Adapter-reconnect", `delete_${kind}`, argsFor(document))), expected);
      assert.deepEqual(await successful(f.call(reopenedOriginal.client, "Original-reconnect", `delete_${kind}`, argsFor(document))), expected);
      assert.deepEqual(await readFile(join(f.root, document.area, ".trash", entry.id, "payload")), raw);
      const restored = f.oracle.run(f.oracleRoot, `
        const result = input.kind === "skill" ? store.skillTrashRestore(input.id) : store.knowledgeTrashRestore(input.area, input.id);
        return { result, row: store[input.kind + "Get"](input.key),
          entries: input.kind === "skill" ? store.skillTrashList() : store.knowledgeTrashList(input.area) };
      `, { area: document.area, id: entry.id, kind, key: kind === "skill" ? document.name : document.slug });
      assert.deepEqual(restored.result, { ok: true, path: document.path });
      assert.deepEqual(restored.row, document.before, "Closed Original restore keeps original identity and revision; no native tombstone revision increment.");
      assert(!restored.entries.some(row => row.id === entry.id));
      assert.deepEqual(await readFile(join(f.oracleRoot, document.area, document.path)), raw);
    }
    assert.deepEqual(await f.state(), stopped, "Reconnect and closed-oracle restore must not restore or otherwise change the real MCP root.");
    await f.assertOwnership();
    await f.close(reopenedOriginal.client); await f.close(reopened.client);
    t.diagnostic(`${JSON.stringify(f.trace)}; original VSIX=${f.oracle.originalPackageSha256}; native/installed Skill/Paper Trash and old-bucket restore are NOT qualified.`);
  });

test("Pinned Original/A reviewed knowledge_file_trash checks exact SHA before paired deletion; read lane and CAS refusal have no effects",
  { timeout: 150000 }, async t => {
    const f = await skillPaperTrashFixture(t);
    const { client: original } = await f.connect(true), { client: adapter } = await f.connect();
    assert.deepEqual(businessContract(await f.contract(adapter, "knowledge_file_trash")),
      businessContract(await f.contract(original, "knowledge_file_trash")));
    for (const kind of ["skill", "paper"]) {
      const document = f.documents.find(row => row.kind === kind && row.lane === "Reviewed");
      const raw = await readFile(join(f.root, document.area, document.path));
      const args = { area: document.area, path: document.path, expected_sha256: hash(raw) };
      const before = await f.state();
      for (const [lane, client] of [["Original", original], ["Adapter", adapter]]) {
        const readLane = await f.call(client, `${lane}-read-refusal`, "knowledge_file_trash", args, { readLane: true });
        assert.equal(readLane.isError, true, JSON.stringify(readLane));
        const refused = await f.call(client, `${lane}-CAS-refusal`, "knowledge_file_trash", { ...args, expected_sha256: "0".repeat(64) });
        assert.equal(refused.isError, true, JSON.stringify(refused));
      }
      assert.deepEqual(await f.state(), before);
      const client = kind === "skill" ? original : adapter;
      const receipt = await successful(f.call(client, kind === "skill" ? "Original" : "Adapter", "knowledge_file_trash", args));
      await verifyDeletion(f, document, receipt, raw);
    }
    await f.assertOwnership();
    await f.close(original); await f.close(adapter);
    t.diagnostic(`Positive original ID: mcp.tool.knowledge_file_trash; trace=${JSON.stringify(f.trace)}. No Original public restore/list operation is invented.`);
  });

test("Pinned Original/A Skill/Paper private-shared pairs refuse without effects; direct private-target policy remains UNQUALIFIED",
  { timeout: 150000 }, async t => {
    const f = await skillPaperTrashFixture(t, { shared: true });
    const { client: original } = await f.connect(true), { client: adapter } = await f.connect();
    for (const kind of ["skill", "paper"]) {
      const document = f.documents.find(row => row.kind === kind && row.lane === "Original");
      const before = await f.state();
      const control = f.oracle.run(f.oracleRoot, `
        try { return { entry: store.knowledgePathMoveToTrash(input.area, input.path) }; }
        catch (error) { return { error: error.message }; }
      `, { area: document.area, path: document.path });
      assert.match(control.error, /Resource is shared by Private\/TrashSecret/);
      for (const [lane, client] of [["Original", original], ["Adapter", adapter]]) {
        const shared = await f.call(client, `${lane}-private-shared-refusal`, `delete_${kind}`, argsFor(document));
        assert.equal(shared.isError, true, JSON.stringify(shared));
        assert.match(JSON.stringify(shared), /Resource is shared by Private/);
        const traversal = await f.call(client, `${lane}-path-refusal`, "knowledge_file_trash",
          { area: document.area, path: "../escape.md", expected_sha256: "0".repeat(64) });
        assert.equal(traversal.isError, true, JSON.stringify(traversal));
      }
      assert.deepEqual(await f.state(), before, "Refused shared-pair and traversal calls must have no physical or journal effect.");
      assert.equal((await readdir(join(f.root, document.area))).includes(".trash"), false);
    }
    await f.assertOwnership();
    await f.close(original); await f.close(adapter);
    t.diagnostic(`Restriction evidence only, not positive deletion coverage: private-shared pairs refuse. Direct private targets are NOT privacy-qualified: pinned22 _walk includes private folders and _assert_mcp_writable checks only System/containment; actual pinned22 private delete_skill moved its synthetic target in the initial characterization run. This is old Original policy, not an A regression, and is not fixed or accepted as safe here. ${JSON.stringify(f.trace)}`);
  });
