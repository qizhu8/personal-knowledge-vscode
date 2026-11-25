import assert from "node:assert/strict";
import Module, { createRequire } from "node:module";
import { generateKeyPairSync, randomBytes, randomUUID, sign } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { connect } from "node:net";
import { join, resolve } from "node:path";
import { startOriginalMcpNativeAttachmentServer } from "../../dist/original-mcp-native-attachment.js";
import { originalMcpNativeIdentity, originalMcpNativeAttestationMessage } from "../../dist/original-mcp-native-identity.js";
import { originalMcpNativeRequestProtocol, originalMcpNativeRequestSession, parseOriginalMcpNativeRequest,
  originalMcpNativeResult, originalMcpNativeErrorResult, waitForOriginalMcpNativeSupport } from "../../dist/original-mcp-native-request.js";
import { isOriginalNativeActionMethod } from "../../dist/original-mcp-native-action-contracts.js";
import { isNativeActionPackageMethod } from "../../dist/original-mcp-action-package-native-contracts.js";

const require = createRequire(import.meta.url);
const built = await require("esbuild").build({
  entryPoints: [resolve("clients/vscode-host/original-mcp-native-action.ts")],
  bundle: true, platform: "node", format: "cjs", external: ["vscode"], write: false, logLevel: "silent",
  plugins: [{ name: "explicit-package-display-signer", setup(plugin) {
    plugin.onResolve({ filter: /original-mcp-native-identity\.js$/ },
      () => ({ path: "package-display-signer", external: true }));
  } }],
});

