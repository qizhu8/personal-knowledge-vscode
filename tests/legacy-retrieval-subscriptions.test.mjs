import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import ts from "typescript";
import { initialize, Storage } from "../dist/storage.js";
import { legacyRetrievalSubscriptions } from "../dist/legacy-retrieval-subscriptions.js";
import { legacyIndexedKnowledgeRead } from "../dist/legacy-retrieval-index.js";
import { subscriptionPriority } from "../dist/domain/subscription-reads-record.js";
import { createWorkspaceBackup, restoreWorkspaceBackup } from "../dist/workspace-backup.js";
import { nativeRestoreAuthority } from "./host-composition-legacy-batch16-restore-fixture.mjs";

const root = resolve(import.meta.dirname, ".."), repository = resolve(root, "legacy");
const source = await readFile(join(repository, "src/subscriptions/subscriptions.ts"), "utf8");
const ast = ts.createSourceFile("subscriptions.ts", source, ts.ScriptTarget.Latest, true);
const methods = [];
function visit(node) {
  if (ts.isMethodDeclaration(node) && ["cachedGroups", "cachedDetail"].includes(node.name?.getText(ast))) methods.push(node.getText(ast));
  ts.forEachChild(node, visit);
}
visit(ast);
assert.equal(methods.length, 2);
const declarations = ast.statements.filter(node => ts.isFunctionDeclaration(node)
  && ["subscribedContentPath", "safeRelativePath"].includes(node.name?.text))
  .map(node => node.getText(ast).replace(/^export /, "")).join("\n");
const cacheConstants = ast.statements.filter(node => ts.isVariableStatement(node)
  && node.declarationList.declarations.some(declaration =>
    ["MAX_CACHED_SEARCH_RESULTS", "MAX_CACHED_SEARCH_FILE_BYTES"].includes(declaration.name.getText(ast))))
  .map(node => node.getText(ast)).join("\n");
const types = ["skills", "notes", "papers", "prompts", "scripts", "packages", "servers", "recipes"];
const Oracle = new Function("fs", "path", "subscriptionPriority", "SHARED_CONTENT_TYPES",
  ts.transpileModule(`${cacheConstants}
    ${declarations}
    class Oracle {
      constructor(state,storageDir){this.state=state;this.storageDir=storageDir;}
      cachedBrokerName(record){return record.brokerName || "";}
      requireSubscription(id){return this.state.subscriptions.find(record=>record.id===id);}
      ${methods.join("\n")}
    }
    return Oracle;`, { compilerOptions: { module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2022 } }).outputText)(
      fs, path, subscriptionPriority, types);

const record = {
  id: "subscription-one", alias: "Source alias", priority: "highest", brokerName: "Source broker",
  nodeId: "node-one", publisher: "Publisher", publisherUser: "PublisherUser", publisherHost: "PublisherHost",
  endpoint: "https://not-called.invalid", shareId: "share-one", publicKey: "not-an-authority-key",
  magicLink: "pkm://not-called", revision: 3, collectionHash: "fixture-collection",
  topics: [], tags: [], counts: {}, itemCount: 6, etag: "fixture", status: "current",
};
async function fixture(t) {
  const parent = join(root, "tests", `.retrieval-subscriptions-${randomUUID()}`), data = join(parent, "workspace");
  await mkdir(parent); await initialize(data);
  const cache = join(data, "subscriptions/cache/node-one/share-one");
  await mkdir(cache, { recursive: true });
  const state = { schema: 1, nodeId: "local-node", shares: [], subscriptions: [record] };
  await writeFile(join(data, "subscriptions/subscriptions.json"), JSON.stringify(state));
  await writeFile(join(cache, "_subscription.json"), JSON.stringify({
    subscriptionId: record.id, nodeId: record.nodeId, shareId: record.shareId, syncedAt: "2026-01-02T03:04:05Z",
  }));
  const content = {
    "skills/Remote.md": "---\nname: Remote\n---\nEvidence remote skill.",
    "notes/Shared.md": "Evidence remotely shared note.",
    "scripts/check.py": "print('Evidence remote script')",
    "packages/Example/README.md": "Evidence package README.",
    "packages/Example/other.txt": "Must retain the representative README.",
    "servers/example/server.link.json": '{"name":"Example server","url":"https://not-called.invalid"}',
    "recipes/workflow.json": '{"name":"Example workflow","description":"Evidence recipe"}',
  };
  for (const [relative, raw] of Object.entries(content)) {
    await mkdir(path.dirname(join(cache, "content", relative)), { recursive: true });
    await writeFile(join(cache, "content", relative), raw);
  }
  await writeFile(join(cache, "content/notes/Shared.md.pkm-source.json"), JSON.stringify({
    publisher: "Upstream Publisher", revision: "source-7", upstream_uri: "pkm://notes/Shared",
  }));
  const storage = await Storage.open(data);
  t.after(async () => { try { await storage.close(); } finally { await rm(parent, { recursive: true, force: true }); } });
  const read = async (tool, args) => (await legacyIndexedKnowledgeRead(storage, { tool, arguments: args })).value;
  return { parent, data, cache, state, read, storage };
}

