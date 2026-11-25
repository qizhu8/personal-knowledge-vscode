import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, lstat, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { initialize, Storage } from "./storage.js";
import { legacyImportPlanSchema, type LegacyImportPlan } from "./domain/legacy-import.js";
import { activateMemoryScopeContinuity, activateReadoptedMemoryScope, type MemoryScopeContinuityRequest } from "./memory-scope-continuity.js";
import { inspectMemoryHostPin, memoryHostPinSchema, type MemoryHostPin } from "./memory-readoption.js";
import { readManagedMemory } from "./managed-memory-reader.js";
import { auditImportedWorkspace } from "./managed-import-audit.js";
import { openImportedExperiment, experimentCoverage } from "./managed-import-write.js";
import { bindImportedReadOnlyHost, startManagedClientHost, type ManagedClientHost, type ManagedDocumentOperation } from "./managed-client-host.js";
import { PYTHON_TRIAL_SCRIPT, runHostPythonWorkflow } from "./host-python-workflow.js";
import { HostLocalEnvironmentWorkflow, localEnvironmentCommandSchema, verifyLocalJournal } from "./host-local-environment-workflow.js";
import { inspectLegacyChatroomArchive } from "./legacy-chatroom-continuation.js";
import { createVscodeLegacyChatroomHost } from "./legacy-chatroom-vscode-host.js";
import { copyPrivateRoomArchive } from "./legacy-chatroom-private-copy.js";
import { managedRecipePolicy } from "./managed-recipe-policy.js";
import { managedRecipeIpc } from "./managed-recipe-ipc.js";
import { assertNativeRoomNameAvailable, createNativeRoom, inspectNativeRoom, nativeRoomName } from "./native-chatroom-identity.js";
import { attachLegacyChatroomHostIpc } from "./legacy-chatroom-host-ipc.js";
import { managedSelectedOwnerIpc } from "./managed-selected-owner-ipc.js";
import { managedClientSelectedChatIpc } from "./managed-client-selected-chat-ipc.js";
import { assertSelectedChatRecovery, type SelectedChatRecoveryPin } from "./selected-chat-recovery.js";
import { coreDatabasePath } from "./workspace-storage-paths.js";

const endpoint = "http://127.0.0.1:1/v1";
let selectedChatRecovery: SelectedChatRecoveryPin | undefined;
const readOnlyManagedOperations = new Set([
  "list", "get", "asset-list", "asset-get", "board-list", "board-get", "board-tasks", "board-stories",
  "research-list", "skill-list", "skill-get", "metadata-get", "recipe-list", "recipe-get",
  "library-list", "library-get", "mutation-scan",
]);
let host: ManagedClientHost | undefined;
let roomHost: Awaited<ReturnType<typeof createVscodeLegacyChatroomHost>> | undefined;
let roomHostPolicy: { legacyReconnect: string; port: number } | undefined;
let roomWork: Promise<void> | undefined;
let roomRecovery: { parent: string; parentIdentity: string; workspaceIdentity: string; databaseIdentity: string; markerIdentity: string;
  legacyRoot: string; legacyIdentity: string; workspaceId: string; roomId: string; sourceFingerprint: string;
  archives: { roomId: string; sourceFingerprint: string }[];
  natives: { roomId: string; sourceFingerprint: string; name: string; hostCredentialHash: string }[] } | undefined;
let privateLegacyRoot: string | undefined;
let pythonWorkspaceRoot: { path: string; pin: string } | undefined;
let pythonWork: Promise<void> | undefined;
const pythonShutdown = new AbortController();
const pythonChallenges = new Map<string, (approved: boolean) => void>();
let environmentService: HostLocalEnvironmentWorkflow | undefined;
let environmentJournal: string | undefined;
let environmentWork: Promise<void> | undefined;
const environmentChallenges = new Map<string, (approved: boolean) => void>();
let booting = false, closing = false, inFlight = 0;
let startup: Promise<void> | undefined;
let shutdown: Promise<void> | undefined;
let migration: { source: string; parent: string; target: string; python: string; legacyRoot: string;
  sourcePin: string; parentPin: string; legacyPin: string; memoryEngine?: string; memoryActorId?: string;
  selectedMemoryScopeSha256?: string; planSha256: string; fingerprint: string; attempted: boolean; receipt?: unknown } | undefined;
let migrationBusy = false;
let migrationPlanned = false;
let migrationWork: Promise<void> | undefined;
let importedReader = false;
let approvedPlan: LegacyImportPlan | undefined;
let importedAudit: Awaited<ReturnType<typeof auditImportedWorkspace>> | undefined;
let writePreparation: { digest: string; workspaceId: string } | undefined;
let writeAttempted = false;
let memoryApproval: { actorId: string; decisionId: string; expiresAtMs: number } | undefined;
let memoryRoot: string | undefined;
let memoryLive = false;
let memorySessionPin: MemoryHostPin | undefined;
const memoryApprovals = new Map<string, (approval: typeof memoryApproval | null) => void>();
const memoryReads = new Set<Promise<void>>();
const send = (message: object) => { if (process.connected) process.send?.(message); };
const recipeIpc = managedRecipeIpc({ host: () => host,
  unavailable: () => closing || migrationBusy || importedReader || inFlight > 0 || !!roomWork || !!pythonWork || !!environmentWork,
  send });
const selectedOwnerIpc = managedSelectedOwnerIpc({ host: () => host,
  unavailable: () => closing || migrationBusy || importedReader,
  connected: () => !!process.connected, send });
const selectedChatIpc = managedClientSelectedChatIpc({ owner: selectedOwnerIpc, host: () => host,
  workspace: () => pythonWorkspaceRoot?.path, source: () => privateLegacyRoot,
  recovery: () => selectedChatRecovery,
  unavailable: () => closing || migrationBusy || importedReader || inFlight > 0 || !!roomWork || !!pythonWork || !!environmentWork,
  send });
const execute = promisify(execFile);
const cli = join(dirname(fileURLToPath(import.meta.url)), "cli.js");
const ack = "--acknowledge-quiescent-disposable-copy";
const overlap = (parent: string, child: string) => {
  const delta = relative(parent, child);
  return !delta || (delta !== ".." && !delta.startsWith(`..${sep}`) && !isAbsolute(delta));
};
function requestMemoryApproval(request: Readonly<MemoryScopeContinuityRequest>, target: string, receiptStateSha256?: string) {
  const approvalId = randomUUID();
  return new Promise<typeof memoryApproval | null>(resolveApproval => {
    const timer = setTimeout(() => { memoryApprovals.delete(approvalId); resolveApproval(null); }, 120_000);
    memoryApprovals.set(approvalId, value => { clearTimeout(timer); resolveApproval(value); });
    send({ type: "memory-scope-approval-request", approvalId,
      envelope: { target, request, ...(receiptStateSha256 ? { receiptStateSha256 } : {}) } });
  });
}

