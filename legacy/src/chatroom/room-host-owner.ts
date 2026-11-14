import type { ChatHub } from "./chatroom-hub";
import type { RoomMeetingStore } from "./meeting-state";

export interface RoomPortalRequest {
  root: string;
  contextId: string;
  operation: "connect" | "restore" | "command" | "task" | "files";
  pairId?: string;
  peerId?: string;
  detail?: unknown;
}
export interface RoomPortalAuthority {
  readonly legacyContext?: boolean;
  assertAuthority(): void;
  authorize(request: RoomPortalRequest): Promise<boolean>;
  executeCommand?(input: RoomPortalRequest & { requestId: string; command: unknown; defaultCwd: string; signal: AbortSignal }): Promise<unknown>;
}
export type RoomHostHub = Pick<ChatHub, keyof ChatHub> & {
  readonly meetingStore?: RoomMeetingStore;
  readonly portalAuthority?: RoomPortalAuthority;
  readonly remoteOwnerDirectory?: boolean;
  takeOverFullRoom?(roomId: string): ReturnType<ChatHub["rehostRoom"]>;
  missingFilePayloads?(roomId: string): Promise<{ fileId: string; name: string; size: number; mime: string }[]>;
  recoverFileBytes?(roomId: string, fileId: string, data: string): Promise<{ sha256: string }>;
};
export type LegacyReconnectPolicy = "host-approval" | "legacy-client-id";
export interface RoomHostUi {
  chooseReconnectPolicy(endpoint: string): Promise<LegacyReconnectPolicy | undefined>;
  approveParticipant(request: { roomId: string; participantId: string; previousAlias: string; requestedAlias: string;
    clientId: string; kind: string; expiresAt: number }): Promise<boolean>;
}
export interface AdoptedRoomHostOwner {
  readonly root: string;
  readonly workspaceId: string;
  readonly qualification: "new-next-workspace" | "adopted-production-qualified";
  /** Supplied by the live workspace owner, never inferred from an on-disk marker. */
  assertAuthority(): void;
  createHub(ui: RoomHostUi, assertSelectedOwner: () => void): RoomHostHub;
}

const owners = new Map<string, AdoptedRoomHostOwner>();
const selectedRoots = new Set<string>();
const legacyRoots = new Set<string>();
const revokedOwners = new WeakSet<AdoptedRoomHostOwner>();
const hubs = new WeakMap<AdoptedRoomHostOwner, Set<RoomHostHub>>();

/** A saved explicit Next selection must not silently reopen the old writer when recovery fails. */
export function markSelectedRoomHostUnavailable(root: string): void {
  if (!root || owners.has(root)) throw new Error("Cannot replace a live Room owner with an unavailable selection.");
  selectedRoots.add(root);
}

/** Call from the trusted, already-admitted workspace host, before initializing the legacy UI. */
export function registerAdoptedRoomHostOwner(owner: AdoptedRoomHostOwner): { dispose(): Promise<void> } {
  if (!owner.root || !owner.workspaceId || owners.has(owner.root)
    || !["new-next-workspace", "adopted-production-qualified"].includes(owner.qualification))
    throw new Error("A unique qualified live Room workspace owner is required; experimental adoption is not production admission.");
  if (legacyRoots.has(owner.root))
    throw new Error("This process already selected a legacy Room writer; restart after the qualified workspace handoff.");
  owner.assertAuthority();
  owners.set(owner.root, owner);
  selectedRoots.add(owner.root);
  hubs.set(owner, new Set());
  let disposing: Promise<void> | undefined;
  return { dispose() {
    if (!disposing) {
      revokedOwners.add(owner);
      disposing = (async () => {
        await Promise.all([...(hubs.get(owner) ?? [])].map(hub => hub.stop()));
        if (owners.get(owner.root) === owner) owners.delete(owner.root);
      })();
    }
    return disposing;
  } };
}

export function adoptedRoomHostOwner(root: string): AdoptedRoomHostOwner | undefined {
  const owner = owners.get(root);
  if (owner && revokedOwners.has(owner) || !owner && selectedRoots.has(root))
    throw new Error("Next Room workspace authority was revoked; the old Hub will not be started.");
  owner?.assertAuthority();
  return owner;
}

export function selectRoomHostHub(root: string, legacy: () => RoomHostHub, ui: RoomHostUi): RoomHostHub {
  const owner = adoptedRoomHostOwner(root);
  const assertCurrent = () => {
    if (adoptedRoomHostOwner(root) !== owner) throw new Error("Room workspace owner changed; reopen the Room UI without legacy fallback.");
  };
  if (!owner) legacyRoots.add(root);
  const hub = owner ? hubs.get(owner)!.values().next().value ?? owner.createHub(ui, assertCurrent) : legacy();
  if (owner) hubs.get(owner)!.add(hub);
  assertCurrent();
  return new Proxy(hub, {
    get(target, property) {
      if (property === "stop") return target.stop.bind(target);
      assertCurrent();
      const value = Reflect.get(target, property, target);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        assertCurrent();
        return value.apply(target, args);
      };
    },
  });
}
