import { randomUUID } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { localFixtureGitProvider } from "./legacy-github-sync-fixture-provider.js";
import { openExperimentalLegacySyncHost } from "./legacy-github-sync-experimental-host.js";
import { Storage } from "./storage.js";
import { syncTransportPolicySchema } from "./sync-transport-contracts.js";

type Pending = { resolve(value: string | undefined): void; reject(error: Error): void; timer: NodeJS.Timeout };
const requests = new Map<string, Pending>();
let session: string | undefined, started = false, closing = false;
let storage: Storage | undefined;
let host: Awaited<ReturnType<typeof openExperimentalLegacySyncHost>> | undefined;
const send = (message: object) => { if (!process.connected || !process.send) throw new Error("Host disconnected"); process.send(message); };
const fail = () => new Error("Private Sync fixture denied.");

function privateDirectory(file: string): void {
  const stat = lstatSync(file);
  if (realpathSync(file) !== file || !stat.isDirectory() || stat.isSymbolicLink()
    || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) throw fail();
}

function readSecret(key: string, signal: AbortSignal): Promise<string | undefined> {
  if (!session || closing || signal.aborted || key !== "personalKnowledge.githubSync.vscode.fixture-target") return Promise.reject(fail());
  const requestId = randomUUID();
  return new Promise((resolveValue, reject) => {
    const timer = setTimeout(() => {
      const request = requests.get(requestId);
      if (request) { requests.delete(requestId); request.reject(fail()); }
    }, 10_000);
    const abort = () => {
      const request = requests.get(requestId);
      if (request) { clearTimeout(request.timer); requests.delete(requestId); reject(fail()); }
    };
    signal.addEventListener("abort", abort, { once: true });
    requests.set(requestId, {
      timer, reject: error => { signal.removeEventListener("abort", abort); reject(error); },
      resolve: value => { signal.removeEventListener("abort", abort); resolveValue(value); },
    });
    if (signal.aborted) { abort(); return; }
    try { send({ type: "credential-request", session, requestId, key }); }
    catch { abort(); }
  });
}

async function close() {
  if (closing) return;
  closing = true;
  for (const request of requests.values()) { clearTimeout(request.timer); request.reject(fail()); }
  requests.clear();
  try { await host?.close(); } finally { await storage?.close(); }
}

process.on("disconnect", () => {
  if (!closing) void close().finally(() => { process.exitCode = 1; });
});
process.on("message", (raw: unknown) => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
  const message = raw as Record<string, unknown>;
  if (message.type === "credential-response" && message.session === session && typeof message.requestId === "string") {
    const request = requests.get(message.requestId);
    if (!request) return;
    requests.delete(message.requestId); clearTimeout(request.timer);
    if (message.value === undefined || typeof message.value === "string" && Buffer.byteLength(message.value) <= 16_384)
      request.resolve(message.value);
    else request.reject(fail());
    return;
  }
  if (message.type !== "start" || started) return;
  started = true;
  void (async () => {
    if (typeof message.session !== "string" || !/^[a-f0-9-]{36}$/.test(message.session)
      || typeof message.fixture !== "string" || resolve(message.fixture) !== message.fixture
      || message.sameRoot !== undefined && typeof message.sameRoot !== "boolean"
      || !["sync", "resume", "crash"].includes(String(message.action))) throw fail();
    session = message.session;
    const fixture = message.fixture, root = join(fixture, message.sameRoot ? "legacy-root" : "native-root"),
      profile = join(fixture, "u/User/globalStorage/uone.personal-knowledge");
    const providerDir = join(fixture, "provider"), bare = join(fixture, "remote.git");
    for (const dir of [fixture, root, profile, providerDir, bare]) privateDirectory(dir);
    const policy = syncTransportPolicySchema.parse(message.policy);
    if (policy.owner !== "fixture" || policy.repository !== "fixture" || policy.branch !== "main"
      || policy.expectedLogin !== "fixture" || policy.allowPrivate || policy.visibility !== "public") throw fail();
    const provider = localFixtureGitProvider(providerDir, bare, policy);
    storage = await Storage.open(root, { deferRecovery: message.action === "resume" });
    host = await openExperimentalLegacySyncHost({
      mode: "isolated-experiment", storage, globalStorage: profile, targetId: "fixture-target",
      actorId: "vscode-private-sync-fixture", transport: provider.host,
      publisherPolicy: { policyId: policy.policyId, enforcement: "all-repository-ref-writers" }, readSecret,
    });
    if (message.action === "crash") {
      provider.loseNextPushResponse();
      try { await host.sync(); } catch { /* The fixture deliberately loses the publish response. */ }
      if (host.status().phase !== "publishing" || provider.pushes !== 1) throw fail();
      process.exit(77);
    }
    const result = await (message.action === "resume" ? host.resume() : host.sync());
    send({ type: "result", session, result, pushes: provider.pushes });
    await close();
    if (process.connected) process.disconnect?.();
  })().catch(async error => {
    const code = error && typeof error === "object" && "code" in error && error.code === "LEGACY_WRITERS_ACTIVE"
      ? "LEGACY_WRITERS_ACTIVE" : "FIXTURE_DENIED";
    try { if (session && process.connected) send({ type: "error", session, code }); } catch { /* Host exited. */ }
    try { await close(); } finally { process.exitCode = 1; if (process.connected) process.disconnect?.(); }
  });
});
