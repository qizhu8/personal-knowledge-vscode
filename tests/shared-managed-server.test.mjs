import assert from "node:assert/strict";
import test from "node:test";
import { createHash, randomUUID } from "node:crypto";
import { Agent, request as httpRequest } from "node:http";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { initialize, Storage } from "../dist/storage.js";
import { createWorkspaceBackup } from "../dist/workspace-backup.js";
import { startSharedManagedServer } from "../dist/shared-managed-server.js";
import { sharedManagedRequest, sharedManagementBodySha256 } from "../dist/shared-managed-client.js";
import { stageIsolatedManagedGeneration, publishIsolatedManagedGeneration, verifyIsolatedManagedGeneration } from "../experimental/managed-migration.mjs";

const business = "business-".repeat(8), management = "management-".repeat(8);
const unwrap = response => response.structuredContent ?? JSON.parse(response.content[0].text);

test("unadvertised native Action source formats reject a verified receiver before writer drain",
  { timeout: 180000 }, async t => {
    const root = resolve("tests", `.action-protocol-${randomUUID()}`); await mkdir(root, { mode: 0o700 });
    const data = await initialize(join(root, "data"), { storageLayout: "separated" });
    const directory = join(data, "server-data/runtime-control/shared-manager"), managedRoot = join(root, "managed");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const first = await stageIsolatedManagedGeneration({ managedRoot, data, allowWrites: true });
    assert(first.compatibility.originalMcpSourceProtocol.action, "The actual producer must advertise its new Action formats.");
    await publishIsolatedManagedGeneration(managedRoot, first.generation);
    const service = await startSharedManagedServer({ directory, managedRoot, token: business, managementToken: management });
    t.after(async () => { await service.close(); await rm(root, { recursive: true, force: true }); });
    const second = await stageIsolatedManagedGeneration({ managedRoot, data, allowWrites: true });
    const candidate = join(managedRoot, "generations", second.generation), manifestPath = join(candidate, "manifest.json");
    delete second.compatibility.originalMcpSourceProtocol.action;
    await writeFile(manifestPath, JSON.stringify(second));
    await assert.rejects(verifyIsolatedManagedGeneration(managedRoot, second.generation), /source protocol advertisement/);
    const name = "runtime/next-server/dist/original-mcp-source-protocol.json";
    const declaration = JSON.stringify(second.compatibility.originalMcpSourceProtocol) + "\n";
    await writeFile(join(candidate, name), declaration);
    second.files[name] = createHash("sha256").update(declaration).digest("hex");
    second.runtimeBuild = createHash("sha256").update(Object.keys(second.files).sort()
      .map(name => `${name}\0${second.files[name]}\0`).join("")).digest("hex");
    await writeFile(manifestPath, JSON.stringify(second));
    await verifyIsolatedManagedGeneration(managedRoot, second.generation);
    const pid = service.status().backendPid, pointer = await readFile(join(managedRoot, "latest-generation.json"));
    const admin = { origin: service.url, serviceId: service.serviceId, token: management };
    const approved = await sharedManagedRequest(admin, "/manage/approve", { action: "switch", generation: second.generation });
    await assert.rejects(sharedManagedRequest(admin, "/manage/switch", {
      approvalId: approved.approvalId, generation: second.generation,
    }), /Incompatible staged backend/);
    assert.equal(service.status().phase, "accepting");
    assert.equal(service.status().backendPid, pid);
    assert.equal(service.status().generation, first.generation);
    assert.deepEqual(await readFile(join(managedRoot, "latest-generation.json")), pointer);
  });

