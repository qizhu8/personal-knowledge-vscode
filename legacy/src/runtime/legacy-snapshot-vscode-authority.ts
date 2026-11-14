import * as vscode from "vscode";
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { getStorePath } from "../knowledge/filestore";
import type { ManagedDrainedSnapshotHost } from "./managed-writer-session";

type SnapshotTool = "knowledge_snapshot_status" | "knowledge_snapshot_create" | "knowledge_snapshot_configure"
  | "knowledge_snapshot_restore_preview" | "knowledge_snapshot_restore_apply";
type SnapshotBinding = Readonly<{
  workspaceId: string; workspaceRoot: string; actorId: string; authorityId: string;
  privateGitRoot: string; rootPin?: string; allowedTools: readonly SnapshotTool[]; operation: string;
}>;
type HostBinding = Readonly<{ root: string; profile: string; sessionId: string; snapshot?: SnapshotBinding }>;
export type LegacySnapshotVscodeAuthority = Readonly<{
  authorityId: string; allowedTools: readonly SnapshotTool[]; signal: AbortSignal;
  authorize(binding: SnapshotBinding): boolean; dispose(): void;
}>;
type Host = Readonly<{
  root: string; sessionId: string; signal: AbortSignal; assertCurrent(binding: HostBinding): void;
}>;
// The snapshot host callback lacks operation arguments and IDs; only the
// read-only status operation can be approved without broader effect authority.
const tools = new Set<SnapshotTool>(["knowledge_snapshot_status"]);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const brands = new WeakMap<LegacySnapshotVscodeAuthority, { hostSignal: AbortSignal;
  assertHostCurrent: Host["assertCurrent"]; root: string; profile: string; sessionId: string; check(): void }>();

function directory(pathname: string): string {
  if (!path.isAbsolute(pathname) || path.resolve(pathname) !== pathname || fs.realpathSync(pathname) !== pathname)
    throw new Error("Snapshot approval requires canonical directories.");
  const stat = fs.lstatSync(pathname, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Snapshot approval directory is unavailable.");
  return `${stat.dev}:${stat.ino}`;
}

function privacy(root: string): string {
  const pkm = path.join(root, ".pkm");
  const pkmPin = directory(pkm);
  const filename = path.join(pkm, "content-privacy.json"), before = fs.lstatSync(filename, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size > 2_097_152n
    || process.platform !== "win32" && ((before.mode & 0o077n) !== 0n
      || process.getuid !== undefined && before.uid !== BigInt(process.getuid())))
    throw new Error("Original snapshot privacy policy is unavailable or unsafe.");
  const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const opened = fs.fstatSync(fd, { bigint: true }), bytes = fs.readFileSync(fd);
    const after = fs.fstatSync(fd, { bigint: true }), current = fs.lstatSync(filename, { bigint: true });
    const matches = (stat: typeof before) => stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1n
      && stat.dev === before.dev && stat.ino === before.ino && stat.size === before.size
      && stat.mode === before.mode && stat.uid === before.uid && stat.mtimeNs === before.mtimeNs
      && stat.ctimeNs === before.ctimeNs;
    if (!matches(opened) || !matches(after) || !matches(current) || BigInt(bytes.length) !== before.size)
      throw new Error("Original snapshot privacy policy changed.");
    if (directory(pkm) !== pkmPin) throw new Error("Original snapshot privacy directory changed.");
    return `${pkmPin}:${before.dev}:${before.ino}:${before.mode}:${before.uid}:${before.mtimeNs}:${before.ctimeNs}:`
      + createHash("sha256").update(bytes).digest("hex");
  } finally { fs.closeSync(fd); }
}

function checkSynchronous(callback: () => unknown): void {
  const value = callback();
  if (value !== undefined) {
    if (value && (typeof value === "object" || typeof value === "function")
      && typeof (value as { then?: unknown }).then === "function")
      void Promise.resolve(value).catch(() => {});
    throw new Error("Snapshot host fence must synchronously return undefined.");
  }
}

