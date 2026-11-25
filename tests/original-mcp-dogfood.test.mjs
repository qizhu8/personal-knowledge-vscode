import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID, sign } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rm, writeFile, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { planOriginalMcpDogfood, startOriginalMcpDogfood, verifyOriginalMcpDogfoodPlan, retireOriginalMcpDogfood } from "../experimental/original-mcp-dogfood.mjs";
import { originalMcpProfileBinding } from "../dist/original-mcp-profile-binding.js";
import { originalMcpNativeIdentity, originalMcpNativeAttestationMessage } from "../dist/original-mcp-native-identity.js";
import { generateKeyPairSync } from "node:crypto";
import { execFileSync } from "node:child_process";
import { connect } from "node:net";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

assert(process.env.PKM_TEST_WORKSPACE, "Use the isolated Linux framework.");
const hash = value => createHash("sha256").update(value).digest("hex");
const base = join(homedir(), ".local/state/pkm-v5-recovery");
const host = resolve("clients/vscode-host");

test("dogfood request refuses unknown authority fields and backup omissions before staging or original writes", async t => {
  const directory = join(base, `q-${randomBytes(4).toString("hex")}`);
  const stage = join(base, `q-${randomBytes(4).toString("hex")}`);
  await mkdir(directory, { mode: 0o700 });
  t.after(async () => {
    await rm(directory, { recursive: true, force: true });
    await rm(stage, { recursive: true, force: true });
  });
  for (const name of ["root", "profile"]) await mkdir(join(directory, name), { mode: 0o700 });
  const profile = originalMcpProfileBinding(join(directory, "profile"));
  const keys = generateKeyPairSync("ed25519");
  const identity = originalMcpNativeIdentity(keys.publicKey.export({ type: "spki", format: "der" }).toString("base64"), profile.sha256);
  await writeFile(join(profile.storageDirectory, "original-mcp-native-identity.json"), JSON.stringify(identity), { mode: 0o600 });
  const recoveryRequest = join(directory, "recovery.json");
  const recovery = { schema: "pkm.cold-state-request/v1", originalRoot: join(directory, "root"),
    externalDirectories: [{ id: "profile", path: profile.storageDirectory }], configurationFiles: [], opaqueLinks: "refuse" };
  await writeFile(recoveryRequest, JSON.stringify(recovery), { mode: 0o600 });
  const request = {
    schema: "pkm.original-mcp-dogfood-request/v1", acceptedScope: "native-dogfood/v1", root: recovery.originalRoot,
    operatorId: "isolated-dogfood-planning", nativeExtension: host, nativeStorage: profile.storageDirectory,
    runtimeExtension: host, runtimeManifestSha256: hash("fixture runtime"),
    nativeIdentitySha256: identity.sha256, recoveryRequest,
    recoveryRequestSha256: hash(await readFile(recoveryRequest)),
    custodyLimits: { maxEntries: 1000, maxDepth: 32, maxBytes: 16_777_216, maxFileBytes: 8_388_608 },
  };
  await assert.rejects(planOriginalMcpDogfood({ ...request, ready: true }, stage), { code: "DOGFOOD_REQUEST_INVALID" });
  await assert.rejects(planOriginalMcpDogfood({ ...request, acceptedScope: "preserve-existing-mcp/v1" }, stage),
    { code: "DOGFOOD_REQUEST_INVALID" });
  await assert.rejects(lstat(stage), { code: "ENOENT" });
  assert.deepEqual(await readdir(request.root), []);
  await assert.rejects(startOriginalMcpDogfood(recoveryRequest, "0".repeat(64)), { code: "DOGFOOD_PIN_CHANGED" });
});

