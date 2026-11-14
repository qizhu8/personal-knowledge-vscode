import { randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { isIP } from "node:net";
import { join } from "node:path";
import type { Storage } from "./storage.js";
import { inspectLegacyChatroomArchive, inspectLegacyChatroomTree } from "./legacy-chatroom-continuation.js";
import { createLegacyChatroomHostAuthority } from "./legacy-chatroom-host-authority.js";
import { LegacyChatroomRuntime, type LegacyParticipantRebind, type LegacyRoomRuntimeOptions } from "./legacy-chatroom-runtime.js";
import { assertNativeRoomNameAvailable, createNativeRoom, inspectNativeRoom, nativeRoomName } from "./native-chatroom-identity.js";
import { rotateRoomJoinSecret } from "./next-room-secret-state.js";
import { createNextRoomMeetings, type RetainedMeetingStore } from "./next-room-meetings.js";
import { createNextRoomPortalAuthority, type NextRoomPortalExecutors } from "./next-room-portals.js";
import { assertPrivateRoomAdmissions } from "./next-room-private-admission.js";
import { roomHistoryLineage } from "./next-room-history-sync.js";
import { readRoomProject, roomProject, type RoomProject } from "./next-room-projects.js";

type Credentials = {
  hostCredential: string; hostCredentialHash: string; joinSecret: string; joinSecretHash: string;
};
type Policy = "host-approval" | "legacy-client-id";
type HostProof = { timestamp: number; nonce: string; signature: string };
export interface NextRoomRemoteHost {
  state: "active" | "released"; activeUrl: string; workspaceId: string; sourceFingerprint: string; historyLineage?: string;
}
interface Options {
  storage: Storage; workspaceId: string;
  qualification: "new-next-workspace" | "adopted-production-qualified";
  assertAuthority(): void;
  credentials: {
    load(roomId: string): Promise<Credentials | undefined>;
    verifyHost(roomId: string, hash: string): Promise<boolean>;
    create(roomId: string, secret?: string): Promise<Credentials>;
    replaceJoinSecret(roomId: string, secret: string): Promise<void>;
    delete(roomId: string): Promise<void>;
    createHostProof?(roomId: string, purpose: string): Promise<HostProof>;
    verifyHostProof?(roomId: string, hash: string, purpose: string, proof: HostProof): Promise<boolean>;
  };
  retained: LegacyRoomRuntimeOptions["retained"] & { MeetingStateStore?: RetainedMeetingStore };
  chooseReconnectPolicy(endpoint: string): Promise<Policy | undefined>;
  approveParticipant(request: LegacyParticipantRebind): Promise<boolean>;
  portal?: NextRoomPortalExecutors;
  project?: { authorize(value: RoomProject & { roomId?: string; purpose?: "host" }): Promise<boolean> };
  historyExport?: true;
  fullHistory?: true;
  ownerDirectory?: true;
  /** Trusted owner directory: report released explicitly; missing/lost contact is never confirmed release. */
  remoteRooms?: { resolve(roomId: string): Promise<NextRoomRemoteHost | undefined>; synchronizeHistory?: true };
}

/**
 * Legacy UI method surface on the already-owned workspace. This never adopts a
 * root, opens Storage or initializes a legacy archive writer.
 */
export function createNextRoomUiHub(options: Options): any {
  if (!["new-next-workspace", "adopted-production-qualified"].includes(options.qualification))
    throw new Error("Experimental adoption does not authorize the default Room UI.");
  const root = options.storage.workspaceRoot();
  let runtime: LegacyChatroomRuntime | undefined, host = "127.0.0.1", port = 0;
  let starting: Promise<void> | undefined;
  let rotating = false;
  let onApprovals: (() => void) | undefined;
  let onDeactivating: ((roomId: string, reason: string) => Promise<void> | void) | undefined;
  const assert = () => { options.assertAuthority(); options.storage.assertWorkspaceLease(); };
  const guard = async () => {
    assert();
    if (await options.storage.workspaceId() !== options.workspaceId) throw new Error("Room workspace identity changed.");
    await assertPrivateRoomAdmissions(options.storage);
    assert();
  };
  const portal = options.portal ? createNextRoomPortalAuthority({
    storage: options.storage, workspaceId: options.workspaceId, assertAuthority: assert, executors: options.portal,
  }) : undefined;
  const authority = createLegacyChatroomHostAuthority({
    storage: options.storage, actorId: "local:owner", credentials: options.credentials,
    authorizeActor: async binding => {
      await guard();
      const ownership = readRoomProject(options.storage, binding.roomId);
      return !ownership || !!await options.project?.authorize({ ...ownership, roomId: binding.roomId, purpose: "host" });
    },
  });
  const remote = async (roomId: string, sourceFingerprint: string) => {
    const value = await options.remoteRooms?.resolve(roomId);
    await guard();
    if (!value) return undefined;
    const endpoint = new URL(value.activeUrl);
    if (!["ws:", "wss:"].includes(endpoint.protocol) || endpoint.username || endpoint.password
      || endpoint.search || endpoint.hash || !["active", "released"].includes(value.state)
      || !/^[a-f0-9]{64}$/.test(value.sourceFingerprint)
      || (value.sourceFingerprint !== sourceFingerprint || value.historyLineage !== undefined)
        && value.historyLineage !== roomHistoryLineage(options.storage, roomId)
      || !/^[a-f0-9-]{36}$/.test(value.workspaceId) || value.workspaceId === options.workspaceId)
      throw new Error("Remote Room endpoint does not match the independently selected owner directory.");
    return Object.freeze({ ...value });
  };
  const authorizeHostProof = async (roomId: string, purpose: string, proof: HostProof) => {
    await guard();
    if (!options.credentials.verifyHostProof) return false;
    const definition = inspectNativeRoom(options.storage, roomId) ?? inspectLegacyChatroomArchive(root, roomId);
    const grant = await authority({ root, workspaceId: options.workspaceId, actorId: "local:owner",
      roomId, sourceFingerprint: definition.sourceFingerprint, operation: "reopen" });
    const credentials = grant && await options.credentials.load(roomId);
    if (!credentials || !await options.credentials.verifyHostProof(roomId, credentials.hostCredentialHash, purpose, proof))
      return false;
    if (!await authority({ root, workspaceId: options.workspaceId, actorId: "local:owner",
      roomId, sourceFingerprint: definition.sourceFingerprint, operation: "reopen" })) return false;
    await guard();
    return true;
  };
  const syncRemoteHistory = async (roomId: string, signal?: AbortSignal, fullAssets = false) => {
    await guard();
    if (!runtime || !options.remoteRooms?.synchronizeHistory || !options.credentials.createHostProof || !options.credentials.verifyHostProof)
      throw new Error("Remote history requires an explicitly started selected Hub and separately enabled Host-proof synchronization.");
    const definition = inspectNativeRoom(options.storage, roomId) ?? inspectLegacyChatroomArchive(root, roomId);
    const current = await remote(roomId, definition.sourceFingerprint);
    if (!current) throw new Error("Selected remote history owner is unavailable.");
    const authorize = async () => {
      await guard();
      if (!await authority({ root, workspaceId: options.workspaceId, actorId: "local:owner",
        roomId, sourceFingerprint: definition.sourceFingerprint, operation: "reopen" }))
        throw new Error("Original Host credentials are required for remote history.");
      if (JSON.stringify(await remote(roomId, definition.sourceFingerprint)) !== JSON.stringify(current))
        throw new Error("Selected remote history owner changed; checkpoint retained.");
    };
    return runtime.syncRemoteHistory({
      binding: { roomId, sourceFingerprint: current.sourceFingerprint, lineage: roomHistoryLineage(options.storage, roomId),
        workspaceId: current.workspaceId, activeUrl: current.activeUrl },
      destinationWorkspaceId: options.workspaceId, signal, authorize, fullAssets,
      createProof: purpose => options.credentials.createHostProof!(roomId, purpose),
      verifyProof: async (purpose, proof) => {
        const current = await options.credentials.load(roomId);
        return !!current && options.credentials.verifyHostProof!(roomId, current.hostCredentialHash, purpose, proof);
      },
    });
  };
  const meetings = options.retained.MeetingStateStore ? createNextRoomMeetings({
    storage: options.storage, Store: options.retained.MeetingStateStore, assertAuthority: assert,
    async authorize(roomId) {
      await guard();
      const definition = inspectNativeRoom(options.storage, roomId) ?? inspectLegacyChatroomArchive(root, roomId);
      if (!await authority({ root, workspaceId: options.workspaceId, actorId: "local:owner", roomId,
        sourceFingerprint: definition.sourceFingerprint, operation: "reopen" }))
        throw new Error("Original Host credentials are required for Meeting state and Notes.");
      await guard();
    },
  }) : undefined;
  const list = async () => {
    await guard();
    const archives = existsSync(join(root, "chatrooms")) ? inspectLegacyChatroomTree(root) : [];
    const db = options.storage.connectNative();
    try {
      const native = db.prepare("SELECT 1 FROM sqlite_schema WHERE name='native_chatroom_definitions'").get()
        ? db.prepare("SELECT room_id,name,source_fingerprint FROM native_chatroom_definitions").all() : [];
      const states = db.prepare("SELECT 1 FROM sqlite_schema WHERE name='legacy_room_runtime_rooms'").get()
        ? new Map(db.prepare("SELECT room_id,state_json FROM legacy_room_runtime_rooms").all().map(row =>
          [String(row.room_id), JSON.parse(String(row.state_json))])) : new Map<string, any>();
      const inventory = [
        ...archives.map(room => ({ roomId: room.roomId, name: room.name, sourceFingerprint: room.sourceFingerprint,
          messageCount: room.messages.length })),
        ...native.map(row => ({ roomId: String(row.room_id), name: String(row.name), sourceFingerprint: String(row.source_fingerprint),
          messageCount: 0 })),
      ];
      const active = new Set(runtime?.activeRoomIds() ?? []);
      return await Promise.all(inventory.map(async room => {
        const state = states.get(room.roomId);
        const granted = await authority({ root, workspaceId: options.workspaceId, actorId: "local:owner",
          roomId: room.roomId, sourceFingerprint: room.sourceFingerprint, operation: "reopen" });
        const observed = active.has(room.roomId) || !granted ? undefined : await remote(room.roomId, room.sourceFingerprint);
        const elsewhere = observed?.state === "active" ? observed : undefined;
        const remoteUnknown = !!options.remoteRooms && !active.has(room.roomId) && !observed;
        return { roomId: room.roomId, roomName: state?.roomName ?? room.name, hasHostAuthority: !!granted,
          canTakeOverFullRoom: !!granted && !!options.fullHistory && !!options.remoteRooms?.synchronizeHistory
            && !active.has(room.roomId) && !!observed,
          ...readRoomProject(options.storage, room.roomId),
          updatedAt: state?.updatedAt ?? 0, messageCount: state?.messages.length ?? room.messageCount,
          canRehost: !!granted && !active.has(room.roomId) && !elsewhere && !remoteUnknown, activeElsewhere: !!elsewhere,
          ...(elsewhere ? { activeUrl: elsewhere.activeUrl, canForceClose: !!granted && !!options.credentials.createHostProof,
            unavailableReason: "Active on the independently selected remote Host." } : {}),
          ...(remoteUnknown ? { unavailableReason: "Selected remote owner state is unavailable; release is unconfirmed." } : {}),
          ...(!granted ? { unavailableReason: "Original Host credentials are unavailable." } : {}) };
      }));
    } finally { db.close(); }
  };
  const checkName = async (name: string, exceptRoomId?: string) => {
    const normalized = nativeRoomName(name);
    if ((await list()).some(room => room.roomId !== exceptRoomId
      && nativeRoomName(room.roomName).toLocaleLowerCase() === normalized.toLocaleLowerCase()))
      throw new Error("A Room with this name already exists.");
    return normalized;
  };
  const storedOperation = async <T>(run: (current: LegacyChatroomRuntime) => Promise<T>): Promise<T> => {
    await guard();
    if (runtime) return run(runtime);
    const current = new LegacyChatroomRuntime({ storage: options.storage, actorId: "local:owner",
      retained: options.retained, authorize: authority, assertAuthority: options.assertAuthority });
    try { return await run(current); } finally { await current.drain(); }
  };
  const api = {
    get meetingStore() { return meetings?.store; },
    get portalAuthority() { return portal; },
    get remoteOwnerDirectory() { return !!options.remoteRooms; },
    get isRunning() { return !!runtime && port > 0; },
    get port() { return port; },
    get publicHost() { return host; },
    setAdvertisedHost(value: string) {
      if (runtime) { if (value !== host) throw new Error("Stop the Next Hub before changing its network binding."); return; }
      if (value !== "localhost" && isIP(value) !== 4
        && !/^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/i.test(value))
        throw new Error("A valid IPv4 address or configured invite hostname is required.");
      host = value === "localhost" ? "127.0.0.1" : value;
    },
    configureArchive() {},
    configurePersistence(directory: string) {
      if (directory !== join(root, "chatrooms")) throw new Error("Room archive root differs from the owned Next workspace.");
    },
    configureLifecycle(directory: string) { api.configurePersistence(directory); },
    onApprovalsChanged(callback: () => void) { onApprovals = callback; },
    onRoomDeactivating(callback: typeof onDeactivating) { onDeactivating = callback; },
    pendingApprovals() { return runtime?.legacyUiAction("pendingApprovals") ?? []; },
    adminRooms() { return runtime?.legacyUiAction("adminRooms") ?? []; },
    portalChannelsSnapshot() { return portal && runtime ? runtime.legacyUiAction("portalChannelsSnapshot") : []; },
    createPortalChannel(channelId?: string, secret?: string) {
      if (!portal || !runtime) throw new Error("Next Portal transport is not admitted or its Hub is stopped.");
      portal.assertAuthority();
      return runtime.legacyUiAction("createPortalChannel", [channelId, secret]);
    },
    closePortalChannel(channelId: string, reason?: string) { runtime?.legacyUiAction("closePortalChannel", [channelId, reason]); },
    listStoredRooms: list,
    async start(requestedPort: number) {
      if (runtime) return;
      if (starting) return starting;
      starting = (async () => {
        await guard();
        if (!Number.isInteger(requestedPort) || requestedPort < 0 || requestedPort > 65535) throw new Error("Invalid Room port.");
        const policy = await options.chooseReconnectPolicy(`ws://${host}:${requestedPort || "(automatic port)"}`);
        if (!policy) throw new Error("Next Room hosting cancelled; no legacy Hub was started.");
        if (!["host-approval", "legacy-client-id"].includes(policy)) throw new Error("Unknown Room reconnect policy.");
        await guard();
        const candidate = new LegacyChatroomRuntime({ storage: options.storage, actorId: "local:owner",
          retained: options.retained, authorize: authority, legacyReconnect: policy,
          assertAuthority: options.assertAuthority,
          portalAuthority: portal?.assertAuthority,
          roomOwnership: roomId => readRoomProject(options.storage, roomId),
          authorizeHostCloseProof: (roomId, proof) => authorizeHostProof(roomId, `force-close:${roomId}`, proof),
          authorizeHostHistoryProof: options.historyExport ? authorizeHostProof : undefined,
          authorizeHostOwnerProof: options.ownerDirectory ? authorizeHostProof : undefined,
          ownerDirectory: options.ownerDirectory,
          prepareFullHistory: options.fullHistory ? async roomId => {
            if (!meetings) throw new Error("Full Room transfer requires the actual Meeting store.");
            await meetings.admit(roomId);
          } : undefined,
          createHostHistoryProof: async (roomId, purpose) => {
            await guard();
            const definition = inspectNativeRoom(options.storage, roomId) ?? inspectLegacyChatroomArchive(root, roomId);
            if (!options.credentials.createHostProof || !await authority({ root, workspaceId: options.workspaceId, actorId: "local:owner",
              roomId, sourceFingerprint: definition.sourceFingerprint, operation: "reopen" }))
              throw new Error("Original Host credentials are required to sign history.");
            const proof = await options.credentials.createHostProof(roomId, purpose);
            await guard();
            return proof;
          },
          network: { bindAddress: host.startsWith("127.") ? host : "0.0.0.0", advertisedHost: host, port: requestedPort },
          approveLegacyParticipant: async request => { await guard(); const approved = await options.approveParticipant(request);
            await guard(); return approved; },
          rotateJoinSecret: async (roomId, current) => {
            if (rotating) throw new Error("Another Room secret rotation is in progress.");
            rotating = true;
            try {
              await guard();
              const definition = inspectNativeRoom(options.storage, roomId) ?? inspectLegacyChatroomArchive(root, roomId);
              const grant = await authority({ root, workspaceId: options.workspaceId, actorId: "local:owner",
                roomId, sourceFingerprint: definition.sourceFingerprint, operation: "reopen" });
              if (!grant) throw new Error("Host credentials changed; no secret was rotated.");
              return await rotateRoomJoinSecret({ storage: options.storage, roomId, current,
                next: randomBytes(24).toString("base64url"), assertAuthority: assert,
                replace: secret => options.credentials.replaceJoinSecret(roomId, secret) });
            } finally { rotating = false; }
          } });
        try {
          if (onApprovals) candidate.legacyUiAction("onApprovalsChanged", [onApprovals]);
          if (onDeactivating) candidate.legacyUiAction("onRoomDeactivating", [onDeactivating]);
          await candidate.start();
          await guard();
          runtime = candidate;
          // The retained admin surface is the listener's actual transport, not a second Hub.
          port = candidate.listeningPort();
        } catch (error) { await candidate.drain(); throw error; }
      })();
      try { await starting; } finally { starting = undefined; }
    },
    async stop() {
      portal?.cancelPending();
      if (starting) await starting;
      const prior = runtime; runtime = undefined; port = 0;
      await prior?.drain();
    },
    async prepareStoredRoom(roomId: string) {
      await guard();
      await meetings?.admit(roomId);
      return meetings?.store.snapshot(roomId);
    },
    async createRoom(name: string, secret?: string, ownership?: unknown) {
      if (!runtime) throw new Error("Start the Next Hub before creating a Room.");
      const project = roomProject(ownership);
      if (project) {
        const existing = (await list()).find(value => value.projectId === project.projectId && value.threadId === project.threadId);
        if (!await options.project?.authorize({ ...project, ...(existing ? { roomId: existing.roomId } : {}) }))
          throw new Error("Original Project/thread ownership is unavailable.");
        if (existing && api.adminRooms().some((room: any) => room.roomId === existing.roomId))
          return runtime.reopen(existing.roomId, true);
        if (existing) return api.rehostRoom(existing.roomId);
      }
      const normalized = await checkName(name);
      assertNativeRoomNameAvailable(options.storage, normalized);
      const roomId = randomUUID(), credentials = await options.credentials.create(roomId, secret);
      await guard();
      createNativeRoom(options.storage, { roomId, name: normalized, sourceFingerprint: randomBytes(32).toString("hex"),
        hostCredentialHash: credentials.hostCredentialHash, joinSecretHash: credentials.joinSecretHash, ...project });
      await meetings?.admit(roomId);
      return runtime.reopen(roomId);
    },
    async rehostRoom(roomId: string) {
      if (!runtime) throw new Error("Start the Next Hub before rehosting.");
      const definition = inspectNativeRoom(options.storage, roomId) ?? inspectLegacyChatroomArchive(root, roomId);
      const observed = await remote(roomId, definition.sourceFingerprint);
      if (options.remoteRooms && !observed) throw new Error("Remote owner state is unavailable; rehost is not admitted.");
      if (observed?.state === "active")
        throw new Error("Close the independently selected remote Host before rehosting.");
      if (options.remoteRooms?.synchronizeHistory && (await syncRemoteHistory(roomId)).sourceState !== "stored")
        throw new Error("Remote history owner has not sealed a closed Room; rehost is not admitted.");
      await meetings?.admit(roomId);
      return runtime.reopen(roomId);
    },
    syncRemoteRoomHistory: syncRemoteHistory,
    missingFilePayloads: (roomId: string) => {
      if (!runtime) throw new Error("Start the selected Hub before saved attachment recovery.");
      return runtime.missingFilePayloads(roomId);
    },
    recoverFileBytes: (roomId: string, fileId: string, data: string) => {
      if (!runtime) throw new Error("Start the selected Hub before saved attachment recovery.");
      return runtime.recoverFileBytes(roomId, fileId, data);
    },
    syncRemoteFullRoomHistory: (roomId: string, signal?: AbortSignal) => syncRemoteHistory(roomId, signal, true),
    async takeOverFullRoom(roomId: string) {
      if (!options.fullHistory || !runtime) throw new Error("Start the selected Hub before explicitly taking over full Room assets.");
      if (!runtime.supportsRequestingHostIdentity())
        throw new Error("Full takeover requires a transport that preserves the receiver's Host identity.");
      const definition = inspectNativeRoom(options.storage, roomId) ?? inspectLegacyChatroomArchive(root, roomId);
      const current = await remote(roomId, definition.sourceFingerprint);
      if (!current) throw new Error("Selected full Room owner is unavailable.");
      if (current.state === "active") await api.forceCloseRemoteRoom(roomId, true);
      else if ((await syncRemoteHistory(roomId, undefined, true)).sourceState !== "stored")
        throw new Error("Full Room owner has not sealed its closed checkpoint.");
      await guard();
      const after = await remote(roomId, definition.sourceFingerprint);
      if (!after || after.state !== "released") throw new Error("Full Room owner release is unconfirmed.");
      await meetings?.admit(roomId);
      return runtime.reopen(roomId, false, true);
    },
    async forceCloseRemoteRoom(roomId: string, fullAssets = false) {
      await guard();
      if (fullAssets && !options.fullHistory) throw new Error("Full Room asset transfer is not enabled.");
      if (!options.remoteRooms || !options.credentials.createHostProof)
        throw new Error("Remote Host discovery/proof is not admitted; no legacy writer was started.");
      if (options.remoteRooms.synchronizeHistory && !runtime)
        throw new Error("Start the selected Hub before remote close with history synchronization.");
      const definition = inspectNativeRoom(options.storage, roomId) ?? inspectLegacyChatroomArchive(root, roomId);
      const current = await remote(roomId, definition.sourceFingerprint);
      if (!current || current.state !== "active") throw new Error("The independently selected remote Room is not active.");
      if (options.remoteRooms.synchronizeHistory) await syncRemoteHistory(roomId, undefined, fullAssets);
      const granted = await authority({ root, workspaceId: options.workspaceId, actorId: "local:owner",
        roomId, sourceFingerprint: definition.sourceFingerprint, operation: "reopen" });
      if (!granted) throw new Error("Original Host credentials are required for remote close.");
      const proof = await options.credentials.createHostProof(roomId, `force-close:${roomId}`);
      await guard();
      if (!await authority({ root, workspaceId: options.workspaceId, actorId: "local:owner",
        roomId, sourceFingerprint: definition.sourceFingerprint, operation: "reopen" }))
        throw new Error("Original Host credentials changed during proof creation; nothing was sent.");
      if (JSON.stringify(await remote(roomId, definition.sourceFingerprint)) !== JSON.stringify(current))
        throw new Error("Remote Host changed during proof creation; nothing was sent.");
      const endpoint = new URL(current.activeUrl);
      endpoint.protocol = endpoint.protocol === "wss:" ? "https:" : "http:";
      endpoint.pathname = `/api/rooms/${encodeURIComponent(roomId)}/close`;
      const response = await fetch(endpoint, { method: "POST", headers: {
        "X-PKM-Host-Timestamp": String(proof.timestamp), "X-PKM-Host-Nonce": proof.nonce, "X-PKM-Host-Proof": proof.signature,
      }, signal: AbortSignal.timeout(5000), redirect: "error" });
      await guard();
      if (response.status !== 202) throw new Error(`Active Host rejected close (${response.status}); no release was confirmed.`);
      const end = Date.now() + 15_000;
      while (Date.now() < end) {
        const after = await remote(roomId, definition.sourceFingerprint);
        if (!after) throw new Error("Remote Host state is unavailable; release is unconfirmed.");
        if (after.state === "released") {
          if (JSON.stringify({ ...after, state: "active" }) !== JSON.stringify(current))
            throw new Error("Remote Host binding changed; release is unconfirmed.");
          if (options.remoteRooms.synchronizeHistory && (await syncRemoteHistory(roomId, undefined, fullAssets)).sourceState !== "stored")
            throw new Error("Remote Host released but latest closed history was not confirmed; do not rehost.");
          return;
        }
        if (JSON.stringify(after) !== JSON.stringify(current)) throw new Error("Remote Host changed while waiting; release is unconfirmed.");
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      throw new Error("Active Host accepted close but its release is unconfirmed; do not claim successful handoff.");
    },
    async adminCloseRoom(roomId: string) { await runtime?.closeRoom(roomId); },
    async adminCloseAll() { for (const room of api.adminRooms()) await runtime!.closeRoom(room.roomId); },
    async renameActiveRoom(roomId: string, name: string) {
      const normalized = await checkName(name, roomId);
      if (!runtime) throw new Error("Room is not active.");
      return runtime.legacyUiAction("renameActiveRoom", [roomId, normalized]);
    },
    async renameStoredRoom(roomId: string, name: string) {
      const normalized = await checkName(name, roomId);
      await storedOperation(current => current.renameStoredRoom(roomId, normalized));
    },
    async repairStoredRoom(roomId: string) {
      return storedOperation(current => current.repairStoredRoom(roomId));
    },
    async rotateRoomSecret(room: string) {
      if (!runtime) throw new Error("Start the Next Hub before rotating its Room secret.");
      return runtime.legacyUiAction("rotateRoomSecret", [room]);
    },
    async deleteStoredRoom(roomId: string) {
      await guard();
      if (api.adminRooms().some((room: any) => room.roomId === roomId)) throw new Error("Close the Room before deleting its data.");
      const definition = inspectNativeRoom(options.storage, roomId);
      if (!definition) throw new Error("Retained migration archives are not deleted by the Next UI; no legacy writer was started.");
      const grant = await authority({ root, workspaceId: options.workspaceId, actorId: "local:owner", roomId,
        sourceFingerprint: definition.sourceFingerprint, operation: "reopen" });
      if (!grant) throw new Error("Original Host credentials are required to delete a Room.");
      const db = options.storage.connectNative();
      try {
        db.exec("BEGIN IMMEDIATE");
        try {
          assert();
          for (const table of ["legacy_room_runtime_chunks", "legacy_room_runtime_files", "legacy_room_runtime_resume",
            "next_room_history_exports", "next_room_history_nonces", "next_room_history_incoming", "next_room_history_receipts", "next_room_owner_nonces",
            "next_room_full_history_exports", "next_room_full_history_nonces", "next_room_full_history_incoming", "next_room_full_history_receipts",
            "next_room_file_recoveries", "next_room_host_successions",
            "legacy_room_runtime_rooms", "next_room_secret_state", "next_room_meeting_notes",
            "next_room_meeting_imported_notes", "next_room_meeting_manual_notes", "next_room_meeting_transferred_sources", "next_room_meetings",
            "next_room_projects", "native_chatroom_definitions"])
            if (db.prepare("SELECT 1 FROM sqlite_schema WHERE name=?").get(table))
              db.prepare(`DELETE FROM ${table} WHERE room_id=?`).run(roomId);
          assert(); db.exec("COMMIT");
        } catch (error) { if (db.isTransaction) db.exec("ROLLBACK"); throw error; }
      } finally { db.close(); }
      try { await options.credentials.delete(roomId); }
      catch { throw new Error("Room data was deleted, but profile credential cleanup is unknown; do not retry deletion."); }
    },
  };
  assert();
  return new Proxy(api, {
    get(target, property) {
      if (property === "then") return undefined;
      if (property === "stop") return api.stop;
      assert();
      if (!(property in target)) return () => { throw new Error(`Next Room action ${String(property)} is not integrated; no legacy writer was started.`); };
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? (...args: unknown[]) => { assert(); return value.apply(target, args); } : value;
    },
  });
}
