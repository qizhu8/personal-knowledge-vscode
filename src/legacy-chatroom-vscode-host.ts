import type { Storage } from "./storage.js";
import { createLegacyChatroomHostAuthority } from "./legacy-chatroom-host-authority.js";
import { attachLegacyChatroomHostIpc } from "./legacy-chatroom-host-ipc.js";
import { LegacyChatroomRuntime, type LegacyRoomRuntimeOptions } from "./legacy-chatroom-runtime.js";

type Binding = { root: string; workspaceId: string; actorId: string; roomId: string;
  sourceFingerprint: string; operation: "reopen" };

/** Compose into the existing workspace-owning server; never opens a second writer. */
export async function createVscodeLegacyChatroomHost(options: {
  storage: Storage;
  session: string;
  binding: Binding;
  retained: LegacyRoomRuntimeOptions["retained"];
  network?: LegacyRoomRuntimeOptions["network"];
  legacyReconnect?: LegacyRoomRuntimeOptions["legacyReconnect"];
  expectedActorId?: string;
  assertAuthority?(): Promise<void>;
}) {
  options.storage.assertWorkspaceLease();
  const actorId = options.expectedActorId ?? "local:owner";
  if (options.binding.actorId !== actorId || options.binding.root !== options.storage.workspaceRoot()
    || options.binding.workspaceId !== await options.storage.workspaceId() || options.binding.operation !== "reopen")
    throw new Error("VS Code Room host workspace binding denied.");
  let runtime: LegacyChatroomRuntime | undefined;
  let closed = false, draining: Promise<void> | undefined;
  let authorityTimer: ReturnType<typeof setInterval> | undefined;
  const bridges = new Map<string, { bridge: ReturnType<typeof attachLegacyChatroomHostIpc>; intentional: boolean }>();
  const drain = () => draining ??= (async () => {
    closed = true;
    if (authorityTimer) clearInterval(authorityTimer);
    await runtime?.drain();
  })();
  const addBridge = async (binding: Binding, session: string) => {
    if (closed || binding.actorId !== actorId || binding.root !== options.storage.workspaceRoot()
      || binding.workspaceId !== await options.storage.workspaceId() || binding.operation !== "reopen"
      || bridges.has(binding.roomId)) throw new Error("VS Code Room host workspace binding denied.");
    const entry = { bridge: undefined as unknown as ReturnType<typeof attachLegacyChatroomHostIpc>, intentional: false };
    entry.bridge = attachLegacyChatroomHostIpc({ binding, session, onRevoked: () => {
      if (entry.intentional || closed) return;
      bridges.delete(binding.roomId);
      void runtime?.closeRoom(binding.roomId).catch(() => drain()).catch(() => {});
    } });
    bridges.set(binding.roomId, entry);
    return entry;
  };
  try {
    await addBridge(options.binding, options.session);
    runtime = new LegacyChatroomRuntime({ storage: options.storage, actorId, retained: options.retained,
      network: options.network, legacyReconnect: options.legacyReconnect,
      approveLegacyParticipant: async request => {
        await options.assertAuthority?.();
        return bridges.get(request.roomId)?.bridge.approveParticipant(request) ?? false;
      },
      authorize: async binding => {
        const bridge = bridges.get(binding.roomId)?.bridge;
        if (!bridge) return false;
        return createLegacyChatroomHostAuthority({ storage: options.storage, actorId,
        credentials: bridge.credentials, authorizeActor: async candidate => {
          await options.assertAuthority?.();
          return bridge.authorizeActor(candidate);
        } })(binding);
      } });
    if (options.assertAuthority) {
      let checking = false;
      authorityTimer = setInterval(() => {
        if (checking) return;
        checking = true;
        void options.assertAuthority!().catch(() => drain()).finally(() => { checking = false; }).catch(() => {});
      }, 1000);
      authorityTimer.unref();
    }
  } catch (error) {
    for (const entry of bridges.values()) { entry.intentional = true; entry.bridge.close(); }
    bridges.clear(); throw error;
  }
  return Object.freeze({
    reopen(roomId: string) {
      if (closed || !bridges.has(roomId)) throw new Error("VS Code Room host admission denied.");
      return runtime!.reopen(roomId);
    },
    async addRoom(binding: Binding, session: string) {
      const entry = await addBridge(binding, session);
      try { return await runtime!.reopen(binding.roomId); }
      catch (error) {
        entry.intentional = true; entry.bridge.close(); bridges.delete(binding.roomId);
        try { await runtime!.closeRoom(binding.roomId); } catch { await drain(); }
        throw error;
      }
    },
    async closeRoom(roomId: string) {
      const entry = bridges.get(roomId);
      if (!entry) return;
      await runtime!.closeRoom(roomId);
      bridges.delete(roomId); entry.intentional = true; entry.bridge.close();
    },
    async close() {
      try { await drain(); } finally {
        for (const entry of bridges.values()) { entry.intentional = true; entry.bridge.close(); }
        bridges.clear();
      }
    },
  });
}
