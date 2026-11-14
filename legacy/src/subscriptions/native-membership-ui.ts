import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { parseShareMagicLink } from "./subscriptions";
import { normalizeGitHubSyncTarget } from "../sync/github-sync";
import { readStoredGitHubSyncCredentials } from "../sync/github-sync-credentials";
import { withCrossProcessLock } from "../runtime/cross-process-lock";
import { privateGitHubSubscriptionEndpoint } from "./native-github-snapshot";

type Grant = { schema: string; nonce: string; fixture: string; root: string; profile: string;
  rootPin: string; profilePin: string; endpoint: string; bearer: string;
  ownerPid: number; ownerStart: string; pidNamespace: string };

function readGrant(context: vscode.ExtensionContext, configuredRoot: string): Grant {
  const file = path.join(context.globalStorageUri.fsPath, "native-subscription-ui.json");
  if (process.platform !== "linux" || process.env.PKM_PRIVATE_NATIVE_SUBSCRIPTION !== "1"
    || process.env.PKM_PRIVATE_NATIVE_SUBSCRIPTION_GRANT !== file || fs.realpathSync(file) !== file)
    throw new Error("Private Subscription UI grant denied.");
  const before = fs.lstatSync(file, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.uid !== BigInt(process.getuid!())
    || (Number(before.mode) & 0o077) !== 0 || before.size > 16384n) throw new Error("Private Subscription UI grant denied.");
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  let grant: Grant;
  try {
    const bytes = fs.readFileSync(fd), after = fs.fstatSync(fd, { bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) throw new Error("Private Subscription UI grant changed.");
    grant = JSON.parse(bytes.toString("utf8"));
  } finally { fs.closeSync(fd); }
  const endpoint = new URL(grant.endpoint);
  const root = fs.lstatSync(grant.root, { bigint: true }), profile = fs.lstatSync(grant.profile, { bigint: true });
  if (!Number.isSafeInteger(grant.ownerPid) || grant.ownerPid <= 1 || !/^\d+$/.test(grant.ownerStart)
    || grant.pidNamespace !== fs.readlinkSync("/proc/self/ns/pid")) throw new Error("Private Subscription controller identity denied.");
  const processStat = fs.readFileSync(`/proc/${grant.ownerPid}/stat`, "utf8"), processEnd = processStat.lastIndexOf(")");
  if (processEnd < 0 || processStat.slice(processEnd + 2).trim().split(/\s+/)[19] !== grant.ownerStart)
    throw new Error("Private Subscription controller is no longer active.");
  if (grant.schema !== "pkm.native-subscription-ui/v1" || !/^[a-f0-9-]{36}$/.test(grant.nonce)
    || !/^[A-Za-z0-9_-]{43}$/.test(grant.bearer) || !/^pkm-native-subscription-ui-[a-f0-9-]{36}$/.test(path.basename(grant.fixture))
    || fs.realpathSync(grant.fixture) !== grant.fixture || path.dirname(grant.root) !== grant.fixture
    || path.dirname(grant.profile) !== grant.fixture || fs.realpathSync(grant.root) !== grant.root
    || fs.realpathSync(grant.profile) !== grant.profile || path.resolve(configuredRoot) !== grant.root
    || file !== path.join(grant.fixture, "u", "User", "globalStorage", "uone.personal-knowledge", "native-subscription-ui.json")
    || !root.isDirectory() || !profile.isDirectory() || root.isSymbolicLink() || profile.isSymbolicLink()
    || `${root.dev}:${root.ino}` !== grant.rootPin || `${profile.dev}:${profile.ino}` !== grant.profilePin
    || endpoint.protocol !== "http:" || endpoint.hostname !== "127.0.0.1" || !endpoint.port
    || endpoint.pathname !== "/" || endpoint.username || endpoint.password || endpoint.search || endpoint.hash)
    throw new Error("Private Subscription UI fixture binding denied.");
  return grant;
}

/** Reuses the full installed PKM panel; only Subscription membership is admitted. */
export function activateNativeSubscriptionUi(
  context: vscode.ExtensionContext, configuredRoot: () => string,
  panelHtml: (view: vscode.Webview, root: string) => string,
): boolean {
  if (!process.env.PKM_PRIVATE_NATIVE_SUBSCRIPTION_GRANT) {
    if (process.env.PKM_PRIVATE_NATIVE_SUBSCRIPTION === "1")
      throw new Error("Private Subscription experiment requires its controller grant.");
    try { fs.lstatSync(path.join(context.globalStorageUri.fsPath, "native-subscription-ui.json")); }
    catch (error: any) { if (error.code === "ENOENT") return false; throw error; }
    throw new Error("Private Subscription grant requires its explicit experimental gate.");
  }
  const grant = readGrant(context, configuredRoot());
  const rpc = async (input: Record<string, unknown>) => {
    const current = readGrant(context, configuredRoot());
    if (JSON.stringify(current) !== JSON.stringify(grant)) throw new Error("Private Subscription grant changed.");
    const response = await fetch(`${grant.endpoint}/subscription`, { method: "POST", redirect: "error",
      ...(input.command === "github-refresh" ? {} : { signal: AbortSignal.timeout(65_000) }),
      headers: { authorization: `Bearer ${grant.bearer}`, "content-type": "application/json" },
      body: JSON.stringify(input) });
    const result: any = await response.json();
    if (!response.ok || result.error) {
      const messages: Record<string, string> = {
        BROKER_FORBIDDEN: "Broker denied this subscriber (403). The refresh remains pending; retry explicitly after reviewing access.",
        BROKER_UNAUTHORIZED: "Broker rejected authorization (401). The refresh remains pending; retry explicitly after reviewing access.",
        BROKER_UNREACHABLE: "Broker is unreachable. The refresh remains pending; retry explicitly when it is available.",
      };
      throw new Error(messages[result.code] || "Subscription action failed or requires explicit recovery.");
    }
    return result.result;
  };
  let panel: vscode.WebviewPanel | undefined;
  let pending = false;
  let warnedPending = false;
  let recoveryInspection: any;
  let actionQueue: Promise<void> = Promise.resolve();
  const sendState = async () => {
    const result = await rpc({ command: "state" });
    pending = !!result.pending;
    if (!pending || recoveryInspection?.operationId !== result.pending?.operationId) recoveryInspection = undefined;
    if (pending && !warnedPending) {
      warnedPending = true;
      void vscode.window.showWarningMessage(result.recoveryBlocked
        ? "Subscription recovery needs review. Preserve the profile and cached data; do not retry until its pending state is reconciled."
        : "Subscription outcome is pending. Re-enter the exact action to retry, or cancel only if unchanged.");
    } else if (!pending) warnedPending = false;
    const data = { nodeId: result.state.nodeId, displayName: "Private Subscription experiment",
      enabled: false, gatewayStatus: "stopped", shares: result.state.shares, subscriptions: result.subscriptions,
      catalog: {}, networkAddresses: [], githubConnections: [],
      nativeRecovery: pending && ["refresh", "github-refresh"].includes(result.pending?.action)
        ? { inspection: recoveryInspection || null } : null };
    await panel?.webview.postMessage({ command: "subscriptionState", data });
  };
  const open = () => {
    if (panel) { panel.reveal(); return; }
    const webviewRoot = fs.existsSync(path.join(context.extensionPath, "dist", "webview", "panel.html"))
      ? vscode.Uri.joinPath(context.extensionUri, "dist", "webview") : vscode.Uri.joinPath(context.extensionUri, "src", "webview");
    const created = vscode.window.createWebviewPanel("personalKnowledge", "Personal Knowledge Manager",
      vscode.ViewColumn.One, { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [
        webviewRoot, vscode.Uri.joinPath(context.extensionUri, "node_modules", "marked"), vscode.Uri.file(grant.root),
        vscode.Uri.file(path.join(grant.profile, "cache")),
      ] });
    panel = created;
    created.webview.html = panelHtml(created.webview, grant.root);
    created.onDidDispose(() => { if (panel === created) panel = undefined; });
    created.webview.onDidReceiveMessage(message => {
      actionQueue = actionQueue.then(async () => {
        const command = String(message?.command || "");
        try {
          if (command === "ready") {
            await created.webview.postMessage({ command: "openSubscription", shareId: "" });
            await sendState();
          } else if (command === "subscriptionState") await sendState();
          else if (command === "subscriptionAdd") {
            const magicLink = String(message.magicLink || "").trim(), alias = String(message.alias || "").trim();
            const secret = String(message.secret || "").trim(), parsed = parseShareMagicLink(magicLink);
            const match = /^pkms:v1:\d{4,5}:[A-Za-z0-9_-]{16,128}:([A-Za-z0-9_-]{16,})$/.exec(secret);
            const key = `personalKnowledge.subscription.${parsed.nodeId}.${parsed.shareId}.secret`;
            if (parsed.secretProtected) {
              if (!match) throw new Error("Protected Subscription secret is invalid.");
              const prior = await context.secrets.get(key);
              if (prior && prior !== match[1]) throw new Error("Existing Subscription secret differs.");
              await context.secrets.store(key, match[1]!);
            }
            await rpc({ command: "add", magicLink, alias, secret, retry: pending });
            await created.webview.postMessage({ command: "subscriptionCompleted", data: { action: "subscribed", name: alias } });
            await sendState();
          } else if (command === "subscriptionRemove") {
            const id = String(message.id || "");
            const state = await rpc({ command: "state" });
            const record = state.state.subscriptions.find((item: any) => item.id === id);
            await rpc({ command: "remove", id, retry: !!state.pending });
            if (record) await context.secrets.delete(`personalKnowledge.subscription.${record.nodeId}.${record.shareId}.secret`);
            await created.webview.postMessage({ command: "subscriptionCompleted", data: { action: "removed" } });
            await sendState();
          } else if (command === "subscriptionSetPriority") {
            const id = String(message.id || ""), priority = String(message.priority || "");
            const state = await rpc({ command: "state" });
            const record = state.state.subscriptions.find((item: any) => item.id === id);
            await rpc({ command: "priority", id, priority, retry: !!state.pending });
            await created.webview.postMessage({ command: "subscriptionCompleted",
              data: { action: "prioritySet", name: record?.alias || record?.brokerName || record?.shareId || "" } });
            await sendState();
          } else if (command === "subscriptionRename") {
            const id = String(message.id || ""), alias = String(message.alias || "").trim();
            const state = await rpc({ command: "state" });
            await rpc({ command: "rename", id, alias, retry: !!state.pending });
            await created.webview.postMessage({ command: "subscriptionRenamed", data: { id, alias } });
            await sendState();
          } else if (command === "subscriptionReviewRecovery") {
            recoveryInspection = await rpc({ command: "inspect-recovery" });
            await sendState();
          } else if (command === "subscriptionRecheckRecovery") {
            if (!recoveryInspection) throw new Error("Inspect the pending refresh before rechecking it.");
            await rpc({ command: "recheck-recovery" });
            recoveryInspection = { ...await rpc({ command: "inspect-recovery" }), rechecked: true };
            await sendState();
          } else if (command === "subscriptionOpenRecoveryFolder") {
            if (!recoveryInspection || !/^[A-Za-z0-9_-]{1,128}$/.test(recoveryInspection.nodeId))
              throw new Error("Inspect the pending refresh before opening its folder.");
            await vscode.commands.executeCommand("revealFileInOS",
              vscode.Uri.file(path.join(grant.profile, "cache", recoveryInspection.nodeId)));
          } else if (command === "subscriptionRefresh") {
            const id = String(message.id || ""), state = await rpc({ command: "state" });
            const record = state.state.subscriptions.find((item: any) => item.id === id);
            if (!record) throw new Error("Subscription refresh target is unavailable.");
            if (record.source?.type === "github") {
              privateGitHubSubscriptionEndpoint(record.source.repository);
              const targetId = record.source.credentialTargetId || record.source.targetId;
              if (!targetId) {
                await rpc({ command: "github-refresh", id, account: record.publisherUser || "github",
                  credentialTargetId: null, retry: !!state.pending });
                const refreshed = (await rpc({ command: "state" })).state.subscriptions.find((item: any) => item.id === id);
                if (!refreshed) throw new Error("Refreshed Subscription is unavailable.");
                await created.webview.postMessage({ command: "subscriptionCompleted",
                  data: { action: "refreshed", name: refreshed.alias || refreshed.brokerName || refreshed.shareId, revision: refreshed.revision } });
                await sendState();
                return;
              }
              if (typeof targetId !== "string" || !/^[A-Za-z0-9._-]{1,128}$/.test(targetId))
                throw new Error("GitHub Subscription credential target is unavailable.");
              const directory = path.join(context.globalStorageUri.fsPath, "github-sync");
              const directoryStat = fs.lstatSync(directory, { bigint: true });
              if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink() || fs.realpathSync(directory) !== directory
                || directoryStat.uid !== BigInt(process.getuid!()) || (Number(directoryStat.mode) & 0o022) !== 0)
                throw new Error("GitHub Sync target directory is unavailable.");
              await withCrossProcessLock(path.join(directory, "targets-state.lock"), "GitHub Sync target state (Subscription refresh)",
                120_000, async () => {
              const file = path.join(directory, "targets.json"), before = fs.lstatSync(file, { bigint: true });
              if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n
                || before.uid !== BigInt(process.getuid!()) || (Number(before.mode) & 0o077) !== 0 || before.size > 4_194_304n)
                throw new Error("GitHub Sync targets are unavailable.");
              const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
              let bytes: Buffer;
              try {
                bytes = fs.readFileSync(fd);
                const after = fs.fstatSync(fd, { bigint: true });
                if (before.dev !== after.dev || before.ino !== after.ino || before.mtimeNs !== after.mtimeNs
                  || before.ctimeNs !== after.ctimeNs || BigInt(bytes.length) !== before.size)
                  throw new Error("GitHub Sync targets changed.");
              } finally { fs.closeSync(fd); }
              const config = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
              const matches = config?.schema === 1 && Array.isArray(config.targets)
                ? config.targets.filter((item: any) => item?.id === targetId) : [];
              if (matches.length !== 1) throw new Error("GitHub Sync credential target is unavailable.");
              const target = normalizeGitHubSyncTarget(matches[0]);
              if (target.authentication?.method !== "vscode"
                || target.authentication.expectedLogin.toLowerCase() !== String(record.publisherUser || "").toLowerCase())
                throw new Error("GitHub Subscription account does not match the saved target.");
              const credential = await readStoredGitHubSyncCredentials(
                () => context.secrets.get(`personalKnowledge.githubSync.vscode.${targetId}`), target);
              const after = fs.lstatSync(file, { bigint: true });
              if (!credential || before.dev !== after.dev || before.ino !== after.ino || before.mtimeNs !== after.mtimeNs
                || before.ctimeNs !== after.ctimeNs) throw new Error("GitHub Sync target changed during credential access.");
              await rpc({ command: "github-refresh", id, account: target.authentication.expectedLogin,
                credentialTargetId: targetId, token: credential.accessToken, retry: !!state.pending });
              const refreshed = (await rpc({ command: "state" })).state.subscriptions.find((item: any) => item.id === id);
              if (!refreshed) throw new Error("Refreshed Subscription is unavailable.");
              await created.webview.postMessage({ command: "subscriptionCompleted",
                data: { action: "refreshed", name: refreshed.alias || refreshed.brokerName || refreshed.shareId, revision: refreshed.revision } });
              await sendState();
              });
              return;
            }
            const material = record.secretProtected
              ? await context.secrets.get(`personalKnowledge.subscription.${record.nodeId}.${record.shareId}.secret`) : "";
            if (record.secretProtected && !material) throw new Error("Subscription refresh secret is unavailable.");
            await rpc({ command: "refresh", id, material: material || "", retry: !!state.pending });
            const refreshedState = await rpc({ command: "state" });
            const refreshed = refreshedState.state.subscriptions.find((item: any) => item.id === id);
            if (!refreshed) throw new Error("Refreshed Subscription is unavailable.");
            await created.webview.postMessage({ command: "subscriptionCompleted",
              data: { action: "refreshed", name: refreshed.alias || refreshed.brokerName || refreshed.shareId, revision: refreshed.revision } });
            await sendState();
          } else if (command.startsWith("subscription")) throw new Error("This Subscription workflow is not enabled in the private experiment.");
        } catch (error) {
          try { await sendState(); } catch { /* Leave the last admitted display unchanged. */ }
          await created.webview.postMessage({ command: "subscriptionError",
            data: { action: command, error: error instanceof Error ? error.message : "Subscription request failed." } });
        }
      });
    });
  };
  context.subscriptions.push(
    vscode.commands.registerCommand("personalKnowledge.open", open),
    vscode.commands.registerCommand("personalKnowledge.openSubscriptions", open),
    vscode.commands.registerCommand("personalKnowledge.openPanelTab", (tab: string) => {
      if (tab !== "subscriptions") throw new Error("Only Subscription is available in this private experiment.");
      open();
    }),
    vscode.commands.registerCommand("personalKnowledge.cancelNativeSubscriptionPending", async () => {
      await rpc({ command: "cancel" }); await sendState();
    }),
    { dispose: () => panel?.dispose() },
  );
  return true;
}
