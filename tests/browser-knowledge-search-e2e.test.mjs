import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { resolve } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ProtocolClient, OPERATIONS } from "../browser/protocol.mjs";
import { KNOWLEDGE_LIFECYCLE_OPERATIONS, createKnowledgeLifecycleClient,
  knowledgeMutationScanRevision } from "../browser/knowledge-lifecycle.mjs";
import { startMcp } from "../dist/mcp.js";
import { managerActor, nativeWorkspace, until } from "./batch06-manager-fixtures.mjs";

const reader = Object.freeze({ id: "native:browser-search-reader", canWrite: false });
const invocation = (operation, args) => ({ operation, version: 1, arguments: args });
const hostileSource = '<script>window.pkmInjected = true</script>\nOLD pinned source';
const currentSource = '<script>window.pkmInjected = true</script>\nCURRENT pinned source';

test("production Browser searches and opens a pinned Note through Core HTTP and read-only MCP", { timeout: 45_000 }, async t => {
  const f = await nativeWorkspace(t);
  const writerUrl = await f.listen(managerActor);
  const readerUrl = await f.listen(reader);
  const writerProtocol = new ProtocolClient({ origin: writerUrl,
    operations: { ...OPERATIONS, ...KNOWLEDGE_LIFECYCLE_OPERATIONS } });
  writerProtocol.authenticate(f.bearer);
  await writerProtocol.bootstrap();
  const writer = createKnowledgeLifecycleClient(writerProtocol);
  const receipt = await writer.noteCreate({
    operationId: randomUUID(), expectedScanRevision: await knowledgeMutationScanRevision(writer),
    title: "Pinned Browser Fixture", category: "Browser", content: hostileSource,
  });
  assert.equal(receipt.action, "create");

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const mcp = await startMcp(f.runtime.core, reader, serverTransport);
  const mcpClient = new Client({ name: "browser-search-e2e", version: "1.0.0" });
  await mcpClient.connect(clientTransport);
  f.addCleanup(async () => { await mcpClient.close(); await mcp.close(); writerProtocol.dispose(); });
  const tools = (await mcpClient.listTools()).tools;
  assert(tools.some(tool => tool.name === "capability_read"));
  assert.equal(tools.some(tool => tool.name === "capability_call"), false, "reader MCP cannot discover mutation entry");
  const described = await mcpClient.callTool({ name: "capabilities_describe", arguments: { operation: "knowledge.note.search" } });
  assert.equal(described.isError, false);
  assert.equal(described.structuredContent.result.readOnly, true);
  const search = await mcpClient.callTool({ name: "capability_read", arguments: invocation("knowledge.note.search", {
    query: "Pinned Browser Fixture", offset: 0, limit: 10,
  }) });
  assert.equal(search.isError, false);
  const mcpSnapshot = search.structuredContent.result;
  const match = mcpSnapshot.items.find(item => item.documentId === receipt.id);
  assert.ok(match, JSON.stringify(mcpSnapshot));
  const opened = await mcpClient.callTool({ name: "capability_read", arguments: invocation("knowledge.note.get", {
    id: receipt.id, snapshotRevision: mcpSnapshot.snapshotRevision,
  }) });
  assert.equal(opened.isError, false);
  assert.equal(opened.structuredContent.result.item.content, hostileSource);
  assert.equal(opened.structuredContent.result.item.documentSha256, match.documentSha256);

  const child = spawn(process.env.PYTHON ?? "python", [resolve(import.meta.dirname, "browser-knowledge-search-e2e.py")],
    { stdio: ["pipe", "pipe", "pipe"] });
  let output = "", diagnostics = "", report;
  child.stdout.on("data", bytes => { output += bytes.toString(); });
  child.stderr.on("data", bytes => { diagnostics += bytes.toString(); });
  const lines = createInterface({ input: child.stdout });
  const handling = (async () => {
    for await (const line of lines) {
      const event = JSON.parse(line);
      if (event.checkpoint === "search-ready") {
        const latest = await writer.documentGet({ id: receipt.id });
        await writer.noteUpdate({
          operationId: randomUUID(), id: receipt.id,
          expectedScanRevision: await knowledgeMutationScanRevision(writer),
          expectedRevision: latest.revision, expectedSha256: latest.sha256,
          content: currentSource,
        });
        child.stdin.write('{"ready":true}\n');
      } else {
        report = event;
      }
    }
  })();
  const closed = new Promise((done, reject) => { child.once("error", reject); child.once("close", done); });
  const timer = setTimeout(() => child.kill("SIGTERM"), 30_000);
  f.addCleanup(() => { clearTimeout(timer); if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM"); });
  child.stdin.write(JSON.stringify({
    url: readerUrl, token: f.bearer, title: "Pinned Browser Fixture",
    initialSnapshotRevision: mcpSnapshot.snapshotRevision,
  }) + "\n");
  const status = await closed;
  clearTimeout(timer);
  await handling;
  assert.equal(status, 0, `${output}\n${diagnostics}`);
  assert.ok(report, output);
  assert.deepEqual(report.errors, []);
  assert.equal(report.injected, false);
  assert.equal(report.readOnly, true);
  assert(report.calls.some(call => call.operation === "knowledge.note.search"));
  const noteReads = report.calls.filter(call => call.operation === "knowledge.note.get");
  assert.equal(noteReads.length, 2, JSON.stringify(report.calls));
  assert.equal(noteReads[0].arguments.snapshotRevision, mcpSnapshot.snapshotRevision,
    "the first Browser open uses the exact search snapshot");
  assert.notEqual(noteReads[1].arguments.snapshotRevision, mcpSnapshot.snapshotRevision,
    "refreshing after a changed source obtains a new snapshot");
  assert(report.calls.some(call => call.operation === "knowledge.document.get"));
  assert.equal(report.calls.some(call => call.method === "capability_call"), false,
    "the Browser flow performs reads only");
  assert.equal((await writer.documentGet({ id: receipt.id })).content, currentSource);
  writerProtocol.dispose();
});
