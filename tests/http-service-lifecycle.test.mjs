import assert from "node:assert/strict";
import test from "node:test";
import { startHttp } from "../dist/http.js";
import { CoreError } from "../dist/contracts.js";

const token = "http-business-token".repeat(4);
const actor = { id: "local:owner", canWrite: true };
const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

test("Core HTTP identity is authenticated and transport quiescence waits admitted dispatch without admitting a replacement", async t => {
  let release, admitted;
  const entered = new Promise(ready => { admitted = ready; });
  const pending = new Promise(ready => { release = ready; });
  const core = { async dispatch(method) {
    if (method === "server_info") return { result: { workspaceId: "independent-workspace", actorId: actor.id } };
    admitted(); await pending; return { result: { committed: true } };
  } };
  const transport = await startHttp(core, token, actor);
  t.after(() => new Promise(ready => transport.server.close(ready)));
  assert.equal((await fetch(`${transport.url}/service/status`)).status, 401);
  const identity = await (await fetch(`${transport.url}/service/status`, { headers })).json();
  assert.equal(identity.identity.result.workspaceId, "independent-workspace");
  assert.equal(identity.service.protocols.coreHttp, true);
  const first = fetch(`${transport.url}/v1/capability_call`, { method: "POST", headers, body: "{}" });
  await entered;
  let drained = false;
  const drain = transport.quiesce().then(value => { drained = true; return value; });
  assert.equal(drained, false);
  const refused = await fetch(`${transport.url}/v1/capability_call`, { method: "POST", headers, body: "{}" });
  assert.equal(refused.status, 503);
  assert.equal((await refused.json()).error.effect, "not-committed");
  release();
  assert.equal((await first).status, 200);
  assert.equal((await drain).phase, "transport-drained", "Dispatch drain must not claim background Chat/owner drain.");
});

test("post-dispatch failures preserve unknown effect and never become safe-to-replay responses", async t => {
  let count = 0;
  const core = { async dispatch() {
    count++;
    throw new CoreError("STORAGE_ERROR", "Committed outcome could not be observed.", "unknown");
  } };
  const transport = await startHttp(core, token, actor);
  t.after(() => new Promise(ready => transport.server.close(ready)));
  const response = await fetch(`${transport.url}/v1/capability_call`, { method: "POST", headers, body: "{}" });
  assert.equal(response.status, 500);
  assert.equal((await response.json()).error.effect, "unknown");
  assert.equal(count, 1);
});