test("source protocol mismatch or omitted v3 advertisement rejects candidate selection before draining the current writer",
  { timeout: 180000 }, async t => {
    const root = resolve("tests", `.source-protocol-${randomUUID()}`);
    await mkdir(root, { mode: 0o700 });
    const data = await initialize(join(root, "data"), { storageLayout: "separated" });
    const directory = join(data, "server-data/runtime-control/shared-manager"), managedRoot = join(root, "managed");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(join(data, "notes/Entry.md"), "---\ntitle: Retained\n---\nNever rewrite during incompatible selection.\n");
    const source = await readFile(join(data, "notes/Entry.md"));
    const first = await stageIsolatedManagedGeneration({ managedRoot, data, allowWrites: true });
    assert(first.compatibility.originalMcpSourceProtocol.custody.includes("pkm.original-mcp-custody/v3"));
    await publishIsolatedManagedGeneration(managedRoot, first.generation);
    const service = await startSharedManagedServer({ directory, managedRoot, token: business, managementToken: management });
    t.after(async () => { await service.close(); await rm(root, { recursive: true, force: true }); });
    const second = await stageIsolatedManagedGeneration({ managedRoot, data, allowWrites: true });
    const candidateDirectory = join(managedRoot, "generations", second.generation);
    const candidatePath = join(candidateDirectory, "manifest.json");
    const oldPid = service.status().backendPid;
    const pointer = await readFile(join(managedRoot, "latest-generation.json"));
    delete second.compatibility.originalMcpSourceProtocol;
    await writeFile(candidatePath, JSON.stringify(second));
    await assert.rejects(verifyIsolatedManagedGeneration(managedRoot, second.generation), /source protocol advertisement/);
    const descriptorPath = "runtime/next-server/dist/original-mcp-source-protocol.js";
    await rm(join(candidateDirectory, descriptorPath));
    delete second.files[descriptorPath];
    const declarationPath = "runtime/next-server/dist/original-mcp-source-protocol.json";
    await rm(join(candidateDirectory, declarationPath));
    delete second.files[declarationPath];
    second.runtimeBuild = createHash("sha256").update(Object.keys(second.files).sort()
      .map(name => `${name}\0${second.files[name]}\0`).join("")).digest("hex");
    await writeFile(candidatePath, JSON.stringify(second));
    await verifyIsolatedManagedGeneration(managedRoot, second.generation);
    const admin = { origin: service.url, serviceId: service.serviceId, token: management };
    const approval = await sharedManagedRequest(admin, "/manage/approve", { action: "switch", generation: second.generation });
    await assert.rejects(sharedManagedRequest(admin, "/manage/switch", { approvalId: approval.approvalId, generation: second.generation }),
      /Incompatible staged backend/);
    assert.equal(service.status().phase, "accepting");
    assert.equal(service.status().backendPid, oldPid);
    assert.equal(service.status().generation, first.generation);
    assert.deepEqual(await readFile(join(managedRoot, "latest-generation.json")), pointer);
    assert.deepEqual(await readFile(join(data, "notes/Entry.md")), source);
  });
async function until(observe) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (await observe()) return;
    await new Promise(ready => setTimeout(ready, 20));
  }
  assert.fail("Actual shared service condition did not settle.");
}

