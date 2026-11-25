import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { test } from "node:test";
import { createOriginalMcpNativeChatRpcPort } from "../dist/original-mcp-native-chat-rpc.js";
import { originalSdkDigest } from "../dist/original-mcp-sdk-model-contracts.js";
import { createOriginalMcpNativeChatSessionFixture } from "./fixtures/original-mcp-native-chat-session.mjs";
import { originalSdkProtocolFixture, unavailableNativeModelFixture } from "./fixtures/original-mcp-sdk-ports.mjs";

async function fixture(t, statusOnly = false) {
  let wire;
  const ports = originalSdkProtocolFixture(() => wire.activationId), native = unavailableNativeModelFixture(() => wire.activationId);
  wire = await createOriginalMcpNativeChatSessionFixture(t, {
    ...native, ...(statusOnly ? {} : { sdk: ports.sdk }),
    async sdkStatus() { return { provider: "copilot-sdk", status: "unsupported",
      reason: { code: "NATIVE_SDK_CATALOGUE_CONTROL_EGRESS_UNSUPPORTED", message: "Official current-account catalogue not qualified." } }; },
  });
  return { wire, ports };
}
async function select(f) {
  const signal = new AbortController().signal, sdk = f.wire.resource.sdk;
  const catalogue = await sdk.catalogue(signal);
  const selected = await sdk.select({ modelId: f.ports.model.id, catalogueSha256: originalSdkDigest(catalogue) }, signal);
  return { sdk, catalogue, selected, signal };
}
function plan(f, selectionId) {
  return { schema: "pkm.original-sdk-api-chat-execution/v1", requestId: originalSdkDigest(randomUUID()),
    chatUrl: "pkm://chats/0123456789abcdef/10000000-0000-4000-8000-000000000001",
    selectionId, sourcePlanSha256: "b".repeat(64), epoch: f.wire.activationId, hostReceiptSha256: "a".repeat(64),
    deadlineAtMs: Date.now() + 30000, messages: [{ role: "user", content: "SDK protocol fixture only." }],
    tools: [{ name: "get_document", description: "Protocol fixture", parameters: { type: "object" } }],
    hardToolRoundLimit: 1, outputTokenCap: 128,
    budget: { maxRequestBytes: 4096, maxSendingBoundaries: 8, maxTotalOutputTokens: 1024, deadlineMs: 30000 } };
}
test("SDK authenticated status and current-epoch byte measurement stay distinct from native counts", async t => {
  const absent = await fixture(t, true);
  assert.equal(absent.wire.resource.sdk, undefined);
  assert.equal((await absent.wire.resource.sdkStatus(new AbortController().signal)).reason.code,
    "NATIVE_SDK_CATALOGUE_CONTROL_EGRESS_UNSUPPORTED");
  assert.equal(absent.ports.state.runs, 0); assert.equal(absent.ports.state.catalogues, 0);
  const f = await fixture(t), selected = await select(f);
  assert.equal(selected.catalogue.source, "copilot-sdk"); assert.equal(selected.selected.epoch, f.wire.activationId);
  assert.equal(selected.selected.model.routing, "service-routed"); assert.equal(selected.selected.model.contextWindowTokens, null);
  const messages = [{ role: "user", content: "UTF-8 \u{1f680}" }];
  const measured = await selected.sdk.measure({ selectionId: selected.selected.selectionId, messages, tools: [] }, selected.signal);
  assert.equal(measured.providerTokenCount, null); assert.equal(Object.hasOwn(measured, "inputTokens"), false);
  assert.equal(measured.countingMethod, "sdk-prompt-utf8-bytes");
  assert.equal(measured.serializedBytes, Buffer.byteLength(JSON.stringify({ messages, tools: [] })));
  assert.equal(measured.payloadSha256, createHash("sha256")
    .update(JSON.stringify({ messages, tools: [] })).digest("hex"));
  await assert.rejects(selected.sdk.measure({ selectionId: randomUUID(), messages: [], tools: [] }, selected.signal), /STALE_SELECTION/);
  assert.throws(() => createOriginalMcpNativeChatRpcPort({ ...f.wire.session }), /UNAUTHENTICATED|NATIVE_DENIED/);
  await f.wire.close();
  await assert.rejects(selected.sdk.catalogue(selected.signal)); assert.equal(f.ports.state.catalogues, 1);
});
test("SDK authenticated forged callback JSON and wrong-plan session fail before any canonical handler", async t => {
  const fresh = await fixture(t), selected = await select(fresh);
  await assert.rejects(selected.sdk.run({ ...plan(fresh, selected.selected.selectionId), epoch: randomUUID() }, {
    async beforeSession() { assert.fail("Wrong-epoch session reached callback."); },
    async beforeSendingBoundary() { assert.fail("Wrong-epoch sending reached callback."); },
    async tool() { assert.fail("Wrong-epoch tool reached callback."); },
    async text() {}, async usage() {},
  }, selected.signal));
  assert.equal(fresh.ports.state.runs, 0);
  for (const mode of ["forged-tool-json", "wrong-plan"]) await t.test(mode, async t => {
    const f = await fixture(t), selected = await select(f); f.ports.mode(mode);
    let effects = 0;
    await assert.rejects(selected.sdk.run(plan(f, selected.selected.selectionId), {
      async beforeSession() {}, async beforeSendingBoundary() {}, async text() {}, async usage() {},
      async tool() { effects++; throw new Error("Unadmitted canonical effect."); },
    }, selected.signal));
    assert.equal(effects, 0); assert.equal(f.ports.state.authorizations, 0); assert.equal(f.ports.state.sends, 0);
  });
});
