import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { captureOriginalMcpCustody, openOriginalMcpRoot } from "../dist/original-mcp-root.js";
import { startOriginalMcpNativeAttachmentServer } from "../dist/original-mcp-native-attachment.js";
import { originalMcpNativeIdentity, originalMcpNativeAttestationMessage } from "../dist/original-mcp-native-identity.js";
import { originalMcpNativeRequestMethods, originalMcpNativeRequestProtocol, originalMcpNativeRequestSession,
  originalMcpNativeResult, originalMcpNativeErrorResult, createOriginalMcpNativeRequestPolicy,
  waitForOriginalMcpNativeSupport } from "../dist/original-mcp-native-request.js";
import { createOriginalMcpNativeHost } from "../dist/original-mcp-native-host.js";
import { createOriginalMcpNativeSourcePolicies } from "../dist/original-mcp-native-source-policy.js";
import { parseOriginalNativeSourcePayload } from "../dist/original-mcp-native-source-contracts.js";
import { originalPublicMcpContracts } from "../dist/native-public-original-mcp-contracts.js";
import { createNativePublicOwnerBackend, nativePublicFullOptions } from "../dist/native-public-mcp-owner.js";
import { startNativePublicMcp } from "../dist/native-public-mcp.js";
import { hydrateOriginalMcpTodo } from "../dist/original-mcp-domains.js";
import { createOriginalMcpTodoGenesisPort } from "../dist/original-mcp-todo-genesis-native.js";
import { originalMcpTodoGenesisMethod, parseOriginalMcpTodoGenesisPayload,
  originalMcpTodoGenesisRequestDigest as digest } from "../dist/original-mcp-todo-genesis-contracts.js";
import { pinnedOriginalKnowledgeWriterFixture } from "./original-knowledge-writer-fixture.mjs";

