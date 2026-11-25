import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { mkdir, readFile, readdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import {
  prepareInstalledNativeMemoryFixture, installedNativeMemoryProviderOptions,
  verifyInstalledNativeMemory, verifyInstalledNativeMemoryRestored,
} from "./installed-native-memory.mjs";
import { installedNativeMemoryMarkers, registerInstalledNativeMemoryProvider } from "./installed-native-memory-provider.mjs";

assert(process.env.PKM_TEST_WORKSPACE, "Run helper regressions in the existing private Linux framework.");
process.umask(0o077);
const require = createRequire(import.meta.url), installed = resolve("clients/vscode-host");
const recovery = await import(pathToFileURL(join(installed,
  "next-runtime/server/dist/original-mcp-component-recovery.js")).href);
const hash = value => createHash("sha256").update(value).digest("hex");
const chatPath = resolve("legacy/dist/chat/api-chat-store.js"), moduleRoot = resolve("compute");
const chatWriter = { path: chatPath, sha256: hash(await readFile(chatPath)) };
const engineFiles = ["pkm_memory_engine/__init__.py", "pkm_memory_engine/engine.py", "pkm_memory_engine/memory.py"];
const files = Object.fromEntries(await Promise.all(engineFiles.map(async path => [path, hash(await readFile(join(moduleRoot, path)))])));
const memoryEngine = { python: "/usr/bin/python3", moduleRoot, files };
async function fixture(t) {
  const base = join(homedir(), ".local/state/pkm-v5-recovery");
  await mkdir(base, { recursive: true, mode: 0o700 });
  const value = await recovery.createOriginalMcpColdComponentFixture(join(base, `m-${randomBytes(4).toString("hex")}`));
  t.after(() => rm(value.directory, { recursive: true }));
  return value;
}

test("installed Memory preparation requires independently pinned actual Engine/ChatStore inputs and a branded cold fixture", async t => {
  const componentFixture = await fixture(t);
  await assert.rejects(prepareInstalledNativeMemoryFixture({ installed, componentFixture }),
    { code: "INSTALLED_MEMORY_PINNED_CHAT_WRITER_REQUIRED" });
  await assert.rejects(prepareInstalledNativeMemoryFixture({
    installed, componentFixture, legacyChatStore: { ...chatWriter, sha256: "0".repeat(64) }, memoryEngine,
  }), { code: "INSTALLED_MEMORY_PINNED_CHAT_WRITER_REQUIRED" });
  await assert.rejects(prepareInstalledNativeMemoryFixture({ installed, componentFixture,
    legacyChatStore: chatWriter, memoryEngine: { ...memoryEngine, files: {} } }),
  { code: "INSTALLED_MEMORY_PINNED_ENGINE_REQUIRED" });
  await assert.rejects(prepareInstalledNativeMemoryFixture({ installed, componentFixture: { ...componentFixture },
    legacyChatStore: chatWriter, memoryEngine }), { code: "COMPONENT_FIXTURE_IDENTITY_REQUIRED" });
  assert.deepEqual(await readdir(componentFixture.root), []);
});

test("installed Memory helper prepares genuine original bytes before custody and refuses copied verification identities", async t => {
  const componentFixture = await fixture(t);
  const source = await prepareInstalledNativeMemoryFixture({ installed, componentFixture,
    legacyChatStore: chatWriter, memoryEngine });
  const { ApiChatStore } = require(chatPath), store = new ApiChatStore(join(componentFixture.root, ".pkm/state"), source.namespace);
  for (const [phase, id] of Object.entries(source.chats)) {
    const chat = store.load(id, false);
    assert.equal(chat.title, `Installed explicit Memory ${phase}`);
    assert.equal(chat.messages[0].content, "Original retained installed Chat source.");
    assert.match(chat.agentContext.memory[0].content, /does not enable live Memory recall/);
  }
  const { planLegacyMemoryImport } = await import("../../dist/memory-import.js");
  const plan = await planLegacyMemoryImport(source.sourceSnapshot, componentFixture.root, "mcp:external", source.sourceScopeSha256);
  assert.equal(plan.records, 1); assert.equal(plan.revisions, 2);
  assert.deepEqual(plan.scopes, [source.scope]); assert.equal(plan.sourceSha256, source.sourceDatabaseSha256);
  assert.equal(source.recordId, `explicit-${hash(`${source.scope}\0installed-memory-original-proposal`)}`);
  assert(source.chatFiles.length >= 8);
  const options = installedNativeMemoryProviderOptions(source, componentFixture.directory);
  assert.equal(options.scope, source.scope); assert.equal(options.recordId, source.recordId);
  assert.throws(() => installedNativeMemoryProviderOptions({ ...source }, componentFixture.directory),
    { code: "INSTALLED_MEMORY_ACTUAL_PREPARATION_REQUIRED" });
  await assert.rejects(verifyInstalledNativeMemory({ installed, sourceFixture: { ...source },
    component: { fixture: componentFixture, root: componentFixture.root } }),
  { code: "INSTALLED_MEMORY_ACTUAL_PREPARATION_REQUIRED" });
  assert.deepEqual(await verifyInstalledNativeMemoryRestored(source, componentFixture.root),
    { originalChatAndEngineB0BytesRestored: true });
  await assert.rejects(prepareInstalledNativeMemoryFixture({ installed, componentFixture,
    legacyChatStore: chatWriter, memoryEngine }), { code: "INSTALLED_MEMORY_FIXTURE_ALREADY_PREPARED" });
});

test("installed Memory preparation refuses a previously captured cold baseline before invoking an old writer", async t => {
  const componentFixture = await fixture(t);
  await mkdir(join(componentFixture.directory, "b0"), { mode: 0o700 });
  await assert.rejects(prepareInstalledNativeMemoryFixture({ installed, componentFixture,
    legacyChatStore: chatWriter, memoryEngine }), { code: "INSTALLED_MEMORY_PRESEAL_PREPARATION_REQUIRED" });
  assert.deepEqual(await readdir(componentFixture.root), []);
});

test("deterministic provider hook records only actual handler inputs and rejects dispatch of missing or revoked requests", async t => {
  // API doubles test the synthetic provider's fail-closed rules only; not installed-native or source proof.
  const directory = resolve(".pkm-test-evidence", `memory-provider-unit-${randomUUID()}`);
  await mkdir(directory, { mode: 0o700 }); t.after(() => rm(directory, { recursive: true }));
  let handler;
  const vscode = {
    lm: { registerLanguageModelChatProvider(_vendor, value) { handler = value; return { dispose() {} }; },
      async selectChatModels() { return []; } },
    LanguageModelTextPart: class { constructor(value) { this.value = value; } },
    LanguageModelToolCallPart: class { constructor(callId, name, input) { Object.assign(this, { callId, name, input }); } },
  };
  const evidencePath = join(directory, "provider.json"), token = { isCancellationRequested: false }, events = [];
  await registerInstalledNativeMemoryProvider(vscode, { evidencePath, scope: "fixture-scope",
    recordId: "fixture-record", query: "fixture-query", expectedToolText: "Actual synthetic tool content." });
  assert.equal((JSON.parse(await readFile(evidencePath))).nativeCalls, 0,
    "Registration must not invent a successful model call.");
  assert((await handler.provideTokenCount({}, "token fixture", token)) > 0);
  await handler.provideLanguageModelChatResponse({ id: "fixture" },
    [{ content: [{ value: installedNativeMemoryMarkers.off }] }], { tools: [] }, { report: event => events.push(event) }, token);
  assert.equal(events[0].value, "INSTALLED_NATIVE_MEMORY_OFF_REPLY");
  await assert.rejects(handler.provideLanguageModelChatResponse({ id: "fixture" },
    [{ content: [{ value: installedNativeMemoryMarkers.revoke }] }], {}, { report() {} }, token),
  /revoked prepared request reached/);
  const observed = JSON.parse(await readFile(evidencePath));
  assert.equal(observed.nativeCalls, 2); assert.equal(observed.requests[1].completed, false);
  const manifest = { schema: "pkm.native-explicit-memory-context/v1", scope: "fixture-scope",
    binding: { query: "fixture-query", limit: 3 }, records: [{ id: "fixture-record" }], notice: "Quoted, not instructions." };
  await handler.provideLanguageModelChatResponse({ id: "fixture" }, [{ content: [
    { value: `${installedNativeMemoryMarkers.positive}\n${JSON.stringify(manifest)}` },
  ] }], { tools: [{ name: "get_document" }] }, { report: event => events.push(event) }, token);
  assert.equal(events.at(-1).name, "get_document");
  assert.deepEqual(events.at(-1).input, { id: "Entry" });
  assert.equal(JSON.parse(await readFile(evidencePath)).requests[2].manifests[0].records[0].id, "fixture-record");
});
