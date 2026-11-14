import * as fs from "fs";
import * as net from "net";
import * as path from "path";
import { fork } from "child_process";
import type * as vscode from "vscode";
import { verifyNextPayload } from "./next-payload-verifier";
import { signProtectedSubscriptionFixture } from "./next-protected-subscription-signing-fixture";
import { registerProtectedSubscriptionUiFixture, type MembershipChange } from "./next-protected-subscription-ui-fixture";

function deny(): never { throw new Error("Private Subscription fixture denied."); }
function privateDirectory(dir: string): void {
  const stat = fs.lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(dir) !== dir
    || stat.uid !== process.getuid?.() || (stat.mode & 0o7077) !== 0) deny();
}
function readMarker(file: string): Record<string, unknown> {
  const before = fs.lstatSync(file, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n
    || before.uid !== BigInt(process.getuid!()) || (Number(before.mode) & 0o7077) !== 0 || before.size > 4096n) deny();
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const bytes = fs.readFileSync(fd), opened = fs.fstatSync(fd, { bigint: true }), after = fs.lstatSync(file, { bigint: true });
    const same = (value: typeof before) => value.dev === before.dev && value.ino === before.ino && value.nlink === before.nlink
      && value.mode === before.mode && value.size === before.size && value.mtimeNs === before.mtimeNs && value.ctimeNs === before.ctimeNs;
    if (!same(opened) || !same(after) || BigInt(bytes.length) !== before.size) deny();
    const marker: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (!marker || typeof marker !== "object" || Array.isArray(marker)) deny();
    return marker as Record<string, unknown>;
  } catch { return deny(); } finally { fs.closeSync(fd); }
}
async function importedBinding(entry: string, fixture: string, nonce: string, shareId: string,
  action: "binding" | "refresh" | "membership-prepare" | "membership-check" | "membership-publish" | "membership-cancel" | "membership-outcome" = "binding",
  expectedHead: string | null = null,
  crashAfterFirstFile = false, replayOnly = false, crashAfterCommit = false, failure = false, priority = false,
  publisherNodeId?: string, membership?: { operationId: string; change?: MembershipChange; verifiedPull?: boolean }): Promise<any> {
  const node = process.env.PKM_PRIVATE_SUBSCRIPTION_NODE;
  if (!node || !path.isAbsolute(node) || fs.realpathSync(node) !== node || !fs.statSync(node).isFile()) deny();
  return await new Promise((resolve, reject) => {
    const child = fork(entry, [], { execPath: node, stdio: ["ignore", "ignore", "ignore", "ipc"],
      env: { PATH: process.env.PATH || "", HOME: path.join(fixture, "h"), TMPDIR: path.join(fixture, "t"),
        PKM_PRIVATE_SUBSCRIPTION_STATE_IMPORT: fixture,
        PKM_PRIVATE_SUBSCRIPTION_UI: process.env.PKM_PRIVATE_SUBSCRIPTION_UI || "0",
        PKM_PRIVATE_SUBSCRIPTION_REFRESH_FAULT: process.env.PKM_PRIVATE_SUBSCRIPTION_REFRESH_FAULT || "0" } });
    let result: any;
    const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
    child.on("message", value => { result = value; });
    child.once("error", () => { clearTimeout(timer); reject(new Error("Private Subscription binding denied.")); });
    child.once("exit", status => {
      clearTimeout(timer);
      if (status === 0 && result?.type === "result"
        && (action === "binding" ? !!result.statePlan
          : action === "refresh" || action === "membership-publish" ? typeof result.refreshHead === "string" : true)) resolve(result);
      else if ((action === "refresh" || action === "membership-publish") && crashAfterFirstFile && status === 80)
        reject(new Error("Private Subscription injected transaction interruption."));
      else if ((action === "refresh" || action === "membership-publish") && crashAfterCommit && status === 81)
        reject(new Error("Private Subscription injected committed interruption."));
      else if (action !== "binding" && status === 0 && result?.type === "error" && result.code === "CONFLICT")
        reject(new Error("Private Subscription publication conflict."));
      else reject(new Error("Private Subscription binding denied."));
    });
    child.send({ fixture, nonce, shareId, action,
      ...(action === "refresh" ? { expectedHead, crashAfterFirstFile, replayOnly, crashAfterCommit, failure, priority, publisherNodeId } : {}),
      ...(membership ? { ...membership, expectedHead, crashAfterFirstFile, crashAfterCommit } : {}) });
  });
}

