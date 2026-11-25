import assert from "node:assert/strict";
import test from "node:test";
import { createHash, randomUUID } from "node:crypto";
import { Agent, request as httpRequest } from "node:http";
import { mkdir, readFile, readdir, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { prepareDistinctManagedRuntimeFixture } from "./shared-managed-runtime-fixtures.mjs";

const digest = value => createHash("sha256").update(value).digest("hex");
const unwrap = response => response.structuredContent ?? JSON.parse(response.content[0].text);
async function until(observe) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (await observe()) return;
    await new Promise(ready => setTimeout(ready, 20));
  }
  assert.fail("Actual shared service condition did not settle.");
}

test("distinct compiled Core versions survive A-B-A, official retirement, exact re-staging and unknown-effect recovery", {
  timeout: 600_000,
}, async t => {
  const started = Date.now(), root = resolve("tests", `.distinct-runtime-${randomUUID()}`);
  await mkdir(root, { mode: 0o700 });
  const closes = [], secretName = "PKM_SHARED_TEST_UNUSED_MODEL_KEY", previousSecret = process.env[secretName];
  process.env[secretName] = "unused-offline-fixture-secret";
  t.after(async () => {
    let failure;
    for (const close of closes.reverse()) {
      try { await close(); } catch (error) { failure ??= error; }
    }
    if (previousSecret === undefined) delete process.env[secretName]; else process.env[secretName] = previousSecret;
    if (failure) throw failure;
    await rm(root, { recursive: true, force: true });
  });
  const fixture = await prepareDistinctManagedRuntimeFixture(root);
  const { artifactA, artifactB, python } = fixture;
  const serverA = join(artifactA, "server"), serverB = join(artifactB, "server");
  const load = (server, path) => import(pathToFileURL(join(server, path)).href);
  const { initialize, Storage } = await load(serverA, "dist/storage.js");
  const managerModule = join(serverA, "dist/shared-managed-server.js");
  const managerCodeSha256 = digest(await readFile(managerModule));
  const { startSharedManagedServer } = await load(serverA, "dist/shared-managed-server.js");
  const { sharedManagedRequest } = await load(serverA, "dist/shared-managed-client.js");
  const { stageIsolatedManagedGeneration, publishIsolatedManagedGeneration } = await load(serverA, "experimental/managed-migration.mjs");
  const { stageIsolatedManagedGeneration: stageB, verifyIsolatedManagedGeneration: verifyB } =
    await load(serverB, "experimental/managed-migration.mjs");
  const { knowledgeMutationScanRevision } = await load(serverB, "dist/knowledge-mutations.js");
  const { scanMarkdown } = await load(serverB, "dist/markdown.js");
  const require = createRequire(import.meta.url);
  const { verifyNextPayload } = require(join(serverA, "legacy/dist/runtime/next-payload-verifier.js"));
  const payloadA = verifyNextPayload(resolve(artifactA, "..")), payloadB = verifyNextPayload(resolve(artifactB, ".."));
  assert.notEqual(payloadA.buildId, payloadB.buildId);
  const coreHashA = digest(await readFile(join(serverA, "dist/core.js")));
  const coreHashB = digest(await readFile(join(serverB, "dist/core.js")));
  assert.notEqual(coreHashA, coreHashB, "Executable Core behavior differs, not only inventory or generation UUID.");
  const data = await initialize(join(root, "data"), { storageLayout: "separated" });
  const directory = join(data, "server-data/runtime-control/shared-manager"), managedRoot = join(root, "managed");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const endpoint = "https://fixture.invalid/v1", business = "business-".repeat(8), management = "management-".repeat(8);
  const coreHostProfile = {
    schema: "pkm.shared-core-host/v1",
    config: { schema: "pkm.native-host-config/v1", provider: "openai-compatible", endpoint,
      secretRef: "secret:fixture/core", model: "fixture-model", contextWindow: 16384, maxOutputTokens: 4096,
      outputTokenParameter: "max_tokens", includeUsage: false, tools: ["knowledge.document.get"] },
    policy: { allowedProviders: ["openai-compatible"], allowedEndpoints: [endpoint], allowedModels: ["fixture-model"],
      allowedTools: ["knowledge.document.get"] },
    secretEnvironment: { "secret:fixture/core": secretName }, humanReview: "browser",
  };
  const first = await stageIsolatedManagedGeneration({ managedRoot, data, allowWrites: true, coreHostProfile,
    repositoryRoot: serverA, python });
  await publishIsolatedManagedGeneration(managedRoot, first.generation);
  const service = await startSharedManagedServer({ directory, managedRoot, token: business,
    managementToken: management, backendKind: "standalone-core" });
  closes.push(() => service.close());
  const client = new Client({ name: "distinct-code-existing-mcp", version: "1" });
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [join(serverA, "dist/shared-managed-relay.js")], stderr: "pipe",
    env: { PKM_SHARED_ORIGIN: service.url, PKM_SHARED_SERVICE_ID: service.serviceId, PKM_SHARED_TOKEN: business } });
  const agent = new Agent({ keepAlive: true, maxSockets: 1 }), sockets = [];
  closes.push(async () => { try { await client.close(); } finally { agent.destroy(); } });
  await client.connect(transport);
  const origin = service.url, serviceId = service.serviceId, relayPid = transport.pid, managerPid = process.pid;
  const admin = { origin, serviceId, token: management };
  const http = (method, body = {}) => new Promise((ready, reject) => {
    const request = httpRequest(`${origin}/v1/${method}`, { agent, method: "POST",
      headers: { authorization: `Bearer ${business}`, "content-type": "application/json" } }, response => {
      let text = ""; response.setEncoding("utf8"); response.on("data", bytes => { text += bytes; });
      response.on("end", () => {
        try { assert.equal(response.statusCode, 200); ready(JSON.parse(text)); } catch (error) { reject(error); }
      });
    });
    request.on("socket", socket => sockets.push(socket)); request.on("error", reject);
    request.end(JSON.stringify(body));
  });
  const phases = [];
  const observe = async (label, expectedMarker, manifest) => {
    const overMcp = unwrap(await client.callTool({ name: "server_info", arguments: {} }));
    const overHttp = await http("server_info");
    const marker = value => value.result.features.filter(item => item.startsWith("runtime-code-upgrade-proof:"));
    assert.deepEqual(marker(overMcp), [expectedMarker]); assert.deepEqual(marker(overHttp), [expectedMarker]);
    assert.equal(service.url, origin); assert.equal(service.serviceId, serviceId);
    assert.equal(process.pid, managerPid); assert.equal(transport.pid, relayPid);
    assert.equal(service.status().generation, manifest.generation); assert.equal(service.status().runtimeBuild, manifest.runtimeBuild);
    assert.equal(service.status().clients, 1); assert.equal(service.status().automaticReplay, false);
    assert.equal(service.status().uncertain.length, 0);
    await assert.rejects(Storage.open(data), /BUSY|writer|lease|owned|fence/i,
      "A second real Storage writer cannot open the running Core workspace.");
    phases.push({ label, marker: marker(overMcp)[0], generation: manifest.generation, runtimeBuild: manifest.runtimeBuild,
      backendPid: service.status().backendPid, clients: service.status().clients, inFlight: service.status().inFlight });
  };
  await observe("A-before", "runtime-code-upgrade-proof:A", first);
  const second = await stageB({ managedRoot, data, allowWrites: true, coreHostProfile, repositoryRoot: serverB, python });
  assert.equal((await verifyB(managedRoot, second.generation)).runtimeBuild, second.runtimeBuild);
  assert.notEqual(first.runtimeBuild, second.runtimeBuild);
  const manage = async (action, fields = {}) => {
    const approval = await sharedManagedRequest(admin, "/manage/approve", { action, ...fields });
    return sharedManagedRequest(admin, `/manage/${action}`, { approvalId: approval.approvalId, ...fields });
  };
  const change = async manifest => {
    const oldPid = service.status().backendPid;
    await manage("switch", { generation: manifest.generation });
    assert.throws(() => process.kill(oldPid, 0), { code: "ESRCH" });
    assert.notEqual(service.status().backendPid, oldPid);
  };
  const cleanup = async manifest => {
    const oldPid = service.status().backendPid;
    await manage("cleanup-runtime");
    assert.throws(() => process.kill(oldPid, 0), { code: "ESRCH" });
    assert.deepEqual(await readdir(join(managedRoot, "generations")), [manifest.generation]);
  };
  await change(second);
  await observe("B", "runtime-code-upgrade-proof:B", second);
  const sessionId = randomUUID(), operationId = randomUUID();
  const created = unwrap(await client.callTool({ name: "capability_call", arguments: {
    operation: "chat.session.create", version: 1, arguments: {
      id: sessionId, operationId, expectedRevision: 0, title: "Written by genuinely different B code",
    },
  } }));
  assert(!created.error, JSON.stringify(created)); assert.equal(created.result.revision, 1);
  const readArgs = { operation: "chat.session.get", version: 1, arguments: { id: sessionId } };
  assert.deepEqual((await http("capability_read", readArgs)).result, created.result);
  const noteOperationId = randomUUID();
  const note = unwrap(await client.callTool({ name: "capability_call", arguments: {
    operation: "knowledge.note.create", version: 1, arguments: {
      operationId: noteOperationId, expectedScanRevision: knowledgeMutationScanRevision(scanMarkdown(data)),
      title: "Knowledge written under genuinely different B", content: "B-written user Markdown must survive runtime deletion and downgrade.",
    },
  } }));
  assert(!note.error, JSON.stringify(note));
  const notePath = join(data, note.result.area, note.result.path), noteBytes = await readFile(notePath);
  await cleanup(second);
  await observe("B-after-A-retirement", "runtime-code-upgrade-proof:B", second);
  await assert.rejects(readFile(join(managedRoot, "generations", first.generation, "manifest.json")), { code: "ENOENT" });
  const restagedA = await stageB({ managedRoot, data, allowWrites: true, coreHostProfile, repositoryRoot: serverA, python });
  await verifyB(managedRoot, restagedA.generation);
  assert.notEqual(restagedA.generation, first.generation);
  assert.equal(restagedA.runtimeBuild, first.runtimeBuild, "Exact verified A bytes return with a new UUID.");
  await change(restagedA);
  await observe("A-restaged", "runtime-code-upgrade-proof:A", restagedA);
  await cleanup(restagedA);
  await observe("A-after-B-retirement", "runtime-code-upgrade-proof:A", restagedA);
  assert.deepEqual(unwrap(await client.callTool({ name: "capability_read", arguments: readArgs })).result, created.result);
  assert.deepEqual((await http("capability_read", readArgs)).result, created.result);
  assert.deepEqual(await readFile(notePath), noteBytes);
  const stoppedPid = service.status().backendPid, unknownSessionId = randomUUID(), unknownOperationId = randomUUID();
  process.kill(stoppedPid, "SIGSTOP");
  const unknown = client.callTool({ name: "capability_call", arguments: {
    operation: "chat.session.create", version: 1, arguments: {
      id: unknownSessionId, operationId: unknownOperationId, expectedRevision: 0, title: "Never replay an unknown call",
    },
  } });
  const rejected = assert.rejects(unknown, /unknown|reconcile|receipt/i);
  try { await until(() => service.status().inFlight === 1); process.kill(stoppedPid, "SIGKILL"); }
  finally { try { process.kill(stoppedPid, "SIGCONT"); } catch (error) { if (error.code !== "ESRCH") throw error; } }
  await rejected;
  await until(() => service.status().phase === "action-required");
  assert.equal(service.status().uncertain.length, 1);
  await assert.rejects(manage("cleanup-runtime"), /reconciliation|uncertain/i);
  assert.deepEqual(await readdir(join(managedRoot, "generations")), [restagedA.generation]);
  await manage("reconcile", { receiptId: service.status().uncertain[0].id, acknowledge: "reviewed-outcome-no-replay" });
  await manage("recover");
  await observe("A-after-reviewed-unknown-recovery", "runtime-code-upgrade-proof:A", restagedA);
  assert.deepEqual(unwrap(await client.callTool({ name: "capability_read", arguments: readArgs })).result, created.result);
  assert.deepEqual(await readFile(notePath), noteBytes);
  assert.deepEqual(await readdir(join(managedRoot, "generations")), [restagedA.generation]);
  const absent = unwrap(await client.callTool({ name: "capability_read", arguments: {
    operation: "chat.session.get", version: 1, arguments: { id: unknownSessionId },
  } }));
  assert.equal(absent.error.code, "NOT_FOUND");
  const db = new DatabaseSync(join(data, "server-data/core.sqlite"), { readOnly: true });
  let receipts;
  try {
    receipts = db.prepare("SELECT COUNT(*) AS count FROM receipts WHERE operation_id=? AND operation=?")
      .get(operationId, "chat.session.create").count;
    assert.equal(receipts, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM receipts WHERE operation_id=?").get(unknownOperationId).count, 0);
  } finally { db.close(); }
  assert.equal(digest(await readFile(managerModule)), managerCodeSha256);
  console.log("DISTINCT_CODE_UPGRADE_PROOF", JSON.stringify({
    schema: "pkm.distinct-code-upgrade-proof/v1", payloadA: payloadA.buildId, payloadB: payloadB.buildId, coreHashA, coreHashB,
    managerModule, managerCodeSha256, managerPayloadBuildId: payloadA.buildId,
    candidatePublisher: join(serverB, "experimental/managed-migration.mjs"), managerPid, relayPid, origin, serviceId,
    sameHttpOrigin: true, sameMcpTransport: true, httpSocketCount: new Set(sockets).size, schemaCompatible: true,
    automaticReplay: false, durableMutationReceipts: receipts, unknownCleanupRefused: true, unknownMutationReplayed: false,
    activeGenerationOnly: restagedA.generation, deletedGenerations: [first.generation, second.generation], restagedA: restagedA.generation,
    userNote: { operationId: noteOperationId, path: note.result.path, sha256: digest(noteBytes), bytes: noteBytes.length },
    sessionId, operationId, durableResult: created.result, phases, artifactProfiles: fixture.artifactProfiles,
    buildTimings: fixture.buildTimings, productionCoreSha256: fixture.sourceCoreSha256, wholeCaseDurationMs: Date.now() - started,
  }));
});