test("two actual enrolled MCP clients share one writer through approved handoff, crash recovery and derived-only reset", { timeout: 240_000 }, async t => {
  const root = resolve("tests", `.shared-service-${randomUUID()}`);
  await mkdir(root, { mode: 0o700 });
  const data = await initialize(join(root, "data"), { storageLayout: "separated" });
  const directory = join(data, "server-data", "runtime-control", "shared-manager");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(join(data, "notes", "Entry.md"), "---\ntitle: Shared entry\n---\nOriginal source bytes.\n");
  const source = await readFile(join(data, "notes", "Entry.md"));
  const managedRoot = join(root, "managed");
  const first = await stageIsolatedManagedGeneration({ managedRoot, data, allowWrites: true });
  const second = await stageIsolatedManagedGeneration({ managedRoot, data, allowWrites: true });
  await publishIsolatedManagedGeneration(managedRoot, first.generation);
  let service = await startSharedManagedServer({ directory, managedRoot, token: business, managementToken: management });
  const sessions = [];
  t.after(async () => {
    for (const client of sessions) await client.close().catch(() => {});
    await service.close();
    await rm(root, { recursive: true, force: true });
  });
  assert.equal(service.status().phase, "accepting");
  await assert.rejects(startSharedManagedServer({ directory, managedRoot, token: business, managementToken: management }), /guard|held/);
  const binding = { origin: service.url, serviceId: service.serviceId, token: business };
  const admin = { ...binding, token: management };
  const request = (path, body) => sharedManagedRequest(binding, path, body);
  const manage = async (action, fields = {}) => {
    const approval = await sharedManagedRequest(admin, "/manage/approve", { action, ...fields });
    return sharedManagedRequest(admin, `/manage/${action}`, { approvalId: approval.approvalId, ...fields });
  };
  await assert.rejects(sharedManagedRequest(binding, "/manage/approve", { action: "switch", generation: second.generation }), /authority/);
  await assert.rejects(sharedManagedRequest({ ...binding, serviceId: randomUUID() }, "/shared/status"), /identity/);
  assert.deepEqual(service.status().protocols, { coreHttp: false, browserChat: false, mcp: "native-compact" });
  assert(!service.status().enabledOperationIds.includes("mcp.tool.api_chat"));
  const browser = await fetch(`${service.url}/webview/`, { headers: { authorization: `Bearer ${business}` } });
  assert.equal(browser.status, 501);
  assert.deepEqual(await browser.json(), {
    error: "Browser unavailable: the native public MCP backend does not expose a compatible browser authority.",
    backendAbi: "pkm.mcp.api/1", effect: "not-committed",
  });

  for (let index = 0; index < 2; index++) {
    const transport = new StdioClientTransport({ command: process.execPath,
      args: [resolve("dist/shared-managed-relay.js")], stderr: "pipe",
      env: { PKM_SHARED_ORIGIN: service.url, PKM_SHARED_SERVICE_ID: service.serviceId, PKM_SHARED_TOKEN: business } });
    const client = new Client({ name: `shared-real-client-${index}`, version: "1" });
    await client.connect(transport); sessions.push(client);
    assert((await client.listTools()).tools.some(tool => tool.name === "capability_read"));
  }
  assert.equal(service.status().clients, 2);
  const read = client => client.callTool({ name: "capability_read",
    arguments: { operation: "mcp.tool.get_note", version: 1, arguments: { slug: "Entry" } } });
  assert.match(JSON.stringify(unwrap(await read(sessions[0]))), /Original source bytes/);
  const oldPid = service.status().backendPid;
  const approval = await sharedManagedRequest(admin, "/manage/approve", { action: "switch", generation: second.generation });
  await assert.rejects(sharedManagedRequest(admin, "/manage/switch",
    { approvalId: approval.approvalId, generation: first.generation }), /approval/);
  const switched = await manage("switch", { generation: second.generation });
  assert.equal(switched.generation, second.generation);
  assert.equal(switched.clients, 2);
  assert.notEqual(switched.backendPid, oldPid);
  assert.throws(() => process.kill(oldPid, 0), { code: "ESRCH" });
  for (const client of sessions) assert.match(JSON.stringify(unwrap(await read(client))), /Original source bytes/);
  const created = await sessions[0].callTool({ name: "capability_call",
    arguments: { operation: "mcp.tool.add_note", version: 1,
      arguments: { title: "SharedOnce", content: "One actual managed writer." } } });
  assert(!created.isError, JSON.stringify(created));
  const written = await readFile(join(data, "notes", "SharedOnce.md"));
  assert.match(written.toString(), /One actual managed writer/);
  await assert.rejects(sessions[0].callTool({ name: "capability_call",
    arguments: { operation: "chat.turn.start", version: 1, arguments: {} } }), /background writers|scope/i);
  assert.equal(service.status().inFlight, 0, "Excluded asynchronous Chat work was never dispatched.");

  const interruptedPid = service.status().backendPid;
  process.kill(interruptedPid, "SIGSTOP");
  const uncertain = sessions[1].callTool({ name: "capability_call",
    arguments: { operation: "mcp.tool.add_note", version: 1,
      arguments: { title: "NotReplayed", content: "This unknown request must never be resubmitted." } } });
  const failed = assert.rejects(uncertain, /unknown|reconcile|receipt/i);
  try {
    await until(() => service.status().inFlight === 1);
    process.kill(interruptedPid, "SIGKILL");
  } finally {
    try { process.kill(interruptedPid, "SIGCONT"); } catch { /* The interrupted process already exited. */ }
  }
  await failed;
  await until(() => service.status().phase === "action-required");
  assert.equal(service.status().uncertain.length, 1);
  await assert.rejects(manage("recover"), /reconciliation/);
  const receiptId = service.status().uncertain[0].id;
  await manage("reconcile", { receiptId, acknowledge: "reviewed-outcome-no-replay" });
  assert(JSON.parse(await readFile(join(directory, "shared-manager.json"), "utf8")).history
    .some(item => item.action === "reconcile" && item.receiptId === receiptId && item.phase === "completed"));
  const recovered = await manage("recover");
  assert.equal(recovered.phase, "accepting");
  for (const client of sessions) assert.match(JSON.stringify(unwrap(await read(client))), /Original source bytes/);
  assert.deepEqual(await readFile(join(data, "notes", "SharedOnce.md")), written, "Crash recovery never replays writes.");
  await assert.rejects(readFile(join(data, "notes", "NotReplayed.md")), { code: "ENOENT" });
  assert.equal((await manage("reset-index")).phase, "accepting");
  assert.deepEqual(await readFile(join(data, "notes", "Entry.md")), source);
  assert.deepEqual(await readFile(join(data, "notes", "SharedOnce.md")), written);
  for (const client of sessions) await client.close();
  await until(() => service.status().clients === 0);
  const serviceId = service.serviceId;
  await service.close();
  const history = JSON.parse(await readFile(join(directory, "shared-manager.json"), "utf8")).history;
  service = await startSharedManagedServer({ directory, managedRoot, token: business, managementToken: management });
  assert.equal(service.serviceId, serviceId, "A clean service restart preserves its authenticated identity.");
  assert.equal(service.status().generation, second.generation);
  assert.deepEqual(JSON.parse(await readFile(join(directory, "shared-manager.json"), "utf8")).history, history);
  assert.deepEqual(await readFile(join(data, "notes", "SharedOnce.md")), written);
});

