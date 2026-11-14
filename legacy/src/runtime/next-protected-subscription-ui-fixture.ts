import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { randomUUID, timingSafeEqual } from "crypto";
import { SharedMarketManager, parseShareMagicLink } from "../subscriptions/subscriptions";
import { withAuthenticatedSubscriptionPull } from "../subscriptions/authenticated-pull";
import { withCrossProcessLockSync } from "./cross-process-lock";
import { signProtectedSubscriptionFixture } from "./next-protected-subscription-signing-fixture";
import { installRemoteSubscriptionFixtureTransport } from "./next-protected-remote-subscription-fixture";

type Binding = Parameters<typeof signProtectedSubscriptionFixture>[4];
export type MembershipChange =
  | { action: "add"; publisherNodeId: string; shareId: string; magicLink: string; alias: string; endpoint: string; secretSalt: string | null }
  | { action: "remove"; publisherNodeId: string; shareId: string; subscriptionId: string };
type Pending = { operationId: string; action: "add" | "remove"; publisherNodeId: string; shareId: string; subscriptionId: string | null };
type BindingReader = (shareId: string) => Promise<{ statePlan: Binding; refreshHead: string | null;
  refreshState: { subscriptions: any[] }; membershipPending: Pending | null }>;
type Publisher = (shareId: string, expectedHead: string | null, crashAfterFirstFile: boolean,
  replayOnly: boolean, crashAfterCommit?: boolean, failure?: boolean, priority?: boolean, publisherNodeId?: string) => Promise<string>;
type Membership = (shareId: string, action: "membership-prepare" | "membership-check" | "membership-publish" | "membership-cancel" | "membership-outcome",
  operationId: string, expectedHead: string | null, change?: MembershipChange, verifiedPull?: boolean,
  crashAfterFirstFile?: boolean, crashAfterCommit?: boolean) => Promise<any>;

