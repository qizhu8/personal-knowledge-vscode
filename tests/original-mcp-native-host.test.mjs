import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { test } from "node:test";
import { captureOriginalMcpCustody, openOriginalMcpRoot } from "../dist/original-mcp-root.js";
import { createOriginalMcpNativeHost, verifyOriginalMcpNativeHostReceipt, originalMcpPublicRequestMatches,
  originalMcpPublicRequestActive, originalMcpRequestDigest, withOriginalMcpPublicRequest } from "../dist/original-mcp-native-host.js";
import { toolArgumentsDigest } from "../dist/domain/tool-gateway-projection.js";

const hash = value => createHash("sha256").update(value).digest("hex");
const encoder = new TextEncoder();
const frame = (delta = {}, finish_reason = null) =>
  `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
const modelConfiguration = {
  aiEndpoint: "https://native-host.invalid/v1", aiModel: "fixture-model",
  apiChatModelProfiles: [{ id: "fixture-model", status: "active", contextWindow: 8192, maxOutputTokens: 256, includeUsage: true }],
};
async function fixture(t, prepareHost = false) {
  const directory = resolve("tests", `.original-native-host-${randomUUID()}`);
  const root = join(directory, "root"), cleanup = [];
  await mkdir(directory, { mode: 0o700 });
  t.after(async () => {
    for (const close of cleanup.reverse()) await close();
    await rm(directory, { recursive: true, force: true });
  });
  await mkdir(join(root, "notes"), { recursive: true, mode: 0o700 });
  await mkdir(join(root, ".pkm", "state", "actions"), { recursive: true, mode: 0o700 });
  await writeFile(join(root, "notes", "Entry.md"), "---\ntitle: Entry\n---\nPreserved original.\n", { mode: 0o600 });
  await writeFile(join(root, ".pkm", "content-privacy.json"), '{"schema":1,"private":{}}', { mode: 0o600 });
  await writeFile(join(root, ".pkm", "state", "actions", "settings.json"), '{"configured":"not inherited"}', { mode: 0o600 });
  const plan = await captureOriginalMcpCustody({ root, backup: join(directory, "custody"),
    operatorId: "fixture-operator", profileSha256: hash("native-profile"),
    limits: { maxEntries: 1000, maxDepth: 32, maxBytes: 16_777_216, maxFileBytes: 8_388_608 } });
  let policy, nativeHost;
  const opened = await openOriginalMcpRoot(plan, prepareHost ? { prepareNative: async storage => {
    nativeHost = await createOriginalMcpNativeHost(storage, policy);
    return nativeHost.options;
  } } : {}); cleanup.push(() => opened.owner.close());
  const lifetime = new AbortController(), admitted = [], authorizations = [], calls = [];
  let current = true, allowed = true, cancelled = 0;
  policy = {
    profileSha256: plan.profileSha256, sourceCatalogSha256: hash("independently captured fixture metadata"),
    authorityId: "native-vscode-profile", epoch: "fixture-epoch-1", signal: lifetime.signal,
    assertCurrent(binding) {
      assert.equal(binding.root, root); assert.equal(binding.workspaceId, opened.workspaceId);
      if (!current) throw new Error("Profile epoch changed.");
    },
    async authorizeAdmission(binding) { admitted.push(binding); return allowed; },
    models: {
      configuration: modelConfiguration, registryAvailability: { "openai-compatible": true },
      async credentialAvailable(binding) {
        assert.equal(binding.secretId, "personalKnowledge.aiApiKey");
        return true;
      },
      async authorizeRequest(binding) { authorizations.push(binding); return allowed; },
      transport: { supports: provider => provider === "openai-compatible", async open(input) {
        calls.push(input);
        return new ReadableStream({ start(controller) {
          controller.enqueue(encoder.encode(frame({ content: "Fresh native provider reply." }) + frame({}, "stop") + "data: [DONE]\n\n"));
          controller.close();
        }, cancel() { cancelled++; } });
      } },
    },
    toolCatalog: [{ name: "get_document", operation: "knowledge.document.get", approvalRequired: true }],
    async approveTool(binding) { authorizations.push(binding); return allowed; },
    async reviewTool(binding) {
      return { actorId: binding.actorId, decisionId: randomUUID(), decision: "reject" };
    },
  };
  return { directory, root, plan, opened, policy, lifetime, admitted, authorizations, calls,
    setCurrent: value => { current = value; }, setAllowed: value => { allowed = value; },
    cancelled: () => cancelled, cleanup, nativeHost: () => nativeHost };
}
const request = () => ({ messages: [{ role: "user", content: "Source-controlled fixture prompt." }],
  profileId: "fixture-model", signal: new AbortController().signal });

test("native original-public approval scope binds the exact host and immutable argument digest", async t => {
  const f = await fixture(t);
  const policy = { ...f.policy, async authorizePublic() { return true; } };
  const host = await createOriginalMcpNativeHost(f.opened.storage, policy);
  const otherHost = await createOriginalMcpNativeHost(f.opened.storage, { ...policy, epoch: "other-live-fixture-epoch" });
  const args = { slug: "Entry" }, approval = { operation: "mcp.tool.get_note", version: 1, tool: "get_note",
    readOnly: true, arguments: args, argumentsDigest: originalMcpRequestDigest(args) };
  assert.equal(originalMcpPublicRequestMatches(f.opened.storage, host, approval), false);
  await withOriginalMcpPublicRequest(f.opened.storage, host, approval, async () => {
    assert.equal(originalMcpPublicRequestMatches(f.opened.storage, host, approval), true);
    assert.equal(originalMcpPublicRequestMatches(f.opened.storage, otherHost, approval), false);
    assert.equal(originalMcpPublicRequestActive(f.opened.storage, "get_note", { slug: "Other" }), false);
    const changed = { slug: "Other" };
    assert.equal(originalMcpPublicRequestMatches(f.opened.storage, host,
      { ...approval, arguments: changed, argumentsDigest: originalMcpRequestDigest(changed) }), false);
    args.slug = "Caller mutation after approval";
    assert.equal(originalMcpPublicRequestMatches(f.opened.storage, host, approval), false);
    assert.equal(originalMcpPublicRequestActive(f.opened.storage, "get_note", { slug: "Entry" }), true);
  });
  assert.equal(originalMcpPublicRequestActive(f.opened.storage, "get_note"), false);
  const writeArgs = { slug: "Entry", content: "Typed fixture result already dispatched" };
  await assert.rejects(withOriginalMcpPublicRequest(f.opened.storage, host, {
    operation: "mcp.tool.update_note", version: 1, tool: "update_note", readOnly: false,
    arguments: writeArgs, argumentsDigest: originalMcpRequestDigest(writeArgs),
  }, async () => { f.setCurrent(false); return { committed: true }; }), error => error.effect === "unknown");
});

test("fresh native profile admission uses actual original-root Storage and streams through the native model provider without copying credentials", async t => {
  const f = await fixture(t, true);
  const originalSettings = await readFile(join(f.root, ".pkm/state/actions/settings.json"));
  assert.equal(f.nativeHost(), undefined, "Cold storage bootstrap has not invented a native profile grant.");
  const full = await f.opened.owner.ensureFull(), host = f.nativeHost();
  assert.equal(full.storage, f.opened.storage);
  assert.equal(f.admitted.length, 1);
  assert.equal(host.receipt.actorId, "mcp:external");
  assert.equal(verifyOriginalMcpNativeHostReceipt(f.opened.storage, host.receipt.receiptSha256).configurationSha256,
    host.receipt.configurationSha256);
  assert.doesNotMatch(JSON.stringify(host.receipt), /native-host\.invalid|fixture-model|apiKey/);
  const service = full.runtime.services.modelProvider;
  assert(service, "The canonical runtime composed the fresh native model service.");
  assert((await full.runtime.core.dispatch("capabilities_describe", { operation: "chat.turn.start" },
    { id: "mcp:external", canWrite: true })).result);
  const events = [];
  for await (const event of service.stream(request())) events.push(event);
  assert(events.some(event => event.type === "text" && event.text === "Fresh native provider reply."));
  assert.equal(f.calls.length, 1);
  assert.equal(f.authorizations[0].requestSha256, toolArgumentsDigest(f.calls[0].payload));
  assert(!("apiKey" in f.calls[0]));
  assert.deepEqual(await readFile(join(f.root, ".pkm/state/actions/settings.json")), originalSettings);
  f.opened.owner.assertWorkspaceLease();
  await host.close();
  assert.throws(() => host.options.providerTransport.supports("openai-compatible"), { code: "ACCESS_DENIED" });
});
test("native host approval is exact actor/workspace/arguments/epoch authority and cannot be inherited from archived settings", async t => {
  const f = await fixture(t);
  await assert.rejects(createOriginalMcpNativeHost(f.opened.storage, { ...f.policy, profileSha256: hash("other") }), { code: "ACCESS_DENIED" });
  await assert.rejects(createOriginalMcpNativeHost(f.opened.storage, { ...f.policy,
    models: { ...f.policy.models, configuration: { ...modelConfiguration, aiApiKey: "must-not-cross-host-boundary" } } }), { code: "ACCESS_DENIED" });
  assert.equal(f.admitted.length, 0);
  f.setAllowed(false);
  await assert.rejects(createOriginalMcpNativeHost(f.opened.storage, f.policy), { code: "ACCESS_DENIED" });
  f.setAllowed(true);
  const host = await createOriginalMcpNativeHost(f.opened.storage, f.policy);
  const binding = { operation: "knowledge.document.get", version: 1, arguments: { id: "Entry" },
    argumentsDigest: toolArgumentsDigest({ id: "Entry" }), actorId: "mcp:external", workspaceId: f.opened.workspaceId,
    turnId: randomUUID(), contextDigest: hash("context"), readOnly: true };
  assert.equal(await host.options.authorizeTool(binding, new AbortController().signal), true);
  const approved = f.authorizations.length;
  for (const change of [{ actorId: "foreign" }, { workspaceId: randomUUID() }, { arguments: { id: "other" } }])
    await assert.rejects(host.options.authorizeTool({ ...binding, ...change }, new AbortController().signal), { code: "ACCESS_DENIED" });
  assert.equal(f.authorizations.length, approved);
  f.setCurrent(false);
  await assert.rejects(host.options.modelConfig.resolve({}), { code: "ACCESS_DENIED" });
  assert.equal(f.calls.length, 0);
});

test("revoked model approval cancels only its owned stream, never the canonical owner or an unknown request replay", async t => {
  const f = await fixture(t);
  let cancelled = 0;
  const host = await createOriginalMcpNativeHost(f.opened.storage, {
    ...f.policy, models: { ...f.policy.models, transport: {
      supports: () => true, async open(input) {
        f.calls.push(input);
        return new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([1])); },
          cancel() { cancelled++; } });
      },
    } },
  });
  const stream = await host.options.providerTransport.open({ provider: "openai-compatible",
    payload: { model: "fixture-model", messages: [], stream: true }, signal: new AbortController().signal });
  const reader = stream.getReader(); await reader.read();
  f.lifetime.abort();
  await assert.rejects(reader.read());
  assert.equal(cancelled, 1);
  assert.equal(f.calls.length, 1);
  f.opened.owner.assertWorkspaceLease();
  await assert.rejects(host.options.providerTransport.open({ provider: "openai-compatible",
    payload: { model: "fixture-model", messages: [], stream: true }, signal: new AbortController().signal }), { code: "ACCESS_DENIED" });
  assert.equal(f.calls.length, 1);
});

test("altered native host schema requires offline recovery before provider authority", async t => {
  const f = await fixture(t);
  const host = await createOriginalMcpNativeHost(f.opened.storage, f.policy);
  const database = f.opened.storage.connectNative();
  try {
    assert.throws(() => database.prepare("UPDATE original_mcp_native_host_admissions SET payload='{}'").run(), /immutable/);
    database.exec("DROP TRIGGER original_mcp_native_host_admissions_no_update");
  } finally { database.close(); }
  assert.throws(() => verifyOriginalMcpNativeHostReceipt(f.opened.storage, host.receipt.receiptSha256), { code: "RECOVERY_REQUIRED" });
  assert.throws(() => host.options.providerTransport.supports("openai-compatible"), { code: "RECOVERY_REQUIRED" });
  assert.equal(f.calls.length, 0);
});
test("tampered host payload is denied even when the exact immutable schema is restored", async t => {
  const f = await fixture(t);
  const host = await createOriginalMcpNativeHost(f.opened.storage, f.policy);
  const database = f.opened.storage.connectNative();
  try {
    const { sql } = database.prepare("SELECT sql FROM sqlite_master WHERE name='original_mcp_native_host_admissions_no_update'").get();
    database.exec("DROP TRIGGER original_mcp_native_host_admissions_no_update");
    database.prepare("UPDATE original_mcp_native_host_admissions SET payload='{}'").run();
    database.exec(sql);
  } finally { database.close(); }
  assert.throws(() => verifyOriginalMcpNativeHostReceipt(f.opened.storage, host.receipt.receiptSha256), { code: "ACCESS_DENIED" });
  assert.throws(() => host.options.providerTransport.supports("openai-compatible"), { code: "ACCESS_DENIED" });
  assert.equal(f.calls.length, 0);
});