test("dogfood freezes the verified native release outside its source and detects later staged tampering", { timeout: 60000 }, async t => {
  const directory = join(base, `q-${randomBytes(4).toString("hex")}`), stage = join(base, `q-${randomBytes(4).toString("hex")}`);
  await mkdir(directory, { mode: 0o700 });
  t.after(async () => {
    await rm(directory, { recursive: true, force: true });
    await rm(stage, { recursive: true, force: true });
  });
  for (const name of ["root", "profile"]) await mkdir(join(directory, name), { mode: 0o700 });
  const profile = originalMcpProfileBinding(join(directory, "profile")), keys = generateKeyPairSync("ed25519");
  const identity = originalMcpNativeIdentity(keys.publicKey.export({ type: "spki", format: "der" }).toString("base64"), profile.sha256);
  await writeFile(join(profile.storageDirectory, "original-mcp-native-identity.json"), JSON.stringify(identity), { mode: 0o600 });
  const recoveryRequest = join(directory, "recovery.json");
  const recovery = { schema: "pkm.cold-state-request/v1", originalRoot: join(directory, "root"),
    externalDirectories: [{ id: "profile", path: profile.storageDirectory }], configurationFiles: [], opaqueLinks: "refuse" };
  await writeFile(recoveryRequest, JSON.stringify(recovery), { mode: 0o600 });
  const request = {
    schema: "pkm.original-mcp-dogfood-request/v1", acceptedScope: "native-dogfood/v1", root: recovery.originalRoot,
    operatorId: "isolated-staged-dogfood", nativeExtension: host, runtimeExtension: host,
    runtimeManifestSha256: hash(await readFile(join(host, "next-runtime/manifest.json"))),
    nativeStorage: profile.storageDirectory, nativeIdentitySha256: identity.sha256, recoveryRequest,
    recoveryRequestSha256: hash(await readFile(recoveryRequest)),
    custodyLimits: { maxEntries: 1000, maxDepth: 32, maxBytes: 16_777_216, maxFileBytes: 8_388_608 },
  };
  const planned = await planOriginalMcpDogfood(request, stage);
  assert.equal(planned.originalRootChanged, false);
  assert.deepEqual(await readdir(request.root), []);
  await verifyOriginalMcpDogfoodPlan(planned.path, planned.sha256);
  await assert.rejects(verifyOriginalMcpDogfoodPlan(planned.path, "0".repeat(64)), { code: "DOGFOOD_PIN_CHANGED" });
  const module = join(stage, "runtime/server/dist/original-mcp-native-bootstrap.js");
  await writeFile(module, "throw new Error('must never execute tampered code');\n", { mode: 0o600 });
  await assert.rejects(startOriginalMcpDogfood(planned.path, planned.sha256), { code: "DOGFOOD_RELEASE_CHANGED" });
  assert.deepEqual(await readdir(request.root), []);
});

