import { assertOriginalMcpNativeHost, originalMcpPublicRequestMatches, type OriginalMcpNativeHost } from "./original-mcp-native-host.js";
import { assertOriginalMcpNativeRoomAuthority, type OriginalMcpNativeRoomAuthority } from "./original-mcp-native-room-authority.js";
import { originalNativeRoomDigest, originalNativeRoomStatusArguments } from "./original-mcp-native-room-contracts.js";
import type { Storage } from "./storage.js";

function fail(code: string): never { throw Object.assign(new Error(code), { code }); }

export interface OriginalMcpRoomPublicPort {
  readonly kind: "pkm.original-native-room-public/v1";
  owns(operation: string): boolean;
  dispatch(operation: string, input: unknown, signal?: AbortSignal): Promise<Readonly<{ result: string }>>;
}
const selections = new WeakMap<Storage, {
  host: OriginalMcpNativeHost; port: OriginalMcpRoomPublicPort; assertCurrent(): void;
}>();

export function originalMcpRoomPublicPort(storage: Storage, host: OriginalMcpNativeHost): OriginalMcpRoomPublicPort {
  const selected = selections.get(storage);
  if (!selected || selected.host !== host) fail("NATIVE_ROOM_SOURCE_SELECTION_REQUIRED");
  selected.assertCurrent();
  return selected.port;
}

/** One original public leaf; selection comes from native source admission, never an extra public room_id argument. */
export function createOriginalMcpRoomPublicPort(storage: Storage, host: OriginalMcpNativeHost,
  authority: OriginalMcpNativeRoomAuthority, roomId: string): OriginalMcpRoomPublicPort {
  const current = () => {
    assertOriginalMcpNativeHost(host, storage); assertOriginalMcpNativeRoomAuthority(authority, storage, host);
    authority.assertSource(roomId);
  };
  current();
  const port: OriginalMcpRoomPublicPort = Object.freeze({
    kind: "pkm.original-native-room-public/v1" as const,
    owns(operation: string) { return operation === "mcp.tool.chat_status"; },
    async dispatch(operation: string, input: unknown, signal?: AbortSignal) {
      current();
      if (operation !== "mcp.tool.chat_status") fail("NATIVE_ROOM_PUBLIC_METHOD_UNAVAILABLE");
      const args = originalNativeRoomStatusArguments.parse(input);
      const approval = { operation, version: 1 as const, tool: "chat_status", readOnly: true, arguments: args,
        argumentsDigest: originalNativeRoomDigest(args) };
      if (!originalMcpPublicRequestMatches(storage, host, approval)) fail("NATIVE_ROOM_EXACT_PUBLIC_REQUEST_REQUIRED");
      const grant = await authority.proveHost(roomId, signal);
      current();
      return authority.readStatus(roomId, grant, args, signal);
    },
  });
  selections.set(storage, { host, port, assertCurrent: current });
  storage.retainNativeCleanup({ release: async () => {
    if (selections.get(storage)?.port === port) selections.delete(storage);
  } });
  return port;
}
