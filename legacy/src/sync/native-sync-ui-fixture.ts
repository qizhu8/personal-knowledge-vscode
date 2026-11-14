import { randomUUID } from "crypto";
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";

type Grant = { schema: string; fixture: string; root: string; profile: string; rootPin: string; profilePin: string;
  endpoint: string; bearer: string; ownerPid: number; ownerStart: string; pidNamespace: string };

function readGrant(context: vscode.ExtensionContext, configuredRoot: string): Grant {
  const file = path.join(context.globalStorageUri.fsPath, "native-sync-ui.json");
  if (process.platform !== "linux" || process.env.PKM_PRIVATE_NATIVE_SYNC_UI !== "1"
    || process.env.PKM_PRIVATE_NATIVE_SYNC_UI_GRANT !== file || fs.realpathSync(file) !== file)
    throw new Error("Private Sync UI grant denied.");
  const before = fs.lstatSync(file, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size > 16384n
    || before.uid !== BigInt(process.getuid!()) || (Number(before.mode) & 0o077) !== 0)
    throw new Error("Private Sync UI grant denied.");
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  let grant: Grant;
  try {
    const bytes = fs.readFileSync(fd), after = fs.fstatSync(fd, { bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs)
      throw new Error("Private Sync grant changed.");
    grant = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } finally { fs.closeSync(fd); }
  const root = fs.lstatSync(grant.root, { bigint: true }), profile = fs.lstatSync(grant.profile, { bigint: true });
  const endpoint = new URL(grant.endpoint);
  if (grant.schema !== "pkm.private-native-sync-ui/v1"
    || !/^pkm-native-sync-ui-[a-f0-9-]{36}$/.test(path.basename(grant.fixture))
    || fs.realpathSync(grant.fixture) !== grant.fixture || path.dirname(grant.root) !== grant.fixture
    || grant.profile !== path.join(grant.fixture, "u", "User", "globalStorage", "uone.personal-knowledge")
    || file !== path.join(grant.profile, "native-sync-ui.json") || fs.realpathSync(grant.root) !== grant.root
    || fs.realpathSync(grant.profile) !== grant.profile || path.resolve(configuredRoot) !== grant.root
    || !root.isDirectory() || root.isSymbolicLink() || !profile.isDirectory() || profile.isSymbolicLink()
    || `${root.dev}:${root.ino}` !== grant.rootPin || `${profile.dev}:${profile.ino}` !== grant.profilePin
    || endpoint.protocol !== "http:" || endpoint.hostname !== "127.0.0.1" || !endpoint.port
    || endpoint.pathname !== "/" || endpoint.username || endpoint.password || endpoint.search || endpoint.hash
    || !/^[A-Za-z0-9_-]{43}$/.test(grant.bearer) || !Number.isSafeInteger(grant.ownerPid) || grant.ownerPid <= 1
    || !/^\d+$/.test(grant.ownerStart) || grant.pidNamespace !== fs.readlinkSync("/proc/self/ns/pid"))
    throw new Error("Private Sync fixture binding denied.");
  const stat = fs.readFileSync(`/proc/${grant.ownerPid}/stat`, "utf8"), end = stat.lastIndexOf(")");
  if (end < 0 || stat.slice(end + 2).trim().split(/\s+/)[19] !== grant.ownerStart)
    throw new Error("Private Sync controller is no longer active.");
  return grant;
}

/** Separate synthetic-only panel: the controller owns the pre-Code writer lease. */
export function activateNativeSyncUiFixture(context: vscode.ExtensionContext, configuredRoot: () => string,
  panelHtml: (view: vscode.Webview, root: string) => string): boolean {
  const file = path.join(context.globalStorageUri.fsPath, "native-sync-ui.json");
  if (!process.env.PKM_PRIVATE_NATIVE_SYNC_UI_GRANT) {
    if (process.env.PKM_PRIVATE_NATIVE_SYNC_UI === "1") throw new Error("Private Sync UI grant required.");
    try { fs.lstatSync(file); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
    throw new Error("Private Sync profile requires its explicit fixture gate.");
  }
  const grant = readGrant(context, configuredRoot());
  const rpc = async (input: Record<string, unknown>, useCredential = false) => {
    if (JSON.stringify(readGrant(context, configuredRoot())) !== JSON.stringify(grant)) throw new Error("Private Sync grant changed.");
    const needsCredential = useCredential && latest?.status?.target?.authentication?.method !== "ssh"
      && latest?.status?.target?.authentication?.method !== "https";
    const credential = needsCredential ? await context.secrets.get("personalKnowledge.githubSync.vscode.fixture-target") : undefined;
    if (needsCredential) {
      let value: any;
      try { value = JSON.parse(credential || ""); } catch { throw new Error("Synthetic Sync credential unavailable."); }
      if (value.accountLabel !== "fixture" || value.accessToken !== "fixture-token") throw new Error("Synthetic Sync credential denied.");
    }
    const response = await fetch(`${grant.endpoint}sync`, { method: "POST", redirect: "error", signal: AbortSignal.timeout(90_000),
      headers: { authorization: `Bearer ${grant.bearer}`, "content-type": "application/json" },
      body: JSON.stringify({ ...input, ...(needsCredential ? { credential } : {}) }) });
    const data: any = await response.json();
    if (!response.ok || data.error) throw new Error(data.error || "Sync action requires recovery.");
    return data.value;
  };
  let panel: vscode.WebviewPanel | undefined, latest: any;
  let actions = Promise.resolve();
  const sendState = async () => {
    latest = await rpc({ action: "state" });
    await panel?.webview.postMessage({ command: "githubSyncState", data: {
      targets: [latest.status.target], nativeSync: latest, fingerprintsDeferred: false,
    } });
  };
  const open = () => {
    if (panel) { panel.reveal(); return; }
    const root = vscode.Uri.joinPath(context.extensionUri, "dist", "webview");
    const created = vscode.window.createWebviewPanel("personalKnowledge", "Personal Knowledge Manager",
      vscode.ViewColumn.One, { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [root] });
    panel = created;
    created.webview.html = panelHtml(created.webview, grant.root);
    created.onDidDispose(() => { if (panel === created) panel = undefined; });
    created.webview.onDidReceiveMessage(message => {
      actions = actions.then(async () => {
        const command = String(message?.command || "");
        try {
          if (command === "ready") {
            await created.webview.postMessage({ command: "openNativeSync" });
            await sendState();
          } else if (command === "githubSyncState") await sendState();
          else if (command === "githubSyncNative") {
            const action = String(message.action || "");
            if (action === "sync" || action === "resume") await rpc({ action }, true);
            else if (action === "discard" || action === "confirm") {
              const sessionId = latest?.comparison?.session?.sessionId;
              if (!sessionId) throw new Error("Comparison is no longer available.");
              await rpc({ action, sessionId }, action === "confirm");
            } else if (action === "decide") {
              const session = latest?.comparison?.session;
              const conflict = session?.plan?.conflicts?.[message.index];
              if (!conflict || !["local", "remote"].includes(message.choice)) throw new Error("Conflict is no longer available.");
              await rpc({ action, decision: { sessionId: session.sessionId, operationId: randomUUID(),
                expectedRevision: session.revision, conflictId: conflict.id, choice: message.choice,
                reason: `User chose ${message.choice} in the private comparison panel.` } }, true);
            } else throw new Error("Unknown Sync action.");
            await sendState();
          }
        } catch (error) {
          try { await sendState(); } catch { /* Preserve the original error if the controller is unavailable. */ }
          await created.webview.postMessage({ command: "githubSyncNativeError",
            data: { message: error instanceof Error ? error.message : "Sync requires recovery." } });
        }
      });
    });
  };
  context.subscriptions.push(vscode.commands.registerCommand("personalKnowledge.open", open),
    vscode.commands.registerCommand("personalKnowledge.openPanelTab", (tab: string) => {
      if (tab !== "githubSync") throw new Error("Only Sync is available in this private experiment.");
      open();
    }), { dispose: () => panel?.dispose() });
  return true;
}
