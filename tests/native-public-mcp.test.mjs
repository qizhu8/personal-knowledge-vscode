import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import { initialize } from "../dist/storage.js";
import { createNativePublicFacade, startNativePublicMcp } from "../dist/native-public-mcp.js";
import { createNativePublicOwnerBackend, nativePublicFullOptions, startNativePublicOwnerMcp } from "../dist/native-public-mcp-owner.js";
import { RootOwner } from "../dist/root-owner.js";
import { createNativeScopedNoteRead } from "../dist/native-public-mcp-note-read.js";
import { loadNativePublicManifest, NativePublicMcpLifecycle } from "../dist/native-public-mcp-lifecycle.js";

async function fixture(t) {
  const parent = resolve("tests", `.native-public-${randomUUID()}`);
  await mkdir(parent, { mode: 0o700 });
  t.after(() => rm(parent, { recursive: true, force: true }));
  const generation = resolve(parent, "generations", "current");
  await mkdir(generation, { recursive: true });
  const manifest = {
    schema: "pkm.mcp.lifecycle/v1", managedRoot: parent, generation: "current", version: "0.1.0",
    components: { knowledge: "0.1.0", chat: "0.1.0", recipes: "0.1.0", agent_sessions: "0.1.0" },
    enabledFeatureDomains: [],
    compatibility: { protocol: "pkm.mcp.api/1", components: { knowledge: "0" } },
  };
  await writeFile(resolve(generation, "manifest.json"), JSON.stringify(manifest));
  const active = resolve(parent, "active-generation.json");
  await writeFile(active, JSON.stringify({ schema: manifest.schema, generation: "current" }));
  return { parent, generation, manifest, active };
}
const jsonResult = result => result.structuredContent ?? JSON.parse(result.content[0].text);

for (const writable of [false, true])
test(`native owner metadata and quiescence never require full attachment and release the actual root (${writable ? "writable" : "read-only"})`, async t => {
  const { parent, manifest } = await fixture(t);
  const data = await initialize(resolve(parent, "workspace"));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const serving = await startNativePublicOwnerMcp(data, { actor: { id: "mcp:external", canWrite: writable }, manifest }, serverTransport);
  const client = new Client({ name: "owner-metadata", version: "1" });
  t.after(async () => { try { await client.close(); } finally { await serving.close(); } });
  await client.connect(clientTransport);
  assert.equal((await client.listTools()).tools.length, 9);
  assert.equal(jsonResult(await client.callTool({ name: "check_version", arguments: {} })).name, "pkm-v5");
  await client.callTool({ name: "capabilities_search", arguments: { query: "get_note" } });
  for (const path of ["todo", "memory"]) {
    const discovered = jsonResult(await client.callTool({ name: "capabilities_search",
      arguments: { query: "", path, limit: 10 } }));
    assert(discovered.operations.length > 0);
    if (!writable) assert(discovered.operations.every(operation => operation.readOnly));
    else assert(discovered.operations.some(operation => !operation.readOnly));
    assert(!discovered.operations.some(operation => ["memory.record.confirm", "memory.record.revise", "memory.record.revoke"].includes(operation.id)));
  }
  const described = await client.callTool({ name: "capabilities_describe", arguments: { operation: "memory.record.search" } });
  assert.equal(described.isError, false);
  await serving.owner.withReadScope(scope => { assert.equal(scope.full, undefined); });
  const drained = jsonResult(await client.callTool({ name: "mcp_lifecycle_quiesce", arguments: {} }));
  assert.equal(drained.phase, "drained");
  const reopened = await RootOwner.open(data);
  try { assert.equal(reopened.startupClassification().kind, "plain"); } finally { await reopened.close(); }
  assert.deepEqual((await readdir(parent)).sort(), ["active-generation.json", "generations", "workspace"]);
});

test("read-only adopted native MCP startup and Note queries preserve the committed rollback baseline", async t => {
  const { parent, manifest } = await fixture(t);
  const data = resolve(parent, "workspace");
  for (const area of ["notes", "skills", "papers"]) await mkdir(resolve(data, area), { recursive: true, mode: 0o700 });
  const original = "---\ntitle: Existing\ndocumentId: synthetic-note\nrevision: 1\n---\nSynthetic original content.\n";
  await writeFile(resolve(data, "notes", "Existing.md"), original, { mode: 0o600 });
  const { adoptLegacyRootInPlaceExperimental, rollbackCommittedLegacyRootAdoptionExperimental } =
    await import("../dist/legacy-root-adoption.js");
  const adopted = await adoptLegacyRootInPlaceExperimental(data, { experimentalPostCommitRollbackBaseline: true });
  await adopted.storage.close();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const serving = await startNativePublicOwnerMcp(data,
    { actor: { id: "mcp:external", canWrite: false }, manifest }, serverTransport);
  const client = new Client({ name: "adopted-read-only", version: "1" });
  try {
    await client.connect(clientTransport);
    for (const operation of ["get_note", "list_notes", "search_notes"]) {
      const args = operation === "get_note" ? { slug: "Existing" }
        : operation === "list_notes" ? { limit: 0 } : { query: "Synthetic" };
      const response = await client.callTool({ name: "capability_read",
        arguments: { operation: `mcp.tool.${operation}`, version: 1, arguments: args } });
      assert.equal(response.isError, false, JSON.stringify(response));
    }
  } finally { try { await client.close(); } finally { await serving.close(); } }
  for (const area of ["notes", "skills", "papers"])
    await assert.rejects(lstat(resolve(data, area, ".trash")), { code: "ENOENT" });
  await rollbackCommittedLegacyRootAdoptionExperimental(data, {
    workspaceId: adopted.workspaceId, expectedPrepared: adopted,
  });
  assert.equal(await readFile(resolve(data, "notes", "Existing.md"), "utf8"), original);
  await assert.rejects(lstat(resolve(data, "core.sqlite")), { code: "ENOENT" });
});

