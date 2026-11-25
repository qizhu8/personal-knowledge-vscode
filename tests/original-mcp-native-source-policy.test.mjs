import assert from "node:assert/strict";
import { createHash, createPublicKey, generateKeyPairSync, randomBytes, randomUUID, sign } from "node:crypto";
import { createRequire } from "node:module";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startOriginalMcpNativeAttachmentServer } from "../dist/original-mcp-native-attachment.js";
import { originalMcpNativeIdentity, originalMcpNativeAttestationMessage } from "../dist/original-mcp-native-identity.js";
import { originalMcpNativeRequestMethods, originalMcpNativeRequestProtocol, originalMcpNativeRequestSession,
  originalMcpNativeResult, createOriginalMcpNativeRequestPolicy, waitForOriginalMcpNativeSupport } from "../dist/original-mcp-native-request.js";
import { createOriginalMcpNativeHost } from "../dist/original-mcp-native-host.js";
import { createOriginalMcpNativeSourcePolicies, assertOriginalMcpNativeSourcePolicy } from "../dist/original-mcp-native-source-policy.js";
import { originalNativeSourceMethods } from "../dist/original-mcp-native-source-contracts.js";
import { captureOriginalMcpCustody, openOriginalMcpRoot } from "../dist/original-mcp-root.js";
import { hydrateOriginalMcpTodo } from "../dist/original-mcp-domains.js";
import { readOriginalMcpDomain, assertOriginalMcpTodoSession } from "../dist/original-mcp-domain-state.js";
import { planOriginalMcpApiChatSource, admitOriginalMcpApiChatSource, originalMcpApiChatSourceActive,
  activateOriginalMcpApiChatSource, readOriginalMcpApiChatSourceSession } from "../dist/original-mcp-api-chat-source.js";
import { originalPublicMcpContracts } from "../dist/native-public-original-mcp-contracts.js";

assert(process.env.PKM_TEST_WORKSPACE, "Run source policy tests with the existing private Linux framework.");
process.umask(0o077);
const hash = value => createHash("sha256").update(value).digest("hex"), require = createRequire(import.meta.url);
const store = require("../legacy/dist/knowledge/filestore.js");
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function fixture(t) {
  const directory = join(process.env.PKM_TEST_WORKSPACE, `source-policy-${randomUUID()}`), root = join(directory, "root");
  let opened, host, producer, server, socket, endpoint;
  await mkdir(root, { recursive: true, mode: 0o700 });
  t.after(async () => {
    producer?.dispose(); socket?.destroy(); await server?.close();
    await host?.close(); await opened?.owner.close();
    if (endpoint) await rm(endpoint, { recursive: true });
    await rm(directory, { recursive: true });
  });
  store.setStorePath(root); store.todoBoardCreate("Team/Board", "Board", "Team");
  await mkdir(join(root, ".pkm"), { recursive: true, mode: 0o700 });
  await writeFile(join(root, ".pkm/content-privacy.json"), '{"schema":1,"private":{}}', { mode: 0o600 });
  const original = await readFile(join(root, "notes/Team/Board.assets/pkm-todo-board.json"));
  const profileSha256 = hash("isolated-native-source-profile");
  const plan = await captureOriginalMcpCustody({ root, backup: join(directory, "custody"), operatorId: "source-policy-fixture",
    profileSha256, limits: { maxEntries: 1000, maxDepth: 32, maxBytes: 1048576, maxFileBytes: 1048576 } });
  opened = await openOriginalMcpRoot(plan);
  const keys = generateKeyPairSync("ed25519"), identity = originalMcpNativeIdentity(
    createPublicKey(keys.privateKey).export({ format: "der", type: "spki" }).toString("base64"), profileSha256);
  endpoint = join(homedir(), ".local/state/pkm-v5-recovery", `s-${randomBytes(4).toString("hex")}`);
  await mkdir(endpoint, { mode: 0o700 });
  const binding = { root, workspaceId: opened.workspaceId, planSha256: plan.planSha256,
    catalogSha256: originalPublicMcpContracts().provenance.metadataSha256, profileSha256,
    payloadBuildId: hash("fixture-payload"), hostEntrySha256: hash("fixture-host") };
  server = await startOriginalMcpNativeAttachmentServer({ directory: endpoint, identity, identitySha256: identity.sha256,
    binding, maxPacketBytes: 65536, heartbeatIntervalMs: 100, heartbeatTimeoutMs: 1000 });
  socket = connect(join(endpoint, "n"));
  let buffer = "", attachedResolve;
  const attached = new Promise(resolve => { attachedResolve = resolve; });
  const frames = [], controls = { allow: true, pending: false };
  const send = value => socket.write(JSON.stringify(value) + "\n");
  socket.on("error", () => socket.destroy());
  socket.on("data", chunk => {
    buffer += chunk.toString("utf8");
    let boundary;
    while ((boundary = buffer.indexOf("\n")) >= 0) {
      const frame = JSON.parse(buffer.slice(0, boundary)); buffer = buffer.slice(boundary + 1);
      if (frame.type === "challenge") {
        const { body, message } = originalMcpNativeAttestationMessage(frame.challenge, identity.sha256, randomUUID());
        send({ type: "attestation", attestation: { ...body, signature: sign(null, message, keys.privateKey).toString("base64") } });
      } else if (frame.type === "attached") attachedResolve();
      else if (frame.type === "ping") send({ type: "pong", nonce: frame.nonce });
      else if (frame.type === "native-request") {
        frames.push(frame);
        if (frame.method === "admission.approve") send(originalMcpNativeResult(frame, { decision: "approve" }));
        else if (!controls.pending) send(originalMcpNativeResult(frame, controls.allow
          ? { actorId: "mcp:external", decisionId: randomUUID(), expiresAtMs: Date.now() + 60000 } : null));
      }
    }
  });
  await attached;
  const session = await server.waitForSession({ timeoutMs: 1000 });
  send({ type: "native-supports", protocol: originalMcpNativeRequestProtocol, session: originalMcpNativeRequestSession(session),
    methods: [...originalMcpNativeRequestMethods], maxPacketBytes: 65536 });
  await waitForOriginalMcpNativeSupport(session, { timeoutMs: 1000 });
  host = await createOriginalMcpNativeHost(opened.storage, createOriginalMcpNativeRequestPolicy(session));
  producer = createOriginalMcpNativeSourcePolicies(opened.storage, host, session);
  return { directory, root, opened, host, producer, session, socket, frames, controls, original };
}

