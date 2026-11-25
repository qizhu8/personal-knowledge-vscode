import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import Module, { createRequire } from "node:module";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { test } from "node:test";
import {
  originalMcpNativeIdentity, verifyOriginalMcpNativeIdentity, originalMcpNativeAttestationMessage,
  OriginalMcpNativeChallenges,
} from "../dist/original-mcp-native-identity.js";
import { originalMcpRequestDigest } from "../dist/original-mcp-native-host.js";
import { originalMcpNativeRequestProtocol, parseOriginalMcpNativeRequest } from "../dist/original-mcp-native-request.js";

function fixture() {
  const pair = generateKeyPairSync("ed25519"), profileSha256 = "a".repeat(64);
  const identity = originalMcpNativeIdentity(pair.publicKey.export({ format: "der", type: "spki" }).toString("base64"), profileSha256);
  const binding = {
    root: "/isolated-fixture/library", workspaceId: randomUUID(), planSha256: "b".repeat(64),
    catalogSha256: "c".repeat(64), profileSha256, payloadBuildId: "d".repeat(64), hostEntrySha256: "e".repeat(64),
  };
  const book = new OriginalMcpNativeChallenges(identity, identity.sha256, binding);
  const response = (challenge, key = pair.privateKey, activationId = randomUUID()) => {
    const { body, message } = originalMcpNativeAttestationMessage(challenge, identity.sha256, activationId);
    return { ...body, signature: sign(null, message, key).toString("base64") };
  };
  return { pair, identity, binding, book, response };
}

test("enrolled native identity authenticates one fresh bound challenge, never a replay or another owner", () => {
  const f = fixture(), challenge = f.book.issue(), response = f.response(challenge);
  assert.deepEqual(f.book.consume(response),
    { activationId: response.activationId, identitySha256: f.identity.sha256 });
  assert.throws(() => f.book.consume(response), /REFUSED/);
  const other = new OriginalMcpNativeChallenges(f.identity, f.identity.sha256, f.binding);
  assert.throws(() => other.consume(f.response(f.book.issue())), /REFUSED/);
  f.book.close();
  assert.throws(() => f.book.issue(), /REVOKED/);
});

test("native producer signatures bind activation, root, profile, plan, exact build and independently pinned public identity", () => {
  const f = fixture();
  assert.throws(() => verifyOriginalMcpNativeIdentity(f.identity, "f".repeat(64), f.binding.profileSha256), /CHANGED/);
  assert.throws(() => verifyOriginalMcpNativeIdentity(f.identity, f.identity.sha256, "f".repeat(64)), /CHANGED/);
  assert.throws(() => verifyOriginalMcpNativeIdentity({ ...f.identity, credential: "not-an-authority" },
    f.identity.sha256, f.binding.profileSha256));
  for (const change of [
    { root: "/other/library" }, { planSha256: "f".repeat(64) }, { profileSha256: "f".repeat(64) },
    { payloadBuildId: "f".repeat(64) }, { hostEntrySha256: "f".repeat(64) },
  ]) assert.throws(() => f.book.consume(f.response({ ...f.book.issue(), ...change })), /REFUSED/);
  const response = f.response(f.book.issue());
  assert.throws(() => f.book.consume({ ...response, activationId: randomUUID() }), /REFUSED/);
  assert.throws(() => f.book.consume(response), /REFUSED/, "A rejected proof must also consume its issued nonce.");
});

test("native attachment refuses a different signing key, malformed encodings, expired challenges and unbounded issuance", t => {
  const f = fixture(), other = generateKeyPairSync("ed25519");
  assert.throws(() => f.book.consume(f.response(f.book.issue(), other.privateKey)), /REFUSED/);
  const response = f.response(f.book.issue());
  assert.throws(() => f.book.consume({ ...response, signature: response.signature + "=" }), /INVALID/);
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const expired = f.response(f.book.issue());
  t.mock.timers.tick(60_001);
  assert.throws(() => f.book.consume(expired), /EXPIRED/);
  const bounded = fixture();
  for (let i = 0; i < 8; i++) bounded.book.issue();
  assert.throws(() => bounded.book.issue(), /BUSY/);
});