test("native subscriber membership projects the exact original cached group/detail corpus, including packages and servers", async t => {
  const f = await fixture(t);
  for (const [type, name] of [["papers", "Paper"], ["prompts", "Prompt"]]) {
    await mkdir(join(f.cache, "content", type));
    await writeFile(join(f.cache, "content", type, `${name}.md`), `Evidence remotely shared ${name}.\n`);
  }
  const actual = await legacyRetrievalSubscriptions(f.data);
  const oracle = new Oracle(f.state, join(f.data, "subscriptions"));
  const expected = types.flatMap(type => oracle.cachedGroups(type, "", Number.MAX_SAFE_INTEGER));
  assert.deepEqual(actual.groups, expected);
  assert.deepEqual([...new Set(actual.groups.flatMap(group => group.items.map(item => item.type)))].sort(), [...types].sort());
  for (const group of expected) for (const item of group.items) {
    const { contentType, content, provenance } = oracle.cachedDetail(item.key);
    assert.deepEqual(actual.read(item.key), { contentType, content, provenance });
  }
  const found = await f.read("search_knowledge", { query: "Evidence", content_type_filter: ["subscription"], debug: true });
  assert.equal(found.ok, true, JSON.stringify(found));
  assert(found.hits.length >= 4);
  assert(found.hits.every(hit => hit.read_only === true));
  const remote = found.hits.find(hit => hit.source_id.includes("/notes/Shared.md"));
  assert.equal(remote.content_type, "note");
  const detail = await f.read("get_knowledge", { id: remote.source_id });
  assert.equal(detail.content, "Evidence remotely shared note.");
  assert.equal(detail.read_only, true);
  assert.equal(detail.provenance.provider, "broker");
  assert.equal(detail.provenance.revision, "source-7");
  const typed = await f.read("search_knowledge", { query: "Evidence", content_type_filter: ["note"], debug: true });
  assert(typed.hits.some(hit => hit.source_id === remote.source_id));
  assert(typed.hits.every(hit => hit.content_type === "note"));
  const scriptId = "pkm://subscriptions/node-one/share-one/scripts/check.py";
  const script = await f.read("get_script", { id: scriptId });
  assert.equal(script.content, "print('Evidence remote script')");
  assert.equal(script.read_only, true);
  const scripts = await f.read("search_scripts", { query: "Evidence", detail: "standard" });
  assert.deepEqual(scripts.hits.map(hit => hit.source_id), [scriptId]);
  assert.equal((await f.read("get_knowledge", {
    id: "pkm://subscriptions/node-one/share-one/prompts/Prompt.md",
  })).content, "Evidence remotely shared Prompt.\n");
  assert.equal((await f.read("get_knowledge", {
    id: "pkm://subscriptions/node-one/share-one/papers/Paper.md",
  })).content, "Evidence remotely shared Paper.\n");
});

test("native admitted subscription corpus restarts and rebuilds after relocated backup without becoming write authority", async t => {
  const f = await fixture(t);
  const id = "pkm://subscriptions/node-one/share-one/notes/Shared.md";
  const before = await f.read("get_knowledge", { id });
  const backup = join(f.parent, "backup"), relocated = join(f.parent, "relocated");
  await createWorkspaceBackup(f.storage, backup, { acquireQuiescence: async () => ({ assertHeld() {}, release() {} }) });
  await f.storage.close();
  await restoreWorkspaceBackup(backup, relocated, { nativeRestoreAuthority });
  const restored = await Storage.open(relocated);
  try {
    const result = await legacyIndexedKnowledgeRead(restored, { tool: "get_knowledge", arguments: { id } });
    assert.equal(result.value.content, before.content);
    assert.equal(result.value.source_revision, before.source_revision);
    assert.equal(result.value.read_only, true);
    assert(result.value.ready_generation > before.ready_generation);
  } finally { await restored.close(); }
});

