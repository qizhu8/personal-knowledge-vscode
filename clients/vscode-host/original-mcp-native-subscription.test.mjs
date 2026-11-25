import assert from "node:assert/strict";
import Module, { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import test from "node:test";
import { originalNativeSourceRequestDigest as digest } from "../../dist/original-mcp-native-source-contracts.js";

test("native Subscription producer requires exact current membership corpus consent and refuses denial replay and epoch change", async t => {
  const require = createRequire(import.meta.url), root = fileURLToPath(new URL("../../", import.meta.url));
  const built = await require("esbuild").build({ entryPoints: [join(root, "clients/vscode-host/original-mcp-native-subscription.ts")],
    bundle: true, platform: "node", format: "cjs", external: ["vscode"], write: false, metafile: true, logLevel: "silent",
    plugins: [{ name: "subscription-signer", setup(plugin) {
      plugin.onResolve({ filter: /original-mcp-native-identity\.js$/ }, () => ({ path: "subscription-signer", external: true }));
    } }],
  });
  assert.deepEqual(Object.keys(built.metafile.inputs).filter(path =>
    /(?:^|\/)src\/(?:contracts|storage|active-vscode-migration-host)\.ts$/.test(path)), [],
  "Native Subscription validation must not pull the broad Core graph or active host brands into its client bundle.");
  const epoch = randomUUID(), session = { brokerId: randomUUID(), activationId: epoch, epoch, identitySha256: "a".repeat(64),
    binding: { root: "/fixture/current-source", workspaceId: randomUUID(), planSha256: "b".repeat(64),
      catalogSha256: "c".repeat(64), profileSha256: "d".repeat(64), payloadBuildId: "e".repeat(64), hostEntrySha256: "f".repeat(64) } };
  const lifetime = new AbortController(), choices = [], prompts = [], context = { subscriptions: [] };
  let alive = true, revoke;
  const signer = { activationId: epoch, identity: { sha256: session.identitySha256, profileSha256: session.binding.profileSha256 },
    payloadBuildId: session.binding.payloadBuildId, hostEntrySha256: session.binding.hostEntrySha256,
    signal: lifetime.signal, assertCurrent() { assert(alive); } };
  const loader = Module._load, module = new Module(join(root, "clients/vscode-host/subscription-producer-memory.cjs"));
  module.filename = join(root, "clients/vscode-host/subscription-producer-memory.cjs");
  module.paths = Module._nodeModulePaths(join(root, "clients/vscode-host"));
  try {
    Module._load = function(id, ...args) {
      if (id === "subscription-signer") return { originalMcpNativeSigner: async () => signer };
      if (id === "vscode") return { workspace: { isTrusted: true, onDidChangeWorkspaceFolders() { return { dispose() {} }; } },
        commands: { registerCommand(_name, callback) { revoke = callback; return { dispose() {} }; } },
        window: { showWarningMessage(_title, options) { prompts.push(JSON.parse(options.detail)); return choices.shift(); } } };
      return loader.call(this, id, ...args);
    };
    module._compile(built.outputFiles[0].text, module.filename);
  } finally { Module._load = loader; }
  const producer = await module.exports.createOriginalMcpNativeSubscriptionProducer(context, {
    session, signal: lifetime.signal, assertCurrent() { assert(alive); }, async close() { lifetime.abort(); },
  });
  t.after(() => producer.dispose());
  const binding = { schema: "pkm.original-mcp-native-host-admission/v1", root: session.binding.root,
    workspaceId: session.binding.workspaceId, planSha256: session.binding.planSha256, profileSha256: session.binding.profileSha256,
    sourceCatalogSha256: session.binding.catalogSha256, authorityId: `native-rpc:${session.brokerId}`,
    epoch, actorId: "mcp:external", domains: ["mcp-public"], configurationSha256: "1".repeat(64) };
  const source = { schema: "pkm.original-subscription-read-source/v1", head: "2".repeat(64), corpusSha256: "3".repeat(64),
    members: [{ subscriptionId: "current", nodeId: "4".repeat(64), shareId: "public", publicKeySha256: "5".repeat(64),
      providerSha256: "6".repeat(64), membershipSha256: "7".repeat(64), revision: 2, collectionHash: `sha256:${"8".repeat(64)}` }] };
  const payload = { binding, source, tool: "list_subscriptions", arguments: {}, argumentsSha256: digest({}), noExecution: true };
  choices.push("Deny");
  assert.equal(await producer.handle(payload, randomUUID(), lifetime.signal), null);
  choices.push("Read this exact current subscription source");
  const id = randomUUID(), decision = await producer.handle(payload, id, lifetime.signal);
  assert.equal(decision.sourceSha256, digest(source));
  assert.deepEqual(prompts.at(-1).source, source);
  await assert.rejects(producer.handle(payload, id, lifetime.signal), /REPLAY/);
  await assert.rejects(producer.handle({ ...payload, binding: { ...binding, epoch: randomUUID() } }, randomUUID(), lifetime.signal));
  revoke();
  await assert.rejects(producer.handle(payload, randomUUID(), lifetime.signal));
});
