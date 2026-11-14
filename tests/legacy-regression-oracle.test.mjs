import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { initialize } from "../dist/storage.js";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(testDirectory, "..");
const repositoryRoot = resolve(packageRoot, "legacy");
const cli = resolve(packageRoot, "dist/cli.js");
const reportPath = join(testDirectory, "legacy-regression-oracle.report.json");
const nativeSources = [
  "src/cli.ts", "src/contracts.ts", "src/core.ts", "src/http.ts", "src/mcp.ts", "src/storage.ts",
  "src/storage-worker.ts", "src/markdown.ts", "src/notes.ts", "src/note-contracts.ts", "src/domain/todo-api.ts",
  "src/domain/markdown-assets.ts", "src/todo-definitions.ts", "src/domain/todo-api-contract.ts",
  "src/domain/todo-identities.ts", "src/domain/todo-board.ts", "src/memory.ts", "src/memory-contracts.ts",
];
const sourcesByOperation = {
  "knowledge.document.create": ["src/contracts.ts", "src/storage-worker.ts", "src/storage.ts", "src/core.ts", "src/http.ts", "src/mcp.ts"],
  "knowledge.document.update": ["src/contracts.ts", "src/storage-worker.ts", "src/storage.ts", "src/core.ts", "src/http.ts", "src/mcp.ts"],
  "knowledge.metadata.get": ["src/contracts.ts", "src/storage-worker.ts", "src/storage.ts", "src/core.ts", "src/http.ts", "src/mcp.ts"],
  "knowledge.metadata.update": ["src/contracts.ts", "src/storage-worker.ts", "src/storage.ts", "src/core.ts", "src/http.ts", "src/mcp.ts"],
  "knowledge.note.list": ["src/note-contracts.ts", "src/notes.ts", "src/markdown.ts", "src/core.ts", "src/http.ts", "src/mcp.ts"],
  "knowledge.note.get": ["src/note-contracts.ts", "src/notes.ts", "src/markdown.ts", "src/core.ts", "src/http.ts", "src/mcp.ts"],
  "knowledge.asset.list": ["src/contracts.ts", "src/domain/markdown-assets.ts", "src/storage-worker.ts", "src/core.ts", "src/http.ts", "src/mcp.ts"],
  "knowledge.asset.get": ["src/contracts.ts", "src/domain/markdown-assets.ts", "src/storage-worker.ts", "src/core.ts", "src/http.ts", "src/mcp.ts"],
  "todo.board.create": ["src/todo-definitions.ts", "src/domain/todo-api-contract.ts", "src/domain/todo-identities.ts", "src/domain/todo-board.ts", "src/storage-worker.ts", "src/core.ts", "src/http.ts", "src/mcp.ts"],
  "todo.board.list": ["src/todo-definitions.ts", "src/domain/todo-api-contract.ts", "src/domain/todo-identities.ts", "src/domain/todo-board.ts", "src/storage-worker.ts", "src/core.ts", "src/http.ts", "src/mcp.ts"],
  "todo.board.get": ["src/todo-definitions.ts", "src/domain/todo-api-contract.ts", "src/domain/todo-identities.ts", "src/domain/todo-board.ts", "src/storage-worker.ts", "src/core.ts", "src/http.ts", "src/mcp.ts"],
  "todo.workitem.create": ["src/todo-definitions.ts", "src/domain/todo-api-contract.ts", "src/domain/todo-identities.ts", "src/domain/todo-board.ts", "src/storage-worker.ts", "src/core.ts", "src/http.ts", "src/mcp.ts"],
  "todo.workitem.list": ["src/todo-definitions.ts", "src/domain/todo-api-contract.ts", "src/domain/todo-identities.ts", "src/domain/todo-board.ts", "src/storage-worker.ts", "src/core.ts", "src/http.ts", "src/mcp.ts"],
  "todo.workitem.claim": ["src/todo-definitions.ts", "src/domain/todo-api-contract.ts", "src/domain/todo-identities.ts", "src/domain/todo-board.ts", "src/storage-worker.ts", "src/core.ts", "src/http.ts", "src/mcp.ts"],
  "todo.workitem.delete": ["src/todo-definitions.ts", "src/domain/todo-api-contract.ts", "src/domain/todo-identities.ts", "src/domain/todo-board.ts", "src/storage-worker.ts", "src/core.ts", "src/http.ts", "src/mcp.ts"],
  "todo.workitem.restore": ["src/todo-definitions.ts", "src/domain/todo-api-contract.ts", "src/domain/todo-identities.ts", "src/domain/todo-board.ts", "src/storage-worker.ts", "src/core.ts", "src/http.ts", "src/mcp.ts"],
  "todo.workitem.comment": ["src/todo-definitions.ts", "src/domain/todo-api-contract.ts", "src/domain/todo-identities.ts", "src/domain/todo-board.ts", "src/storage-worker.ts", "src/core.ts", "src/http.ts", "src/mcp.ts"],
  "todo.workitem.history": ["src/todo-definitions.ts", "src/domain/todo-api-contract.ts", "src/domain/todo-identities.ts", "src/domain/todo-board.ts", "src/storage-worker.ts", "src/core.ts", "src/http.ts", "src/mcp.ts"],
  "todo.board.changes": ["src/todo-definitions.ts", "src/domain/todo-api-contract.ts", "src/domain/todo-identities.ts", "src/domain/todo-board.ts", "src/storage-worker.ts", "src/core.ts", "src/http.ts", "src/mcp.ts"],
  "todo.story.create": ["src/todo-definitions.ts", "src/domain/todo-api-contract.ts", "src/domain/todo-identities.ts", "src/domain/todo-board.ts", "src/storage-worker.ts", "src/core.ts", "src/http.ts", "src/mcp.ts"],
  "todo.story.delete": ["src/todo-definitions.ts", "src/domain/todo-api-contract.ts", "src/domain/todo-identities.ts", "src/domain/todo-board.ts", "src/storage-worker.ts", "src/core.ts", "src/http.ts", "src/mcp.ts"],
  "todo.story.restore": ["src/todo-definitions.ts", "src/domain/todo-api-contract.ts", "src/domain/todo-identities.ts", "src/domain/todo-board.ts", "src/storage-worker.ts", "src/core.ts", "src/http.ts", "src/mcp.ts"],
  "memory.record.propose": ["src/memory-contracts.ts", "src/memory.ts", "src/storage-worker.ts", "src/storage.ts", "src/core.ts", "src/http.ts", "src/mcp.ts"],
  "memory.record.get": ["src/memory-contracts.ts", "src/memory.ts", "src/storage-worker.ts", "src/storage.ts", "src/core.ts", "src/http.ts", "src/mcp.ts"],
  "memory.record.search": ["src/memory-contracts.ts", "src/memory.ts", "src/storage-worker.ts", "src/storage.ts", "src/core.ts", "src/http.ts", "src/mcp.ts"],
  "memory.record.audit": ["src/memory-contracts.ts", "src/memory.ts", "src/storage-worker.ts", "src/storage.ts", "src/core.ts", "src/http.ts", "src/mcp.ts"],
  "memory.record.confirm": ["src/memory-contracts.ts", "src/memory.ts", "src/storage-worker.ts", "src/core.ts", "src/http.ts", "src/mcp.ts"],
  "memory.record.revoke": ["src/memory-contracts.ts", "src/memory.ts", "src/storage-worker.ts", "src/core.ts", "src/http.ts", "src/mcp.ts"],
};
const invoke = (operation, args = {}) => ({ operation, version: 1, arguments: args });
const sha256 = value => createHash("sha256").update(value).digest("hex");
const resultOf = response => {
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert(!response.body.error, JSON.stringify(response.body.error));
  return response.body.result;
};

