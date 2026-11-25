import { ProtocolClient as BrowserProtocolClient } from "../browser/protocol.mjs";
export { ProtocolError, LiveFeed, OPERATIONS } from "../browser/protocol.mjs";

// The frozen oracle predates authenticated server identity in its synthetic fixture.
export class ProtocolClient extends BrowserProtocolClient {
  #turns = new Map();
  async request(method, ...args) {
    // Adapt the frozen synthetic server to the newer native continuity contract.
    const body = args[0];
    if (method === "capability_read" && body.operation === "chat.turn.list")
      return { items: [...this.#turns.values()].filter(turn => turn.sessionId === body.arguments.sessionId), next: null };
    const result = await super.request(method, ...args);
    if (method === "server_info" && result.name === "pkm-next" &&
        result.workspaceId === undefined && result.actorId === undefined) {
      return { ...result, workspaceId: "oracle-workspace", actorId: "oracle-owner" };
    }
    if (!["capability_call", "capability_read"].includes(method)) return result;
    if (body.operation === "chat.turn.start") {
      const turn = { ...result, sessionId: body.arguments.sessionId, messages: body.arguments.messages };
      this.#turns.set(turn.id, turn);
      return turn;
    }
    if (body.operation === "chat.turn.get" && this.#turns.has(result.id)) {
      const turn = { ...this.#turns.get(result.id), ...result };
      this.#turns.set(turn.id, turn);
      return turn;
    }
    if (body.operation === "chat.session.messages") {
      const observations = [...this.#turns.values()].filter(turn => turn.sessionId === body.arguments.id)
        .flatMap(turn => [...turn.messages, ...(["completed", "failed", "cancelled", "unknown"].includes(turn.status)
          ? [{ role: "assistant", content: turn.output, status: "complete" }] : [])]);
      return { ...result, items: [...result.items, ...observations] };
    }
    return result;
  }
}
