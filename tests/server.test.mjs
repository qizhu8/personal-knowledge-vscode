import { test } from "node:test";
import assert from "node:assert/strict";
import { rm, readFile, readdir, mkdir, writeFile, symlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { createInterface } from "node:readline";
import { once } from "node:events";
import { request } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { initialize, Storage } from "../dist/storage.js";
import { Core } from "../dist/core.js";
import { resultEnvelope } from "../dist/contracts.js";
import { scanMarkdown } from "../dist/markdown.js";
import { planResourceLifecycle, serializeResourceLifecyclePlan } from "../dist/resource-lifecycle.js";
import { workflowCompilerTransportFixtures } from "./workflow-compiler-fixtures.mjs";
import { planDocumentLifecycle, serializeDocumentLifecyclePlan } from "../dist/document-lifecycle.js";
import { installSubscriptionReadTransportFixtures, subscriptionReadTransportFixtures } from "./subscription-reads-fixtures.mjs";
import { installAgentSnapshotReadTransportFixtures, fixtureRequests, fixtureResults } from "./agent-snapshot-reads-fixtures.mjs";
import { installProjectMutationTransportFixture, projectMutationFixtureRequests } from "./project-mutations-fixtures.mjs";
import { planProjectMutation, serializeProjectMutationPlan } from "../dist/project-mutations.js";
import { syncApplyFixtureBytes, syncApplyFixtureInput } from "./sync-apply-fixture.mjs";
import { syncPlanHash } from "../dist/sync-plan.js";

const cli = resolve("dist/cli.js");
const executeFile = promisify(execFile);
const token = randomUUID() + randomUUID();
const owner = { id: "local:owner", canWrite: true };
const reader = { id: "local:reader", canWrite: false };
const invoke = (operation, args) => ({ operation, version: 1, arguments: args });
const cleanups = new WeakMap();
async function fixture(t) {
  const parent = resolve("tests", `.server-${randomUUID()}`);
  await mkdir(parent, { recursive: true });
  const actions = [];
  cleanups.set(t, actions);
  t.after(async () => {
    try { for (const action of actions.reverse()) await action(); }
    finally { await rm(parent, { recursive: true, force: true }); }
  });
  const directory = join(parent, "workspace");
  await initialize(directory);
  return { parent, directory };
}
async function httpProcess(t, directory, extra = []) {
  const child = spawn(process.execPath, [cli, "http", "--data", directory, ...extra], {
    env: { ...process.env, PKM_NEXT_TOKEN: token }, stdio: ["ignore", "pipe", "pipe"],
  });
  let diagnostics = "";
  child.stderr.on("data", data => { diagnostics += data; });
  let stopping;
  const close = () => {
    if (stopping) return stopping;
    stopping = (async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await once(child, "exit");
    }
    })();
    return stopping;
  };
  cleanups.get(t).push(close);
  const url = await new Promise((resolve, reject) => {
    const lines = createInterface({ input: child.stdout });
    const timeout = setTimeout(() => { child.kill("SIGTERM"); reject(new Error(`Server readiness timeout: ${diagnostics}`)); }, 10000);
    lines.on("line", line => {
      try {
        const message = JSON.parse(line);
        if (message.ready) { clearTimeout(timeout); resolve(message.url); }
      } catch (error) { clearTimeout(timeout); reject(error); }
    });
    child.once("exit", code => { clearTimeout(timeout); reject(new Error(`Server exited ${code}: ${diagnostics}`)); });
  });
  const call = async (method, input, headers = {}) => {
    const response = await fetch(`${url}/v1/${method}`, {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...headers },
      body: JSON.stringify(input),
    });
    return { status: response.status, body: await response.json() };
  };
  return { child, url, call, close };
}

test("workspace initialization refuses existing/legacy directories and never imports old data", async t => {
  const { parent, directory } = await fixture(t);
  await assert.rejects(initialize(directory), /EEXIST/);
  const legacy = join(parent, "legacy");
  await mkdir(legacy); await writeFile(join(legacy, "note.md"), "untouched");
  await assert.rejects(Storage.open(legacy), /isolated/);
  assert.equal(await readFile(join(legacy, "note.md"), "utf8"), "untouched");
  assert.deepEqual(await readdir(legacy), ["note.md"]);
  const linked = join(parent, "linked");
  await symlink(directory, linked, "dir");
  await assert.rejects(Storage.open(linked), /symlinks/);
});

test("Core applies strict schemas, actor authority, CAS, receipt identity, trash and revision-pinned pages", async t => {
  const { directory } = await fixture(t);
  const storage = await Storage.open(directory); cleanups.get(t).push(() => storage.close());
  const core = new Core(storage);
  const execute = (method, args, actor = owner) => core.dispatch(method, args, actor);
  const create = invoke("knowledge.document.create", { id: "a", operationId: randomUUID(), title: "First", content: "body" });
  assert.equal((await execute("capability_call", create, reader)).error.code, "ACCESS_DENIED");
  assert.equal((await execute("capability_read", create)).error.code, "ACCESS_DENIED");
  assert.equal((await execute("capability_call", { ...create, arguments: { ...create.arguments, ownerId: "fake" } })).error.code, "INVALID_ARGUMENT");
  const created = (await execute("capability_call", create)).result;
  assert.equal(created.revision, 1);
  assert.equal((await execute("capability_call", create)).result.revision, 1);
  assert.equal((await execute("capability_call", { ...create, arguments: { ...create.arguments, content: "different" } })).error.code, "CONFLICT");
  const listing = await execute("capability_read", invoke("knowledge.document.list", { limit: 1 }));
  const updates = await Promise.all(["one", "two"].map(content => execute("capability_call",
    invoke("knowledge.document.update", { id: "a", operationId: randomUUID(), expectedRevision: 1, expectedSha256: created.sha256, title: "First", content }))));
  assert.equal(updates.filter(result => result.result).length, 1);
  assert.equal(updates.filter(result => result.error?.code === "CONFLICT").length, 1);
  assert.equal((await execute("capability_read", invoke("knowledge.document.list", { workspaceRevision: listing.result.workspaceRevision }))).error.code, "CONFLICT");
  const updated = updates.find(result => result.result).result;
  const trash = await execute("capability_call", invoke("knowledge.document.trash", { id: "a", operationId: randomUUID(), expectedRevision: 2, expectedSha256: updated.sha256 }));
  assert.equal(trash.result.deleted, true);
  assert.equal((await execute("capability_read", invoke("knowledge.document.list", {}))).result.total, 0);
  const restored = await execute("capability_call", invoke("knowledge.document.restore", { id: "a", operationId: randomUUID(), expectedRevision: 3, expectedSha256: trash.result.sha256 }));
  assert.equal(restored.result.revision, 4);
  assert.equal(restored.result.deleted, false);
  const available = await execute("capabilities_search", { query: "knowledge.document" }, reader);
  assert.equal(available.result.items.length, 3);
  assert(available.result.items.every(item => item.readOnly));
  assert.equal((await execute("capabilities_search", { revision: "0".repeat(64) })).error.code, "CONFLICT");
  assert.equal((await execute("capabilities_describe", { operation: create.operation }, reader)).error.code, "NOT_FOUND");
});

