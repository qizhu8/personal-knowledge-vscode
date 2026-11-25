import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { chmod, lstat, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { installedNativeMemoryMarkers, installedNativeMemoryVendor } from "./installed-native-memory-provider.mjs";
import { startInstalledNativeMemoryUi } from "./installed-native-memory-ui.mjs";

const require = createRequire(import.meta.url), preparations = new WeakMap();
const hash = value => createHash("sha256").update(value).digest("hex");
const load = (installed, name) => import(pathToFileURL(join(installed, "next-runtime/server/dist", `${name}.js`)).href);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function fail(code) { throw Object.assign(new Error(code), { code }); }
async function pinnedFile(value, code) {
  if (!value || typeof value.path !== "string" || !isAbsolute(value.path) || resolve(value.path) !== value.path
    || !/^[a-f0-9]{64}$/.test(value.sha256)) fail(code);
  const stat = await lstat(value.path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 8_388_608
    || await realpath(value.path) !== value.path || hash(await readFile(value.path)) !== value.sha256) fail(code);
  return value.path;
}
async function originalFiles(root) {
  const files = [];
  async function visit(directory, prefix) {
    for (const name of (await readdir(directory)).sort()) {
      const path = join(directory, name), member = `${prefix}/${name}`, stat = await lstat(path);
      if (stat.isSymbolicLink()) fail("INSTALLED_MEMORY_ORIGINAL_SOURCE_SYMLINK");
      if (stat.isDirectory()) await visit(path, member);
      else if (stat.isFile() && stat.nlink === 1) files.push({ path: member, bytes: await readFile(path) });
      else fail("INSTALLED_MEMORY_ORIGINAL_SOURCE_ENTITY");
    }
  }
  for (const directory of ["api-chats", "api-chat-history", "agent-groups"]) {
    const path = join(root, ".pkm/state", directory);
    try { await visit(path, `.pkm/state/${directory}`); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  return files;
}
async function unchanged(state, root = state.value.root) {
  for (const file of state.files) assert.deepEqual(await readFile(join(root, file.path)), file.bytes);
  assert.equal(hash(await readFile(state.value.sourceSnapshot)), state.value.sourceDatabaseSha256);
}
async function waitJson(path, timeoutMs, check = () => {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    check();
    try {
      const value = JSON.parse(await readFile(path, "utf8"));
      if (value.failed) throw new Error(`Installed Memory UI failed: ${value.error}`);
      return value;
    } catch (error) {
      if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
    }
    await delay(50);
  }
  throw new Error(`Installed Memory evidence timed out: ${path}`);
}

/** Before B0/custody only. Both real old-writer inputs must be independently pinned. */
export async function prepareInstalledNativeMemoryFixture({ installed, componentFixture, legacyChatStore, memoryEngine }) {
  const recovery = await load(installed, "original-mcp-component-recovery");
  await recovery.assertOriginalMcpColdComponentFixture(componentFixture);
  if (preparations.has(componentFixture)) fail("INSTALLED_MEMORY_FIXTURE_ALREADY_PREPARED");
  for (const path of [join(componentFixture.directory, "b0"), join(componentFixture.directory, "custody"),
    join(componentFixture.root, ".pkm-next-original-mcp.json")]) {
    try { await lstat(path); fail("INSTALLED_MEMORY_PRESEAL_PREPARATION_REQUIRED"); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  const chatStorePath = await pinnedFile(legacyChatStore, "INSTALLED_MEMORY_PINNED_CHAT_WRITER_REQUIRED");
  if (!memoryEngine || typeof memoryEngine.python !== "string" || !isAbsolute(memoryEngine.python)
    || typeof memoryEngine.moduleRoot !== "string" || !isAbsolute(memoryEngine.moduleRoot)
    || await realpath(memoryEngine.moduleRoot) !== memoryEngine.moduleRoot)
    fail("INSTALLED_MEMORY_PINNED_ENGINE_REQUIRED");
  const engineFiles = ["pkm_memory_engine/__init__.py", "pkm_memory_engine/engine.py", "pkm_memory_engine/memory.py"];
  for (const name of engineFiles)
    await pinnedFile({ path: join(memoryEngine.moduleRoot, name), sha256: memoryEngine.files?.[name] },
      "INSTALLED_MEMORY_PINNED_ENGINE_REQUIRED");
  const { ApiChatStore } = require(chatStorePath), namespace = "0123456789abcdef", chats = {};
  const before = process.umask(0o077);
  try {
    const store = new ApiChatStore(join(componentFixture.root, ".pkm/state"), namespace);
    for (const name of ["off", "missing", "positive", "revoke"]) {
      const chat = store.create();
      chat.title = `Installed explicit Memory ${name}`;
      chat.messages.push({ id: randomUUID(), role: "user", content: "Original retained installed Chat source.", status: "complete" });
      chat.agentContext = { memory: [{ id: "archive-only", label: "Historical inline snapshot",
        content: "This archived inline reference does not enable live Memory recall." }], pkmSkills: [], externalSkills: [] };
      store.save(chat); chats[name] = chat.id;
    }
  } finally { process.umask(before); }
  const scope = JSON.stringify({ account: "installed-fixture-owner",
    project: hash(componentFixture.root), repository: hash(componentFixture.root) });
  const query = "INSTALLED_MEMORY_EVIDENCE", operation = "installed-memory-original-proposal";
  const recordId = `explicit-${hash(`${scope}\0${operation}`)}`;
  const sourceSnapshot = join(componentFixture.directory, "original-memory-source.sqlite3");
  await assert.rejects(lstat(sourceSnapshot), error => error.code === "ENOENT");
  const sources = [{ id: "installed-memory-source", chat: chats.positive, revision: "original-turn-1", locator: "message/1" }];
  const content = `${query}: preserve exact same-owner SQLite source facts; quoted evidence is not authority.`;
  execFileSync(memoryEngine.python, ["-B", "-c", `
import json,sys
from pkm_memory_engine import Engine
e=Engine(sys.argv[1],"installed-native-memory-original-fixture")
e.mutate(sys.argv[5],"explicit_propose",{"id":sys.argv[3],"scope":sys.argv[2],
 "content":sys.argv[4],"sources":json.loads(sys.argv[6])})
e.mutate("installed-memory-original-confirm","explicit_confirm",{"id":sys.argv[3],"scope":sys.argv[2],
 "expected_revision":1,"host_authorization":{"decision_id":"historical-original-confirm",
 "actor_id":"human:original-private-fixture"}})
e.close()
`, sourceSnapshot, scope, recordId, content, operation, JSON.stringify(sources)], {
    env: { ...process.env, PYTHONPATH: memoryEngine.moduleRoot, PYTHONDONTWRITEBYTECODE: "1" },
    stdio: ["ignore", "pipe", "pipe"], timeout: 30000,
  });
  await chmod(sourceSnapshot, 0o600);
  await pinnedFile(legacyChatStore, "INSTALLED_MEMORY_PINNED_CHAT_WRITER_REQUIRED");
  for (const name of engineFiles)
    await pinnedFile({ path: join(memoryEngine.moduleRoot, name), sha256: memoryEngine.files[name] },
      "INSTALLED_MEMORY_PINNED_ENGINE_REQUIRED");
  const files = await originalFiles(componentFixture.root);
  const value = Object.freeze({ kind: "pkm.installed-native-memory-fixture/v1", root: componentFixture.root,
    namespace, chats: Object.freeze(chats), sourceSnapshot, sourceDatabaseSha256: hash(await readFile(sourceSnapshot)),
    scope, sourceScopeSha256: hash(scope), recordId, query, content, sources: Object.freeze(sources.map(Object.freeze)),
    originalChatWriterSha256: legacyChatStore.sha256,
    originalEngineFiles: Object.freeze({ ...memoryEngine.files }),
    chatFiles: Object.freeze(files.map(file => Object.freeze({ path: file.path, sha256: hash(file.bytes) }))) });
  const state = { componentFixture, value, files };
  preparations.set(componentFixture, state); preparations.set(value, state);
  return value;
}

export function installedNativeMemoryProviderOptions(sourceFixture, root) {
  if (!preparations.has(sourceFixture)) fail("INSTALLED_MEMORY_ACTUAL_PREPARATION_REQUIRED");
  return Object.freeze({ evidencePath: join(root, "native-memory-provider.json"),
    scope: sourceFixture.scope, recordId: sourceFixture.recordId, query: sourceFixture.query,
    expectedToolText: "Approved genuine cold Note mutation." });
}

/** Real UI stage contract for the parent-owned browser driver; these are not approval receipts. */
export const installedNativeMemoryUiStages = Object.freeze([
  "native-memory-chat-source-admit", "native-memory-default-off",
  "native-memory-missing-grant", "native-memory-source-admit", "native-memory-positive",
  "native-memory-revoke-pending", "native-memory-complete",
]);

/**
 * Same installed module identity/actual signed sources only. Call before the Todo
 * helper closes the full session; no supplied source policy or success callback.
 */
export async function verifyInstalledNativeMemory({ root, installed, component, sourceFixture,
  payloadBuildId, python, env, port, timeoutMs = 120000 }) {
  const state = preparations.get(sourceFixture);
  if (!state || component.fixture !== state.componentFixture || component.root !== sourceFixture.root)
    fail("INSTALLED_MEMORY_ACTUAL_PREPARATION_REQUIRED");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000)
    fail("INSTALLED_MEMORY_BOUNDED_TIMEOUT_REQUIRED");
  const rootStat = await lstat(root);
  if (!isAbsolute(root) || resolve(root) !== root || await realpath(root) !== root
    || !/^\.installed-host-[a-f0-9-]{36}$/.test(basename(root)) || !rootStat.isDirectory() || rootStat.isSymbolicLink()
    || rootStat.uid !== process.getuid() || rootStat.mode & 0o077)
    fail("INSTALLED_MEMORY_PRIVATE_DRIVER_REQUIRED");
  const recovery = await load(installed, "original-mcp-component-recovery");
  await recovery.assertOriginalMcpColdComponentFixture(component.fixture);
  const host = await component.complete(), full = await component.owner.ensureFull();
  (await load(installed, "root-owner")).assertRootOwner(component.owner);
  (await load(installed, "original-mcp-native-host")).assertOriginalMcpNativeHost(host, component.storage);
  assert.equal(full.storage, component.storage);
  const rpc = await load(installed, "original-mcp-native-chat-rpc");
  if (!host.nativeChat?.apiChat?.memory) fail("INSTALLED_MEMORY_COLD_MODEL_RESOURCE_COMPOSITION_REQUIRED");
  rpc.assertOriginalMcpNativeChatRpcPort(host.nativeChat);
  assert.equal(host.options.providerTransport.supports("openai-compatible"), false);
  assert.equal(host.options.providerTransport.supports("azure-openai"), false);
  const policies = component.sourcePolicies(), sourcePolicy = await load(installed, "original-mcp-native-source-policy");
  sourcePolicy.assertOriginalMcpNativeSourcePolicy(policies.chat, component.storage, host, "chat");
  sourcePolicy.assertOriginalMcpNativeSourcePolicy(policies.memory, component.storage, host, "memory");
  const first = JSON.parse(await readFile(join(root, "native-identity-first.json"), "utf8"));
  const identityProof = JSON.parse(await readFile(join(root, "native-identity-passed.json"), "utf8"));
  const member = typeof first.result?.path === "string" ? relative(root, first.result.path) : "";
  if (!member || member === ".." || member.startsWith(`..${sep}`) || isAbsolute(member)
    || await realpath(first.result.path) !== first.result.path) fail("INSTALLED_MEMORY_ENROLLED_PROFILE_REQUIRED");
  assert.equal(await readFile(first.result.path, "utf8"), first.publicRecord);
  assert.equal(identityProof.passed, true); assert.equal(identityProof.realInstalledExtension, true);
  assert.equal(identityProof.identitySha256, first.result.sha256);
  assert.equal(component.custody.profileSha256, first.result.profileSha256,
    "The genuine profile must be enrolled before sealing; no profile repinning is permitted.");
  const identity = await load(installed, "original-mcp-native-identity");
  identity.verifyOriginalMcpNativeIdentity(JSON.parse(first.publicRecord), first.result.sha256, first.result.profileSha256);
  const descriptor = JSON.parse(await readFile(component.attachmentDescriptorPath, "utf8"));
  assert.equal(hash(await readFile(component.attachmentDescriptorPath)), component.attachmentDescriptorSha256);
  assert.equal(descriptor.identitySha256, first.result.sha256);
  assert.equal(descriptor.binding.payloadBuildId, payloadBuildId);
  assert.equal(descriptor.binding.hostEntrySha256, hash(await readFile(join(installed, "dist/extension.cjs"))));
  assert.equal(descriptor.binding.planSha256, component.custody.planSha256);
  assert.equal(host.nativeChat.session.binding.root, component.root);
  assert.equal(host.nativeChat.session.activationId, host.receipt.epoch);
  assert.equal(host.nativeChat.session.identitySha256, first.result.sha256);
  const lease = { ...component.owner.workspaceLease() }, actor = Object.freeze({ id: "mcp:external", canWrite: true });
  const providerPath = join(root, "native-memory-provider.json");
  const provider = () => waitJson(providerPath, timeoutMs);
  const progress = stage => writeFile(join(root, "progress.json"), JSON.stringify({ stage }), { mode: 0o600 });
  const source = await load(installed, "original-mcp-api-chat-source"), domains = await load(installed, "original-mcp-domains");
  const domainState = await load(installed, "original-mcp-domain-state");
  const memoryApi = await load(installed, "original-mcp-memory-context");
  const execution = await load(installed, "original-mcp-api-chat-execution");
  const { originalNativeChatDigest } = await load(installed, "original-mcp-api-chat-contracts");
  const core = async (operation, arguments_) => {
    const response = await full.runtime.core.dispatch("capability_read", { operation, version: 1, arguments: arguments_ }, actor);
    if (response.error) throw Object.assign(new Error(response.error.message), { code: response.error.code });
    return response.result;
  };
  const stage = join(component.fixture.directory, "native-chat-source-stage");
  await mkdir(stage, { mode: 0o700 });
  const plan = await source.planOriginalMcpApiChatSource(component.storage, host, {
    stagingDirectory: stage, limits: { maxChats: 100, maxMessagesPerChat: 1000, maxMessages: 4000 },
  });
  const catalogue = await host.nativeChat.models.catalogue(new AbortController().signal);
  const model = catalogue.models.find(item => item.vendor === installedNativeMemoryVendor);
  assert(model && model.label === "Synthetic installed Memory evidence model",
    "The independently registered actual synthetic Memory model must be callable.");
  const requests = Object.fromEntries(Object.keys(sourceFixture.chats).map(name => {
    const commandId = `installed-native-memory-${name}`, chatId = sourceFixture.chats[name];
    const prompt = `${installedNativeMemoryMarkers[name]}: use only explicitly selected current evidence.`;
    return [name, { commandId, chatId, prompt, chatUrl: `pkm://chats/${sourceFixture.namespace}/${chatId}`,
      requestId: hash(JSON.stringify([component.workspaceId, commandId]).replace(",", ", ")),
      argumentsSha256: originalNativeChatDigest({ chatId, prompt, hardToolRoundLimit: 1 }) }];
  }));
  await writeFile(join(root, "native-memory-ui-contract.json"), JSON.stringify({
    schema: "pkm.installed-native-memory-ui/v1", sourceRoot: component.root,
    profileSha256: component.custody.profileSha256, sourcePlanSha256: plan.planSha256,
    sourceDatabaseSha256: sourceFixture.sourceDatabaseSha256, sourceScopeSha256: sourceFixture.sourceScopeSha256,
    scope: sourceFixture.scope, query: sourceFixture.query, stages: installedNativeMemoryUiStages,
    modelLabel: model.label, modelId: model.id, wireModelId: model.nativeModelId, providerVendor: installedNativeMemoryVendor,
    workspaceId: component.workspaceId, nativeEpoch: host.receipt.epoch, requests,
    revocationHandshake: { visible: "native-memory-revoke-model-visible.json",
      revoked: "native-memory-revoked-before-click.json", lateClick: "native-memory-revoke-clicked.json" },
  }), { mode: 0o600, flag: "wx" });
  const ui = await startInstalledNativeMemoryUi({ root, python, env, port, timeoutMs });
  const observerAbort = new AbortController();
  void ui.done.catch(error => observerAbort.abort(error));
  const checkUi = () => { if (ui.error) throw ui.error; };
  let runtime;
  try {
    await waitJson(join(root, "native-memory-ui-ready.json"), timeoutMs, checkUi);
    await progress("native-memory-chat-source-admit");
    await source.admitOriginalMcpApiChatSource(component.storage, host, plan, policies.chat);
    const sourceGrant = source.readOriginalMcpApiChatSourceSession(component.storage, host);
    assert.equal(Atomics.load(new Int32Array(sourceGrant.revocation), 0), 0);
    assert.equal(domainState.readOriginalMcpDomain(component.root, "memory"), undefined);
    await assert.rejects(memoryApi.readOriginalMcpMemoryContext(component.owner, host, { query: sourceFixture.query }));
    runtime = await (await load(installed, "original-mcp-api-chat")).createOriginalMcpApiChatRuntime(component.owner, actor, host);
    const invoke = async (tool, args) => {
      checkUi();
      const reply = await runtime.invoke(tool, args, observerAbort.signal);
      assert(!reply.isError, JSON.stringify(reply));
      return reply.structuredContent ?? JSON.parse(reply.content[0].text);
    };
    const settled = async request => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        checkUi();
        const receipt = await invoke("api_chat_request_get", { host_id: component.workspaceId, request_id: request.request_id });
        if (!["queued", "running"].includes(receipt.status)) return receipt;
        await delay(50);
      }
      throw new Error(`Installed Memory Chat request did not settle: ${request.request_id}`);
    };
    const submit = name => invoke("api_chat_send", {
      host_id: component.workspaceId, chat_id: sourceFixture.chats[name],
      prompt: `${installedNativeMemoryMarkers[name]}: use only explicitly selected current evidence.`,
      command_id: `installed-native-memory-${name}`, hard_tool_round_limit: 1,
    });
    const send = async name => settled(await submit(name));
    const beforeProvider = await provider();
    assert.equal(beforeProvider.nativeCalls, 0);
    await progress("native-memory-default-off");
    const off = await send("off");
    assert.equal(off.status, "succeeded", off.error);
    assert.equal(off.result.reply.content, "INSTALLED_NATIVE_MEMORY_OFF_REPLY");
    let observed = await provider();
    assert.equal(observed.nativeCalls, 1);
    assert.equal(observed.requests[0].marker, "off");
    assert.deepEqual(observed.requests[0].manifests, []);
    assert.equal(domainState.readOriginalMcpDomain(component.root, "memory"), undefined,
      "Default off must not call or implicitly admit the live Memory source.");
    await progress("native-memory-missing-grant");
    const missing = await send("missing");
    assert.equal(missing.status, "failed");
    assert.match(missing.error, /ORIGINAL_MEMORY_SCOPE|Memory source|Memory admission/i);
    assert.equal((await provider()).nativeCalls, 1);
    await assert.rejects(core("chat.session.get", { id: sourceFixture.chats.missing }));
    await progress("native-memory-source-admit");
    const memoryStage = join(component.fixture.directory, "native-memory-import-stage");
    await mkdir(memoryStage, { mode: 0o700 });
    const imported = await domains.hydrateOriginalMcpMemory(component.storage, host, {
      sourceSnapshot: sourceFixture.sourceSnapshot, sourceScopeSha256: sourceFixture.sourceScopeSha256,
      stagingDirectory: memoryStage,
    }, policies.memory);
    const memory = await memoryApi.readOriginalMcpMemoryContext(component.owner, host, { query: sourceFixture.query });
    assert.equal(memory.scope, sourceFixture.scope);
    assert.deepEqual(memory.records.map(record => record.id), [sourceFixture.recordId]);
    assert.equal(memory.records[0].content, sourceFixture.content);
    assert.deepEqual(memory.records[0].sources, sourceFixture.sources);
    await progress("native-memory-positive");
    const positive = await send("positive");
    assert.equal(positive.status, "succeeded", positive.error);
    assert.equal(positive.result.reply.content, "INSTALLED_NATIVE_MEMORY_POSITIVE_REPLY");
    observed = await provider();
    assert.equal(observed.nativeCalls, 3);
    const positiveRequests = observed.requests.filter(request => request.marker === "positive");
    assert.equal(positiveRequests.length, 2);
    assert.equal(positiveRequests[0].proposedTool, true);
    assert.deepEqual(positiveRequests[1].tools, []);
    assert.equal(positiveRequests[1].toolResultObserved, true);
    for (const request of positiveRequests) {
      const manifest = request.manifests[0];
      assert.deepEqual(manifest.records, memory.records);
      assert.equal(manifest.memoryRevision, memory.memoryRevision);
      assert.equal(manifest.binding.requestId, positive.request_id);
      assert.equal(manifest.binding.workspaceId, component.workspaceId);
      assert.equal(manifest.binding.nativeEpoch, host.receipt.epoch);
      assert.equal(manifest.binding.nativeHostReceiptSha256, host.receipt.receiptSha256);
      assert.equal(manifest.binding.sourcePlanSha256, plan.planSha256);
      assert.equal(manifest.binding.chatUrl, `pkm://chats/${sourceFixture.namespace}/${sourceFixture.chats.positive}`);
      assert.equal(manifest.binding.draftSha256, null);
    }
    const nativeExecution = execution.readOriginalMcpNativeExecution(component.storage, host, positive.request_id);
    assert.equal(nativeExecution.status, "complete");
    assert.equal(nativeExecution.context.roundCount, 2);
    assert.deepEqual(nativeExecution.tools, [{ name: "get_document", status: "complete" }]);
    const history = await core("chat.session.messages", { id: sourceFixture.chats.positive, afterSequence: 0, limit: 100 });
    assert.equal(history.items.at(-1).content, "INSTALLED_NATIVE_MEMORY_POSITIVE_REPLY");
    assert.match(JSON.stringify(await core("knowledge.document.get", { id: "Entry" })), /Approved genuine cold Note mutation/);
    memory.assertCurrent(); await unchanged(state);
    await progress("native-memory-revoke-pending");
    const revokeRequest = await submit("revoke"), pending = settled(revokeRequest);
    void pending.catch(() => {});
    await waitJson(join(root, "native-memory-revoke-model-visible.json"), timeoutMs, checkUi);
    assert.equal((await provider()).nativeCalls, 3);
    const pendingDb = component.storage.connectNative();
    try {
      const intents = pendingDb.prepare("SELECT authorized,payload FROM original_native_chat_inferences WHERE request_id=?")
        .all(revokeRequest.request_id);
      assert.equal(intents.length, 1, "The actual Core must have one pending inference intent before source revocation.");
      assert.equal(intents[0].authorized, 0);
      const request = JSON.parse(intents[0].payload);
      assert.match(JSON.stringify(request.nativeRequest.messages), /pkm.native-explicit-memory-context\/v1/);
      assert.match(JSON.stringify(request.nativeRequest.messages), /INSTALLED_NATIVE_MEMORY_REVOKE_REQUEST/);
    } finally { pendingDb.close(); }
    policies.revoke("memory");
    assert.throws(memory.assertCurrent);
    assert.equal(host.signal.aborted, false, "Independent Memory source revocation is not transport failure.");
    assert.equal(Atomics.load(new Int32Array(sourceGrant.revocation), 0), 0);
    await writeFile(join(root, "native-memory-revoked-before-click.json"), '{"revoked":true}', { mode: 0o600, flag: "wx" });
    const revoked = await pending;
    await waitJson(join(root, "native-memory-revoke-clicked.json"), timeoutMs, checkUi);
    assert(["failed", "outcome_unknown"].includes(revoked.status), JSON.stringify(revoked));
    observed = await provider();
    assert.equal(observed.nativeCalls, 3, "The late native approval cannot dispatch a revoked prepared Memory prompt.");
    assert(observed.requests.every(request => request.marker !== "revoke"));
    await assert.rejects(memoryApi.readOriginalMcpMemoryContext(component.owner, host, { query: sourceFixture.query }));
    assert.equal((await host.nativeChat.models.catalogue(new AbortController().signal)).source, "vscode.lm");
    assert.deepEqual(component.owner.workspaceLease(), lease);
    assert.equal((await component.owner.ensureFull()).runtime.core, full.runtime.core);
    await unchanged(state);
    const db = component.storage.connectNative();
    let journal;
    try {
      journal = db.prepare(`SELECT request_id,status FROM original_native_chat_executions
        WHERE request_id IN (?,?) ORDER BY request_id`).all(positive.request_id, revoked.request_id);
      assert.equal(db.prepare(`SELECT count(*) AS n FROM original_native_chat_inferences
        WHERE request_id=? AND authorized=1`).get(revoked.request_id).n, 0);
      assert.equal(db.prepare(`SELECT count(*) AS n FROM original_native_chat_events
        WHERE request_id=? AND type='tool-intent'`).get(revoked.request_id).n, 0);
      const events = db.prepare("SELECT payload FROM original_native_chat_events WHERE request_id=? AND type='tool-intent'")
        .all(positive.request_id).map(row => JSON.parse(row.payload));
      assert.equal(events.length, 1); assert.equal(events[0].name, "get_document");
      assert.deepEqual(events[0].arguments, { id: "Entry" });
      const entry = db.prepare("SELECT plan,plan_sha256 FROM original_native_chat_executions WHERE request_id=?").get(positive.request_id);
      assert.equal(originalNativeChatDigest(JSON.parse(entry.plan)), entry.plan_sha256);
    } finally { db.close(); }
    await progress("native-memory-complete");
    await ui.done;
    const uiProof = await waitJson(join(root, "native-memory-ui-passed.json"), timeoutMs, checkUi);
    assert.equal(uiProof.actualRenderedDom, true);
    assert.equal(uiProof.samePendingInferenceApprovedOnlyAfterRevocation, true);
    const evidence = {
      schema: "pkm.installed-native-memory-evidence/v1", passed: true,
      scope: "actual installed native provider/source/UI with disposable original Engine/ChatStore data only",
      deterministicProvider: true, commercialProviderQualified: false, actualProfileOrKeyringQualified: false,
      fullCutoverQualified: false, sameOwnerAndCachedCore: true, payloadBuildId,
      profileSha256: component.custody.profileSha256, custodyPlanSha256: component.custody.planSha256,
      chatSourcePlanSha256: plan.planSha256, memoryIntentSha256: imported.intentSha256,
      memoryRevision: memory.memoryRevision, nativeHostReceiptSha256: host.receipt.receiptSha256,
      sourceDatabaseSha256: sourceFixture.sourceDatabaseSha256, sourceScopeSha256: sourceFixture.sourceScopeSha256,
      nativeProviderCalls: observed.nativeCalls, nativeTokenCalls: observed.tokenCalls,
      defaultOffNoLiveRecall: true, missingGrantNoProviderDispatch: true,
      httpFallbackUnavailable: true,
      actualProviderReceivedExactQuotedMemoryManifest: true, actualCoreReadToolAndTranscript: true,
      sourceRevokedDuringPendingNativeApproval: true, lateApprovalNoProviderOrNextTool: true,
      independentModelAndChatSourceStillLive: true, originalChatAndEngineBytesUnchanged: true, journal,
      actualNativeMemoryUi: uiProof,
    };
    await writeFile(join(root, "native-memory-passed.json"), JSON.stringify(evidence), { mode: 0o600, flag: "wx" });
    return evidence;
  } finally {
    observerAbort.abort();
    try { await runtime?.close(); } finally { await ui.stop(); }
  }
}

export async function verifyInstalledNativeMemoryRestored(sourceFixture, root) {
  const state = preparations.get(sourceFixture);
  if (!state) fail("INSTALLED_MEMORY_ACTUAL_PREPARATION_REQUIRED");
  await unchanged(state, root);
  return { originalChatAndEngineB0BytesRestored: true };
}
