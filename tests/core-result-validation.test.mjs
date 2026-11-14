import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Core } from "../dist/core.js";
import { resultEnvelope } from "../dist/contracts.js";

const owner = { id: "local:owner", canWrite: true };
const reader = { id: "local:reader", canWrite: false };
const invoke = (operation, args) => ({ operation, version: 1, arguments: args });

test("Core rejects results that cannot fit its object envelope without changing effects or authority", async () => {
  let value;
  let calls = 0;
  const core = new Core({}, {
    nativeRuntime: {
      available: () => true,
      dispatch: async () => { calls++; return value; },
    },
  });
  const read = invoke("manager.runtime.get", { runId: "run-1" });
  const write = invoke("manager.runtime.cancel", { runId: "run-1", expectedVersion: 1, operationId: randomUUID() });
  for (const invalid of [null, true, 7, "text", ["item"]]) {
    value = invalid;
    for (const [method, request, effect] of [
      ["capability_read", read, "not-committed"],
      ["capability_call", write, "unknown"],
    ]) {
      const response = await core.dispatch(method, request, owner);
      assert.equal(response.error?.code, "INVALID_RESULT");
      assert.equal(response.error.effect, effect);
      assert(resultEnvelope.safeParse(response).success);
    }
  }
  const before = calls;
  assert.equal((await core.dispatch("capability_call", write, reader)).error.code, "ACCESS_DENIED");
  assert.equal((await core.dispatch("capability_read", write, owner)).error.code, "ACCESS_DENIED");
  assert.equal(calls, before);

  value = { content: "  原样\r\n", nested: { bytes: "AAEC/w==" }, items: [1, null] };
  for (const [method, request] of [["capability_read", read], ["capability_call", write]]) {
    const response = await core.dispatch(method, request, owner);
    assert(resultEnvelope.safeParse(response).success);
    assert.deepEqual(response.result, value);
  }
});
