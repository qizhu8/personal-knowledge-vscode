import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { isolatedEnvironment, startLiveRuntime } from "./live-runtime.mjs";

test("live launcher environment has no inherited private provider or server credentials", () => {
  const environment = isolatedEnvironment("/synthetic/home");
  assert.equal(environment.HOME, "/synthetic/home");
  assert.equal(environment.TMPDIR, "/synthetic/home");
  assert.equal(environment.HTTP_PROXY, "http://127.0.0.1:1");
  assert.equal(environment.NO_PROXY, "127.0.0.1");
  assert.equal(environment.PKM_NEXT_TOKEN, undefined);
  assert.equal(environment.OPENAI_API_KEY, undefined);
  assert.equal(environment.GITHUB_TOKEN, undefined);
  assert.equal(environment.NODE_OPTIONS, undefined);
});

test("actual CLI creates a fresh synthetic identity, authenticates read-only HTTP and cleans up", async () => {
  const runtime = await startLiveRuntime();
  try {
    const identity = JSON.parse(await readFile(`${runtime.workspace}/.pkm-next-workspace`, "utf8"));
    assert.equal(identity.id, runtime.workspaceId);
    const request = token => fetch(`${runtime.origin}/v1/server_info`, {
      method: "POST", redirect: "error",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: "{}",
    });
    const authenticated = await request(runtime.token);
    assert.equal(authenticated.status, 200);
    const info = await authenticated.json();
    assert.equal(info.result.serverId, "pkm-v5");
    assert.equal(info.result.workspaceId, identity.id);
    assert.equal(info.result.actorId, "local:reader");
    const denied = await request("synthetic-denied-token".padEnd(64, "x"));
    assert.equal(denied.status, 401);
    await denied.arrayBuffer();
  } finally {
    await runtime.close();
  }
  assert.equal(existsSync(runtime.root), false);
  await assert.rejects(fetch(`${runtime.origin}/v1/server_info`, { method: "POST", body: "{}", redirect: "error" }));
});