test("first real native MCP Note list and lexical search attach only the canonical basic reader", async t => {
  for (const name of ["list_notes", "search_notes"]) {
    const { parent, manifest } = await fixture(t);
    const data = await initialize(resolve(parent, "workspace"));
    await writeFile(resolve(data, "notes", "Entry.md"), "---\ndocumentId: entry\ntitle: Needle entry\n---\nneedle body\n");
    const observed = JSON.parse(execFileSync(process.execPath, ["-e", `
      (async()=>{
      const {registerHooks}=await import("node:module");
      const seen=[];
      registerHooks({load(url,context,next){ if(/\\/(?:dist|src)\\//.test(url)) seen.push(url); return next(url,context); }});
      const {startNativePublicOwnerMcp}=await import(process.argv[1]);
      const {InMemoryTransport}=await import("@modelcontextprotocol/sdk/inMemory.js");
      const {Client}=await import("@modelcontextprotocol/sdk/client/index.js");
      const [clientTransport,serverTransport]=InMemoryTransport.createLinkedPair();
      const serving=await startNativePublicOwnerMcp(process.argv[2],{
        actor:{id:"mcp:external",canWrite:false},manifest:JSON.parse(process.argv[3])
      },serverTransport);
      const client=new Client({name:"first-basic",version:"1"});
      try {
        await client.connect(clientTransport);
        const name=process.argv[4], args=name==="list_notes"?{limit:0}:{query:"needle"};
        const read=()=>client.callTool({name:"capability_read",arguments:{operation:"mcp.tool."+name,version:1,arguments:args}});
        const first=await read();
        let plain=false; await serving.owner.withReadScope(scope=>{plain=scope.full===undefined;});
        const basicSeen=[...seen], lease={...serving.owner.workspaceLease()};
        await serving.owner.ensureFull();
        const canonical=await read();
        console.log(JSON.stringify({first,canonical,plain,seen:basicSeen,sameLease:JSON.stringify(lease)===JSON.stringify(serving.owner.workspaceLease())}));
      } finally { await client.close(); await serving.close(); }
      })().catch(error=>{console.error(error);process.exitCode=1;});
    `, new URL("../dist/native-public-mcp-owner.js", import.meta.url).href, data, JSON.stringify(manifest), name],
    { encoding: "utf8", timeout: 45_000 }));
    assert.equal(observed.plain, true);
    assert.equal(observed.sameLease, true);
    assert.equal(observed.first.isError, false, JSON.stringify(observed.first));
    assert.deepEqual(observed.first, observed.canonical, "the minimal and full backend must preserve every original output field");
    assert(!observed.seen.some(url => !url.includes("/node_modules/")
      && /\/(?:storage|storage-worker|core|contracts|native-runtime|legacy-note-mcp|legacy-mcp-note-policy)\.(?:js|ts)$/.test(url)),
      observed.seen.join("\n"));
  }
});

test("basic native Note publication rechecks late SQL/control changes once and never replays", async t => {
  for (const change of ["receipt", "journal", "schema", "layout", "private", "owner", "expiry"]) {
    const { parent } = await fixture(t);
    const data = await initialize(resolve(parent, "workspace"));
    // Use the canonical v23 schema so receipts and every global journal exist.
    const bootstrap = await RootOwner.open(data);
    await bootstrap.ensureFull();
    await bootstrap.close();
    await writeFile(resolve(data, "notes", "Entry.md"), "---\ndocumentId: entry\ntitle: Entry\n---\nNeedle body.\n");
    const options = { actor: { id: "mcp:external", canWrite: false } };
    const owner = await RootOwner.open(data, { prepareNative: storage => nativePublicFullOptions(storage, options) });
    const backend = createNativePublicOwnerBackend(owner, options);
    const qualify = owner.qualifyFreshLegacyReadScope.bind(owner);
    let queries = 0, armed = false;
    const read = owner.readBasicLegacyNotes.bind(owner);
    t.mock.method(owner, "readBasicLegacyNotes", (...args) => { queries++; return read(...args); });
    t.mock.method(owner, "qualifyFreshLegacyReadScope", async scope => {
      if (armed) {
        armed = false;
        if (change === "layout") mkdirSync(resolve(data, "recipes"), { mode: 0o700 });
        else if (change === "private") mkdirSync(resolve(data, ".pkm-room-admission"), { mode: 0o700 });
        else {
          const db = new DatabaseSync(resolve(data, "core.sqlite"));
          try {
            if (change === "receipt") db.prepare("INSERT INTO receipts VALUES(?,?,?,?,?,?)")
              .run(randomUUID(), "a".repeat(64), "{}", "foreign", "knowledge.document.create", new Date().toISOString());
            if (change === "journal") db.exec("INSERT INTO pending_todo VALUES(1,'pending','f','actor','todo.item.add','board',NULL,'{}','{}')");
            if (change === "schema") db.exec("CREATE TABLE late_unknown_state(value TEXT)");
            if (change === "owner") db.exec("UPDATE native_runtime_owner SET owner_id='foreign',fence=fence+1 WHERE singleton=1");
            if (change === "expiry") db.exec("UPDATE native_runtime_owner SET lease_until=0 WHERE singleton=1");
          } finally { db.close(); }
        }
      }
      const result = await qualify(scope);
      // The next qualifier runs only after the actual A/B model query has finished.
      if (queries === 1 && !armed) armed = true;
      return result;
    });
    try {
      await assert.rejects(backend.invoke("list_notes", {}), error =>
        ["CONFLICT", "RECOVERY_REQUIRED", "STORAGE_UNAVAILABLE"].includes(error.code), change);
      assert.equal(queries, 1, `${change}: an ambiguous result must not replay via full()`);
      assert.equal(owner.fullTask, undefined, `${change}: no automatic second executor after query admission`);
    } finally { await backend.close(); await owner.close(); }
  }
});