async function producerFixture(t, { chatShutdownFixture = false } = {}) {
  const require = createRequire(import.meta.url), { build } = require("esbuild");
  const parent = resolve("tests", `.native-identity-${randomUUID()}`);
  t.after(() => rm(parent, { recursive: true, force: true }));
  const extensionPath = join(parent, "extension"), directory = join(parent, "globalStorage", "pkm-nonproduction.pkm-v5");
  await mkdir(join(extensionPath, "dist"), { recursive: true, mode: 0o700 });
  await mkdir(join(parent, "globalStorage"), { mode: 0o700 });
  const entry = join(extensionPath, "dist/extension.cjs");
  await writeFile(join(extensionPath, "package.json"), '{"type":"commonjs"}');
  await build({
    stdin: { contents: `
      export {originalMcpNativeSigner} from "./clients/vscode-host/original-mcp-native-identity.ts";
      export {registerOriginalMcpNativeAttachment} from "./clients/vscode-host/original-mcp-native-attachment.ts";
      export {registerOriginalMcpNativeCredentials,originalMcpNativeCredentialAvailable}
        from "./clients/vscode-host/original-mcp-native-credentials.ts";
      export {originalMcpNativeApprovals} from "./clients/vscode-host/original-mcp-native-approvals.ts";
      ${chatShutdownFixture ? 'export {nativeChatShutdownState} from "native-chat-shutdown-fixture";' : ""}
    `, resolveDir: resolve() },
    bundle: true, platform: "node", format: "cjs", outfile: entry, external: ["vscode"], logLevel: "silent",
    plugins: chatShutdownFixture ? [{ name: "protocol-shutdown-fixture", setup(plugin) {
      plugin.onResolve({ filter: /(?:original-mcp-native-chat-session\.js|^native-chat-shutdown-fixture)$/ },
        () => ({ path: "shutdown-fixture", namespace: "native-chat-shutdown-fixture" }));
      plugin.onLoad({ filter: /.*/, namespace: "native-chat-shutdown-fixture" }, () => ({ contents: `
        export const nativeChatShutdownState = {disposed:false,triggerFatal:undefined};
        export async function enableOriginalMcpNativeChatSession(context, options) {
          let settled;
          const closed = new Promise(resolve => { settled=resolve; });
          nativeChatShutdownState.triggerFatal=()=>options.close().then(() => { settled(); });
          return {
            async support(){},
            receive() { void nativeChatShutdownState.triggerFatal(); },
            async dispose(){ await closed; nativeChatShutdownState.disposed=true; }
          };
        }
      ` }));
    } }] : [],
  });
  const runtime = join(extensionPath, "next-runtime/server/legacy/dist/runtime");
  await mkdir(runtime, { recursive: true });
  await writeFile(join(runtime, "next-payload-verifier.js"),
    `exports.verifyNextPayload = () => ({buildId:${JSON.stringify("d".repeat(64))}});\n`);
  await mkdir(join(extensionPath, "next-runtime/server/dist"), { recursive: true });
  await writeFile(join(extensionPath, "next-runtime/server/dist", "original-mcp-native-attachment.js"), `
    const fs = require("node:fs"), crypto = require("node:crypto");
    exports.verifyOriginalMcpNativeAttachmentDescriptor = async (path,pin,profile) => {
      const bytes=fs.readFileSync(path), value=JSON.parse(bytes);
      if(crypto.createHash("sha256").update(bytes).digest("hex")!==pin || value.binding.profileSha256!==profile)
        throw new Error("FIXTURE_DESCRIPTOR_REFUSED");
      return value;
    };
  `);
  await writeFile(join(extensionPath, "next-runtime/server/dist", "original-mcp-native-request.js"),
    `const actual = require(${JSON.stringify(resolve("dist/original-mcp-native-request.js"))});
      exports.parseOriginalMcpNativeRequest = actual.parseOriginalMcpNativeRequest;
      exports.originalMcpNativeResult = actual.originalMcpNativeResult;
      exports.originalMcpNativeErrorResult = actual.originalMcpNativeErrorResult;
      exports.originalMcpNativeRequestSessionSchema = actual.originalMcpNativeRequestSessionSchema;
      exports.originalMcpNativeCancelSchema = actual.originalMcpNativeCancelSchema;
      exports.originalMcpNativeRequestProtocol = actual.originalMcpNativeRequestProtocol;\n`);
  const manifest = join(extensionPath, "next-runtime/manifest.json");
  await writeFile(manifest, '{"scope":"fixture-only native-package/context mocks; not production qualification"}');
  const secrets = new Map(), secretAccesses = [];
  function activation(selectedSecrets = secrets) {
    const answers = [], inputs = [], inputOptions = [], listeners = new Set(), subscriptions = [], commands = new Map(), diagnostics = [];
    const context = {
      extensionMode: 1, extension: { id: "pkm-nonproduction.pkm-v5" }, extensionPath,
      globalStorageUri: { fsPath: directory }, subscriptions,
      secrets: {
        async get(key) { secretAccesses.push(key); return selectedSecrets.get(key); },
        async store(key, value) { secretAccesses.push(key); selectedSecrets.set(key, value); },
        onDidChange(listener) { listeners.add(listener); return { dispose() { listeners.delete(listener); } }; },
      },
    };
    const current = {
      isActive: true, extensionPath,
      exports: { assertActiveMigrationContext(candidate) { assert.equal(candidate, context); } },
    };
    const native = {
      ExtensionMode: { Production: 1 }, workspace: { isTrusted: true,
        onDidChangeWorkspaceFolders() { return { dispose() {} }; } },
      extensions: { getExtension: () => current },
      commands: { registerCommand(name, handler) {
        commands.set(name, handler); return { dispose() { commands.delete(name); } };
      } },
      window: {
        showWarningMessage: async () => answers.shift(),
        showInputBox: async options => { inputOptions.push(options); return inputs.shift(); },
        showErrorMessage: async message => { diagnostics.push(message); },
      },
    };
    const load = Module._load;
    let api;
    try {
      Module._load = function (id, ...args) { return id === "vscode" ? native : load.call(this, id, ...args); };
      delete require.cache[require.resolve(entry)];
      api = require(entry);
    } finally { Module._load = load; }
    return { api, context, answers, inputs, inputOptions, current, commands, diagnostics,
      notifyKey(key) { for (const listener of listeners) listener({ key }); },
      revokeKey(key) { selectedSecrets.delete(key); for (const listener of listeners) listener({ key }); },
      dispose() { for (const subscription of subscriptions) subscription.dispose(); } };
  }
  return { activation, directory, secrets, secretAccesses, manifest };
}

