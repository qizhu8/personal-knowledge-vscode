import { ChildProcess, execFileSync, fork } from "child_process";
import { createHash, randomUUID } from "crypto";
import { isDeepStrictEqual } from "util";
import { assertRecipeWorkspace, captureRecipeWorkspace, type NextRecipeWorkspacePin } from "./next-recipe-workspace";
import * as fs from "fs";
import * as path from "path";
import { verifyNextPayload } from "./next-payload-verifier";
import { parseMemoryHostPin, type MemoryHostPin } from "./memory-migration-authority";
import type { PythonEnvironmentAuthority, PythonEnvironmentHandle } from "./python-environment-authority";
import type { PythonProgramAuthority, PythonProgramGrant } from "./python-program-authority";
import type { LocalRuntimeAuthority, LocalJournalHandle, LocalRuntimeHandle, LocalProgramParameters } from "./local-runtime-authority";
import { attachNextRoomHostBridge, type NextRoomHostBinding, type NextRoomParticipantApproval } from "../chatroom/next-room-host-bridge";
import { ChatRoomCredentialStore, type SecretStorageLike } from "../chatroom/chat-room-credentials";
import { assertRoomRecoveryPin, loadRoomRecoveryPins, saveRoomRecoveryPin, type NextRoomRecoveryPin } from "../chatroom/next-room-recovery";
import type { createNextChatProfileAuthority } from "./next-chat-profile-authority";
import type { createNextVscodeModelBridge } from "./next-vscode-model-bridge";
import type { createNextCopilotSdkBridge } from "./next-copilot-sdk-bridge";
import type { CopilotSdkDeps, CopilotSdkModel } from "../chat/api-chat-copilot-sdk";
import type { VscodeChatModel } from "../chat/api-chat-vscode";
import { assertSelectedChatRecoveryPin, type NextSelectedChatRecoveryPin } from "./next-selected-chat-recovery";

export interface LocalEnvironmentRunView {
  runId: string; workspaceId: string; environmentId: string; provider: string;
  state: "ready" | "running" | "succeeded" | "failed" | "cancelled" | "unknown";
  effect: "not-started" | "known" | "unknown"; version: number;
  jobs: { phase: string; state: string; effect: string; exitCode: number | null; stdout: string; stderr: string }[];
}

type Operation = "list" | "get" | "asset-list" | "asset-get" | "board-list" | "board-get" | "board-tasks" | "board-stories"
  | "research-list" | "skill-list" | "skill-get" | "metadata-get" | "recipe-list" | "recipe-get" | "library-list" | "library-get" | "mutation-scan"
  | "memory-get" | "memory-search" | "memory-audit" | "memory-replay"
  | "note-create" | "note-update" | "skill-create" | "skill-update" | "research-create" | "research-update" | "create" | "update";
type Pending = { resolve(value: any): void; reject(error: Error): void };
type MemoryImportPlan = {
  actorId: string; sourceSha256: string; engineIdentity: string; scopes: string[];
  records: number; revisions: number; events: number; operations: number; continuityScopeSha256?: string;
};
type MemoryScopeApprovalHandler = (envelope: unknown) =>
  Promise<{ actorId: string; decisionId: string; expiresAtMs: number } | null>;
export interface NextImportPlan {
  ready: boolean;
  planSha256: string;
  fingerprint: unknown;
  blockers: { code: string; path: string; message: string; relatedPath?: string }[];
  target: string;
  memoryPlan?: MemoryImportPlan;
}
export interface NextWritePreparation {
  workspaceId: string;
  planSha256: string;
  target: string;
  authorizationDigest: string;
  scope: "isolated_experiment";
  writerCoverage: { inProcessCalls: "tracked"; cooperatingHosts: "native-lease"; external: "unknown" };
  blockers: string[];
}
export interface NextWriteCredential { parent: string; capability: string; workspaceId: string }
export interface NextSelectedChatConfiguration {
  chats: { namespace: string; chatId: string }[];
  commands: { id: string; program: string; cwd: string; arguments: string[][] }[];
  model: { provider: "openai-compatible" | "azure-openai" | "vscode"; endpoint: string; model: string;
    apiVersion?: string; apiKey: string; contextWindow: number; maxOutputTokens: number;
    outputTokenParameter: "max_tokens" | "max_completion_tokens"; includeUsage: boolean;
    status: "active" | "unknown" | "deprecated"; deprecatedAt?: string; timeoutMs?: number;
    vscodeModelId?: string; vscodeTools?: boolean; vscodeImageInput?: boolean };
}
export interface NextSelectedChatOwner {
  session: string; workspaceId: string; actorId: "local:owner";
  signal: AbortSignal;
  assertCurrent(): void;
  revoke(): Promise<void>;
}
const overlap = (a: string, b: string) => {
  const delta = path.relative(a, b);
  return delta === "" || (!delta.startsWith(`..${path.sep}`) && delta !== ".." && !path.isAbsolute(delta));
};
const hashScope = (scope: string) => createHash("sha256").update(scope).digest("hex");
function validateImportPlan(value: unknown, parent: string): NextImportPlan | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const plan = value as Record<string, unknown>;
  if (typeof plan.ready !== "boolean" || typeof plan.planSha256 !== "string" || !/^[a-f0-9]{64}$/.test(plan.planSha256)
    || !Array.isArray(plan.blockers) || plan.target !== path.join(parent, "workspace")
    || plan.blockers.some((item: any) => !item || typeof item.code !== "string"
      || typeof item.path !== "string" || typeof item.message !== "string")) return undefined;
  let memoryPlan: MemoryImportPlan | undefined;
  if (plan.memoryPlan !== undefined) {
    const memory = plan.memoryPlan as Record<string, unknown>;
    if (!memory || typeof memory !== "object" || typeof memory.actorId !== "string" || memory.actorId !== "local:owner"
      || typeof memory.sourceSha256 !== "string" || !/^[a-f0-9]{64}$/.test(memory.sourceSha256)
      || typeof memory.engineIdentity !== "string" || !Array.isArray(memory.scopes)
      || memory.scopes.some(scope => typeof scope !== "string" || !scope || Buffer.byteLength(scope) > 1024)
      || !Number.isSafeInteger(memory.records) || !Number.isSafeInteger(memory.revisions)
      || !Number.isSafeInteger(memory.events) || !Number.isSafeInteger(memory.operations)
      || memory.continuityScopeSha256 !== undefined && (typeof memory.continuityScopeSha256 !== "string"
        || !/^[a-f0-9]{64}$/.test(memory.continuityScopeSha256)
        || !(memory.scopes as string[]).some(scope => hashScope(scope) === memory.continuityScopeSha256))) return undefined;
    memoryPlan = memory as unknown as MemoryImportPlan;
  }
  return {
    ready: plan.ready, planSha256: plan.planSha256, fingerprint: plan.fingerprint,
    blockers: plan.blockers as NextImportPlan["blockers"], target: plan.target as string,
    ...(memoryPlan ? { memoryPlan } : {}),
  };
}

