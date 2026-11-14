import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { isAbsolute, join, relative, sep } from "node:path";
import { initialize, Storage } from "./storage.js";
import { inspectLegacyChatroomTree } from "./legacy-chatroom-continuation.js";
import { admitPrivateRoom, openPrivateRoomAdmissions, type PrivateRoomAdmissionOptions } from "./next-room-private-admission.js";
import { createNextRoomUiHub } from "./next-room-ui-hub.js";
import { resolveRoomOwner } from "./next-room-owner-directory.js";
import { roomHistoryLineage } from "./next-room-history-sync.js";

type Value = Record<string, any>;
let storage: Storage | undefined, hub: any, live = true, booting = false;
let closing: Promise<void> | undefined;
const pending = new Map<string, { resolve(value: any): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
const send = (value: Value) => { if (process.connected) process.send?.(value); };
const assert = () => {
  if (!live || !process.connected) throw new Error("Collaboration owner admission is closed.");
  storage?.assertWorkspaceLease();
};
function parent(operation: string, args: unknown[] = []): Promise<any> {
  assert();
  const id = randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error("Collaboration profile approval timed out.")); }, 120_000);
    pending.set(id, { resolve, reject, timer });
    send({ type: "callback", id, operation, args });
  });
}
const credentials = Object.fromEntries(["load", "verifyHost", "create", "replaceJoinSecret", "delete",
  "createHostProof", "verifyHostProof"].map(name => [name, (...args: unknown[]) => parent(`credentials.${name}`, args)])) as any;
const profile = { get: (key: string) => parent("profile.get", [key]),
  store: (key: string, value: string) => parent("profile.store", [key, value]) };
async function snapshot() {
  assert();
  const rooms = await hub.listStoredRooms(), meetings: Value = {};
  for (const room of rooms) {
    if (!room.hasHostAuthority) continue;
    const state = await hub.prepareStoredRoom(room.roomId);
    if (state) meetings[room.roomId] = state;
  }
  return { workspaceId: await storage!.workspaceId(), root: storage!.workspaceRoot(),
    running: hub.isRunning, port: hub.port, publicHost: hub.publicHost,
    rooms, active: hub.adminRooms(), channels: hub.portalChannelsSnapshot(), approvals: hub.pendingApprovals(), meetings };
}
async function close() {
  if (closing) return closing;
  closing = (async () => {
    try { await hub?.stop(); } finally {
      live = false;
      for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error("Collaboration owner closed.")); }
      pending.clear();
      await storage?.close();
      process.disconnect?.();
    }
  })();
  return closing;
}
const operations = new Set(["start", "stop", "createRoom", "rehostRoom", "syncRemoteRoomHistory", "syncRemoteFullRoomHistory", "takeOverFullRoom",
  "missingFilePayloads", "recoverFileBytes",
  "forceCloseRemoteRoom", "adminCloseRoom", "adminCloseAll", "renameActiveRoom", "renameStoredRoom",
  "repairStoredRoom", "rotateRoomSecret", "deleteStoredRoom", "listStoredRooms", "createPortalChannel", "closePortalChannel"]);
const meetingOperations = new Set(["startMeeting", "adjournMeeting", "recordDiscussionMessage", "moveToTrash",
  "restoreFromTrash", "permanentlyDelete", "readNote", "writeNote"]);