test("native owner upgrades once on the same lease and preserves real canonical reads, mutations and drain", async t => {
  const { parent, manifest } = await fixture(t);
  const data = await initialize(resolve(parent, "workspace"));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const serving = await startNativePublicOwnerMcp(data, { actor: { id: "mcp:external", canWrite: true }, manifest }, serverTransport);
  const client = new Client({ name: "owner-upgrade", version: "1" });
  t.after(async () => { try { await client.close(); } finally { await serving.close(); } });
  await client.connect(clientTransport);
  const lease = serving.owner.workspaceLease();
  await writeFile(resolve(data, "notes", "Entry.md"), "---\ndocumentId: entry\ntitle: Entry\n---\nScoped original body.\n");
  const get = () => client.callTool({ name: "capability_read",
    arguments: { operation: "mcp.tool.get_note", version: 1, arguments: { slug: "Entry" } } });
  const beforeUpgrade = await get();
  assert.equal(beforeUpgrade.isError, false);
  await serving.owner.withReadScope(scope => { assert.equal(scope.full, undefined); });
  const boards = () => client.callTool({ name: "capability_read",
    arguments: { operation: "todo.board.list", version: 1, arguments: {} } });
  const reads = await Promise.all([boards(), boards()]);
  assert(reads.every(result => !result.isError), JSON.stringify(reads));
  const full = await serving.owner.ensureFull();
  assert.equal(await serving.owner.ensureFull(), full);
  assert.deepEqual(full.storage.workspaceLease(), lease);
  assert.deepEqual(await get(), beforeUpgrade, "a still-simple full owner retains the same qualified path get");
  const created = await client.callTool({ name: "capability_call",
    arguments: { operation: "mcp.tool.add_note", version: 1, arguments: { title: "Created", content: "Native owner mutation." } } });
  assert.equal(created.isError, false, JSON.stringify(created));
  assert.match(await readFile(resolve(data, "notes", "Created.md"), "utf8"), /Native owner mutation/);
  const drained = jsonResult(await client.callTool({ name: "mcp_lifecycle_quiesce", arguments: {} }));
  assert.equal(drained.phase, "drained");
  const reopened = await RootOwner.open(data);
  try { assert.deepEqual(reopened.startupClassification(), { kind: "full-required", reason: "durable-state" }); }
  finally { await reopened.close(); }
});

test("native scoped get ignores unrelated invalid/duplicate sources but failed global upgrade cannot resume thin", async t => {
  const { parent, manifest } = await fixture(t);
  const data = await initialize(resolve(parent, "workspace"));
  await writeFile(resolve(data, "notes", "Entry.md"), "---\ndocumentId: entry\ntitle: Entry\n---\nTarget body.\n");
  await writeFile(resolve(data, "notes", "Duplicate1.md"), "---\ndocumentId: duplicate\n---\nOne\n");
  await writeFile(resolve(data, "notes", "Duplicate2.md"), "---\ndocumentId: duplicate\n---\nTwo\n");
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const serving = await startNativePublicOwnerMcp(data, { actor: { id: "mcp:external", canWrite: false }, manifest }, serverTransport);
  const client = new Client({ name: "scoped-get", version: "1" });
  t.after(async () => { try { await client.close(); } finally { await serving.close(); } });
  await client.connect(clientTransport);
  const get = slug => client.callTool({ name: "capability_read",
    arguments: { operation: "mcp.tool.get_note", version: 1, arguments: { slug } } });
  const first = await get("Entry");
  assert.equal(first.isError, false, JSON.stringify(first));
  assert.match(first.content[0].text, /Target body/);
  assert.equal((await get("Missing")).content[0].text, "Note 'Missing' not found. Use list_notes or search_notes to find it.");
  assert.equal((await get("../Entry")).isError, true);
  await writeFile(resolve(data, "notes", "Invalid.md"), "---\ntitle: [unterminated\n---\nUnrelated\n");
  assert.deepEqual(await get("Entry"), first);
  await serving.owner.withReadScope(scope => { assert.equal(scope.full, undefined); });
  const global = await client.callTool({ name: "capability_read",
    arguments: { operation: "mcp.tool.list_notes", version: 1, arguments: {} } });
  assert.equal(global.isError, true, JSON.stringify(global));
  assert.equal((await get("Entry")).isError, true, "failed upgrade never returns to thin get");
});

