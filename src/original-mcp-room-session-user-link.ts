import { randomUUID } from "node:crypto";
import { originalRoomSessionDigest } from "./original-mcp-room-session-contracts.js";
import { describeOriginalRoomUserJoin, parseOriginalRoomUserJoinArguments } from "./original-mcp-room-session-user-link-codec.js";
export { describeOriginalRoomUserJoin } from "./original-mcp-room-session-user-link-codec.js";
import {
  assertOriginalRoomSessionGrantCurrent, type OriginalRoomSessionGrant,
} from "./original-mcp-room-session-authority.js";

function fail(code: string): never { throw Object.assign(new Error(code), { code }); }
type PublicArguments = { magic_link: string; name: string };
export type OriginalRoomUserJoinCall = ReturnType<typeof describeOriginalRoomUserJoin>;
export interface OriginalRoomUserJoinIngress {
  readonly kind: "pkm.original-room-user-link-ingress/v1";
  readonly callId: string;
  readonly effectSha256: string;
  readonly call: OriginalRoomUserJoinCall;
}
type State = { grant: OriginalRoomSessionGrant; raw?: PublicArguments; phase: "pending" | "forwarded" | "discarded" };
const records = new WeakMap<object, State>();
const ledgers = new WeakMap<object, Map<string, OriginalRoomUserJoinIngress>>();

/** Original public contract in; genuine current effect capability required. The returned object is redaction-safe. */
export function prepareOriginalRoomUserJoin(grant: OriginalRoomSessionGrant, input: unknown, callId = randomUUID()): OriginalRoomUserJoinIngress {
  assertOriginalRoomSessionGrantCurrent(grant);
  const args = parseOriginalRoomUserJoinArguments(input), call = describeOriginalRoomUserJoin(grant.effect, args);
  // Use the existing operation UUID contract without putting caller input in errors.
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(callId)) fail("ROOM_USER_JOIN_CALL_ID_REQUIRED");
  let ledger = ledgers.get(grant);
  if (!ledger) {
    ledger = new Map(); ledgers.set(grant, ledger);
    const selected = ledger;
    grant.signal.addEventListener("abort", () => {
      for (const ingress of selected.values()) {
        const state = records.get(ingress)!; state.raw = undefined; state.phase = "discarded";
      }
    }, { once: true });
  }
  const prior = ledger.get(callId);
  if (prior) {
    if (prior.call.userLink.argumentsSha256 !== call.userLink.argumentsSha256) fail("ROOM_USER_JOIN_CALL_CONFLICT");
    return prior;
  }
  if (ledger.size >= 16) fail("ROOM_USER_JOIN_INGRESS_LIMIT");
  const ingress = Object.freeze({ kind: "pkm.original-room-user-link-ingress/v1" as const,
    callId, effectSha256: originalRoomSessionDigest(grant.effect), call });
  records.set(ingress, { grant, raw: args, phase: "pending" }); ledger.set(callId, ingress);
  return ingress;
}

/** Only this branch may carry raw user-supplied args, once, to the actual native producer. Never log its return value. */
export function consumeOriginalRoomUserJoin(ingress: OriginalRoomUserJoinIngress) {
  const state = records.get(ingress);
  if (!state) fail("ROOM_USER_JOIN_ACTUAL_INGRESS_REQUIRED");
  assertOriginalRoomSessionGrantCurrent(state.grant);
  if (state.phase === "discarded") fail("ROOM_USER_JOIN_INGRESS_DISCARDED");
  if (state.phase === "forwarded")
    return Object.freeze({ kind: "replay" as const, callId: ingress.callId, call: ingress.call });
  const args = state.raw!;
  state.raw = undefined; state.phase = "forwarded";
  return Object.freeze({ kind: "forward" as const, callId: ingress.callId, arguments: Object.freeze(args), intent: ingress.call.userLink });
}
export function discardOriginalRoomUserJoin(ingress: OriginalRoomUserJoinIngress): void {
  const state = records.get(ingress);
  if (!state) fail("ROOM_USER_JOIN_ACTUAL_INGRESS_REQUIRED");
  state.raw = undefined; state.phase = "discarded";
}

/** Feed this descriptor to existing current-native public approval/usage evidence, not the original link-bearing args. */
export function originalRoomUserJoinPublicApproval(ingress: OriginalRoomUserJoinIngress) {
  const state = records.get(ingress);
  if (!state) fail("ROOM_USER_JOIN_ACTUAL_INGRESS_REQUIRED");
  assertOriginalRoomSessionGrantCurrent(state.grant);
  const arguments_ = Object.freeze({ name: ingress.call.arguments.name, user_link: ingress.call.userLink });
  return Object.freeze({ operation: "mcp.tool.chat_join", version: 1 as const, tool: "chat_join", readOnly: false,
    arguments: arguments_, argumentsDigest: originalRoomSessionDigest(arguments_) });
}