async function start(input: Value) {
  if (booting || storage) throw new Error("Collaboration owner already started.");
  booting = true;
  if (!isAbsolute(input.root) || !isAbsolute(input.sourceRoot)) throw new Error("Absolute configured roots are required.");
  const delta = relative(input.sourceRoot, input.root), reverse = relative(input.root, input.sourceRoot);
  const inside = (value: string) => !value || !isAbsolute(value) && value !== ".." && !value.startsWith(`..${sep}`);
  if (inside(delta) || inside(reverse)) throw new Error("Collaboration workspace must be disjoint from the original root.");
  const admission: PrivateRoomAdmissionOptions = { profile, credentials, sourcePrivate: false, assertAuthority: assert,
    authorize: binding => parent("authorize", [binding]) };
  if (existsSync(join(input.root, ".pkm-room-admission"))) {
    storage = await openPrivateRoomAdmissions({ ...admission, root: input.root });
  } else {
    if (!existsSync(join(input.root, ".pkm-next-workspace"))) {
      if (input.bootstrap !== true) throw new Error("Previously selected Collaboration workspace is missing; no replacement was created.");
      await initialize(input.root);
    }
    storage = await Storage.open(input.root, { deferRecovery: true });
  }
  if (input.bootstrap === true) {
    const rooms = existsSync(join(input.sourceRoot, "chatrooms")) ? inspectLegacyChatroomTree(input.sourceRoot) : [];
    for (const room of rooms) {
      if (!await credentials.load(room.roomId)) throw new Error("Original Host credentials are unavailable; original routing is unchanged.");
      await admitPrivateRoom({ ...admission, storage, sourceRoot: input.sourceRoot, roomId: room.roomId });
    }
  }
  const workspaceId = await storage.workspaceId();
  if (input.workspaceId && input.workspaceId !== workspaceId) throw new Error("Selected Collaboration workspace identity changed.");
  const retained = createRequire(import.meta.url)("./legacy-chatroom-retained.cjs");
  hub = createNextRoomUiHub({ storage, workspaceId, qualification: "new-next-workspace", assertAuthority: assert,
    credentials, retained, historyExport: true, ownerDirectory: true, fullHistory: true,
    ...(input.productCapabilities ? {
      project: { authorize: (value: Value) => parent("project.authorize", [value]) },
      portal: { legacyContext: true as const, authorize: (value: Value) => parent("portal.authorize", [value]),
        executeCommand: async () => ({ admitted: true, epoch: hub.portalAuthority.executionEpoch() }) },
    } : {}),
    chooseReconnectPolicy: endpoint => parent("chooseReconnectPolicy", [endpoint]),
    approveParticipant: request => parent("approveParticipant", [request]),
    ...(input.remoteUrl ? { remoteRooms: { synchronizeHistory: true as const, resolve: async (roomId: string) => {
      try {
        return await resolveRoomOwner({ roomId, url: input.remoteUrl, workspaceId,
          historyLineage: roomHistoryLineage(storage!, roomId), assertAuthority: assert,
          createProof: purpose => credentials.createHostProof(roomId, purpose),
          verifyProof: async (purpose, proof) => {
            const value = await credentials.load(roomId);
            return !!value && credentials.verifyHostProof(roomId, value.hostCredentialHash, purpose, proof);
          } });
      } catch { return undefined; }
    } } } : {}),
  });
  hub.onApprovalsChanged(() => { void snapshot().then(state => send({ type: "state", state })).catch(() => {}); });
  hub.onRoomDeactivating((roomId: string, reason: string) => parent("roomDeactivating", [roomId, reason]));
  return snapshot();
}
process.on("message", (input: Value) => {
  if (input?.type === "callback-result") {
    const call = pending.get(input.id);
    if (!call) return;
    pending.delete(input.id); clearTimeout(call.timer);
    input.error ? call.reject(new Error(input.error)) : call.resolve(input.result);
    return;
  }
  if (input?.type === "close") { void close().catch(() => { process.exitCode = 1; }); return; }
  if (input?.type !== "request" || typeof input.id !== "string") return;
  void (async () => {
    const args = Array.isArray(input.args) ? input.args : [];
    if (input.operation === "initialize") return { result: null, state: await start(args[0]) };
    assert();
    if (!hub || !storage) throw new Error("Collaboration owner is not ready.");
    if (input.operation === "portal.check") {
      if (!hub.portalAuthority) throw new Error("Portal owner is unavailable.");
      hub.portalAuthority.assertExecution(args[0]); return { result: true };
    }
    if (input.operation === "portal.authorize") return { result: await hub.portalAuthority?.authorize(args[0]) ?? false };
    if (input.operation === "portal.consume") {
      if (!hub.portalAuthority?.executeCommand) throw new Error("Portal execution is not admitted.");
      return { result: await hub.portalAuthority.executeCommand({ ...args[0], signal: new AbortController().signal }) };
    }
    if (input.operation === "setAdvertisedHost") { hub.setAdvertisedHost(args[0]); return { result: null, state: await snapshot() }; }
    let result: unknown;
    if (meetingOperations.has(input.operation?.replace(/^meeting\./, "")) && input.operation.startsWith("meeting.")) {
      result = await hub.meetingStore[input.operation.slice(8)](...args);
    } else {
      if (!operations.has(input.operation)) throw new Error("Unsupported Collaboration owner operation.");
      result = await hub[input.operation](...args);
    }
    return { result, state: await snapshot() };
  })().then(value => send({ type: "response", id: input.id, ...value }),
    error => send({ type: "response", id: input.id, error: error instanceof Error ? error.message : "Collaboration operation failed." }));
});
process.once("disconnect", () => { live = false; void close().catch(() => { process.exitCode = 1; }); });
process.once("SIGTERM", () => { void close().catch(() => { process.exitCode = 1; }); });