test("actual signed same-owner source adapter fails closed for missing methods; integrated grants revoke cached Core source access", { timeout: 120000 }, async t => {
  const f = await fixture(t);
  for (const domain of ["todo", "memory", "chat"])
    assert.doesNotThrow(() => assertOriginalMcpNativeSourcePolicy(f.producer[domain], f.opened.storage, f.host, domain));
  assert.throws(() => assertOriginalMcpNativeSourcePolicy({ ...f.producer.todo }, f.opened.storage, f.host, "todo"),
    { code: "NATIVE_SOURCE_POLICY_REQUIRED" });
  assert.throws(() => assertOriginalMcpNativeSourcePolicy(f.producer.memory, f.opened.storage, f.host, "todo"),
    { code: "NATIVE_SOURCE_POLICY_REQUIRED" });
  const hydrate = () => hydrateOriginalMcpTodo(f.opened.storage, f.host, ["Team/Board"], f.producer.todo);
  const missing = originalNativeSourceMethods.some(method => !originalMcpNativeRequestMethods.includes(method));
  if (missing) {
    await assert.rejects(hydrate(), { code: "MISSING_NATIVE_METHOD" });
    assert.equal(readOriginalMcpDomain(f.root, "todo"), undefined);
    assert.throws(() => assertOriginalMcpTodoSession(f.root, "mcp:external"));
    assert.equal(f.frames.filter(frame => frame.method.endsWith(".source.approve")).length, 0);
    t.diagnostic("Shared native source method integration is absent: real signed source activation remains closed, not fixture-qualified.");
  } else {
    await hydrate(); assertOriginalMcpTodoSession(f.root, "mcp:external");
    const stage = join(f.directory, "chat-stage"); await mkdir(stage, { mode: 0o700 });
    const source = await planOriginalMcpApiChatSource(f.opened.storage, f.host, {
      stagingDirectory: stage, limits: { maxChats: 4, maxMessagesPerChat: 16, maxMessages: 64 } });
    await admitOriginalMcpApiChatSource(f.opened.storage, f.host, source, f.producer.chat);
    assert.equal(originalMcpApiChatSourceActive(f.opened.storage, f.host), true);
    const chatSource = readOriginalMcpApiChatSourceSession(f.opened.storage, f.host);
    f.producer.revoke("todo");
    assert.throws(() => assertOriginalMcpTodoSession(f.root, "mcp:external"),
      /fresh exact native Todo source admission/);
    assert.equal(originalMcpApiChatSourceActive(f.opened.storage, f.host), true, "Source grants remain independent.");
    await hydrate(); assertOriginalMcpTodoSession(f.root, "mcp:external");
    f.producer.revoke("chat");
    f.session.assertCurrent();
    assert.equal(Atomics.load(new Int32Array(chatSource.revocation), 0), 1);
    assert.equal(originalMcpApiChatSourceActive(f.opened.storage, f.host), false);
    assert.throws(() => readOriginalMcpApiChatSourceSession(f.opened.storage, f.host));
    assertOriginalMcpTodoSession(f.root, "mcp:external");
    await activateOriginalMcpApiChatSource(f.opened.storage, f.host, f.producer.chat);
    const currentChatSource = readOriginalMcpApiChatSourceSession(f.opened.storage, f.host);
    assert.notEqual(currentChatSource.revocation, chatSource.revocation);
    f.controls.allow = false;
    await assert.rejects(hydrate(), /fresh bounded native UI/i);
    assert.throws(() => assertOriginalMcpTodoSession(f.root, "mcp:external"));
    f.controls.allow = true; await hydrate();
    await f.session.close();
    for (let count = 0; count < 100 && !f.session.signal.aborted; count++) await delay(5);
    assert.throws(() => assertOriginalMcpTodoSession(f.root, "mcp:external"));
    assert.equal(Atomics.load(new Int32Array(currentChatSource.revocation), 0), 1);
    assert.equal(originalMcpApiChatSourceActive(f.opened.storage, f.host), false);
    assert.throws(() => readOriginalMcpApiChatSourceSession(f.opened.storage, f.host));
  }
  assert.deepEqual(await readFile(join(f.root, "notes/Team/Board.assets/pkm-todo-board.json")), f.original);
});