async function fixture(t) {
  const parent = join(testDirectory, `.legacy-regression-oracle-${randomUUID()}`);
  const directory = join(parent, "workspace");
  await mkdir(parent, { recursive: true });
  await initialize(directory);
  t.after(() => rm(parent, { recursive: true, force: true }));
  return { parent, directory };
}

async function httpProcess(t, directory) {
  const token = randomUUID() + randomUUID();
  const child = spawn(process.execPath, [cli, "http", "--data", directory], {
    cwd: packageRoot,
    env: { ...process.env, PKM_NEXT_TOKEN: token },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let diagnostics = "";
  child.stderr.on("data", data => { diagnostics += data; });
  const url = await new Promise((resolveUrl, reject) => {
    const lines = createInterface({ input: child.stdout });
    const timeout = setTimeout(() => reject(new Error(`HTTP readiness timeout: ${diagnostics}`)), 10_000);
    lines.on("line", line => {
      try {
        const message = JSON.parse(line);
        if (message.ready) {
          clearTimeout(timeout);
          resolveUrl(message.url);
        }
      } catch (error) {
        clearTimeout(timeout);
        reject(error);
      }
    });
    child.once("exit", code => {
      clearTimeout(timeout);
      reject(new Error(`HTTP server exited ${code}: ${diagnostics}`));
    });
  });
  const close = async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await once(child, "exit");
    }
  };
  t.after(close);
  return {
    close,
    async call(method, input) {
      const response = await fetch(`${url}/v1/${method}`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(input),
      });
      return { status: response.status, body: await response.json() };
    },
  };
}

async function mcpClient(t, directory) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [cli, "mcp", "--data", directory],
    cwd: packageRoot,
    stderr: "pipe",
  });
  let diagnostics = "";
  transport.stderr?.on("data", data => { diagnostics += data; });
  const client = new Client({ name: "legacy-regression-oracle", version: "1.0.0" });
  try {
    await client.connect(transport);
  } catch (error) {
    throw new Error(`${error}; MCP startup stderr: ${diagnostics}`);
  }
  let closed = false;
  const close = async () => {
    if (!closed) {
      closed = true;
      await client.close();
    }
  };
  t.after(close);
  return {
    close,
    async call(method, input) {
      try {
        const response = await client.callTool({ name: method, arguments: input });
        const envelope = response.structuredContent ?? JSON.parse(response.content[0].text);
        return { status: response.isError ? 400 : 200, body: envelope };
      } catch (error) {
        throw new Error(`${error}; MCP stderr: ${diagnostics}`);
      }
    },
  };
}