export async function signedActionPackageClient(storage, plan, catalogSha256, external = {}) {
  const directory = resolve("tests", `.p-${randomBytes(4).toString("hex")}`);
  await mkdir(directory, { mode: 0o700 });
  const keys = external.keys ?? generateKeyPairSync("ed25519");
  const identity = external.identity ?? originalMcpNativeIdentity(keys.publicKey.export({ format: "der", type: "spki" }).toString("base64"),
    plan.profileSha256);
  const binding = { root: plan.root, workspaceId: await storage.workspaceId(), planSha256: plan.planSha256,
    catalogSha256, profileSha256: plan.profileSha256, payloadBuildId: "b".repeat(64), hostEntrySha256: "c".repeat(64) };
  const server = external.descriptor ? undefined
    : await startOriginalMcpNativeAttachmentServer({ directory, identity, identitySha256: identity.sha256,
      binding, maxPacketBytes: 65536, heartbeatIntervalMs: 100, heartbeatTimeoutMs: 3000 });
  const lifetime = new AbortController();
  const socket = connect(external.descriptor?.socketPath ?? join(directory, "n")),
    requests = [], prompts = [], controllers = new Map(), commands = new Map();
  let session, producer, input = "", attachedResolve, closing;
  const wireSession = () => server ? originalMcpNativeRequestSession(session) : {
    brokerId: session.brokerId, activationId: session.activationId, epoch: session.activationId,
    identitySha256: session.identitySha256, binding: session.binding,
  };
  const ui = { open: undefined, save: undefined, approve: true, beforeApprove: undefined };
  const close = () => closing ??= (async () => {
    producer?.dispose(); lifetime.abort(); socket.destroy(); await server?.close(); await rm(directory, { recursive: true, force: true });
  })();
  storage.retainNativeCleanup({ release: close });
  const attached = new Promise(resolve => { attachedResolve = resolve; });
  const send = frame => socket.write(JSON.stringify(frame) + "\n");
  socket.on("error", () => socket.destroy());
  socket.on("data", bytes => {
    input += bytes.toString("utf8");
    for (let boundary; (boundary = input.indexOf("\n")) >= 0;) {
      const frame = JSON.parse(input.slice(0, boundary)); input = input.slice(boundary + 1);
      if (frame.type === "challenge") {
        const { body, message } = originalMcpNativeAttestationMessage(frame.challenge, identity.sha256, randomUUID());
        send({ type: "attestation", attestation: { ...body, signature: sign(null, message, keys.privateKey).toString("base64") } });
      } else if (frame.type === "attached") {
        if (!server) session = { brokerId: frame.brokerId, activationId: frame.activationId, epoch: frame.activationId,
          identitySha256: identity.sha256, binding: external.descriptor.binding, signal: lifetime.signal,
          assertCurrent() { lifetime.signal.throwIfAborted(); } };
        attachedResolve();
      }
      else if (frame.type === "ping") send({ type: "pong", nonce: frame.nonce });
      else if (frame.type === "native-cancel") controllers.get(frame.requestId)?.abort();
      else if (frame.type === "native-request") {
        const request = parseOriginalMcpNativeRequest(frame, wireSession());
        requests.push(request);
        const controller = new AbortController(); controllers.set(request.requestId, controller);
        void Promise.resolve().then(() => isOriginalNativeActionMethod(request.method) || isNativeActionPackageMethod(request.method)
          ? producer.handle(request.method, request.payload, request.requestId, controller.signal)
          : { decision: "approve" }).then(result => send(originalMcpNativeResult(request, result)),
          () => send(originalMcpNativeErrorResult(request, controller.signal.aborted ? "NATIVE_REQUEST_CANCELLED" : "NATIVE_DENIED")))
          .finally(() => controllers.delete(request.requestId));
      }
    }
  });
  await attached;
  if (server) session = await server.waitForSession({ timeoutMs: 3000 });
  const signer = { activationId: session.activationId, identity, payloadBuildId: binding.payloadBuildId,
    hostEntrySha256: binding.hostEntrySha256, signal: session.signal, assertCurrent: () => session.assertCurrent() };
  const load = Module._load;
  let api;
  try {
    Module._load = function (id, ...rest) {
      if (id === "package-display-signer") return { originalMcpNativeSigner: async () => signer };
      if (id === "vscode") return {
        Uri: { file: fsPath => ({ fsPath }) }, StatusBarAlignment: { Left: 1 },
        commands: { registerCommand(id, callback) {
          commands.set(id, callback); return { dispose() { commands.delete(id); } };
        } },
        workspace: { isTrusted: true, onDidChangeWorkspaceFolders() { return { dispose() {} }; } },
        window: {
          async showWarningMessage(title, options, ...choices) {
            const prompt = { title, detail: JSON.parse(options.detail) }; prompts.push(prompt);
            await ui.beforeApprove?.(prompt);
            return ui.approve ? choices[0] : undefined;
          },
          async showOpenDialog(options) {
            const fsPath = ui.open === undefined ? options.defaultUri.fsPath : ui.open;
            return fsPath === null ? undefined : [{ fsPath }];
          },
          async showSaveDialog(options) {
            const fsPath = ui.save === undefined ? options.defaultUri.fsPath : ui.save;
            return fsPath === null ? undefined : { fsPath };
          },
          createStatusBarItem() { return { show() {}, dispose() {} }; },
        },
      };
      return load.call(this, id, ...rest);
    };
    const filename = resolve("tests", `.package-display-memory-${randomUUID()}.cjs`), memory = new Module(filename);
    memory.filename = filename; memory.paths = Module._nodeModulePaths(resolve("tests"));
    memory._compile(built.outputFiles[0].text, filename); api = memory.exports;
  } finally { Module._load = load; }
  producer = await api.createOriginalMcpNativeActionProducer({ subscriptions: [] }, {
    session: wireSession(), signal: session.signal, assertCurrent: () => session.assertCurrent(),
  });
  assert.equal(await producer.enable(), true);
  send({ type: "native-supports", protocol: originalMcpNativeRequestProtocol, session: wireSession(),
    methods: ["admission.approve", "public.approve", ...producer.methods], maxPacketBytes: 65536 });
  if (server) await waitForOriginalMcpNativeSupport(session, { timeoutMs: 3000 });
  return { session, producer, requests, prompts, ui, close,
    revoke() {
      const command = [...commands].find(([id]) => id.startsWith("personalKnowledge.revokeNativeActions."));
      assert(command); command[1]();
    } };
}