test("native scoped get revalidates fresh target and conditional dependencies before publishing", async t => {
  for (const change of ["invalid-target", "board", "recipes", "unrelated"]) await t.test(change, async t => {
    const { parent } = await fixture(t);
    const data = await initialize(resolve(parent, "workspace"));
    const target = resolve(data, "notes", "Entry.md");
    await writeFile(target, "---\ndocumentId: entry\ntitle: Entry\n---\nOriginal body.\n");
    const owner = await RootOwner.open(data);
    t.after(() => owner.close());
    const reader = createNativeScopedNoteRead(owner);
    const request = { tool: "get_note", arguments: { slug: "Entry" } };
    const lease = owner.workspaceLease();
    const baseline = await owner.withReadScope(scope => reader.read(scope, request));
    const attempt = owner.withReadScope(scope => {
      const actual = owner.assertWorkspaceLease;
      let checks = 0;
      owner.assertWorkspaceLease = function() {
        actual.call(this);
        if (++checks !== 2) return;
        if (change === "invalid-target") writeFileSync(target, "---\ntitle: [invalid\n---\nChanged\n");
        if (change === "board") {
          mkdirSync(resolve(data, "notes", "Entry.assets"));
          writeFileSync(resolve(data, "notes", "Entry.assets", "pkm-todo-board.json"), "{}");
        }
        if (change === "recipes") mkdirSync(resolve(data, "recipes"));
        if (change === "unrelated") writeFileSync(resolve(data, "notes", "Other.md"), "---\ntitle: [invalid\n");
      };
      try { return reader.read(scope, request); }
      finally { owner.assertWorkspaceLease = actual; }
    });
    if (change === "unrelated") assert.deepEqual(await attempt, baseline);
    else await assert.rejects(attempt, error => error.code === "CONFLICT");
    assert.deepEqual(owner.workspaceLease(), lease);
    if (change === "invalid-target")
      await assert.rejects(owner.withReadScope(scope => reader.read(scope, request)),
        error => error.code === "INVALID_DOCUMENT", "initial invalid YAML retains the canonical exception");
  });
});

test("native get keeps Board advisory reads on the same-owner canonical fallback", async t => {
  const { parent, manifest } = await fixture(t);
  const data = await initialize(resolve(parent, "workspace"));
  await writeFile(resolve(data, "notes", "Board.md"), "---\ndocumentId: board\ntitle: Board\ndocumentKind: todo-board\n---\nBoard\n");
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const serving = await startNativePublicOwnerMcp(data, { actor: { id: "mcp:external", canWrite: false }, manifest }, serverTransport);
  const client = new Client({ name: "board-fallback", version: "1" });
  t.after(async () => { try { await client.close(); } finally { await serving.close(); } });
  await client.connect(clientTransport);
  await serving.owner.withReadScope(scope => { assert.equal(scope.full, undefined); });
  const response = await client.callTool({ name: "capability_read",
    arguments: { operation: "mcp.tool.get_note", version: 1, arguments: { slug: "Board" } } });
  assert.equal(response.isError, false, JSON.stringify(response));
  assert.equal(JSON.parse(response.content[0].text).documentKind, "todo-board");
  await serving.owner.withReadScope(scope => { assert(scope.full); });
});

test("native full get publishes only after live canonical post-qualification and never replays a failed read", async t => {
  const { parent } = await fixture(t);
  const data = await initialize(resolve(parent, "workspace"));
  await writeFile(resolve(data, "notes", "Entry.md"), "---\ndocumentId: entry\ntitle: Entry\n---\nOriginal body.\n");
  const options = { actor: { id: "mcp:external", canWrite: false } };
  const owner = await RootOwner.open(data, { prepareNative: storage => nativePublicFullOptions(storage, options) });
  const actual = createNativeScopedNoteRead(owner);
  let inject = false, reads = 0;
  const backend = createNativePublicOwnerBackend(owner, options, {
    accepts: request => actual.accepts(request),
    read(scope, request) {
      reads++;
      const result = actual.read(scope, request);
      if (inject) {
        inject = false;
        const database = new DatabaseSync(resolve(data, "core.sqlite"));
        try {
          database.prepare("INSERT INTO receipts VALUES(?,?,?,?,?,?)")
            .run(randomUUID(), "a".repeat(64), "{}", "foreign-fixture", "knowledge.document.create", new Date().toISOString());
        } finally { database.close(); }
      }
      return result;
    },
  });
  t.after(async () => { try { await backend.close(); } finally { await owner.close(); } });
  await backend.invoke("legacy_capability_read", { action: "read",
    args: { operation: "todo.board.list", version: 1, arguments: {} } });
  const request = { tool: "get_note", arguments: { slug: "Entry" } };
  const baseline = await backend.invoke("legacy_knowledge_read", request);
  reads = 0; inject = true;
  await assert.rejects(backend.invoke("legacy_knowledge_read", request), error => error.code === "CONFLICT");
  assert.equal(reads, 1, "post-qualification failure is not retried through another executor");
  const delegated = await backend.invoke("legacy_knowledge_read", request);
  assert.equal(reads, 1, "an already nonplain root delegates before executing the scoped get");
  assert.equal(delegated.structuredContent.text, baseline.structuredContent.text);
});

test("native public contracts regenerate from the current real Python facade", { timeout: 30_000 }, () => {
  execFileSync(process.env.PKM_TEST_PYTHON ?? "python", ["scripts/export-native-public-mcp-contracts.py", "--check"],
    { encoding: "utf8", timeout: 25_000, stdio: ["ignore", "pipe", "pipe"] });
});