test("the entire subscribed corpus beyond native membership page boundaries is indexed without truncation", async t => {
  const f = await fixture(t);
  const records = Array.from({ length: 105 }, (_, index) => ({ ...record,
    id: `subscription-${index}`, nodeId: `node-${index}`, shareId: `share-${index}` }));
  for (const member of records) {
    const directory = join(f.data, "subscriptions/cache", member.nodeId, member.shareId, "content/notes");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "Remote.md"), `Complete paginated evidence ${member.id}.\n`);
  }
  f.state.subscriptions.push(...records);
  await writeFile(join(f.data, "subscriptions/subscriptions.json"), JSON.stringify(f.state));
  const corpus = await legacyRetrievalSubscriptions(f.data);
  assert.equal(corpus.groups.reduce((count, group) => count + group.items.length, 0), 111);
  assert.equal(new Set(corpus.groups.map(group => group.subscriptionId)).size, 106);
  const last = records.at(-1);
  const detail = await f.read("get_knowledge", {
    id: `pkm://subscriptions/${last.nodeId}/${last.shareId}/notes/Remote.md`,
  });
  assert.equal(detail.content, `Complete paginated evidence ${last.id}.\n`);
  const database = f.storage.connectNative();
  try {
    assert.equal(database.prepare("SELECT document_count FROM legacy_retrieval_corpus ORDER BY generation DESC LIMIT 1").get().document_count, 111);
  } finally { database.close(); }
});

test("complete subscribed text exceeds the original query-scan threshold without loading excluded assets", async t => {
  const f = await fixture(t);
  const content = `Evidence ${"x".repeat(300 * 1024)} exact final source bytes.\n`;
  await writeFile(join(f.cache, "content/notes/Shared.md"), content);
  await mkdir(join(f.cache, "content/notes/Shared.assets"));
  await writeFile(join(f.cache, "content/notes/Shared.assets/large.bin"), Buffer.alloc(3 * 1024 * 1024, 65));
  const corpus = await legacyRetrievalSubscriptions(f.data);
  const asset = corpus.cache.find(file => file.path.endsWith("/large.bin"));
  assert.equal(asset.size, 3 * 1024 * 1024);
  assert.equal(typeof asset.raw, "undefined");
  assert.equal((await f.read("get_knowledge", {
    id: "pkm://subscriptions/node-one/share-one/notes/Shared.md",
  })).content, content);
});

for (const tamper of ["orphan-cache", "cache-identity", "removed-membership", "changed-cache"])
test(`subscribed retrieval revalidates exact native membership and cache bytes (${tamper})`, async t => {
  const f = await fixture(t);
  const first = await f.read("get_knowledge", { id: "pkm://subscriptions/node-one/share-one/notes/Shared.md" });
  assert.equal(first.ok, true);
  if (tamper === "orphan-cache") {
    await mkdir(join(f.data, "subscriptions/cache/foreign/share"), { recursive: true });
    await writeFile(join(f.data, "subscriptions/cache/foreign/share/summary.json"), "{}");
  } else if (tamper === "cache-identity") {
    await writeFile(join(f.cache, "_subscription.json"), JSON.stringify({ subscriptionId: "different-owner" }));
  } else if (tamper === "removed-membership") {
    await writeFile(join(f.data, "subscriptions/subscriptions.json"), JSON.stringify({ ...f.state, subscriptions: [] }));
  } else {
    await writeFile(join(f.cache, "content/notes/Shared.md"), "Fresh Evidence cache bytes.");
    const fresh = await f.read("get_knowledge", { id: first.source_id });
    assert(fresh.ready_generation > first.ready_generation);
    assert.notEqual(fresh.content_hash, first.content_hash);
    assert.equal(fresh.content, "Fresh Evidence cache bytes.");
    return;
  }
  await assert.rejects(f.read("search_knowledge", { query: "Evidence" }), /identity|subscriber/);
});