test("HTTP and sequential MCP share contracts and persisted state across restart", { timeout: 30000 }, async t => {
  const { directory } = await fixture(t);
  const http = await httpProcess(t, directory);
  const serverInfo = await http.call("server_info", {});
  assert.equal(serverInfo.status, 200);
  assert.deepEqual(serverInfo.body.result.limits, { storageQueue: 32 });
  assert.equal((await http.call("server_info", {}, { authorization: "Bearer wrong" })).status, 401);
  assert.equal((await http.call("server_info", {}, { origin: "https://untrusted.example" })).status, 403);
  const invalidHost = await new Promise((resolve, reject) => {
    const req = request(`${http.url}/v1/server_info`, { method: "POST", headers: {
      host: "other.example", authorization: `Bearer ${token}`, "content-type": "application/json",
    } }, res => { res.resume(); res.on("end", () => resolve(res.statusCode)); });
    req.on("error", reject); req.end("{}");
  });

  assert.equal(invalidHost, 403);
  const create = invoke("knowledge.document.create", { id: "shared", operationId: randomUUID(), title: "Shared", content: "Persisted" });
  const created = await http.call("capability_call", create);
  assert.equal(created.status, 200);
  assert(resultEnvelope.safeParse(created.body).success);
  assert(resultEnvelope.safeParse((await http.call("server_info", {}, { authorization: "Bearer wrong" })).body).success);
  const sameOwnerHttpCall = async (name, args) => {
    const envelope = (await http.call(name, args)).body;
    assert(resultEnvelope.safeParse(envelope).success);
    return envelope;
  };
  const read = invoke("knowledge.document.get", { id: "shared" });
  assert.deepEqual((await sameOwnerHttpCall("capability_read", read)).result, created.body.result);
  const contract = { operation: "knowledge.document.update" };
  assert.deepEqual((await sameOwnerHttpCall("capabilities_describe", contract)).result, (await http.call("capabilities_describe", contract)).body.result);
  const metadataContract = { operation: "knowledge.metadata.update" };
  assert.deepEqual((await sameOwnerHttpCall("capabilities_describe", metadataContract)).result, (await http.call("capabilities_describe", metadataContract)).body.result);
  const skill = (await http.call("capability_call", invoke("knowledge.document.create", {
    operationId: randomUUID(), id: "shared-skill", area: "skills", path: "Team/Shared.md", title: "Shared Skill", content: "Authoritative skill",
  }))).body.result;
  assert.equal(skill.area, "skills");
  const metadataWrites = ["HTTP", "MCP"].map(source => invoke("knowledge.metadata.update", {
    operationId: randomUUID(), id: skill.id, expectedRevision: skill.revision, expectedSha256: skill.sha256,
    set: { tags: [source] },
  }));
  const metadataResults = await Promise.all([
    http.call("capability_call", metadataWrites[0]).then(response => response.body),
    sameOwnerHttpCall("capability_call", metadataWrites[1]),
  ]);
  assert.equal(metadataResults.filter(result => result.result).length, 1);
  assert.equal(metadataResults.find(result => result.error).error.code, "CONFLICT");
  const winner = metadataResults.findIndex(result => result.result);
  const replay = winner === 0 ? await sameOwnerHttpCall("capability_call", metadataWrites[winner])
    : (await http.call("capability_call", metadataWrites[winner])).body;
  assert.deepEqual(replay.result, metadataResults[winner].result);
  const metadataRead = invoke("knowledge.metadata.get", { id: skill.id });
  assert.deepEqual((await sameOwnerHttpCall("capability_read", metadataRead)).result, (await http.call("capability_read", metadataRead)).body.result);
  const skillList = (await http.call("capability_read", invoke("knowledge.skill.list", { category: "Team" }))).body;
  assert.equal(skillList.result.items[0].documentId, skill.id);
  assert.equal(skillList.result.items[0].name, "Shared", "Skill names come from name/filename, not document title.");
  for (const [operation, args] of [
    ["knowledge.skill.list", { tag: metadataWrites[winner].arguments.set.tags[0], snapshotRevision: skillList.result.snapshotRevision }],
    ["knowledge.skill.get", { name: "Shared", snapshotRevision: skillList.result.snapshotRevision }],
    ["knowledge.skill.get", { id: skill.id, snapshotRevision: skillList.result.snapshotRevision }],
  ]) {
    const httpResult = (await http.call("capability_read", invoke(operation, args))).body;
    assert(!httpResult.error, JSON.stringify(httpResult.error));
    assert.deepEqual(httpResult.result, (await sameOwnerHttpCall("capability_read", invoke(operation, args))).result);
  }
  assert.equal((await sameOwnerHttpCall("capability_read", invoke("knowledge.document.get", { id: skill.id }))).result.content, "Authoritative skill");
  for (const [suffix, args] of [
    ["sources", {}],
    ["context", { task: "Authoritative skill" }],
    ["select", { query: "Authoritative skill", limit: 1 }],
    ["project", { selected: [{ id: skill.id }] }],
    ["prompt", { query: "Authoritative skill", selected: [{ id: skill.id }] }],
  ]) {
    const operation = `knowledge.skill.routing.${suffix}`;
    const projected = (await http.call("capability_read", invoke(operation, args))).body;
    assert(!projected.error, JSON.stringify(projected.error));
    assert.match(projected.result.snapshotRevision, /^[a-f0-9]{64}$/);
    assert.deepEqual((await sameOwnerHttpCall("capability_read", invoke(operation, {
      ...args, snapshotRevision: projected.result.snapshotRevision,
    }))).result, projected.result);
    const stale = (await http.call("capability_read", invoke(operation, {
      ...args, snapshotRevision: "0".repeat(64),
    }))).body;
    assert.equal(stale.error.code, "CONFLICT");
  }
  const notes = (await http.call("capability_read", invoke("knowledge.note.list", {}))).body;
  assert.equal(notes.result.items[0].documentId, "shared");
  for (const [operation, args] of [
    ["knowledge.note.list", { type: "general", snapshotRevision: notes.result.snapshotRevision }],
    ["knowledge.note.get", { id: "shared", snapshotRevision: notes.result.snapshotRevision }],
    ["knowledge.note.get", { path: "shared.md", snapshotRevision: notes.result.snapshotRevision }],
  ]) {
    const httpResult = (await http.call("capability_read", invoke(operation, args))).body;
    assert(!httpResult.error, JSON.stringify(httpResult.error));
    assert.deepEqual(httpResult.result, (await sameOwnerHttpCall("capability_read", invoke(operation, args))).result);
  }
  await mkdir(join(directory, "skills/Team/Shared.assets"));
  const image = Buffer.alloc(70_000, 137);
  await writeFile(join(directory, "skills/Team/Shared.assets/image.bin"), image);
  const assets = (await http.call("capability_read", invoke("knowledge.asset.list", { id: skill.id }))).body.result;
  assert.equal(assets.total, 1);
  assert.deepEqual((await sameOwnerHttpCall("capability_read", invoke("knowledge.asset.list", { id: skill.id }))).result, assets);
  const chunkArgs = {
    id: skill.id, path: assets.items[0].path, expectedDocumentSha256: assets.documentSha256, expectedDigest: assets.items[0].digest,
  };
  const firstChunk = await http.call("capability_read", invoke("knowledge.asset.get", chunkArgs));
  assert.equal(firstChunk.status, 200);
  assert.equal(firstChunk.body.result.nextOffset, 65_536);
  const lastChunk = await sameOwnerHttpCall("capability_read", invoke("knowledge.asset.get", { ...chunkArgs, offset: firstChunk.body.result.nextOffset }));
  assert.equal(lastChunk.result.nextOffset, null);
  assert.deepEqual(Buffer.concat([Buffer.from(firstChunk.body.result.data, "base64"), Buffer.from(lastChunk.result.data, "base64")]), image);
  const uploadedBytes = Buffer.alloc(70_000, 61);
  const beginUpload = await http.call("capability_call", invoke("knowledge.upload.begin", {
    operationId: randomUUID(), id: skill.id, expectedRevision: metadataResults[winner].result.revision,
    expectedSha256: assets.documentSha256, name: "uploaded.bin", size: uploadedBytes.length,
    digest: `sha256:${createHash("sha256").update(uploadedBytes).digest("hex")}`,
  }));
  assert.equal(beginUpload.status, 200);
  const uploadId = beginUpload.body.result.uploadId;
  assert.equal((await sameOwnerHttpCall("capability_call", invoke("knowledge.upload.append", {
    operationId: randomUUID(), uploadId, offset: 0, data: uploadedBytes.subarray(0, 65_536).toString("base64"),
  }))).result.receivedBytes, 65_536);
  assert.equal((await http.call("capability_call", invoke("knowledge.upload.append", {
    operationId: randomUUID(), uploadId, offset: 65_536, data: uploadedBytes.subarray(65_536).toString("base64"),
  }))).body.result.receivedBytes, uploadedBytes.length);
  const commitUpload = invoke("knowledge.upload.commit", { operationId: randomUUID(), uploadId });
  const committedUpload = await sameOwnerHttpCall("capability_call", commitUpload);
  assert.equal(committedUpload.result.status, "committed");
  assert.deepEqual((await http.call("capability_call", commitUpload)).body.result, committedUpload.result);
  assert.deepEqual(await readFile(join(directory, "skills/Team/Shared.assets/uploaded.bin")), uploadedBytes);
  const memoryProposal = invoke("memory.record.propose", {
    operation_id: randomUUID(), content: "Use PKM Todo Boards.",
    sources: [{ id: "input-1", chat: "fixture-chat", revision: "turn-1", locator: "message/input-1" }],
  });
  const memory = (await http.call("capability_call", memoryProposal)).body;
  assert.equal(memory.result.status, "pending");
  assert.deepEqual((await sameOwnerHttpCall("capability_call", memoryProposal)).result, memory.result);
  assert.deepEqual((await sameOwnerHttpCall("capability_read", invoke("memory.record.get", { id: memory.result.id }))).result, memory.result);
  assert.deepEqual((await sameOwnerHttpCall("capability_read", invoke("memory.record.search", { query: "Todo" }))).result.records, []);
  assert.equal((await sameOwnerHttpCall("capability_read", invoke("memory.record.audit", { id: memory.result.id }))).result.events[0].action, "proposed");
  assert.equal((await http.call("capability_call", invoke("memory.record.confirm", {
    id: memory.result.id, expected_revision: 1, operation_id: randomUUID(),
  }))).body.error.code, "NOT_AVAILABLE");
  assert.equal((await sameOwnerHttpCall("capabilities_search", { query: "memory.record" })).result.total, 4);
  for (const [id, title, fields] of [
    ["research-base", "Research Base", { topic: "Retrieval", tags: ["embedding"], year: 2020 }],
    ["research-child", "Research Child", { cites: [{ paper: "research-base", note: "Extends" }], year: 2025, group: "Roadmap" }],
  ]) {
    const paper = (await http.call("capability_call", invoke("knowledge.document.create", {
      operationId: randomUUID(), id, area: "papers", title, content: "Research body",
    }))).body;
    assert(!paper.error, JSON.stringify(paper.error));
    const metadata = await sameOwnerHttpCall("capability_call", invoke("knowledge.metadata.update", {
      operationId: randomUUID(), id, expectedRevision: paper.result.revision, expectedSha256: paper.result.sha256, set: fields,
    }));
    assert(!metadata.error, JSON.stringify(metadata.error));
  }
  const research = (await http.call("capability_read", invoke("knowledge.research.list", { limit: 1 }))).body;
  for (const [operation, query, total] of [
    ["knowledge.note.search", "Persisted", 1],
    ["knowledge.skill.search", "Authoritative skill", 1],
    ["knowledge.research.search", "Research body", 2],
  ]) {
    const input = invoke(operation, { query, limit: 1 });
    const searched = (await http.call("capability_read", input)).body;
    assert(!searched.error, JSON.stringify(searched.error));
    assert.equal(searched.result.total, total);
    assert.equal(searched.result.items.length, 1);
    assert(!Object.hasOwn(searched.result.items[0], "content"));
    assert.deepEqual((await sameOwnerHttpCall("capability_read", input)).result, searched.result);
    const pin = operation === "knowledge.research.search" ? { revision: searched.result.revision }
      : { snapshotRevision: searched.result.snapshotRevision };
    assert.deepEqual((await http.call("capability_read", invoke(operation, { query, ...pin }))).body.result,
      (await sameOwnerHttpCall("capability_read", invoke(operation, { query, ...pin }))).result);
    const regex = (await http.call("capability_read", invoke(operation, { query: ".*", regex: true }))).body;
    assert.equal(regex.error.code, "INVALID_ARGUMENT");
  }
  assert.equal(research.result.total, 2);
  assert.equal(research.result.items[0].slug, "research-base");
  const researchGraph = await sameOwnerHttpCall("capability_read", invoke("knowledge.research.graph", { revision: research.result.revision }));
  assert.deepEqual(researchGraph.result.edges, [{ from: "research-base", to: "research-child", note: "Extends" }]);
  for (const operation of ["knowledge.research.list", "knowledge.research.facets", "knowledge.research.groups", "knowledge.research.graph"]) {
    const args = { revision: research.result.revision };
    assert.deepEqual((await http.call("capability_read", invoke(operation, args))).body.result,
      (await sameOwnerHttpCall("capability_read", invoke(operation, args))).result);
  }
  const board = await http.call("capability_call", invoke("todo.board.create", { board_slug: "Team/Board", operationId: randomUUID() }));
  assert.equal(board.status, 200);
  assert.deepEqual((await sameOwnerHttpCall("capability_read", invoke("todo.board.get", { board_slug: "Team/Board" }))).result, board.body.result);
  const todoWrites = await Promise.all([
    http.call("capability_call", invoke("todo.workitem.create", {
      board_slug: "Team/Board", expected_digest: board.body.result.digest, operationId: randomUUID(),
      item: { id: "http-task", title: "HTTP", goal: "Concurrency", scope: "Board", acceptance: ["Exactly one writer"] },
    })).then(response => response.body),
    sameOwnerHttpCall("capability_call", invoke("todo.workitem.create", {
      board_slug: "Team/Board", expected_digest: board.body.result.digest, operationId: randomUUID(),
      item: { id: "mcp-task", title: "MCP", goal: "Concurrency", scope: "Board", acceptance: ["Exactly one writer"] },
    })),
  ]);
  assert.equal(todoWrites.filter(result => result.result).length, 1);
  assert.equal(todoWrites.find(result => result.error).error.code, "CONFLICT");
  assert.equal((await sameOwnerHttpCall("capability_read", invoke("todo.workitem.list", { board_slug: "Team/Board" }))).result.total, 1);
  const competing = await Promise.all([
    http.call("capability_call", invoke("knowledge.document.update", { id: "shared", operationId: randomUUID(), expectedRevision: 1, expectedSha256: created.body.result.sha256, title: "HTTP", content: "HTTP update" })).then(result => result.body),
    sameOwnerHttpCall("capability_call", invoke("knowledge.document.update", { id: "shared", operationId: randomUUID(), expectedRevision: 1, expectedSha256: created.body.result.sha256, title: "MCP", content: "MCP update" })),
  ]);
  assert.equal(competing.filter(result => result.result).length, 1);
  assert.equal(competing.filter(result => result.error?.code === "CONFLICT").length, 1);
  assert.deepEqual((await sameOwnerHttpCall("capability_call", create)).result, created.body.result, "same-transport retry returns the original receipt");
  const final = (await sameOwnerHttpCall("capability_read", read)).result;
  await http.close();
  const transport = new StdioClientTransport({ command: process.execPath, args: [cli, "mcp", "--data", directory], stderr: "pipe" });
  const client = new Client({ name: "next-server-sequential-mcp-test", version: "1.0.0" });
  cleanups.get(t).push(() => client.close());
  await client.connect(transport);
  assert.deepEqual((await client.listTools()).tools.map(tool => tool.name).sort(), [
    "api_chat_capabilities", "api_chat_get", "api_chat_list", "api_chat_models", "api_chat_request_get",
    "capabilities_describe", "capabilities_search", "capability_call", "capability_read", "recipe_capabilities",
    "server_info",
  ]);
  const mcpReplay = await client.callTool({ name: "capability_call", arguments: create });
  assert.deepEqual((mcpReplay.structuredContent ?? JSON.parse(mcpReplay.content[0].text)).result, created.body.result);
  const mcpRead = await client.callTool({ name: "capability_read", arguments: read });
  assert.deepEqual((mcpRead.structuredContent ?? JSON.parse(mcpRead.content[0].text)).result, final);
  await client.close();
  const restarted = await httpProcess(t, directory);
  assert.deepEqual((await restarted.call("capability_read", read)).body.result, final);
  assert.deepEqual((await restarted.call("capability_call", create)).body.result, created.body.result);
  await restarted.close();
  const readOnly = await httpProcess(t, directory, ["--read-only"]);
  assert.equal((await readOnly.call("capability_call", create)).status, 403);
  assert.equal((await readOnly.call("capabilities_search", { query: "knowledge.document" })).body.result.total, 3);
  assert.equal((await readOnly.call("capabilities_search", { query: "knowledge.metadata" })).body.result.total, 1);
  assert.equal((await readOnly.call("capabilities_search", { query: "knowledge.asset" })).body.result.total, 3);
  assert.equal((await readOnly.call("capabilities_search", { query: "knowledge.upload" })).body.result.total, 2);
  assert.equal((await readOnly.call("capabilities_search", { query: "knowledge.research" })).body.result.total, 5);
  assert.equal((await readOnly.call("capability_read", invoke("knowledge.research.graph", {}))).body.result.shown, 2);
  assert.equal((await readOnly.call("capabilities_search", { query: "memory.record" })).body.result.total, 3);
  assert.equal((await readOnly.call("capabilities_search", { query: "knowledge.skill" })).body.result.total, 8);
  assert.equal((await readOnly.call("capabilities_search", { query: "knowledge.note" })).body.result.total, 3);
  assert.equal((await readOnly.call("capability_call", commitUpload)).status, 403);
  await readOnly.close();
});

