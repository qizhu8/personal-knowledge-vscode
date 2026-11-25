import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import childProcess from "node:child_process";
import { registerHooks, syncBuiltinESMExports } from "node:module";
import fs from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import ts from "typescript";

assert.equal(process.env.PKM_TEST_ISOLATED_NETWORK, "1", "Use the mandatory private framework.");
assert(process.env.PKM_TEST_PYTHON);
const project = resolve("."), dist = join(project, "dist"), hash = bytes => createHash("sha256").update(bytes).digest("hex");
const sourceFiles = ["legacy-note-mcp", "domain/legacy-note-query-original"];
const source = new Map(await Promise.all(sourceFiles.map(async name => [
  pathToFileURL(join(dist, `${name}.js`)).href,
  ts.transpileModule(await readFile(join(project, "src", `${name}.ts`), "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
  }).outputText,
])));
// Load only the changed Source at its real module identity; no dist mutation or emitted files.
const hooks = registerHooks({ load(url, context, next) {
  return source.has(url) ? { format: "module", source: source.get(url), shortCircuit: true } : next(url, context);
} });
const { captureOriginalMcpCustody, openOriginalMcpRoot } = await import("../dist/original-mcp-root.js");
const { createNativePublicOwnerBackend } = await import("../dist/native-public-mcp-owner.js");
const { createOriginalMcpNativeHost } = await import("../dist/original-mcp-native-host.js");
const { originalPublicMcpContracts } = await import("../dist/native-public-original-mcp-contracts.js");
const { legacyNoteInventory } = await import("../dist/legacy-note-mcp.js");
const { initialize } = await import("../dist/storage.js");
const { RootOwner } = await import("../dist/root-owner.js");
const { knowledgeReadPrivateTopLevels } = await import("../dist/fresh-note-query-contracts.js");
test.after(() => hooks.deregister());

