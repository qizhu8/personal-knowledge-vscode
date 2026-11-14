import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm, chmod } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { initialize } from "../dist/storage.js";
import { legacyManagedFixture, closeLegacyManagedFixture } from "./legacy-managed-fixture.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("opt-in legacy MCP diagnostics persist and page actual calls across authorized restarts", { timeout: 60000 }, async t => {
  const parent = join(root, `.diagnostics-test-${randomUUID()}`);
  await mkdir(parent, { mode: 0o700 });
  let client;
  t.after(async () => { try { await client?.close(); } finally { await rm(parent, { recursive: true, force: true }); } });
  const data = await initialize(join(parent, "workspace"));
  const managed = await legacyManagedFixture(parent);
  const logs = join(parent, "diagnostics");
  await mkdir(logs, { mode: 0o700 });
  const connect = async (enable = true, profile = "legacy", history = false) => {
    const connection = new Client({ name: "diagnostics-test", version: "1" });
    await connection.connect(new StdioClientTransport({
      command: "python3",
      args: [join(root, "compat/legacy-compact-mcp.py"), "--data", data, "--node", process.execPath,
        "--managed-generation", managed,
        ...(enable ? ["--diagnostics-directory", logs] : []), ...(history ? ["--diagnostics-history"] : [])],
      env: { ...process.env, PKM_CAPABILITY_PROFILE: profile, PYTHONDONTWRITEBYTECODE: "1" }, stderr: "pipe",
    }));
    return connection;
  };
  const call = (name, args = {}) => client.callTool({ name, arguments: args });
  client = await connect(false);
  assert(!(await client.listTools()).tools.some(tool => tool.name === "diagnostics_latest"));
  await closeLegacyManagedFixture(client);
  client = await connect();
  assert((await client.listTools()).tools.some(tool => tool.name === "diagnostics_latest"));
  assert(!(await client.listTools()).tools.some(tool => tool.name === "diagnostics_history_page"));
  assert.equal((await call("list_notes", { directory: "private-sensitive-input" })).isError, true);
  assert.notEqual((await call("list_notes")).isError, true);
  const latest = (await call("diagnostics_latest", { limit: 100 })).structuredContent;
  assert(latest.records.some(row => row.event === "runtime.started"));
  assert(latest.records.some(row => row.tool === "list_notes" && row.event === "mcp.call.started"));
  assert(!JSON.stringify(latest).includes("private-sensitive-input"));
  assert.equal((await call("diagnostics_history_page", { writer_id: latest.writer_id })).isError, true);
  assert.equal((await call("capability_read", { operation: "mcp.tool.diagnostics_history_page", version: 1,
    arguments: { writer_id: latest.writer_id } })).isError, true);
  assert.equal((await call("diagnostics_latest", { limit: 1001 })).isError, true);
  const first = (await call("diagnostics_page", { limit: 2 })).structuredContent;
  assert.equal(first.records.length, 2);
  assert(first.next_cursor);
  const seen = [...first.records];
  let cursor = first.next_cursor;
  while (cursor) {
    const result = await call("diagnostics_page", { limit: 2, cursor });
    assert.notEqual(result.isError, true);
    seen.push(...result.structuredContent.records);
    cursor = result.structuredContent.next_cursor;
  }
  assert.equal(seen.at(-1).event, "runtime.started");
  assert.equal(seen.filter(row => row.tool === "diagnostics_page").length, 1);
  const writer = latest.writer_id;
  const paths = (await readdir(logs)).filter(name => name.startsWith(`${writer}.`));
  assert(paths.length > 0);
  await closeLegacyManagedFixture(client);
  const file = await readFile(join(logs, paths[0]), "utf8");
  assert(file.includes('"mcp.call.started"'));
  assert(!file.includes("private-sensitive-input"));
  client = await connect(true, "compact", true);
  const args = { operation: "mcp.tool.diagnostics_latest", version: 1, arguments: {} };
  const restarted = (await call("capability_read", args)).structuredContent;
  assert.notEqual(restarted.writer_id, writer);
  assert(restarted.records.every(row => row.writerId === restarted.writer_id));
  assert.equal((await call("capability_read", { operation: "mcp.tool.diagnostics_page", version: 1,
    arguments: { cursor: first.next_cursor } })).isError, true);
  assert.equal((await call("capability_read", { ...args, worker_token: "fake" })).isError, true);
  assert.equal(await readFile(join(logs, paths[0]), "utf8"), file);
  const read = async (operation, arguments_) => {
    const result = await call("capability_read", { operation: `mcp.tool.${operation}`, version: 1, arguments: arguments_ });
    assert.notEqual(result.isError, true, JSON.stringify(result));
    return result.structuredContent;
  };
  const inventory = await read("diagnostics_writers", { limit: 1 });
  assert.equal(inventory.writer_ids.length, 1);
  assert(inventory.next_offset);
  const inventory2 = await read("diagnostics_writers", { offset: inventory.next_offset, limit: 1, revision: inventory.revision });
  assert([...inventory.writer_ids, ...inventory2.writer_ids].includes(writer));
  assert.equal((await call("capability_read", { operation: "mcp.tool.diagnostics_writers", version: 1,
    arguments: { offset: 1, revision: "wrong" } })).isError, true);
  const historical = await read("diagnostics_history_page", { writer_id: writer, limit: 2 });
  assert.equal(historical.records.length, 2);
  const historyCursor = historical.next_cursor;
  assert(historyCursor);
  await closeLegacyManagedFixture(client);
  client = await connect(true, "compact", true);
  const remainder = [];
  cursor = historyCursor;
  while (cursor) {
    const result = await read("diagnostics_history_page", { writer_id: writer, limit: 2, cursor });
    remainder.push(...result.records);
    cursor = result.next_cursor;
  }
  const all = [...historical.records, ...remainder];
  assert.equal(all.at(-1).event, "runtime.started");
  assert(all.some(row => row.tool === "list_notes" && row.event === "mcp.call.returned"));
  assert(!JSON.stringify(all).includes("private-sensitive-input"));
  assert.equal((await call("capability_read", { operation: "mcp.tool.diagnostics_history_page", version: 1,
    arguments: { writer_id: restarted.writer_id, cursor: historyCursor } })).isError, true);
  assert.equal(await readFile(join(logs, paths[0]), "utf8"), file);
  await closeLegacyManagedFixture(client);
  client = undefined;
  await chmod(logs, 0o755);
  if (process.platform !== "win32") await assert.rejects(connect());
});
