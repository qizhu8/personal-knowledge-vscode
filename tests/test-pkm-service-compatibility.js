const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const { randomUUID } = require("node:crypto");
const root = process.env.PKM_SERVICE_TEST_EXTENSION_ROOT || path.resolve(__dirname, "..");
const { PkmServiceClient, pkmServiceIdentity, PKM_SERVICE_PROTOCOL } = require(path.join(root, "dist/runtime/pkm-service"));

function encode(value) {
  if (value === undefined) return { $pkm:"undefined" };
  if (Array.isArray(value)) return value.map(encode);
  return value && typeof value === "object"
    ? { $pkm:"object", entries:Object.entries(value).map(([key, item]) => [key, encode(item)]) } : value;
}
function decode(value) {
  if (Array.isArray(value)) return value.map(decode);
  if (value?.$pkm === "undefined") return undefined;
  return value?.$pkm === "object" ? Object.fromEntries(value.entries.map(([key, item]) => [key, decode(item)])) : value;
}

async function fixture(t, { legacy = false, wrongProtocol = false, methods } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-service-compat-"));
  const options = { globalStoragePath:path.join(directory, "storage"), knowledgeRoot:path.join(directory, "knowledge"),
    extensionVersion:"3.2.103", execute:async () => {} };
  fs.mkdirSync(options.knowledgeRoot);
  const identity = pkmServiceIdentity(options);
  fs.mkdirSync(identity.serviceDirectory, { recursive:true, mode:0o700 });
  if (identity.ipcDirectory) fs.mkdirSync(identity.ipcDirectory, { recursive:true, mode:0o700 });
  const metadata = { ...identity, protocol:PKM_SERVICE_PROTOCOL, extensionVersion:"3.2.104", pid:process.pid, nonce:randomUUID() };
  const calls = [], sockets = new Set();
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    let buffered = Buffer.alloc(0);
    socket.on("data", chunk => {
      buffered = Buffer.concat([buffered, chunk]);
      while (buffered.length >= 4 && buffered.length >= 4 + buffered.readUInt32BE(0)) {
        const length = buffered.readUInt32BE(0);
        const message = decode(JSON.parse(buffered.subarray(4, 4 + length).toString()));
        buffered = buffered.subarray(4 + length);
        calls.push(message);
        const value = message.method === "health" ? {
          pid:metadata.pid, nonce:metadata.nonce, extensionVersion:metadata.extensionVersion,
          ...(legacy ? {} : { capabilities:{ methods:methods || ["health", "register", "configure"] } }),
        } : message.method === "register" ? {} : null;
        const error = legacy && message.method !== "health" && message.extensionVersion !== metadata.extensionVersion
          ? { name:"PkmServiceVersionError", requiredVersion:metadata.extensionVersion, installedVersion:message.extensionVersion }
          : undefined;
        const body = Buffer.from(JSON.stringify(encode({ ...metadata,
          protocol:wrongProtocol ? "pkm-github-sync/2" : PKM_SERVICE_PROTOCOL,
          kind:"response", id:message.id, value, error })));
        const header = Buffer.alloc(4); header.writeUInt32BE(body.length);
        socket.write(Buffer.concat([header, body]));
      }
    });
  });
  await new Promise(resolve => server.listen(identity.endpoint, resolve));
  if (identity.ipcDirectory) fs.chmodSync(identity.endpoint, 0o600);
  fs.writeFileSync(path.join(identity.serviceDirectory, "endpoint.json"), JSON.stringify(metadata), { mode:0o600 });
  const clients = [];
  t.after(async () => {
    for (const client of clients) client.dispose();
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(directory, { recursive:true, force:true });
  });
  return { calls, options, async connect(extra) {
    const client = await PkmServiceClient.connect({ ...options, ...extra });
    clients.push(client);
    return client;
  } };
}

test("different versions share protocol; unsupported features fail before submission, not the whole connection", async t => {
  const f = await fixture(t);
  const warnings = [], errors = [];
  const client = await f.connect({ onCompatibilityWarning:message => warnings.push(message), onError:error => errors.push(error) });
  await client.configure([]);
  await assert.rejects(client.listRecoverableResults(), /does not support 'listRecoverableResults'/);
  await client.configure([]);
  assert.equal(warnings.length, 1);
  assert.equal(errors.length, 0);
  assert.equal(f.calls.filter(call => call.method === "configure").length, 2);
  assert(!f.calls.some(call => call.method === "listRecoverableResults"), "unsupported operation was never sent or retried");
});

test("legacy protocol-v1 exact-version registration uses its wire adapter without hiding the actual host version", async t => {
  const f = await fixture(t, { legacy:true });
  const client = await f.connect({ onCompatibilityWarning:() => {} });
  await client.configure([]);
  const registration = f.calls.find(call => call.method === "register");
  assert.equal(registration.extensionVersion, "3.2.104");
  assert.equal(registration.value.clientVersion, "3.2.103");
  assert.equal(f.calls.filter(call => call.method === "health").length, 2);
});

test("a genuinely different wire protocol remains an explicit failure", async t => {
  const f = await fixture(t, { wrongProtocol:true });
  await assert.rejects(f.connect({ onError:() => {} }), /identity\/protocol\/version validation failed/);
  assert(!f.calls.some(call => call.method === "register"));
});

test("malformed capability advertisements cannot be treated as a compatible service", async t => {
  const f = await fixture(t, { methods:["health", 12] });
  await assert.rejects(f.connect({ onError:() => {} }), /invalid protocol capability contract/);
  assert(!f.calls.some(call => call.method === "configure"));
});

test("new client orchestrates a real previous-installation service through the protocol-v1 adapter",
  { skip:!process.env.PKM_LEGACY_SERVICE_EXTENSION_ROOT }, async t => {
    const legacyRoot = process.env.PKM_LEGACY_SERVICE_EXTENSION_ROOT;
    const legacy = require(path.join(legacyRoot, "dist/runtime/pkm-service"));
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-legacy-service-"));
    fs.mkdirSync(path.join(directory, "knowledge"));
    const options = { globalStoragePath:path.join(directory, "storage"), knowledgeRoot:path.join(directory, "knowledge"),
      extensionVersion:require(path.join(legacyRoot, "package.json")).version,
      serviceEntryPath:path.join(legacyRoot, "dist/runtime/pkm-service.js") };
    const runtime = await legacy.startPkmService(options);
    let client, executions = 0;
    t.after(async () => {
      if (client) { await client.drain(); client.dispose(); }
      await runtime.stopped;
      fs.rmSync(directory, { recursive:true, force:true });
    });
    client = await PkmServiceClient.connect({ ...options, extensionVersion:"8.0.0",
      onCompatibilityWarning:() => {},
      execute:async (targetId, reason, fence) => {
        assert.equal(targetId, "legacy");
        assert.equal(reason, "manual");
        assert(fence > 0);
        executions++;
      } });
    await client.configure([{ id:"legacy", enabled:false, intervalMinutes:1440, syncOnChange:false }]);
    assert(await client.request("legacy", "manual"));
    const deadline = Date.now() + 5000;
    while (!executions && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(executions, 1, "the real legacy service admitted exactly one new-host callback");
  });
