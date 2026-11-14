import { ChildProcess, fork } from "child_process";
import { randomBytes, randomUUID, timingSafeEqual } from "crypto";
import * as fs from "fs";
import * as http from "http";
import * as path from "path";
import { withCrossProcessLock } from "../runtime/cross-process-lock";
import { withAuthenticatedSubscriptionPull } from "./authenticated-pull";
import { installNativeRemoteSubscriptionTransport } from "./native-remote-transport";
import { fetchPrivateGitHubSubscription } from "./native-github-snapshot";
import { parseShareMagicLink, SharedMarketManager } from "./subscriptions";

type Add = { action: "add"; publisherNodeId: string; shareId: string; magicLink: string; alias: string; endpoint: string; secretSalt: string | null };
type Remove = { action: "remove"; publisherNodeId: string; shareId: string; subscriptionId: string };
type Priority = { action: "priority"; publisherNodeId: string; shareId: string; subscriptionId: string;
  priority: "normal" | "high" | "highest" };
type Rename = { action: "rename"; publisherNodeId: string; shareId: string; subscriptionId: string; alias: string };
type Refresh = { action: "refresh"; publisherNodeId: string; shareId: string; subscriptionId: string };
type GitHubRefresh = { action: "github-refresh"; publisherNodeId: string; shareId: string; subscriptionId: string;
  repository: string; branch: string; commit: string; credentialTargetId: string | null;
  files: { path: string; size: number; sha256: string }[] };
type Change = Add | Remove | Priority | Rename | Refresh | GitHubRefresh;
type Status = { head: string; state: { nodeId: string; shares: any[]; subscriptions: any[] };
  pending: { operationId: string; action: "add" | "remove" | "priority" | "rename" | "refresh" | "github-refresh";
    publisherNodeId: string; shareId: string; subscriptionId: string | null; githubRequest?: GitHubRefresh } | null };

function privateDirectory(directory: string): fs.Stats {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(directory) !== directory
    || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) throw new Error("Private Subscription directory denied.");
  return stat;
}

function privateJson(file: string): any {
  const before = fs.lstatSync(file, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.uid !== BigInt(process.getuid!())
    || (Number(before.mode) & 0o077) !== 0 || before.size > 16384n) throw new Error("Private Subscription grant denied.");
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const bytes = fs.readFileSync(fd), after = fs.fstatSync(fd, { bigint: true }), current = fs.lstatSync(file, { bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs || BigInt(bytes.length) !== before.size
      || current.dev !== before.dev || current.ino !== before.ino || current.mtimeNs !== before.mtimeNs
      || current.ctimeNs !== before.ctimeNs) throw new Error("Private Subscription grant changed.");
    return JSON.parse(bytes.toString("utf8"));
  } finally { fs.closeSync(fd); }
}

function processStart(pid: number): string | undefined {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8"), end = stat.lastIndexOf(")");
    const start = stat.slice(end + 2).trim().split(/\s+/)[19];
    if (end < 0 || !/^\d+$/.test(start || "")) throw new Error("Process identity unavailable.");
    return start;
  } catch (error: any) {
    if (error.code === "ENOENT" || error.code === "ESRCH") return undefined;
    throw error;
  }
}

class HostIpc {
  constructor(private readonly child: ChildProcess) {}
  request(phase: string, extra: Record<string, unknown> = {}): Promise<any> {
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const finish = (error?: Error, value?: unknown) => {
        clearTimeout(timer); this.child.off("message", receive); this.child.off("exit", exited);
        error ? reject(error) : resolve(value);
      };
      const receive = (message: any) => {
        if (message?.id !== id) return;
        if (!message.ok) finish(new Error(`Native Subscription action rejected: ${String(message.code || "UNKNOWN")}`));
        else finish(undefined, message.result);
      };
      const exited = () => finish(new Error("Native Subscription host exited; inspect pending action before retry."));
      const timer = setTimeout(() => finish(new Error("Native Subscription outcome is unknown; inspect before retry.")), 60_000);
      this.child.on("message", receive); this.child.once("exit", exited);
      this.child.send!({ type: "native-subscription-host/v1", id, phase, ...extra }, error => {
        if (error) finish(new Error("Native Subscription IPC is unavailable."));
      });
    });
  }
}

