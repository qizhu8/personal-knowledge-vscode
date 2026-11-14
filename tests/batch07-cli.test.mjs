import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";
import test from "node:test";
import { cliFixture, invocation, until } from "./batch07-cli-fixtures.mjs";
import { chatTurnInput } from "./chat-turn-fixtures.mjs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const turn = message => chatTurnInput({ messages: [{ role: "user", content: message }], deadlineMs: 15000 });
const readTurn = (child, input) => child.rpc("capability_read", invocation("chat.turn.get", { id: input.id })).then(value => value.body.result);
async function queue(child) {
  const before = child.diagnostics.length;
  child.send({ action: "read" });
  const result = await until(() => child.diagnostics.slice(before).find(value => value.humanReview));
  return result.humanReview.entries;
}
const pending = child => until(() => queue(child), values => values?.length === 1).then(values => values[0]);
const pin = (entry, decision) => ({ id: entry.id, expectedRevision: entry.revision, intentDigest: entry.intentDigest, decision });
const terminal = (child, input) => until(() => readTurn(child, input), value =>
  value && ["completed", "failed", "cancelled", "unknown"].includes(value.status));
const execute = promisify(execFile);

test("actual CLI remains deny-by-default without explicit configured host authority", { timeout: 20000 }, async t => {
  const f = await cliFixture(t), child = await f.launch([], false);
  const info = (await child.rpc("server_info", {})).body.result;
  assert.equal(info.serverId, "pkm-next");
  assert.equal(info.workspaceId, f.identity.id);
  assert.equal(info.actorId, "local:owner");
  assert.equal(info.protocolVersion, "v1");
  const result = await child.rpc("capability_call", invocation("chat.turn.start", turn("default")));
  assert.ok(result.status !== 200 || result.body.error, JSON.stringify(result));
  assert.equal(f.requests.length, 0);
  assert.notEqual((await fetch(child.url + "/human-review/read", { method: "POST",
    headers: { authorization: `Bearer ${f.token}`, "content-type": "application/json" }, body: "{}" })).status, 200);
});

test("actual machine MCP CLI cannot discover or submit native human decisions", { timeout: 20000 }, async t => {
  const f = await cliFixture(t);
  const client = new Client({ name: "synthetic-machine-qualification", version: "1" });
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [resolve(import.meta.dirname, "../dist/cli.js"), "mcp", "--data", f.workspace],
    env: { ...process.env, TMPDIR: f.root }, stderr: "pipe" });
  t.after(async () => { await client.close(); await transport.close(); });
  await client.connect(transport);
  const tools = await client.listTools();
  assert.ok(!tools.tools.some(tool => /human|approve|decide/i.test(tool.name)));
  for (const operation of ["human.review.decide", "execution.approve", "approval.decide"]) {
    const response = await client.callTool({ name: "capability_call", arguments: invocation(operation,
      { id: "synthetic", decision: "approve", trustedUserButton: true }) });
    const result = JSON.parse(response.content.find(item => item.type === "text").text);
    assert.ok(result.error, operation);
  }
  assert.equal(f.requests.length, 0);
});

test("actual CLI backup refuses a live workspace owner and publishes a real quiescent SQLite snapshot after shutdown", { timeout: 20000 }, async t => {
  const f = await cliFixture(t), child = await f.launch([], false);
  const destination = resolve(f.root, "cli-backup");
  const args = [resolve(import.meta.dirname, "../dist/cli.js"), "backup", "--data", f.workspace, "--destination", destination];
  const options = { env: { ...process.env, TMPDIR: f.root }, timeout: 10000 };
  await assert.rejects(execute(process.execPath, args, options));
  await child.stop();
  const output = await execute(process.execPath, args, options);
  const result = JSON.parse(output.stdout).backup;
  assert.equal(result.workspaceId, f.identity.id);
  assert.ok((await readFile(resolve(destination, "core.sqlite"))).length > 10000);
  await assert.rejects(readFile(resolve(destination, "core.sqlite-wal")), { code: "ENOENT" });
});

test("spawned configured CLI socket SSE uses native terminal exact approval/reject/cancel and fences stale/restart", { timeout: 75000 }, async t => {
  const f = await cliFixture(t), child = await f.launch(["--human-review", "terminal"]);
  for (const decision of ["approve", "reject", "cancel"]) {
    const input = turn(decision);
    assert.equal((await child.rpc("capability_call", invocation("chat.turn.start", input))).status, 200);
    const entry = await pending(child);
    assert.equal(entry.actorId, "local:owner");
    assert.equal(entry.workspaceId, f.identity.id);
    assert.equal(entry.intent.request.record.tool, "knowledge.document.create");
    assert.match(entry.intent.request.record.arguments.title, /<img/);
    const before = child.diagnostics.length;
    child.send({ action: "decide", input: { ...pin(entry, decision), intentDigest: "0".repeat(64) } });
    await until(() => child.diagnostics.length > before);
    assert.equal((await queue(child)).length, 1, "stale pin cannot consume or approve intent");
    child.send({ action: "decide", input: pin(entry, decision) });
    const result = await terminal(child, input);
    const document = await child.rpc("capability_read", invocation("knowledge.document.get", { id: `document-${decision}` }));
    if (decision === "approve") {
      assert.equal(result.status, "completed");
      assert.equal(result.output, "Local socket answer.");
      assert.equal(document.body.result.content, "Local socket content approve.");
    } else assert.ok(document.body.error || document.status !== 200, "no rejected/cancelled effect");
    const replay = child.diagnostics.length;
    child.send({ action: "decide", input: pin(entry, "approve") });
    await until(() => child.diagnostics.length > replay);
    assert.deepEqual(await queue(child), []);
  }
  const redirected = turn("redirect");
  assert.equal((await child.rpc("capability_call", invocation("chat.turn.start", redirected))).status, 200);
  assert.notEqual((await terminal(child, redirected)).status, "completed");
  assert.equal(f.requests.filter(value => value.messages[0]?.content === "redirect").length <= 1, true);
  const interrupted = turn("hold");
  assert.equal((await child.rpc("capability_call", invocation("chat.turn.start", interrupted))).status, 200);
  await until(() => f.requests.some(value => value.messages.find(message => message.role === "user")?.content === "hold"));
  child.process.kill("SIGKILL");
  await child.closed;
  await assert.rejects(f.launch(["--human-review", "terminal"]), /startup failed/);
  await new Promise(resolve => setTimeout(resolve, 30100));
  const beforeRestart = f.requests.length;
  const restarted = await f.launch(["--human-review", "terminal"]);
  const recovered = await readTurn(restarted, interrupted);
  assert.equal(recovered.status, "unknown");
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(f.requests.length, beforeRestart, "unknown provider outcome never automatically replays");
  await restarted.stop();
  const database = new DatabaseSync(resolve(f.workspace, "core.sqlite"), { readOnly: true });
  try {
    for (const { name } of database.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()) {
      const rows = database.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all();
      const serialized = JSON.stringify(rows, (_, value) => typeof value === "bigint" ? String(value) : value);
      for (const secret of [f.providerSecret, f.token, f.config.secretRef, f.endpoint]) assert.equal(serialized.includes(secret), false, name);
    }
  } finally { database.close(); }
  for (const secret of [f.providerSecret, f.token, f.config.secretRef, f.endpoint])
    assert.equal(JSON.stringify([...child.lines, ...child.diagnostics]).includes(secret), false, "public/readiness/native diagnostics redacted");
  assert.ok((await readFile(resolve(f.workspace, "core.sqlite"))).length);
});