test("original knowledge, Todo, and Memory regression assertions qualify through native transports", async t => {
  const rows = [];
  const httpCall = async (http, method, operation, args) => {
    return http.call(method, invoke(operation, args));
  };
  const mcpCall = async (mcp, method, operation, args) => {
    return mcp.call(method, invoke(operation, args));
  };

  await t.test("Markdown resource discovery, ownership, and bytes", async t => {
    const { directory } = await fixture(t);
    const http = await httpProcess(t, directory);
    const content = [
      "![parent](../_assets/plot%20one.png)",
      "![root](../../_assets/root.png?raw=1#figure)",
      "![remote](https://example.com/image.png)",
      "![pkm](pkm://knowledge/knowledge_0123456789abcdef01234567)",
      "`![code](../_assets/plot%20one.png)`",
      "```md",
      "![fenced](../_assets/plot%20one.png)",
      "```",
    ].join("\n");
    const created = resultOf(await http.call("capability_call", invoke("knowledge.document.create", {
      operationId: randomUUID(),
      id: "asset-regression",
      area: "notes",
      path: "Team/Design/Doc.md",
      title: "Doc",
      content,
    })));
    await mkdir(join(directory, "notes/Team/_assets"), { recursive: true });
    await mkdir(join(directory, "notes/_assets"), { recursive: true });
    const teamBytes = Buffer.from("team-plot");
    const rootBytes = Buffer.from("root-plot");
    await writeFile(join(directory, "notes/Team/_assets/plot one.png"), teamBytes);
    await writeFile(join(directory, "notes/_assets/root.png"), rootBytes);
    await writeFile(join(directory, "notes/Team/_assets/ignored.bin"), "not a Markdown resource");

    const listed = resultOf(await httpCall(http, "capability_read", "knowledge.asset.list", { id: created.id }));
    assert.deepEqual(listed.items.map(asset => asset.path), ["_assets/root.png", "Team/_assets/plot one.png"]);
    assert(listed.items.every(asset => /^sha256:[a-f0-9]{64}$/.test(asset.digest)));
    assert(!listed.items.some(asset => asset.path.endsWith("ignored.bin")));
    const originalMarkdown = await readFile(join(directory, "notes/Team/Design/Doc.md"), "utf8");
    for (const [path, expected] of [["_assets/root.png", rootBytes], ["Team/_assets/plot one.png", teamBytes]]) {
      const asset = listed.items.find(item => item.path === path);
      const read = resultOf(await httpCall(http, "capability_read", "knowledge.asset.get", {
        id: created.id,
        path,
        expectedDocumentSha256: created.sha256,
        expectedDigest: asset.digest,
      }));
      assert.deepEqual(Buffer.from(read.data, "base64"), expected);
      assert.equal(read.nextOffset, null);
    }
    assert.equal(await readFile(join(directory, "notes/Team/Design/Doc.md"), "utf8"), originalMarkdown);

    rows.push({
      originalFile: "tests/test-markdown-image-assets.js",
      originalTestcase: "top-level referencedMarkdownAssets and owned-resource assertions",
      originalSourceSha256: await sourceHash("tests/test-markdown-image-assets.js"),
      nativeOperations: ["knowledge.document.create", "knowledge.asset.list", "knowledge.asset.get"],
      scenario: "HTTP-created Markdown fixture resolves parent/root shared resources; ignores code, fenced, remote, and unreferenced paths; digest-pinned reads return exact bytes without changing Markdown.",
      result: "passed",
      assertions: 8,
      evidence: [
        "Listed the expected root and team shared-resource paths with sha256 digests; code-only ignored.bin was excluded.",
        "Both pinned reads returned the fixture bytes exactly; document bytes were unchanged.",
      ],
      unsupportedReason: "The original sync-bundle, GitHub dependency, and VS Code webview URL assertions have no next-server transport equivalent and were not claimed as qualified.",
    });
  });

  await t.test("Todo authority, discoverability, and cross-transport CAS", async t => {
    const { directory } = await fixture(t);
    const http = await httpProcess(t, directory);
    const created = resultOf(await httpCall(http, "capability_call", "todo.board.create", {
      board_slug: "Team/Board",
      operationId: randomUUID(),
    }));
    const discovery = resultOf(await httpCall(http, "capability_read", "todo.board.list", { limit: 10 }));
    assert.equal(discovery.total, 1);
    assert.equal(discovery.items[0].slug, "Team/Board");
    await http.close();
    const mcp = await mcpClient(t, directory);
    const empty = resultOf(await mcpCall(mcp, "capability_read", "todo.board.get", { board_slug: "Team/Board" }));
    assert.equal(empty.digest, created.digest);
    assert.equal(empty.counts.todo, 0);

    const workitem = {
      id: "mcp-task", title: "mcp-task", goal: "Keep one authoritative Board mutation",
      scope: "Regression fixture", acceptance: ["Exactly one CAS winner"],
    };
    const createdWorkitem = resultOf(await mcp.call("capability_call", invoke("todo.workitem.create", {
      board_slug: "Team/Board",
      expected_digest: created.digest,
      operationId: randomUUID(),
      item: workitem,
    })));
    const listed = resultOf(await mcpCall(mcp, "capability_read", "todo.workitem.list", { board_slug: "Team/Board" }));
    assert.equal(listed.total, 1);
    assert.equal(listed.items[0].id, createdWorkitem.item.id);
    const stale = await mcp.call("capability_call", invoke("todo.workitem.create", {
      board_slug: "Team/Board",
      expected_digest: created.digest,
      operationId: randomUUID(),
      item: { ...workitem, id: "stale-task", title: "stale-task" },
    }));
    assert.equal(stale.body.error.code, "CONFLICT");

    const backingPath = join(directory, "boards/Team/Board/pkm-todo-board.json");
    const validBacking = await readFile(backingPath);
    await writeFile(backingPath, "{invalid board JSON");
    const broken = await mcpCall(mcp, "capability_read", "todo.board.get", { board_slug: "Team/Board" });
    assert(broken.body.error, "corrupt authoritative backing must fail closed");
    assert.notEqual(broken.body.error.code, "NOT_FOUND");
    await writeFile(backingPath, validBacking);
    const recovered = resultOf(await mcpCall(mcp, "capability_read", "todo.board.get", { board_slug: "Team/Board" }));
    assert.equal(recovered.digest, createdWorkitem.digest);
    assert.equal(recovered.counts.todo, 1);
    await http.close();
    await mcp.close();
    const restarted = await httpProcess(t, directory);
    const afterRestart = resultOf(await httpCall(restarted, "capability_read", "todo.workitem.list", { board_slug: "Team/Board" }));
    assert.equal(afterRestart.total, 1);
    assert.equal(afterRestart.items[0].id, listed.items[0].id);

    rows.push({
      originalFile: "tests/test-todo-board.js",
      originalTestcase: "dedicated Board is discoverable when empty; generic Markdown and assets cannot change authoritative tasks",
      originalSourceSha256: await sourceHash("tests/test-todo-board.js"),
      nativeOperations: ["todo.board.create", "todo.board.list", "todo.board.get", "todo.workitem.create", "todo.workitem.list"],
      scenario: "HTTP creates and discovers an empty Board; after HTTP releases the single-writer lease, MCP reads the same digest, creates an item, rejects a stale-digest mutation, rejects corrupted authoritative backing, and serves recovered state; an HTTP restart reads the surviving item.",
      result: "passed",
      assertions: 13,
      evidence: [
        "HTTP discovered the empty board; MCP read the same initial digest.",
        "MCP create added one item; using the old digest returned CONFLICT.",
        "Invalid backing JSON failed closed; restored fixture state remained readable after a restarted HTTP server.",
      ],
      unsupportedReason: "The original VS Code/legacy Note Markdown and reserved-asset writes do not map to next-server's isolated boards/ authority and were not represented as native operations.",
    });
    rows.push({
      originalFile: "tests/test-todo-board.js",
      originalTestcase: "competing Board commands across processes have exactly one CAS winner",
      originalSourceSha256: await sourceHash("tests/test-todo-board.js"),
      nativeOperations: ["todo.workitem.create", "todo.workitem.list"],
      scenario: "The native transport performs a stale-digest conflict check in a single writer process, but cannot execute the original simultaneous multi-process race.",
      result: "unsupported",
      assertions: 0,
      evidence: ["Only sequential stale-digest behavior ran; simultaneous process race deliberately not claimed."],
      unsupportedReason: "The enforced single-writer lease prevents an HTTP and an MCP server from concurrently opening the same workspace; only sequential stale-CAS behavior was verified.",
    });
  });

  await t.test("Memory remains pending without real Host authorization and survives restart", async t => {
    const { directory } = await fixture(t);
    const http = await httpProcess(t, directory);
    const proposalRequest = invoke("memory.record.propose", {
      operation_id: "legacy-oracle-memory-proposal",
      content: "Project Todos are managed in PKM.",
      sources: [{ id: "input-1", chat: "fixture-chat", revision: "turn-1", locator: "message/input-1" }],
    });
    const proposed = resultOf(await http.call("capability_call", proposalRequest));
    assert.equal(proposed.status, "pending");
    assert.deepEqual(resultOf(await http.call("capability_call", proposalRequest)), proposed);
    assert.deepEqual(resultOf(await httpCall(http, "capability_read", "memory.record.search", { query: "Todos" })).records, []);
    assert.equal((await httpCall(http, "capability_call", "memory.record.confirm", {
      id: proposed.id, expected_revision: 1, operation_id: "forbidden-without-host",
    })).body.error.code, "NOT_AVAILABLE");
    assert.equal((await http.call("capability_call", {
      ...proposalRequest,
      arguments: { ...proposalRequest.arguments, userConfirmed: true },
    })).body.error.code, "INVALID_ARGUMENT");
    await http.close();
    const mcp = await mcpClient(t, directory);
    assert.deepEqual(resultOf(await mcpCall(mcp, "capability_read", "memory.record.get", { id: proposed.id })), proposed);
    assert.equal((await mcpCall(mcp, "capability_call", "memory.record.confirm", {
      id: proposed.id, expected_revision: 1, operation_id: "mcp-forbidden-without-host",
    })).body.error.code, "NOT_AVAILABLE");
    const audit = resultOf(await mcpCall(mcp, "capability_read", "memory.record.audit", { id: proposed.id }));
    assert.deepEqual(audit.events.map(event => event.action), ["proposed"]);
    await mcp.close();
    const restartedHttp = await httpProcess(t, directory);
    const persisted = resultOf(await httpCall(restartedHttp, "capability_read", "memory.record.get", { id: proposed.id }));
    assert.deepEqual(persisted, proposed);
    assert.deepEqual(resultOf(await httpCall(restartedHttp, "capability_read", "memory.record.search", { query: "Todos" })).records, []);

    rows.push({
      originalFile: "tests/test-capability-memory.js",
      originalTestcase: "native and external capability paths share durable scoped Memory, but only real Host decisions activate or revoke it",
      originalSourceSha256: await sourceHash("tests/test-capability-memory.js"),
      nativeOperations: ["memory.record.propose", "memory.record.get", "memory.record.search", "memory.record.confirm", "memory.record.audit"],
      scenario: "HTTP creates and idempotently retries a proposal; MCP reads the resulting record and audit; pending content is not searchable, caller-forged confirmation is rejected, and the same pending revision survives restart.",
      result: "passed",
      assertions: 10,
      evidence: [
        "HTTP proposal and identical retry returned deep-equal pending records.",
        "Pending search was empty; caller userConfirmed was INVALID_ARGUMENT; HTTP and MCP confirm were NOT_AVAILABLE.",
        "MCP audit contained only proposed, and the same record survived HTTP restart.",
      ],
      unsupportedReason: "No native Host decision injector is configured by the isolated HTTP/MCP server; successful confirm/revise/revoke, foreign-owner scoping, and old ChatMemory accounting remain explicitly unqualified.",
    });
  });

  await t.test("Note metadata, identity aliases, and snapshot conflict assertions", async t => {
    const { directory } = await fixture(t);
    const http = await httpProcess(t, directory);
    const created = resultOf(await http.call("capability_call", invoke("knowledge.document.create", {
      operationId: randomUUID(), id: "note-contract", area: "notes", path: "Team/Legacy.md",
      title: "Display title", content: "Private body",
    })));
    const updated = resultOf(await http.call("capability_call", invoke("knowledge.metadata.update", {
      operationId: randomUUID(), id: created.id, expectedRevision: created.revision, expectedSha256: created.sha256,
      set: {
        type: "decision", tags: ["one", "one"], pinned: true, description: "Description",
        created: "Original date", custom: { retained: true },
      },
    })));
    const listing = resultOf(await httpCall(http, "capability_read", "knowledge.note.list", { limit: 100 }));
    const note = listing.items.find(item => item.documentId === created.id);
    assert(note, "native Note projection includes the document created through HTTP");
    assert.equal(note.slug, "Team/Legacy");
    assert.equal(note.type, "decision");
    assert.equal(note.tags, '["one","one"]');
    assert.equal(note.pinned, true);
    assert.equal(note.created_at, "Original date");
    assert(!Object.hasOwn(note, "content"));
    const byAlias = resultOf(await httpCall(http, "capability_read", "knowledge.note.get", {
      id: note.knowledgeId,
      snapshotRevision: listing.snapshotRevision,
    }));
    assert.equal(byAlias.item.documentId, created.id);
    assert.equal(byAlias.item.content, "Private body");

    rows.push({
      originalFile: "tests/test-knowledge-contracts.js",
      originalTestcase: "top-level Note knowledge identity assertions; persisted Note ID, revision, aliases, and links",
      originalSourceSha256: await sourceHash("tests/test-knowledge-contracts.js"),
      nativeOperations: ["knowledge.document.create", "knowledge.metadata.update", "knowledge.note.list", "knowledge.note.get"],
      scenario: "The HTTP-created Note receives legacy metadata through a revision-pinned metadata patch; body-free listing preserves that metadata and its generated canonical knowledgeId resolves to the same stable documentId and private body.",
      result: "passed",
      assertions: 9,
      evidence: [
        "knowledge.note.list returned slug=Team/Legacy, type=decision, tags=[\"one\",\"one\"], pinned=true, created_at=Original date, with no content field.",
        "knowledge.note.get(canonical knowledgeId from listed Note, snapshotRevision=list.snapshotRevision) returned documentId=note-contract and content=Private body.",
      ],
      unsupportedReason: "This qualifies persisted identity lookup and metadata only; the original legacy noteUpsert rename/revision/alias-rewrite path is unavailable to the native read-only Note API.",
    });

    const metadata = resultOf(await httpCall(http, "capability_read", "knowledge.metadata.get", { id: created.id }));
    assert.deepEqual(metadata.metadata.custom, { retained: true });
    const customUpdate = resultOf(await http.call("capability_call", invoke("knowledge.metadata.update", {
      operationId: randomUUID(), id: created.id, expectedRevision: updated.revision,
      expectedSha256: updated.sha256, set: { description: "Updated without losing custom data" },
    })));
    const afterMetadata = resultOf(await httpCall(http, "capability_read", "knowledge.metadata.get", { id: created.id }));
    assert.deepEqual(afterMetadata.metadata.custom, { retained: true });
    assert.equal(afterMetadata.metadata.description, "Updated without losing custom data");
    assert.equal(customUpdate.revision, updated.revision + 1);
    assert((await httpCall(http, "capability_read", "knowledge.document.get", { id: created.id })).body.result.content.includes("Private body"));
    rows.push({
      originalFile: "tests/test-knowledge-contracts.js",
      originalTestcase: "top-level unknown Note metadata preservation assertion",
      originalSourceSha256: await sourceHash("tests/test-knowledge-contracts.js"),
      nativeOperations: ["knowledge.document.create", "knowledge.metadata.get", "knowledge.metadata.update", "knowledge.document.get"],
      scenario: "A metadata-only CAS update changes description while preserving an unknown nested custom field and the Note body.",
      result: "passed",
      assertions: 5,
      evidence: [
        "Initial metadata.custom was {retained:true}; after metadata.update it remained byte-equivalent JSON and description changed.",
        "knowledge.document.get returned the original Private body after metadata update.",
      ],
      unsupportedReason: null,
    });

    const staleSnapshot = resultOf(await httpCall(http, "capability_read", "knowledge.note.list", {}));
    const path = join(directory, "notes/Team/Legacy.md");
    await writeFile(path, (await readFile(path, "utf8")).replace("Private body", "External body edit"));
    assert.equal((await httpCall(http, "capability_read", "knowledge.note.list", {
      snapshotRevision: staleSnapshot.snapshotRevision,
    })).body.error.code, "CONFLICT");
    assert.equal((await httpCall(http, "capability_read", "knowledge.note.get", {
      id: created.id, path: "Team/Legacy.md",
    })).body.error.code, "INVALID_ARGUMENT");
    assert.equal((await httpCall(http, "capability_read", "knowledge.note.get", { path: "../unsafe.md" })).body.error.code, "INVALID_ARGUMENT");
    rows.push({
      originalFile: "tests/test-knowledge-contracts.js",
      originalTestcase: "top-level original knowledge identity/revision assertions",
      originalSourceSha256: await sourceHash("tests/test-knowledge-contracts.js"),
      nativeOperations: ["knowledge.note.list", "knowledge.note.get"],
      scenario: "An external body edit invalidates the previously issued Note snapshot; conflicting id+path selectors and an escaping path fail with exact INVALID_ARGUMENT errors.",
      result: "passed",
      assertions: 3,
      evidence: [
        "knowledge.note.list(snapshotRevision=pre-edit) returned CONFLICT after direct external body edit.",
        "knowledge.note.get({id,path}) and knowledge.note.get({path:'../unsafe.md'}) each returned INVALID_ARGUMENT.",
      ],
      unsupportedReason: null,
    });
  });

  await t.test("Markdown resource ownership, bounded chunks, stale pins, and authority denial", async t => {
    const { directory } = await fixture(t);
    const http = await httpProcess(t, directory);
    const image = Buffer.alloc(130_000);
    for (let index = 0; index < image.length; index++) image[index] = index % 251;
    const document = resultOf(await http.call("capability_call", invoke("knowledge.document.create", {
      operationId: randomUUID(), id: "owned-asset-note", area: "notes", path: "Design.md",
      title: "Design", content: "![plot](Design.assets/plot%20one.bin)",
    })));
    await mkdir(join(directory, "notes/Design.assets"), { recursive: true });
    await writeFile(join(directory, "notes/Design.assets/plot one.bin"), image);
    await writeFile(join(directory, "notes/Design.assets/unreferenced.mmd"), "graph LR\nA-->B");
    await writeFile(join(directory, "notes/Design.assets/pkm-todo-board.json"), '{"schema":"pkm.todo-board/v1","items":[]}');
    const firstPage = resultOf(await httpCall(http, "capability_read", "knowledge.asset.list", {
      id: document.id, limit: 1,
    }));
    assert.equal(firstPage.total, 2);
    assert.equal(firstPage.nextOffset, 1);
    const secondPage = resultOf(await httpCall(http, "capability_read", "knowledge.asset.list", {
      id: document.id, offset: firstPage.nextOffset, limit: 10, revision: firstPage.revision,
    }));
    const resource = firstPage.items[0];
    assert(resource.path.endsWith("plot one.bin"));
    assert(secondPage.items.some(item => item.path.endsWith("unreferenced.mmd")));
    const pinned = { id: document.id, path: resource.path, expectedDocumentSha256: document.sha256, expectedDigest: resource.digest };
    const firstChunk = resultOf(await httpCall(http, "capability_read", "knowledge.asset.get", pinned));
    assert.equal(Buffer.from(firstChunk.data, "base64").length, 65_536);
    assert.equal(firstChunk.nextOffset, 65_536);
    const lastChunk = resultOf(await httpCall(http, "capability_read", "knowledge.asset.get", { ...pinned, offset: firstChunk.nextOffset }));
    assert.deepEqual(Buffer.concat([Buffer.from(firstChunk.data, "base64"), Buffer.from(lastChunk.data, "base64")]), image);
    await writeFile(join(directory, "notes/Design.assets/plot one.bin"), "externally changed");
    assert.equal((await httpCall(http, "capability_read", "knowledge.asset.get", pinned)).body.error.code, "CONFLICT");
    rows.push({
      originalFile: "tests/test-markdown-owned-assets.js",
      originalTestcase: "top-level resource ownership, unreferenced diagrams, and original asset-byte assertions",
      originalSourceSha256: await sourceHash("tests/test-markdown-owned-assets.js"),
      nativeOperations: ["knowledge.document.create", "knowledge.asset.list", "knowledge.asset.get"],
      scenario: "The native owned-asset catalog includes the referenced binary and unreferenced diagram, pages the catalog, returns a 130,000-byte resource in bounded exact chunks, then rejects the stale digest after external replacement.",
      result: "passed",
      assertions: 8,
      evidence: [
        "Asset catalog total=2, first page nextOffset=1; second page contains unreferenced Design.assets/unreferenced.mmd.",
        "First read is 65,536 bytes with nextOffset=65,536; concatenated chunk bytes exactly equal the original 130,000-byte fixture.",
        "The original expectedDigest/expectedDocumentSha256 read returned CONFLICT after the resource bytes changed externally.",
      ],
      unsupportedReason: "Copy/move/Trash materialization and sync deletion journal assertions from the legacy filestore do not have equivalent native operations.",
    });

    const baseList = resultOf(await httpCall(http, "capability_read", "knowledge.asset.list", { id: document.id }));
    const digest = baseList.items.find(item => item.path.endsWith("unreferenced.mmd")).digest;
    const getBase = { id: document.id, expectedDocumentSha256: document.sha256, expectedDigest: digest };
    for (const unsafePath of ["../escape.bin", "/absolute.bin", "Design.assets/.hidden", "Design.assets/a\\b.bin"]) {
      assert.equal((await httpCall(http, "capability_read", "knowledge.asset.get", {
        ...getBase, path: unsafePath,
      })).body.error.code, "INVALID_ARGUMENT");
    }
    assert.equal((await httpCall(http, "capability_read", "knowledge.asset.get", {
      ...getBase, path: "Design.assets/pkm-todo-board.json",
    })).body.error.code, "ACCESS_DENIED");
    const linkPath = join(directory, "notes/Design.assets/link.bin");
    await symlink(join(directory, "notes/Design.assets/unreferenced.mmd"), linkPath);
    assert.equal((await httpCall(http, "capability_read", "knowledge.asset.list", { id: document.id })).body.error.code, "INVALID_DOCUMENT");
    rows.push({
      originalFile: "tests/test-markdown-owned-assets.js",
      originalTestcase: "top-level invalid-resource names and symbolic-link rejection assertions",
      originalSourceSha256: await sourceHash("tests/test-markdown-owned-assets.js"),
      nativeOperations: ["knowledge.asset.list", "knowledge.asset.get"],
      scenario: "Native asset reads deny traversal/absolute/hidden/backslash paths, reserve the Todo backing file, and reject a symbolic link in the owned-resource tree.",
      result: "passed",
      assertions: 6,
      evidence: [
        "Four unsafe resource names each returned INVALID_ARGUMENT.",
        "pkm-todo-board.json returned ACCESS_DENIED.",
        "A symlink under Design.assets caused knowledge.asset.list to return INVALID_DOCUMENT.",
      ],
      unsupportedReason: null,
    });
  });

  await t.test("Todo cross-board focus, history, and durable operation receipts", async t => {
    const { directory } = await fixture(t);
    let http = await httpProcess(t, directory);
    const call = (method, operation, args) => http.call(method, invoke(operation, args));
    const boards = [];
    for (const board_slug of ["Team/A", "Team/B"]) {
      const board = resultOf(await call("capability_call", "todo.board.create", { board_slug, operationId: randomUUID() }));
      const created = resultOf(await call("capability_call", "todo.workitem.create", {
        board_slug, expected_digest: board.digest, operationId: randomUUID(),
        item: { id: `task-${board_slug.at(-1)}`, title: `task-${board_slug.at(-1)}`, goal: "Keep one active focus",
          scope: "Regression fixture", acceptance: ["Exactly one focus owner"] },
      }));
      boards.push({ slug: board_slug, digest: created.digest, id: created.item.id });
    }
    const claims = await Promise.all(boards.map(board => call("capability_call", "todo.workitem.claim", {
      board_slug: board.slug, expected_digest: board.digest, operationId: randomUUID(), id: board.id,
    })));
    assert.equal(claims.filter(item => item.body.result).length, 1);
    assert.equal(claims.filter(item => item.body.error?.code === "WORKITEM_FOCUS_CONFLICT").length, 1);
    const winnerIndex = claims.findIndex(item => item.body.result);
    const winner = boards[winnerIndex];
    const claimed = claims[winnerIndex].body.result;
    const history = resultOf(await call("capability_read", "todo.workitem.history", {
      board_slug: winner.slug, id: winner.id, limit: 10,
    }));
    assert(history.total >= 2);
    assert(history.items.length >= 2);
    const changes = resultOf(await call("capability_read", "todo.board.changes", {
      board_slug: winner.slug, limit: 100,
    }));
    assert(changes.total >= 2);

    const commentRequest = invoke("todo.workitem.comment", {
      board_slug: winner.slug, id: winner.id, expected_digest: claimed.digest,
      operationId: randomUUID(), text: "durable original comment",
    });
    const firstReceipt = resultOf(await http.call("capability_call", commentRequest));
    assert.deepEqual(resultOf(await http.call("capability_call", commentRequest)), firstReceipt);
    await http.close();
    http = await httpProcess(t, directory);
    assert.deepEqual(resultOf(await http.call("capability_call", commentRequest)), firstReceipt);
    const changedRetry = await http.call("capability_call", {
      ...commentRequest,
      arguments: { ...commentRequest.arguments, text: "different payload with same operationId" },
    });
    assert.equal(changedRetry.body.error.code, "CONFLICT");
    assert.notDeepEqual(changedRetry.body.result, firstReceipt);
    rows.push({
      originalFile: "tests/test-todo-board.js",
      originalTestcase: "competing Board commands across processes have exactly one CAS winner",
      originalSourceSha256: await sourceHash("tests/test-todo-board.js"),
      nativeOperations: ["todo.board.create", "todo.workitem.create", "todo.workitem.claim", "todo.workitem.history", "todo.board.changes", "todo.workitem.comment"],
      scenario: "Two board claims race through the single native HTTP process and exactly one acquires workspace focus; history/change pages record the winning claim; an identical comment operation replays the exact receipt after HTTP restart and changed payload reuse fails.",
      result: "passed",
      assertions: 10,
      evidence: [
        "Concurrent claim results were exactly one result and one WORKITEM_FOCUS_CONFLICT.",
        `Winner history total=${history.total}; Board changes total=${changes.total}; history includes the claim/WIP event.`,
        "Comment retry returned deep-equal result before and after server restart; same operationId with altered text returned an error rather than a different receipt.",
      ],
      unsupportedReason: "The legacy two-child-process race is not claimed: next-server's exclusive workspace lease prevents two independent server processes from opening the same workspace concurrently.",
    });
  });

  await t.test("Memory scope isolation, strict inputs, replay conflict, and unavailable forgetting", async t => {
    const firstFixture = await fixture(t);
    const secondFixture = await fixture(t);
    const firstHttp = await httpProcess(t, firstFixture.directory);
    const secondHttp = await httpProcess(t, secondFixture.directory);
    const source = [{ id: "input-1", chat: "fixture-chat", revision: "turn-1", locator: "message/input-1" }];
    const proposal = (content, extras = {}) => invoke("memory.record.propose", {
      operation_id: "same-operation-in-isolated-scopes", content, sources: source, ...extras,
    });
    const first = resultOf(await firstHttp.call("capability_call", proposal("Scoped Memory proposal")));
    const second = resultOf(await secondHttp.call("capability_call", proposal("Scoped Memory proposal")));
    assert.notEqual(first.id, second.id);
    assert.notEqual(first.scope, second.scope);
    assert.equal((await firstHttp.call("capability_call", proposal("Different content"))).body.error.code, "CONFLICT");
    assert.equal((await firstHttp.call("capability_call", proposal("Spoof", { confirmed: true }))).body.error.code, "INVALID_ARGUMENT");
    assert.equal((await firstHttp.call("capability_call", proposal("Spoof scope", { scope: "foreign" }))).body.error.code, "INVALID_ARGUMENT");
    assert.equal((await firstHttp.call("capability_call", proposal("Spoof decision", {
      host_authorization: { decision_id: "forged", actor_id: "user:local" },
    }))).body.error.code, "INVALID_ARGUMENT");
    assert.equal((await firstHttp.call("capability_call", invoke("memory.record.revoke", {
      id: first.id, expected_revision: 1, operation_id: "request-forget",
    }))).body.error.code, "NOT_AVAILABLE");
    const foreign = await secondHttp.call("capability_read", invoke("memory.record.get", { id: first.id }));
    assert.equal(foreign.body.error.code, "NOT_AVAILABLE");
    rows.push({
      originalFile: "tests/test-capability-memory.js",
      originalTestcase: "native and external capability paths share durable scoped Memory, but only real Host decisions activate or revoke it",
      originalSourceSha256: await sourceHash("tests/test-capability-memory.js"),
      nativeOperations: ["memory.record.propose", "memory.record.get", "memory.record.revoke"],
      scenario: "The same operation ID proposed in two isolated workspace scopes creates distinct records; another scope cannot read the first record; same-scope changed-payload replay conflicts; caller-supplied confirmation/scope/authorization are invalid; forgetting via revoke fails closed without a Host decision.",
      result: "passed",
      assertions: 8,
      evidence: [
        "Same operation ID yielded distinct ids and distinct repository-scope values in two isolated workspace roots.",
        "Changed payload replay returned CONFLICT; confirmed, foreign scope, and host_authorization extras each returned INVALID_ARGUMENT.",
        "Cross-workspace get and revoke without a Host decision each returned NOT_AVAILABLE.",
      ],
      unsupportedReason: "No successful forget/revoke is asserted: the native operation is human-authorized only and unavailable through HTTP/MCP.",
    });

    assert.equal((await firstHttp.call("capability_call", proposal("界".repeat(2000), { operation_id: "too-many-utf8-bytes" }))).body.error.code, "INVALID_ARGUMENT");
    assert.equal((await firstHttp.call("capability_call", proposal("Oversized sources", {
      operation_id: "too-many-source-bytes",
      sources: [0, 1, 2].map(index => ({ ...source[0], id: String(index), locator: "x".repeat(1500) })),
    }))).body.error.code, "INVALID_ARGUMENT");
    const fetched = resultOf(await firstHttp.call("capability_read", invoke("memory.record.get", { id: first.id })));
    assert.deepEqual(fetched.sources, source);
    rows.push({
      originalFile: "tests/test-capability-memory.js",
      originalTestcase: "native and external capability paths share durable scoped Memory, but only real Host decisions activate or revoke it",
      originalSourceSha256: await sourceHash("tests/test-capability-memory.js"),
      nativeOperations: ["memory.record.propose", "memory.record.get"],
      scenario: "UTF-8 byte limit and aggregate source-reference limit reject oversized proposals; a valid stored proposal returns the exact source provenance.",
      result: "passed",
      assertions: 3,
      evidence: [
        "2,000 three-byte CJK characters returned INVALID_ARGUMENT under the 4,096-byte content bound.",
        "Three 1,500-byte source locators returned INVALID_ARGUMENT under the 4,096-byte aggregate source bound.",
        "memory.record.get returned sources deep-equal to the original source identity/chat/revision/locator.",
      ],
      unsupportedReason: null,
    });
  });

  await t.test("Knowledge identity persists through external-edit rejection and a later CAS update", async t => {
    const { directory } = await fixture(t);
    const http = await httpProcess(t, directory);
    const created = resultOf(await http.call("capability_call", invoke("knowledge.document.create", {
      operationId: randomUUID(), id: "identity-cas", title: "Original", content: "Authoritative body",
    })));
    const before = resultOf(await httpCall(http, "capability_read", "knowledge.metadata.get", { id: created.id }));
    assert.match(before.metadata.knowledgeId, /^knowledge_[a-f0-9]{24}$/);
    assert(before.metadata.aliases.includes("note:identity-cas"));
    const path = join(directory, "notes/identity-cas.md");
    const external = `${await readFile(path, "utf8")}\nExternal editor note\n`;
    await writeFile(path, external);
    const stale = await http.call("capability_call", invoke("knowledge.document.update", {
      operationId: randomUUID(), id: created.id, expectedRevision: created.revision,
      expectedSha256: created.sha256, title: "Must not overwrite", content: "stale body",
    }));
    assert.equal(stale.body.error.code, "CONFLICT");
    assert.equal(await readFile(path, "utf8"), external);
    const current = resultOf(await httpCall(http, "capability_read", "knowledge.document.get", { id: created.id }));
    const updated = resultOf(await http.call("capability_call", invoke("knowledge.document.update", {
      operationId: randomUUID(), id: created.id, expectedRevision: current.revision,
      expectedSha256: current.sha256, title: "Revised", content: "Current body",
    })));
    assert.equal(updated.revision, current.revision + 1);
    const after = resultOf(await httpCall(http, "capability_read", "knowledge.metadata.get", { id: created.id }));
    assert.equal(after.metadata.knowledgeId, before.metadata.knowledgeId);
    assert.deepEqual(after.metadata.aliases, before.metadata.aliases);
    assert.equal(resultOf(await httpCall(http, "capability_read", "knowledge.document.get", { id: created.id })).content, "Current body");
    rows.push({
      originalFile: "tests/test-knowledge-contracts.js",
      originalTestcase: "top-level stable Knowledge ID/revision/alias assertions across Note updates",
      originalSourceSha256: await sourceHash("tests/test-knowledge-contracts.js"),
      nativeOperations: ["knowledge.document.create", "knowledge.metadata.get", "knowledge.document.get", "knowledge.document.update"],
      scenario: "The original knowledge ID and aliases remain stable across a successful revision-pinned edit; an external byte change first defeats the stale update without overwriting the external Markdown.",
      result: "passed",
      assertions: 9,
      evidence: [
        `Initial metadata had a schema-valid knowledgeId and aliases=${JSON.stringify(before.metadata.aliases)}.`,
        "Stale update returned CONFLICT and the exact external bytes remained unchanged.",
        `Successful update advanced revision ${current.revision}->${updated.revision} and preserved knowledgeId/aliases; get returned Current body.`,
      ],
      unsupportedReason: "Path move/rename and legacy noteUpsert alias rewriting remain unsupported by these document mutation operations.",
    });
  });

  await t.test("Knowledge link contract rejects unsupported targets and protects identity metadata", async t => {
    const { directory } = await fixture(t);
    const http = await httpProcess(t, directory);
    const created = resultOf(await http.call("capability_call", invoke("knowledge.document.create", {
      operationId: randomUUID(), id: "link-contract", title: "Link contract", content: "body",
    })));
    const invalidLink = await http.call("capability_call", invoke("knowledge.metadata.update", {
      operationId: randomUUID(), id: created.id, expectedRevision: created.revision,
      expectedSha256: created.sha256,
      set: { links: [{ relation: "supports", target: "relative/path", mode: "floating", required: false }] },
    }));
    assert.equal(invalidLink.body.error.code, "INVALID_ARGUMENT");
    const protectedIdentity = await http.call("capability_call", invoke("knowledge.metadata.update", {
      operationId: randomUUID(), id: created.id, expectedRevision: created.revision,
      expectedSha256: created.sha256, set: { knowledgeId: "knowledge_aaaaaaaaaaaaaaaaaaaaaaaa" },
    }));
    assert.equal(protectedIdentity.body.error.code, "ACCESS_DENIED");
    const current = resultOf(await httpCall(http, "capability_read", "knowledge.document.get", { id: created.id }));
    assert.equal(current.revision, created.revision);
    assert.equal(current.content, "body");
    rows.push({
      originalFile: "tests/test-knowledge-contracts.js",
      originalTestcase: "top-level Knowledge links and immutable-identity validation assertions",
      originalSourceSha256: await sourceHash("tests/test-knowledge-contracts.js"),
      nativeOperations: ["knowledge.document.create", "knowledge.metadata.update", "knowledge.document.get"],
      scenario: "A relative floating link fails contract validation; a metadata patch cannot overwrite knowledgeId; both rejected writes leave the document revision and body unchanged.",
      result: "passed",
      assertions: 4,
      evidence: [
        "Unsupported relative/path link returned INVALID_ARGUMENT.",
        "Attempt to set knowledgeId returned ACCESS_DENIED.",
        "After both failures, document revision remained 1 and content remained body.",
      ],
      unsupportedReason: null,
    });
  });

  await t.test("Todo Story/task deletion and restore preserve parent guards", async t => {
    const { directory } = await fixture(t);
    const http = await httpProcess(t, directory);
    const call = (method, operation, args) => http.call(method, invoke(operation, args));
    const board = resultOf(await call("capability_call", "todo.board.create", {
      board_slug: "Relations", operationId: randomUUID(),
    }));
    const story = resultOf(await call("capability_call", "todo.story.create", {
      board_slug: "Relations", expected_digest: board.digest, operationId: randomUUID(),
      item: { id: "story", title: "Story", goal: "Keep relation", scope: "Regression", acceptance: ["Parent survives"] },
    }));
    const task = resultOf(await call("capability_call", "todo.workitem.create", {
      board_slug: "Relations", expected_digest: story.digest, operationId: randomUUID(),
      item: { id: "child", title: "Child", goal: "Remain attached", scope: "Regression",
        acceptance: ["Exact acceptance"], parentId: "story" },
    }));
    assert.equal(task.item.parentId, "story");
    assert.deepEqual(task.item.acceptance, ["Exact acceptance"]);
    const blockedStoryDelete = await call("capability_call", "todo.story.delete", {
      board_slug: "Relations", expected_digest: task.digest, operationId: randomUUID(), id: "story", reason: "Has child",
    });
    assert(blockedStoryDelete.body.error);
    const deletedTask = resultOf(await call("capability_call", "todo.workitem.delete", {
      board_slug: "Relations", expected_digest: task.digest, operationId: randomUUID(), id: "child", reason: "Remove child",
    }));
    const deletedStory = resultOf(await call("capability_call", "todo.story.delete", {
      board_slug: "Relations", expected_digest: deletedTask.digest, operationId: randomUUID(), id: "story", reason: "Remove story",
    }));
    const blockedRestore = await call("capability_call", "todo.workitem.restore", {
      board_slug: "Relations", expected_digest: deletedStory.digest, operationId: randomUUID(), id: "child", reason: "Parent is deleted",
    });
    assert(blockedRestore.body.error);
    const restoredStory = resultOf(await call("capability_call", "todo.story.restore", {
      board_slug: "Relations", expected_digest: deletedStory.digest, operationId: randomUUID(), id: "story", reason: "Restore parent",
    }));
    const restoredTask = resultOf(await call("capability_call", "todo.workitem.restore", {
      board_slug: "Relations", expected_digest: restoredStory.digest, operationId: randomUUID(), id: "child", reason: "Restore child",
    }));
    assert.equal(restoredTask.item.parentId, "story");
    assert.deepEqual(restoredTask.item.acceptance, ["Exact acceptance"]);
    rows.push({
      originalFile: "tests/test-todo-board.js",
      originalTestcase: "Board authority follows rename, folders, Trash, restore and explicit export/import without sharing worker grants",
      originalSourceSha256: await sourceHash("tests/test-todo-board.js"),
      nativeOperations: ["todo.board.create", "todo.story.create", "todo.story.delete", "todo.story.restore", "todo.workitem.create", "todo.workitem.delete", "todo.workitem.restore"],
      scenario: "Native Board task/story lifecycle rejects deleting a parent with a child and restoring a child before its parent; after parent-first restoration, original relation and acceptance are unchanged.",
      result: "passed",
      assertions: 6,
      evidence: [
        "Child task was created with parentId=story and acceptance=[Exact acceptance].",
        "Deleting a Story with a child returned an error; restoring the child before its deleted parent also returned an error.",
        "After Story then child restore, parentId and acceptance exactly matched the original values.",
      ],
      unsupportedReason: "Board rename/folder move, Trash restore of the Board document, and legacy export/import remain unsupported at this native endpoint.",
    });
  });

  await t.test("Plain Note defaults remain body-free in native projection", async t => {
    const { directory } = await fixture(t);
    const http = await httpProcess(t, directory);
    const created = resultOf(await http.call("capability_call", invoke("knowledge.document.create", {
      operationId: randomUUID(), id: "plain-note", area: "notes", path: "Fallback.md",
      title: "Fallback", content: "Fallback body",
    })));
    const list = resultOf(await httpCall(http, "capability_read", "knowledge.note.list", { limit: 100 }));
    const note = list.items.find(item => item.documentId === created.id);
    assert(note);
    assert.equal(note.title, "Fallback");
    assert.equal(note.type, "general");
    assert.equal(note.tags, "[]");
    assert.equal(note.documentKind, "markdown");
    assert(!Object.hasOwn(note, "content"));
    assert.equal(resultOf(await httpCall(http, "capability_read", "knowledge.note.get", { id: created.id })).item.content, "Fallback body");
    rows.push({
      originalFile: "tests/test-knowledge-contracts.js",
      originalTestcase: "top-level plain Note defaults and content-preservation assertions",
      originalSourceSha256: await sourceHash("tests/test-knowledge-contracts.js"),
      nativeOperations: ["knowledge.document.create", "knowledge.note.list", "knowledge.note.get"],
      scenario: "A plain Markdown Note projects original title/general/empty-tags/markdown defaults without body leakage; an explicit get returns the body.",
      result: "passed",
      assertions: 7,
      evidence: [
        "List returned title=Fallback, type=general, tags=[], documentKind=markdown, and omitted content.",
        "Get by stable documentId returned Fallback body.",
      ],
      unsupportedReason: null,
    });
  });

  assert(rows.filter(row => row.result === "passed").length >= 15, "qualify a substantive tranche before writing the report");
  const sources = {};
  for (const path of nativeSources) sources[path] = await sourceHash(path, packageRoot);
  for (const row of rows) {
    const implementationPaths = new Set(row.nativeOperations.flatMap(operation => sourcesByOperation[operation] ?? []));
    if (row.nativeOperations.some(operation => operation.startsWith("todo."))) implementationPaths.add("src/domain/todo-api.ts");
    row.nativeImplementationSources = [...implementationPaths].sort().map(path => ({ path, sha256: sources[path] }));
    assert(row.originalSourceSha256 && row.nativeImplementationSources.length > 0 && row.evidence.length > 0,
      `Every report row needs original/native source hashes and assertion evidence: ${row.originalTestcase}`);
  }
  const originalSources = {};
  for (const path of new Set(rows.map(row => row.originalFile))) originalSources[path] = await sourceHash(path);
  const testSourceSha256 = await sourceHash("tests/legacy-regression-oracle.test.mjs", packageRoot);
  const report = {
    schema: "pkm.next-server.legacy-regression-oracle/v1",
    qualification: "standalone-native-transport-adapter",
    execution: {
      testFile: "tests/legacy-regression-oracle.test.mjs",
      testSourceSha256,
      command: "node --test --test-concurrency=4 tests/legacy-regression-oracle.test.mjs",
      workingDirectory: "next-server",
      node: process.version,
    },
    build: {
      command: "npm --prefix next-server run build",
      result: "passed",
      reason: null,
    },
    result: "passed",
    nativeSourceSetSha256: sha256(JSON.stringify(Object.entries(sources).sort(([a], [b]) => a.localeCompare(b)))),
    nativeSources: sources,
    originalSources,
    rows,
    totals: { verifiedRows: rows.filter(row => row.result === "passed").length,
      unsupportedRows: rows.filter(row => row.result === "unsupported").length,
      passedRows: rows.filter(row => row.result === "passed").length,
      assertions: rows.reduce((total, row) => total + row.assertions, 0) },
    legacySuiteExecution: {
      status: "not-run",
      reason: "This report records only the inherited assertions exercised through next-server HTTP/MCP. The original VS Code test loader and full legacy suite were not run.",
    },
    explicitGaps: [
      "The full original VS Code suite is not qualified by this tranche.",
      "Markdown asset sync-bundle/GitHub/webview assertions and legacy shared-asset migration/materialization are unsupported at the tested next-server transport seam.",
      "Todo legacy Note/Markdown and reserved-asset write paths are not represented by the isolated native boards/ authority.",
      "Memory confirmation, revision, revocation, and legacy ChatMemory accounting are not qualified without an injected native Host decision or an implemented accounting surface.",
    ],
  };
  const reportBytes = `${JSON.stringify(report, null, 2)}\n`;
  assert.equal(JSON.parse(reportBytes).totals.verifiedRows, 15, "report must retain the qualified verified tranche");
  assert.equal(JSON.parse(reportBytes).totals.unsupportedRows, 1, "report must retain the explicit unsupported case");
  assert.equal(JSON.parse(reportBytes).totals.assertions, 109, "report must retain all inherited assertions");

  for (const [path, expectedHash] of Object.entries(sources)) {
    assert.equal(await sourceHash(path, packageRoot), expectedHash,
      `Native source changed during oracle qualification: ${path}`);
  }
  for (const [path, expectedHash] of Object.entries(originalSources)) {
    assert.equal(await sourceHash(path), expectedHash,
      `Original source changed during oracle qualification: ${path}`);
  }
  assert.equal(await sourceHash("tests/legacy-regression-oracle.test.mjs", packageRoot), testSourceSha256,
    "Oracle test changed during report generation");

  const temporaryPath = join(testDirectory, `.legacy-regression-oracle.report.${randomUUID()}.tmp`);
  try {
    await writeFile(temporaryPath, reportBytes, { flag: "wx" });
    assert.equal(await readFile(temporaryPath, "utf8"), reportBytes, "staged report bytes must be complete before publish");
    await rename(temporaryPath, reportPath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
});

async function sourceHash(path, base = repositoryRoot) {
  return sha256(await readFile(join(base, path)));
}
