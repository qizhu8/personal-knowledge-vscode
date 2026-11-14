import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { createHash, randomBytes, randomUUID } from "crypto";

/** A window-local selection, not evidence that other Knowledge Root writers stopped. */
export function createNextChatProfileAuthority(options: {
  workspaceId: string;
  root: string;
  currentRoot(): string;
  clientCurrent(): boolean;
  secrets?: Pick<vscode.SecretStorage, "onDidChange"> & Partial<Pick<vscode.SecretStorage, "get" | "store" | "delete">>;
}) {
  if (!/^[a-f0-9-]{36}$/.test(options.workspaceId) || !path.isAbsolute(options.root)
    || path.resolve(options.root) !== options.root || fs.realpathSync(options.root) !== options.root)
    throw new Error("A canonical root and selected Next workspace are required.");
  const identity = fs.lstatSync(options.root, { bigint: true });
  if (!identity.isDirectory() || identity.isSymbolicLink()) throw new Error("Selected Knowledge Root is unavailable.");
  const controller = new AbortController(), id = randomUUID();
  let permissionKey: string | undefined;
  const revoke = () => controller.abort();
  const configuration = vscode.workspace.onDidChangeConfiguration(event => {
    if (event.affectsConfiguration("personalKnowledge")) revoke();
  });
  const folders = vscode.workspace.onDidChangeWorkspaceFolders(revoke);
  const secrets = options.secrets?.onDidChange(event => {
    if (event.key === "personalKnowledge.aiApiKey" || event.key === permissionKey) revoke();
  });
  let modelChanges: vscode.Disposable | undefined;
  let authChanges: vscode.Disposable | undefined;
  const assertCurrent = () => {
    if (controller.signal.aborted || vscode.workspace.isTrusted === false || !options.clientCurrent()
      || options.currentRoot() !== options.root || fs.realpathSync(options.root) !== options.root)
      throw new Error("Selected Chat profile, workspace, or connection was revoked.");
    const now = fs.lstatSync(options.root, { bigint: true });
    if (!now.isDirectory() || now.isSymbolicLink() || now.dev !== identity.dev || now.ino !== identity.ino)
      throw new Error("Selected Knowledge Root identity changed.");
  };
  try { assertCurrent(); }
  catch (error) { configuration.dispose(); folders.dispose(); secrets?.dispose(); throw error; }
  return Object.freeze({
    id, workspaceId: options.workspaceId, actorId: "local:owner" as const, root: options.root,
    signal: controller.signal, assertCurrent,
    async preparePermissions(namespace: string, chatId: string): Promise<string | undefined> {
      const store = options.secrets;
      if (!store?.get || !store.store || !store.delete) return undefined;
      if (!/^[a-f0-9]{16}$/.test(namespace) || !/^[a-f0-9-]{36}$/.test(chatId) || permissionKey)
        throw new Error("A single selected Chat permission scope is required.");
      const key = `personalKnowledge.next.chatPermissionKey.v1.${createHash("sha256").update(JSON.stringify([
        options.workspaceId, options.root, `${identity.dev}:${identity.ino}`, namespace, chatId,
      ])).digest("hex")}`;
      assertCurrent();
      let value = await store.get(key);
      assertCurrent();
      if (value === undefined) {
        value = randomBytes(32).toString("base64url");
        await store.store(key, value);
        assertCurrent();
      }
      if (!/^[A-Za-z0-9_-]{43}$/.test(value)) throw new Error("Stored Chat permission key is invalid.");
      permissionKey = key;
      const confirmed = await store.get(key);
      assertCurrent();
      if (confirmed !== value) throw new Error("Chat permission key changed during selection.");
      return value;
    },
    async resetPermissions(): Promise<void> {
      if (!permissionKey || !options.secrets?.delete) throw new Error("This Chat has no profile-local permission key.");
      assertCurrent();
      await options.secrets.delete(permissionKey);
    },
    watchModelChanges(event: vscode.Event<void>) {
      if (modelChanges) throw new Error("Model catalog is already watched.");
      modelChanges = event(revoke);
      assertCurrent();
    },
    watchGithubSessions(event: vscode.Event<vscode.AuthenticationSessionsChangeEvent>) {
      if (authChanges) throw new Error("GitHub sessions are already watched.");
      authChanges = event(change => { if (change.provider.id === "github") revoke(); });
      assertCurrent();
    },
    dispose() { revoke(); configuration.dispose(); folders.dispose(); secrets?.dispose(); modelChanges?.dispose(); authChanges?.dispose(); },
  });
}