test("Project Recipe mutations expose usable public pins and durable HTTP receipts", async t => {
  const { directory } = await fixture(t);
  await installProjectMutationTransportFixture(directory);
  const http = await httpProcess(t, directory);
  const read = async (operation, args) => {
    const response = (await http.call("capability_read", invoke(operation, args))).body;
    assert(!response.error, `${operation}: ${JSON.stringify(response.error)}`);
    return response.result;
  };
  const mutate = async request => {
    const input = invoke(request.operation, request.args);
    const response = (await http.call("capability_call", input)).body;
    assert(!response.error, `${request.operation}: ${JSON.stringify(response.error)}`);
    const replay = await http.call("capability_call", input);
    assert.deepEqual(replay.body.result, response.result);
    return response.result;
  };
  const initial = await read("project.list", {});
  const { createProject } = projectMutationFixtureRequests(initial.snapshotRevision);
  const created = await mutate(createProject);
  const projectId = created.item.projectId;
  assert(projectId);
  const projectPin = await read("project.mutation.pin", { entityKind: "project", id: projectId });
  assert.match(projectPin.sha256, /^[a-f0-9]{64}$/);
  const { updateProject } = projectMutationFixtureRequests(projectPin.snapshotRevision, projectPin);
  const updated = await mutate(updateProject);
  assert.equal(updated.item.version, created.item.version + 1);
  const freshProjectPin = await read("project.mutation.pin", { entityKind: "project", id: projectId });
  const { createRecipe } = projectMutationFixtureRequests(freshProjectPin.snapshotRevision, freshProjectPin);
  const recipe = await mutate(createRecipe);
  const recipePin = await read("project.mutation.pin", { entityKind: "recipe", id: recipe.item.recipeId });
  const { updateRecipe } = projectMutationFixtureRequests(recipePin.snapshotRevision, undefined, recipePin);
  const recipeUpdated = await mutate(updateRecipe);
  assert.equal(recipeUpdated.item.revision, recipe.item.revision + 1);
  const archivePin = await read("project.mutation.pin", { entityKind: "project", id: projectId });
  const archived = await mutate({ operation: "project.archive", args: {
    operationId: randomUUID(), projectId, expectedSnapshotRevision: archivePin.snapshotRevision,
    expectedVersion: archivePin.version, expectedSha256: archivePin.sha256, at: "2026-11-06T03:04:05.000Z",
  } });
  assert.equal(archived.item.archivedAt, "2026-11-06T03:04:05.000Z");
  assert.equal((await read("project.get", { id: projectId })).item.archivedAt, archived.item.archivedAt);
  await http.close();
  const restarted = await httpProcess(t, directory);
  assert.deepEqual((await restarted.call("capability_call", invoke(createProject.operation, createProject.args))).body.result, created);
  await restarted.close();
  const readOnly = await httpProcess(t, directory, ["--read-only"]);
  assert.equal((await readOnly.call("capability_call", invoke(createProject.operation, createProject.args))).status, 403);
  await readOnly.close();
});