/** Starts only on a caller-created private synthetic copy, before VS Code is launched. */
export async function runNativeSubscriptionCoordinator(input: {
  fixture: string; root: string; profile: string; cli: string; gateway: string; grant: string;
}): Promise<void> {
  if (process.platform !== "linux" || process.env.PKM_PRIVATE_NATIVE_SUBSCRIPTION !== "1"
    || process.env.PKM_EXPERIMENTAL_SUBSCRIPTION_HOST !== "1") throw new Error("Private Subscription experiment is disabled.");
  const { fixture, root, profile, cli, gateway, grant } = input;
  for (const dir of [fixture, root, profile, path.dirname(grant)]) privateDirectory(dir);
  const inside = (file: string) => {
    const relative = path.relative(fixture, file);
    return !!relative && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  };
  if (!/^pkm-native-subscription-ui-[a-f0-9-]{36}$/.test(path.basename(fixture))
    || path.dirname(root) !== fixture || path.dirname(profile) !== fixture
    || path.resolve(cli) !== cli || path.resolve(gateway) !== gateway
    || fs.realpathSync(cli) !== cli || fs.realpathSync(gateway) !== gateway || !inside(cli) || !inside(gateway)
    || grant !== path.join(fixture, "u", "User", "globalStorage", "uone.personal-knowledge", "native-subscription-ui.json"))
    throw new Error("Private Subscription paths denied.");
  const marker = privateJson(path.join(fixture, "native-subscription-fixture.json"));
  const rootStat = fs.lstatSync(root, { bigint: true }), profileStat = fs.lstatSync(profile, { bigint: true });
  if (marker.schema !== "pkm.native-subscription-ui-fixture/v1" || !/^[a-f0-9-]{36}$/.test(marker.nonce)
    || marker.root !== `${rootStat.dev}:${rootStat.ino}` || marker.profile !== `${profileStat.dev}:${profileStat.ino}`)
    throw new Error("Private Subscription fixture identity denied.");
  const assertFixture = () => {
    privateDirectory(fixture); privateDirectory(root); privateDirectory(profile);
    const rootNow = fs.lstatSync(root, { bigint: true }), profileNow = fs.lstatSync(profile, { bigint: true });
    if (`${rootNow.dev}:${rootNow.ino}` !== marker.root || `${profileNow.dev}:${profileNow.ino}` !== marker.profile
      || JSON.stringify(privateJson(path.join(fixture, "native-subscription-fixture.json"))) !== JSON.stringify(marker))
      throw new Error("Private Subscription fixture identity changed.");
  };
  const bearer = randomBytes(32).toString("base64url"), nextBearer = randomBytes(32).toString("base64url");
  let createdGrant: fs.Stats | undefined;
  await withCrossProcessLock(path.join(profile, "subscriptions-state.lock"), "Subscription state mutation", 2000, async () => {
    if (fs.existsSync(grant)) {
      const before = fs.lstatSync(grant), previous = privateJson(grant);
      if (previous.schema !== "pkm.native-subscription-ui/v1" || previous.nonce !== marker.nonce
        || previous.fixture !== fixture || previous.root !== root || previous.profile !== profile
        || previous.rootPin !== marker.root || previous.profilePin !== marker.profile
        || previous.pidNamespace !== fs.readlinkSync("/proc/self/ns/pid")
        || !Number.isSafeInteger(previous.ownerPid) || previous.ownerPid <= 1 || !/^\d+$/.test(previous.ownerStart)
        || processStart(previous.ownerPid) === previous.ownerStart) throw new Error("Private Subscription grant ownership is not recoverable.");
      const after = fs.lstatSync(grant);
      if (after.dev !== before.dev || after.ino !== before.ino || after.mtimeMs !== before.mtimeMs
        || after.ctimeMs !== before.ctimeMs) throw new Error("Private Subscription grant changed during recovery.");
      fs.unlinkSync(grant);
    }
    const state = privateJson(path.join(profile, "subscriptions.json"));
    const secrets = new Map<string, string>();
    const manager = Object.create(SharedMarketManager.prototype) as SharedMarketManager;
    Object.assign(manager, {
      storageDir: profile, gatewayScript: gateway, events: {},
      secrets: { async get(key: string) { return secrets.get(key); }, async store(key: string, value: string) { secrets.set(key, value); },
        async delete(key: string) { secrets.delete(key); } },
      state, mqttClients: new Map(), gatewayStatus: "stopped", gatewayError: "", gatewayStartupDeadline: 0,
      gatewayStartupLastError: "", gatewayConfigurationId: "", disposed: false, warned: new Set(), publishedRefreshAgain: false,
      publisherUser: "synthetic", publisherHost: "synthetic", gatewayRuntimeVersion: "synthetic", stateMutationDepth: 1,
      mqttRefreshesInFlight: new Set(), connectMqtt: () => {},
    });
    installNativeRemoteSubscriptionTransport(manager, profile, {
      control: url => url.origin === "http://127.0.0.1:23002",
      transfer: url => url.protocol === "http:" && url.hostname === "127.0.0.1" && url.port !== "23002",
    });
    const child = fork(cli, ["http", "--data", root], { stdio: ["ignore", "pipe", "pipe", "ipc"], env: {
      PATH: process.env.PATH || "", PKM_NEXT_TOKEN: nextBearer, PKM_EXPERIMENTAL_SUBSCRIPTION_HOST: "1",
      PKM_EXPERIMENTAL_SUBSCRIPTION_PROFILE: profile,
    } });
    const ipc = new HostIpc(child);
    let server: http.Server | undefined;
    const closeChild = async () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const done = new Promise<void>(resolve => child.once("exit", () => resolve()));
      child.kill("SIGTERM"); await done;
    };
    try {
      const nextUrl = await new Promise<string>((resolve, reject) => {
        let output = "", diagnostic = "";
        child.stderr!.on("data", chunk => { if (diagnostic.length < 32768) diagnostic += chunk.toString(); });
        const timer = setTimeout(() => reject(new Error("Native Subscription CLI startup timed out.")), 30_000);
        child.once("error", reject);
        child.once("exit", () => {
          clearTimeout(timer);
          const code = /\bcode: '([A-Z_]+)'/.exec(diagnostic)?.[1];
          reject(new Error(`Native Subscription CLI startup denied by writer guard or host validation${code ? ` (${code})` : ""}.`));
        });
        child.stdout!.on("data", chunk => {
          output += chunk.toString();
          if (output.length > 16384) { clearTimeout(timer); reject(new Error("Native Subscription CLI output denied.")); return; }
          if (!output.includes("\n")) return;
          try {
            const ready = JSON.parse(output.slice(0, output.indexOf("\n"))), url = new URL(ready.url);
            if (!ready.ready || url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port) throw new Error();
            clearTimeout(timer); resolve(url.origin);
          } catch { clearTimeout(timer); reject(new Error("Native Subscription CLI readiness denied.")); }
        });
      });
      let status: Status | null = await ipc.request("status");
      if (!status) { await ipc.request("admit"); status = await ipc.request("status"); }
      if (!status) throw new Error("Native Subscription admission unavailable.");
      let recoveryBlocked = false;
      if (status.pending?.action === "refresh") {
        try { await ipc.request("recover", { operationId: status.pending.operationId }); }
        catch { recoveryBlocked = true; console.error("Subscription refresh recovery requires review; pending state was preserved."); }
      }
      const current = async (): Promise<Status> => {
        const value = await ipc.request("status");
        if (!value) throw new Error("Native Subscription admission unavailable.");
        return value;
      };
      const checkChange = async (operationId: string, change: Change) =>
        ipc.request("check", { operationId, change });
      const addChange = (magicLink: string, alias: string, secret: string): Add => {
        const link = parseShareMagicLink(magicLink), url = new URL(link.endpoint);
        let secretSalt: string | null = null;
        if (link.secretProtected) {
          const parsed = /^pkms:v1:(\d{4,5}):([A-Za-z0-9_-]{16,128}):([A-Za-z0-9_-]{16,})$/.exec(secret);
          if (!parsed) throw new Error("Protected Subscription secret is invalid.");
          url.port = parsed[1]!; secretSalt = parsed[2]!;
        }
        if (url.origin !== "http://127.0.0.1:23002" || url.username || url.password || url.pathname !== "/" || url.search || url.hash)
          throw new Error("Private Subscription endpoint denied.");
        return { action: "add", publisherNodeId: link.nodeId, shareId: link.shareId,
          magicLink, alias, endpoint: url.origin, secretSalt };
      };
      let queue: Promise<unknown> = Promise.resolve();
      const dispatch = async (body: any) => {
        assertFixture();
        if (!body || typeof body !== "object" || Array.isArray(body) || typeof body.command !== "string")
          throw new Error("Subscription action denied.");
        const allowed = ["state", "cancel", "inspect-recovery", "recheck-recovery"].includes(body.command) ? ["command"]
          : body.command === "add" ? ["alias", "command", "magicLink", "retry", "secret"]
          : body.command === "remove" ? ["command", "id", "retry"]
          : body.command === "priority" ? ["command", "id", "priority", "retry"]
          : body.command === "rename" ? ["alias", "command", "id", "retry"]
          : body.command === "refresh" ? ["command", "id", "material", "retry"]
          : body.command === "github-refresh" ? ["account", "command", "credentialTargetId", "id", "retry", "token"] : [];
        if (!allowed.length || Object.keys(body).some(key => !allowed.includes(key))
          || body.retry !== undefined && typeof body.retry !== "boolean") throw new Error("Subscription action denied.");
        const view = await current();
        if (body.command === "state") {
          if (!view.pending) {
            recoveryBlocked = false;
            const subscriptions: any[] = [];
            let offset = 0, revision: string | undefined;
            do {
              const response = await fetch(`${nextUrl}/v1/capability_read`, { method: "POST",
                headers: { authorization: `Bearer ${nextBearer}`, "content-type": "application/json" },
                body: JSON.stringify({ operation: "subscription.list", version: 1,
                  arguments: { limit: 100, offset, ...(revision ? { expectedRevision: revision } : {}) } }),
                redirect: "error", signal: AbortSignal.timeout(10_000) });
              const result: any = await response.json();
              if (!response.ok || result.error || !Array.isArray(result.result?.items)
                || subscriptions.length + result.result.items.length > 4096) throw new Error("Native Subscription read unavailable.");
              revision = result.result.revision;
              for (const item of result.result.items) {
                const source = view.state.subscriptions.find(record => record.id === item.id);
                if (!source) throw new Error("Native Subscription head changed.");
                subscriptions.push({ ...item, endpoint: source.endpoint,
                  ...(source.source?.type === "github" ? { source: source.source } : {}) });
              }
              if (result.result.nextOffset === null) break;
              if (!Number.isSafeInteger(result.result.nextOffset) || result.result.nextOffset <= offset)
                throw new Error("Native Subscription page is invalid.");
              offset = result.result.nextOffset;
            } while (true);
            if (subscriptions.length !== view.state.subscriptions.length || (await current()).head !== view.head)
              throw new Error("Native Subscription head changed.");
            return { state: view.state, subscriptions, pending: null };
          }
          return { state: view.state, subscriptions: view.state.subscriptions, pending: view.pending, recoveryBlocked };
        }
        if (body.command === "cancel") {
          if (!view.pending) throw new Error("No pending action.");
          return ipc.request("cancel", { operationId: view.pending.operationId });
        }
        if (body.command === "inspect-recovery" || body.command === "recheck-recovery") {
          const pending = view.pending;
          if (!pending || !["refresh", "github-refresh"].includes(pending.action) || !pending.subscriptionId)
            throw new Error("No pending Subscription refresh.");
          const change: Refresh | GitHubRefresh = pending.action === "github-refresh" && pending.githubRequest
            ? pending.githubRequest : { action: "refresh", publisherNodeId: pending.publisherNodeId,
              shareId: pending.shareId, subscriptionId: pending.subscriptionId };
          if (body.command === "recheck-recovery") {
            if (pending.action === "refresh") await ipc.request("recover", { operationId: pending.operationId });
            await checkChange(pending.operationId, change);
            recoveryBlocked = false;
            return { canRetry: true };
          }
          const node = path.join(profile, "cache", pending.publisherNodeId);
          let entries: string[] = [];
          try {
            const stat = fs.lstatSync(node);
            if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(node) !== node
              || stat.uid !== process.getuid?.() || (stat.mode & 0o002) !== 0)
              throw new Error("Subscription recovery folder is unavailable.");
            entries = fs.readdirSync(node).filter(name => name.startsWith(`.${pending.shareId}.`)
              || name.startsWith(`${pending.shareId}.mount-`) || name.startsWith(`${pending.shareId}.previous`)).sort();
            if (entries.length > 256) throw new Error("Subscription recovery inventory is too large.");
          } catch (error: any) { if (error?.code !== "ENOENT") throw error; }
          let canRetry = false;
          try { await checkChange(pending.operationId, change); canRetry = true; } catch { /* Preserve unknown state. */ }
          return { action: pending.action, operationId: pending.operationId, nodeId: pending.publisherNodeId,
            shareId: pending.shareId, entries, canRetry,
            ...(pending.githubRequest ? { repository: pending.githubRequest.repository, branch: pending.githubRequest.branch,
              commit: pending.githubRequest.commit } : {}) };
        }
        if (!view.pending && body.retry === true)
          throw new Error("The pending action was already resolved; inspect its outcome before a new action.");
        if (body.command === "github-refresh") {
          const record = view.state.subscriptions.find(item => item.id === body.id), source = record?.source;
          const credentialTargetId = source?.credentialTargetId || source?.targetId || null;
          if (!record || source?.type !== "github" || typeof body.account !== "string"
            || credentialTargetId !== null && (typeof credentialTargetId !== "string" || typeof body.token !== "string")
            || body.credentialTargetId !== credentialTargetId || credentialTargetId === null && body.token !== undefined)
            throw new Error("GitHub Subscription credentials denied.");
          const pending = view.pending, operationId = pending?.operationId ?? randomUUID();
          if (pending) {
            if (body.retry !== true || pending.action !== "github-refresh" || pending.subscriptionId !== record.id
              || !pending.githubRequest) throw new Error("Pending GitHub action requires explicit exact recovery.");
            await checkChange(operationId, pending.githubRequest);
          }
          const pulled = await fetchPrivateGitHubSubscription(fixture, record, body.account,
            credentialTargetId === null ? undefined : { accessToken: body.token });
          const change: GitHubRefresh = { action: "github-refresh", publisherNodeId: record.nodeId,
            shareId: record.shareId, subscriptionId: record.id, repository: source.repository, branch: source.branch,
            commit: pulled.commit, credentialTargetId: body.credentialTargetId,
            files: pulled.files.map(({ path, size, sha256 }) => ({ path, size, sha256 })) };
          if (pending && JSON.stringify(change) !== JSON.stringify(pending.githubRequest))
            throw new Error("GitHub branch or selected content changed; inspect the pending result.");
          if (!pending) await ipc.request("prepare", { operationId, expectedHead: view.head, change });
          await checkChange(operationId, change);
          await manager.mountGitHubBranch({ name: record.brokerName || source.repository, repository: source.repository,
            branch: source.branch, commit: pulled.commit, targetId: source.targetId, credentialTargetId: source.credentialTargetId,
            account: body.account, selectedPaths: source.selectedPaths, selectedFolders: source.selectedFolders,
            files: pulled.files }, record.alias);
          await ipc.request("publish", { operationId, change, verifiedPull: true });
          return { completed: true };
        }
        let change: Change, secret = "";
        if (body.command === "add" && typeof body.magicLink === "string" && typeof body.alias === "string" && typeof body.secret === "string") {
          secret = body.secret.trim();
          change = addChange(body.magicLink.trim(), body.alias.trim(), secret);
        } else if (["remove", "priority", "rename", "refresh"].includes(body.command) && typeof body.id === "string") {
          const record = view.state.subscriptions.find(item => item.id === body.id);
          if (!record) throw new Error("Subscription is not in the admitted head.");
          if (body.command === "priority") {
            if (!["normal", "high", "highest"].includes(body.priority)) throw new Error("Subscription priority denied.");
            change = { action: "priority", publisherNodeId: record.nodeId, shareId: record.shareId,
              subscriptionId: record.id, priority: body.priority };
          } else if (body.command === "rename") {
            if (typeof body.alias !== "string" || body.alias.trim().length > 512) throw new Error("Subscription alias denied.");
            change = { action: "rename", publisherNodeId: record.nodeId, shareId: record.shareId,
              subscriptionId: record.id, alias: body.alias.trim() };
          } else if (body.command === "refresh") {
            if (record.source?.type === "github" || typeof body.material !== "string"
              || (record.secretProtected ? !/^[A-Za-z0-9_-]{16,}$/.test(body.material) || body.material.length > 512 : body.material !== ""))
              throw new Error("Subscription refresh credentials denied.");
            secret = body.material;
            change = { action: "refresh", publisherNodeId: record.nodeId, shareId: record.shareId, subscriptionId: record.id };
          } else change = { action: "remove", publisherNodeId: record.nodeId, shareId: record.shareId, subscriptionId: record.id };
        } else throw new Error("Subscription action denied.");
        const pending = view.pending;
        if (pending && (body.retry !== true || pending.action !== change.action || pending.publisherNodeId !== change.publisherNodeId
          || pending.shareId !== change.shareId || change.action !== "add" && pending.subscriptionId !== change.subscriptionId))
          throw new Error("Pending action requires explicit exact recovery.");
        const operationId = pending?.operationId ?? randomUUID();
        if (!pending) await ipc.request("prepare", { operationId, expectedHead: view.head, change });
        const inspected = await checkChange(operationId, change);
        if (change.action === "add") {
          await withAuthenticatedSubscriptionPull(manager, { nodeId: change.publisherNodeId, shareId: change.shareId },
            () => manager.subscribe(change.magicLink, change.alias, secret));
        } else if (change.action === "priority") {
          manager.setSubscriptionPriority(change.subscriptionId, change.priority);
        } else if (change.action === "rename") {
          manager.renameSubscription(change.subscriptionId, change.alias);
        } else if (change.action === "refresh") {
          const key = `personalKnowledge.subscription.${change.publisherNodeId}.${change.shareId}.secret`;
          if (secret) secrets.set(key, secret);
          try {
            await withAuthenticatedSubscriptionPull(manager, { nodeId: change.publisherNodeId, shareId: change.shareId },
              () => manager.refresh(change.subscriptionId, true));
          } finally { secrets.delete(key); }
        } else if (inspected.targetExists) {
          manager.removeSubscription(change.subscriptionId);
          const parent = path.join(profile, "cache", change.publisherNodeId);
          if (!(manager.snapshot as any).subscriptions.some((item: any) => item.nodeId === change.publisherNodeId)) {
            try { fs.rmdirSync(parent); } catch (error: any) { if (error.code !== "ENOENT") throw error; }
          }
        }
        await ipc.request("publish", { operationId, change, verifiedPull: change.action === "add" || change.action === "refresh" });
        return { completed: true };
      };
      server = http.createServer((request, response) => {
        const supplied = Buffer.from(String(request.headers.authorization || "")), expected = Buffer.from(`Bearer ${bearer}`);
        if (request.method !== "POST" || request.url !== "/subscription" || supplied.length !== expected.length
          || !timingSafeEqual(supplied, expected)) { response.writeHead(403).end(); return; }
        let input = "", tooLarge = false;
        request.on("data", chunk => { input += chunk.toString(); if (Buffer.byteLength(input) > 32768) { tooLarge = true; request.destroy(); } });
        request.on("end", () => {
          if (tooLarge) return;
          queue = queue.then(async () => {
            let command: string | undefined;
            try {
              const body = JSON.parse(input);
              command = body?.command;
              const result = await dispatch(body);
              response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify({ result }));
            } catch (error) {
              const message = error instanceof Error ? error.message : "";
              const code = command === "refresh" && message === "Broker returned 403." ? "BROKER_FORBIDDEN"
                : command === "refresh" && message === "Broker returned 401." ? "BROKER_UNAUTHORIZED"
                  : command === "refresh" && (message === "fetch failed" || message === "The operation was aborted due to timeout")
                    ? "BROKER_UNREACHABLE" : "RECOVERY_REQUIRED";
              response.writeHead(409, { "content-type": "application/json", "cache-control": "no-store" })
                .end(JSON.stringify({ error: "Subscription action failed or requires explicit recovery.", code }));
            }
          });
        });
      });
      await new Promise<void>((resolve, reject) => { server!.once("error", reject); server!.listen(0, "127.0.0.1", resolve); });
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Private Subscription endpoint unavailable.");
      const data = { schema: "pkm.native-subscription-ui/v1", nonce: marker.nonce, fixture, root, profile,
        rootPin: marker.root, profilePin: marker.profile, endpoint: `http://127.0.0.1:${address.port}`, bearer,
        ownerPid: process.pid, ownerStart: processStart(process.pid), pidNamespace: fs.readlinkSync("/proc/self/ns/pid") };
      fs.writeFileSync(grant, JSON.stringify(data), { flag: "wx", mode: 0o600 });
      createdGrant = fs.lstatSync(grant);
      process.stdout.write(JSON.stringify({ ready: true }) + "\n");
      await new Promise<void>(resolve => { process.once("SIGTERM", resolve); process.once("SIGINT", resolve); child.once("exit", resolve); });
      await new Promise<void>(resolve => server!.close(() => resolve()));
      await queue;
    } finally {
      if (createdGrant) {
        try {
          const current = fs.lstatSync(grant);
          if (current.dev === createdGrant.dev && current.ino === createdGrant.ino) fs.unlinkSync(grant);
        } catch (error: any) { if (error.code !== "ENOENT") throw error; }
      }
      server?.close(); await closeChild(); manager.dispose(); secrets.clear();
    }
  });
}