test("native lifecycle preserves cancellation uncertainty, control fences and close-before-drained receipts", async t => {
  const { parent, manifest, active } = await fixture(t);
  let now = 0, closed = 0, finish;
  const lifecycle = new NativePublicMcpLifecycle(manifest, async () => { closed++; }, { now: () => now, drainSeconds: 1 });
  const abort = new AbortController();
  const pending = lifecycle.run("capability_call", () => new Promise(resolve => { finish = resolve; }), abort.signal);
  await Promise.resolve();
  abort.abort();
  lifecycle.quiesce();
  now = 2000;
  assert.equal(lifecycle.status().uncertainCalls, 1);
  assert.equal(lifecycle.status().phase, "action-required");
  assert.equal((await lifecycle.drainedStatus()).inFlight, 1);
  assert.equal(closed, 0);
  await assert.rejects(lifecycle.run("capability_read", async () => null), /managed-runtime-superseded/);
  finish("committed once");
  assert.equal(await pending, "committed once");
  assert.equal((await lifecycle.drainedStatus()).phase, "drained");
  assert.equal(closed, 1);
  await lifecycle.close();
  assert.equal(closed, 1);
  assert.deepEqual((await readdir(parent)).sort(), ["active-generation.json", "generations"]);
  await writeFile(active, "{malformed");
  assert.equal(lifecycle.status().controlError, "generation-control-unavailable");
  await assert.rejects(lifecycle.drainedStatus(), /drain is unverified/);
});

test("native lifecycle distinguishes compatible successors from maintenance and rejects forged ownership", async t => {
  const { parent, generation, manifest, active } = await fixture(t);
  const successor = resolve(parent, "generations", "next");
  await mkdir(successor);
  await writeFile(resolve(successor, "manifest.json"), JSON.stringify({ ...manifest, generation: "next" }));
  await writeFile(active, JSON.stringify({ schema: manifest.schema, generation: "current", compatibilityBaseline: true }));
  await writeFile(resolve(parent, "latest-generation.json"), JSON.stringify({ schema: manifest.schema, generation: "next" }));
  const lifecycle = new NativePublicMcpLifecycle(manifest, async () => {});
  assert.equal(lifecycle.status().acceptingNewCalls, true);
  assert.equal(lifecycle.status().compatibility, "compatible-update");
  await writeFile(resolve(parent, "runtime-maintenance.json"), "{}");
  assert.equal(lifecycle.status().acceptingNewCalls, false);
  assert.equal(loadNativePublicManifest(generation, parent, false).generation, "current");
  await writeFile(resolve(generation, "manifest.json"), JSON.stringify({ ...manifest, generation: "next" }));
  assert.throws(() => loadNativePublicManifest(generation, parent, false), /ownership/);
  await lifecycle.close();
});

test("full original public metadata preserves all actual contracts, numeric spelling and bounded discovery pages", async t => {
  const { manifest } = await fixture(t);
  const oracle = JSON.parse(await readFile(new URL("fixtures/original-public-mcp-discovery.json", import.meta.url), "utf8"));
  const backend = { close: async () => {}, invoke: async () => { throw new Error("Discovery must not execute a business tool."); } };
  const facade = createNativePublicFacade(backend,
    { writable: true, manifest, closeBackend: async () => {}, catalogProfile: "original-full", toolSurface: "compact" });
  t.after(() => facade.close());
  assert.deepEqual(facade.definitions, oracle.wireDefinitions);
  assert.deepEqual(await facade.invoke("capabilities_inventory", {}), oracle.inventory);
  for (const { operation, response } of oracle.describes)
    assert.deepEqual(await facade.invoke("capabilities_describe", { operation }), response, operation);
  for (const { name, arguments: args, response } of oracle.discovery)
    assert.deepEqual(await facade.invoke(name, args), response, `${name}:${JSON.stringify(args)}`);
});

test("full original public execution uses its exact native dispatcher and discovery never grants writes", async t => {
  const { manifest } = await fixture(t);
  const calls = [];
  const response = { content: [{ type: "text", text: '{"fixture":"native"}' }],
    structuredContent: { fixture: "native" }, isError: false };
  const backend = { close: async () => {}, invoke: async (name, args) => { calls.push({ name, args }); return response; } };
  const writable = createNativePublicFacade(backend,
    { writable: true, manifest, closeBackend: async () => {}, catalogProfile: "original-full" });
  const readonly = createNativePublicFacade(backend,
    { writable: false, manifest, closeBackend: async () => {}, catalogProfile: "original-full" });
  t.after(async () => { await writable.close(); await readonly.close(); });
  assert.equal(await writable.invoke("capability_read",
    { operation: "mcp.tool.api_chat_capabilities", version: 1, arguments: {} }), response);
  assert.deepEqual(calls, [{ name: "original_mcp_public", args: { tool: "api_chat_capabilities", arguments: {} } }]);
  await readonly.invoke("capabilities_describe", { operation: "mcp.tool.add_note" });
  await assert.rejects(readonly.invoke("capability_call",
    { operation: "mcp.tool.add_note", version: 1, arguments: { title: "Synthetic", content: "Fixture only" } }), /ACCESS_DENIED/);
  assert.equal(calls.length, 1);
});