/** Synthetic-profile-only SecretStorage bridge; it never returns the secret to the caller. */
export function registerProtectedSubscriptionFixture(context: vscode.ExtensionContext): void {
  const fixture = process.env.PKM_PRIVATE_SUBSCRIPTION_STATE_IMPORT;
  if (process.platform !== "linux" || !fixture || path.resolve(fixture) !== fixture
    || !/^pkm-protected-state-fixture-[a-f0-9-]{36}$/.test(path.basename(fixture))) deny();
  for (const dir of [fixture, path.join(fixture, "original"), path.join(fixture, "profile"),
    path.join(fixture, "u/User/globalStorage/uone.personal-knowledge"), path.join(fixture, "x")]) privateDirectory(dir);
  if (fs.realpathSync(context.globalStorageUri.fsPath) !== path.join(fixture, "u/User/globalStorage/uone.personal-knowledge")
    || path.dirname(fs.realpathSync(context.extensionPath)) !== path.join(fixture, "x")) deny();
  const marker = readMarker(path.join(fixture, "subscription-state-fixture.json"));
  const root = fs.lstatSync(path.join(fixture, "original"), { bigint: true });
  const profile = fs.lstatSync(path.join(fixture, "profile"), { bigint: true });
  if (Object.keys(marker).sort().join(",") !== "nonce,profilePin,rootPin,schema"
    || marker.schema !== "pkm.protected-subscription-state-fixture/v1"
    || marker.rootPin !== `${root.dev}:${root.ino}` || marker.profilePin !== `${profile.dev}:${profile.ino}`
    || typeof marker.nonce !== "string" || !/^[a-f0-9-]{36}$/.test(marker.nonce)) deny();
  verifyNextPayload(context.extensionPath);
  registerProtectedSubscriptionUiFixture(context, fixture, marker.nonce as string, async shareId => {
    const payload = verifyNextPayload(context.extensionPath);
    return await importedBinding(path.join(payload.root, "server/dist/legacy-protected-state-vscode-child.js"),
      fixture, marker.nonce as string, shareId);
  }, async (shareId, expectedHead, crashAfterFirstFile, replayOnly, crashAfterCommit, failure, priority, publisherNodeId) => {
    const payload = verifyNextPayload(context.extensionPath);
    const result = await importedBinding(path.join(payload.root, "server/dist/legacy-protected-state-vscode-child.js"),
      fixture, marker.nonce as string, shareId, "refresh", expectedHead, crashAfterFirstFile, replayOnly, crashAfterCommit, failure, priority, publisherNodeId);
    return result.refreshHead;
  }, async (shareId, action, operationId, expectedHead, change, verifiedPull, crashAfterFirstFile, crashAfterCommit) => {
    const payload = verifyNextPayload(context.extensionPath);
    return await importedBinding(path.join(payload.root, "server/dist/legacy-protected-state-vscode-child.js"),
      fixture, marker.nonce as string, shareId, action, expectedHead, crashAfterFirstFile, false, crashAfterCommit,
      false, false, undefined, { operationId, change, verifiedPull });
  });
  context.subscriptions.push(
    // The test driver invokes this command; the secret is sent only to its private local broker.
    require("vscode").commands.registerCommand("personalKnowledge.runIsolatedProtectedSubscriptionFixture", async (input: unknown) => {
      if (!input || typeof input !== "object" || Array.isArray(input)) deny();
      const request = input as Record<string, unknown>;
      if (Object.keys(request).sort().join(",") !== "nonce,shareId" || request.nonce !== marker.nonce
        || typeof request.shareId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(request.shareId)) deny();
      const current = readMarker(path.join(fixture, "subscription-state-fixture.json"));
      for (const dir of [fixture, path.join(fixture, "original"), path.join(fixture, "profile"),
        path.join(fixture, "u/User/globalStorage/uone.personal-knowledge")]) privateDirectory(dir);
      const rootNow = fs.lstatSync(path.join(fixture, "original"), { bigint: true });
      const profileNow = fs.lstatSync(path.join(fixture, "profile"), { bigint: true });
      if (JSON.stringify(current) !== JSON.stringify(marker) || rootNow.dev !== root.dev || rootNow.ino !== root.ino
        || profileNow.dev !== profile.dev || profileNow.ino !== profile.ino) deny();
      const brokerRoot = process.env.PKM_PRIVATE_SUBSCRIPTION_SOCKET_ROOT || fixture;
      if (fs.realpathSync(brokerRoot) !== fixture) deny();
      const socketPath = path.join(brokerRoot, "credential.sock"), stat = fs.lstatSync(socketPath);
      if (!stat.isSocket() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) deny();
      const payload = verifyNextPayload(context.extensionPath);
      let secret: string | undefined;
      try { secret = await context.secrets.get(`personalKnowledge.shareBroker.${request.shareId}.secret`); }
      catch { return deny(); }
      if (!secret || Buffer.byteLength(secret) > 4096) deny();
      let signing: { magicLink: string; proof: string; nodeId: string } | undefined;
      if (process.env.PKM_PRIVATE_SUBSCRIPTION_SIGNING === "1") {
        const entry = path.join(payload.root, "server/dist/legacy-protected-state-vscode-child.js");
        const binding = await importedBinding(entry, fixture, request.nonce as string, request.shareId);
        signing = signProtectedSubscriptionFixture(fixture, request.nonce as string, request.shareId, secret, binding.statePlan);
      }
      await new Promise<void>((resolve, reject) => {
        const socket = net.createConnection(socketPath);
        const timer = setTimeout(() => { socket.destroy(); reject(new Error("Private Subscription broker unavailable.")); }, 120_000);
        let response = "";
        socket.once("connect", () => {
          try {
            const after = fs.lstatSync(socketPath);
            if (fs.realpathSync(brokerRoot) !== fixture || !after.isSocket()
              || after.dev !== stat.dev || after.ino !== stat.ino || after.uid !== stat.uid || after.mode !== stat.mode) throw new Error();
            socket.write(JSON.stringify({ nonce: request.nonce, shareId: request.shareId, secret, ...(signing || {}) }) + "\n");
          } catch { socket.destroy(); }
        });
        socket.on("data", data => {
          response += data.toString("utf8");
          if (response.length > 32) { socket.destroy(); return; }
          if (response === "ok\n") { clearTimeout(timer); socket.end(); resolve(); }
        });
        socket.once("error", () => { clearTimeout(timer); reject(new Error("Private Subscription broker unavailable.")); });
        socket.once("close", () => { clearTimeout(timer); if (response !== "ok\n") reject(new Error("Private Subscription broker closed.")); });
      });
      return { delivered: true };
    }),
  );
}