test("native producer fixture keeps the private key in its separate namespace and signs only matching consented attachments", async t => {
  const f = await producerFixture(t), native = f.activation();
  native.answers.push("Enroll native identity");
  const signer = await native.api.originalMcpNativeSigner(native.context);
  t.after(() => native.dispose());
  const publicFile = await readFile(signer.path, "utf8");
  assert(!publicFile.includes("PRIVATE KEY"));
  assert.equal(f.secrets.size, 1);
  assert(f.secretAccesses.every(key => key.startsWith("pkm.originalMcp.nativeIdentity.v1.")));
  native.notifyKey([...f.secrets.keys()][0]);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(signer.signal.aborted, false, "A late notification of the initial unchanged store must not revoke its new identity.");
  const binding = { ...fixture().binding, profileSha256: signer.identity.profileSha256,
    payloadBuildId: signer.payloadBuildId, hostEntrySha256: signer.hostEntrySha256 };
  const broker = new OriginalMcpNativeChallenges(signer.identity, signer.identity.sha256, binding);
  const challenge = broker.issue();
  native.answers.push("Attach native producer");
  assert.equal(broker.consume(await signer.signChallenge(challenge)).activationId, signer.activationId);
  await assert.rejects(signer.signChallenge({ ...broker.issue(), payloadBuildId: "f".repeat(64) }), /profile\/build/);
  await assert.rejects(signer.signChallenge(broker.issue()), /DECLINED/);
  native.revokeKey([...f.secrets.keys()][0]);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(signer.signal.aborted, true);
  await assert.rejects(signer.signChallenge(broker.issue()), /changed/);
  assert.equal(await readFile(signer.path, "utf8"), publicFile);
});