async function realDirectory(value: unknown): Promise<{ path: string; pin: string }> {
  if (typeof value !== "string" || !isAbsolute(value) || resolve(value) !== value || await realpath(value) !== value)
    throw new Error("Absolute canonical real directory required.");
  let current: string = sep;
  for (const part of value.slice(1).split(sep).filter(Boolean)) {
    current = join(current, part);
    const stat = await lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Directory symlinks are forbidden.");
  }
  const stat = await lstat(value, { bigint: true });
  return { path: value, pin: `${stat.dev}:${stat.ino}` };
}
async function assertRoomRecovery() {
  const pin = roomRecovery!;
  const parent = await realDirectory(pin.parent), root = await realDirectory(join(pin.parent, "workspace"));
  const legacy = await realDirectory(pin.legacyRoot), parentStat = await lstat(parent.path);
  const database = await lstat(coreDatabasePath(root.path), { bigint: true });
  const marker = await lstat(join(root.path, ".pkm-next-workspace"), { bigint: true });
  if (parent.pin !== pin.parentIdentity || root.pin !== pin.workspaceIdentity || legacy.pin !== pin.legacyIdentity
    || !database.isFile() || database.isSymbolicLink() || `${database.dev}:${database.ino}` !== pin.databaseIdentity
    || !marker.isFile() || marker.isSymbolicLink() || `${marker.dev}:${marker.ino}` !== pin.markerIdentity
    || parentStat.uid !== process.getuid?.() || (parentStat.mode & 0o077) !== 0
    || overlap(parent.path, legacy.path) || overlap(legacy.path, parent.path)
    || JSON.parse(await readFile(join(root.path, ".pkm-next-workspace"), "utf8")).id !== pin.workspaceId)
    throw new Error("Room recovery workspace binding changed.");
}
async function migrationCheck(empty: boolean) {
  const state = migration!;
  const source = await realDirectory(state.source), parent = await realDirectory(state.parent), legacy = await realDirectory(state.legacyRoot);
  const stat = await lstat(state.parent);
  if (source.pin !== state.sourcePin || parent.pin !== state.parentPin || legacy.pin !== state.legacyPin
    || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0
    || empty && (await readdir(state.parent)).length !== 0) throw new Error("Migration path identity or target changed.");
}
async function runCli(command: string, args: string[]): Promise<{ code: number; value: any }> {
  try {
    const result = await execute(process.execPath, [cli, command, ...args], { maxBuffer: 64 * 1024 * 1024 });
    return { code: 0, value: JSON.parse(result.stdout) };
  } catch (error) {
    const failure = error as { code?: string | number; signal?: string; stdout?: string; stderr?: string };
    if (typeof failure.code === "number" && !failure.signal && failure.stdout) {
      try { return { code: failure.code, value: JSON.parse(failure.stdout) }; } catch { /* No structured result. */ }
    }
    throw new Error(`Importer process failed or returned an unrecognized result.${failure.stderr ? ` ${failure.stderr.slice(0, 4096)}` : ""}`);
  }
}
async function status() {
  const result = await runCli("import-status", ["--destination", migration!.target]);
  const outcome = result.value?.outcome;
  if (!outcome || !["published", "in-progress", "not-published", "unknown"].includes(outcome.status)
    || outcome.status === "published" && (result.code !== 0 || outcome.receipt?.destination !== migration!.target))
    throw new Error("Invalid import outcome.");
  return outcome;
}

function close(): Promise<void> {
  if (shutdown) return shutdown;
  closing = true;
  selectedOwnerIpc.closeAdmission();
  recipeIpc.close();
  pythonShutdown.abort();
  for (const resolveApproval of pythonChallenges.values()) resolveApproval(false);
  for (const resolveApproval of environmentChallenges.values()) resolveApproval(false);
  shutdown = (async () => {
    try {
      for (const resolveApproval of memoryApprovals.values()) resolveApproval(null);
      await startup; await migrationWork; await pythonWork; await environmentWork; await roomWork;
      await recipeIpc.drain(); await selectedChatIpc.drain(); await selectedOwnerIpc.drain();
      await environmentService?.close();
      await roomHost?.close();
      await Promise.all(memoryReads); await host?.close();
      send({ type: "closed" });
      if (process.connected) process.disconnect?.();
    }
    catch {
      if (host && process.connected) {
        shutdown = undefined;
        send({ type: "close-retryable-error" });
      } else {
        send({ type: "close-error" });
        process.exitCode = 1;
        if (process.connected) process.disconnect?.();
      }
    }
  })();
  return shutdown;
}