/** Consent for snapshot tools only; it is not writer handoff or a cross-process grant. */
export async function requestLegacySnapshotVscodeAuthority(context: vscode.ExtensionContext, options: {
  host: Host; allowedTools: readonly SnapshotTool[]; recoveryAuthorityId?: string;
}): Promise<LegacySnapshotVscodeAuthority | undefined> {
  const host = options?.host, selected = options?.allowedTools;
  if (!host || !host.signal || typeof host.assertCurrent !== "function"
    || !uuid.test(host.sessionId) || !Array.isArray(selected) || !selected.length
    || selected.length > tools.size || selected.some(tool => !tools.has(tool))
    || new Set(selected).size !== selected.length
    || options.recoveryAuthorityId !== undefined && !uuid.test(options.recoveryAuthorityId))
    throw new Error("An exact snapshot scope and independently authenticated host are required.");
  const root = host.root, hostSignal = host.signal, sessionId = host.sessionId, assertHostCurrent = host.assertCurrent;
  const profile = context.globalStorageUri.fsPath;
  if (!vscode.workspace.isTrusted || hostSignal.aborted || getStorePath() !== root)
    throw new Error("Snapshot approval was revoked or the workspace is not trusted.");
  const rootPin = directory(root), profilePin = directory(profile), privacyHash = privacy(root);
  if (profile === root || profile.startsWith(root + path.sep) || root.startsWith(profile + path.sep))
    throw new Error("Snapshot approval profile must be separate from the Knowledge Root.");
  const authorityId = options.recoveryAuthorityId ?? randomUUID();
  const allowedTools = Object.freeze([...selected]), controller = new AbortController();
  const subscriptions: vscode.Disposable[] = [];
  const expiresAt = Date.now() + 120_000;
  let timer: ReturnType<typeof setInterval> | undefined, registration: vscode.Disposable | undefined;
  const dispose = () => {
    controller.abort();
    if (timer) { clearInterval(timer); timer = undefined; }
    hostSignal.removeEventListener("abort", dispose);
    for (const subscription of subscriptions.splice(0)) subscription.dispose();
    if (registration) {
      const index = context.subscriptions.indexOf(registration);
      if (index >= 0) context.subscriptions.splice(index, 1);
      registration = undefined;
    }
  };
  const check = () => {
    if (controller.signal.aborted || hostSignal.aborted || Date.now() >= expiresAt || !vscode.workspace.isTrusted
      || host.signal !== hostSignal || host.root !== root || host.sessionId !== sessionId || host.assertCurrent !== assertHostCurrent
      || getStorePath() !== root || context.globalStorageUri.fsPath !== profile
      || directory(root) !== rootPin || directory(profile) !== profilePin || privacy(root) !== privacyHash)
      throw new Error("Snapshot approval or its Root/profile binding was revoked.");
    checkSynchronous(() => assertHostCurrent(Object.freeze({ root, profile, sessionId })));
    if (controller.signal.aborted || hostSignal.aborted || Date.now() >= expiresAt
      || !vscode.workspace.isTrusted || getStorePath() !== root
      || host.signal !== hostSignal || host.root !== root || host.sessionId !== sessionId || host.assertCurrent !== assertHostCurrent
      || context.globalStorageUri.fsPath !== profile || directory(root) !== rootPin
      || directory(profile) !== profilePin || privacy(root) !== privacyHash)
      throw new Error("Snapshot approval or its Root/profile binding was revoked.");
  };
  try {
    hostSignal.addEventListener("abort", dispose, { once: true });
    subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(dispose));
    subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration("personalKnowledge")) dispose();
    }));
    subscriptions.push(context.secrets.onDidChange(dispose));
    check();
    timer = setInterval(() => { try { check(); } catch { dispose(); } }, 1_000);
    timer.unref();
    const answer = await new Promise<string | undefined>((resolve, reject) => {
      const abort = () => { controller.signal.removeEventListener("abort", abort); reject(new Error("Snapshot approval was revoked.")); };
      controller.signal.addEventListener("abort", abort, { once: true });
      Promise.resolve(vscode.window.showWarningMessage("Allow the selected Knowledge snapshot operations?", {
        modal: true, detail: `Knowledge Root: ${root}\nProfile: ${profile}\nOwner session: ${sessionId}\n`
          + `Snapshot authority: ${authorityId}\nAllowed tools:\n${allowedTools.join("\n")}\n\n`
          + "Approval lasts at most two minutes and permits only status for the external MCP actor. "
          + "It does not authorize snapshot creation, restoration, interrupted snapshot recovery, other MCP operations, writer handoff, or migration.",
      }, "Allow Selected Snapshot Operations")).then(value => {
        controller.signal.removeEventListener("abort", abort);
        if (controller.signal.aborted) reject(new Error("Snapshot approval was revoked.")); else resolve(value);
      }, error => { controller.signal.removeEventListener("abort", abort); reject(error); });
    });
    check();
    if (answer !== "Allow Selected Snapshot Operations") { dispose(); return undefined; }
    const authority: LegacySnapshotVscodeAuthority = Object.freeze({
      authorityId, allowedTools, signal: controller.signal, dispose,
      authorize(actual) {
        try {
          check();
          if (!actual || !uuid.test(actual.workspaceId) || actual.workspaceRoot !== root
            || actual.actorId !== "mcp:external" || actual.authorityId !== authorityId
            || actual.privateGitRoot !== path.join(root, "packages", "knowledge-snapshots", "repository.git")
            || actual.rootPin !== rootPin && !(actual.operation === "admit" && actual.rootPin === undefined)
            || !Array.isArray(actual.allowedTools) || actual.allowedTools.length !== allowedTools.length
            || actual.allowedTools.some((tool, index) => tool !== allowedTools[index])
            || actual.operation !== "admit" && !allowedTools.includes(actual.operation as SnapshotTool))
            return false;
          checkSynchronous(() => assertHostCurrent(Object.freeze({ root, profile, sessionId,
            snapshot: Object.freeze({ ...actual, allowedTools }) })));
          check();
          return true;
        } catch { dispose(); return false; }
      },
    });
    brands.set(authority, { hostSignal, assertHostCurrent, root, profile, sessionId, check });
    registration = authority;
    context.subscriptions.push(authority);
    return authority;
  } catch (error) { dispose(); throw error; }
}