export const hash = bytes => createHash("sha256").update(bytes).digest("hex");
export const value = response => response.structuredContent ?? JSON.parse(response.content[0].text);
export async function nativeTodoSourceFixture(t, { imported = false } = {}) {
  assert(process.env.PKM_TEST_WORKSPACE, "Use the existing isolated framework.");
  assert(process.env.PKM_TEST_PYTHON);
  process.umask(0o077);
  assert(originalMcpNativeRequestMethods.includes(originalMcpTodoGenesisMethod),
    "Run only after Parent's normal emission includes actual method26; no override or skipped positive.");
  const base = resolve(".pkm-test-evidence", `todo-source-${randomUUID()}`);
  const endpoint = resolve(`.nts-${randomBytes(4).toString("hex")}`), cleanups = [];
  await mkdir(join(base, "oracle"), { recursive: true, mode: 0o700 }); await mkdir(endpoint, { mode: 0o700 });
  t.after(async () => {
    for (const close of cleanups.reverse()) await close();
    await rm(endpoint, { recursive: true, force: true }); await rm(base, { recursive: true, force: true });
  });
  const oracle = pinnedOriginalKnowledgeWriterFixture({ directory: join(base, "oracle"),
    legacyVsix: process.env.PKM_LEGACY_VSIX, python: process.env.PKM_TEST_PYTHON });
  const root = join(base, "oracle/library"); await mkdir(root, { mode: 0o700 });
  oracle.run(root, `
    store.noteUpsert({ title:"Entry", slug:"Entry", content:"Standalone public Todo Source fixture.", tags:[], type:"general" });
    store.noteUpsert({ title:"Secret", slug:"Private/Secret", category:"Private", content:"PRIVATE_TODO_SOURCE_SENTINEL", tags:[], type:"general" });
    if(input.imported)store.todoBoardCreate("Team/Imported","Imported","Team");
    return store.noteGet("Entry");
  `, { imported });
  await writeFile(join(root, ".pkm/content-privacy.json"), '{"schema":1,"private":{"notes":["Private"]}}', { mode: 0o600 });
  const catalog = originalPublicMcpContracts(), profileSha256 = hash("isolated-signed-todo-source");
  const custody = await captureOriginalMcpCustody({ root, backup: join(base, "custody"), operatorId: "todo-source-test",
    profileSha256, limits: { maxEntries: 1000, maxDepth: 32, maxBytes: 4_194_304, maxFileBytes: 2_097_152 } });
  const actor = Object.freeze({ id: "mcp:external", canWrite: true });
  const opened = await openOriginalMcpRoot(custody, { prepareNative: storage => nativePublicFullOptions(storage, { actor }) });
  cleanups.push(() => opened.owner.close());
  const frames = [], controls = { denyPublic: new Set(), denyGenesis: false, genesisTtlMs: 60000 };
  const keys = generateKeyPairSync("ed25519"), identity = originalMcpNativeIdentity(
    keys.publicKey.export({ format: "der", type: "spki" }).toString("base64"), profileSha256);
  const binding = { root, workspaceId: opened.workspaceId, planSha256: custody.planSha256, profileSha256,
    catalogSha256: catalog.provenance.metadataSha256, payloadBuildId: hash("todo-source-test-payload"),
    hostEntrySha256: hash("todo-source-test-host") };
  const server = await startOriginalMcpNativeAttachmentServer({ directory: endpoint, identity, identitySha256: identity.sha256,
    binding, maxPacketBytes: 65536, heartbeatIntervalMs: 100, heartbeatTimeoutMs: 1000 });
  cleanups.push(() => server.close());
  const socket = connect(join(endpoint, "n")); cleanups.push(async () => socket.destroy());
  let buffer = "", attachedResolve;
  const attached = new Promise(resolve => { attachedResolve = resolve; });
  const send = message => socket.write(JSON.stringify(message) + "\n");
  socket.on("error", () => socket.destroy());
  socket.on("data", bytes => {
    buffer += bytes.toString("utf8");
    for (let end; (end = buffer.indexOf("\n")) >= 0;) {
      const frame = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
      if (frame.type === "challenge") {
        const { body, message } = originalMcpNativeAttestationMessage(frame.challenge, identity.sha256, randomUUID());
        send({ type: "attestation", attestation: { ...body, signature: sign(null, message, keys.privateKey).toString("base64") } });
      } else if (frame.type === "attached") attachedResolve();
      else if (frame.type === "ping") send({ type: "pong", nonce: frame.nonce });
      else if (frame.type === "native-request") {
        frames.push(frame);
        if (frame.method === "admission.approve") send(originalMcpNativeResult(frame, { decision: "approve" }));
        else if (frame.method === "public.approve") send(originalMcpNativeResult(frame, {
          decision: controls.denyPublic.has(frame.payload.request.operation) ? "deny" : "approve",
        }));
        else if (frame.method === "todo.source.approve") {
          parseOriginalNativeSourcePayload(frame.method, frame.payload, frame.session);
          send(originalMcpNativeResult(frame, { actorId: "mcp:external", decisionId: randomUUID(), expiresAtMs: Date.now() + 60000 }));
        } else if (frame.method === originalMcpTodoGenesisMethod) {
          const payload = parseOriginalMcpTodoGenesisPayload(frame.payload, frame.session);
          send(originalMcpNativeResult(frame, controls.denyGenesis ? null : {
            decision: "approve", actorId: "mcp:external", decisionId: randomUUID(), epoch: payload.request.nativeEpoch,
            requestSha256: payload.requestSha256, operationId: payload.request.operationId,
            expiresAtMs: Date.now() + controls.genesisTtlMs,
          }));
        } else send(originalMcpNativeErrorResult(frame, "NATIVE_DENIED"));
      }
    }
  });
  await attached;
  const session = await server.waitForSession({ timeoutMs: 2000 });
  send({ type: "native-supports", protocol: originalMcpNativeRequestProtocol,
    session: originalMcpNativeRequestSession(session), methods: [...originalMcpNativeRequestMethods], maxPacketBytes: 65536 });
  await waitForOriginalMcpNativeSupport(session, { timeoutMs: 2000 });
  const host = await createOriginalMcpNativeHost(opened.storage, createOriginalMcpNativeRequestPolicy(session));
  cleanups.push(() => host.close());
  const source = createOriginalMcpNativeSourcePolicies(opened.storage, host, session);
  cleanups.push(async () => source.dispose());
  const port = createOriginalMcpTodoGenesisPort(opened.storage, host, session);
  const backend = createNativePublicOwnerBackend(opened.owner, { actor, originalMcpHost: host });
  cleanups.push(() => backend.close());
  await backend.prepareFull();
  if (imported) await hydrateOriginalMcpTodo(opened.storage, host, ["Team/Imported"], source.todo);
  const managed = join(base, "mcp"); await mkdir(managed, { mode: 0o700 });
  const generation = randomUUID();
  await writeFile(join(managed, "active-generation.json"), JSON.stringify({ schema: "pkm.mcp.lifecycle/v1", generation }), { mode: 0o600 });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const serving = await startNativePublicMcp(backend, { writable: actor.canWrite, catalogProfile: "original-full",
    manifest: { managedRoot: managed, generation, version: "0.1.0", runtimeBuild: hash("source-only-fixture"), components: {} },
    closeBackend: () => backend.close() }, serverTransport);
  cleanups.push(() => serving.close());
  const client = new Client({ name: "signed-todo-source-only", version: "1" });
  cleanups.push(() => client.close()); await client.connect(clientTransport);
  const contracts = new Map(), trace = [];
  async function call(tool, args) {
    let contract = contracts.get(tool);
    if (!contract) {
      contract = value(await client.callTool({ name: "capabilities_describe", arguments: { operation: `mcp.tool.${tool}` } }));
      assert.equal(contract.id, `mcp.tool.${tool}`); contracts.set(tool, contract);
    }
    const response = await client.callTool({ name: contract.readOnly ? "capability_read" : "capability_call",
      arguments: { operation: contract.id, version: 1, arguments: args } });
    trace.push({ operation: contract.id, isError: response.isError === true, requestSha256: digest(args) });
    return response;
  }
  async function ok(tool, args) {
    const response = await call(tool, args); assert.notEqual(response.isError, true, JSON.stringify(response));
    return value(response);
  }
  return { ...opened, root, actor, host, port, source, session, socket, client, frames, controls, call, ok, trace, oracle, custody,
    snapshot: async slug => Promise.all([readFile(join(root, `notes/${slug}.md`)),
      readFile(join(root, `notes/${slug}.assets/pkm-todo-board.json`))]) };
}
