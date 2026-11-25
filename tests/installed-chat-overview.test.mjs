import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { test } from "node:test";
import { createOverviewModel } from "./installed-chat-overview.mjs";

test("installed overview fixture routes only its marked turns and holds concurrent inference until explicit fixture release", async () => {
  const base = join(".pkm-test-evidence", `overview-provider-${randomUUID()}`);
  await mkdir(base, { recursive:true, mode:0o700 });
  const model = createOverviewModel({ base });
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const input = JSON.parse(Buffer.concat(chunks).toString());
    if (!await model.handle(request, response, input)) { response.writeHead(404); response.end("baseline route"); }
  });
  await new Promise(done => server.listen(0, "127.0.0.1", done));
  const url = `http://127.0.0.1:${server.address().port}/v1/chat/completions`;
  const invoke = (marker, results = []) => fetch(url, { method:"POST",
    headers:{ authorization:"Bearer isolated-installed-provider", "content-type":"application/json" },
    body:JSON.stringify({ messages:[{ role:"user", content:marker }, ...results.map(content => ({ role:"tool", content }))],
      tools:["replace_text", "find_vscode_tools", "invoke_vscode_tool"].map(name => ({ function:{ name } })) }) });
  const delta = body => JSON.parse(body.split("\n").find(line => line.startsWith("data: ")).slice(6)).choices[0].delta;
  try {
    assert.equal((await invoke("BASELINE_MARKER")).status, 404);
    const first = await invoke("OVERVIEW_APPROVAL_A: inspect only");
    const edit = delta(await first.text()).tool_calls[0];
    assert.equal(edit.function.name, "replace_text");
    assert.deepEqual(JSON.parse(edit.function.arguments),
      { path:"overview-approval.txt", oldText:"OVERVIEW_APPROVAL_PENDING", newText:"OVERVIEW_APPROVAL_RESOLVED" });
    const edited = '{"applied":true,"saved":false}';
    const second = await invoke("OVERVIEW_APPROVAL_A: inspect only", [edited]);
    const discovery = delta(await second.text()).tool_calls[0];
    assert.equal(discovery.function.name, "find_vscode_tools");
    const third = await invoke("OVERVIEW_APPROVAL_A: inspect only", [edited, "discovered"]);
    const read = delta(await third.text()).tool_calls[0];
    assert.deepEqual(JSON.parse(read.function.arguments),
      { name:"mcp_pkm_get_note", input:{ slug:"InstalledGatewayNote" } });
    const completed = await invoke("OVERVIEW_APPROVAL_A: inspect only",
      [edited, "discovered", "Created by installed PKM Chat through the selected v5 gateway."]);
    assert.equal(delta(await completed.text()).content, "OVERVIEW_A_COMPLETED");
    const running = await invoke("OVERVIEW_RUNNING_B: remain pending");
    const before = JSON.parse(await readFile(join(base, "overview-model-evidence.json"), "utf8"));
    assert.deepEqual(before.pending, ["OVERVIEW_RUNNING_B"]);
    assert.equal(before.requests.length, 5);
    await writeFile(join(base, "overview-release-running.json"), '{"release":true}');
    assert.match(await running.text(), /OVERVIEW_B_COMPLETED/);
    assert.equal((await invoke("OVERVIEW_FAIL: explicit failure")).status, 401);
    const evidence = await model.flush();
    assert.equal(evidence.requests.length, 6);
    assert.deepEqual(evidence.pending, []);
    assert.deepEqual(evidence.failures, []);
  } finally {
    server.closeAllConnections();
    await new Promise(done => server.close(done));
    await model.flush();
    await rm(base, { recursive:true, force:true });
  }
});
