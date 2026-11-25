import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from "node:crypto";
import { cp, lstat, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { connect } from "node:net";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { captureOriginalMcpCustody, openOriginalMcpRoot, acquireOriginalMcpRootFence } from "../dist/original-mcp-root.js";
import { startOriginalMcpNativeBroker, originalMcpNativeBrokerAvailability } from "../dist/original-mcp-broker.js";
import { originalMcpRelayLaunch, pinOriginalMcpBrokerFile } from "../dist/original-mcp-relay.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { startOriginalMcpNativeAttachmentServer } from "../dist/original-mcp-native-attachment.js";
import { originalMcpNativeIdentity, originalMcpNativeAttestationMessage } from "../dist/original-mcp-native-identity.js";
import { originalMcpNativeRequestMethods, originalMcpNativeRequestProtocol, originalMcpNativeRequestSession,
  originalMcpNativeResult, createOriginalMcpNativeRequestPolicy, waitForOriginalMcpNativeSupport,
  parseOriginalMcpNativeRequest } from "../dist/original-mcp-native-request.js";
import { createOriginalMcpNativeHost } from "../dist/original-mcp-native-host.js";
import { originalPublicMcpContracts } from "../dist/native-public-original-mcp-contracts.js";
import { nativePublicFullOptions, createNativePublicOwnerBackend } from "../dist/native-public-mcp-owner.js";
import { createNativeOriginalTrashPort, getNativeOriginalTrashPort, withNativeOriginalTrashContext,
  approvePendingOriginalTrash, withOriginalTrashRecovery } from "../dist/original-native-trash-native.js";
import { originalNativeTrashMethod, parseOriginalNativeTrashPayload,
  originalNativeTrashRequestV1Schema } from "../dist/original-native-trash-contracts.js";
import { originalKnowledgeWriterFixture } from "./original-knowledge-writer-fixture.mjs";
import { previewTrashRestoreRevision } from "../dist/trash-lifecycle.js";
import { decodeMarkdown } from "../dist/markdown.js";

assert(process.env.PKM_TEST_WORKSPACE, "Use the existing real private Linux test framework.");
assert(originalMcpNativeRequestMethods.includes(originalNativeTrashMethod),
  "The current emitted Source must register method25; stale or unregistered artifacts are not successful lifecycle evidence.");
const actor = Object.freeze({ id: "mcp:external", canWrite: true });
const hash = value => createHash("sha256").update(value).digest("hex");
const bytes = Buffer.from([255, 0, 128, 9]), path = "Public/Lifecycle.md";
const seed = `
  store.noteUpsert({slug:"Public/Lifecycle",title:"Lifecycle",category:"Public",type:"general",
    tags:["retained"],content:"Original body\\n![pair](Lifecycle.assets/opaque.bin?q=1#view)\\n"
      +'<img src="Lifecycle.assets/opaque.bin?html=1#image">\\n'
      +"[pair]: <Lifecycle.assets/opaque.bin?definition=1#doc>\\n"});
  assets.saveMarkdownAsset(root,"notes","Public/Lifecycle.md","opaque.bin",Buffer.from([255,0,128,9]));
  const before=store.noteGet("Public/Lifecycle");
  store.noteUpsert({...before,tags:JSON.parse(before.tags),content:before.content+"Revision two.\\n"});
  store.noteUpsert({slug:"Private/Secret",title:"Secret",category:"Private",type:"general",
    content:"Private fixture marker\\n"+(input.shared?"![shared](../Public/Lifecycle.assets/opaque.bin)\\n":"")});
  privacy.setTopLevelPrivacy("notes","Private",true);
  if(input.archived){
    store.noteUpsert({slug:"Public/Archived",title:"Archived",category:"Public",type:"general",content:"Prior fixture bucket.\\n"});
    store.knowledgePathMoveToTrash("notes","Public/Archived.md");
  }
  if(input.area){
    if(input.area==="scripts"||input.area==="prompts"){
      const name=input.area==="scripts"?"Reviewed.py":"Reviewed.md";
      const base=path.join(root,input.area,"Public");
      fs.mkdirSync(base,{recursive:true});
      fs.writeFileSync(path.join(base,name),"raise RuntimeError('NEVER EXECUTE')\\r\\n# opaque 字节\\r\\n");
      if(input.area==="prompts"){
        fs.mkdirSync(path.join(base,"Reviewed.assets"));
        fs.writeFileSync(path.join(base,"Reviewed.assets","opaque.bin"),Buffer.from([255,0,128,9]));
      }
      return {path:"Public/"+name};
    }
    const kind=input.area==="skills"?"skill":"paper",name=input.area==="skills"?"NativeSkill":"NativePaper";
    store[kind+"Upsert"]({slug:"Public/"+name,name,title:name,category:"Public",type:"general",
      tags:["retained"],content:"Exact Unicode 字节\\r\\n![pair]("+name+".assets/opaque.bin?q=1#view)\\r\\n"});
    assets.saveMarkdownAsset(root,input.area,"Public/"+name+".md","opaque.bin",Buffer.from([255,0,128,9]));
    const key=kind==="skill"?name:"Public/"+name,first=store[kind+"Get"](key);
    store[kind+"Upsert"]({...first,tags:first.tags,content:first.content+"Revision two.\\r\\n"});
    store[kind+"Upsert"]({slug:"Private/Secret"+name,name:"Secret"+name,title:"Secret"+name,category:"Private",
      type:"general",content:"Synthetic private owner\\n"+(input.sharedPair
        ?"![shared](../Public/"+name+".assets/opaque.bin)\\n":""),
      ...(input.paperFile&&kind==="paper"?{file:"../Public/"+name+".assets/opaque.bin"}:{})});
    privacy.setTopLevelPrivacy(input.area,"Private",true);
    if(input.crossArea)store.noteUpsert({slug:"Private/Secret",title:"Secret",category:"Private",type:"general",
      content:"Private cross-area referrer\\n![pair](../../"+input.area+"/Public/"+name+".assets/opaque.bin)\\n"});
    return store[kind+"Get"](key);
  }
  return store.noteGet("Public/Lifecycle");
`;
function journal(root) {
  const db = new DatabaseSync(join(root, "core.sqlite"), { readOnly: true });
  try { return { intents: db.prepare("SELECT * FROM migration_runtime_intents").all(),
    receipts: db.prepare("SELECT * FROM receipts WHERE operation GLOB 'knowledge.trash.*' ORDER BY operation_id").all(),
    successors: db.prepare("SELECT * FROM original_native_trash_commits ORDER BY sequence").all() }; }
  finally { db.close(); }
}
async function physical(root) {
  const rows = [];
  const walk = async (path, relative) => {
    let stat;
    try { stat = await lstat(path); } catch (error) { if (error.code === "ENOENT") return; throw error; }
    rows.push([relative, stat.ino, stat.isDirectory() ? null : hash(await readFile(path))]);
    if (stat.isDirectory()) for (const name of (await readdir(path)).sort()) await walk(join(path, name), `${relative}/${name}`);
  };
  for (const area of ["notes", "skills", "papers", "scripts", "prompts"]) await walk(join(root, area), area);
  await walk(join(root, ".pkm/state"), ".pkm/state");
  return rows;
}
async function fixture(t, input = {}) {
  const directory = resolve("tests", `.native-trash-${randomUUID()}`), root = join(directory, "root");
  await mkdir(root, { recursive: true, mode: 0o700 });
  const original = originalKnowledgeWriterFixture(directory), before = original.run(root, seed, input);
  const oracle = join(directory, "oracle"); await cp(root, oracle, { recursive: true });
  const profileSha256 = hash("native-trash-disposable-profile");
  const capture = { root, backup: join(directory, "custody"),
    operatorId: "native-trash-disposable-fixture", profileSha256,
    ...(input.area === "prompts" ? { preserveOpaquePrompts: true } : {}),
    limits: { maxEntries: 4096, maxDepth: 32, maxBytes: 16 * 1024 * 1024, maxFileBytes: 1024 * 1024 } };
  let plan;
  if (input.captureCli) {
    const requestPath = join(directory, "capture-request.json");
    const raw = JSON.stringify({ schema: "pkm.original-mcp-custody-capture/v1", ...capture });
    await writeFile(requestPath, raw, { mode: 0o600 });
    plan = JSON.parse(execFileSync(process.execPath, [resolve("dist/original-mcp-custody-cli.js"), "capture",
      "--request", requestPath, "--pin", hash(raw)], { encoding: "utf8", timeout: 30000 }));
  } else plan = await captureOriginalMcpCustody(capture);
  const state = { mode: "approve", fault: undefined, injected: false, frames: [], epochs: [], cancel: undefined };
  let opened, backend, host, server, socket, endpoint, port, session, writerFence, broker, relayClient, brokerDirectory;
  async function close() {
    await relayClient?.close(); relayClient = undefined;
    await broker?.stop(); broker = undefined;
    if (brokerDirectory) await rm(brokerDirectory, { recursive: true, force: true }); brokerDirectory = undefined;
    await backend?.close(); backend = undefined;
    socket?.destroy(); await server?.close(); await host?.close(); await opened?.owner.close();
    server = host = opened = undefined;
    if (endpoint) await rm(endpoint, { recursive: true, force: true }); endpoint = undefined;
  }
  async function start() {
    writerFence = await acquireOriginalMcpRootFence(root);
    opened = await openOriginalMcpRoot(plan, { prepareNative: async storage => {
      const keys = generateKeyPairSync("ed25519"), identity = originalMcpNativeIdentity(
        keys.publicKey.export({ format: "der", type: "spki" }).toString("base64"), profileSha256);
      endpoint = resolve("tests", `.t-${randomBytes(4).toString("hex")}`); await mkdir(endpoint, { mode: 0o700 });
      const binding = { root, workspaceId: await storage.workspaceId(), planSha256: plan.planSha256, profileSha256,
        catalogSha256: originalPublicMcpContracts().provenance.metadataSha256,
        payloadBuildId: hash("synthetic-source-test-payload"), hostEntrySha256: hash("synthetic-source-test-host") };
      server = await startOriginalMcpNativeAttachmentServer({ directory: endpoint, identity, identitySha256: identity.sha256,
        binding, maxPacketBytes: 65536, heartbeatIntervalMs: 100, heartbeatTimeoutMs: 1000 });
      socket = connect(join(endpoint, "n")); socket.on("error", () => socket.destroy());
      let buffer = "", attachedResolve;
      const attached = new Promise(resolve => { attachedResolve = resolve; });
      const send = frame => socket.write(JSON.stringify(frame) + "\n");
      socket.on("data", chunk => {
        buffer += chunk.toString("utf8"); let end;
        while ((end = buffer.indexOf("\n")) >= 0) {
          const frame = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
          if (frame.type === "challenge") {
            const { body, message } = originalMcpNativeAttestationMessage(frame.challenge, identity.sha256, randomUUID());
            send({ type: "attestation", attestation: { ...body, signature: sign(null, message, keys.privateKey).toString("base64") } });
          } else if (frame.type === "attached") attachedResolve();
          else if (frame.type === "ping") send({ type: "pong", nonce: frame.nonce });
          else if (frame.type === "native-request") {
            parseOriginalMcpNativeRequest(frame, originalMcpNativeRequestSession(session)); state.frames.push(frame);
            if (frame.method !== originalNativeTrashMethod) { send(originalMcpNativeResult(frame, { decision: "approve" })); continue; }
            if (state.review) { const review = state.review; state.review = undefined; review(frame); }
            if (state.mode === "cancel") { state.cancel.abort(); continue; }
            if (state.mode === "deny") { send(originalMcpNativeResult(frame, null)); continue; }
            send(originalMcpNativeResult(frame, { decision: "approve", actorId: actor.id, decisionId: randomUUID(),
              requestSha256: state.mode === "wrong" ? "0".repeat(64) : frame.payload.requestSha256,
              operationId: frame.payload.request.subject.operationId, epoch: frame.session.epoch,
              expiresAtMs: state.mode === "expired" ? Date.now() - 1 : Date.now() + 60000 }));
          }
        }
      });
      await attached; session = await server.waitForSession({ timeoutMs: 1000 }); state.epochs.push(session.activationId);
      send({ type: "native-supports", protocol: originalMcpNativeRequestProtocol,
        session: originalMcpNativeRequestSession(session),
        methods: state.mode === "unsupported" ? originalMcpNativeRequestMethods.filter(method => method !== originalNativeTrashMethod)
          : [...originalMcpNativeRequestMethods], maxPacketBytes: 65536 });
      await waitForOriginalMcpNativeSupport(session, { timeoutMs: 1000 });
      host = await createOriginalMcpNativeHost(storage, createOriginalMcpNativeRequestPolicy(session));
      port = createNativeOriginalTrashPort(storage, host, session);
      assert.equal(createNativeOriginalTrashPort(storage, host, session), port);
      assert.equal(getNativeOriginalTrashPort(storage, host), port);
      const recovery = await approvePendingOriginalTrash(port);
      const options = await nativePublicFullOptions(storage, { actor, originalMcpHost: host });
      assert.equal(options.trash.original, port);
      return { ...options, trash: { ...options.trash, ...(recovery ? { recovery } : {}),
        faultInjector(point) {
          if (!state.injected && state.fault === point) { state.injected = true; throw new Error(`Fixture interruption: ${point}`); }
        } } };
    }, writerFence });
    await opened.owner.ensureFull();
    backend = createNativePublicOwnerBackend(opened.owner, { actor, originalMcpHost: host });
  }
  t.after(async () => { try { await close(); } finally { await rm(directory, { recursive: true, force: true }); } });
  await start();
  const invoke = (tool, arguments_, signal) => backend.invoke("original_mcp_public", { tool, arguments: arguments_ }, signal);
  const canonical = async (operation, arguments_, readOnly = false, signal) => {
    const value = await backend.invoke(readOnly ? "legacy_capability_read" : "legacy_capability_call", {
      action: readOnly ? "read" : "call", args: { operation, version: 1, arguments: arguments_ },
    }, signal);
    return value.structuredContent ?? JSON.parse(value.content[0].text);
  };
  async function publicRelay() {
    brokerDirectory = resolve("tests", `.b-${randomBytes(4).toString("hex")}`);
    await mkdir(brokerDirectory, { mode: 0o700 });
    const buildSha256 = hash("current-qualified-source-fixture");
    await writeFile(join(directory, "active-generation.json"),
      JSON.stringify({ schema: "pkm.mcp.lifecycle/v1", generation: "fixture" }), { mode: 0o600 });
    broker = await startOriginalMcpNativeBroker({
      plan, writerFence, owner: opened.owner, storage: opened.storage, nativeHost: host, directory: brokerDirectory,
      runtime: { node: pinOriginalMcpBrokerFile(process.execPath), relay: pinOriginalMcpBrokerFile(resolve("dist/original-mcp-relay-cli.js")), buildSha256 },
      manifest: { schema: "pkm.mcp.lifecycle/v1", version: "0.1.0", runtimeBuild: buildSha256,
        managedRoot: directory, generation: "fixture" },
      authorization: { schema: "pkm.original-mcp-broker-authorization/v1", operatorId: plan.operatorId,
        planSha256: plan.planSha256, profileSha256, acceptedScope: "native-dogfood/v1", writable: true },
    });
    relayClient = new Client({ name: "prompt-product-relay", version: "1" });
    const launch = originalMcpRelayLaunch(broker.descriptorPath, broker.descriptorSha256);
    await relayClient.connect(new StdioClientTransport({ command: launch.command, args: launch.args, stderr: "pipe" }));
    return relayClient;
  }
  return { root, oracle, original, before, state, invoke, canonical, close, start,
    publicRelay,
    get opened() { return opened; }, get port() { return port; }, get session() { return session; } };
}
const deletion = f => f.invoke("delete_note", { slug: "Public/Lifecycle" });
const entryFrom = response => {
  const text = response.content[0].text, value = JSON.parse(text);
  return value.trash ?? value.entry ?? value;
};

for (const area of ["scripts", "prompts"]) test(`public ${area} trash preserves reviewed opaque bytes and restores its exact pair`, {
  timeout: 120000,
}, async t => {
  const f = await fixture(t, { area }), path = f.before.path;
  const raw = await readFile(join(f.root, area, path));
  const initial = await physical(f.root);
  await assert.rejects(f.invoke("knowledge_file_trash", { area, path, expected_sha256: hash("stale") }), { code: "CONFLICT" });
  assert.deepEqual(await physical(f.root), initial);
  assert.deepEqual(journal(f.root), { intents: [], receipts: [], successors: [] });
  const originalEntry = f.original.run(f.oracle,
    `return store.knowledgePathMoveToTrash(input.area, input.path);`, { area, path });
  const entry = entryFrom(await f.invoke("knowledge_file_trash", { area, path, expected_sha256: hash(raw) }));
  const comparable = ({ id: _id, deletedAt: _deletedAt, ...value }) => value;
  assert.deepEqual(comparable(entry), comparable(originalEntry));
  assert.deepEqual(await readFile(join(f.root, area, ".trash", entry.id, "payload")), raw);
  if (area === "prompts") assert.deepEqual(await readFile(join(f.root, area, ".trash", entry.id, "assets/opaque.bin")), bytes);
  await assert.rejects(f.invoke("knowledge_file_trash", { area, path, expected_sha256: hash(raw) }), { code: "CONFLICT" });
  assert.equal(journal(f.root).receipts.length, 1);
  const listed = await f.canonical("knowledge.trash.list", { area, entryIds: [entry.id], operationId: randomUUID() }, true);
  assert.equal(listed.items[0].originalPath, path);
  await f.close(); await f.start();
  const restored = await f.canonical("knowledge.trash.restore", {
    operationId: randomUUID(), entryId: entry.id, expectedScanRevision: previewTrashRestoreRevision(f.root),
  });

  assert.equal(restored.area, area);
  assert.deepEqual(await readFile(join(f.root, area, path)), raw);
  if (area === "prompts") assert.deepEqual(await readFile(join(f.root, area, "Public/Reviewed.assets/opaque.bin")), bytes);
  assert.deepEqual(f.original.run(f.oracle,
    `return store.knowledgeTrashRestore(input.area, input.id);`, { area, id: originalEntry.id }), { ok: true, path });
  assert.deepEqual(await readFile(join(f.oracle, area, path)), raw);
  const reviews = f.state.frames.filter(frame => frame.method === originalNativeTrashMethod);
  for (const frame of reviews) {
    assert.equal(frame.payload.request.schema, "pkm.original-native-trash-request/v3");
    assert.equal(originalNativeTrashRequestV1Schema.safeParse(frame.payload.request).success, false);
    assert(!("document" in frame.payload.request.subject.selection[0]));
    assert.deepEqual(parseOriginalNativeTrashPayload(frame.payload, frame.session), frame.payload);
  }
  await f.close(); await f.start();
});

test("shipped capture CLI explicitly enrolls Prompt v3 for current authenticated public trash and fresh unknown-effect recovery",
  { timeout: 120000 }, async t => {
    const f = await fixture(t, { area: "prompts", captureCli: true });
    const path = f.before.path, raw = await readFile(join(f.root, "prompts", path));
    const relay = await f.publicRelay();
    const description = await relay.callTool({ name: "capabilities_describe",
      arguments: { operation: "mcp.tool.knowledge_file_trash" } });
    assert.notEqual(description.isError, true, JSON.stringify(description));
    assert(originalMcpNativeBrokerAvailability(true).disabledOperationIds.includes("mcp.tool.knowledge_file_trash"),
      "Static/no-port broker availability remains closed.");
    f.state.fault = "move-0";
    assert.equal((await relay.callTool({ name: "capability_call", arguments: {
      operation: "mcp.tool.knowledge_file_trash", version: 1,
      arguments: { area: "prompts", path, expected_sha256: hash(raw) } } })).isError, true);
    assert.equal(journal(f.root).intents.length, 1);
    const epoch = f.state.epochs.at(-1);
    await f.close(); await f.start();
    assert.notEqual(f.state.epochs.at(-1), epoch);
    const records = journal(f.root), id = JSON.parse(records.receipts[0].result).entryId;
    assert.equal(records.intents.length, 0);
    assert.equal(records.receipts.length, 1);
    assert.deepEqual(await readFile(join(f.root, "prompts/.trash", id, "payload")), raw);
    assert.deepEqual(await readFile(join(f.root, "prompts/.trash", id, "assets/opaque.bin")), bytes);
    const recoveredRelay = await f.publicRelay();
    assert.equal((await recoveredRelay.callTool({ name: "capability_call", arguments: {
      operation: "mcp.tool.knowledge_file_trash", version: 1,
      arguments: { area: "prompts", path, expected_sha256: hash(raw) } } })).isError, true);
    assert.equal(journal(f.root).receipts.length, 1);
  });

test("opaque reviewed source/pair changes and cancellation cannot publish intents; occupied restore pairs cannot be overwritten",
  { timeout: 180000 }, async t => {
    for (const area of ["scripts", "prompts"]) {
      const f = await fixture(t, { area }), path = f.before.path, raw = await readFile(join(f.root, area, path));
      const before = await physical(f.root);
      f.state.mode = "cancel"; f.state.cancel = new AbortController();
      await assert.rejects(f.invoke("knowledge_file_trash", { area, path, expected_sha256: hash(raw) }, f.state.cancel.signal),
        { code: "NATIVE_REQUEST_CANCELLED" });
      assert.deepEqual(await physical(f.root), before);
      assert.deepEqual(journal(f.root), { intents: [], receipts: [], successors: [] });
      f.state.mode = "approve";
      f.state.review = () => writeFileSync(join(f.root, area,
        area === "scripts" ? path : "Public/Reviewed.assets/opaque.bin"), "concurrent source/pair edit");
      await assert.rejects(f.invoke("knowledge_file_trash", { area, path, expected_sha256: hash(raw) }));
      assert.deepEqual(journal(f.root), { intents: [], receipts: [], successors: [] });
    }
    const f = await fixture(t, { area: "prompts" }), path = f.before.path, raw = await readFile(join(f.root, "prompts", path));
    const entry = entryFrom(await f.invoke("knowledge_file_trash", { area: "prompts", path, expected_sha256: hash(raw) }));
    await mkdir(join(f.root, "prompts/Public/Reviewed.assets"));
    await writeFile(join(f.root, "prompts/Public/Reviewed.assets/new.bin"), "must not overwrite");
    const before = await physical(f.root), records = journal(f.root);
    await assert.rejects(f.canonical("knowledge.trash.restore", { operationId: randomUUID(), entryId: entry.id,
      expectedScanRevision: previewTrashRestoreRevision(f.root) }));
    assert.deepEqual(await physical(f.root), before);
    assert.deepEqual(journal(f.root), records);
    assert.deepEqual(await readFile(join(f.root, "prompts/.trash", entry.id, "assets/opaque.bin")), bytes);
  });

test("opaque unknown move effects require fresh native recovery and never replay public exact-SHA trash",
  { timeout: 180000 }, async t => {
    for (const area of ["scripts", "prompts"]) {
      const f = await fixture(t, { area }), path = f.before.path, raw = await readFile(join(f.root, area, path));
      f.state.fault = "move-0";
      await assert.rejects(f.invoke("knowledge_file_trash", { area, path, expected_sha256: hash(raw) }));
      assert.equal(journal(f.root).intents.length, 1);
      assert.equal(journal(f.root).receipts.length, 0);
      const image = await physical(f.root), oldEpoch = f.state.epochs.at(-1);
      await f.close(); f.state.mode = "deny";
      await assert.rejects(f.start(), { code: "ORIGINAL_TRASH_DENIED" });
      assert.deepEqual(await physical(f.root), image);
      await f.close(); f.state.mode = "approve"; await f.start();
      assert.notEqual(f.state.epochs.at(-1), oldEpoch);
      const records = journal(f.root), id = JSON.parse(records.receipts[0].result).entryId;
      assert.equal(records.intents.length, 0);
      assert.equal(records.receipts.length, 1);
      assert.equal(records.successors.length, 1);
      assert.deepEqual(await readFile(join(f.root, area, ".trash", id, "payload")), raw);
      if (area === "prompts") assert.deepEqual(await readFile(join(f.root, area, ".trash", id, "assets/opaque.bin")), bytes);
      await assert.rejects(f.invoke("knowledge_file_trash", { area, path, expected_sha256: hash(raw) }), { code: "CONFLICT" });
      assert.equal(journal(f.root).receipts.length, 1);
    }
  });

test("native Trash DTO copies, missing support, denial, expired/wrong decisions and cancellation cannot publish an intent", {
  timeout: 180000,
}, async t => {
  const f = await fixture(t), before = await physical(f.root);
  await assert.rejects(withNativeOriginalTrashContext(structuredClone(f.port), async () => true), { code: "NATIVE_AUTHORITY_REQUIRED" });
  await assert.rejects(withOriginalTrashRecovery(f.opened.storage, { kind: "pkm.original-trash-recovery/v1" }, async () => true),
    { code: "NATIVE_AUTHORITY_REQUIRED" });
  const reviewedBefore = f.state.frames.filter(frame => frame.method === originalNativeTrashMethod).length;
  await assert.rejects(f.canonical("knowledge.trash.list", {}, true), { code: "INVALID_ARGUMENT" });
  assert.equal(f.state.frames.filter(frame => frame.method === originalNativeTrashMethod).length, reviewedBefore);
  for (const [mode, code] of [["deny", "ORIGINAL_TRASH_DENIED"], ["expired", "ORIGINAL_TRASH_EXPIRED"],
    ["wrong", "ORIGINAL_TRASH_DECISION_MISMATCH"], ["cancel", "NATIVE_REQUEST_CANCELLED"]]) {
    f.state.mode = mode; f.state.cancel = new AbortController();
    await assert.rejects(f.invoke("delete_note", { slug: "Public/Lifecycle" }, f.state.cancel.signal), { code });
    assert.deepEqual(await physical(f.root), before);
    assert.deepEqual(journal(f.root), { intents: [], receipts: [], successors: [] });
  }
  f.state.mode = "unsupported"; await f.close(); await f.start();
  await assert.rejects(deletion(f), { code: "MISSING_NATIVE_METHOD" });
  assert.deepEqual(await physical(f.root), before);
});
test("public original alias and scoped canonical list/restore preserve raw bytes, knowledge identity, revision, pair and ordered history", {
  timeout: 180000,
}, async t => {
  const f = await fixture(t, { archived: true }), raw = await readFile(join(f.root, "notes", path));
  const prior = f.original.run(f.root, `return store.knowledgeTrashList("notes");`)[0];
  const priorBucket = await readFile(join(f.root, "notes/.trash", prior.id, "payload"));
  const response = await deletion(f), entry = entryFrom(response);
  assert.match(entry.id, /^[0-9]+-[a-f0-9]{10}$/);
  assert.deepEqual(await readFile(join(f.root, "notes/.trash", entry.id, "payload")), raw);
  assert.deepEqual(await readFile(join(f.root, "notes/.trash", entry.id, "assets/opaque.bin")), bytes);
  assert.equal(journal(f.root).receipts.length, 1); assert.equal(journal(f.root).successors.length, 1);
  const history = JSON.parse(await readFile(join(f.root, ".pkm/state/knowledge-deletions.json"), "utf8"));
  assert.deepEqual(history.records.slice(-2), [
    { path: `notes/${path}`, deletedAt: entry.deletedAt },
    { path: "notes/Public/Lifecycle.assets/opaque.bin", deletedAt: entry.deletedAt },
  ]);
  const listed = await f.canonical("knowledge.trash.list", { area: "notes", entryIds: [entry.id, prior.id], operationId: randomUUID() }, true);
  assert.equal(listed.items.length, 2); assert.equal(listed.items.find(row => row.id === entry.id).runtimeEntryId, entry.id);
  await assert.rejects(f.canonical("knowledge.trash.restore", { operationId: randomUUID(), entryId: prior.id,
    expectedScanRevision: previewTrashRestoreRevision(f.root) }), { code: "NOT_FOUND" });
  await f.close(); await f.start();
  const restoreArgs = { operationId: randomUUID(), entryId: entry.id, expectedScanRevision: previewTrashRestoreRevision(f.root) };
  const restore = await f.canonical("knowledge.trash.restore", restoreArgs);
  assert.equal(restore.action, "restore");
  assert.deepEqual(await readFile(join(f.root, "notes", path)), raw);
  assert.deepEqual(await readFile(join(f.root, "notes/Public/Lifecycle.assets/opaque.bin")), bytes);
  assert.deepEqual(f.original.run(f.root, `return store.noteGet("Public/Lifecycle");`), f.before);
  assert.deepEqual(await readFile(join(f.root, "notes/.trash", prior.id, "payload")), priorBucket);
  const after = JSON.parse(await readFile(join(f.root, ".pkm/state/knowledge-deletions.json"), "utf8"));
  assert.deepEqual(after.records, history.records.slice(0, -2));
  assert.equal(journal(f.root).receipts.length, 2); assert.equal(journal(f.root).successors.length, 2);
  assert.deepEqual(await f.canonical("knowledge.trash.restore", restoreArgs), restore);
  await assert.rejects(f.canonical("knowledge.trash.restore", { operationId: randomUUID(), entryId: entry.id,
    expectedScanRevision: previewTrashRestoreRevision(f.root) }), { code: "NOT_FOUND" });
  const reviews = f.state.frames.filter(frame => frame.method === originalNativeTrashMethod);
  assert.deepEqual(reviews.map(frame => frame.payload.request.subject.action), ["move", "list", "restore"]);
  const publicReview = f.state.frames.findIndex(frame => frame.method === "public.approve" && frame.payload.request.tool === "delete_note");
  assert(publicReview >= 0 && publicReview < f.state.frames.indexOf(reviews[0]),
    "Public delete approval must precede its separate exact native Trash decision.");
  assert.equal(reviews[0].payload.request.subject.publicRequest.tool, "delete_note");
  for (const frame of reviews) assert.deepEqual(parseOriginalNativeTrashPayload(frame.payload, frame.session), frame.payload);
  const changed = structuredClone(reviews[0].payload); changed.defaultDecision = "approve";
  assert.throws(() => parseOriginalNativeTrashPayload(changed, reviews[0].session));
});
test("shared-private pair, same-Core restore collision and external custody drift refuse without additional effects", {
  timeout: 180000,
}, async t => {
  const shared = await fixture(t, { shared: true }), before = await physical(shared.root);
  await assert.rejects(deletion(shared), { code: "CONFLICT" });
  assert.deepEqual(await physical(shared.root), before);
  assert.equal(shared.state.frames.filter(frame => frame.method === originalNativeTrashMethod).length, 0);
  assert.deepEqual(journal(shared.root), { intents: [], receipts: [], successors: [] });
  const native = await fixture(t), nativeEntry = entryFrom(await deletion(native));
  const created = await native.invoke("add_note", { title: "Lifecycle", category: "Public",
    content: "Disposable same-Core collision.\n" });
  assert.deepEqual(JSON.parse(created.content[0].text), { ok: true, slug: "Public/Lifecycle" });
  const db = new DatabaseSync(join(native.root, "core.sqlite"), { readOnly: true });
  try { assert.equal(db.prepare("SELECT COUNT(*) AS n FROM receipts WHERE operation='knowledge.note.create'").get().n, 1); }
  finally { db.close(); }
  const nativeBefore = await physical(native.root), nativeJournal = journal(native.root), nativeFrames = native.state.frames.length;
  await assert.rejects(native.canonical("knowledge.trash.restore", { operationId: randomUUID(), entryId: nativeEntry.id,
    expectedScanRevision: previewTrashRestoreRevision(native.root) }), { code: "CONFLICT" });
  assert.deepEqual(await physical(native.root), nativeBefore);
  assert.deepEqual(journal(native.root), nativeJournal); assert.equal(native.state.frames.length, nativeFrames);
  const f = await fixture(t), entry = entryFrom(await deletion(f));
  f.original.run(f.root, `return store.noteUpsert({slug:"Public/Lifecycle",title:"Lifecycle",category:"Public",type:"general",content:"Disposable collision.\\n"});`);
  const collision = await physical(f.root), count = f.state.frames.length;
  await assert.rejects(f.canonical("knowledge.trash.restore", { operationId: randomUUID(), entryId: entry.id,
    expectedScanRevision: previewTrashRestoreRevision(f.root) }), { code: "RECOVERY_REQUIRED" });
  assert.deepEqual(await physical(f.root), collision); assert.equal(f.state.frames.length, count);
  assert.equal(journal(f.root).receipts.length, 1); assert.equal(journal(f.root).intents.length, 0);
});
test("paired-move and history-stage interruptions require fresh native recovery epochs and preserve receipt-bound custody", {
  timeout: 180000,
}, async t => {
  for (const point of ["move-0", "original-history-staged"]) {
    const f = await fixture(t), raw = await readFile(join(f.root, "notes", path));
    f.state.fault = point;
    await assert.rejects(deletion(f)); assert.equal(f.state.injected, true);
    assert.equal(journal(f.root).intents.length, 1); assert.equal(journal(f.root).receipts.length, 0);
    const interrupted = await physical(f.root), oldEpoch = f.state.epochs.at(-1);
    await f.close(); f.state.mode = "deny";
    await assert.rejects(f.start(), { code: "ORIGINAL_TRASH_DENIED" });
    assert.deepEqual(await physical(f.root), interrupted);
    assert.equal(journal(f.root).intents.length, 1); assert.equal(journal(f.root).receipts.length, 0);
    await f.close(); f.state.mode = "approve"; await f.start();
    assert.notEqual(f.state.epochs.at(-1), oldEpoch);
    assert.equal(journal(f.root).intents.length, 0); assert.equal(journal(f.root).receipts.length, 1);
    const entry = JSON.parse(journal(f.root).receipts[0].result).entryId;
    assert.deepEqual(await readFile(join(f.root, "notes/.trash", entry, "payload")), raw);
    assert.deepEqual(await readFile(join(f.root, "notes/.trash", entry, "assets/opaque.bin")), bytes);
    const recoveries = f.state.frames.filter(frame => frame.method === originalNativeTrashMethod && frame.payload.request.phase === "recover");
    assert.equal(recoveries.length, 2);
    await f.close(); await f.start();
    assert.equal(f.state.frames.filter(frame => frame.method === originalNativeTrashMethod && frame.payload.request.phase === "recover").length, 2);
  }
});

const subjects = [
  { area: "skills", kind: "skill", name: "NativeSkill", args: { name: "NativeSkill" } },
  { area: "papers", kind: "paper", name: "NativePaper", args: { slug: "Public/NativePaper" } },
];
test("signed v2 Skill/Paper delete and receipt-linked canonical restore preserve Original raw identity, metadata, pair and history", {
  timeout: 180000,
}, async t => {
  for (const spec of subjects) {
    const f = await fixture(t, spec), owner = `Public/${spec.name}.md`;
    const raw = await readFile(join(f.root, spec.area, owner));
    const entry = entryFrom(await f.invoke(`delete_${spec.kind}`, spec.args));
    assert.equal(entry.kind, spec.kind === "skill" ? "skill" : "item");
    assert.equal(entry.name, spec.kind === "skill" ? spec.name : `${spec.name}.md`);
    assert.deepEqual(await readFile(join(f.root, spec.area, ".trash", entry.id, "payload")), raw);
    assert.deepEqual(await readFile(join(f.root, spec.area, ".trash", entry.id, "assets/opaque.bin")), bytes);
    await assert.rejects(lstat(join(f.root, spec.area, owner)), { code: "ENOENT" });
    const history = JSON.parse(await readFile(join(f.root, ".pkm/state/knowledge-deletions.json")));
    assert.deepEqual(history.records, [owner, `Public/${spec.name}.assets/opaque.bin`]
      .map(path => ({ path: `${spec.area}/${path}`, deletedAt: entry.deletedAt })));
    const listed = await f.canonical("knowledge.trash.list", {
      area: spec.area, entryIds: [entry.id], operationId: randomUUID(),
    }, true);
    assert.equal(listed.items[0].kind, entry.kind);
    const wrongArea = spec.area === "skills" ? "papers" : "skills", unchanged = await physical(f.root);
    const count = f.state.frames.length;
    await assert.rejects(f.canonical("knowledge.trash.list", {
      area: wrongArea, entryIds: [entry.id], operationId: randomUUID(),
    }, true), { code: "NOT_FOUND" });
    assert.equal(f.state.frames.length, count); assert.deepEqual(await physical(f.root), unchanged);
    await f.close(); await f.start();
    const args = { entryId: entry.id, operationId: randomUUID(), expectedScanRevision: previewTrashRestoreRevision(f.root) };
    const restored = await f.canonical("knowledge.trash.restore", args);
    assert.equal(restored.area, spec.area);
    assert.deepEqual(await readFile(join(f.root, spec.area, owner)), raw);
    assert.deepEqual(await readFile(join(f.root, spec.area, `Public/${spec.name}.assets/opaque.bin`)), bytes);
    assert.deepEqual(JSON.parse(await readFile(join(f.root, ".pkm/state/knowledge-deletions.json"))), { schema: 1, records: [] });
    const oracleBefore = f.original.run(f.oracle, `return store[input.kind+"Get"](input.key);`,
      { kind: spec.kind, key: spec.kind === "skill" ? spec.name : `Public/${spec.name}` });
    assert.equal(oracleBefore.knowledgeId, f.before.knowledgeId); assert.equal(oracleBefore.revision, 2);
    const decoded = decodeMarkdown(f.before.knowledgeId, raw.toString("utf8"), owner, spec.area);
    assert.equal(decoded.metadata.get("knowledgeId"), oracleBefore.knowledgeId); assert.equal(decoded.record.revision, oracleBefore.revision);
    const read = entryFrom(await f.invoke(`get_${spec.kind}`, spec.args));
    assert.equal(read.content, oracleBefore.content.replaceAll("\r\n", "\n"));
    const replayBefore = await physical(f.root), records = journal(f.root), frames = f.state.frames.length;
    assert.deepEqual(await f.canonical("knowledge.trash.restore", args), restored);
    await assert.rejects(f.canonical("knowledge.trash.restore", { ...args, entryId: `${Date.now()}-0123456789` }), { code: "CONFLICT" });
    assert.deepEqual(await physical(f.root), replayBefore); assert.deepEqual(journal(f.root), records);
    assert.equal(f.state.frames.length, frames);
    assert.equal(records.successors.length, 2);
    const reviews = f.state.frames.filter(frame => frame.method === originalNativeTrashMethod);
    assert.deepEqual(reviews.map(frame => frame.payload.request.subject.action), ["move", "list", "restore"]);
    assert.equal(reviews[0].payload.request.subject.publicRequest.tool, `delete_${spec.kind}`);
    for (const frame of reviews) {
      assert.equal(frame.payload.request.schema, "pkm.original-native-trash-request/v2");
      assert.equal(frame.payload.request.subject.area, spec.area);
      assert.deepEqual(parseOriginalNativeTrashPayload(frame.payload, frame.session), frame.payload);
      assert.equal(originalNativeTrashRequestV1Schema.safeParse(frame.payload.request).success, false,
        "Source schema isolation only: the Parent must separately probe a sealed v1 receiver.");
      const changed = structuredClone(frame.payload);
      changed.request.schema = "pkm.original-native-trash-request/v1";
      assert.throws(() => parseOriginalNativeTrashPayload(changed, frame.session));
    }
    await f.close(); await f.start();
  }
});
test("v2 private owners, shared-private pairs, denied decisions, stale CAS and same-Core collisions refuse before intents or effects", {
  timeout: 180000,
}, async t => {
  for (const spec of subjects) {
    const f = await fixture(t, spec), before = await physical(f.root);
    for (const [mode, code] of [["deny", "ORIGINAL_TRASH_DENIED"], ["wrong", "ORIGINAL_TRASH_DECISION_MISMATCH"],
      ["expired", "ORIGINAL_TRASH_EXPIRED"]]) {
      f.state.mode = mode;
      await assert.rejects(f.invoke(`delete_${spec.kind}`, spec.args), { code });
      assert.deepEqual(await physical(f.root), before); assert.deepEqual(journal(f.root), { intents: [], receipts: [], successors: [] });
    }
    f.state.mode = "approve";
    const privateArgs = spec.kind === "skill" ? { name: `Secret${spec.name}` } : { slug: `Private/Secret${spec.name}` };
    const privateRecords = journal(f.root), privateReviews = f.state.frames.filter(frame => frame.method === originalNativeTrashMethod).length;
    const privateReply = await f.invoke(`delete_${spec.kind}`, privateArgs);
    assert.deepEqual(await physical(f.root), before); assert.deepEqual(journal(f.root), privateRecords);
    assert.equal(f.state.frames.filter(frame => frame.method === originalNativeTrashMethod).length, privateReviews);
    t.diagnostic(`Native public-only delete_${spec.kind} private target reply=${JSON.stringify(privateReply)}; exact physical/receipt/intent/Trash-frame images unchanged.`);
    assert(!JSON.stringify(privateReply).includes("Synthetic private owner"));
    assert.deepEqual(entryFrom(privateReply), spec.kind === "skill"
      ? { ok: true, name: privateArgs.name, absent: true } : { ok: true, absent: true });
    const shared = await fixture(t, { ...spec, sharedPair: true }), sharedBefore = await physical(shared.root);
    await assert.rejects(shared.invoke(`delete_${spec.kind}`, spec.args), { code: "CONFLICT" });
    assert.deepEqual(await physical(shared.root), sharedBefore);
    assert.equal(shared.state.frames.filter(frame => frame.method === originalNativeTrashMethod).length, 0);
    for (const referrer of [{ crossArea: true }, ...(spec.kind === "paper" ? [{ paperFile: true }] : [])]) {
      const outside = await fixture(t, { ...spec, ...referrer }), image = await physical(outside.root);
      await assert.rejects(outside.invoke(`delete_${spec.kind}`, spec.args), { code: "CONFLICT" });
      assert.deepEqual(await physical(outside.root), image);
      assert.equal(outside.state.frames.filter(frame => frame.method === originalNativeTrashMethod).length, 0);
      assert.deepEqual(journal(outside.root), { intents: [], receipts: [], successors: [] });
    }
    const entry = entryFrom(await f.invoke(`delete_${spec.kind}`, spec.args));
    const staleBefore = await physical(f.root), staleRecords = journal(f.root);
    await assert.rejects(f.canonical("knowledge.trash.restore", {
      entryId: entry.id, operationId: randomUUID(), expectedScanRevision: hash("not the current reference scan"),
    }), { code: "CONFLICT" });
    assert.deepEqual(await physical(f.root), staleBefore); assert.deepEqual(journal(f.root), staleRecords);
    assert.notEqual((await f.invoke(`add_${spec.kind}`, { ...(spec.kind === "skill" ? { name: spec.name } : { title: spec.name }),
      category: "Public", content: "Synthetic same-Core collision.\n" })).isError, true);
    const collision = await physical(f.root), collisionRecords = journal(f.root), frames = f.state.frames.length;
    await assert.rejects(f.canonical("knowledge.trash.restore", {
      entryId: entry.id, operationId: randomUUID(), expectedScanRevision: previewTrashRestoreRevision(f.root),
    }), { code: "CONFLICT" });
    assert.deepEqual(await physical(f.root), collision); assert.deepEqual(journal(f.root), collisionRecords);
    assert.equal(f.state.frames.length, frames);
  }
});
test("v2 interrupted owned-pair effects require a new exact area-specific recovery epoch", { timeout: 180000 }, async t => {
  const spec = subjects[0], f = await fixture(t, spec), raw = await readFile(join(f.root, "skills/Public/NativeSkill.md"));
  f.state.fault = "move-0"; await assert.rejects(f.invoke("delete_skill", spec.args));
  assert.equal(journal(f.root).intents.length, 1); assert.equal(journal(f.root).receipts.length, 0);
  const before = await physical(f.root), epoch = f.state.epochs.at(-1);
  await f.close(); f.state.mode = "deny";
  await assert.rejects(f.start(), { code: "ORIGINAL_TRASH_DENIED" });
  assert.deepEqual(await physical(f.root), before);
  await f.close(); f.state.mode = "approve"; await f.start();
  assert.notEqual(f.state.epochs.at(-1), epoch);
  const records = journal(f.root), id = JSON.parse(records.receipts[0].result).entryId;
  assert.equal(records.intents.length, 0); assert.equal(records.successors.length, 1);
  assert.deepEqual(await readFile(join(f.root, "skills/.trash", id, "payload")), raw);
  assert.deepEqual(await readFile(join(f.root, "skills/.trash", id, "assets/opaque.bin")), bytes);
  const recoveries = f.state.frames.filter(frame => frame.method === originalNativeTrashMethod && frame.payload.request.phase === "recover");
  assert.equal(recoveries.length, 2);
  assert(recoveries.every(frame => frame.payload.request.schema === "pkm.original-native-trash-request/v2"
    && frame.payload.request.subject.area === "skills"));
});