test("committed Project journal recovers a missing multi-file creation before serving reads", async t => {
  const { directory } = await fixture(t);
  await installProjectMutationTransportFixture(directory);
  const store = await Storage.open(directory);
  const listing = await store.request({ operation: "project.list", args: {}, actorId: owner.id });
  const request = { ...projectMutationFixtureRequests(listing.snapshotRevision).createProject, actorId: owner.id };
  await store.close();
  const plan = planProjectMutation(directory, request, scanMarkdown(directory));
  const db = new DatabaseSync(join(directory, "core.sqlite"));
  try {
    db.prepare("INSERT INTO pending_project_mutation(singleton,operation_id,fingerprint,actor_id,operation,plan) VALUES(1,?,?,?,?,?)").run(
      request.args.operationId, createHash("sha256").update(JSON.stringify({ operation: request.operation, actorId: owner.id, args: request.args })).digest("hex"),
      owner.id, request.operation, serializeProjectMutationPlan(plan));
  } finally { db.close(); }
  const reopened = await Storage.open(directory);
  cleanups.get(t).push(() => reopened.close());
  assert.deepEqual(await reopened.request(request), plan.result);
  const project = await reopened.request({ operation: "project.get", args: { id: plan.result.entityId }, actorId: owner.id });
  assert.equal(project.item.projectId, plan.result.entityId);
  assert.equal(project.threads.length, 1);
});

test("subscription ACL and immutable snapshot reads use trusted actors through HTTP without writes", async t => {
  const { directory } = await fixture(t);
  await installSubscriptionReadTransportFixtures(directory);
  await installAgentSnapshotReadTransportFixtures(directory);
  const http = await httpProcess(t, directory, ["--read-only"]);
  const cases = [
    ...subscriptionReadTransportFixtures(owner.id),
    ...Object.entries(fixtureRequests).map(([key, request]) => ({ ...request, result: fixtureResults[key] })),
  ];
  for (const fixture of cases) {
    const input = invoke(fixture.operation, fixture.args);
    const response = (await http.call("capability_read", input)).body;
    assert(!response.error, `${fixture.operation}: ${JSON.stringify(response.error)}`);
    for (const [key, value] of Object.entries(fixture.result)) {
      if (key !== "revision" && key !== "snapshotRevision" && key !== "actorId") {
        assert.deepEqual(response.result[key], value, `${fixture.operation}.${key}`);
      }
    }
    const impersonation = (await http.call("capability_read", invoke(fixture.operation, { ...fixture.args, actorId: "other:user" }))).body;
    assert.equal(impersonation.error.code, "INVALID_ARGUMENT");
  }
  await http.close();
});

test("paired document moves retain identity, binary bytes and replay through HTTP and restart", async t => {
  const { directory } = await fixture(t);
  const http = await httpProcess(t, directory);
  const created = (await http.call("capability_call", invoke("knowledge.document.create", {
    operationId: randomUUID(), id: "moving", area: "notes", path: "Old/Doc.md", title: "Moving",
    content: "![image](Doc.assets/image.bin)",
  }))).body;
  assert(!created.error, JSON.stringify(created.error));
  await mkdir(join(directory, "notes", "Old", "Doc.assets"));
  const bytes = Buffer.from([0, 255, 17, 33]);
  await writeFile(join(directory, "notes", "Old", "Doc.assets", "image.bin"), bytes);
  const args = { id: "moving", area: "notes", path: "Old/Doc.md", destinationPath: "New/Deep/Renamed.md",
    expectedRevision: created.result.revision, expectedSha256: created.result.sha256 };
  const preview = (await http.call("capability_read", invoke("knowledge.document.lifecycle.preview", args))).body;
  assert(!preview.error, JSON.stringify(preview.error));
  assert.equal(preview.result.referenceRewriteRequired, true);
  assert.equal(preview.result.pairedAssets.files, 1);
  const request = invoke("knowledge.document.move", { ...args, operationId: randomUUID(),
    expectedScanRevision: preview.result.scanRevision, expectedPairedTreeDigest: preview.result.pairedAssets.digest,
    expectedDestinationSha256: null, expectedDestinationTreeDigest: null });
  const moved = (await http.call("capability_call", request)).body;
  assert(!moved.error, JSON.stringify(moved.error));
  assert.equal(moved.result.document.afterPath, "New/Deep/Renamed.md");
  assert.equal(moved.result.document.revision, created.result.revision);
  assert.deepEqual((await http.call("capability_call", request)).body.result, moved.result);
  const document = (await http.call("capability_read", invoke("knowledge.document.get", { id: "moving" }))).body.result;
  assert.equal(document.path, "New/Deep/Renamed.md");
  assert(document.content.includes("Renamed.assets/image.bin"));
  assert.deepEqual(await readFile(join(directory, "notes", "New", "Deep", "Renamed.assets", "image.bin")), bytes);
  await assert.rejects(readFile(join(directory, "notes", "Old", "Doc.md")), { code: "ENOENT" });
  await http.close();
  const restarted = await httpProcess(t, directory);
  assert.deepEqual((await restarted.call("capability_call", request)).body.result, moved.result);
  assert.deepEqual((await restarted.call("capability_read", invoke("knowledge.document.get", { id: "moving" }))).body.result, document);
  await restarted.close();
});