test("canonical Core MCP and HTTP share one actor and durable sessions across a stable two-client handoff", { timeout: 240_000 }, async t => {
  const root = resolve("tests", `.shared-core-${randomUUID()}`);
  await mkdir(root, { mode: 0o700 });
  const data = await initialize(join(root, "data"), { storageLayout: "separated" });
  const directory = join(data, "server-data", "runtime-control", "shared-manager"), managedRoot = join(root, "managed");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const endpoint = "https://fixture.invalid/v1";
  const coreHostProfile = {
    schema: "pkm.shared-core-host/v1",
    config: { schema: "pkm.native-host-config/v1", provider: "openai-compatible", endpoint,
      secretRef: "secret:fixture/core", model: "fixture-model", contextWindow: 16384, maxOutputTokens: 4096,
      outputTokenParameter: "max_tokens", includeUsage: false, tools: ["knowledge.document.get"] },
    policy: { allowedProviders: ["openai-compatible"], allowedEndpoints: [endpoint], allowedModels: ["fixture-model"],
      allowedTools: ["knowledge.document.get"] },
    secretEnvironment: { "secret:fixture/core": "PKM_SHARED_TEST_UNUSED_MODEL_KEY" }, humanReview: "browser",
  };
  const first = await stageIsolatedManagedGeneration({ managedRoot, data, allowWrites: true, coreHostProfile });
  const second = await stageIsolatedManagedGeneration({ managedRoot, data, allowWrites: true, coreHostProfile });
  await publishIsolatedManagedGeneration(managedRoot, first.generation);
  const unsafe = await import(pathToFileURL(join(managedRoot, "generations", first.generation,
    "runtime", "next-server", "dist", "shared-managed-server.js")).href);
  await assert.rejects(unsafe.startSharedManagedServer({ directory, managedRoot, token: business,
    managementToken: management, backendKind: "standalone-core" }), /STABLE_MANAGER_PAYLOAD_REQUIRED/);
  await assert.rejects(readFile(join(directory, "shared-manager.json")), { code: "ENOENT" },
    "An unsafe supervisor refuses before creating durable control state or acquiring the workspace writer.");
  let service = await startSharedManagedServer({ directory, managedRoot, token: business,
    managementToken: management, backendKind: "standalone-core" });
  const sessions = [];
  t.after(async () => {
    for (const client of sessions) await client.close().catch(() => {});
    await service.close(); await rm(root, { recursive: true, force: true });
  });
  assert.equal(service.status().phase, "accepting");
  assert.deepEqual(service.status().protocols, { coreHttp: true, browserChat: true, mcp: "canonical-core" });
  for (let index = 0; index < 2; index++) {
    const client = new Client({ name: `canonical-core-${index}`, version: "1" });
    await client.connect(new StdioClientTransport({ command: process.execPath,
      args: [resolve("dist/shared-managed-relay.js")], stderr: "pipe",
      env: { PKM_SHARED_ORIGIN: service.url, PKM_SHARED_SERVICE_ID: service.serviceId, PKM_SHARED_TOKEN: business } }));
    sessions.push(client);
    assert((await client.listTools()).tools.some(tool => tool.name === "server_info"));
    const info = unwrap(await client.callTool({ name: "server_info", arguments: {} }));
    assert.equal(info.result.workspaceId, service.status().workspaceId);
    assert.equal(info.result.actorId, "local:owner");
  }
  const sessionId = randomUUID();
  const created = unwrap(await sessions[0].callTool({ name: "capability_call", arguments: {
    operation: "chat.session.create", version: 1, arguments: {
      id: sessionId, operationId: randomUUID(), expectedRevision: 0, title: "One actual Core session",
    },
  } }));
  assert(!created.error, JSON.stringify(created));
  const read = client => client.callTool({ name: "capability_read",
    arguments: { operation: "chat.session.get", version: 1, arguments: { id: sessionId } } });
  const before = unwrap(await read(sessions[1])).result;
  assert.equal(before.title, "One actual Core session");
  const agent = new Agent({ keepAlive: true, maxSockets: 1 }), sockets = [];
  t.after(() => agent.destroy());
  const httpRead = () => new Promise((ready, reject) => {
    const request = httpRequest(`${service.url}/v1/capability_read`, { agent, method: "POST",
      headers: { authorization: `Bearer ${business}`, "content-type": "application/json", "x-pkm-actor": "invented-admin" } },
    response => {
      let text = ""; response.setEncoding("utf8"); response.on("data", bytes => { text += bytes; });
      response.on("end", () => ready({ status: response.statusCode, body: JSON.parse(text) }));
    });
    request.on("socket", socket => sockets.push(socket)); request.on("error", reject);
    request.end(JSON.stringify({ operation: "chat.session.get", version: 1, arguments: { id: sessionId } }));
  });
  const http = await httpRead();
  assert.equal(http.status, 200);
  assert.deepEqual(http.body.result, before, "HTTP and MCP compose the same actual owner, not parallel stores.");
  assert.equal(service.status().clients, 2);
  for (let index = 0; index < 129; index++) {
    const observed = await httpRead();
    assert.equal(observed.status, 200, `Cookie-less HTTP read ${index + 1} remains admitted.`);
    assert.deepEqual(observed.body.result, before);
  }
  assert.equal(service.status().clients, 2, "Stateless HTTP polling never consumes MCP enrollment slots.");
  assert.equal(service.status().uncertain.length, 0);
  const additional = new Client({ name: "canonical-core-after-http-polling", version: "1" });
  sessions.push(additional);
  await additional.connect(new StdioClientTransport({ command: process.execPath,
    args: [resolve("dist/shared-managed-relay.js")], stderr: "pipe",
    env: { PKM_SHARED_ORIGIN: service.url, PKM_SHARED_SERVICE_ID: service.serviceId, PKM_SHARED_TOKEN: business } }));
  assert.equal(service.status().clients, 3, "A real MCP client can still enroll after more than 128 HTTP requests.");
  assert.deepEqual(unwrap(await read(additional)).result, before);
  await additional.close(); sessions.pop();
  await until(() => service.status().clients === 2);
  const admin = { origin: service.url, serviceId: service.serviceId, token: management };
  await assert.rejects(sharedManagedRequest({ ...admin, token: business }, "/manage/candidates"), /authority/i);
  const candidates = await sharedManagedRequest(admin, "/manage/candidates");
  assert.equal(candidates.schema, "pkm.shared-service-candidates/v1");
  assert.equal(candidates.activeGeneration, first.generation);
  assert.deepEqual(new Set(candidates.items.map(item => item.generation)), new Set([first.generation, second.generation]));
  assert(candidates.items.every(item => item.compatible && item.backendKind === "standalone-core"));
  const invalid = randomUUID();
  await mkdir(join(managedRoot, "generations", invalid), { mode: 0o700 });
  try {
    const observed = await sharedManagedRequest(admin, "/manage/candidates");
    assert(!observed.items.some(item => item.generation === invalid));
    assert.equal(observed.rejectedCount, 1, "Unverified candidate directories are never offered for management selection.");
  } finally { await rm(join(managedRoot, "generations", invalid), { recursive: true }); }
  await assert.rejects(sharedManagedRequest({ ...admin, token: business }, "/manage/approve",
    { action: "human-review-enrollment" }), /authority/i);
  const enrollHuman = async () => {
    const approval = await sharedManagedRequest(admin, "/manage/approve", { action: "human-review-enrollment" });
    return sharedManagedRequest(admin, "/manage/human-review-enrollment", { approvalId: approval.approvalId });
  };
  const staleHuman = await enrollHuman(), human = await enrollHuman();
  assert.notEqual(staleHuman.code, human.code, "A new explicit grant invalidates the previous unused enrollment code.");
  for (const asset of ["/human-review", "/human-review-host.mjs", "/human-review.mjs", "/human-review.css"]) {
    const response = await fetch(`${service.url}${asset}`);
    assert.equal(response.status, 200, asset);
    if (asset === "/human-review") assert.match(response.headers.get("content-security-policy"), /frame-ancestors 'none'/);
    await response.arrayBuffer();
  }
  const humanRequest = (path, body, extraHeaders = {}) => fetch(`${service.url}/human-review/${path}`, { method: "POST",
    headers: { origin: service.url, "content-type": "application/json", ...extraHeaders }, body: JSON.stringify(body) });
  const expiredGrant = await humanRequest("session", { code: staleHuman.code });
  assert.equal(expiredGrant.status, 403); await expiredGrant.arrayBuffer();
  const businessGrant = await humanRequest("session", { code: human.code }, { authorization: `Bearer ${business}` });
  assert.equal(businessGrant.status, 403, "Business authorization cannot impersonate the independent human channel.");
  await businessGrant.arrayBuffer();
  const bound = await humanRequest("session", { code: human.code });
  assert.equal(bound.status, 200); await bound.arrayBuffer();
  const humanCookie = bound.headers.getSetCookie().find(value => value.startsWith("pkm_human=")).split(";")[0];
  const reviewed = await humanRequest("read", {}, { cookie: humanCookie });
  assert.equal(reviewed.status, 200); await reviewed.json();
  const change = async generation => {
    const approval = await sharedManagedRequest(admin, "/manage/approve", { action: "switch", generation });
    return sharedManagedRequest(admin, "/manage/switch", { generation, approvalId: approval.approvalId });
  };
  const pid = service.status().backendPid;
  await assert.rejects(change(randomUUID()), /generation|ENOENT|missing/i);
  assert.equal(service.status().phase, "accepting", "Invalid candidates must not retire the healthy owner.");
  assert.equal(service.status().backendPid, pid);
  const switchOperation = randomUUID();
  const switchHash = await sharedManagementBodySha256(service.serviceId, "switch", { generation: second.generation });
  const switchApproval = await sharedManagedRequest(admin, "/manage/approve",
    { action: "switch", generation: second.generation, operationId: switchOperation, bodySha256: switchHash });
  const switching = sharedManagedRequest(admin, "/manage/switch", { generation: second.generation,
    operationId: switchOperation, bodySha256: switchHash, approvalId: switchApproval.approvalId });
  await until(async () => (await sharedManagedRequest(admin, "/manage/operation-status",
    { operationId: switchOperation, bodySha256: switchHash })).status === "pending");
  await switching;
  assert.equal((await sharedManagedRequest(admin, "/manage/operation-status",
    { operationId: switchOperation, bodySha256: switchHash })).record.phase, "completed");
  assert.notEqual(service.status().backendPid, pid);
  for (const client of sessions) assert.deepEqual(unwrap(await read(client)).result, before);
  const oldHumanSession = await humanRequest("read", {}, { cookie: humanCookie });
  assert.equal(oldHumanSession.status, 403, "Human approval authority is not silently rebound to the replacement process.");
  await oldHumanSession.arrayBuffer();
  await httpRead();
  const connectedSocket = sockets.at(-1);
  const approval = await sharedManagedRequest(admin, "/manage/approve", { action: "revoke-access" });
  await sharedManagedRequest(admin, "/manage/revoke-access", { approvalId: approval.approvalId,
    acknowledge: "revoke-current-business-credential" });
  for (const client of sessions) await assert.rejects(read(client), /authority|revoked|401/i);
  assert.equal((await httpRead()).status, 401, "A previously connected HTTP client cannot dispatch with revoked credentials.");
  assert.equal(sockets.at(-1), connectedSocket, "Revocation is checked on the actual existing keep-alive connection.");
  assert.equal((await sharedManagedRequest(admin, "/manage/status")).authentication.businessCredential, "revoked");
  await assert.rejects(sharedManagedRequest({ ...admin, token: business }, "/shared/enroll",
    { clientId: randomUUID() }), /authority|revoked/i);
  for (const client of sessions) await client.close();
  const serviceId = service.serviceId;
  await service.close();
  const journal = await readFile(join(directory, "shared-manager.json"), "utf8");
  assert(!journal.includes(business) && !journal.includes(management), "Only non-replayable revoked fingerprints are persisted.");
  assert(!journal.includes(staleHuman.code) && !journal.includes(human.code), "Ephemeral human enrollment authority is never persisted.");
  service = await startSharedManagedServer({ directory, managedRoot, token: business,
    managementToken: management, backendKind: "standalone-core" });
  await assert.rejects(sharedManagedRequest({ origin: service.url, serviceId, token: business }, "/shared/status"), /authority|revoked/i);
  await service.close();
  const replacement = "replacement-business-".repeat(4);
  service = await startSharedManagedServer({ directory, managedRoot, token: replacement,
    managementToken: management, backendKind: "standalone-core" });
  assert.equal(service.serviceId, serviceId);
  assert.equal((await sharedManagedRequest({ origin: service.url, serviceId, token: replacement }, "/shared/status"))
    .authentication.businessCredential, "active");
});

