import * as vscode from "vscode";
import { createHash } from "node:crypto";
import Module from "node:module";
import { lstat, mkdir, readFile, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ChatRoomCredentialStore } from "../../legacy/src/chatroom/chat-room-credentials.js";
import { originalMcpNativeSigner } from "./original-mcp-native-identity.js";
import { originalNativeRoomSessionSchema, type OriginalNativeRoomSession } from "../../src/original-mcp-native-room-contracts.js";
import { originalRoomSessionEffectSchema } from "../../src/original-mcp-room-session-contracts.js";
import { startNativeOwnedOriginalRoomSession } from "./original-mcp-native-room-session-hub.js";

function fail(code: string): never { throw Object.assign(new Error(code), { code }); }
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

/** Actual installed producer leaf. Parent dispatch must remain on the authenticated signed attachment. */
export async function createOriginalMcpNativeRoomSessionProducer(context: vscode.ExtensionContext, options: {
  session: OriginalNativeRoomSession; effect: unknown; persistence: unknown; signal: AbortSignal; assertCurrent(): void;
}) {
  const signer = await originalMcpNativeSigner(context), session = originalNativeRoomSessionSchema.parse(options.session);
  const effect = originalRoomSessionEffectSchema.parse(options.effect);
  const lifetime = new AbortController();
  const current = () => {
    try {
      signer.assertCurrent();
      const asserted = options.assertCurrent() as unknown;
      if (asserted !== undefined) {
        if (asserted && (typeof asserted === "object" || typeof asserted === "function") && "then" in asserted)
          void Promise.resolve(asserted).catch(() => {});
        fail("ROOM_SESSION_NATIVE_SYNCHRONOUS_GUARD_REQUIRED");
      }
      if (options.signal.aborted || signer.signal.aborted || session.activationId !== signer.activationId
        || effect.nativeEpoch !== session.activationId || session.identitySha256 !== signer.identity.sha256
        || session.epoch !== signer.activationId || session.binding.profileSha256 !== signer.identity.profileSha256
        || session.binding.payloadBuildId !== signer.payloadBuildId || session.binding.hostEntrySha256 !== signer.hostEntrySha256
        || effect.root !== session.binding.root || effect.workspaceId !== session.binding.workspaceId
        || effect.profileSha256 !== session.binding.profileSha256 || effect.custodyPlanSha256 !== session.binding.planSha256
        || effect.expiresAtMs <= Date.now() || effect.expiresAtMs > Date.now() + 30000
        || effect.currentHostProofExpiresAtMs > Date.now() + 30000) fail("ROOM_SESSION_NATIVE_BINDING_REQUIRED");
    } catch (error) { lifetime.abort(); throw error; }
  };
  current();
  const credentials = new ChatRoomCredentialStore(context.secrets);
  if (!await credentials.verifyHost(effect.roomId, effect.hostCredentialHash)) fail("ROOM_SESSION_CURRENT_NATIVE_CREDENTIALS_REQUIRED");
  const cancellation = AbortSignal.any([options.signal, signer.signal,
    AbortSignal.timeout(Math.max(1, effect.expiresAtMs - Date.now()))]);
  const prompt = vscode.window.showWarningMessage("Open this exact single-client loopback Room session?", {
    modal: true, detail: JSON.stringify({ session, effect, permission:
      "Separate network/rehost/new-participant/client effect consent. Bind ONLY this exact loopback port, keep the original Host offline and unchanged, create one NEW temporary agent identity, allow one exact progress post and read/status/leave. No old PID/CID/participant rebind, remote network, commands, other PKM tool or model execution, private Note projection, or credential export. Source and Host custody alone did not authorize this." }, null, 2),
  }, "Open this exact loopback Room session", "Deny");
  const answer = await new Promise<string | undefined>((resolve, reject) => {
    const aborted = () => reject(Object.assign(new Error("ROOM_SESSION_NATIVE_EFFECT_CANCELLED"), { code: "ROOM_SESSION_NATIVE_EFFECT_CANCELLED" }));
    cancellation.addEventListener("abort", aborted, { once: true });
    Promise.resolve(prompt).then(resolve, reject).finally(() => cancellation.removeEventListener("abort", aborted));
    if (cancellation.aborted) aborted();
  });
  current();
  if (answer !== "Open this exact loopback Room session") fail("ROOM_SESSION_NATIVE_EFFECT_DENIED");
  const resources = join(context.extensionPath, "next-runtime/server/legacy/resources");
  const retainedPath = join(context.extensionPath, "next-runtime/server/dist/legacy-chatroom-retained.cjs");
  const manifest = JSON.parse(await readFile(join(context.extensionPath, "next-runtime/manifest.json"), "utf8"));
  const template = await readFile(join(resources, "chat_server.py.template")), guard = await readFile(join(resources, "mcp_call_guard.py"));
  const retainedBytes = await readFile(retainedPath);
  if (sha(template) !== "0834131c634962e3526540eac35fdba35beb28cefa6de1f17dce8ac586e4a722"
    || manifest.files["server/legacy/resources/chat_server.py.template"] !== sha(template)
    || manifest.files["server/legacy/resources/mcp_call_guard.py"] !== sha(guard)
    || manifest.files["server/dist/legacy-chatroom-retained.cjs"] !== sha(retainedBytes))
    fail("ROOM_SESSION_NATIVE_RETAINED_PAYLOAD_CHANGED");
  current();
  const Loader = Module as typeof Module & { _nodeModulePaths(path: string): string[] };
  const retained = new Loader(retainedPath) as Module & { _compile(source: string, path: string): void };
  retained.filename = retainedPath; retained.paths = Loader._nodeModulePaths(dirname(retainedPath));
  retained._compile(retainedBytes.toString("utf8"), retainedPath);
  const directory = join(context.globalStorageUri.fsPath, "native-room-sessions");
  await mkdir(directory, { mode: 0o700, recursive: true });
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(directory) !== directory
    || stat.uid !== process.getuid!() || stat.mode & 0o077) fail("ROOM_SESSION_NATIVE_PRIVATE_DIRECTORY_REQUIRED");
  const changed = context.secrets.onDidChange(event => {
    if (event.key === `personalKnowledge.chatroom.${effect.roomId}.host` || event.key === `personalKnowledge.chatroom.${effect.roomId}.join`)
      lifetime.abort();
  });
  try {
    const native = await startNativeOwnedOriginalRoomSession({
      effect, persistence: options.persistence, credentials, retained: retained.exports, resources: { template, guard },
      workDirectory: join(directory, effect.sessionId), signal: AbortSignal.any([lifetime.signal, options.signal, signer.signal]),
    });
    context.subscriptions.push({ dispose() { lifetime.abort(); changed.dispose(); } });
    return Object.freeze({ ...native, async invoke(callId: string, call: unknown) {
      current(); const result = await native.invoke(callId, call); current(); return result;
    }, async invokeUserJoin(callId: string, args: unknown, intent: unknown) {
      current(); const result = await native.invokeUserJoin(callId, args, intent); current(); return result;
    }, async close() {
      try { await native.close(); } finally { lifetime.abort(); changed.dispose(); }
    } });
  } catch (error) { lifetime.abort(); changed.dispose(); throw error; }
}