test("committed document move journal recovers before indexing and preserves the exact receipt", async t => {
  const { directory } = await fixture(t);
  const store = await Storage.open(directory);
  const request = { operation: "knowledge.document.create", actorId: owner.id, args: {
    operationId: randomUUID(), id: "moving", area: "notes", path: "Old/Doc.md", title: "Moving", content: "Plain body",
  } };
  const created = await new Core(store).dispatch("capability_call", invoke(request.operation, request.args), owner);
  assert(!created.error, JSON.stringify(created.error));
  const args = { id: "moving", area: "notes", path: "Old/Doc.md", destinationPath: "New/Doc.md",
    expectedRevision: created.result.revision, expectedSha256: created.result.sha256 };
  const preview = await store.request({ operation: "knowledge.document.lifecycle.preview", args, actorId: owner.id });
  await store.close();
  const move = { operation: "knowledge.document.move", actorId: owner.id, args: { ...args, operationId: randomUUID(),
    expectedScanRevision: preview.scanRevision, expectedPairedTreeDigest: preview.pairedAssets.digest,
    expectedDestinationSha256: null, expectedDestinationTreeDigest: null } };
  const plan = planDocumentLifecycle(directory, scanMarkdown(directory), move);
  const db = new DatabaseSync(join(directory, "core.sqlite"));
  try {
    db.prepare("INSERT INTO pending_document_lifecycle VALUES(1,?,?,?,?,?)").run(
      move.args.operationId, createHash("sha256").update(JSON.stringify({ operation: move.operation, actorId: move.actorId, args: move.args })).digest("hex"),
      owner.id, move.operation, serializeDocumentLifecyclePlan(plan));
  } finally { db.close(); }
  const reopened = await Storage.open(directory);
  cleanups.get(t).push(() => reopened.close());
  assert.deepEqual(await reopened.request(move), plan.result);
  assert.equal((await reopened.request({ operation: "knowledge.document.get", args: { id: "moving" }, actorId: owner.id })).path, "New/Doc.md");
  await assert.rejects(readFile(join(directory, "notes", "Old", "Doc.md")), { code: "ENOENT" });
});

test("workflow compile fixtures preserve exact valid plans and invalid diagnostics over HTTP", async t => {
  const { directory } = await fixture(t);
  const http = await httpProcess(t, directory, ["--read-only"]);
  for (const fixture of workflowCompilerTransportFixtures) {
    const input = invoke(fixture.operation, fixture.args);
    const response = (await http.call("capability_read", input)).body;
    assert(!response.error, JSON.stringify(response.error));
    assert.deepEqual(response.result, fixture.result);
  }
  const capabilities = (await http.call("capability_read", invoke("workflow.compiler.capabilities", {}))).body;
  assert(!capabilities.error, JSON.stringify(capabilities.error));
  const invalid = (await http.call("capability_read", invoke("workflow.definition.validate", { source: { kind: "inline", definition: null } }))).body;
  assert(!invalid.error, JSON.stringify(invalid.error));
  assert.equal(invalid.result.status, "invalid");
  assert(invalid.result.diagnostics.some(item => item.code === "E3003" && item.pointer === ""));
  await http.close();
});

test("Project Recipe transports preserve original schemas, content-bound bundles and pins", async t => {
  const { directory } = await fixture(t);
  await mkdir(join(directory, "project", "Alpha-Project.project_alpha"), { recursive: true });
  await mkdir(join(directory, "recipes", "Project", "Alpha Project", "Design"), { recursive: true });
  await mkdir(join(directory, "skills", "Coding"), { recursive: true });
  await mkdir(join(directory, "notes", "Projects"), { recursive: true });
  await writeFile(join(directory, "project", "Alpha-Project.project_alpha", "project.json"),
    JSON.stringify({ projectId: "project_alpha", name: "Alpha Project", version: 3, status: "active" }));
  const defaultPath = join(directory, "project", "Default-Project.project_22185ea2caa2c62b0f0b4ae12b26e579");
  await mkdir(join(defaultPath, "threads"), { recursive: true });
  await writeFile(join(defaultPath, "project.json"), JSON.stringify({
    projectId: "project_22185ea2caa2c62b0f0b4ae12b26e579", name: "Default Project", systemKind: "default-project", version: 1,
  }));
  await writeFile(join(defaultPath, "threads", "thread_36c07f23660167f2c5d0b5e31ab89d62.json"), JSON.stringify({
    threadId: "thread_36c07f23660167f2c5d0b5e31ab89d62", projectId: "project_22185ea2caa2c62b0f0b4ae12b26e579",
    name: "General", description: "", archived: false, systemKind: "general-thread", legacyAliases: [], version: 1,
  }));
  await writeFile(join(directory, "skills", "Coding", "Verify.md"), "---\nname: Verify\ndescription: \"\"\ntags: []\n---\nRun tests.");
  await writeFile(join(directory, "notes", "Projects", "Release.md"), "---\ntitle: Release\ntype: general\ntags: []\n---\nNo publishing.");
  const skillHash = createHash("sha256").update(JSON.stringify({
    category: "Coding", content: "Run tests.", description: "", name: "Verify", tags: [],
  })).digest("hex");
  const noteHash = createHash("sha256").update(JSON.stringify({
    category: "Projects", content: "No publishing.", tags: [], title: "Release", type: "general",
  })).digest("hex");
  const recipe = {
    schema: "pkm.knowledge/v1", knowledgeId: "knowledge_0f6619bc221d5d2f2b88e5f7", aliases: ["recipe:recipe_alpha"],
    recipeId: "recipe_alpha", scope: "global", category: "Project/Alpha Project/Design", name: "Verification Recipe",
    description: "Verification Recipe description",
    definition: { schema: "pkm.workflow.definition/v1", spec: {
      inputs: {}, nodes: [{ nodeId: "work", kind: "pkm.step.noop/v1", config: {}, dependsOn: [] }],
      outputs: {}, completion: { requiredNodes: ["work"] },
    } },
    nodeBindings: [{ nodeId: "work", bindings: [
      { bindingId: "verify-skill", kind: "skill", knowledgeId: "Coding/Verify", contentHash: skillHash, usage: "required" },
      { bindingId: "release-note", kind: "note", knowledgeId: "Projects/Release", contentHash: noteHash, usage: "reference" },
    ] }],
    executableDigest: "bcc56f88feeb5c65d92e7ee53925dcfa9cc27ba9f66120555309a039b1607f3d", revision: 1,
  };
  await writeFile(join(directory, "recipes", "Project", "Alpha Project", "Design", "Verification-Recipe.recipe_alpha.json"), JSON.stringify(recipe));
  const http = await httpProcess(t, directory);
  const results = {};
  for (const [operation, args] of [
    ["project.list", {}], ["project.get", { id: "project_alpha" }],
    ["project.recipe.list", { projectId: "project_alpha" }], ["project.recipe.get", { id: "recipe_alpha" }],
    ["project.recipe.bundle.get", { projectId: "project_alpha", exportedAt: "2026-11-06T00:00:00.000Z" }],
  ]) {
    const response = (await http.call("capability_read", invoke(operation, args))).body;
    assert(!response.error, JSON.stringify(response.error));
    results[operation] = response.result;
    const sameOwner = (await http.call("capability_read", invoke(operation, {
      ...args, snapshotRevision: response.result.snapshotRevision,
    }))).body;
    assert.deepEqual(sameOwner.result, response.result);
    const stale = (await http.call("capability_read", invoke(operation, { ...args, snapshotRevision: "0".repeat(64) }))).body;
    assert.equal(stale.error.code, "CONFLICT");
  }
  assert.equal(results["project.list"].total, 2);
  assert.equal(results["project.get"].item.projectId, "project_alpha");
  assert.deepEqual(results["project.get"].threads, []);
  assert.deepEqual(results["project.get"].ganttTasks, []);
  assert.deepEqual(results["project.get"].collaborationTasks, []);
  assert.equal(results["project.recipe.list"].total, 1);
  assert.equal(results["project.recipe.list"].items[0].recipeId, "recipe_alpha");
  assert.deepEqual(results["project.recipe.get"].item, recipe);
  const bundle = results["project.recipe.bundle.get"].item;
  assert.equal(bundle.schema, "pkm.project-recipe-bundle/v1");
  assert.equal(bundle.recipes.length, 1);
  assert.equal(bundle.knowledge.length, 2);
  assert.deepEqual(bundle.knowledge.map(item => [item.knowledgeId, item.contentHash]).sort(),
    [["Coding/Verify", skillHash], ["Projects/Release", noteHash]]);
  assert.match(bundle.digest, /^[a-f0-9]{64}$/);
  await http.close();
});