test("native producer fixture never replaces a lost enrolled key or silently rotates its identity", async t => {
  const f = await producerFixture(t), initial = f.activation();
  initial.answers.push("Enroll native identity");
  const signer = await initial.api.originalMcpNativeSigner(initial.context);
  const before = await readFile(signer.path, "utf8");
  initial.dispose();
  const empty = new Map(), restarted = f.activation(empty);
  await assert.rejects(restarted.api.originalMcpNativeSigner(restarted.context), /signing key is absent/);
  assert.equal(empty.size, 0);
  assert.equal(await readFile(signer.path, "utf8"), before);
  const resumed = f.activation();
  const current = await resumed.api.originalMcpNativeSigner(resumed.context);
  t.after(() => resumed.dispose());
  await writeFile(f.manifest, '{"changed":true}');
  assert.throws(() => current.assertCurrent(), /changed/);
  assert.equal(current.signal.aborted, true);
});

test("competing native enrollment fixtures cannot overwrite the winning public identity's private key", async t => {
  const f = await producerFixture(t), first = f.activation(), second = f.activation();
  first.answers.push("Enroll native identity"); second.answers.push("Enroll native identity");
  const results = await Promise.allSettled([
    first.api.originalMcpNativeSigner(first.context), second.api.originalMcpNativeSigner(second.context),
  ]);
  t.after(() => { first.dispose(); second.dispose(); });
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  assert.equal(results.filter(result => result.status === "rejected").length, 1);
  const resumed = f.activation(), signer = await resumed.api.originalMcpNativeSigner(resumed.context);
  t.after(() => resumed.dispose());
  const broker = new OriginalMcpNativeChallenges(signer.identity, signer.identity.sha256, {
    ...fixture().binding, profileSha256: signer.identity.profileSha256,
    payloadBuildId: signer.payloadBuildId, hostEntrySha256: signer.hostEntrySha256,
  });
  resumed.answers.push("Attach native producer");
  assert(broker.consume(await signer.signChallenge(broker.issue())).activationId);
});