/** Disposable trial or explicitly pinned Room-only recovery; never a general workspace adoption. */
export class NextManagedClient {
  private child?: ChildProcess;
  private pending = new Map<string, Pending>();
  private state: "new" | "starting" | "open" | "closing" | "closed" = "new";
  private drained = false;
  private peerClosing = false;
  private drainError?: Error;
  private stop?: Promise<void>;
  private failStop?: (error: Error) => void;
  private cancelStartup?: () => void;
  private importMode = false;
  private importConfirmed = false;
  private readOnly = false;
  private importPlan?: NextImportPlan;
  private writeEnabled = false;
  private writeAttempted = false;
  private preparation?: NextWritePreparation;
  private workspaceId?: string;
  private readonly roomBridges = new Map<string, { close(): void }>();
  private roomHubPolicy?: { legacyReconnect: "proof-required" | "new-identity" | "host-approval"; port: number };
  private roomBusy = false;
  private roomCreating = false;
  private pythonDirectory?: string;
  private roomRecovery?: NextRoomRecoveryPin;
  private roomRecoveries: NextRoomRecoveryPin[] = [];
  private readonly nativeRoomPins = new Map<string, NextRoomRecoveryPin>();
  private legacyDirectory?: string;
  private readonly pythonApprovals = new Map<string, (handleSha256: unknown) => boolean>();
  private readonly environmentApprovals = new Map<string, (grantSha256: unknown) => boolean>();
  private recipeRecovery?: NextRecipeWorkspacePin;
  private selectedChatRecovery?: NextSelectedChatRecoveryPin;
  private readonly recipeApprovals = new Map<string, (message: Record<string, any>) => Promise<boolean>>();
  private selectedOwner?: { invalidate(): void; revoke?: () => Promise<void>; owner?: NextSelectedChatOwner };
  private selectedReview?: { owner: NextSelectedChatOwner; chats: Set<string>; challenges: Set<string> };
  private vscodeModelBridge?: ReturnType<typeof createNextVscodeModelBridge> | ReturnType<typeof createNextCopilotSdkBridge>;
  private sdkResource?: CopilotSdkDeps & { dispose(): Promise<void> };
  private selectedModelDrain?: Promise<void>;
  private importParent?: string;
  private memoryScopeApprovalHandler?: MemoryScopeApprovalHandler;
  private memoryDirectory?: string;
  private memoryReadoptionPending = false;
  private closed!: (error?: Error) => void;
  private readonly termination = new Promise<void>((resolve, reject) => {
    this.closed = error => error ? reject(error) : resolve();
  });
  constructor() { void this.termination.catch(() => undefined); }
  isStopped(): boolean { return this.state === "closed"; }
  ownsWorkspace(workspaceId: string): boolean {
    if (this.selectedChatRecovery) {
      try { assertSelectedChatRecoveryPin(this.selectedChatRecovery, this.legacyDirectory!); } catch { return false; }
    }
    return this.state === "open" && !this.peerClosing && !!this.child?.connected && this.workspaceId === workspaceId;
  }
  async selectChatOwner(profile: ReturnType<typeof createNextChatProfileAuthority>, onRevocationError: (error: unknown) => void) {
    if (this.selectedOwner || !this.ownsWorkspace(profile.workspaceId) || profile.signal.aborted)
      throw new Error("A live, unselected Next workspace is required.");
    profile.assertCurrent();
    const session = randomUUID();
    let active = true, completed = false, revoking: Promise<void> | undefined;
    const assertCurrent = () => {
      try {
        if (!active || !this.ownsWorkspace(profile.workspaceId)) throw new Error("Selected owner is unavailable.");
        profile.assertCurrent();
      } catch (error) {
        if (active) void revoke().catch(onRevocationError);
        throw error;
      }
    };
    const invalidate = () => {
      active = false;
      this.selectedReview = undefined;
      profile.signal.removeEventListener("abort", onAbort);
      this.vscodeModelBridge?.dispose();
    };
    this.selectedOwner = { invalidate };
    const opening = this.request({ type: "selected-owner-open", session, workspaceId: profile.workspaceId, actorId: profile.actorId });
    const revoke = (): Promise<void> => {
      invalidate();
      if (completed) return Promise.resolve();
      return revoking ??= (async () => {
        try {
          await opening.catch(() => undefined);
          const result = await this.request({ type: "selected-owner-revoke", session });
          if (result?.revoked !== true) throw new Error("Selected owner drain is unconfirmed.");
          await this.drainSelectedModel();
          completed = true;
          this.selectedOwner = undefined;
          this.vscodeModelBridge = undefined;
        } catch (error) { revoking = undefined; throw error; }
      })();
    };
    this.selectedOwner.revoke = revoke;
    const onAbort = () => { if (active) void revoke().catch(onRevocationError); };
    profile.signal.addEventListener("abort", onAbort, { once: true });
    if (profile.signal.aborted) onAbort();
    try {
      const result = await opening;
      if (result?.session !== session || result.workspaceId !== profile.workspaceId || result.actorId !== profile.actorId)
        throw new Error("Selected owner binding is unconfirmed.");
      assertCurrent();
      const owner = Object.freeze({ session, workspaceId: profile.workspaceId, actorId: profile.actorId,
        signal: profile.signal, assertCurrent, revoke });
      if (!this.selectedOwner) throw new Error("Selected owner is unavailable.");
      this.selectedOwner.owner = owner;
      return owner;
    } catch (error) {
      await revoke().catch(onRevocationError);
      throw error;
    }
  }
  async revokeSelectedChatOwner(): Promise<void> {
    await this.selectedOwner?.revoke?.();
  }
  private async drainSelectedModel(): Promise<void> {
    if (!this.selectedModelDrain) {
      const task = Promise.resolve().then(async () => {
        const bridge = this.vscodeModelBridge;
        try {
          if (bridge && "drain" in bridge) await bridge.drain();
          if (this.sdkResource) { await this.sdkResource.dispose(); this.sdkResource = undefined; }
        } catch { throw new Error("Selected model drain is unconfirmed."); }
      });
      this.selectedModelDrain = task;
      void task.then(() => { if (this.selectedModelDrain === task) this.selectedModelDrain = undefined; },
        () => { if (this.selectedModelDrain === task) this.selectedModelDrain = undefined; });
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([this.selectedModelDrain, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Selected model drain is unconfirmed.")), 5000);
      })]);
    } finally { clearTimeout(timer); }
  }
  async privateCopilotSdk(owner: NextSelectedChatOwner): Promise<CopilotSdkDeps> {
    owner.assertCurrent();
    if (this.selectedOwner?.owner !== owner || !this.pythonDirectory || this.sdkResource)
      throw new Error("Private SDK owner is unavailable.");
    const control = path.join(path.dirname(this.pythonDirectory), "control"), stat = fs.lstatSync(control);
    if (fs.realpathSync(control) !== control || !stat.isDirectory() || stat.isSymbolicLink()
      || stat.uid !== process.getuid?.() || (stat.mode & 0o7077) !== 0)
      throw new Error("Private SDK directory is unavailable.");
    const directory = path.join(control, `selected-sdk-${owner.session}`);
    fs.mkdirSync(directory, { mode: 0o700 });
    const { createPrivateCopilotSdk } = await import("../chat/api-chat-copilot-sdk");
    const vscode = await import("vscode");
    owner.assertCurrent();
    const resource = createPrivateCopilotSdk(vscode, directory);
    this.sdkResource = resource;
    return resource;
  }
  async startSelectedChat(owner: NextSelectedChatOwner, configuration: NextSelectedChatConfiguration,
    vscodeModel?: VscodeChatModel | CopilotSdkModel, permissionKey?: string) {
    owner.assertCurrent();
    if (this.selectedOwner?.owner !== owner || !this.ownsWorkspace(owner.workspaceId)
      || owner.actorId !== "local:owner" || !this.pythonDirectory)
      throw new Error("Selected Chat requires the current independent Next workspace.");
    try {
      if (configuration.model.provider === "vscode") {
        if (!vscodeModel || vscodeModel.vendor === "copilotcli"
          || configuration.model.vscodeModelId !== `vscode:${encodeURIComponent(vscodeModel.vendor)}:${encodeURIComponent(vscodeModel.id)}`
          || configuration.model.endpoint || configuration.model.apiKey
          || configuration.model.vscodeImageInput !== (vscodeModel.capabilities?.imageInput === true))
          throw new Error("The selected VS Code model binding is unavailable.");
        const send = (message: object) => { try { if (this.child?.connected) this.child.send(message); } catch { /* Parent IPC closed. */ } };
        if (vscodeModel.vendor === "copilot-sdk") {
          if (!this.sdkResource || !("copilotSdk" in vscodeModel)) throw new Error("Private SDK binding is unavailable.");
          if (!Number.isSafeInteger(configuration.model.contextWindow) || configuration.model.contextWindow < 256
            || configuration.model.contextWindow > vscodeModel.maxInputTokens
            || !Number.isSafeInteger(configuration.model.maxOutputTokens) || configuration.model.maxOutputTokens < 1
            || configuration.model.maxOutputTokens > (vscodeModel.maxOutputTokens ?? 0)
            || configuration.model.maxOutputTokens >= configuration.model.contextWindow)
            throw new Error("Selected SDK model budget is invalid.");
          const { createNextCopilotSdkBridge } = await import("./next-copilot-sdk-bridge");
          owner.assertCurrent();
          this.vscodeModelBridge = createNextCopilotSdkBridge({ model: vscodeModel as CopilotSdkModel,
            deps: this.sdkResource, session: owner.session, signal: owner.signal, assertCurrent: owner.assertCurrent, send,
            contextWindow: configuration.model.contextWindow, maxOutputTokens: configuration.model.maxOutputTokens });
        } else {
          const { createNextVscodeModelBridge } = await import("./next-vscode-model-bridge");
          owner.assertCurrent();
          this.vscodeModelBridge = createNextVscodeModelBridge({ model: vscodeModel as VscodeChatModel, session: owner.session,
            signal: owner.signal, assertCurrent: owner.assertCurrent, send });
        }
      } else if (vscodeModel) throw new Error("Unexpected VS Code model binding.");
      this.selectedReview = { owner, chats: new Set(configuration.chats.map(chat => `${chat.namespace}:${chat.chatId}`)), challenges: new Set() };
      const result = await this.request({ type: "selected-chat-start", session: owner.session, ...configuration,
        ...(permissionKey ? { permissionKey } : {}) });
      owner.assertCurrent();
      const endpoint = new URL(result.endpoint), parent = path.join(path.dirname(this.pythonDirectory), "control", `selected-chat-${owner.session}`);
      if (result.workspaceId !== owner.workspaceId || result.actorId !== owner.actorId
        || typeof result.root !== "string" || (this.selectedChatRecovery
          ? result.root !== this.selectedChatRecovery.snapshotRoot || result.sourceFingerprint !== this.selectedChatRecovery.sourceFingerprint
          : path.dirname(result.root) !== parent) || fs.realpathSync(result.root) !== result.root
        || !/^chat-snapshot-[a-f0-9-]{36}$/.test(path.basename(result.root))
        || !/^[a-f0-9]{64}$/.test(result.sourceFingerprint) || !/^[A-Za-z0-9_-]{43}$/.test(result.bearer)
        || endpoint.protocol !== "http:" || endpoint.hostname !== "127.0.0.1" || !endpoint.port
        || endpoint.pathname !== "/" || endpoint.username || endpoint.password || endpoint.search || endpoint.hash)
        throw new Error("Selected Chat owner binding is unconfirmed.");
      return Object.freeze({ ...result, nonce: randomUUID() });
    } catch (error) {
      await owner.revoke().catch(() => undefined);
      throw error;
    }
  }
  async listSelectedChats(owner: NextSelectedChatOwner): Promise<Array<{
    namespace: string; chatId: string; title: string; modelProvider: string | null;
    modelProfileId: string | null; vscodeModelId: string | null; contextWindow: number | null; maxOutputTokens: number | null;
  }>> {
    owner.assertCurrent();
    if (this.selectedOwner?.owner !== owner || !this.ownsWorkspace(owner.workspaceId))
      throw new Error("Selected Chat owner is unavailable.");
    const result = await this.request({ type: "selected-chat-list", session: owner.session });
    owner.assertCurrent();
    if (!Array.isArray(result?.chats) || result.chats.length > 128 || result.chats.some((chat: any) =>
      !chat || !/^[a-f0-9]{16}$/.test(chat.namespace) || !/^[a-f0-9-]{36}$/.test(chat.chatId)
      || typeof chat.title !== "string" || chat.title.length > 4096
      || [chat.modelProvider, chat.modelProfileId, chat.vscodeModelId].some((value: unknown) => value !== null && typeof value !== "string")
      || [chat.contextWindow, chat.maxOutputTokens].some((value: unknown) => value !== null && !Number.isSafeInteger(value))))
      throw new Error("Selected Chat list is invalid.");
    return result.chats;
  }
  recoveredRoomId(): string | undefined { return this.roomRecovery?.roomId; }
  recoveredRoomIds(): string[] { return this.roomRecoveries.map(pin => pin.roomId); }
  savedRoomChoices(): { roomId: string; name: string }[] {
    return this.roomRecoveries.map(pin => ({ roomId: pin.roomId, name: pin.nativeName ?? pin.roomName ?? pin.roomId }));
  }
  nativeRoomHostName(roomId: string): string | undefined { return this.nativeRoomPins.get(roomId)?.nativeHostName; }
  async createIsolatedRoom(name: string, hostName: string, requestedJoinSecret: string | undefined, secrets: SecretStorageLike,
    authorized: () => boolean, legacyReconnect: "proof-required" | "new-identity" | "host-approval",
    approveParticipant?: (candidate: NextRoomParticipantApproval) => Promise<boolean>, port = 0): Promise<{
      roomId: string; room: string; url: string; secret: string; hostToken: string;
    }> {
    const normalized = Array.from(name.normalize("NFKC").trim().replace(/\s+/g, " ")).slice(0, 80).join("");
    if (!normalized || !hostName.trim() || hostName !== hostName.trim() || hostName.length > 60
      || requestedJoinSecret !== undefined && (!requestedJoinSecret || Buffer.byteLength(requestedJoinSecret) > 4096)
      || this.roomBusy || this.roomCreating || !authorized()) throw new Error("A trusted Room name and optional secret are required.");
    const root = this.roomRecovery ? path.join(this.roomRecovery.parent, "workspace") : this.pythonWorkspaceDirectory();
    const workspaceId = this.roomRecovery?.workspaceId ?? this.pythonWorkspaceId();
    this.roomCreating = true;
    try {
    if (!this.legacyDirectory) throw new Error("Current Knowledge Root binding is unavailable.");
    const saved = await loadRoomRecoveryPins(secrets, path.dirname(root), this.legacyDirectory);
    if (saved.some(pin => pin.origin === "native" && pin.nativeName?.toLocaleLowerCase() === normalized.toLocaleLowerCase()))
      throw new Error("A saved or pending Room with this name already exists; rehost it instead.");
    const checked = await this.request({ type: "room-name-check", name: normalized });
    if (!checked?.available || !authorized() || !this.legacyDirectory) throw new Error("Room creation authority changed.");
    const roomId = randomUUID(), credentials = new ChatRoomCredentialStore(secrets);
    await credentials.create(roomId, requestedJoinSecret);
    const binding: NextRoomHostBinding = { root, workspaceId, actorId: "local:owner", roomId,
      sourceFingerprint: createHash("sha256").update(randomUUID()).digest("hex"), operation: "reopen" };
    try { await saveRoomRecoveryPin(secrets, binding, this.legacyDirectory, normalized, hostName); }
    catch { throw new Error("Room profile pin outcome is unknown; preserve the trial and credentials for reconciliation."); }
    const pin = (await loadRoomRecoveryPins(secrets, path.dirname(root), this.legacyDirectory))
      .find(item => item.roomId === roomId);
    if (!pin) throw new Error("Room creation was pinned but could not be reloaded; preserve the trial for recovery.");
    this.nativeRoomPins.set(roomId, pin);
    this.roomRecoveries.push(pin);
    return await this.openIsolatedRoom(roomId, secrets, authorized, legacyReconnect, approveParticipant, port);
    } finally { this.roomCreating = false; }
  }
  pythonWorkspaceId(): string {
    if (this.state !== "open" || !this.workspaceId || this.importMode || this.roomRecovery)
      throw new Error("Python trial requires a fresh isolated Next workspace; start one and select the environment again.");
    return this.workspaceId;
  }
  pythonWorkspaceDirectory(): string {
    const workspaceId = this.pythonWorkspaceId(), root = this.pythonDirectory;
    if (!root || fs.realpathSync(root) !== root
      || JSON.parse(fs.readFileSync(path.join(root, ".pkm-next-workspace"), "utf8")).id !== workspaceId)
      throw new Error("Fresh isolated Python working directory changed.");
    return root;
  }

  async openIsolatedRoom(roomId: string, secrets: SecretStorageLike, authorized: () => boolean,
    legacyReconnect: "proof-required" | "new-identity" | "host-approval" = "proof-required",
    approveParticipant?: (candidate: NextRoomParticipantApproval) => Promise<boolean>, port = 0): Promise<{
    roomId: string; room: string; url: string; secret: string; hostToken: string;
  }> {
    if (this.roomBusy || this.roomBridges.has(roomId) || !/^[A-Za-z0-9_-]{6,80}$/.test(roomId)
      || !["proof-required", "new-identity", "host-approval"].includes(legacyReconnect)
      || legacyReconnect === "host-approval" && !approveParticipant
      || !Number.isInteger(port) || port < 0 || port > 65535)
      throw new Error("The isolated Room selection or host policy is invalid.");
    const root = this.roomRecovery ? path.join(this.roomRecovery.parent, "workspace") : this.pythonWorkspaceDirectory();
    const workspaceId = this.roomRecovery?.workspaceId ?? this.pythonWorkspaceId(), child = this.child;
    const recovery = this.roomRecovery ? this.roomRecoveries.find(pin => pin.roomId === roomId) : this.nativeRoomPins.get(roomId);
    if (this.roomRecovery && !recovery) throw new Error("Recovery is restricted to independently pinned Rooms.");
    if (recovery) assertRoomRecoveryPin(recovery, this.legacyDirectory!);
    if (this.roomHubPolicy && (legacyReconnect !== this.roomHubPolicy.legacyReconnect || port !== this.roomHubPolicy.port))
      throw new Error("All Rooms on this Hub use the same reconnect policy and port.");
    if (!child || !authorized()) throw new Error("Trusted isolated Room action required.");
    this.roomBusy = true;
    try {
      const binding = recovery?.origin === "native"
        ? { root, workspaceId, actorId: "local:owner" as const, roomId, sourceFingerprint: recovery.sourceFingerprint, operation: "reopen" as const }
        : await this.request({ type: "room-inspect", roomId }) as NextRoomHostBinding;
      if (!binding || binding.root !== root || binding.workspaceId !== workspaceId || binding.actorId !== "local:owner"
        || binding.roomId !== roomId || binding.operation !== "reopen" || !/^[a-f0-9]{64}$/.test(binding.sourceFingerprint)
        || recovery && binding.sourceFingerprint !== recovery.sourceFingerprint
        || !authorized() || this.state !== "open" || this.child !== child)
        throw new Error("Isolated Room binding changed.");
      const bridge = attachNextRoomHostBridge({ child, secrets, binding,
        authorized: () => {
          if (recovery) assertRoomRecoveryPin(recovery, this.legacyDirectory!);
          return this.state === "open" && this.child === child && authorized();
        }, approveParticipant });
      this.roomBridges.set(roomId, bridge);
      try {
        if (recovery?.origin === "native") {
          const created = await this.request({ type: "room-create", roomId, binding, session: bridge.session,
            name: recovery.nativeName, expectedHostHash: recovery.hostCredentialHash });
          if (!created?.created) throw new Error("Native Room creation outcome is unknown.");
          const inspected = await this.request({ type: "room-inspect", roomId });
          if (JSON.stringify(inspected) !== JSON.stringify(binding)) throw new Error("Native Room identity changed.");
        }
        const opened = await this.request({ type: "room-open", roomId, binding, session: bridge.session, legacyReconnect, port });
        const url = new URL(opened.url);
        if (opened.roomId !== roomId || typeof opened.room !== "string" || !opened.room
          || url.protocol !== "ws:" || url.hostname !== "127.0.0.1" || !url.port || port !== 0 && Number(url.port) !== port
          || typeof opened.secret !== "string" || !opened.secret || typeof opened.hostToken !== "string" || !opened.hostToken
          || opened.authority !== "verified-legacy-host-credential" || !authorized() || this.state !== "open")
          throw new Error("Isolated Room host response invalid.");
        if (!this.legacyDirectory) throw new Error("Current Knowledge Root binding is unavailable.");
        if (!this.roomRecovery && !recovery) {
          await saveRoomRecoveryPin(secrets, binding, this.legacyDirectory, undefined, undefined, opened.room);
          this.roomRecoveries = await loadRoomRecoveryPins(secrets, path.dirname(root), this.legacyDirectory);
        }
        this.roomHubPolicy = { legacyReconnect, port: Number(url.port) };
        return { roomId, room: opened.room, url: opened.url, secret: opened.secret, hostToken: opened.hostToken };
      } catch (error) {
        try { await this.request({ type: "room-close", roomId }); }
        catch { void this.close().catch(() => undefined); }
        bridge.close(); this.roomBridges.delete(roomId);
        throw error;
      }
    } finally { this.roomBusy = false; }
  }

  async copyIsolatedRoom(source: string, roomId: string): Promise<void> {
    const target = this.pythonWorkspaceDirectory(), legacy = this.legacyDirectory;
    if (!legacy || !path.isAbsolute(source) || path.resolve(source) !== source || fs.realpathSync(source) !== source
      || overlap(source, target) || overlap(target, source) || overlap(source, legacy) || overlap(legacy, source)
      || !/^[A-Za-z0-9_-]{6,80}$/.test(roomId) || this.roomBusy || this.roomBridges.has(roomId))
      throw new Error("Select an isolated Room copy outside the current Knowledge Root and trial.");
    const result = await this.request({ type: "room-import-private", source, roomId });
    if (result?.roomId !== roomId || !/^[a-f0-9]{64}$/.test(result.sourceFingerprint))
      throw new Error("Room copy outcome unknown; preserve the trial and do not retry.");
  }

  async closeIsolatedRoom(roomId?: string): Promise<void> {
    if (roomId) {
      const bridge = this.roomBridges.get(roomId);
      if (!bridge) return;
      try { await this.request({ type: "room-close", roomId }); }
      catch (error) { bridge.close(); void this.close().catch(() => undefined); throw error; }
      this.roomBridges.delete(roomId); bridge.close();
    } else {
      await this.request({ type: "room-close" });
      for (const bridge of this.roomBridges.values()) bridge.close();
      this.roomBridges.clear(); this.roomHubPolicy = undefined;
    }
  }

  async runPythonTrial(authority: PythonEnvironmentAuthority, handle: PythonEnvironmentHandle): Promise<{
    workspaceId: string; actorId: string; environmentId: string; runId: string;
    state: "succeeded" | "failed" | "unknown"; stdout: string; exitCode: number | null; error?: string;
  }> {
    const workspaceId = this.pythonWorkspaceId(), actorId = "local:owner", approvalId = randomUUID();
    authority.validate(handle, workspaceId, actorId);
    const handleSha256 = createHash("sha256").update(JSON.stringify(handle)).digest("hex");
    this.pythonApprovals.set(approvalId, receivedDigest => {
      if (receivedDigest !== handleSha256) return false;
      authority.validate(handle, this.pythonWorkspaceId(), actorId); return true;
    });
    try {
      const result = await this.request({ type: "python-trial", approvalId, handle });
      if (result?.workspaceId !== workspaceId || result.actorId !== actorId || result.environmentId !== handle.environmentId
        || !/^python-[a-f0-9-]{36}$/.test(result.runId) || !["succeeded", "failed", "unknown"].includes(result.state)
        || typeof result.stdout !== "string" || Buffer.byteLength(result.stdout) > 1024
        || result.exitCode !== null && !Number.isInteger(result.exitCode)
        || result.state === "succeeded" && (result.exitCode !== 0 || result.stdout.replace(/\r\n/g, "\n") !== "7\n")
        || Object.keys(result).some(key => !["workspaceId", "actorId", "environmentId", "runId", "state", "stdout", "exitCode", "error"].includes(key))
        || result.error !== undefined && typeof result.error !== "string")
        throw new Error("Invalid Python Workflow result; do not retry automatically.");
      return result;
    } finally { this.pythonApprovals.delete(approvalId); }
  }

  async localEnvironmentCommand(authority: LocalRuntimeAuthority, journal: LocalJournalHandle,
    command: { operation: "open"; recover: boolean } | { operation: "start"; runtime: LocalRuntimeHandle; parameters: LocalProgramParameters }
      | { operation: "start-python"; program: PythonProgramGrant }
      | { operation: "status" } | { operation: "cancel"; runId: string }, python?: PythonProgramAuthority): Promise<LocalEnvironmentRunView[]> {
    const workspaceId = this.pythonWorkspaceId(), actorId = "local:owner", approvalId = randomUUID();
    authority.validateJournal(journal, workspaceId, actorId);
    if (command.operation === "start") authority.validateRuntime(command.runtime, journal);
    if (command.operation === "start-python") {
      if (!python) throw new Error("An exact native Python program approval is required.");
      if (command.program.cwd !== this.pythonWorkspaceDirectory()) throw new Error("Python working-directory binding rejected.");
      python.consume(command.program, workspaceId);
    }
    const grant = { ...command, journal };
    const digest = createHash("sha256").update(JSON.stringify(grant)).digest("hex");
    this.environmentApprovals.set(approvalId, value => {
      if (value !== digest) return false;
      authority.validateJournal(journal, this.pythonWorkspaceId(), actorId);
      if (command.operation === "start") authority.validateRuntime(command.runtime, journal);
      if (command.operation === "start-python") python!.validate(command.program, this.pythonWorkspaceId());
      if (command.operation === "start-python" && command.program.cwd !== this.pythonWorkspaceDirectory()) return false;
      return true;
    });
    try {
      const result = await this.request({ type: "environment-command", approvalId, grant });
      if (!Array.isArray(result) || result.length > 64 || Buffer.byteLength(JSON.stringify(result)) > 2_097_152
        || result.some(item => !item || !/^environment-[a-f0-9-]{36}$/.test(item.runId)
          || !/^[a-f0-9-]{36}$/.test(item.workspaceId) || typeof item.environmentId !== "string"
          || !["node-diagnostic/v1", "dotnet8-diagnostic/v1", "node-project/v1", "python-script/v1"].includes(item.provider)
          || !["ready", "running", "succeeded", "failed", "cancelled", "unknown"].includes(item.state)
          || !["not-started", "known", "unknown"].includes(item.effect) || !Number.isSafeInteger(item.version)
          || !Array.isArray(item.jobs) || item.jobs.length > 4 || item.jobs.some((job: any) =>
            !["compile", "run"].includes(job.phase) && !/^python:[A-Za-z0-9._-]{1,128}$/.test(job.phase) || typeof job.state !== "string" || typeof job.effect !== "string"
            || typeof job.stdout !== "string" || Buffer.byteLength(job.stdout) > 4096
            || typeof job.stderr !== "string" || Buffer.byteLength(job.stderr) > 1024
            || job.exitCode !== null && !Number.isInteger(job.exitCode))))
        throw new Error("Invalid environment run result; do not retry automatically.");
      return result;
    } finally { this.environmentApprovals.delete(approvalId); }
  }

  async start(extensionPath: string, directory: string, nodePath: string, legacyRoot: string): Promise<string> {
    return this.boot(extensionPath, directory, nodePath, legacyRoot);
  }

  recipeWorkspacePin(): NextRecipeWorkspacePin {
    return captureRecipeWorkspace(path.dirname(this.pythonWorkspaceDirectory()), this.pythonWorkspaceId());
  }
  async resumeRecipes(extensionPath: string, pin: NextRecipeWorkspacePin, nodePath: string, legacyRoot: string): Promise<void> {
    assertRecipeWorkspace(pin);
    this.recipeRecovery = Object.freeze({ ...pin });
    await this.boot(extensionPath, pin.parent, nodePath, legacyRoot);
  }
  async resumeSelectedChat(extensionPath: string, pin: NextSelectedChatRecoveryPin, nodePath: string, legacyRoot: string): Promise<void> {
    assertSelectedChatRecoveryPin(pin, legacyRoot);
    this.selectedChatRecovery = Object.freeze({ ...pin });
    await this.boot(extensionPath, pin.parent, nodePath, legacyRoot);
  }
  selectedChatRecoveryPin(): NextSelectedChatRecoveryPin | undefined { return this.selectedChatRecovery; }
  async recipeCommand(command: Record<string, unknown>, review?: (request: {
    binding: Record<string, unknown>; operation: string; approval: any;
  }) => Promise<boolean>): Promise<any> {
    const root = this.pythonWorkspaceDirectory(), workspaceId = this.pythonWorkspaceId(), child = this.child;
    if (!child || Buffer.byteLength(JSON.stringify(command)) > 1_000_000) throw new Error("Bounded native Recipe request required.");
    const approvalId = randomUUID();
    this.recipeApprovals.set(approvalId, async message => {
      if (this.state !== "open" || this.child !== child || message.binding?.root !== root
        || message.binding?.workspaceId !== workspaceId || message.binding?.actorId !== "local:owner") return false;
      if (command.operation === "save") {
        if (message.operation !== "library-save" || !isDeepStrictEqual(message.approval, command.input)) return false;
      } else if (command.operation === "execute") {
        const input = command.input as any;
        if (message.operation !== "lazy" || message.approval?.operation !== input?.operation
          || !message.approval.args || Object.entries(input.args ?? {}).some(([key, value]) =>
            !isDeepStrictEqual(message.approval.args[key], value))) return false;
      } else return false;
      const approved = await review?.({ binding: message.binding, operation: message.operation, approval: message.approval }) === true;
      return approved && this.state === "open" && this.child === child && this.pythonWorkspaceDirectory() === root;
    });
    try { return await this.request({ type: "recipe-command", command, approvalId }); }
    finally { this.recipeApprovals.delete(approvalId); }
  }

  async resumeIsolatedRoom(extensionPath: string, pin: NextRoomRecoveryPin, nodePath: string, legacyRoot: string,
    pins: NextRoomRecoveryPin[] = [pin]): Promise<void> {
    if (!pins.length || pins.length > 128 || new Set(pins.map(item => item.roomId)).size !== pins.length
      || !pins.some(item => item.roomId === pin.roomId && item.sourceFingerprint === pin.sourceFingerprint))
      throw new Error("Room recovery inventory is invalid.");
    for (const item of pins) {
      assertRoomRecoveryPin(item, legacyRoot);
      if (item.parent !== pin.parent || item.workspaceId !== pin.workspaceId || item.workspaceIdentity !== pin.workspaceIdentity
        || item.databaseIdentity !== pin.databaseIdentity || item.markerIdentity !== pin.markerIdentity
        || item.parentIdentity !== pin.parentIdentity || item.legacyIdentity !== pin.legacyIdentity)
        throw new Error("Room recovery workspace pins disagree.");
    }
    this.roomRecovery = Object.freeze({ ...pin });
    this.roomRecoveries = pins.map(item => Object.freeze({ ...item }));
    for (const item of this.roomRecoveries) if (item.origin === "native") this.nativeRoomPins.set(item.roomId, item);
    await this.boot(extensionPath, pin.parent, nodePath, legacyRoot);
  }

  async planImport(extensionPath: string, parent: string, nodePath: string, legacyRoot: string,
    source: string, python: string, memoryEngine?: string): Promise<NextImportPlan> {
    this.importMode = true;
    this.importParent = parent;
    await this.boot(extensionPath, parent, nodePath, legacyRoot, {
      source, parent, python, legacyRoot, acknowledge: true, ...(memoryEngine ? { memoryEngine } : {}),
    });
    return this.importPlan!;
  }

  setMemoryScopeApprovalHandler(handler: MemoryScopeApprovalHandler): void {
    if (!this.importMode || this.state !== "open" || this.memoryScopeApprovalHandler)
      throw new Error("Memory scope approval handler is unavailable.");
    this.memoryScopeApprovalHandler = handler;
  }

  async selectMemoryScope(sourceScopeSha256: string): Promise<NextImportPlan> {
    if (!this.importMode || this.state !== "open" || this.importConfirmed
      || !/^[a-f0-9]{64}$/.test(sourceScopeSha256)
      || !this.importPlan?.memoryPlan?.scopes.some(scope => hashScope(scope) === sourceScopeSha256)) {
      throw new Error("Memory scope selection is not part of the current original snapshot.");
    }
    const result = await this.request({ type: "select-memory-scope", sourceScopeSha256 });
    const plan = validateImportPlan(result?.plan, this.importParent!);
    if (!plan || !plan.ready || plan.memoryPlan?.continuityScopeSha256 !== sourceScopeSha256)
      throw new Error("Selected Memory scope could not be pinned into the import plan.");
    this.importPlan = plan;
    return plan;
  }

  async resumeImport(extensionPath: string, credential: NextWriteCredential, nodePath: string, legacyRoot: string): Promise<void> {
    this.importMode = true;
    this.importParent = credential.parent;
    await this.boot(extensionPath, credential.parent, nodePath, legacyRoot, undefined, credential);
  }
  async openMemoryWorkspace(extensionPath: string, directory: string, nodePath: string, legacyRoot: string): Promise<void> {
    this.importMode = true;
    this.memoryDirectory = directory;
    await this.boot(extensionPath, directory, nodePath, legacyRoot, undefined, undefined, true);
  }

  async prepareMemoryReadoption(): Promise<{ target: string; pin: MemoryHostPin }> {
    if (!this.importMode || !this.importConfirmed || this.state !== "open")
      throw new Error("Open an isolated imported trial first.");
    const result = await this.request({ type: "prepare-memory-readoption" });
    const pin = parseMemoryHostPin(result?.pin);
    const target = this.memoryDirectory ?? (this.importParent && path.join(this.importParent, "workspace"));
    if (!pin || result.target !== target || pin.workspaceId !== this.workspaceId)
      throw new Error("Imported Memory evidence is not bound to this exact workspace.");
    return { target: result.target, pin };
  }

  async readoptMemory(pin: MemoryHostPin, handler: MemoryScopeApprovalHandler): Promise<void> {
    if (this.memoryReadoptionPending || !parseMemoryHostPin(pin) || this.workspaceId !== pin.workspaceId
      || !this.importMode || !this.importConfirmed || this.state !== "open")
      throw new Error("Exact imported workspace and independent host pin are required.");
    this.memoryReadoptionPending = true;
    const previous = this.memoryScopeApprovalHandler;
    this.memoryScopeApprovalHandler = handler;
    try {
      const result = await this.request({ type: "readopt-memory", pin });
      if (result?.workspaceId !== pin.workspaceId || result.scope !== pin.scope
        || !Number.isSafeInteger(result.expiresAtMs) || result.expiresAtMs <= Date.now())
        throw new Error("Fresh exact Memory session was not confirmed.");
    } finally { this.memoryReadoptionPending = false; this.memoryScopeApprovalHandler = previous; }
  }

  private async boot(extensionPath: string, directory: string, nodePath: string, legacyRoot: string,
    importing?: Record<string, unknown>, resuming?: NextWriteCredential, memoryReopen = false): Promise<string> {
    if (this.state !== "new") throw new Error("Trial already started.");
    this.state = "starting";
    try {
      if (process.platform !== "linux") throw new Error("Trial currently requires Linux.");
      const payload = verifyNextPayload(extensionPath);
      if (!path.isAbsolute(directory) || path.resolve(directory) !== directory || fs.realpathSync(directory) !== directory)
        throw new Error("Select a real absolute empty directory.");
      const stat = fs.lstatSync(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0 ||
        (!resuming && !memoryReopen && !this.roomRecovery && !this.recipeRecovery && !this.selectedChatRecovery
          && fs.readdirSync(directory).length)) throw new Error("Trial directory must be empty and private to this account.");
      if (legacyRoot) {
        const legacy = fs.realpathSync(legacyRoot);
        if (overlap(directory, legacy) || overlap(legacy, directory)) throw new Error("Trial and existing Knowledge Root must not overlap.");
        this.legacyDirectory = legacy;
      }
      if (!path.isAbsolute(nodePath) || fs.realpathSync(nodePath) !== nodePath || !fs.statSync(nodePath).isFile())
        throw new Error("Select a real absolute Node executable.");
      const version = execFileSync(nodePath, ["-e", "const v=process.versions.node.split('.').map(Number); if(v[0]<22||(v[0]===22&&v[1]<18))process.exit(2); require('node:sqlite');"], {
        timeout: 10000, stdio: "ignore", env: { PATH: process.env.PATH || "" },
      });
      void version;
      const child = fork(payload.entry, [], {
        execPath: nodePath, cwd: payload.root, stdio: ["ignore", "ignore", "ignore", "ipc"],
        env: { PATH: process.env.PATH || "", NODE_NO_WARNINGS: "1" },
      });
      this.child = child;
      this.pythonDirectory = !importing && !resuming && !memoryReopen && !this.roomRecovery ? path.join(directory, "workspace") : undefined;
      const started = new Promise<string>((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => { if (!settled) { settled = true; reject(new Error("Trial startup timed out; outcome unknown.")); } }, 30000);
        const fail = (error: Error) => { if (!settled) { settled = true; clearTimeout(timer); reject(error); } };
        this.cancelStartup = () => fail(new Error("Trial startup cancelled; shutdown is pending and outcome may be unknown."));
        child.on("message", (raw: unknown) => {
          if (!raw || typeof raw !== "object") return;
          const message = raw as Record<string, any>;
          if (this.vscodeModelBridge?.handle(message)) return;
          if (message.type === "selected-chat-review-request") {
            const review = this.selectedReview;
            const respond = (approved: boolean) => {
              try { if (child.connected) child.send({ type: "selected-chat-review-response", id: message.id,
                session: message.session, approved }); } catch { /* Deny on disconnect. */ }
            };
            if (!review || review.owner.session !== message.session || !/^[a-f0-9-]{36}$/.test(message.id)
              || !review.chats.has(`${message.namespace}:${message.chatId}`) || !/^[a-f0-9]{64}$/.test(message.expectedDigest)
              || message.decision !== "abandon-without-replay" || typeof message.reason !== "string"
              || !message.reason.trim() || message.reason.length > 1000 || review.challenges.has(message.id)) {
              respond(false); return;
            }
            review.challenges.add(message.id);
            void (async () => {
              try {
                review.owner.assertCurrent();
                const vscode = await import("vscode");
                const choice = await vscode.window.showWarningMessage("Confirm this selected Chat unknown-outcome decision?",
                  { modal: true, detail: `Chat: ${message.chatId}\nEvidence digest: ${message.expectedDigest}\nReason: ${message.reason}\nThe effect remains UNKNOWN and is never replayed.` },
                  "Confirm unknown; never replay");
                review.owner.assertCurrent();
                respond(this.selectedReview === review && choice === "Confirm unknown; never replay");
              } catch { respond(false); }
            })();
            return;
          }
          if (message.type === "environment-command-revalidate" && typeof message.approvalId === "string"
            && typeof message.challengeId === "string" && /^[a-f0-9-]{36}$/.test(message.challengeId)) {
            let approved = false;
            const approval = this.environmentApprovals.get(message.approvalId);
            this.environmentApprovals.delete(message.approvalId);
            try { approved = approval?.(message.grantSha256) === true; } catch { /* Deny stale native capability. */ }
            try { child.send({ type: "environment-command-revalidated", challengeId: message.challengeId, approved }); }
            catch { /* Child fails closed on disconnect or timeout. */ }
            return;
          }
          if (message.type === "python-trial-revalidate" && typeof message.approvalId === "string"
            && typeof message.challengeId === "string" && /^[a-f0-9-]{36}$/.test(message.challengeId)) {
            let approved = false;
            const approval = this.pythonApprovals.get(message.approvalId);
            this.pythonApprovals.delete(message.approvalId);
            try { approved = approval?.(message.handleSha256) === true; } catch { /* Deny stale authority. */ }
            try { child.send({ type: "python-trial-revalidated", challengeId: message.challengeId, approved }); }
            catch { /* Child fails closed on timeout/disconnect. */ }
            return;
          }
          if (message.type === "import-plan" && importing && this.state === "starting" && !settled) {
            const plan = validateImportPlan(message, directory);
            if (!plan) {
              fail(new Error("Invalid import plan; outcome unknown.")); return;
            }
            this.importPlan = plan;
            settled = true; clearTimeout(timer); this.state = "open"; resolve(""); return;
          }
          if (message.type === "recipe-approval-request" && this.state === "open"
            && typeof message.approvalId === "string" && typeof message.challenge === "string") {
            const approve = this.recipeApprovals.get(message.approvalId);
            const respond = (approved: boolean) => {
              try {
                if (child.connected) child.send({ type: "recipe-approval-result", approvalId: message.approvalId,
                  challenge: message.challenge, approved });
              } catch { /* The child denies a disconnected or expired review. */ }
            };
            void Promise.resolve(approve?.(message) ?? false).then(approved => respond(approved === true), () => respond(false));
            return;
          }
          if (message.type === "memory-scope-approval-request" && this.importMode && this.importConfirmed
            && this.state === "open" && typeof message.approvalId === "string"
            && /^[a-f0-9-]{36}$/i.test(message.approvalId)) {
            void Promise.resolve(this.memoryScopeApprovalHandler?.(message.envelope) ?? null).then(approval => {
              const valid = approval && approval.actorId.length > 0 && approval.actorId.length <= 256
                && /^[a-f0-9-]{36}$/i.test(approval.decisionId)
                && Number.isSafeInteger(approval.expiresAtMs) && approval.expiresAtMs > Date.now()
                ? approval : null;
              try { child.send({ type: "memory-scope-approval-result", approvalId: message.approvalId, approval: valid }); }
              catch { /* The importer will fail closed when its approval response is unavailable. */ }
            }, () => {
              try { child.send({ type: "memory-scope-approval-result", approvalId: message.approvalId, approval: null }); }
              catch { /* The importer will fail closed when its approval response is unavailable. */ }
            });
            return;
          }
          if (message.type === "ready" && this.state === "starting" && !settled && typeof message.workspaceId === "string" &&
            /^[a-f0-9-]{36}$/.test(message.workspaceId)) {
            if (this.roomRecovery && (message.workspaceId !== this.roomRecovery.workspaceId || message.roomOnly !== true)) {
              fail(new Error("Room-only recovery binding invalid; outcome unknown.")); return;
            }
            if (resuming) {
              if (message.workspaceId !== resuming.workspaceId || message.readOnly !== false ||
                message.scope !== "isolated_experiment" || !this.validCoverage(message.writerCoverage)) {
                fail(new Error("Experimental resume binding invalid; outcome unknown.")); return;
              }
              this.writeEnabled = true; this.importConfirmed = true;
            }
            if (memoryReopen) {
              if (message.readOnly !== true || message.memoryReadoption !== true) {
                fail(new Error("Memory workspace reopening was not read-only.")); return;
              }
              this.readOnly = true; this.importConfirmed = true;
            }
            if (this.recipeRecovery && message.workspaceId !== this.recipeRecovery.workspaceId) {
              fail(new Error("Recipe recovery workspace changed.")); return;
            }
            if (this.selectedChatRecovery && (message.workspaceId !== this.selectedChatRecovery.workspaceId || message.selectedChatOnly !== true)) {
              fail(new Error("Selected Chat-only recovery binding invalid; outcome unknown.")); return;
            }
            this.workspaceId = message.workspaceId;
            settled = true; clearTimeout(timer); this.state = "open"; resolve(message.workspaceId); return;
          }
          if (message.type === "startup-error") {
            // The child owns drain after startup failure; connected can lag its disconnect.
            this.peerClosing = true;
            const detail = typeof message.message === "string" ? message.message.slice(0, 4096) : "";
            fail(new Error(`Trial host startup failed; preserve the selected directory; outcome may be unknown.${detail ? `\n${detail}` : ""}`));
            return;
          }
          if (message.type === "closed") { this.peerClosing = true; this.drained = true; return; }
          if (message.type === "result" && typeof message.id === "string") {
            const pending = this.pending.get(message.id);
            if (!pending) return;
            this.pending.delete(message.id);
            if (message.error) {
              const blockers = Array.isArray(message.blockers) ? message.blockers.map((item: any) =>
                `${String(item?.code)}: ${String(item?.path)}: ${String(item?.message)}${item?.relatedPath ? ` (${String(item.relatedPath)})` : ""}`).join("\n") : "";
              const detail = typeof message.message === "string" ? message.message.slice(0, 4096) : "";
              pending.reject(new Error(message.error === "BUSY_OR_INVALID"
                ? `Trial request rejected before admission.${detail ? `\n${detail}` : ""}`
                : `Trial operation outcome unknown. Preserve operation ID ${message.id}; do not replay automatically.${detail ? `\n${detail}` : ""}${blockers ? `\nBlockers:\n${blockers}` : ""}`));
            }
            else pending.resolve(message.result);
          }
          if (message.type === "close-error") {
            this.peerClosing = true;
            this.drainError = new Error("Trial host drain failed; outcome unknown.");
          }
          if (message.type === "close-retryable-error") {
            if (child.connected) this.peerClosing = false;
            this.failStop?.(new Error("Trial host drain failed; child remains connected and outcome is unknown. Retry Close Trial."));
          }
        });
        child.once("disconnect", () => {
          this.peerClosing = true;
          this.selectedOwner?.invalidate();
          void this.drainSelectedModel().catch(() => undefined);
        });
        child.once("error", () => {
          fail(new Error("Trial child process error; startup outcome unknown. Preserve the selected directory."));
          this.drainError = new Error("Trial child process error; outcome unknown.");
        });
        child.once("close", (code, signal) => {
          this.selectedOwner?.invalidate();
          fail(new Error("Trial child exited during startup; outcome unknown. Preserve the selected directory."));
          for (const request of this.pending.values()) request.reject(new Error("Trial child exited; operation outcome unknown. Do not replay automatically."));
          this.pending.clear();
          const expected = this.state === "closing" && this.drained && code === 0 && !signal;
          this.state = "closed";
          this.closed(expected && !this.drainError ? undefined : this.drainError || new Error("Trial child exited unexpectedly; reconcile uncertain writes."));
        });
        try {
          child.send(this.selectedChatRecovery ? { type: "start-selected-chat-recovery", pin: this.selectedChatRecovery, legacyRoot: this.legacyDirectory }
            : this.recipeRecovery ? { type: "start-recipe-recovery", pin: this.recipeRecovery, legacyRoot: this.legacyDirectory }
            : this.roomRecovery ? { type: "start-room-recovery", pin: this.roomRecovery, legacyRoot: this.legacyDirectory,
            archives: this.roomRecoveries.filter(item => item.origin !== "native").map(({ roomId, sourceFingerprint }) => ({ roomId, sourceFingerprint })),
            natives: this.roomRecoveries.filter(item => item.origin === "native").map(({ roomId, sourceFingerprint, nativeName, hostCredentialHash }) =>
              ({ roomId, sourceFingerprint, name: nativeName, hostCredentialHash })) }
            : resuming ? { type: "start-import-write", parent: resuming.parent, capability: resuming.capability,
            acknowledgeIsolatedExperiment: true } : importing ? { type: "start-import", ...importing }
              : memoryReopen ? { type: "start-memory-readoption", directory, legacyRoot } : { type: "start", directory, legacyRoot: this.legacyDirectory }, error => {
            if (error) fail(new Error("Trial startup request failed; outcome unknown. Preserve the selected directory."));
          });
        } catch {
          fail(new Error("Trial startup request failed; outcome unknown. Preserve the selected directory."));
        }
      });
      try {
        const workspaceId = await started;
        if ((this.state as string) !== "open") throw new Error("Trial startup cancelled; shutdown is pending and outcome may be unknown.");
        return workspaceId;
      }
      finally { this.cancelStartup = undefined; }
    } catch (error) {
      if (this.child && !this.isStopped()) void this.close().catch(() => undefined);
      else if (!this.child) { this.state = "closed"; this.closed(); }
      throw error;
    }
  }

  invoke(operation: Operation, args: Record<string, unknown>): Promise<any> {
    if (this.importMode && !this.writeEnabled && (!this.readOnly || !["list", "get", "asset-list", "asset-get", "board-list", "board-get", "board-tasks", "board-stories",
      "research-list", "skill-list", "skill-get", "metadata-get", "recipe-list", "recipe-get", "library-list", "library-get", "mutation-scan",
      "memory-get", "memory-search", "memory-audit", "memory-replay"].includes(operation)))
      return Promise.reject(new Error("Imported workspace permits attached read-only document/resource reads only."));
    return this.request({ type: "invoke", operation, args });
  }

  async confirmImport(planSha256: string): Promise<any> {
    if (!this.importMode || this.importConfirmed || !this.importPlan?.ready || this.importPlan.blockers.length ||
      this.importPlan.planSha256 !== planSha256) throw new Error("Import confirmation rejected before admission.");
    this.importConfirmed = true;
    return this.request({ type: "confirm-import", planSha256 });
  }

  importStatus(): Promise<any> { return this.request({ type: "import-status" }); }

  async attachImport(): Promise<void> {
    if (!this.importMode || !this.importConfirmed) throw new Error("Import has not been confirmed.");
    const result = await this.request({ type: "attach-import" });
    if (result?.readOnly !== true || typeof result.workspaceId !== "string" ||
      !/^[a-f0-9-]{36}$/.test(result.workspaceId)) {
      void this.close().catch(() => undefined);
      throw new Error("Invalid import attach; outcome unknown.");
    }
    this.readOnly = true;
    this.workspaceId = result.workspaceId;
  }

  private validCoverage(value: any): boolean {
    return value?.inProcessCalls === "tracked" && value?.cooperatingHosts === "native-lease" && value?.external === "unknown";
  }

  async prepareImportWrite(): Promise<NextWritePreparation> {
    if (!this.importMode || !this.readOnly || this.writeAttempted) throw new Error("Attach the imported copy read-only first.");
    const result = await this.request({ type: "prepare-import-write" });
    if (result?.workspaceId !== this.workspaceId || result?.scope !== "isolated_experiment" ||
      result.target !== path.join(this.importParent!, "workspace") || !/^[a-f0-9]{64}$/.test(result.authorizationDigest) ||
      result.planSha256 !== this.importPlan?.planSha256 || !this.validCoverage(result.writerCoverage) ||
      !Array.isArray(result.blockers) || result.blockers.some((item: unknown) => typeof item !== "string"))
      throw new Error("Invalid experimental write preparation; writing remains disabled.");
    this.preparation = result;
    return result;
  }

  async enableImportWrite(authorizationDigest: string, confirmTarget: string): Promise<NextWriteCredential> {
    const preparation = this.preparation;
    if (this.writeAttempted || !preparation || preparation.blockers.length ||
      preparation.authorizationDigest !== authorizationDigest || preparation.target !== confirmTarget)
      throw new Error("Experimental write approval rejected before admission.");
    this.writeAttempted = true;
    const result = await this.request({ type: "enable-import-write", authorizationDigest, confirmTarget,
      acknowledgeIsolatedExperiment: true });
    if (result?.workspaceId !== this.workspaceId || result.readOnly !== false || result.scope !== "isolated_experiment" ||
      result.credential?.parent !== this.importParent || typeof result.credential?.capability !== "string" ||
      !/^[a-f0-9]{64}$/.test(result.credential.capability)) {
      void this.close().catch(() => undefined);
      throw new Error("Experimental authorization outcome unknown; do not retry.");
    }
    this.writeEnabled = true;
    return { ...result.credential, workspaceId: this.workspaceId! };
  }

  private request(message: Record<string, unknown>): Promise<any> {
    if (this.state !== "open" || this.peerClosing || !this.child?.connected) return Promise.reject(new Error("Trial is not connected."));
    if (this.pending.size >= 16) return Promise.reject(new Error("Trial admission limit reached."));
    let bytes: number;
    try { bytes = Buffer.byteLength(JSON.stringify(message)); } catch { return Promise.reject(new Error("Invalid trial request.")); }
    if (bytes > 250_000) return Promise.reject(new Error("Trial request is too large."));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Trial request timed out; outcome unknown. Preserve operation ID ${id}; do not replay automatically.`));
        void this.close().catch(() => undefined);
      }, 30000);
      const failed = (error: Error) => { clearTimeout(timer); reject(error); };
      this.pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: failed });
      const sendFailed = () => {
        if (this.pending.delete(id)) failed(new Error(`Trial request outcome unknown. Preserve operation ID ${id}; do not replay automatically.`));
        void this.close().catch(() => undefined);
      };
      try { this.child!.send({ ...message, id }, error => { if (error) sendFailed(); }); }
      catch { sendFailed(); }
    });
  }

  close(): Promise<void> {
    if (this.stop) return this.stop;
    if (this.state === "new") { this.state = "closed"; this.closed(); return Promise.resolve(); }
    if (this.state === "closed") return this.drainSelectedModel().then(() => this.termination);
    this.state = "closing";
    this.selectedOwner?.invalidate();
    for (const bridge of this.roomBridges.values()) bridge.close();
    this.roomBridges.clear();
    this.roomHubPolicy = undefined;
    this.pythonApprovals.clear();
    this.environmentApprovals.clear();
    this.recipeApprovals.clear();
    this.cancelStartup?.();
    if (this.child?.connected && !this.peerClosing) {
      try {
        this.child.send({ type: "close" }, error => {
          if (error) this.drainError = new Error("Trial shutdown request failed; outcome unknown.");
        });
      } catch {
        this.drainError = new Error("Trial shutdown request failed; outcome unknown.");
      }
    }
    this.stop = new Promise<void>((resolve, reject) => {
      let settled = false;
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.failStop = undefined;
        this.stop = undefined;
        reject(error);
      };
      const timer = setTimeout(() => fail(new Error("Trial drain timed out; the child was not terminated and outcomes remain unknown.")), 30000);
      this.failStop = fail;
      this.termination.then(() => this.drainSelectedModel(),
        error => this.drainSelectedModel().then(() => { throw error; })).then(() => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.failStop = undefined;
        resolve();
      }, fail);
    });
    return this.stop;
  }
}