test("resource rename/delete share durable receipts, guarded compound rewrites and reader previews over HTTP", async t => {
  const { directory } = await fixture(t);
  await writeFile(join(directory, "notes", "owner.md"), "---\ndocumentId: owner\nrevision: 3\n---\n![asset](owner.assets/source.bin)");
  await mkdir(join(directory, "notes", "owner.assets"));
  const bytes = Buffer.from([0, 255, 1]);
  await writeFile(join(directory, "notes", "owner.assets", "source.bin"), bytes);
  const http = await httpProcess(t, directory);
  const sameOwnerCall = async (name, args) => {
    return (await http.call(name, args)).body;
  };
  const document = (await http.call("capability_read", invoke("knowledge.document.get", { id: "owner" }))).body.result;
  const pins = { id: "owner", area: "notes", documentPath: "owner.md",
    expectedRevision: document.revision, expectedSha256: document.sha256, path: "owner.assets/source.bin",
    expectedDigest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`, expectedSize: bytes.length };
  const previewArgs = { ...pins, action: "rename", newName: "renamed.bin" };
  const preview = (await http.call("capability_read", invoke("knowledge.asset.lifecycle.preview", previewArgs))).body;
  assert(!preview.error, JSON.stringify(preview.error));
  assert.equal(preview.result.markdownRewriteRequired, true);
  assert.deepEqual((await sameOwnerCall("capability_read", invoke("knowledge.asset.lifecycle.preview", previewArgs))).result, preview.result);
  const rename = invoke("knowledge.asset.rename", { ...pins, operationId: randomUUID(),
    expectedScanRevision: preview.result.scanRevision, newName: "renamed.bin",
    expectedDestinationDigest: null, rewriteMarkdown: true });
  const renamed = (await http.call("capability_call", rename)).body;
  assert(!renamed.error, JSON.stringify(renamed.error));
  assert.equal(renamed.result.markdownRewritten, true);
  assert.deepEqual((await sameOwnerCall("capability_call", rename)).result, renamed.result);
  assert.deepEqual(await readFile(join(directory, "notes", "owner.assets", "renamed.bin")), bytes);
  await assert.rejects(readFile(join(directory, "notes", "owner.assets", "source.bin")), { code: "ENOENT" });
  const after = (await http.call("capability_read", invoke("knowledge.document.get", { id: "owner" }))).body.result;
  assert(after.content.includes("owner.assets/renamed.bin"));
  assert.equal(after.revision, document.revision);
  const deletePins = { ...pins, path: "owner.assets/renamed.bin", expectedSha256: after.sha256 };
  const blocked = (await http.call("capability_read", invoke("knowledge.asset.lifecycle.preview", { ...deletePins, action: "delete" }))).body;
  assert(blocked.error, "Referenced delete must fail explicitly");
  const cleared = (await http.call("capability_call", invoke("knowledge.document.update", {
    id: "owner", operationId: randomUUID(), expectedRevision: after.revision, expectedSha256: after.sha256,
    title: after.title, content: "No references",
  }))).body.result;
  const finalPins = { ...deletePins, expectedRevision: cleared.revision, expectedSha256: cleared.sha256 };
  const deletionPreview = (await http.call("capability_read", invoke("knowledge.asset.lifecycle.preview", { ...finalPins, action: "delete" }))).body;
  assert(!deletionPreview.error, JSON.stringify(deletionPreview.error));
  const deletion = invoke("knowledge.asset.delete", { ...finalPins, operationId: randomUUID(), expectedScanRevision: deletionPreview.result.scanRevision });
  const deleted = await sameOwnerCall("capability_call", deletion);
  assert(!deleted.error, JSON.stringify(deleted.error));
  assert.equal(deleted.result.after, null);
  assert.deepEqual((await http.call("capability_call", deletion)).body.result, deleted.result);
  await assert.rejects(readFile(join(directory, "notes", "owner.assets", "renamed.bin")), { code: "ENOENT" });
  assert.deepEqual((await http.call("capability_call", rename)).body.result, renamed.result);
  await http.close();
  const readOnly = await httpProcess(t, directory, ["--read-only"]);
  assert.equal((await readOnly.call("capability_call", rename)).status, 403);
  await readOnly.close();
});

test("committed resource lifecycle intent recovers compound effects and immutable receipt at storage restart", async t => {
  const { directory } = await fixture(t);
  await writeFile(join(directory, "notes", "owner.md"), "---\ndocumentId: owner\nrevision: 3\n---\n![asset](owner.assets/source.bin)");
  await mkdir(join(directory, "notes", "owner.assets"));
  const bytes = Buffer.from([0, 255, 1]);
  await writeFile(join(directory, "notes", "owner.assets", "source.bin"), bytes);
  const store = await Storage.open(directory);
  const document = await store.request({ operation: "knowledge.document.get", args: { id: "owner" }, actorId: owner.id });
  const pins = { id: "owner", area: "notes", documentPath: "owner.md", expectedRevision: document.revision,
    expectedSha256: document.sha256, path: "owner.assets/source.bin", expectedSize: bytes.length,
    expectedDigest: `sha256:${createHash("sha256").update(bytes).digest("hex")}` };
  const preview = await store.request({ operation: "knowledge.asset.lifecycle.preview", args: { ...pins, action: "rename", newName: "renamed.bin" }, actorId: owner.id });
  await store.close();
  const request = { operation: "knowledge.asset.rename", actorId: owner.id, args: { ...pins,
    operationId: randomUUID(), expectedScanRevision: preview.scanRevision, newName: "renamed.bin", expectedDestinationDigest: null, rewriteMarkdown: true } };
  const plan = planResourceLifecycle(directory, scanMarkdown(directory), request);
  const db = new DatabaseSync(join(directory, "core.sqlite"));
  try {
    db.prepare("INSERT INTO pending_resource VALUES(1,?,?,?,?,?)").run(request.args.operationId,
      createHash("sha256").update(JSON.stringify(request)).digest("hex"), owner.id, request.operation, serializeResourceLifecyclePlan(plan));
  } finally { db.close(); }
  await writeFile(join(directory, "notes", "owner.assets", "renamed.bin"), bytes);
  const reopened = await Storage.open(directory);
  cleanups.get(t).push(() => reopened.close());
  assert.deepEqual(await reopened.request(request), plan.result);
  assert.deepEqual(await readFile(join(directory, "notes", "owner.assets", "renamed.bin")), bytes);
  await assert.rejects(readFile(join(directory, "notes", "owner.assets", "source.bin")), { code: "ENOENT" });
  assert((await readFile(join(directory, "notes", "owner.md"), "utf8")).includes("renamed.bin"));
});

test("resource recovery preserves unknown external bytes and mismatched intent identities", async t => {
  for (const fault of ["resource-bytes", "actor-identity", "operation-identity"]) {
    await t.test(fault, async t => {
      const { directory } = await fixture(t);
      const markdown = "---\ndocumentId: owner\nrevision: 3\n---\nNo references";
      await writeFile(join(directory, "notes", "owner.md"), markdown);
      await mkdir(join(directory, "notes", "owner.assets"));
      const bytes = Buffer.from([0, 255, 1]);
      const resource = join(directory, "notes", "owner.assets", "source.bin");
      await writeFile(resource, bytes);
      const store = await Storage.open(directory);
      const document = await store.request({ operation: "knowledge.document.get", args: { id: "owner" }, actorId: owner.id });
      const pins = { id: "owner", area: "notes", documentPath: "owner.md", expectedRevision: document.revision,
        expectedSha256: document.sha256, path: "owner.assets/source.bin", expectedSize: bytes.length,
        expectedDigest: `sha256:${createHash("sha256").update(bytes).digest("hex")}` };
      const preview = await store.request({ operation: "knowledge.asset.lifecycle.preview", args: { ...pins, action: "delete" }, actorId: owner.id });
      await store.close();
      const request = { operation: "knowledge.asset.delete", args: { ...pins, operationId: randomUUID(), expectedScanRevision: preview.scanRevision }, actorId: owner.id };
      const plan = planResourceLifecycle(directory, scanMarkdown(directory), request);
      const serialized = serializeResourceLifecyclePlan(plan);
      const db = new DatabaseSync(join(directory, "core.sqlite"));
      try {
        db.prepare("INSERT INTO pending_resource VALUES(1,?,?,?,?,?)").run(
          request.args.operationId, createHash("sha256").update(JSON.stringify(request)).digest("hex"),
          fault === "actor-identity" ? "different:actor" : owner.id,
          fault === "operation-identity" ? "knowledge.asset.rename" : request.operation, serialized,
        );
      } finally { db.close(); }
      const expectedBytes = fault === "resource-bytes" ? Buffer.from("external edit") : bytes;
      if (fault === "resource-bytes") await writeFile(resource, expectedBytes);
      await assert.rejects(Storage.open(directory), /resource|Resource/);
      assert.deepEqual(await readFile(resource), expectedBytes);
      assert.equal(await readFile(join(directory, "notes", "owner.md"), "utf8"), markdown);
      const check = new DatabaseSync(join(directory, "core.sqlite"));
      try {
        assert.equal(check.prepare("SELECT plan FROM pending_resource").get().plan, serialized);
        assert.equal(check.prepare("SELECT count(*) AS count FROM receipts").get().count, 0);
      } finally { check.close(); }
    });
  }
});

test("Skill routing preserves metadata admission, complete selection and prompt semantics over HTTP", async t => {
  const { directory } = await fixture(t);
  const http = await httpProcess(t, directory);
  const sameOwnerCall = async args => (await http.call("capability_read", args)).body;
  let fixtureSkill;
  for (const [id, path, fields] of [
    ["fixture-skill", "Testing/Fixture.md", { name: "Fixture Skill", description: "pytest workflow", tags: ["pytest"],
      priority: "highest", recipe_required: true, recipe_hint: "Validate tests", related_skills: [] }],
    ["unrelated-skill", "Other/Unrelated.md", { name: "Unrelated" }],
  ]) {
    const created = (await http.call("capability_call", invoke("knowledge.document.create", {
      id, path, area: "skills", operationId: randomUUID(), title: "Ignored Display Title", content: "pytest workflow",
    }))).body;
    assert(!created.error, JSON.stringify(created.error));
    const updated = (await http.call("capability_call", invoke("knowledge.metadata.update", {
      id, operationId: randomUUID(), expectedRevision: created.result.revision, expectedSha256: created.result.sha256, set: fields,
    }))).body;
    assert(!updated.error, JSON.stringify(updated.error));
    if (id === "fixture-skill") fixtureSkill = updated.result;
  }
  const reads = {};
  for (const [suffix, args] of [
    ["context", { task: "pytest workflow", detail: "full" }],
    ["select", { query: "pytest workflow" }],
    ["project", { selected: [{ id: "fixture-skill", documentSha256: fixtureSkill.sha256 }] }],
    ["prompt", { query: "pytest workflow", selected: [{ id: "fixture-skill" }] }],
  ]) {
    const operation = `knowledge.skill.routing.${suffix}`;
    const response = (await http.call("capability_read", invoke(operation, args))).body;
    assert(!response.error, JSON.stringify(response.error));
    reads[suffix] = response.result;
    assert.deepEqual((await sameOwnerCall(invoke(operation, { ...args, snapshotRevision: response.result.snapshotRevision }))).result, response.result);
  }
  assert.equal(reads.context.count, 1);
  const candidate = reads.context.items[0];
  assert.equal(candidate.skill_id, "Testing/Fixture Skill");
  assert.equal(candidate.address.documentId, "fixture-skill");
  assert.equal(candidate.skill_priority, "highest");
  assert.equal(candidate.priority, "required");
  assert.equal(candidate.score, 86);
  assert.equal(candidate.task_coverage, 1);
  assert.equal(candidate.source_rank, 1);
  assert(!Object.hasOwn(candidate, "content"));
  assert.equal(reads.select.total, 1);
  assert.equal(reads.select.nextOffset, null);
  assert.equal(reads.select.items[0].id, "Fixture Skill");
  assert.equal(reads.select.items[0].sourceId, "pkm://skills/Fixture%20Skill");
  assert.equal(reads.select.items[0].content, "pytest workflow");
  assert.equal(reads.select.items[0].address.documentId, "fixture-skill");
  assert.equal(reads.project.projection, null);
  assert.equal(reads.prompt.messages.length, 2);
  assert.deepEqual(reads.prompt.sourceIds, ["pkm://skills/Fixture%20Skill"]);
  assert.deepEqual(reads.prompt.priorities, [{ id: "fixture-skill", priority: 50 }]);
  assert.equal(reads.prompt.selection, null);
  const stale = (await http.call("capability_read", invoke("knowledge.skill.routing.project", {
    selected: [{ id: "fixture-skill", documentSha256: "0".repeat(64) }],
  }))).body;
  assert.equal(stale.error.code, "CONFLICT");
  await http.close();
});

test("canonical links resolve pinned cross-area links over HTTP", async t => {
  const { directory } = await fixture(t);
  const http = await httpProcess(t, directory);
  const uris = [];
  const saved = [];
  for (const [index, area] of ["papers", "skills", "notes"].entries()) {
    const id = `link-${area}`;
    const created = (await http.call("capability_call", invoke("knowledge.document.create", {
      operationId: randomUUID(), id, area, title: id, content: "Link fixture",
    }))).body;
    assert(!created.error, JSON.stringify(created.error));
    const identity = (await http.call("capability_read", invoke("knowledge.metadata.get", { id }))).body;
    assert(!identity.error, JSON.stringify(identity.error));
    uris.unshift(`pkm://knowledge/${identity.result.metadata.knowledgeId}`);
    const links = index === 0 ? [] : [{
      target: uris[1], relation: "cites", mode: "pinned", required: true,
      targetRevision: String(saved[index - 1].revision),
    }];
    if (index === 2) links.push({ target: uris[2], relation: "cites", mode: "floating", required: false });
    const updated = (await http.call("capability_call", invoke("knowledge.metadata.update", {
      operationId: randomUUID(), id, expectedRevision: created.result.revision, expectedSha256: created.result.sha256,
      set: { links },
    }))).body;
    assert(!updated.error, JSON.stringify(updated.error));
    saved.push(updated.result);
  }
  const args = { starts: [uris[0]], direction: "forward", maxDepth: 2 };
  const resolved = (await http.call("capability_read", invoke("knowledge.links.resolve", args))).body;
  assert(!resolved.error, JSON.stringify(resolved.error));
  assert.equal(resolved.result.totalNodes, 3);
  assert.equal(resolved.result.totalEdges, 3);
  assert(resolved.result.edges.every(edge => edge.resolved));
  assert.deepEqual(resolved.result.diagnostics, []);
  assert.equal(resolved.result.truncated, false);
  assert.deepEqual((await http.call("capability_read", invoke("knowledge.links.resolve", {
    ...args, snapshotPins: resolved.result.snapshotPins,
  })).then(response => response.body)).result, resolved.result);
  const stale = (await http.call("capability_read", invoke("knowledge.links.resolve", {
    ...args, snapshotPins: { ...resolved.result.snapshotPins, notes: "0".repeat(64) },
  }))).body;
  assert.equal(stale.error.code, "CONFLICT");
  await http.close();
});