test("hybrid module tools negotiate guidance and call the same canonical executor without discovery", async t => {
  const { manifest } = await fixture(t);
  const calls = [];
  const backend = {
    close: async () => {},
    invoke: async (name, args) => {
      calls.push({ name, args });
      const value = { canonical: args.tool };
      return { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value, isError: false };
    },
  };
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const toolCalls = [];
  const send = clientTransport.send.bind(clientTransport);
  clientTransport.send = (message, extra) => {
    if (message.method === "tools/call") toolCalls.push(message.params.name);
    return send(message, extra);
  };
  const serving = await startNativePublicMcp(backend,
    { writable: true, manifest, closeBackend: async () => {}, catalogProfile: "original-full" }, serverTransport);
  const client = new Client({ name: "direct-module-tools", version: "1" });
  t.after(async () => { try { await client.close(); } finally { await serving.close(); } });
  await client.connect(clientTransport);
  assert.match(client.getInstructions(), /skill_read/);
  assert.match(client.getInstructions(), /Content search.*not|Content search.*documents/);
  const { tools } = await client.listTools();
  assert(tools.some(tool => tool.name === "skill_read"));
  assert(tools.some(tool => tool.name === "note_write" && !tool.annotations.readOnlyHint));
  assert(tools.some(tool => tool.name === "script_read" && tool.annotations.readOnlyHint));
  assert(!tools.some(tool => ["script_write", "prompt_write"].includes(tool.name)));
  const direct = await client.callTool({ name: "skill_read", arguments: { name: "Synthetic" } });
  assert.deepEqual(toolCalls, ["skill_read"], "A common read must require one tool call, not discovery plus execution.");
  const canonical = await serving.invoke("capability_read",
    { operation: "mcp.tool.get_skill", version: 1, arguments: { name: "Synthetic" } });
  assert.deepEqual(direct, canonical);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], calls[1]);
  assert.equal(calls[0].name, "original_mcp_public");
  assert.equal(calls[0].args.tool, "get_skill");
  const inventory = jsonResult(await client.callTool({ name: "capabilities_inventory", arguments: { limit: 50 } }));
  assert.equal(inventory.total, tools.length);
  assert(inventory.schemaBytes <= 32768, `Common exposed schemas exceeded 32 KiB: ${inventory.schemaBytes}`);
  const validators = new AjvJsonSchemaValidator();
  for (const name of ["capabilities_list", "capabilities_search"]) {
    const definition = tools.find(tool => tool.name === name);
    assert(definition);
    const validate = validators.getValidator(definition.inputSchema);
    const base = name === "capabilities_search" ? { query: "" } : {};
    for (const limit of [1, 10]) {
      assert.equal(validate({ ...base, limit }).valid, true);
      const page = await client.callTool({ name, arguments: { ...base, limit } });
      assert.notEqual(page.isError, true);
      assert(jsonResult(page).operations.length <= limit);
    }
    for (const bounds of [{ limit: 0 }, { limit: 11 }, { offset: -1 }]) {
      assert.equal(validate({ ...base, ...bounds }).valid, false);
      assert.equal((await client.callTool({ name, arguments: { ...base, ...bounds } })).isError, true);
    }
  }
  const alias = jsonResult(await client.callTool({ name: "capabilities_search", arguments: { query: "skill_read" } }));
  assert.deepEqual(alias.operations.map(operation => operation.id), ["mcp.tool.get_skill"]);
  const first = jsonResult(await client.callTool({ name: "capabilities_list", arguments: { limit: 2 } }));
  assert(first.nextOffset > 0);
  const next = jsonResult(await client.callTool({ name: "capabilities_list",
    arguments: { limit: 2, offset: first.nextOffset, revision: first.revision } }));
  assert.equal(new Set([...first.operations, ...next.operations].map(operation => operation.id)).size, 4,
    "An agent without search keywords must be able to browse distinct canonical actions.");
  const catalog = jsonResult(await client.callTool({ name: "capabilities_search", arguments: { query: "", limit: 1 } }));
  const oracle = JSON.parse(await readFile(new URL("fixtures/original-public-mcp-discovery.json", import.meta.url), "utf8"));
  assert.equal(catalog.total, oracle.describes.length);
  assert.equal(calls.length, 2, "Inventory/discovery must not run a business handler.");
  const invalid = await client.callTool({ name: "skill_read", arguments: { name: "Synthetic", actor: { id: "local:owner" } } });
  assert.equal(invalid.isError, true);
  assert.equal(calls.length, 2);
  await client.callTool({ name: "mcp_lifecycle_quiesce", arguments: {} });
  const fenced = await client.callTool({ name: "skill_read", arguments: { name: "Synthetic" } });
  assert.equal(fenced.isError, true);
  assert.equal(calls.length, 2, "A direct alias must not bypass lifecycle drain.");
});

test("module shortcuts follow canonical visibility and never create read-only write access", async t => {
  const { manifest } = await fixture(t);
  const backend = { close: async () => {}, invoke: async () => { throw new Error("A denied alias reached the backend."); } };
  const readonly = createNativePublicFacade(backend,
    { writable: false, manifest, closeBackend: async () => {}, catalogProfile: "original-full" });
  t.after(() => readonly.close());
  assert(readonly.definitions.some(tool => tool.name === "note_read"));
  assert(!readonly.definitions.some(tool => ["note_write", "skill_write", "skill_modify"].includes(tool.name)));
  await assert.rejects(readonly.invoke("note_write", { title: "Synthetic", content: "No write" }), /NOT_AVAILABLE/);
  const restricted = createNativePublicFacade(backend, {
    writable: true, manifest, closeBackend: async () => {}, catalogProfile: "original-full",
    availability: { enabledOperationIds: ["mcp.tool.get_note"], disabledOperationIds: [], limitations: ["fixture"] },
  });
  t.after(() => restricted.close());
  assert(restricted.definitions.some(tool => tool.name === "note_read"));
  assert(!restricted.definitions.some(tool => tool.name === "skill_read"));
  await assert.rejects(restricted.invoke("skill_read", { name: "Synthetic" }), /NOT_AVAILABLE/);
});