/** Verify the exact in-process UI-issued object and its original host fence. */
export function assertLegacySnapshotVscodeAuthority(authority: LegacySnapshotVscodeAuthority, context: vscode.ExtensionContext, host: Host): void {
  const binding = brands.get(authority);
  if (!binding || !host || authority.signal.aborted || host.signal.aborted || binding.hostSignal !== host.signal
    || binding.assertHostCurrent !== host.assertCurrent || binding.root !== host.root
    || binding.profile !== context.globalStorageUri.fsPath || binding.sessionId !== host.sessionId)
    throw new Error("Snapshot UI authority does not belong to this current host.");
  try { binding.check(); } catch (error) { authority.dispose(); throw error; }
}

/** Issue only the native status intent from this process's actual drained managed host. */
export async function requestManagedDrainedSnapshotVscodeAuthority(context: vscode.ExtensionContext, host: ManagedDrainedSnapshotHost,
  recoveryAuthorityId?: string): Promise<LegacySnapshotVscodeAuthority | undefined> {
  const { assertManagedDrainedSnapshotHost } = require("./managed-writer-session") as typeof import("./managed-writer-session");
  assertManagedDrainedSnapshotHost(host);
  const authority = await requestLegacySnapshotVscodeAuthority(context, {
    host, allowedTools: ["knowledge_snapshot_status"], ...(recoveryAuthorityId ? { recoveryAuthorityId } : {}),
  });
  if (!authority) return undefined;
  try {
    assertManagedDrainedSnapshotHost(host);
    assertLegacySnapshotVscodeAuthority(authority, context, host);
    return authority;
  } catch (error) {
    authority.dispose();
    throw error;
  }
}