test("HTTP rejects malformed inputs without committing", async t => {
  const { directory } = await fixture(t);
  const http = await httpProcess(t, directory);
  for (const [body, contentType, status] of [
    ["{", "application/json", 400],
    ["{}", "text/plain", 400],
    [JSON.stringify({ padding: "x".repeat(131073) }), "application/json", 400],
  ]) {
    const response = await fetch(`${http.url}/v1/capability_call`, {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": contentType }, body,
    });
    assert.equal(response.status, status);
    const envelope = await response.json();
    assert(resultEnvelope.safeParse(envelope).success);
    assert.equal(envelope.error.effect, "not-committed");
  }
  const invalid = await http.call("capability_call", invoke("knowledge.document.create", {
    id: "../escape", operationId: randomUUID(), title: "Bad", content: "no",
  }));
  assert.equal(invalid.body.error.code, "INVALID_ARGUMENT");
  assert.equal((await http.call("capability_read", invoke("knowledge.document.list", {}))).body.result.total, 0);
});

test("bounded worker queue drains on shutdown and the Core event loop remains responsive during a database lock", async t => {
  const { directory } = await fixture(t);
  const storage = await Storage.open(directory); cleanups.get(t).push(() => storage.close());
  const core = new Core(storage);
  const created = await core.dispatch("capability_call", invoke("knowledge.document.create", { id: "a", operationId: randomUUID(), title: "A", content: "original" }), owner);
  const db = new DatabaseSync(join(directory, "core.sqlite")); cleanups.get(t).push(() => db.close());
  db.exec("BEGIN IMMEDIATE");
  try {
    const update = core.dispatch("capability_call", invoke("knowledge.document.update", {
      id: "a", operationId: randomUUID(), expectedRevision: 1, expectedSha256: created.result.sha256, title: "A", content: "updated",
    }), owner);
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal((await core.dispatch("server_info", {}, owner)).result.name, "pkm-next");
    db.exec("COMMIT");
    assert.equal((await update).result.revision, 2);
  } catch (error) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw error;
  }
  const requests = Array.from({ length: 40 }, () => storage.request({ operation: "knowledge.document.get", args: { id: "a" }, actorId: owner.id }));
  const outcomes = Promise.allSettled(requests);
  await storage.close();
  const results = await outcomes;
  assert.equal(results.filter(result => result.status === "fulfilled").length, 32);
  const rejected = results.filter(result => result.status === "rejected");
  assert.equal(rejected.length, 8);
  assert(rejected.every(result => result.reason.code === "BUSY" && result.reason.effect === "not-committed"));
  await assert.rejects(storage.request({ operation: "knowledge.document.get", args: { id: "a" }, actorId: owner.id }), /closed/);
});