test("a crash journal requires explicit outcome review and recovery; bearer cannot clear it", async t => {
  const root = resolve("tests", `.shared-journal-${randomUUID()}`);
  await mkdir(root, { mode: 0o700 });
  const data = await initialize(join(root, "data"), { storageLayout: "separated" });
  const directory = join(data, "server-data", "runtime-control", "shared-manager"), managedRoot = join(root, "managed");
  await mkdir(directory, { recursive: true, mode: 0o700 }); await mkdir(managedRoot);
  const receiptId = randomUUID(), clientId = randomUUID(), serviceId = randomUUID();
  const journal = { schema: "pkm.shared-manager/v1", serviceId, managedRoot, phase: "accepting",
    receipts: [{ id: receiptId, clientId, tool: "capability_call", generation: randomUUID(), outcome: "pending" }] };
  await writeFile(join(directory, "shared-manager.json"), JSON.stringify(journal), { mode: 0o600 });
  const service = await startSharedManagedServer({ directory, managedRoot, token: business, managementToken: management });
  t.after(async () => { await service.close(); await rm(root, { recursive: true, force: true }); });
  const binding = { origin: service.url, serviceId, token: business }, admin = { ...binding, token: management };
  assert.equal(service.status().phase, "action-required");
  assert.equal(service.status().uncertain[0].id, receiptId);
  assert.equal(service.status().uncertain[0].outcome, "unknown");
  await assert.rejects(sharedManagedRequest(binding, "/manage/reconcile",
    { receiptId, acknowledge: "reviewed-outcome-no-replay" }), /authority/);
  const approval = await sharedManagedRequest(admin, "/manage/approve", { action: "recover" });
  await assert.rejects(sharedManagedRequest(admin, "/manage/recover", { approvalId: approval.approvalId }), /reconciliation/);
  assert.equal(service.status().uncertain.length, 1);
  assert.equal(JSON.parse(await readFile(join(directory, "shared-manager.json"), "utf8")).receipts.length, 1);
  const storage = await Storage.open(data);
  try {
    const options = { async acquireQuiescence() { return { assertHeld() {}, release() {} }; } };
    await assert.rejects(createWorkspaceBackup(storage, join(root, "live-control-backup"), options), /not quiescent|guard|Close the shared manager/i);
    await service.close();
    const before = await readFile(join(directory, "shared-manager.json"));
    await assert.rejects(createWorkspaceBackup(storage, join(root, "unknown-control-backup"), options), /reconcile|unknown|Close the shared manager/i);
    assert.deepEqual(await readFile(join(directory, "shared-manager.json")), before,
      "Refusing an unsafe backup must preserve the only durable unknown-outcome receipt.");
  } finally { await storage.close(); }
});

