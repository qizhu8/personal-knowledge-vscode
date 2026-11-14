import { fork } from "child_process";
import { randomUUID } from "crypto";
import * as fs from "fs";
import * as path from "path";
import type * as vscode from "vscode";
import { verifyNextPayload } from "./next-payload-verifier";

type FixtureAction = "sync" | "resume" | "crash";
type FixtureRequest = { fixture: string; action: FixtureAction; policy: unknown };

function privateDirectory(file: string): void {
  const stat = fs.lstatSync(file);
  if (fs.realpathSync(file) !== file || !stat.isDirectory() || stat.isSymbolicLink()
    || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) throw new Error("Private Sync fixture denied.");
}

/** Explicit synthetic-only bridge. Production cutover remains separately blocked. */
export async function runNextSyncFixture(context: vscode.ExtensionContext, configuredRoot: string, value: unknown): Promise<unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Private Sync fixture denied.");
  const request = value as FixtureRequest;
  if (process.platform !== "linux" || typeof request.fixture !== "string"
    || path.resolve(request.fixture) !== request.fixture
    || process.env.PKM_PRIVATE_SYNC_FIXTURE !== request.fixture
    || !/^pkm-sync-fixture-[a-f0-9-]{36}$/.test(path.basename(request.fixture))
    || !["sync", "resume", "crash"].includes(request.action)
    || Object.keys(value).some(key => !["fixture", "action", "policy"].includes(key))) throw new Error("Private Sync fixture denied.");
  const fixture = request.fixture, legacy = path.join(fixture, "legacy-root");
  const sameRoot = process.env.PKM_PRIVATE_SYNC_SAME_ROOT === "1";
  const root = sameRoot ? legacy : path.join(fixture, "native-root");
  const storage = path.join(fixture, "u/User/globalStorage/uone.personal-knowledge");
  for (const dir of [fixture, root, legacy, storage, path.join(fixture, "provider"), path.join(fixture, "remote.git"), path.join(fixture, "t")])
    privateDirectory(dir);
  if (fs.realpathSync(configuredRoot) !== legacy || fs.realpathSync(context.globalStorageUri.fsPath) !== storage
    || path.dirname(fs.realpathSync(context.extensionPath)) !== fs.realpathSync(path.join(fixture, "x")))
    throw new Error("Private Sync fixture denied.");
  const payload = verifyNextPayload(context.extensionPath);
  const entry = path.join(payload.root, "server/dist/legacy-github-sync-vscode-child.js");
  const stat = fs.lstatSync(entry);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Private Sync fixture denied.");
  const session = randomUUID();
  const child = fork(entry, [], { execPath: process.execPath, cwd: payload.root,
    env: { PATH: process.env.PATH || "", HOME: fixture, TMPDIR: path.join(fixture, "t"), ELECTRON_RUN_AS_NODE: "1",
      GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_ALLOW_PROTOCOL: "file", GIT_TERMINAL_PROMPT: "0" },
    stdio: ["ignore", "ignore", "ignore", "ipc"] });
  const seen = new Set<string>();
  let credentialReads = 0, result: unknown, failure = false, refusal: string | undefined;
  return new Promise((resolve, reject) => {
    let finished = false;
    const timer = setTimeout(() => { deny(); finish(null, "timeout"); }, 120_000);
    const deny = () => { failure = true; if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); };
    const lifetime = { dispose: () => { deny(); finish(null, "disposed"); } };
    context.subscriptions.push(lifetime);
    const finish = (code: number | null, signal: string | null) => {
      if (finished) return;
      finished = true; clearTimeout(timer);
      const index = context.subscriptions.indexOf(lifetime);
      if (index >= 0) context.subscriptions.splice(index, 1);
      if (!failure && request.action === "crash" && code === 77 && credentialReads > 0) {
        resolve({ state: "fixture-crash", credentialReads }); return;
      }
      if (!failure && code === 0 && result && (credentialReads > 0 || request.action === "resume")) {
        resolve({ ...(result as object), credentialReads }); return;
      }
      reject(new Error(`Private Sync child stopped (${refusal ?? code ?? signal ?? "unknown"}); outcome may require recovery. No automatic retry.`));
    };
    child.on("message", (raw: unknown) => {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return deny();
      const message = raw as Record<string, unknown>;
      if (message.session !== session) return deny();
      if (message.type === "credential-request") {
        if (typeof message.requestId !== "string" || !/^[a-f0-9-]{36}$/.test(message.requestId)
          || message.key !== "personalKnowledge.githubSync.vscode.fixture-target"
          || seen.has(message.requestId) || seen.size >= 10_000) return deny();
        const requestId = message.requestId;
        seen.add(requestId);
        void Promise.resolve(context.secrets.get(message.key)).then(value => {
          if (finished || failure || !child.connected) return;
          if (!value || Buffer.byteLength(value) > 16_384) return deny();
          let credential: unknown;
          try { credential = JSON.parse(value); } catch { return deny(); }
          if (!credential || typeof credential !== "object"
            || !("accountLabel" in credential) || credential.accountLabel !== "fixture"
            || !("accessToken" in credential) || credential.accessToken !== "fixture-token") return deny();
          credentialReads++;
          child.send({ type: "credential-response", session, requestId, value }, error => { if (error) deny(); });
        }, deny);
      } else if (message.type === "result") {
        if (result !== undefined || !message.result || typeof message.result !== "object"
          || !Number.isSafeInteger(message.pushes) || (message.pushes as number) < 0) return deny();
        result = { result: message.result, pushes: message.pushes };
      } else if (message.type === "error") {
        if (message.code !== "LEGACY_WRITERS_ACTIVE" && message.code !== "FIXTURE_DENIED") return deny();
        refusal = message.code; failure = true;
      }
      else deny();
    });
    child.once("error", () => { deny(); finish(null, "spawn-error"); });
    child.once("exit", finish);
    child.send({ type: "start", session, fixture, sameRoot, action: request.action, policy: request.policy }, error => { if (error) deny(); });
  });
}