test("pagination is deterministic, bounded and metadata-only; replay survives later writes and actor changes are rejected", async t => {
  const { directory } = await fixture(t);
  const storage = await Storage.open(directory); cleanups.get(t).push(() => storage.close());
  const core = new Core(storage);
  const execute = (method, args, actor = owner) => core.dispatch(method, args, actor);
  const first = invoke("knowledge.document.create", { id: "a", operationId: randomUUID(), title: "A", content: "secret" });
  await execute("capability_call", first);
  await execute("capability_call", invoke("knowledge.document.create", { id: "b", operationId: randomUUID(), title: "B", content: "secret" }));
  const page = (await execute("capability_read", invoke("knowledge.document.list", { limit: 1 }))).result;
  assert.equal(page.total, 2); assert.equal(page.nextOffset, 1);
  assert.equal(page.items.length, 1); assert.equal(page.items[0].id, "a");
  assert(!Object.hasOwn(page.items[0], "content"));
  const next = (await execute("capability_read", invoke("knowledge.document.list", { limit: 1, offset: page.nextOffset, workspaceRevision: page.workspaceRevision }))).result;
  assert.equal(next.items[0].id, "b"); assert.equal(next.nextOffset, null);
  assert.equal((await execute("capability_call", first)).result.revision, 1);
  assert.equal((await execute("capability_call", first, { id: "different-owner", canWrite: true })).error.code, "CONFLICT");
  assert.equal((await execute("capability_read", invoke("knowledge.document.list", { limit: 101 }))).error.code, "INVALID_ARGUMENT");
});

test("unsupported database versions fail at startup without silently downgrading", async t => {
  const { directory } = await fixture(t);
  const db = new DatabaseSync(join(directory, "core.sqlite"));
  db.exec("PRAGMA user_version=999"); db.close();
  await assert.rejects(Storage.open(directory), /Unsupported workspace database version/);
  const check = new DatabaseSync(join(directory, "core.sqlite"));
  assert.equal(check.prepare("PRAGMA user_version").get().user_version, 999);
  check.close();
});

test("shutdown drains a pending write and its receipt survives a fresh worker", async t => {
  const { directory } = await fixture(t);
  const storage = await Storage.open(directory);
  const request = {
    operation: "knowledge.document.create",
    args: { id: "during-shutdown", operationId: randomUUID(), title: "Shutdown", content: "committed" },
    actorId: owner.id,
  };
  const pendingWrite = storage.request(request);
  await Promise.all([storage.close(), storage.close()]);
  const committed = await pendingWrite;
  assert.equal(committed.revision, 1);
  const reopened = await Storage.open(directory);
  cleanups.get(t).push(() => reopened.close());
  assert.deepEqual(await reopened.request(request), committed);
});

test("read-only MCP exposes only read tools and rejects write attempts", async t => {
  const { directory } = await fixture(t);
  const transport = new StdioClientTransport({
    command: process.execPath, args: [cli, "mcp", "--data", directory, "--read-only"], stderr: "pipe",
  });
  const client = new Client({ name: "read-only-test", version: "1.0.0" });
  cleanups.get(t).push(() => client.close());
  await client.connect(transport);
  const tools = (await client.listTools()).tools;
  assert.deepEqual(tools.map(tool => tool.name).sort(), [
    "api_chat_capabilities", "api_chat_get", "api_chat_list", "api_chat_models", "api_chat_request_get",
    "capabilities_describe", "capabilities_search", "capability_read", "recipe_capabilities", "server_info",
  ]);
  assert(tools.every(tool => tool.annotations.readOnlyHint));
  assert(tools.filter(tool => [
    "server_info", "capabilities_search", "capabilities_describe", "capability_read",
  ].includes(tool.name)).every(tool => tool.outputSchema));
  const denied = await client.callTool({ name: "capability_call", arguments: invoke("knowledge.document.create", {
    id: "denied", operationId: randomUUID(), title: "Denied", content: "must not write",
  }) });
  assert.equal(denied.isError, true);
  const result = await client.callTool({ name: "capabilities_search", arguments: { query: "knowledge.document" } });
  assert.equal(result.structuredContent.result.total, 3);
  assert(result.structuredContent.result.items.every(item => item.readOnly));
});

test("committed writes recover after abrupt exit only after the single-owner lease expires", async t => {
  const { directory } = await fixture(t);
  const first = await httpProcess(t, directory);
  const create = invoke("knowledge.document.create", {
    id: "crash-recovery", operationId: randomUUID(), title: "Recover", content: "WAL committed",
  });
  const committed = await first.call("capability_call", create);
  assert.equal(committed.status, 200);
  first.child.kill("SIGKILL");
  assert.equal((await once(first.child, "exit"))[1], "SIGKILL");
  await assert.rejects(httpProcess(t, directory), /Another process currently owns this workspace/);
  const lease = new DatabaseSync(join(directory, "core.sqlite"));
  try { lease.prepare("UPDATE native_runtime_owner SET lease_until=0 WHERE singleton=1").run(); }
  finally { lease.close(); }
  const restarted = await httpProcess(t, directory);
  assert.deepEqual((await restarted.call("capability_read", invoke("knowledge.document.get", { id: "crash-recovery" }))).body.result, committed.body.result);
  assert.deepEqual((await restarted.call("capability_call", create)).body.result, committed.body.result);
  await restarted.close();
});

test("CLI initializes only a new workspace and rejects insecure startup before opening storage", async t => {
  const { parent } = await fixture(t);
  const directory = join(parent, "cli-workspace");
  const initialized = await executeFile(process.execPath, [cli, "init", "--data", directory]);
  assert.equal(JSON.parse(initialized.stdout).initialized, directory);
  await assert.rejects(executeFile(process.execPath, [cli, "init", "--data", directory]), /EEXIST/);
  await assert.rejects(executeFile(process.execPath, [cli, "http", "--data", directory], {
    env: { ...process.env, PKM_NEXT_TOKEN: "" },
  }), /PKM_NEXT_TOKEN/);
  assert.deepEqual((await readdir(directory)).sort(), [".pkm-next-workspace", "notes"], "invalid transport config must not open/create the database");
});

test("HTTP accepts Note requests above the former 128-KiB request-body limit", async t => {
  const { directory } = await fixture(t);
  const http = await httpProcess(t, directory);
  const content = "large note body ".repeat(20_000);
  const created = await http.call("capability_call", invoke("knowledge.document.create", {
    id: "large-http-note", operationId: randomUUID(), title: "Large HTTP Note", content,
  }));
  assert.equal(created.status, 200);
  assert.equal(created.body.result.content.length, content.length);
  const read = await http.call("capability_read", invoke("knowledge.document.get", { id: "large-http-note" }));
  assert.equal(read.status, 200);
  assert.equal(read.body.result.content, content);
});