process.on("disconnect", () => { void close(); });
process.on("message", (value: unknown) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const message = value as Record<string, unknown>;
  if (message.type === "close") { void close(); return; }
  if (selectedOwnerIpc.handle(message)) return;
  if (selectedChatIpc.handle(message)) return;
  if (selectedChatRecovery) {
    if (typeof message.id === "string") send({ type: "result", id: message.id, error: "BUSY_OR_INVALID" });
    return;
  }
  if (recipeIpc.handle(message)) return;
  if (recipeIpc.busy && !["pkm.room.host-response/v1", "pkm.room.host-revoked/v1"].includes(String(message.type))) {
    if (typeof message.id === "string") send({ type: "result", id: message.id, error: "BUSY_OR_INVALID" });
    return;
  }
  if (roomRecovery && !["room-name-check", "room-create", "room-inspect", "room-open", "room-close", "pkm.room.host-response/v1",
    "pkm.room.host-revoked/v1"].includes(String(message.type))) {
    if (typeof message.id === "string") send({ type: "result", id: message.id, error: "BUSY_OR_INVALID" });
    return;
  }
  if (["room-import-private", "room-name-check", "room-create", "room-inspect", "room-open", "room-close"].includes(String(message.type))) {
    if (typeof message.id !== "string" || !/^[a-f0-9-]{36}$/.test(message.id)) return;
    const id = message.id;
    if (closing || !host?.roomContext || roomWork || inFlight) {
      send({ type: "result", id, error: "BUSY_OR_INVALID" }); return;
    }
    roomWork = (async () => {
      if (message.type === "room-close") {
        if (message.roomId !== undefined) {
          if (typeof message.roomId !== "string" || !/^[A-Za-z0-9_-]{6,80}$/.test(message.roomId))
            throw new Error("Room selection invalid.");
          await roomHost?.closeRoom(message.roomId);
        } else {
          await roomHost?.close(); roomHost = undefined; roomHostPolicy = undefined;
        }
        send({ type: "result", id, result: { closed: true } }); return;
      }
      if (message.type === "room-name-check") {
        if (typeof message.name !== "string" || nativeRoomName(message.name) !== message.name)
          throw new Error("Room name is invalid.");
        const context = await host!.roomContext!();
        await context.assertAuthority();
        assertNativeRoomNameAvailable(context.storage, message.name);
        send({ type: "result", id, result: { available: true } }); return;
      }
      if (typeof message.roomId !== "string" || !/^[A-Za-z0-9_-]{6,80}$/.test(message.roomId))
        throw new Error("Room selection invalid.");
      const recoveryArchive = roomRecovery?.archives.find(item => item.roomId === message.roomId);
      const recoveryNative = roomRecovery?.natives.find(item => item.roomId === message.roomId);
      if (roomRecovery && message.type !== "room-create" && !recoveryArchive && !recoveryNative)
        throw new Error("Recovery is restricted to independently pinned Rooms.");
      const context = await host!.roomContext!();
      await context.assertAuthority();
      if (message.type === "room-create") {
        const binding = message.binding as { root: string; workspaceId: string; actorId: string; roomId: string;
          sourceFingerprint: string; operation: "reopen" };
        if (!binding || binding.root !== context.storage.workspaceRoot() || binding.workspaceId !== host!.workspaceId
          || binding.actorId !== context.actorId || binding.operation !== "reopen" || binding.roomId !== message.roomId
          || !/^[a-f0-9]{64}$/.test(binding.sourceFingerprint) || typeof message.name !== "string"
          || nativeRoomName(message.name) !== message.name || typeof message.expectedHostHash !== "string"
          || !/^[a-f0-9]{64}$/.test(message.expectedHostHash)
          || typeof message.session !== "string" || !/^[a-f0-9-]{36}$/.test(message.session)
          || recoveryArchive || recoveryNative && (recoveryNative.sourceFingerprint !== binding.sourceFingerprint
            || recoveryNative.name !== message.name || recoveryNative.hostCredentialHash !== message.expectedHostHash))
          throw new Error("Native Room creation binding denied.");
        const bridge = attachLegacyChatroomHostIpc({ binding, session: message.session, onRevoked() {} });
        try {
          if (!await bridge.authorizeActor(binding) || !await bridge.credentials.verifyHost(binding.roomId, message.expectedHostHash))
            throw new Error("Native Room Host authorization denied.");
          const credentials = await bridge.credentials.load(binding.roomId);
          if (!credentials || credentials.hostCredentialHash !== message.expectedHostHash
            || createHash("sha256").update(credentials.hostCredential).digest("hex") !== message.expectedHostHash
            || createHash("sha256").update(credentials.joinSecret).digest("hex") !== credentials.joinSecretHash)
            throw new Error("Native Room credentials changed.");
          await context.assertAuthority();
          if (!await bridge.authorizeActor(binding)) throw new Error("Native Room authorization changed.");
          createNativeRoom(context.storage, { roomId: binding.roomId, name: message.name,
            sourceFingerprint: binding.sourceFingerprint, hostCredentialHash: message.expectedHostHash,
            joinSecretHash: credentials.joinSecretHash });
          if (roomRecovery && !recoveryNative) roomRecovery.natives.push({ roomId: binding.roomId,
            sourceFingerprint: binding.sourceFingerprint, name: message.name, hostCredentialHash: message.expectedHostHash });
        } finally { bridge.close(); }
        send({ type: "result", id, result: { created: true } }); return;
      }
      if (message.type === "room-import-private") {
        if (!privateLegacyRoot || typeof message.source !== "string") throw new Error("Private Room source unavailable.");
        const sourceFingerprint = copyPrivateRoomArchive(context.storage, message.source, privateLegacyRoot, message.roomId);
        await context.assertAuthority();
        send({ type: "result", id, result: { roomId: message.roomId, sourceFingerprint } }); return;
      }
      const root = context.storage.workspaceRoot();
      const native = inspectNativeRoom(context.storage, message.roomId);
      const archive = native ? undefined : inspectLegacyChatroomArchive(root, message.roomId);
      const sourceFingerprint = native?.sourceFingerprint ?? archive!.sourceFingerprint;
      if (recoveryArchive && sourceFingerprint !== recoveryArchive.sourceFingerprint
        || recoveryNative && (sourceFingerprint !== recoveryNative.sourceFingerprint || native?.name !== recoveryNative.name
          || native.hostCredentialHash !== recoveryNative.hostCredentialHash))
        throw new Error("Room recovery archive changed.");
      const binding = { root, workspaceId: host!.workspaceId, actorId: context.actorId, roomId: message.roomId,
        sourceFingerprint, operation: "reopen" as const };
      if (message.type === "room-inspect") {
        send({ type: "result", id, result: binding }); return;
      }
      if (JSON.stringify(message.binding) !== JSON.stringify(binding)
        || typeof message.session !== "string" || !/^[a-f0-9-]{36}$/.test(message.session)
        || !["proof-required", "new-identity", "host-approval"].includes(String(message.legacyReconnect))
        || message.port !== undefined && (typeof message.port !== "number" || !Number.isInteger(message.port)
          || message.port < 0 || message.port > 65535))
        throw new Error("Room host binding changed.");
      if (roomHost) {
        if (!roomHostPolicy || message.legacyReconnect !== roomHostPolicy.legacyReconnect
          || message.port !== roomHostPolicy.port) throw new Error("All Rooms on this Hub use the same reconnect policy and port.");
        const opened = await roomHost.addRoom(binding, message.session);
        if (closing) { await roomHost.closeRoom(message.roomId); throw new Error("Room host is shutting down."); }
        send({ type: "result", id, result: opened }); return;
      }
      const retained = createRequire(import.meta.url)("./legacy-chatroom-retained.cjs");
      const candidate = await createVscodeLegacyChatroomHost({ storage: context.storage, binding,
        session: message.session, retained, expectedActorId: context.actorId, assertAuthority: context.assertAuthority,
        network: { bindAddress: "127.0.0.1", advertisedHost: "127.0.0.1", port: typeof message.port === "number" ? message.port : 0 },
        legacyReconnect: message.legacyReconnect as "proof-required" | "new-identity" | "host-approval" });
      try {
        const opened = await candidate.reopen(message.roomId);
        if (closing) throw new Error("Room host is shutting down.");
        roomHost = candidate;
        roomHostPolicy = { legacyReconnect: String(message.legacyReconnect), port: Number(new URL(opened.url).port) };
        send({ type: "result", id, result: opened });
      } catch (error) { await candidate.close(); throw error; }
    })().catch(error => {
      send({ type: "result", id, error: "ROOM_UNAVAILABLE",
        message: error instanceof Error ? error.message.slice(0, 512) : "Room unavailable." });
    }).finally(() => { roomWork = undefined; });
    return;
  }
  if (message.type === "environment-command-revalidated" && typeof message.challengeId === "string") {
    const resolveApproval = environmentChallenges.get(message.challengeId);
    if (resolveApproval) { environmentChallenges.delete(message.challengeId); resolveApproval(message.approved === true); }
    return;
  }
  if (message.type === "environment-command") {
    const parsed = localEnvironmentCommandSchema.safeParse(message.grant);
    if (!host || !pythonWorkspaceRoot || closing || environmentWork || !parsed.success
      || typeof message.id !== "string" || !/^[a-f0-9-]{36}$/.test(message.id)
      || typeof message.approvalId !== "string" || !/^[a-f0-9-]{36}$/.test(message.approvalId)
      || Buffer.byteLength(JSON.stringify(message)) > 65_536
      || Object.keys(message).some(key => !["type", "id", "approvalId", "grant"].includes(key))) {
      send({ type: "result", id: message.id, error: "BUSY_OR_INVALID" }); return;
    }
    const root = pythonWorkspaceRoot, workspaceId = host.workspaceId, grant = parsed.data;
    const assertWorkspace = async () => {
      if (closing || (await realDirectory(root.path)).pin !== root.pin
        || JSON.parse(await readFile(join(root.path, ".pkm-next-workspace"), "utf8")).id !== workspaceId)
        throw new Error("Environment workspace changed.");
      verifyLocalJournal(grant.journal, workspaceId);
      if (overlap(grant.journal.directory, root.path) || overlap(root.path, grant.journal.directory)
        || overlap(grant.journal.directory, dirname(cli)) || overlap(dirname(cli), grant.journal.directory))
        throw new Error("Environment journal overlaps a workspace or installed runtime.");
    };
    environmentWork = Promise.resolve().then(async () => {
      await assertWorkspace();
      const approved = await new Promise<boolean>(resolveApproval => {
        const challengeId = randomUUID();
        const timer = setTimeout(() => { environmentChallenges.delete(challengeId); resolveApproval(false); }, 5000);
        environmentChallenges.set(challengeId, approved => { clearTimeout(timer); resolveApproval(approved && !closing); });
        send({ type: "environment-command-revalidate", approvalId: message.approvalId, challengeId,
          grantSha256: createHash("sha256").update(JSON.stringify(message.grant)).digest("hex") });
      });
      if (!approved) throw new Error("Native environment command approval rejected; reselect.");
      await assertWorkspace();
      if (grant.operation === "open") {
        if (environmentService) {
          if (environmentJournal !== grant.journal.directory) throw new Error("Close this trial before opening another journal.");
        } else {
          environmentService = new HostLocalEnvironmentWorkflow(grant.journal, root.path, grant.recover);
          environmentJournal = grant.journal.directory;
        }
        return environmentService.status();
      }
      if (!environmentService || environmentJournal !== grant.journal.directory) throw new Error("Open the approved native environment journal first.");
      if (grant.operation === "start") return environmentService.start(grant.runtime, grant.parameters);
      if (grant.operation === "start-python") {
        if (grant.program.source.kind !== "inline" || !grant.program.sourceFile || grant.program.cwd !== root.path)
          throw new Error("Private reviewed-file Workflow only; Recipe requires its real native resolver and independent approval.");
        return environmentService.startPython(grant.program);
      }
      if (grant.operation === "cancel") return environmentService.cancel(grant.runId);
      return environmentService.status();
    }).then(result => send({ type: "result", id: message.id, result }),
      error => send({ type: "result", id: message.id, error: "BUSY_OR_INVALID",
        message: error instanceof Error ? error.message : "Native environment command rejected; no automatic retry." }))
      .finally(() => { environmentWork = undefined; });
    return;
  }
  if (message.type === "python-trial-revalidated" && typeof message.challengeId === "string") {
    const resolveApproval = pythonChallenges.get(message.challengeId);
    if (resolveApproval) { pythonChallenges.delete(message.challengeId); resolveApproval(message.approved === true); }
    return;
  }
  if (message.type === "python-trial") {
    if (!host || !pythonWorkspaceRoot || closing || pythonWork || typeof message.id !== "string"
      || !/^[a-f0-9-]{36}$/.test(message.id)
      || typeof message.approvalId !== "string" || !/^[a-f0-9-]{36}$/.test(message.approvalId)
      || Buffer.byteLength(JSON.stringify(message)) > 16_384
      || Object.keys(message).some(key => !["type", "id", "approvalId", "handle"].includes(key))) {
      send({ type: "result", id: message.id, error: "BUSY_OR_INVALID" }); return;
    }
    const workspaceId = host.workspaceId, root = pythonWorkspaceRoot;
    const assertPythonWorkspace = async () => {
      if ((await realDirectory(root.path)).pin !== root.pin
        || JSON.parse(await readFile(join(root.path, ".pkm-next-workspace"), "utf8")).id !== workspaceId)
        throw new Error("Python trial workspace identity changed.");
    };
    pythonWork = Promise.resolve().then(async () => {
      await assertPythonWorkspace();
      return runHostPythonWorkflow({
        handle: message.handle, workspaceId, actorId: "local:owner", workspaceRoot: root.path,
        script: PYTHON_TRIAL_SCRIPT, signal: pythonShutdown.signal,
        approve: async () => {
          await assertPythonWorkspace();
          const approved = await new Promise<boolean>(resolveApproval => {
            const challengeId = randomUUID();
            const timer = setTimeout(() => { pythonChallenges.delete(challengeId); resolveApproval(false); }, 5000);
            pythonChallenges.set(challengeId, approved => { clearTimeout(timer); resolveApproval(approved && !closing); });
            send({ type: "python-trial-revalidate", approvalId: message.approvalId, challengeId,
              handleSha256: createHash("sha256").update(JSON.stringify(message.handle)).digest("hex") });
          });
          await assertPythonWorkspace();
          return approved;
        },
      });
    }).then(result => send({ type: "result", id: message.id, result }),
      () => send({ type: "result", id: message.id, error: "BUSY_OR_INVALID",
        message: "Python host mapping/approval rejected. Select the registered environment again; no automatic retry." }))
      .finally(() => { pythonWork = undefined; });
    return;
  }
  if (message.type === "memory-scope-approval-result" && typeof message.approvalId === "string") {
    const resolveApproval = memoryApprovals.get(message.approvalId);
    if (resolveApproval) {
      memoryApprovals.delete(message.approvalId);
      const approval = message.approval;
      if (approval && typeof approval === "object" && !Array.isArray(approval)) {
        const value = approval as Record<string, unknown>;
        resolveApproval(typeof value.actorId === "string" && typeof value.decisionId === "string"
          && typeof value.expiresAtMs === "number" ? {
            actorId: value.actorId, decisionId: value.decisionId, expiresAtMs: value.expiresAtMs,
          } : null);
      } else resolveApproval(null);
    }
    return;
  }
  if (message.type === "start-memory-readoption" && !booting && !closing) {
    booting = true;
    startup = (async () => {
      if (process.platform !== "linux") throw new Error("Linux isolated trial is required.");
      const directory = await realDirectory(message.directory), legacy = await realDirectory(message.legacyRoot);
      if (overlap(directory.path, legacy.path) || overlap(legacy.path, directory.path)
        || overlap(directory.path, dirname(cli)) || overlap(dirname(cli), directory.path))
        throw new Error("Memory trial must not overlap the current root or installed server.");
      memoryRoot = directory.path;
      const pin = inspectMemoryHostPin(memoryRoot);
      const assertEvidence = async () => {
        if (JSON.stringify(inspectMemoryHostPin(directory.path)) !== JSON.stringify(pin))
          throw new Error("Imported Memory changed since read-only opening.");
      };
      host = bindImportedReadOnlyHost(directory.path, pin.workspaceId, assertEvidence);
      importedReader = true;
      if (!closing) send({ type: "ready", workspaceId: pin.workspaceId, readOnly: true, memoryReadoption: true });
    })();
    void startup.catch(error => {
      send({ type: "startup-error", message: error instanceof Error ? error.message : "Memory reopening failed." });
      process.exitCode = 1; void close();
    });
    return;
  }
  if (message.type === "start-import-write" && !booting && !closing) {
    booting = true;
    startup = (async () => {
      if (process.platform !== "linux" || message.acknowledgeIsolatedExperiment !== true
        || typeof message.capability !== "string") throw new Error("Explicit isolated experiment acknowledgment required.");
      const parent = await realDirectory(message.parent);
      if (overlap(parent.path, dirname(cli)) || overlap(dirname(cli), parent.path)) throw new Error("Experiment overlaps server.");
      const opened = await openImportedExperiment({ parent: parent.path, capability: message.capability });
      host = opened.host;
      memoryRoot = join(parent.path, "workspace"); memoryLive = true;
      if (!closing) send({ type: "ready", workspaceId: host.workspaceId, readOnly: false,
        scope: "isolated_experiment", writerCoverage: experimentCoverage });
    })();
    void startup.catch(error => {
      send({ type: "startup-error", message: error instanceof Error ? error.message.slice(0, 4096) : "Experiment restart rejected." });
      process.exitCode = 1; void close();
    });
    return;
  }
  if (["prepare-memory-readoption", "readopt-memory"].includes(String(message.type))) {
    const id = message.id;
    if (typeof id !== "string" || !/^[a-f0-9-]{36}$/i.test(id)) return;
    if (!host || !memoryRoot || closing || migrationBusy || inFlight) {
      send({ type: "result", id, error: "BUSY_OR_INVALID" }); return;
    }
    migrationBusy = true;
    migrationWork = (async () => {
      try {
        const pin = inspectMemoryHostPin(memoryRoot!, memoryLive);
        if (message.type === "prepare-memory-readoption") {
          send({ type: "result", id, result: { target: memoryRoot, pin } });
        } else {
          const expected = memoryHostPinSchema.parse(message.pin);
          if (JSON.stringify(pin) !== JSON.stringify(expected)) throw new Error("Independent host pin does not match imported Memory.");
          const { schema: _schema, receiptStateSha256, ...identity } = pin;
          const request: MemoryScopeContinuityRequest = { schema: "pkm.memory-scope-continuity/v2", ...identity };
          const approval = await requestMemoryApproval(Object.freeze(request), memoryRoot!, receiptStateSha256);
          if (closing || !approval || approval.actorId !== pin.actorId || approval.expiresAtMs <= Date.now()
            || approval.expiresAtMs > Date.now() + 15 * 60_000
            || JSON.stringify(inspectMemoryHostPin(memoryRoot!, memoryLive)) !== JSON.stringify(pin))
            throw new Error("Fresh exact host Memory approval is missing, expired or changed.");
          activateReadoptedMemoryScope(memoryRoot!, request, approval);
          memoryApproval = approval; memorySessionPin = pin;
          send({ type: "result", id, result: { workspaceId: pin.workspaceId, scope: pin.scope, expiresAtMs: approval.expiresAtMs } });
        }
      } catch (error) {
        send({ type: "result", id, error: "NOT_AVAILABLE",
          message: error instanceof Error ? error.message.slice(0, 4096) : "Memory admission unavailable." });
      } finally { migrationBusy = false; }
    })();
    return;
  }
  if (message.type === "start-import" && !booting && !closing) {
    booting = true;
    startup = (async () => {
      if (process.platform !== "linux" || message.acknowledge !== true) throw new Error("Linux and explicit disposable-copy acknowledgment required.");
      const source = await realDirectory(message.source), parent = await realDirectory(message.parent), legacy = await realDirectory(message.legacyRoot);
      if (overlap(source.path, parent.path) || overlap(parent.path, source.path)
        || overlap(legacy.path, source.path) || overlap(source.path, legacy.path)
        || overlap(legacy.path, parent.path) || overlap(parent.path, legacy.path)
        || overlap(parent.path, dirname(cli)) || overlap(dirname(cli), parent.path)
        || overlap(source.path, dirname(cli)) || overlap(dirname(cli), source.path))
        throw new Error("Migration roots must not overlap.");
      const parentStat = await lstat(parent.path);
      if (parentStat.uid !== process.getuid?.() || (parentStat.mode & 0o077) !== 0 || (await readdir(parent.path)).length)
        throw new Error("Migration parent must be empty and private.");
      const python = message.python;
      if (typeof python !== "string" || !isAbsolute(python) || resolve(python) !== python || await realpath(python) !== python
        || !(await lstat(python)).isFile()) throw new Error("Python must be an absolute canonical executable.");
      await access(python, constants.X_OK);
      migration = { source: source.path, parent: parent.path, target: join(parent.path, "workspace"), python, legacyRoot: legacy.path,
        ...(typeof message.memoryEngine === "string" ? { memoryEngine: message.memoryEngine, memoryActorId: "local:owner" } : {}),
        sourcePin: source.pin, parentPin: parent.pin, legacyPin: legacy.pin, planSha256: "", fingerprint: "", attempted: false };
      const result = await runCli("import-plan", ["--source", source.path, ack,
        ...(migration.memoryEngine ? ["--memory-engine", migration.memoryEngine, "--memory-actor-id", "local:owner"] : [])]);
      const plan = result.value?.plan;
      if (!plan || plan.sourceRoot !== source.path || typeof plan.ready !== "boolean" || !/^[a-f0-9]{64}$/.test(plan.planSha256)
        || !Array.isArray(plan.blockers) || plan.ready && (result.code !== 0 || !/^[a-f0-9]{64}$/.test(plan.fingerprint) || plan.blockers.length)
        || !plan.ready && result.code === 0) throw new Error("Invalid migration plan.");
      await migrationCheck(true);
      migration.planSha256 = plan.planSha256;
      migration.fingerprint = plan.ready ? plan.fingerprint : "";
      approvedPlan = legacyImportPlanSchema.parse(plan);
      migrationPlanned = true;
      if (!closing) send({ type: "import-plan", ready: plan.ready, planSha256: plan.planSha256,
        fingerprint: plan.fingerprint, blockers: plan.blockers, target: migration.target,
        ...(plan.memoryPlan ? { memoryPlan: plan.memoryPlan } : {}) });
    })();
    void startup.catch(error => { send({ type: "startup-error", message: error instanceof Error ? error.message : "Migration planning failed." }); process.exitCode = 1; void close(); });
    return;
  }
  if (message.type === "start-room-recovery" && !booting && !closing) {
    booting = true;
    startup = (async () => {
      const pin = message.pin as typeof roomRecovery & { schema?: unknown; origin?: unknown; nativeName?: unknown; hostCredentialHash?: unknown };
      if (!pin || pin.schema !== "pkm.next-isolated-room-recovery/v1"
        || typeof pin.parent !== "string" || typeof pin.legacyRoot !== "string" || pin.legacyRoot !== message.legacyRoot
        || typeof pin.parentIdentity !== "string" || typeof pin.workspaceIdentity !== "string"
        || typeof pin.databaseIdentity !== "string" || typeof pin.markerIdentity !== "string" || typeof pin.legacyIdentity !== "string"
        || typeof pin.workspaceId !== "string" || !/^[a-f0-9-]{36}$/.test(pin.workspaceId)
        || typeof pin.roomId !== "string" || !/^[A-Za-z0-9_-]{6,80}$/.test(pin.roomId)
        || typeof pin.sourceFingerprint !== "string" || !/^[a-f0-9]{64}$/.test(pin.sourceFingerprint))
        throw new Error("Invalid Room recovery pin.");
      const archives = message.archives === undefined
        ? [{ roomId: pin.roomId, sourceFingerprint: pin.sourceFingerprint }]
        : message.archives as { roomId: string; sourceFingerprint: string }[];
      const natives = message.natives === undefined ? [] : message.natives as NonNullable<typeof roomRecovery>["natives"];
      if (!Array.isArray(archives) || !Array.isArray(natives) || archives.length + natives.length < 1
        || archives.length + natives.length > 128
        || archives.some(item => !item || typeof item.roomId !== "string" || !/^[A-Za-z0-9_-]{6,80}$/.test(item.roomId)
          || typeof item.sourceFingerprint !== "string" || !/^[a-f0-9]{64}$/.test(item.sourceFingerprint))
        || natives.some(item => !item || typeof item.roomId !== "string" || !/^[A-Za-z0-9_-]{6,80}$/.test(item.roomId)
          || typeof item.sourceFingerprint !== "string" || !/^[a-f0-9]{64}$/.test(item.sourceFingerprint)
          || typeof item.name !== "string" || nativeRoomName(item.name) !== item.name
          || typeof item.hostCredentialHash !== "string" || !/^[a-f0-9]{64}$/.test(item.hostCredentialHash))
        || new Set([...archives, ...natives].map(item => item.roomId)).size !== archives.length + natives.length
        || ![...archives, ...natives].some(item => item.roomId === pin.roomId && item.sourceFingerprint === pin.sourceFingerprint)
        || pin.origin === "native" && !natives.some(item => item.roomId === pin.roomId
          && item.name === pin.nativeName && item.hostCredentialHash === pin.hostCredentialHash)
        || pin.origin !== undefined && pin.origin !== "native")
        throw new Error("Invalid Room recovery archive inventory.");
      roomRecovery = { ...pin, archives, natives };
      await assertRoomRecovery();
      const root = join(pin.parent, "workspace");
      for (const archive of archives)
        if (inspectLegacyChatroomArchive(root, archive.roomId).sourceFingerprint !== archive.sourceFingerprint)
          throw new Error("Room recovery archive changed.");
      const storage = await Storage.openPrivateRoomRecovery(root, archives);
      try {
        await assertRoomRecovery();
        if (await storage.workspaceId() !== pin.workspaceId) throw new Error("Room recovery workspace changed.");
        for (const item of natives) {
          const current = inspectNativeRoom(storage, item.roomId);
          if (current && (current.sourceFingerprint !== item.sourceFingerprint || current.name !== item.name
            || current.hostCredentialHash !== item.hostCredentialHash)) throw new Error("Native Room recovery definition changed.");
        }
        let closed = false;
        const assertAuthority = async () => {
          if (closed || closing) throw new Error("Room recovery authority revoked.");
          await assertRoomRecovery();
          storage.assertWorkspaceLease();
        };
        host = {
          workspaceId: pin.workspaceId,
          writerCoverage: { inProcessCalls: "tracked", external: "unknown", cutoverAuthorized: false },
          async roomContext() { await assertAuthority(); return { storage, actorId: "local:owner", assertAuthority }; },
          async invoke() { throw new Error("Room-only recovery cannot invoke workspace operations."); },
          async close() { closed = true; await storage.close(); },
        };
        if (!closing && process.connected) send({ type: "ready", workspaceId: pin.workspaceId, roomOnly: true });
      } catch (error) { await storage.close(); throw error; }
    })();
    void startup.catch(error => {
      send({ type: "startup-error", message: error instanceof Error ? error.message : "Room recovery failed." });
      process.exitCode = 1; void close();
    });
    return;
  }
  if (message.type === "start-selected-chat-recovery" && !booting && !closing) {
    booting = true;
    startup = (async () => {
      const pin = message.pin as SelectedChatRecoveryPin;
      if (typeof message.legacyRoot !== "string") throw new Error("Selected Chat Knowledge Root is required.");
      assertSelectedChatRecovery(pin, message.legacyRoot);
      const data = join(pin.parent, "workspace"), configPath = join(pin.parent, "control/host.json");
      privateLegacyRoot = pin.legacyRoot;
      selectedChatRecovery = pin;
      const started = await startManagedClientHost({
        optIn: true, dataPath: data, configPath, expectedWorkspaceId: pin.workspaceId,
        policy: { authorizedConfigPath: configPath, allowedProviders: ["openai-compatible"],
          allowedEndpoints: [endpoint], allowedModels: ["disabled"], allowedTools: ["knowledge.document.create"], allowInsecureLoopback: true },
        resolveSecret: async () => undefined,
      });
      host = started;
      assertSelectedChatRecovery(pin, message.legacyRoot);
      pythonWorkspaceRoot = await realDirectory(data);
      if (!closing && process.connected) send({ type: "ready", workspaceId: pin.workspaceId, selectedChatOnly: true });
    })();
    void startup.catch(error => {
      send({ type: "startup-error", message: error instanceof Error ? error.message : "Selected Chat recovery failed." });
      process.exitCode = 1; void close();
    });
    return;
  }
  if (message.type === "start-recipe-recovery" && !booting && !closing) {
    booting = true;
    startup = (async () => {
      const pin = message.pin as Record<string, unknown> | undefined;
      if (!pin || pin.schema !== "pkm.next-recipe-workspace/v1" || typeof pin.parent !== "string"
        || typeof pin.workspaceId !== "string" || !/^[a-f0-9-]{36}$/.test(pin.workspaceId)
        || Object.keys(pin).sort().join(",") !== "databaseIdentity,markerIdentity,parent,parentIdentity,schema,workspaceId,workspaceIdentity")
        throw new Error("Independent Recipe workspace pin required.");
      const parent = await realDirectory(pin.parent), data = join(parent.path, "workspace");
      if (typeof message.legacyRoot === "string" && message.legacyRoot) {
        const legacy = await realDirectory(message.legacyRoot);
        if (overlap(legacy.path, parent.path) || overlap(parent.path, legacy.path)) throw new Error("Recipe recovery overlaps the legacy root.");
        privateLegacyRoot = legacy.path;
      }
      const check = async () => {
        const directory = await realDirectory(data), parentStat = await lstat(parent.path);
        const database = await lstat(coreDatabasePath(data), { bigint: true });
        const marker = await lstat(join(data, ".pkm-next-workspace"), { bigint: true });
        if ((await realDirectory(parent.path)).pin !== pin.parentIdentity || directory.pin !== pin.workspaceIdentity
          || parentStat.uid !== process.getuid?.() || parentStat.mode & 0o077
          || !database.isFile() || database.isSymbolicLink() || database.nlink !== 1n
          || !marker.isFile() || marker.isSymbolicLink() || marker.nlink !== 1n
          || `${database.dev}:${database.ino}` !== pin.databaseIdentity || `${marker.dev}:${marker.ino}` !== pin.markerIdentity
          || JSON.parse(await readFile(join(data, ".pkm-next-workspace"), "utf8")).id !== pin.workspaceId)
          throw new Error("Recipe workspace identity changed; no adoption or repair is performed.");
      };
      await check();
      const configPath = join(parent.path, "control/host.json");
      const started = await startManagedClientHost({
        optIn: true, dataPath: data, configPath, expectedWorkspaceId: pin.workspaceId,
        legacyRecipes: managedRecipePolicy(data, pin.workspaceId, recipeIpc.review),
        policy: { authorizedConfigPath: configPath, allowedProviders: ["openai-compatible"],
          allowedEndpoints: [endpoint], allowedModels: ["disabled"], allowedTools: ["knowledge.document.create"], allowInsecureLoopback: true },
        resolveSecret: async () => undefined,
      });
      host = started;
      await check();
      pythonWorkspaceRoot = await realDirectory(data);
      if (!closing && process.connected) send({ type: "ready", workspaceId: pin.workspaceId, recipeRecovery: true });
    })();
    void startup.catch(error => {
      send({ type: "startup-error", message: error instanceof Error ? error.message : "Recipe recovery failed." });
      process.exitCode = 1; void close();
    });
    return;
  }
  if (message.type === "start" && !booting && !closing) {
    booting = true;
    startup = (async () => {
      const root = message.directory;
      if (typeof root !== "string" || !isAbsolute(root) || resolve(root) !== root
        || await realpath(root) !== root || (await readdir(root)).length) throw new Error("Invalid empty directory.");
      if (typeof message.legacyRoot === "string" && message.legacyRoot) {
        const legacy = await realDirectory(message.legacyRoot);
        if (overlap(legacy.path, root) || overlap(root, legacy.path)) throw new Error("Legacy root overlaps the trial.");
        privateLegacyRoot = legacy.path;
      }
      const control = join(root, "control"), data = join(root, "workspace");
      await mkdir(control, { mode: 0o700 });
      await initialize(data);
      const { id } = JSON.parse(await readFile(join(data, ".pkm-next-workspace"), "utf8"));
      const configPath = join(control, "host.json");
      await writeFile(configPath, JSON.stringify({
        schema: "pkm.native-host-config/v1", provider: "openai-compatible", endpoint,
        secretRef: "secret:disabled/provider", model: "disabled", contextWindow: 16384, maxOutputTokens: 4096,
        outputTokenParameter: "max_tokens", includeUsage: true, tools: ["knowledge.document.create"],
      }), { flag: "wx", mode: 0o600 });
      const started = await startManagedClientHost({
        optIn: true, dataPath: data, configPath, expectedWorkspaceId: id,
        legacyRecipes: managedRecipePolicy(data, id, recipeIpc.review),
        policy: { authorizedConfigPath: configPath, allowedProviders: ["openai-compatible"],
          allowedEndpoints: [endpoint], allowedModels: ["disabled"], allowedTools: ["knowledge.document.create"], allowInsecureLoopback: true },
        resolveSecret: async () => undefined,
      });
      host = started;
      pythonWorkspaceRoot = await realDirectory(data);
      if (!closing && process.connected) send({ type: "ready", workspaceId: id });
    })();
    void startup.catch(error => {
      send({ type: "startup-error", message: error instanceof Error ? error.message.slice(0, 4096) : "Native workspace startup failed." });
      process.exitCode = 1;
      void close();
    });
    return;
  }
  if (["prepare-import-write", "enable-import-write"].includes(String(message.type))) {
    const id = message.id;
    if (typeof id !== "string" || !/^[a-f0-9-]{36}$/i.test(id)) return;
    if (closing || !host || !importedReader || !migration || !importedAudit || migrationBusy || writeAttempted || inFlight) {
      send({ type: "result", id, error: "BUSY_OR_INVALID" }); return;
    }
    migrationBusy = true;
    migrationWork = (async () => {
      try {
        await migrationCheck(false);
        await importedAudit!.assertUnchanged();
        if (message.type === "prepare-import-write") {
          const digest = createHash("sha256").update(JSON.stringify({ operationId: randomUUID(), target: migration!.target,
            workspaceId: host!.workspaceId, planSha256: migration!.planSha256, scope: "isolated_experiment" })).digest("hex");
          writePreparation = { digest, workspaceId: host!.workspaceId };
          send({ type: "result", id, result: { workspaceId: host!.workspaceId, target: migration!.target,
            planSha256: migration!.planSha256, authorizationDigest: digest, scope: "isolated_experiment",
            writerCoverage: experimentCoverage, blockers: [] } });
        } else {
          if (!writePreparation || message.authorizationDigest !== writePreparation.digest
            || message.confirmTarget !== migration!.target || message.acknowledgeIsolatedExperiment !== true)
            throw new Error("Exact target, current authorization digest and isolated experiment acknowledgment required.");
          writeAttempted = true;
          await host!.close();
          const opened = await openImportedExperiment({ parent: migration!.parent,
            initial: { workspaceId: writePreparation.workspaceId, planSha256: migration!.planSha256,
              source: migration!.source, legacyRoot: migration!.legacyRoot,
              assertUnchanged: importedAudit!.assertUnchanged } });
          host = opened.host;
          memoryRoot = migration!.target; memoryLive = true;
          importedReader = false;
          send({ type: "result", id, result: { workspaceId: host.workspaceId, readOnly: false,
            scope: "isolated_experiment", writerCoverage: experimentCoverage,
            credential: { parent: migration!.parent, capability: opened.capability } } });
        }
      } catch (error) {
        send({ type: "result", id, error: writeAttempted ? "OUTCOME_UNKNOWN" : "BUSY_OR_INVALID",
          message: error instanceof Error ? error.message.slice(0, 4096) : "Experiment authorization failed." });
      } finally { migrationBusy = false; }
    })();
    return;
  }
  if (["select-memory-scope", "confirm-import", "import-status", "attach-import"].includes(String(message.type))) {
    const id = message.id;
    if (typeof id !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(id)) return;
    if (closing || !migration || !migrationPlanned || migrationBusy || host) { send({ type: "result", id, error: "BUSY_OR_INVALID" }); return; }
    const state = migration;
    if (message.type === "confirm-import" && (state.attempted || !state.fingerprint || message.planSha256 !== state.planSha256)
      || message.type === "attach-import" && !state.receipt) {
      send({ type: "result", id, error: "BUSY_OR_INVALID" }); return;
    }
    migrationBusy = true;
    migrationWork = (async () => {
      try {
        await migrationCheck(message.type === "confirm-import");
        if (message.type === "select-memory-scope") {
          if (state.attempted || !approvedPlan?.memoryPlan || typeof message.sourceScopeSha256 !== "string"
            || !approvedPlan.memoryPlan.scopes.some(scope => createHash("sha256").update(scope).digest("hex") === message.sourceScopeSha256))
            throw new Error("Scope is not in the original pinned snapshot.");
          const { planLegacyImport } = await import("./legacy-import.js");
          const plan = await planLegacyImport(state.source, {}, {
            memoryEngine: state.memoryEngine, memoryActorId: "local:owner",
            memoryContinuityScopeSha256: message.sourceScopeSha256,
          });
          if (!plan.ready || plan.memoryPlan?.sourceSha256 !== approvedPlan.memoryPlan.sourceSha256)
            throw new Error("Memory snapshot changed.");
          approvedPlan = plan; state.planSha256 = plan.planSha256; state.fingerprint = plan.fingerprint!;
          send({ type: "result", id, result: { plan: { ...plan, target: state.target } } });
        } else if (message.type === "confirm-import") {
          state.attempted = true;
          const result = state.memoryEngine ? { code: 0, value: { receipt: await (await import("./legacy-import.js")).importLegacyWorkspace(approvedPlan!, state.target, {
            pythonExecutable: state.python, memoryActorId: "local:owner",
            authorizeMemoryScopeContinuity: async (request: Readonly<MemoryScopeContinuityRequest>) => {
              const approval = await requestMemoryApproval(request, state.target);
              if (!closing && approval) memoryApproval = approval;
              return closing ? null : approval ?? null;
            },
          }) } } : await runCli("import", ["--source", state.source, "--destination", state.target,
            "--plan-sha256", state.planSha256, "--python", state.python, ack]);
          if (result.code !== 0 && result.value?.plan && Array.isArray(result.value.plan.blockers)) {
            send({ type: "result", id, error: "OUTCOME_UNKNOWN", blockers: result.value.plan.blockers });
            return;
          }
          const receipt = result.value?.receipt;
          if (result.code !== 0 || !receipt || receipt.destination !== state.target || receipt.fingerprint !== state.fingerprint)
            throw new Error("Import outcome unknown.");
          const outcome = await status();
          if (outcome.status !== "published" || JSON.stringify(outcome.receipt) !== JSON.stringify(receipt))
            throw new Error("Import outcome not confirmed.");
          state.receipt = receipt;
          send({ type: "result", id, result: { receipt, outcome } });
        } else if (message.type === "import-status") {
          send({ type: "result", id, result: { outcome: await status() } });
        } else {
          const outcome = await status();
          if (outcome.status !== "published" || JSON.stringify(outcome.receipt) !== JSON.stringify(state.receipt))
            throw new Error("Import binding changed.");
          const data = await realDirectory(state.target);
          const markerPath = join(data.path, ".pkm-next-workspace");
          const markerStat = await lstat(markerPath);
          if (!markerStat.isFile() || markerStat.isSymbolicLink() || markerStat.size > 4096) throw new Error("Invalid workspace marker.");
          const marker = JSON.parse(await readFile(markerPath, "utf8"));
          if (!["pkm.next-workspace/v1", "pkm.next-workspace/v2"].includes(marker.schema)
            || typeof marker.id !== "string" || !/^[a-f0-9-]{36}$/i.test(marker.id)) throw new Error("Invalid workspace identity.");
          const checked = await status();
          if (checked.status !== "published" || JSON.stringify(checked.receipt) !== JSON.stringify(state.receipt)
            || (await realDirectory(state.target)).pin !== data.pin) throw new Error("Import binding changed during attach.");
          if (!approvedPlan) throw new Error("Approved import plan is unavailable.");
          const audit = await auditImportedWorkspace(state.target, approvedPlan);
          importedAudit = audit;
          host = bindImportedReadOnlyHost(state.target, marker.id, audit.assertUnchanged);
          memoryRoot = state.target;
          if (memoryApproval) {
            activateMemoryScopeContinuity(state.target, memoryApproval);
            memorySessionPin = inspectMemoryHostPin(state.target);
          }
          importedReader = true;
          send({ type: "result", id, result: { workspaceId: marker.id, readOnly: true, audit: audit.summary } });
        }
      } catch (error) {
        send({ type: "result", id, error: state.attempted ? "OUTCOME_UNKNOWN" : "BUSY_OR_INVALID",
          message: error instanceof Error ? error.message.slice(0, 4096) : "Migration request failed." });
      } finally { migrationBusy = false; }
    })();
    return;
  }
  if (message.type === "invoke" && migrationBusy && typeof message.id === "string" && message.id.length <= 80) {
    send({ type: "result", id: message.id, error: "BUSY_OR_INVALID" }); return;
  }
  if (message.type === "invoke" && typeof message.operation === "string" && message.operation.startsWith("memory-")) {
    if (!host || !memoryApproval || !memoryRoot || !memorySessionPin || closing || typeof message.id !== "string"
      || message.id.length > 80 || inFlight >= 16 || Buffer.byteLength(JSON.stringify(message)) > 256_000
      || !["memory-get", "memory-search", "memory-audit", "memory-replay"].includes(message.operation)
      || !message.args || typeof message.args !== "object" || Array.isArray(message.args)) {
      send({ type: "result", id: message.id, error: "NOT_AVAILABLE" }); return;
    }
    inFlight++;
    const work = Promise.resolve().then(() => {
      if (JSON.stringify(inspectMemoryHostPin(memoryRoot!, memoryLive)) !== JSON.stringify(memorySessionPin))
        throw new Error("Imported Memory no longer matches the independent session pin.");
      return readManagedMemory(memoryRoot!, String(message.operation), message.args as Record<string, unknown>);
    })
      .then(result => send({ type: "result", id: message.id, result }),
        error => send({ type: "result", id: message.id, error: error?.code ?? "NOT_AVAILABLE" }))
      .finally(() => { inFlight--; memoryReads.delete(work); });
    memoryReads.add(work);
    return;
  }
  if (message.type !== "invoke" || !host || closing || typeof message.id !== "string" ||
      message.id.length > 80 || !["list", "get", "asset-list", "asset-get", "board-list", "board-get", "board-tasks", "board-stories",
        "research-list", "skill-list", "skill-get", "metadata-get", "recipe-list", "recipe-get", "library-list", "library-get", "mutation-scan",
        "note-create", "note-update", "skill-create", "skill-update", "research-create", "research-update", "create", "update"].includes(String(message.operation)) ||
      !message.args || typeof message.args !== "object" || Array.isArray(message.args)) return;
  if (importedReader && !readOnlyManagedOperations.has(String(message.operation))) {
    send({ type: "result", id: message.id, error: "BUSY_OR_INVALID" }); return;
  }
  let size: number;
  try { size = Buffer.byteLength(JSON.stringify(message)); } catch { return; }
  if (size > 256_000 || inFlight >= 16) { send({ type: "result", id: message.id, error: "BUSY_OR_INVALID" }); return; }
  inFlight++;
  void host.invoke(message.operation as ManagedDocumentOperation, message.args as Record<string, unknown>)
    .then(result => send({ type: "result", id: message.id, result }),
      error => send({ type: "result", id: message.id, error: "OUTCOME_UNKNOWN",
        ...(error instanceof Error && (importedReader || readOnlyManagedOperations.has(String(message.operation)))
          ? { message: error.message.slice(0, 4096) } : {}) }))
    .finally(() => { inFlight--; });
});
