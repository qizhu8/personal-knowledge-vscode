import * as vscode from "vscode";
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomUUID, sign, type KeyObject } from "node:crypto";
import { constants, readFileSync, realpathSync } from "node:fs";
import { mkdir, open, lstat, unlink } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { originalMcpExtensionId, originalMcpProfileBinding } from "../../src/original-mcp-profile-binding.js";
import {
  originalMcpNativeIdentity, verifyOriginalMcpNativeIdentity, originalMcpNativeChallenge,
  originalMcpNativeAttestationMessage, type OriginalMcpNativeAttestation, type OriginalMcpNativeIdentity,
} from "../../src/original-mcp-native-identity.js";
import { renameNoReplace } from "../../src/rename-no-replace.js";

const fileName = "original-mcp-native-identity.json";
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const identities = new WeakMap<vscode.ExtensionContext, Promise<OriginalMcpNativeSigner>>();
type OriginalMcpNativeSigner = Awaited<ReturnType<typeof createSigner>>;
function unavailable(message: string): never { throw new Error(`NATIVE_IDENTITY_UNAVAILABLE: ${message}`); }

function nativeContext(context: vscode.ExtensionContext) {
  const extensionPath = resolve(__dirname, ".."), current = vscode.extensions.getExtension(originalMcpExtensionId);
  if (process.platform !== "linux" || context.extensionMode !== vscode.ExtensionMode.Production
    || context.extension.id !== originalMcpExtensionId || !current?.isActive || !vscode.workspace.isTrusted
    || context.extensionPath !== extensionPath || current.extensionPath !== extensionPath
    || realpathSync(extensionPath) !== extensionPath)
    return unavailable("A trusted installed native v5 activation is required.");
  const activation: unknown = current.exports;
  if (!activation || typeof activation !== "object" || !("assertActiveMigrationContext" in activation)
    || typeof activation.assertActiveMigrationContext !== "function")
    return unavailable("The actual extension activation is unavailable.");
  activation.assertActiveMigrationContext(context);
  const require = createRequire(join(extensionPath, "package.json"));
  const verifier: { verifyNextPayload(path: string): { buildId: string } } =
    require(join(extensionPath, "next-runtime/server/legacy/dist/runtime/next-payload-verifier.js"));
  const payload = verifier.verifyNextPayload(extensionPath);
  if (!/^[a-f0-9]{64}$/.test(payload.buildId)) return unavailable("The installed native payload is unverified.");
  const assertActive = activation.assertActiveMigrationContext;
  return {
    activation, assertActive: () => assertActive.call(activation, context), payloadBuildId: payload.buildId,
    payloadManifestSha256: hash(readFileSync(join(extensionPath, "next-runtime/manifest.json"))),
    hostEntrySha256: hash(readFileSync(join(extensionPath, "dist/extension.cjs"))),
  };
}