test("module Note and Skill writes modify actual canonical files and preserve normal read/search behavior", async t => {
  const { parent, manifest } = await fixture(t);
  const data = await initialize(resolve(parent, "workspace"));
  const options = { actor: { id: "mcp:external", canWrite: true } };
  const owner = await RootOwner.open(data, { prepareNative: storage => nativePublicFullOptions(storage, options) });
  const backend = createNativePublicOwnerBackend(owner, options, createNativeScopedNoteRead(owner));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const serving = await startNativePublicMcp(backend,
    { writable: true, manifest, closeBackend: () => owner.close(), toolSurface: "hybrid" }, serverTransport);
  const client = new Client({ name: "actual-module-writes", version: "1" });
  t.after(async () => { try { await client.close(); } finally { await serving.close(); } });
  await client.connect(clientTransport);
  const call = async (name, args) => {
    const response = await client.callTool({ name, arguments: args });
    assert.equal(response.isError, false, JSON.stringify(response));
    return jsonResult(response);
  };
  const note = await call("note_write", { title: "Alias entry", content: "Initial alias content." });
  assert.equal(note.ok, true);
  await call("note_modify", { slug: note.slug, content: "Updatedaliasneedle content." });
  assert.match(await readFile(resolve(data, "notes", `${note.slug}.md`), "utf8"), /Updatedaliasneedle/);
  const direct = await client.callTool({ name: "note_read", arguments: { slug: note.slug } });
  const canonical = await client.callTool({ name: "capability_read",
    arguments: { operation: "mcp.tool.get_note", version: 1, arguments: { slug: note.slug } } });
  assert.deepEqual(direct, canonical);
  assert.equal((await call("note_search", { query: "Updatedaliasneedle" })).length, 1);
  await call("note_list", {});
  assert.equal((await call("skill_write", { name: "Alias skill", content: "Initial skill content." })).ok, true);
  await call("skill_modify", { name: "Alias skill", content: "Updatedskillneedle content." });
  assert.match(await readFile(resolve(data, "skills", "Alias skill.md"), "utf8"), /Updatedskillneedle/);
  await call("skill_read", { name: "Alias skill" });
  assert.equal((await call("skill_search", { query: "Updatedskillneedle" })).length, 1);
  await call("skill_list", {});
});

test("native facade validates strict versions, gates, defaults, tokens and never accepts actor overrides", async t => {
  const { manifest } = await fixture(t);
  const calls = [];
  const backend = {
    close: async () => {},
    invoke: async (name, args) => {
      calls.push({ name, args });
      if (name.startsWith("legacy_capability")) return { content: [], structuredContent: { result: { ok: true } } };
      return { content: [], structuredContent: { value: {}, text: '{"ok":true}' } };
    },
  };
  const facade = createNativePublicFacade(backend, { writable: true, manifest, closeBackend: async () => {} });
  t.after(() => facade.close());
  for (const name of ["legacy_knowledge_read", "legacy_capability_call", "__proto__", "constructor"])
    await assert.rejects(facade.invoke(name, {}), /NOT_AVAILABLE/);
  for (const version of ["1", true, null, 2])
    await assert.rejects(facade.invoke("capability_read", { operation: "mcp.tool.get_note", version, arguments: {} }), /Pin version 1/);
  await assert.rejects(facade.invoke("capability_read", {
    operation: "mcp.tool.get_note", version: 1, arguments: {}, actor: { id: "local:owner" },
  }), /INVALID_ARGUMENT/);
  await assert.rejects(facade.invoke("capability_call", {
    operation: "mcp.tool.get_note", version: 1, arguments: {},
  }), /matching read or mutation/);
  await assert.rejects(facade.invoke("capability_read", {
    operation: "mcp.tool.get_note", version: 1, arguments: {}, worker_token: "unscoped",
  }), /no worker_token/);
  assert.equal(calls.length, 0);
  const value = await facade.invoke("capability_read", { operation: "mcp.tool.get_note", version: 1, arguments: {} });
  assert.deepEqual(value, { content: [{ type: "text", text: '{"ok":true}' }], isError: false });
  assert.deepEqual(calls.pop(), { name: "legacy_knowledge_read", args: { tool: "get_note", arguments: { id: "", slug: null } } });
  await facade.invoke("capability_read", {
    operation: "mcp.tool.list_workitems", version: 1, arguments: { board_slug: "Board", limit: "2", actionable: "false" },
    worker_token: "exact-board",
  });
  const forwarded = calls.pop();
  assert.equal(forwarded.name, "legacy_capability_read");
  assert.equal(forwarded.args.workerToken, "exact-board");
  assert.equal(forwarded.args.args.operation, "todo.workitem.list");
  assert.equal(forwarded.args.args.arguments.limit, 2);
  assert.equal(forwarded.args.args.arguments.actionable, false);
  assert(!("worker_token" in forwarded.args.args.arguments));
  assert.throws(() => createNativePublicFacade(backend, {
    writable: true, manifest, closeBackend: async () => {}, profile: "legacy",
  }), /compact only/);
});

