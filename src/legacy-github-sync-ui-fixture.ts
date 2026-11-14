import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { lstatSync, readFileSync, realpathSync, readlinkSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { localFixtureGitProvider } from "./legacy-github-sync-fixture-provider.js";
import { privateNativeGitUiProvider } from "./legacy-github-sync-native-ui-provider.js";
import { openExperimentalLegacySyncHost } from "./legacy-github-sync-experimental-host.js";
import { Storage } from "./storage.js";
import { syncTransportPolicySchema } from "./sync-transport-contracts.js";

/** Synthetic, private installed-UI controller; starts with the normal writer gate before Code. */
export async function runLegacySyncUiFixture(fixture: string): Promise<void> {
  if (process.platform !== "linux" || process.env.PKM_PRIVATE_NATIVE_SYNC_UI !== "1"
    || resolve(fixture) !== fixture || realpathSync(fixture) !== fixture
    || !/^pkm-native-sync-ui-[a-f0-9-]{36}$/.test(basename(fixture))) throw new Error("Private Sync fixture denied.");
  const root = join(fixture, "root"), profile = join(fixture, "u", "User", "globalStorage", "uone.personal-knowledge");
  const providerDir = join(fixture, "provider"), bare = join(fixture, "remote.git");
  for (const dir of [fixture, root, profile, providerDir, bare]) {
    const info = lstatSync(dir);
    if (!info.isDirectory() || info.isSymbolicLink() || realpathSync(dir) !== dir
      || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) throw new Error("Private Sync directory denied.");
  }
  const policyFile = join(fixture, "policy.json"), info = lstatSync(policyFile);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.uid !== process.getuid?.()
    || (info.mode & 0o077) !== 0 || info.size > 16384) throw new Error("Private Sync policy denied.");
  const policy = syncTransportPolicySchema.parse(JSON.parse(readFileSync(policyFile, "utf8")));
  const nativeGit = process.env.PKM_PRIVATE_SYNC_UI_NATIVE_GIT === "1";
  if (policy.owner !== "fixture" || policy.repository !== "fixture" || policy.branch !== "main"
    || policy.expectedLogin !== "fixture"
    || !(policy.visibility === "public" && !policy.allowPrivate || nativeGit && policy.visibility === "private" && policy.allowPrivate))
    throw new Error("Private Sync policy denied.");
  const storage = await Storage.open(root, { deferRecovery: true });
  const provider = nativeGit ? privateNativeGitUiProvider(fixture, profile, policy) : localFixtureGitProvider(providerDir, bare, policy);
  let credential: string | undefined;
  const host = await openExperimentalLegacySyncHost({ mode: "isolated-experiment", storage, globalStorage: profile,
    targetId: "fixture-target", actorId: "private-installed-sync", transport: provider.host,
    ...(process.env.PKM_PRIVATE_SYNC_UI_NATIVE_TRASH === "1" ? { experimentalNativeTrash: true as const } : {}),
    publisherPolicy: { policyId: policy.policyId, enforcement: nativeGit ? "atomic-git-lease" : "all-repository-ref-writers" },
    readSecret: async key => key === "personalKnowledge.githubSync.vscode.fixture-target" ? credential : undefined });
  const bearer = randomBytes(32).toString("base64url");
  let queue = Promise.resolve();
  const server = createServer((request, response) => {
    if (request.method !== "POST" || request.url !== "/sync" || request.socket.remoteAddress !== "127.0.0.1"
      || request.headers.authorization !== `Bearer ${bearer}`) { response.writeHead(403).end(); return; }
    let body = "";
    request.setEncoding("utf8");
    request.on("data", chunk => { body += chunk; if (body.length > 32768) request.destroy(); });
    request.on("end", () => {
      queue = queue.then(async () => {
        let value: unknown;
        try {
          const input = JSON.parse(body);
          if (!input || typeof input !== "object" || Array.isArray(input)
            || typeof input.action !== "string") throw new Error("Invalid request.");
          if (input.credential !== undefined) {
            const parsed = JSON.parse(input.credential);
            if (parsed.accountLabel !== "fixture" || parsed.accessToken !== "fixture-token")
              throw new Error("Synthetic credential denied.");
            credential = input.credential;
          }
          if (input.action === "state") {
            const status = host.status();
            value = { status, pushes: provider.pushes, comparison: ["comparison", "conflict"].includes(status.phase)
              ? await host.inspectComparison() : undefined };
          } else if (input.action === "sync") value = await host.sync();
          else if (input.action === "resume") value = await host.resume();
          else if (input.action === "decide") value = await host.decide(input.decision);
          else if (input.action === "confirm") value = await host.confirmComparison(input.sessionId);
          else if (input.action === "discard") value = await host.discardComparison(input.sessionId);
          else if (input.action === "test-drop-response" && process.env.PKM_PRIVATE_SYNC_UI_FAULTS === "1") {
            provider.loseNextPushResponse(); value = { armed: true };
          } else throw new Error("Unsupported Sync action.");
          response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ value }));
        } catch (error) {
          const text = error instanceof Error ? error.message : "Sync request failed.";
          response.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: text }));
        } finally { credential = undefined; }
      }).catch(() => { if (!response.writableEnded) response.writeHead(500).end(); });
    });
  });
  await new Promise<void>((done, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", done); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Private Sync listener failed.");
  const rootStat = lstatSync(root, { bigint: true }), profileStat = lstatSync(profile, { bigint: true });
  const stat = readFileSync(`/proc/${process.pid}/stat`, "utf8"), end = stat.lastIndexOf(")");
  const grant = { schema: "pkm.private-native-sync-ui/v1", fixture, root, profile,
    rootPin: `${rootStat.dev}:${rootStat.ino}`, profilePin: `${profileStat.dev}:${profileStat.ino}`,
    endpoint: `http://127.0.0.1:${address.port}/`, bearer, ownerPid: process.pid,
    ownerStart: stat.slice(end + 2).trim().split(/\s+/)[19], pidNamespace: readlinkSync("/proc/self/ns/pid") };
  writeFileSync(join(profile, "native-sync-ui.json"), JSON.stringify(grant), { mode: 0o600, flag: "wx" });
  process.stdout.write("READY\n");
  const close = async () => {
    server.close();
    await queue;
    await host.close();
    await storage.close();
  };
  process.once("SIGTERM", () => { void close().finally(() => process.exit(0)); });
}

if (process.env.PKM_PRIVATE_NATIVE_SYNC_UI === "1" && process.argv[1]
  && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  void runLegacySyncUiFixture(process.env.PKM_PRIVATE_SYNC_UI_FIXTURE || "")
    .catch(error => { console.error(error instanceof Error ? error.message : "Private Sync failed."); process.exitCode = 1; });
}