/** Private copy-only adapter for exercising the original Subscription renderer and client. */
export function registerProtectedSubscriptionUiFixture(context: vscode.ExtensionContext, fixture: string, nonce: string,
  readBinding: BindingReader, publish: Publisher, membership: Membership): void {
  if (process.env.PKM_PRIVATE_SUBSCRIPTION_UI !== "1" || process.env.PKM_PRIVATE_SUBSCRIPTION_SIGNING !== "1") return;
  let panel: vscode.WebviewPanel | undefined;
  context.subscriptions.push(vscode.commands.registerCommand("personalKnowledge.openIsolatedSubscriptionUiFixture", async (input: unknown) => {
    if (panel || !input || typeof input !== "object" || Array.isArray(input)) throw new Error("Private Subscription UI denied.");
    const request = input as Record<string, unknown>;
    if (Object.keys(request).sort().join(",") !== "nonce,shareId" || request.nonce !== nonce
      || typeof request.shareId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(request.shareId)) {
      throw new Error("Private Subscription UI denied.");
    }
    const shareId = request.shareId;
    let binding = await readBinding(shareId);
    const plan = binding.statePlan;
    let refreshHead = binding.refreshHead;
    let injectFailure = ["1", "4", "6", "7"].includes(process.env.PKM_PRIVATE_SUBSCRIPTION_REFRESH_FAULT || "");
    const secret = await context.secrets.get(`personalKnowledge.shareBroker.${shareId}.secret`);
    if (!secret) throw new Error("Private Subscription UI denied.");
    const check = () => signProtectedSubscriptionFixture(fixture, nonce, shareId, secret, plan,
      { mutableSubscriberState: true, expectedSubscriptions: binding.refreshState.subscriptions,
        ...(binding.membershipPending ? { pending: binding.membershipPending } : {}) });
    const reload = async () => { binding = await readBinding(shareId); refreshHead = binding.refreshHead; };
    const checkRecord = async (subscription: any) => {
      const localNodeId = check().nodeId;
      if (subscription.source || subscription.nodeId !== localNodeId && process.env.PKM_PRIVATE_SUBSCRIPTION_REMOTE !== "1"
        || typeof subscription.shareId !== "string"
        || !["http://127.0.0.1:23001", "http://127.0.0.1:23002"].includes(new URL(subscription.endpoint).origin))
        throw new Error();
      const subscriberSecret = await context.secrets.get(`personalKnowledge.subscription.${subscription.nodeId}.${subscription.shareId}.secret`);
      if (!subscriberSecret) throw new Error();
      if (subscription.nodeId !== localNodeId) return;
      const brokerSecret = await context.secrets.get(`personalKnowledge.shareBroker.${subscription.shareId}.secret`);
      if (!brokerSecret) throw new Error();
      const expected = Buffer.from(brokerSecret), supplied = Buffer.from(subscriberSecret);
      try {
        if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) throw new Error();
        signProtectedSubscriptionFixture(fixture, nonce, subscription.shareId, brokerSecret, plan, { mutableSubscriberState: true });
      } finally { expected.fill(0); supplied.fill(0); }
    };
    const sourceProfile = path.join(fixture, "profile");
    const oldProfile = path.join(context.globalStorageUri.fsPath, "subscriptions");
    const original = fs.lstatSync(sourceProfile, { bigint: true }), mounted = fs.lstatSync(oldProfile, { bigint: true });
    if (!mounted.isDirectory() || mounted.isSymbolicLink() || mounted.dev !== original.dev || mounted.ino !== original.ino)
      throw new Error("Private Subscription UI denied.");
    const manager = withCrossProcessLockSync(path.join(sourceProfile, "subscriptions-state.lock"), "Subscription state mutation", () => {
      check();
      const current = JSON.parse(fs.readFileSync(path.join(sourceProfile, "subscriptions.json"), "utf8"));
      if (current.port !== 23000 || current.advertisedHost !== "127.0.0.1" || typeof current.displayName !== "string")
        throw new Error("Private Subscription UI denied.");
      // The old constructor rewrites state and prunes files; pending recovery must not do either.
      const instance = Object.create(SharedMarketManager.prototype) as SharedMarketManager;
      Object.assign(instance, {
        storageDir: oldProfile, gatewayScript: path.join(context.extensionPath, "dist/subscription-gateway.js"),
        events: {}, secrets: context.secrets, state: current, mqttClients: new Map(), gatewayStatus: "stopped",
        gatewayError: "", gatewayStartupDeadline: 0, gatewayStartupLastError: "", gatewayConfigurationId: "",
        disposed: false, warned: new Set(), publishedRefreshAgain: false, publisherUser: "fixture",
        publisherHost: "fixture", gatewayRuntimeVersion: "fixture", stateMutationDepth: 0, mqttRefreshesInFlight: new Set(),
      });
      if (process.env.PKM_PRIVATE_SUBSCRIPTION_REMOTE === "1") installRemoteSubscriptionFixtureTransport(instance, fixture);
      // Realtime callbacks must not mutate a profile behind the durable publication fence.
      (instance as unknown as { connectMqtt: () => void }).connectMqtt = () => {};
      try { check(); } catch (error) { instance.dispose(); throw error; }
      return instance;
    });
    const uiRoot = vscode.Uri.file(path.join(context.extensionPath, "private-subscription-ui"));
    panel = vscode.window.createWebviewPanel("pkmPrivateSubscriptionFixture", "Private Subscription Fixture",
      vscode.ViewColumn.One, { enableScripts: true, localResourceRoots: [uiRoot] });
    const view = panel;
    const script = (name: string) => view.webview.asWebviewUri(vscode.Uri.joinPath(uiRoot, name)).toString();
    view.webview.html = `<!doctype html><html><head><meta charset="utf-8">
      <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src ${view.webview.cspSource} 'unsafe-inline'; style-src 'unsafe-inline';">
      </head><body><p>Private copy-only Subscription fixture</p><button id="fixture-quit">Close fixture</button>
      <button id="membership-recover">Recover pending removal</button><button id="membership-cancel">Cancel unchanged pending action</button>
      <div id="membership-status" role="status"></div><div id="fixture-error" role="alert"></div><div id="fixture-ack"></div><main id="detail"></main><section><h3>Fixture cached notes</h3><div id="fixture-cache"></div></section>
      <script src="${script("bridge.js")}"></script><script src="${script("45-subscriptions.js")}"></script><script src="${script("start.js")}"></script></body></html>`;
    const safeState = () => {
      const state = manager.snapshot as any;
      const shares = (state.shares || []).map((s: any) => ({
        shareId: s.shareId, name: s.name, revision: s.revision, revisionLabel: s.revisionLabel,
        visibility: s.visibility, protection: s.protection, published: s.published, summary: s.summary,
        subscribers: [], securityEvents: [], automaticBlocks: [],
      }));
      const admitted = binding.membershipPending ? binding.refreshState.subscriptions : state.subscriptions || [];
      const subscriptions = admitted.map((s: any) => ({
        id: s.id, alias: s.alias, priority: s.priority, brokerName: s.brokerName, nodeId: s.nodeId,
        publisher: s.publisher, shareId: s.shareId, endpoint: s.endpoint, revision: s.revision,
        topics: s.topics, tags: s.tags, counts: s.counts, itemCount: s.itemCount,
        lastUpdated: s.lastUpdated, status: s.status, ...(s.error ? { error: "Subscription refresh failed." } : {}),
      }));
      const visibleIds = new Set(admitted.map((item: any) => item.id));
      const groups = manager.cachedGroups("notes").filter(group => visibleIds.has(group.subscriptionId));
      const cache = groups.flatMap(group => group.items.map(item => ({
        subscriptionId: group.subscriptionId, title: item.title, content: manager.cachedDetail(item.key).content,
      })));
      return { data: { nodeId: state.nodeId, displayName: state.displayName, enabled: false, gatewayStatus: "stopped",
        port: state.port, advertisedHost: state.advertisedHost, shares, subscriptions,
        catalog: {}, networkAddresses: [], githubConnections: [] }, cache, pending: !!binding.membershipPending };
    };
    const send = async () => { await view.webview.postMessage({ command: "subscriptionState", ...safeState() }); };
    const locked = manager as unknown as { withStateMutation<T>(action: () => Promise<T>): Promise<T> };
    const publishMembership = async (operationId: string, change: MembershipChange, verifiedPull: boolean) => {
      const crash = injectFailure && process.env.PKM_PRIVATE_SUBSCRIPTION_REFRESH_FAULT === "6";
      const crashAfterCommit = injectFailure && process.env.PKM_PRIVATE_SUBSCRIPTION_REFRESH_FAULT === "7";
      injectFailure = false;
      try {
        await membership(shareId, "membership-publish", operationId, refreshHead, change, verifiedPull, crash, crashAfterCommit);
      } finally { await reload(); }
    };
    const removeMembership = async (change: Extract<MembershipChange, { action: "remove" }>, operationId: string) => {
      const status = await membership(shareId, "membership-check", operationId, refreshHead, change);
      if (status.targetExists) {
        const record = manager.subscription(change.subscriptionId);
        await checkRecord(record);
        manager.removeSubscription(change.subscriptionId);
        await context.secrets.delete(`personalKnowledge.subscription.${change.publisherNodeId}.${change.shareId}.secret`);
        const parent = path.join(sourceProfile, "cache", change.publisherNodeId);
        if (!(manager.snapshot as any).subscriptions.some((item: any) => item.nodeId === change.publisherNodeId)
          && fs.existsSync(parent)) fs.rmdirSync(parent);
      }
      await publishMembership(operationId, change, false);
    };
    let actions = Promise.resolve();
    view.webview.onDidReceiveMessage(message => {
      actions = actions.then(async () => {
        try {
          if (!message || typeof message !== "object") throw new Error();
          const identity = check();
          if (message.command === "fixtureClose") { await vscode.commands.executeCommand("workbench.action.quit"); return; }
          if (message.command === "subscriptionState") await send();
          else if (message.command === "membershipCancel" && binding.membershipPending) {
            await locked.withStateMutation(async () => {
              await membership(shareId, "membership-cancel", binding.membershipPending!.operationId, refreshHead);
              await reload();
            });
            await send();
            await view.webview.postMessage({ command: "fixtureAck", message: "Unchanged membership action cancelled." });
          } else if (message.command === "membershipRecover" && binding.membershipPending?.action === "remove") {
            const pending = binding.membershipPending;
            if (!pending.subscriptionId) throw new Error();
            const change: MembershipChange = { action: "remove", publisherNodeId: pending.publisherNodeId,
              shareId: pending.shareId, subscriptionId: pending.subscriptionId };
            await locked.withStateMutation(async () => { await removeMembership(change, pending.operationId); });
            await send();
            await view.webview.postMessage({ command: "fixtureAck", message: "Removal recovered." });
          } else if (message.command === "subscriptionAdd" && typeof message.magicLink === "string"
            && typeof message.alias === "string" && typeof message.secret === "string") {
            const magicLink = message.magicLink.trim(), alias = message.alias.trim(), suppliedSecret = message.secret.trim();
            const link = parseShareMagicLink(magicLink);
            if (link.nodeId !== identity.nodeId && process.env.PKM_PRIVATE_SUBSCRIPTION_REMOTE !== "1") throw new Error();
            const url = new URL(link.endpoint);
            let secretSalt: string | null = null;
            if (link.secretProtected) {
              const parsed = /^pkms:v1:(\d{4,5}):([A-Za-z0-9_-]{16,128}):([A-Za-z0-9_-]{16,})$/.exec(suppliedSecret);
              if (!parsed) throw new Error();
              url.port = parsed[1]!;
              secretSalt = parsed[2]!;
            }
            if (!["http://127.0.0.1:23001", "http://127.0.0.1:23002"].includes(url.origin)
              || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error();
            const change: MembershipChange = { action: "add", publisherNodeId: link.nodeId, shareId: link.shareId,
              magicLink, alias, endpoint: url.origin, secretSalt };
            await locked.withStateMutation(async () => {
              const pending = binding.membershipPending;
              if (pending && (pending.action !== "add" || pending.publisherNodeId !== change.publisherNodeId
                || pending.shareId !== change.shareId)) throw new Error();
              const operationId = pending?.operationId ?? randomUUID();
              if (!pending) {
                await membership(shareId, "membership-prepare", operationId, refreshHead, change);
                await reload();
              }
              await membership(shareId, "membership-check", operationId, refreshHead, change);
              try {
                await withAuthenticatedSubscriptionPull(manager, { nodeId: change.publisherNodeId, shareId: change.shareId },
                  () => manager.subscribe(magicLink, alias, suppliedSecret));
                await publishMembership(operationId, change, true);
              } finally { await reload(); }
            });
            await send();
            await view.webview.postMessage({ command: "fixtureAck", message: "Subscription added." });
          } else if (message.command === "subscriptionRemove" && typeof message.id === "string") {
            if (binding.membershipPending) throw new Error();
            await locked.withStateMutation(async () => {
              const record = manager.subscription(message.id);
              await checkRecord(record);
              const change: MembershipChange = { action: "remove", publisherNodeId: record.nodeId,
                shareId: record.shareId, subscriptionId: record.id };
              const operationId = randomUUID();
              await membership(shareId, "membership-prepare", operationId, refreshHead, change);
              await reload();
              try { await removeMembership(change, operationId); } finally { await reload(); }
            });
            await send();
            await view.webview.postMessage({ command: "fixtureAck", message: "Subscription removed." });
          } else if (binding.membershipPending) throw new Error("Subscription membership requires explicit recovery.");
          else if (message.command === "subscriptionRefresh" && typeof message.id === "string") {
            const subscription = manager.subscription(message.id);
            await checkRecord(subscription);
            // Hold the original manager's lock continuously across its authenticated pull and publication.
            const locked = manager as unknown as { withStateMutation<T>(action: () => Promise<T>): Promise<T> };
            await locked.withStateMutation(async () => {
              check();
              try { await manager.refresh(subscription.id, true); }
              catch (error) {
                await checkRecord(subscription);
                refreshHead = await publish(subscription.shareId, refreshHead, false, false, false, true, false, subscription.nodeId);
                await send();
                await view.webview.postMessage({ command: "fixtureAck", message: "Failed refresh published." });
                throw error;
              }
              await checkRecord(subscription);
              const crash = injectFailure && process.env.PKM_PRIVATE_SUBSCRIPTION_REFRESH_FAULT === "1";
              const crashAfterCommit = injectFailure && process.env.PKM_PRIVATE_SUBSCRIPTION_REFRESH_FAULT === "4";
              injectFailure = false;
              refreshHead = await publish(subscription.shareId, refreshHead, crash, false, crashAfterCommit, false, false, subscription.nodeId);
            });
            await send();
            await view.webview.postMessage({ command: "fixtureAck", message: "Refresh published." });
          } else if (message.command === "fixtureReplay" && refreshHead) {
            const locked = manager as unknown as { withStateMutation<T>(action: () => Promise<T>): Promise<T> };
            await locked.withStateMutation(async () => { check(); refreshHead = await publish(shareId, refreshHead, false, true); });
            await view.webview.postMessage({ command: "fixtureAck", message: "Replay matched." });
          } else if (message.command === "fixtureConflict" && refreshHead
            && process.env.PKM_PRIVATE_SUBSCRIPTION_REFRESH_FAULT === "2") {
            const locked = manager as unknown as { withStateMutation<T>(action: () => Promise<T>): Promise<T> };
            await locked.withStateMutation(async () => {
              check();
              const record = (manager.snapshot as any).subscriptions[0];
              if (!record || record.nodeId !== identity.nodeId || record.shareId !== shareId) throw new Error();
              manager.setSubscriptionPriority(record.id, "normal");
              await publish(shareId, refreshHead, false, true);
            });
            throw new Error("Conflicting fixture replay unexpectedly succeeded.");
          } else if (message.command === "fixtureStale" && refreshHead
            && process.env.PKM_PRIVATE_SUBSCRIPTION_REFRESH_FAULT === "2") {
            const locked = manager as unknown as { withStateMutation<T>(action: () => Promise<T>): Promise<T> };
            await locked.withStateMutation(async () => { check(); await publish(shareId, null, false, false); });
            throw new Error("Stale fixture publication unexpectedly succeeded.");
          } else if (message.command === "fixtureRestore" && refreshHead
            && process.env.PKM_PRIVATE_SUBSCRIPTION_REFRESH_FAULT === "2") {
            const locked = manager as unknown as { withStateMutation<T>(action: () => Promise<T>): Promise<T> };
            await locked.withStateMutation(async () => {
              const record = (manager.snapshot as any).subscriptions[0];
              if (!record || record.nodeId !== identity.nodeId || record.shareId !== shareId) throw new Error();
              manager.setSubscriptionPriority(record.id, "highest");
              check();
              await publish(shareId, refreshHead, false, true);
            });
            await view.webview.postMessage({ command: "fixtureAck", message: "Fixture restored." });
          } else if (message.command === "fixtureSameRevision" && refreshHead
            && process.env.PKM_PRIVATE_SUBSCRIPTION_REFRESH_FAULT === "3") {
            const locked = manager as unknown as { withStateMutation<T>(action: () => Promise<T>): Promise<T> };
            await locked.withStateMutation(async () => { check(); await publish(shareId, refreshHead, false, false); });
            throw new Error("Conflicting fixture publication unexpectedly succeeded.");
          } else if (message.command === "fixtureForeignConflict" && refreshHead
            && process.env.PKM_PRIVATE_SUBSCRIPTION_REFRESH_FAULT === "5") {
            const locked = manager as unknown as { withStateMutation<T>(action: () => Promise<T>): Promise<T> };
            await locked.withStateMutation(async () => {
              const foreign = (manager.snapshot as any).subscriptions.find((record: any) => record.shareId !== shareId);
              if (!foreign || foreign.priority !== "normal") throw new Error();
              await checkRecord(foreign);
              manager.setSubscriptionPriority(foreign.id, "highest");
              try { await publish(shareId, refreshHead, false, false); }
              finally { manager.setSubscriptionPriority(foreign.id, "normal"); }
            });
            throw new Error("Foreign fixture publication unexpectedly succeeded.");
          } else if (message.command === "subscriptionSetPriority" && typeof message.id === "string"
            && ["normal", "high", "highest"].includes(message.priority)) {
            const locked = manager as unknown as { withStateMutation<T>(action: () => Promise<T>): Promise<T> };
            await locked.withStateMutation(async () => {
              check();
              const record = manager.subscription(message.id);
              await checkRecord(record);
              manager.setSubscriptionPriority(message.id, message.priority);
              await checkRecord(record);
              refreshHead = await publish(record.shareId, refreshHead, false, false, false, false, true, record.nodeId);
            });
            await send();
          } else throw new Error();
        } catch (error) {
          if (["1", "6"].includes(process.env.PKM_PRIVATE_SUBSCRIPTION_REFRESH_FAULT || "")
            && error instanceof Error && error.message === "Private Subscription injected transaction interruption.")
            await view.webview.postMessage({ command: "fixtureAck", message: "Transaction interrupted at injected boundary." });
          if (["4", "7"].includes(process.env.PKM_PRIVATE_SUBSCRIPTION_REFRESH_FAULT || "")
            && error instanceof Error && error.message === "Private Subscription injected committed interruption.")
            await view.webview.postMessage({ command: "fixtureAck", message: "Committed transaction interrupted before reply." });
          if (["2", "3", "5"].includes(process.env.PKM_PRIVATE_SUBSCRIPTION_REFRESH_FAULT || "")
            && error instanceof Error && error.message === "Private Subscription publication conflict.")
            await view.webview.postMessage({ command: "fixtureAck", message: "Publication conflict." });
          await view.webview.postMessage({ command: "fixtureError", message: "Private Subscription action denied." });
        }
      }).catch(() => {});
    }, undefined, context.subscriptions);
    view.onDidDispose(() => { manager.dispose(); panel = undefined; }, undefined, context.subscriptions);
    return { opened: true };
  }));
}