test("management outcomes survive a lost response and restart without replay; stale, absent and foreign observations stay unknown", async t => {
  const root = resolve("tests", `.shared-management-outcome-${randomUUID()}`);
  await mkdir(root, { mode: 0o700 });
  const data = await initialize(join(root, "data"), { storageLayout: "separated" });
  const directory = join(data, "server-data", "runtime-control", "shared-manager"), managedRoot = join(root, "managed");
  await mkdir(directory, { recursive: true, mode: 0o700 }); await mkdir(managedRoot);
  const serviceId = randomUUID(), receiptId = randomUUID(), generation = randomUUID(), interruptedId = randomUUID();
  const interruptedHash = await sharedManagementBodySha256(serviceId, "recover");
  const path = join(directory, "shared-manager.json");
  await writeFile(path, JSON.stringify({ schema: "pkm.shared-manager/v1", serviceId, managedRoot,
    phase: "accepting", receipts: [{ id: receiptId, clientId: randomUUID(), tool: "capability_call", generation, outcome: "pending" }],
    history: [{ id: interruptedId, action: "recover", from: generation, to: generation,
      phase: "prepared", at: Date.now(), bodySha256: interruptedHash }] }), { mode: 0o600 });
  let service = await startSharedManagedServer({ directory, managedRoot, token: business, managementToken: management });
  let foreign;
  t.after(async () => { await foreign?.close(); await service.close(); await rm(root, { recursive: true, force: true }); });
  const admin = () => ({ origin: service.url, serviceId, token: management });
  const observe = (operationId, bodySha256, binding = admin()) =>
    sharedManagedRequest(binding, "/manage/operation-status", { operationId, bodySha256 });
  const interrupted = await observe(interruptedId, interruptedHash);
  assert.equal(interrupted.status, "unknown");
  assert.equal(interrupted.record.phase, "interrupted", "Prepared operations never become fabricated terminal outcomes on restart.");
  const fields = { receiptId, acknowledge: "reviewed-outcome-no-replay" }, operationId = randomUUID();
  const bodySha256 = await sharedManagementBodySha256(serviceId, "reconcile", fields);
  assert.equal(await sharedManagementBodySha256(serviceId, "reconcile", { ...fields,
    approvalId: "transient-not-hashed", token: business, operationId: randomUUID() }), bodySha256);
  await assert.rejects(sharedManagedRequest(admin(), "/manage/approve", { action: "reconcile", ...fields,
    receiptId: randomUUID(), operationId, bodySha256 }), /semantic|SHA256/i);
  const approval = await sharedManagedRequest(admin(), "/manage/approve",
    { action: "reconcile", ...fields, operationId, bodySha256 });
  await new Promise((ready, reject) => {
    const request = httpRequest(`${service.url}/manage/reconcile`, { method: "POST",
      headers: { authorization: `Bearer ${management}`, "x-pkm-service-id": serviceId, "content-type": "application/json" } },
    response => {
      response.destroy(); request.destroy(); ready();
    });
    request.on("error", error => { if (error.code !== "ECONNRESET") reject(error); });
    request.end(JSON.stringify({ ...fields, approvalId: approval.approvalId, operationId, bodySha256 }));
  });
  assert.equal(service.status().uncertain.length, 0, "The actual review committed despite discarding its HTTP response.");
  const port = Number(new URL(service.url).port);
  await service.close();
  service = await startSharedManagedServer({ directory, managedRoot, token: business, managementToken: management, port });
  const bytes = await readFile(path);
  const outcome = await observe(operationId, bodySha256);
  assert.equal(outcome.status, "terminal");
  assert.equal(outcome.record.id, operationId); assert.equal(outcome.record.phase, "completed");
  assert.equal(outcome.record.action, "reconcile"); assert.equal(outcome.record.receiptId, receiptId);
  const stale = await observe(operationId, "0".repeat(64));
  assert.equal(stale.status, "unknown"); assert.equal(stale.record, undefined);
  const absent = await observe(randomUUID(), bodySha256);
  assert.equal(absent.status, "unknown"); assert.equal(absent.absenceIsNotNoncommit, true);
  await assert.rejects(observe(operationId, bodySha256, { ...admin(), serviceId: randomUUID() }), /identity/i);
  await assert.rejects(observe(operationId, bodySha256, { ...admin(), token: business }), /authority/i);
  assert.deepEqual(await readFile(path), bytes, "Outcome reads never mutate state, recover an owner or re-execute an action.");
  const foreignData = await initialize(join(root, "foreign-data"), { storageLayout: "separated" });
  const foreignDirectory = join(foreignData, "server-data", "runtime-control", "shared-manager");
  await mkdir(foreignDirectory, { recursive: true, mode: 0o700 });
  foreign = await startSharedManagedServer({ directory: foreignDirectory, managedRoot, token: business, managementToken: management });
  const foreignBinding = { origin: foreign.url, serviceId: foreign.serviceId, token: management };
  const foreignObservation = await observe(operationId, bodySha256, foreignBinding);
  assert.equal(foreignObservation.status, "unknown"); assert.equal(foreignObservation.record, undefined);
  assert.notEqual(foreignObservation.serviceId, serviceId);
  await assert.rejects(sharedManagedRequest(foreignBinding, "/manage/approve",
    { action: "reconcile", ...fields, operationId, bodySha256 }), /semantic|SHA256/i);
  await assert.rejects(sharedManagedRequest(admin(), "/manage/approve",
    { action: "reconcile", ...fields, operationId, bodySha256 }), /already observed|re-execution/i);
  const history = (await sharedManagedRequest(admin(), "/manage/status")).history;
  assert.equal(history.filter(item => item.id === operationId).length, 1);
  assert.equal(history.find(item => item.id === operationId).bodySha256, bodySha256);
});