for (const { writable, assets = false } of [{ writable: false }, { writable: true }, { writable: true, assets: true }])
test(`native public protocol matches active Python facade (${writable ? "writable" : "read-only"}${assets ? ", assets" : ""})`,
  { timeout: 90_000 }, async t => {
    const { parent, generation } = await fixture(t);
    const data = await initialize(resolve(parent, "workspace"));
    await writeFile(resolve(data, "notes", "Example.md"),
      "---\nid: native-public-note\ntitle: Example\nrevision: 1\ndeleted: false\n---\nA complete original Note body.\n");
    const calls = [
      ["capabilities_inventory", {}],
      ["capabilities_search", { query: "", path: "", limit: 10 }],
      ["capabilities_search", { query: "note", limit: 3 }],
      ["capabilities_search", { query: "GET_NOTE", limit: 1 }],
      ["capabilities_search", { query: "zzzz_no_match", limit: 10 }],
      ["capabilities_list", { path: "todo" }],
      ["capabilities_search", { query: "workitem", path: "todo", limit: 10 }],
      ["capabilities_search", { query: "proposal", path: "memory" }],
      ["capabilities_search", { query: "", path: "memory", limit: 10 }],
      ["capabilities_search", { query: "", revision: "0".repeat(64), limit: 10 }],
      ["capabilities_search", { query: "", path: "memory", revision: "0".repeat(64) }],
      ["capabilities_describe", { operation: "mcp.tool.get_note" }],
      ["capabilities_describe", { operation: "todo.board.get" }],
      ["capabilities_describe", { operation: "memory.record.search" }],
      ["capabilities_describe", { operation: "memory.record.confirm" }],
      ["capability_read", { operation: "mcp.tool.get_note", version: 1, arguments: { slug: "Example" } }],
      ["capability_read", { operation: "mcp.tool.list_notes", version: 1, arguments: { limit: "1", recursive: "true" } }],
      ["capability_read", { operation: "todo.board.list", version: 1, arguments: {} }],
      ["capability_read", { operation: "mcp.tool.list_boards", version: 1, arguments: {} }],
      ["capability_read", { operation: "mcp.tool.action_capabilities", version: 1, arguments: {} }],
      ["capability_read", { operation: "mcp.tool.search_notes", version: 1, arguments: { query: "complete" } }],
      ["capability_read", { operation: "mcp.tool.search_notes", version: 1, arguments: { query: '"unterminated', limit: 0 } }],
      ["capability_read", { operation: "mcp.tool.search_notes", version: 1, arguments: { query: "or", detail: "legacy", route: "lexical" } }],
      ["capability_read", { operation: "mcp.tool.get_note", version: "1", arguments: {} }],
      ["capability_call", { operation: "mcp.tool.get_note", version: 1, arguments: {} }],
      ["capability_read", { operation: "mcp.tool.get_note", version: 1, arguments: {}, worker_token: "forbidden" }],
      ["capability_read", { operation: "mcp.tool.get_note", version: 1, arguments: {}, actor: "owner" }],
      ["capabilities_describe", { operation: "mcp.tool.asset_classify_preview" }],
      ["capabilities_describe", { operation: "mcp.tool.knowledge_snapshot_configure" }],
      ["capability_call", { operation: "memory.proposal.create", version: 1, arguments: {} }],
      ["capabilities_search", { query: "", offset: "0", limit: "2" }],
      ["capability_read", { operation: "mcp.tool.get_note", version: 1, arguments: { id: 17 } }],
    ];
    const captures = [];
    for (const native of [false, true]) {
      const transport = new StdioClientTransport({
        command: native ? process.execPath : process.env.PKM_TEST_PYTHON ?? "python",
        args: native ? [resolve("dist/cli.js"), "mcp", "--data", data, "--experimental-legacy-mcp",
          "--native-public-mcp", "--managed-generation", generation, ...(!writable ? ["--read-only"] : []),
          ...(assets ? ["--allow-asset-classification"] : [])]
          : [resolve("compat/legacy-compact-mcp.py"), "--data", data, "--node", process.execPath,
            "--managed-generation", generation, ...(writable ? ["--allow-writes"] : []),
            ...(assets ? ["--allow-asset-classification"] : [])],
        env: { ...process.env, PKM_CAPABILITY_PROFILE: "compact" }, stderr: "pipe",
      });
      let stderr = "";
      transport.stderr?.on("data", chunk => { stderr += chunk; });
      const client = new Client({ name: "native-public-oracle", version: "1" });
      try {
        await client.connect(transport);
        const tools = await client.listTools();
        const values = [];
        for (const [name, args] of calls) values.push(await client.callTool({ name, arguments: args }));
        const contracts = [], pages = [];
        let offset = 0, revision;
        do {
          const response = await client.callTool({ name: "capabilities_search",
            arguments: { query: "", offset, limit: 10, ...(revision ? { revision } : {}) } });
          assert(!response.isError, stderr);
          pages.push(response);
          const page = jsonResult(response);
          contracts.push(...page.operations);
          offset = page.nextOffset; revision = page.revision;
        } while (offset !== null);
        captures.push({ tools, values, contracts, pages });
        if (native) {
          const drained = jsonResult(await client.callTool({ name: "mcp_lifecycle_quiesce", arguments: {} }));
          assert.equal(drained.phase, "drained");
          assert.equal(drained.inFlight, 0);
          assert.equal(drained.uncertainCalls, 0);
          const reopened = await import("../dist/storage.js").then(({ Storage }) => Storage.open(data, { deferRecovery: true }));
          await reopened.close();
        }
      } finally { await client.close(); }
    }
    const [python, native] = captures;
    assert.deepEqual(native.tools, python.tools);
    assert.deepEqual(native.contracts, python.contracts);
    assert.deepEqual(native.pages, python.pages);
    for (let index = 0; index < calls.length; index++) {
      if (python.values[index].isError) {
        assert.equal(native.values[index].isError, true, JSON.stringify(calls[index]));
        assert.equal(native.values[index].structuredContent, undefined);
      } else {
        assert.deepEqual(native.values[index], python.values[index], JSON.stringify(calls[index]));
      }
    }
    assert((await readFile(resolve(data, "notes", "Example.md"), "utf8")).includes("complete original"));
  });
