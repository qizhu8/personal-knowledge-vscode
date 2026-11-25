import assert from "node:assert/strict";
import test from "node:test";
import Module, { createRequire } from "node:module";
import { randomUUID, createHash } from "node:crypto";
import { mkdir, copyFile, writeFile, readFile, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { originalPortalRequestDigest } from "../../dist/original-mcp-portal-contracts.js";
const require = createRequire(import.meta.url);
const built = await require("esbuild").build({ entryPoints: [fileURLToPath(new URL("original-mcp-native-portal.ts", import.meta.url))],
  bundle: true, platform: "node", format: "cjs", external: ["vscode"], write: false, logLevel: "silent" });

test("registered native Portal UI uses only current workspace-prefixed endpoint storage and disposes commands before reattachment", async t => {
  const directory = resolve(".pkm-test-evidence", `portal-native-ui-${randomUUID()}`), epoch = randomUUID();
  await mkdir(join(directory, "next-runtime/server/dist"), { recursive: true });
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = fileURLToPath(new URL("../../dist/legacy-chatroom-retained.cjs", import.meta.url));
  const target = join(directory, "next-runtime/server/dist/legacy-chatroom-retained.cjs");
  await copyFile(source, target);
  await writeFile(join(directory, "next-runtime/manifest.json"), JSON.stringify({ files: {
    "server/dist/legacy-chatroom-retained.cjs": createHash("sha256").update(await readFile(target)).digest("hex") } }));
  const commands = new Map(), state = new Map(), secrets = new Map();
  const vscode = { workspace: { isTrusted: true }, commands: { registerCommand(id, callback) {
    assert(!commands.has(id), "Reattachment must not register duplicate or stale command IDs.");
    commands.set(id, callback); return { dispose() { commands.delete(id); } };
  } }, window: { async showQuickPick() { return "Saved Controller"; }, async showInputBox() { return "Current native endpoint"; } } };
  const context = { extensionPath: directory, subscriptions: [], workspaceState: {
    get: key => state.get(key), async update(key, value) { state.set(key, structuredClone(value)); },
  }, secrets: { async get(key) { return secrets.get(key); }, async store(key, value) { secrets.set(key, value); },
    async delete(key) { secrets.delete(key); } } };
  const module = new Module("portal-native-ui.cjs");
  module.filename = "portal-native-ui.cjs"; module.paths = [];
  module.require = name => name === "vscode" ? vscode : require(name);
  module._compile(built.outputFiles[0].text, module.filename);
  const factory = () => module.exports.createOriginalMcpNativePortalConsent({ assertCurrent() {}, activationId: epoch, context });
  const workspaceId = randomUUID(), brokerId = randomUUID();
  const session = { brokerId, activationId: epoch, epoch, identitySha256: "a".repeat(64), binding: {
    root: directory, workspaceId, planSha256: "b".repeat(64), profileSha256: "c".repeat(64),
    catalogSha256: "d".repeat(64), payloadBuildId: "e".repeat(64), hostEntrySha256: "f".repeat(64) } };
  const binding = { schema: "pkm.original-mcp-native-host-admission/v1", root: directory, workspaceId,
    epoch, actorId: "mcp:external", authorityId: `native-rpc:${brokerId}`, planSha256: session.binding.planSha256,
    profileSha256: session.binding.profileSha256, sourceCatalogSha256: session.binding.catalogSha256,
    configurationSha256: "a".repeat(64), domains: ["mcp-public"] };
  const frame = phase => {
    const request = { phase, contextId: "", pairId: "", revision: 0, detail: {} };
    return { method: "portal.local.approve", session, payload: { binding, request, requestSha256: originalPortalRequestDigest(request) } };
  };
  const signal = new AbortController().signal, first = factory();
  const created = await first.handle(frame("open"), signal);
  assert.equal(created.endpoint.name, "Current native endpoint");
  assert.equal(created.endpoint.root, directory); assert.equal(commands.size, 2);
  assert([...state.keys()].every(key => key.startsWith(`pkm.native.portal.${workspaceId}.`)));
  assert.equal(secrets.size, 0, "Naming an endpoint never inherits or manufactures a pairing credential.");
  await first.handle(frame("endpoints"), signal);
  assert.equal(commands.size, 2);
  first.dispose(); assert.equal(commands.size, 0);
  await assert.rejects(first.handle(frame("endpoints"), signal), /PORTAL_NATIVE_SOURCE_DISPOSED/);
  const second = factory();
  assert.equal((await second.handle(frame("endpoints"), signal)).endpoints.length, 1);
  assert.equal(commands.size, 2);
  second.dispose(); assert.equal(commands.size, 0);
});