const actor = Object.freeze({ id: "mcp:external", canWrite: true });
const privacy = { schema: 1, private: { notes: ["Private"] } };
async function originalFiles(root, includePrivacy = true) {
  for (const directory of ["notes/Public", "notes/Private", "skills", "papers", ...(includePrivacy ? [".pkm"] : [])])
    await mkdir(join(root, directory), { recursive: true, mode: 0o700 });
  await writeFile(join(root, "notes/Public/Visible.md"),
    '---\ntitle: "Visible"\ntype: "general"\nknowledgeId: "knowledge_123456789012345678901234"\nrevision: 1\n---\nBounded public body.\n', { mode: 0o600 });
  await writeFile(join(root, "notes/Private/Secret.md"),
    '---\ntitle: "basicprivatesentinel"\ntype: "general"\n---\nbasicprivatesentinel body.\n', { mode: 0o600 });
  if (includePrivacy) await writeFile(join(root, ".pkm/content-privacy.json"), JSON.stringify(privacy), { mode: 0o600 });
}
async function fixture(t, original = true) {
  const directory = resolve("tests", `.native-note-inventory-privacy-${randomUUID()}`);
  await mkdir(directory, { mode: 0o700 });
  const root = join(directory, "root");
  let opened, owner, backend, host;
  t.after(async () => {
    try { await backend?.close(); await host?.close(); await owner?.close(); }
    finally { await rm(directory, { recursive: true, force: true }); }
  });
  if (original) await mkdir(root, { mode: 0o700 }); else await initialize(root);
  await originalFiles(root, original);
  if (!original) {
    owner = await RootOwner.open(root);
    return { directory, root, owner, storage: (await owner.ensureFull()).storage };
  }
  const profileSha256 = hash("native-note-inventory-source-fixture");
  const plan = await captureOriginalMcpCustody({ root, backup: join(directory, "custody"),
    operatorId: "native-note-inventory-source-fixture", profileSha256,
    limits: { maxEntries: 1000, maxDepth: 16, maxBytes: 16_777_216, maxFileBytes: 1_048_576 } });
  opened = await openOriginalMcpRoot(plan); owner = opened.owner;
  const catalog = originalPublicMcpContracts();
  host = await createOriginalMcpNativeHost(opened.storage, {
    profileSha256, sourceCatalogSha256: catalog.provenance.metadataSha256,
    authorityId: "native-note-inventory-source-fixture", epoch: "source-test",
    signal: new AbortController().signal, assertCurrent() {},
    async authorizeAdmission() { return true; }, async authorizePublic() { return true; },
    models: { configuration: { aiEndpoint: "https://not-called.invalid/v1", aiModel: "not-called" },
      registryAvailability: {}, async credentialAvailable() { return false; }, async authorizeRequest() { return false; },
      transport: { supports: () => false, async open() { throw new Error("No network/model calls in this Source fixture."); } } },
  });
  backend = createNativePublicOwnerBackend(owner, { actor, originalMcpHost: host });
  return { directory, root, owner, storage: opened.storage, backend, host,
    async list(args = {}) {
      const response = await backend.invoke("original_mcp_public", { tool: "list_notes", arguments: args });
      assert.notEqual(response.isError, true);
      return response.structuredContent ?? JSON.parse(response.content[0].text);
    } };
}
function privateFieldPaths(value, path = "$", fields = []) {
  if (typeof value === "string" && (/Private|basicprivatesentinel/.test(value))) fields.push(path);
  else if (Array.isArray(value)) value.forEach((item, index) => privateFieldPaths(item, `${path}[${index}]`, fields));
  else if (value && typeof value === "object") for (const [key, item] of Object.entries(value))
    privateFieldPaths(item, `${path}.${key}`, fields);
  return fields;
}
function observePrivateReads(root) {
  const originals = { openSync: fs.openSync, readFileSync: fs.readFileSync }, calls = [], pythonReaders = [];
  const spawn = childProcess.spawn;
  function record(path) {
    if (typeof path !== "string" && !Buffer.isBuffer(path) && !(path instanceof URL)) return;
    try {
      const name = fs.realpathSync(path);
      if (name.startsWith(join(root, "notes/Private") + "/")) calls.push("private-file-read");
    } catch { /* The real filesystem function retains its own missing-path behavior. */ }
  }
  fs.openSync = function (path, ...args) { record(path); return originals.openSync.call(this, path, ...args); };
  fs.readFileSync = function (path, ...args) { record(path); return originals.readFileSync.call(this, path, ...args); };
  childProcess.spawn = function (command, args, ...rest) {
    if (args?.some(arg => typeof arg === "string" && arg.endsWith("/compat/legacy-note-inventory.py")))
      pythonReaders.push("unrestricted-inventory-reader");
    return spawn.call(this, command, args, ...rest);
  };
  syncBuiltinESMExports();
  return { calls, pythonReaders, close() {
    Object.assign(fs, originals); childProcess.spawn = spawn; syncBuiltinESMExports();
  } };
}
test("genuine Original native PUBLIC all-Note list excludes private items before byte reads and retains the exact inventory envelope", async t => {
  const f = await fixture(t);
  assert(knowledgeReadPrivateTopLevels(f.root, "notes").has("Private"));
  const observed = observePrivateReads(f.root);
  let inventory;
  try { inventory = await f.list(); } finally { observed.close(); }
  const fields = privateFieldPaths(inventory);
  t.diagnostic(JSON.stringify({ privateFieldPaths: fields, returned: inventory.returned,
    privateNodeReads: observed.calls.length, unrestrictedInventoryReaders: observed.pythonReaders.length,
    scope: "fresh Source fixture, not installed qualification" }));
  assert.deepEqual(fields, [], "Default PUBLIC inventory may expose neither private rows nor their title/category/source URI.");
  assert.equal(observed.calls.length, 0);
  assert.equal(observed.pythonReaders.length, 0, "Do not read privately and filter only the resulting Python envelope.");
  assert.equal(inventory.schema, "pkm.note-inventory/v1"); assert.equal(inventory.directory, "");
  assert.equal(inventory.total, 1); assert.equal(inventory.returned, 1); assert.equal(inventory.limit, 50);
  assert.equal(inventory.next_offset, null); assert.equal(inventory.identity_complete, true);
  assert.deepEqual(inventory.notes.map(row => row.slug), ["Public/Visible"]);
  assert.match(inventory.inventory_revision, /^[a-f0-9]{64}$/);
  const scoped = await f.list({ directory: "Public" });
  assert.deepEqual(scoped.notes, inventory.notes);
  const page = await f.list({ offset: 1, inventory_revision: inventory.inventory_revision });
  assert.deepEqual(page.notes, []); assert.equal(page.total, inventory.total);
  assert.equal(page.inventory_revision, inventory.inventory_revision);
  await assert.rejects(f.list({ inventory_revision: "0".repeat(64) }), { code: "CONFLICT" });
  const database = f.storage.connectNative();
  try {
    assert.equal(database.prepare("SELECT 1 FROM sqlite_master WHERE name='fresh_note_query_meta'").get(), undefined,
      "Canonical-required Original Roots must not silently bootstrap a new query index to filter this fallback.");
  } finally { database.close(); }
});
test("native private-directory and traversal requests refuse before reading private bytes or publishing inventory metadata", async t => {
  const f = await fixture(t);
  for (const directory of ["Private", "pkm://notes/Private/"]) {
    const observed = observePrivateReads(f.root);
    try { await assert.rejects(f.list({ directory }), { code: "ACCESS_DENIED" }); }
    finally { observed.close(); }
    assert.equal(observed.calls.length, 0);
    assert.equal(observed.pythonReaders.length, 0);
  }
  await assert.rejects(f.list({ directory: "../Private" }), { code: "INVALID_ARGUMENT" });
  await assert.rejects(f.list({ offset: 1 }), { code: "INVALID_ARGUMENT" });
});
test("ordinary non-admitted compatibility inventory does not infer a denial from a Private folder label", async t => {
  const f = await fixture(t, false);
  assert.equal(knowledgeReadPrivateTopLevels(f.root, "notes").size, 0);
  const inventory = await legacyNoteInventory(f.storage, { recursive: true, offset: 0, limit: 50 });
  assert.equal(inventory.total, 2);
  assert.deepEqual(inventory.notes.map(row => row.slug), ["Private/Secret", "Public/Visible"]);
});