async function publicRecord(path: string): Promise<unknown | undefined> {
  let file;
  try { file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  try {
    const before = await file.stat({ bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size > 4096n || (before.mode & 0o7177n) !== 0n
      || process.getuid === undefined || before.uid !== BigInt(process.getuid()))
      return unavailable("The public native identity file is unsafe.");
    const bytes = await file.readFile(), after = await file.stat({ bigint: true }), named = await lstat(path, { bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino || before.mtimeNs !== after.mtimeNs
      || before.ctimeNs !== after.ctimeNs || named.dev !== before.dev || named.ino !== before.ino
      || BigInt(bytes.length) !== before.size) return unavailable("The native identity changed during inspection.");
    return JSON.parse(bytes.toString("utf8"));
  } finally { await file.close(); }
}

function privateKey(value: string) {
  try {
    if (value.length > 1024) return unavailable("The native signing key is invalid; it was not replaced.");
    const key = createPrivateKey(value);
    if (key.asymmetricKeyType !== "ed25519") return unavailable("The native signing key has the wrong type.");
    return key;
  } catch {
    return unavailable("The native signing key cannot be read. Restore or explicitly re-enroll its identity; no automatic replacement occurred.");
  }
}

async function createSigner(context: vscode.ExtensionContext) {
  const initial = nativeContext(context), directory = context.globalStorageUri.fsPath;
  const path = join(directory, fileName);
  const found = await publicRecord(path);
  if (found === undefined) {
    const answer = await vscode.window.showWarningMessage(
      `Enroll a separate PKM v5 native identity for ${directory}?\nOnly a new signing key is stored in this extension's SecretStorage. Old extension credentials are not read or copied. This does not activate the library or approve model/tool calls.`,
      { modal: true }, "Enroll native identity");
    if (answer !== "Enroll native identity") throw new Error("NATIVE_IDENTITY_DECLINED: Enrollment cancelled; no credentials changed.");
    nativeContext(context);
    if (realpathSync(dirname(directory)) !== dirname(directory)) return unavailable("The profile parent is not canonical.");
    try { await mkdir(directory, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  }
  const profile = originalMcpProfileBinding(directory);
  let candidate: { publicKey: KeyObject; privateKey: KeyObject } | undefined;
  let identity: OriginalMcpNativeIdentity;
  if (found !== undefined) {
    if (!found || typeof found !== "object" || !("publicKey" in found) || typeof found.publicKey !== "string")
      return unavailable("The existing public identity is invalid; it was not overwritten.");
    identity = originalMcpNativeIdentity(found.publicKey, profile.sha256);
    verifyOriginalMcpNativeIdentity(found, identity.sha256, profile.sha256);
  } else {
    candidate = generateKeyPairSync("ed25519");
    identity = originalMcpNativeIdentity(candidate.publicKey.export({ format: "der", type: "spki" }).toString("base64"), profile.sha256);
  }
  const secretId = `pkm.originalMcp.nativeIdentity.v1.${profile.sha256}.${identity.keyId}`;
  let secret = await context.secrets.get(secretId);
  if (!secret) {
    if (!candidate) return unavailable("The enrolled signing key is absent. The existing public identity was not overwritten.");
    secret = candidate.privateKey.export({ format: "pem", type: "pkcs8" }).toString();
    await context.secrets.store(secretId, secret);
  }
  const key = privateKey(secret);
  if (createPublicKey(secret).export({ format: "der", type: "spki" }).toString("base64") !== identity.publicKey)
    return unavailable("The native signing key does not match the enrolled public identity.");
  if (found === undefined) {
    const temporary = join(directory, `.native-identity-${randomUUID()}.partial`);
    const file = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    try { await file.writeFile(`${JSON.stringify(identity)}\n`); await file.sync(); } finally { await file.close(); }
    try { await renameNoReplace(temporary, path); }
    finally { await unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; }); }
    const parent = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY);
    try { await parent.sync(); } finally { await parent.close(); }
  }
  const activationId = randomUUID(), lifetime = new AbortController();
  const revoke = () => lifetime.abort();
  const subscription = context.secrets.onDidChange(event => {
    if (event.key !== secretId) return;
    // The initial store notification can arrive after enrollment completes.
    void context.secrets.get(secretId).then(value => { if (value !== secret) revoke(); }, () => {
      revoke();
      console.error("Native identity credential revalidation failed; activation revoked.");
    });
  });
  const dispose = () => { revoke(); subscription.dispose(); };
  context.subscriptions.push({ dispose });
  function assertCurrent() {
    try {
      const current = vscode.extensions.getExtension(originalMcpExtensionId);
      if (lifetime.signal.aborted || !vscode.workspace.isTrusted || !current?.isActive || current.exports !== initial.activation
        || context.extensionPath !== resolve(__dirname, "..") || context.globalStorageUri.fsPath !== directory
        || originalMcpProfileBinding(directory).sha256 !== profile.sha256
        || hash(readFileSync(join(context.extensionPath, "next-runtime/manifest.json"))) !== initial.payloadManifestSha256
        || hash(readFileSync(join(context.extensionPath, "dist/extension.cjs"))) !== initial.hostEntrySha256)
        return unavailable("The native activation, profile or installed entrypoint changed.");
      initial.assertActive();
    } catch (error) { revoke(); throw error; }
  }
  return Object.freeze({
    identity, activationId, path, payloadBuildId: initial.payloadBuildId, hostEntrySha256: initial.hostEntrySha256,
    signal: lifetime.signal, assertCurrent, dispose,
    async signChallenge(value: unknown): Promise<OriginalMcpNativeAttestation> {
      assertCurrent();
      const challenge = originalMcpNativeChallenge(value);
      if (challenge.profileSha256 !== profile.sha256 || challenge.payloadBuildId !== initial.payloadBuildId
        || challenge.hostEntrySha256 !== initial.hostEntrySha256)
        return unavailable("The attachment challenge does not select this native profile/build.");
      const answer = await vscode.window.showWarningMessage(
        `Attach this PKM v5 native activation to ${challenge.root}?\nWorkspace: ${challenge.workspaceId}\nPlan: ${challenge.planSha256}\nThis authenticates attachment only; model, tool and state permissions still require their own approval.`,
        { modal: true }, "Attach native producer");
      if (answer !== "Attach native producer") throw new Error("NATIVE_ATTACHMENT_DECLINED: No native attachment was authorized.");
      assertCurrent();
      const currentSecret = await context.secrets.get(secretId);
      if (!currentSecret || currentSecret !== secret) { revoke(); return unavailable("The native signing key changed."); }
      verifyOriginalMcpNativeIdentity(await publicRecord(path), identity.sha256, profile.sha256);
      const { body, message } = originalMcpNativeAttestationMessage(challenge, identity.sha256, activationId);
      const signature = sign(null, message, key).toString("base64");
      assertCurrent();
      return Object.freeze({ ...body, signature });
    },
  });
}

export function originalMcpNativeSigner(context: vscode.ExtensionContext): Promise<OriginalMcpNativeSigner> {
  let current = identities.get(context);
  if (!current) {
    current = createSigner(context).catch(error => { identities.delete(context); throw error; });
    identities.set(context, current);
  }
  return current;
}

export function registerOriginalMcpNativeIdentity(context: vscode.ExtensionContext, output: vscode.OutputChannel) {
  return vscode.commands.registerCommand("pkm.nextHost.enrollNativeIdentity", async () => {
    try {
      const signer = await originalMcpNativeSigner(context);
      signer.assertCurrent();
      const result = { path: signer.path, sha256: signer.identity.sha256, keyId: signer.identity.keyId,
        profileSha256: signer.identity.profileSha256, businessActivation: false };
      output.appendLine(`Native public identity: ${JSON.stringify(result)}`);
      void vscode.window.showInformationMessage("PKM v5 native identity enrolled. Old credentials are unchanged; library activation is not enabled.")
        .then(undefined, () => { output.appendLine("Native identity is enrolled, but its informational notification could not be displayed."); });
      return result;
    } catch (error) {
      output.appendLine("Native identity enrollment failed or was declined. No existing public identity or old credentials were replaced.");
      await vscode.window.showErrorMessage("PKM v5 native identity is unavailable. Check the installed native profile and its SecretStorage; no automatic replacement was attempted.");
      throw error;
    }
  });
}