async function attachmentFixture(t, fault) {
  const f = await producerFixture(t, { chatShutdownFixture: !!fault?.chatShutdownFixture }), native = f.activation();
  native.answers.push("Enroll native identity");
  const signer = await native.api.originalMcpNativeSigner(native.context);
  const directory = resolve(`.pkm-native-attach-${randomUUID().slice(0, 8)}`);
  await mkdir(directory, { mode: 0o700 });
  const binding = { ...fixture().binding, profileSha256: signer.identity.profileSha256,
    payloadBuildId: signer.payloadBuildId, hostEntrySha256: signer.hostEntrySha256 };
  const broker = new OriginalMcpNativeChallenges(signer.identity, signer.identity.sha256, binding);
  const socketPath = join(directory, "s"), received = [];
  let resolvePong;
  const pong = new Promise(resolve => { resolvePong = resolve; });
  let connection;
  const server = createServer(socket => {
    connection = socket;
    let buffered = "";
    socket.write(JSON.stringify({ type: "challenge", challenge: { ...broker.issue(), ...fault?.challenge } }) + "\n");
    socket.on("data", chunk => {
      buffered += chunk.toString("utf8");
      for (let boundary; (boundary = buffered.indexOf("\n")) >= 0;) {
        const value = JSON.parse(buffered.slice(0, boundary)); buffered = buffered.slice(boundary + 1);
        received.push(value);
        if (value.type === "attestation") {
          const proof = broker.consume(value.attestation);
          socket.write(JSON.stringify({ type: "attached", brokerId: broker.brokerId, ...proof,
            businessReady: fault?.businessReady ?? false }) + "\n");
          if (!fault) socket.write('{"type":"ping","nonce":"fixture-keepalive"}\n');
        } else if (value.type === "pong") resolvePong(value);
      }
    });
  });
  let registration;
  t.after(async () => {
    registration?.dispose(); native.dispose(); broker.close();
    if (server.listening) await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  await new Promise(resolve => server.listen(socketPath, resolve));
  const descriptor = { schema: "pkm.original-mcp-native-attachment/v1", brokerId: broker.brokerId,
    socketPath, identitySha256: signer.identity.sha256, binding };
  const descriptorPath = join(directory, "descriptor.json"), bytes = JSON.stringify(descriptor);
  await writeFile(descriptorPath, bytes, { mode: 0o600 });
  await writeFile(join(f.directory, "original-mcp-native-bootstrap.json"), JSON.stringify({
    schema: "pkm.original-mcp-native-bootstrap/v1", descriptorPath,
    descriptorSha256: createHash("sha256").update(bytes).digest("hex"), profileSha256: signer.identity.profileSha256,
  }), { mode: 0o600 });
  const output = [];
  let outputDisposed = false;
  registration = native.api.registerOriginalMcpNativeAttachment(native.context, { appendLine: line => {
    if (outputDisposed) throw new Error("fixture output channel disposed");
    if (fault?.telemetryLoggerFailure && line.startsWith("[pkm.native-attachment.first-stop]"))
      throw new Error("fixture diagnostic sink failed");
    output.push(line);
  } });
  return { ...f, native, received, pong, output, disposeAttachment() { registration.dispose(); },
    disposeOutput() { outputDisposed = true; },
    disconnect() { connection.end(); }, send(value) { connection.write(`${JSON.stringify(value)}\n`); } };
}
function firstAttachmentStops(f) {
  const prefix = "[pkm.native-attachment.first-stop] ";
  return f.output.filter(line => line.startsWith(prefix)).map(line => JSON.parse(line.slice(prefix.length)));
}
async function untilAttachment(check) {
  for (let count = 0; count < 100; count++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.fail("Native attachment fixture condition timed out.");
}

test("native attachment client fixture signs pinned challenges, answers liveness and never returns business authority", { timeout: 10000 }, async t => {
  const f = await attachmentFixture(t);
  f.native.answers.push("Attach native producer");
  const result = await f.native.commands.get("pkm.nextHost.attachNativeProducer")();
  assert.deepEqual(result, { authenticated: true, businessReady: false });
  assert.deepEqual(await f.pong, { type: "pong", nonce: "fixture-keepalive" });
  assert.equal(f.received.filter(value => value.type === "attestation").length, 1);
  assert(!JSON.stringify(f.received).includes("PRIVATE KEY"));
});

test("native model protocol shutdown closes its socket without awaiting its own disposal", { timeout: 10000 }, async t => {
  const f = await attachmentFixture(t, { chatShutdownFixture: true });
  f.native.answers.push("Attach native producer");
  await f.native.commands.get("pkm.nextHost.attachNativeProducer")();
  await f.native.commands.get("pkm.nextHost.enableNativeModels")();
  f.send({ type: "native-chat-fixture-fatal" });
  for (let count = 0; count < 100 && !f.native.api.nativeChatShutdownState.disposed; count++)
    await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(f.native.api.nativeChatShutdownState.disposed, true,
    "Fatal protocol cleanup must finish rather than form a socket-close/channel-disposal cycle.");
  assert.equal(firstAttachmentStops(f)[0].origin, "protocol");
  assert.equal(firstAttachmentStops(f)[0].expectedShutdown, false);
});

for (const fault of [{ challenge: { root: "/different/unapproved-root" } }, { businessReady: true }])
test(`native attachment client fixture refuses ${fault.challenge ? "a changed root" : "premature business publication"}`, { timeout: 10000 }, async t => {
  const f = await attachmentFixture(t, fault);
  f.native.answers.push("Attach native producer");
  await assert.rejects(f.native.commands.get("pkm.nextHost.attachNativeProducer")(), /authentication|binding/);
  assert(f.native.diagnostics.length > 0);
  assert.equal(firstAttachmentStops(f).length, 1);
  assert.equal(firstAttachmentStops(f)[0].origin, "protocol");
  assert.equal(firstAttachmentStops(f)[0].expectedShutdown, false);
  assert(!JSON.stringify(firstAttachmentStops(f)).includes("/different/unapproved-root"));
  if (fault.challenge) assert.equal(f.received.length, 0, "A changed Root must be refused before signing or sending a proof.");
});

test("native attachment first-stop telemetry distinguishes peer disconnect from expected disposal", { timeout: 10000 }, async t => {
  for (const expected of [false, true]) await t.test(expected ? "dispose" : "disconnect", async t => {
    const f = await attachmentFixture(t);
    f.native.answers.push("Attach native producer");
    await f.native.commands.get("pkm.nextHost.attachNativeProducer")();
    await f.pong;
    if (expected) f.disposeAttachment(); else f.disconnect();
    await untilAttachment(() => firstAttachmentStops(f).length > 0);
    f.disposeAttachment();
    const records = firstAttachmentStops(f);
    assert.equal(records.length, 1);
    assert.equal(records[0].origin, expected ? "requested-close" : "socket-close");
    assert.equal(records[0].expectedShutdown, expected);
    assert.equal(records[0].phase, "attached");
    assert.equal(records[0].terminalObserved, true);
    assert(records[0].elapsedMs >= 0 && records[0].rssBytes > 0 && records[0].heapUsedBytes > 0);
  });
});

test("attachment disposal records intent before output disposal without consuming the later terminal latch", { timeout: 10000 }, async t => {
  const f = await attachmentFixture(t);
  const fallback = [], prefix = "[pkm.native-attachment.first-stop] ";
  t.mock.method(console, "error", line => { if (typeof line === "string" && line.startsWith(prefix)) fallback.push(JSON.parse(line.slice(prefix.length))); });
  f.native.answers.push("Attach native producer");
  await f.native.commands.get("pkm.nextHost.attachNativeProducer")();
  await f.pong;
  f.disposeAttachment();
  const intent = f.output.filter(line => line.startsWith("[pkm.native-attachment.disposal-intent] "));
  assert.equal(intent.length, 1);
  assert.equal(JSON.parse(intent[0].slice("[pkm.native-attachment.disposal-intent] ".length)).terminalObserved, false);
  assert.equal(firstAttachmentStops(f).length, 0, "A queued disposal intent is not a terminal observation.");
  f.disposeOutput();
  await untilAttachment(() => fallback.length > 0);
  assert.equal(fallback.length, 1);
  assert.equal(fallback[0].origin, "requested-close");
  assert.equal(fallback[0].expectedShutdown, true);
  assert.equal(fallback[0].terminalObserved, true);
});

test("a protocol failure after disposal intent keeps its actual first origin and remains unexpected", { timeout: 10000 }, async t => {
  const f = await attachmentFixture(t, { chatShutdownFixture: true });
  f.native.answers.push("Attach native producer");
  await f.native.commands.get("pkm.nextHost.attachNativeProducer")();
  await f.native.commands.get("pkm.nextHost.enableNativeModels")();
  f.disposeAttachment();
  const stopping = f.native.api.nativeChatShutdownState.triggerFatal();
  await stopping;
  const records = firstAttachmentStops(f);
  assert.equal(records.length, 1);
  assert.equal(records[0].origin, "protocol");
  assert.equal(records[0].expectedShutdown, false);
  assert.equal(records[0].terminalObserved, true);
});

test("attachment telemetry sink failure cannot prevent socket cancellation and existing failure reporting", { timeout: 10000 }, async t => {
  const f = await attachmentFixture(t, { telemetryLoggerFailure: true });
  f.native.answers.push("Attach native producer");
  await f.native.commands.get("pkm.nextHost.attachNativeProducer")();
  f.disconnect();
  await untilAttachment(() => f.output.some(line => line.includes("unavailable or disconnected")));
  assert.equal(firstAttachmentStops(f).length, 0);
  assert(f.native.diagnostics.length > 0);
});

test("native model credential fixture uses masked native input and returns only profile-bound presence, never keys", async t => {
  const f = await producerFixture(t), native = f.activation();
  native.answers.push("Enroll native identity");
  const signer = await native.api.originalMcpNativeSigner(native.context), output = [];
  t.after(() => native.dispose());
  const registration = native.api.registerOriginalMcpNativeCredentials(native.context, { appendLine: line => output.push(line) });
  t.after(() => registration.dispose());
  const binding = { secretId: "personalKnowledge.aiApiKey", profileSha256: signer.identity.profileSha256 };
  assert.equal(await native.api.originalMcpNativeCredentialAvailable(native.context, binding), false);
  const enroll = native.commands.get("pkm.nextHost.reenrollModelCredential");
  assert.deepEqual(await enroll(), { cancelled: true, stored: false });
  assert.equal(f.secrets.size, 1);
  native.inputs.push("invalid\ncredential");
  await assert.rejects(enroll(), /CREDENTIAL_INVALID/);
  native.inputs.push("x".repeat(4097));
  await assert.rejects(enroll(), /CREDENTIAL_INVALID/);
  assert.equal(f.secrets.size, 1);
  const key = "fixture-native-model-key-only";
  native.inputs.push(key);
  const result = await enroll();
  assert.deepEqual(result, { stored: true, profileSha256: signer.identity.profileSha256, businessActivation: false });
  assert.equal(await native.api.originalMcpNativeCredentialAvailable(native.context, binding), true);
  assert(native.inputOptions.every(options => options.password === true && options.ignoreFocusOut === true));
  await assert.rejects(native.api.originalMcpNativeCredentialAvailable(native.context, { ...binding, profileSha256: "f".repeat(64) }), /BINDING_REQUIRED/);
  await assert.rejects(native.api.originalMcpNativeCredentialAvailable(native.context, { ...binding, secretId: "unrelated.secret" }), /BINDING_REQUIRED/);
  assert(!JSON.stringify({ result, output, diagnostics: native.diagnostics }).includes(key));
  assert(!(await readFile(signer.path, "utf8")).includes(key));
  assert(f.secretAccesses.every(id => /^pkm\.originalMcp\.(?:nativeIdentity|modelApiKey)\.v1\./.test(id)));
});

test("native approval fixture separates authentication, scoped public reads, exact writes and cancellation", async t => {
  const f = await producerFixture(t), native = f.activation();
  native.answers.push("Enroll native identity");
  const signer = await native.api.originalMcpNativeSigner(native.context);
  const withoutModel = await native.api.originalMcpNativeApprovals(native.context);
  let pendingInference;
  const approvals = await native.api.originalMcpNativeApprovals(native.context, (model, digest) => {
    if (pendingInference?.model !== model || pendingInference?.digest !== digest) return false;
    pendingInference = undefined;
    return true;
  });
  t.after(() => native.dispose());
  assert(!withoutModel.methods.includes("model.approve"), "Unavailable model execution must not be advertised.");
  const base = { ...fixture().binding, profileSha256: signer.identity.profileSha256,
    payloadBuildId: signer.payloadBuildId, hostEntrySha256: signer.hostEntrySha256 };
  const session = { brokerId: randomUUID(), activationId: signer.activationId, identitySha256: signer.identity.sha256,
    epoch: signer.activationId, binding: base };
  const binding = { schema: "pkm.original-mcp-native-host-admission/v1", root: base.root, workspaceId: base.workspaceId,
    planSha256: base.planSha256, profileSha256: base.profileSha256, sourceCatalogSha256: base.catalogSha256,
    authorityId: `native-rpc:${session.brokerId}`, epoch: session.activationId, actorId: "mcp:external",
    domains: ["mcp-public"], configurationSha256: "f".repeat(64) };
  const frame = (method, extra = {}) => {
    const body = { protocol: originalMcpNativeRequestProtocol, requestId: randomUUID(), session, method, payload: { binding, ...extra } };
    return parseOriginalMcpNativeRequest({ type: "native-request", ...body, requestDigest: originalMcpRequestDigest(body) }, session);
  };
  const operation = { operation: "mcp.tool.get_note", version: 1, tool: "get_note", readOnly: true,
    arguments: { slug: "fixture" }, argumentsDigest: originalMcpRequestDigest({ slug: "fixture" }) };
  const read = frame("public.approve", { request: operation }), live = new AbortController();
  await assert.rejects(approvals.handle(read, live.signal), /NATIVE_DENIED/, "Signing a connection must not approve reads.");
  native.answers.push("Deny");
  assert.deepEqual(await approvals.handle(frame("admission.approve"), live.signal), { decision: "deny" });
  native.answers.push("Approve this request");
  assert.deepEqual(await approvals.handle(frame("admission.approve"), live.signal), { decision: "approve" });
  assert.deepEqual(await approvals.handle(read, live.signal), { decision: "approve" });
  const args = { slug: "fixture", content: "exact approved request" };
  const write = frame("public.approve", { request: { ...operation, operation: "mcp.tool.update_note", tool: "update_note",
    readOnly: false, arguments: args, argumentsDigest: originalMcpRequestDigest(args) } });
  const forgedRead = frame("public.approve", { request: { ...write.payload.request, readOnly: true } });
  await assert.rejects(approvals.handle(forgedRead, live.signal), /CLASSIFICATION/,
    "The broker cannot relabel a mutation as a preapproved public read.");
  native.answers.push("Deny");
  assert.deepEqual(await approvals.handle(write, live.signal), { decision: "deny" });
  let answer;
  native.answers.push(new Promise(resolve => { answer = resolve; }));
  const cancelled = new AbortController(), pending = approvals.handle(write, cancelled.signal);
  cancelled.abort(); answer("Approve this request");
  await assert.rejects(pending, /CANCELLED/, "A late native click cannot approve a cancelled request.");
  const inference = { provider: "vscode", model: "fixture-model", requestSha256: "a".repeat(64) };
  await assert.rejects(approvals.handle(frame("model.approve", inference), live.signal), /NATIVE_DENIED/);
  pendingInference = { model: inference.model, digest: inference.requestSha256 };
  await assert.rejects(approvals.handle(frame("model.approve", { ...inference, provider: "openai-compatible" }), live.signal), /NATIVE_DENIED/);
  await assert.rejects(approvals.handle(frame("model.approve", { ...inference, requestSha256: "b".repeat(64) }), live.signal), /NATIVE_DENIED/);
  native.answers.push("Approve this request");
  assert.deepEqual(await approvals.handle(frame("model.approve", inference), live.signal), { decision: "approve" });
  await assert.rejects(approvals.handle(frame("model.approve", inference), live.signal), /NATIVE_DENIED/);
  assert.deepEqual(await approvals.handle(frame("credential.present", { secretId: "personalKnowledge.aiApiKey" }), live.signal), { present: false });
  native.answers.push("Deny");
  await approvals.handle(frame("admission.approve"), live.signal);
  await assert.rejects(approvals.handle(read, live.signal), /NATIVE_DENIED/);
});