test("staged dogfood controller backs B0, admits signed writes, then retires without discarding the new public content", {
  timeout: 180000,
}, async t => {
  const directory = resolve("tests", `.dogfood-${randomBytes(4).toString("hex")}`);
  const stage = join(base, `q-${randomBytes(4).toString("hex")}`);
  await mkdir(directory, { mode: 0o700 });
  let active, socket, client;
  t.after(async () => {
    await client?.close(); await active?.close(); socket?.destroy();
    await rm(directory, { recursive: true, force: true });
    await rm(stage, { recursive: true, force: true });
  });
  const root = join(directory, "root"), storage = join(directory, "profile");
  for (const name of [root, join(root, "notes"), join(root, "skills"), join(root, "papers"), join(root, ".pkm"), storage])
    await mkdir(name, { mode: 0o700 });
  await writeFile(join(root, "notes/Entry.md"), "---\ntitle: Entry\n---\nOriginal content.\n", { mode: 0o600 });
  await writeFile(join(root, ".pkm/content-privacy.json"), '{"schema":1,"private":{}}', { mode: 0o600 });
  execFileSync("/usr/bin/git", ["init", "--quiet", root]);
  const profile = originalMcpProfileBinding(storage), keys = generateKeyPairSync("ed25519");
  const identity = originalMcpNativeIdentity(keys.publicKey.export({ type: "spki", format: "der" }).toString("base64"), profile.sha256);
  await writeFile(join(storage, "original-mcp-native-identity.json"), JSON.stringify(identity), { mode: 0o600 });
  const recoveryRequest = join(directory, "recovery.json");
  await writeFile(recoveryRequest, JSON.stringify({
    schema: "pkm.cold-state-request/v1", originalRoot: root, externalDirectories: [{ id: "profile", path: storage }],
    configurationFiles: [], opaqueLinks: "refuse",
  }), { mode: 0o600 });
  const request = {
    schema: "pkm.original-mcp-dogfood-request/v1", acceptedScope: "native-dogfood/v1", root,
    operatorId: "isolated-staged-writable-dogfood", nativeExtension: host, runtimeExtension: host,
    runtimeManifestSha256: hash(await readFile(join(host, "next-runtime/manifest.json"))),
    nativeStorage: storage, nativeIdentitySha256: identity.sha256, recoveryRequest,
    recoveryRequestSha256: hash(await readFile(recoveryRequest)),
    custodyLimits: { maxEntries: 1000, maxDepth: 32, maxBytes: 16_777_216, maxFileBytes: 8_388_608 },
  };
  const planned = await planOriginalMcpDogfood(request, stage);
  active = await startOriginalMcpDogfood(planned.path, planned.sha256);
  assert.equal(active.businessReady, false);
  const completing = active.complete();
  const pointer = JSON.parse(await readFile(active.pointerPath));
  const descriptor = JSON.parse(await readFile(pointer.descriptorPath));
  const protocol = await import(pathToFileURL(join(stage, "runtime/server/dist/original-mcp-native-request.js")).href);
  let input = "", session;
  socket = connect(descriptor.socketPath);
  const send = value => socket.write(JSON.stringify(value) + "\n");
  socket.on("error", () => {});
  socket.on("data", chunk => {
    input += chunk.toString();
    for (let end; (end = input.indexOf("\n")) !== -1;) {
      const frame = JSON.parse(input.slice(0, end)); input = input.slice(end + 1);
      if (frame.type === "challenge") {
        const { body, message } = originalMcpNativeAttestationMessage(frame.challenge, identity.sha256, randomUUID());
        send({ type: "attestation", attestation: { ...body, signature: sign(null, message, keys.privateKey).toString("base64") } });
      } else if (frame.type === "attached") {
        session = { brokerId: frame.brokerId, activationId: frame.activationId, identitySha256: identity.sha256,
          epoch: frame.activationId, binding: descriptor.binding };
        send({ type: "native-supports", protocol: protocol.originalMcpNativeRequestProtocol, session, maxPacketBytes: 65536,
          methods: ["admission.approve", "public.approve", "tool.approve", "tool.review", "credential.present"] });
      } else if (frame.type === "ping") send({ type: "pong", nonce: frame.nonce });
      else if (frame.type === "native-request")
        send(protocol.originalMcpNativeResult(frame, frame.method === "credential.present" ? { present: false } : { decision: "approve" }));
    }
  });
  const business = await completing;
  const target = JSON.parse(await readFile(business.target.path));
  client = new Client({ name: "staged-dogfood-fixture", version: "1" });
  await client.connect(new StdioClientTransport({ command: target.command.path, args: [target.entry.path, ...target.args], stderr: "pipe" }));
  const retrieved = await client.callTool({ name: "retrieval_search",
    arguments: { query: "Original", limit: 10, route: "lexical" } });
  assert.notEqual(retrieved.isError, true, JSON.stringify(retrieved));
  assert.notEqual((await client.callTool({ name: "note_modify",
    arguments: { slug: "Entry", content: "Retained through full staged retirement.\n" } })).isError, true);
  await client.close();
  await active.close();
  const retired = await retireOriginalMcpDogfood(planned.path, planned.sha256, active.executionPath, active.executionSha256);
  assert.equal(retired.publicUpdatesRetainedInPlace, true);
  assert.equal(retired.legacyConnectionVerified, false);
  assert.match(await readFile(join(root, "notes/Entry.md"), "utf8"), /full staged retirement/);
  await assert.rejects(lstat(join(root, "core.sqlite")), { code: "ENOENT" });
  await assert.rejects(lstat(active.pointerPath), { code: "ENOENT" });
  assert.equal((await lstat(join(retired.archive, "core.sqlite"))).isFile(), true);
  await unlink(join(active.execution, "retirement-ticket.json"));
  const resumed = await retireOriginalMcpDogfood(planned.path, planned.sha256, active.executionPath, active.executionSha256);
  assert.equal(resumed.archive, retired.archive);
  assert.match(await readFile(join(root, "notes/Entry.md"), "utf8"), /full staged retirement/);
});
