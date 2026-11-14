// @ts-check
/**
 * @typedef {{operation:string, readOnly:boolean}} Operation
 * @typedef {{schema:string, requestId:string, result?:Record<string,any>, error?:{code:string,effect:string}}} Envelope
 * @typedef {{seq?:number,sequence?:number,eventId?:string,type:string,time?:string,at?:number,data?:Record<string,any>}} LiveEvent
 */

export const OPERATIONS = Object.freeze({
  knowledgeList: { operation: "knowledge.document.list", readOnly: true },
  knowledgeGet: { operation: "knowledge.document.get", readOnly: true },
  chatList: { operation: "chat.session.list", readOnly: true },
  chatCreate: { operation: "chat.session.create", readOnly: false },
  chatGet: { operation: "chat.session.get", readOnly: true },
  chatMessages: { operation: "chat.session.messages", readOnly: true },
  chatStart: { operation: "chat.turn.start", readOnly: false },
  chatTurn: { operation: "chat.turn.get", readOnly: true },
  chatEvents: { operation: "chat.turn.events", readOnly: true },
  chatCancel: { operation: "chat.turn.cancel", readOnly: false },
  managerStart: { operation: "manager.runtime.start", readOnly: false },
  managerGet: { operation: "manager.runtime.get", readOnly: true },
  managerEvents: { operation: "manager.runtime.events", readOnly: true },
  managerFeedback: { operation: "manager.runtime.feedback", readOnly: false },
  managerCancel: { operation: "manager.runtime.cancel", readOnly: false },
  managerProgressGet: { operation: "manager.progress.get", readOnly: true },
  managerProgressEvents: { operation: "manager.progress.events", readOnly: true },
  managerProgressFeedback: { operation: "manager.progress.feedback", readOnly: false },
});

export class ProtocolError extends Error {
  /** @param {string} code @param {string} [effect] */
  constructor(code, effect = "not-committed") {
    super(`${code}${effect === "unknown" ? " · outcome unknown; do not resubmit as a new operation" : ""}`);
    this.name = "ProtocolError";
    this.code = code;
    this.effect = effect;
  }
}

/** Only trusted host code may supply operation mappings; never accept endpoint/user overrides. */
export class ProtocolClient {
  #token = "";
  #disposed = false;
  /** @type {Set<AbortController>} */
  #pending = new Set();
  /** @type {Set<string>} */
  #available = new Set();
  /** @type {Map<string,Record<string,any>>} */
  #uncertain = new Map();
  #generation = 0;
  /**
   * @param {{origin?:string, fetch?:typeof fetch, operations?:Record<string,Operation>, timeoutMs?:number}} [options]
   */
  constructor(options = {}) {
    const url = new URL(options.origin ?? globalThis.location?.origin);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password ||
        (globalThis.location && url.origin !== globalThis.location.origin)) throw new ProtocolError("UNSAFE_ORIGIN");
    this.origin = url.origin;
    this.fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.operations = Object.freeze(Object.fromEntries(Object.entries(options.operations ?? OPERATIONS).map(([key, value]) => {
      if (!/^[a-z][a-z0-9.]{0,99}$/.test(value.operation) || typeof value.readOnly !== "boolean")
        throw new ProtocolError("INVALID_HOST_CONFIGURATION");
      return [key, Object.freeze({ ...value })];
    })));
    this.timeoutMs = options.timeoutMs ?? 12000;
  }
  /** @param {string} token */
  authenticate(token) {
    if (this.#disposed) throw new ProtocolError("DISPOSED");
    if (!token || /[\r\n]/.test(token)) throw new ProtocolError("INVALID_TOKEN");
    this.disconnect();
    this.#token = token;
  }
  disconnect() {
    this.#generation++;
    this.#token = "";
    this.#available.clear();
    for (const controller of this.#pending) controller.abort();
    this.#pending.clear();
  }
  dispose() { this.disconnect(); this.#uncertain.clear(); this.#disposed = true; }
  /** @param {string} key */
  available(key) { return this.#available.has(key); }
  /** Pending bodies stay private in memory, allowing only an identical explicit retry. */
  pendingMutations() { return [...this.#uncertain.keys()]; }
  async bootstrap() {
    const generation = this.#generation;
    const info = await this.request("server_info", {});
    const keys = Object.keys(this.operations);
    for (let offset = 0; offset < keys.length; offset += 4) {
      await Promise.all(keys.slice(offset, offset + 4).map(async key => {
        try {
          const result = await this.request("capabilities_describe", { operation: this.operations[key].operation });
          if (generation !== this.#generation) throw new ProtocolError("REQUEST_ABORTED");
          if (result.operation !== this.operations[key].operation || result.version !== 1 ||
              result.readOnly !== this.operations[key].readOnly) throw new ProtocolError("INVALID_CONTRACT");
          this.#available.add(key);
        } catch (error) {
          if (!(error instanceof ProtocolError) || !["NOT_FOUND", "NOT_AVAILABLE", "ACCESS_DENIED"].includes(error.code)) throw error;
        }
      }));
    }
    return info;
  }
  /** @param {string} key @param {Record<string,any>} args @param {AbortSignal} [signal] */
  async call(key, args, signal) {
    if (!this.available(key)) throw new ProtocolError("CAPABILITY_UNAVAILABLE");
    const operation = this.operations[key];
    if (!operation.readOnly && this.#uncertain.has(key)) throw new ProtocolError("PENDING_OUTCOME_UNKNOWN", "unknown");
    const body = JSON.parse(JSON.stringify({ operation: operation.operation, version: 1, arguments: args }));
    try { return await this.request(operation.readOnly ? "capability_read" : "capability_call", body, signal, !operation.readOnly); }
    catch (error) {
      if (!operation.readOnly && error instanceof ProtocolError && error.effect === "unknown") this.#uncertain.set(key, body);
      throw error;
    }
  }
  /** @param {string} key */
  async retryMutation(key) {
    const body = this.#uncertain.get(key);
    if (!body || !this.available(key)) throw new ProtocolError("NO_RETRYABLE_OPERATION");
    const result = await this.request("capability_call", body, undefined, true);
    this.#uncertain.delete(key);
    return { key, result, arguments: structuredClone(body.arguments) };
  }
  /**
   * No automatic write retries. Retrying an unknown mutation requires retaining its exact body/operationId.
   * @param {string} method @param {Record<string,any>} body @param {AbortSignal} [signal] @param {boolean} [mutation]
   */
  async request(method, body, signal, mutation = false) {
    if (this.#disposed || !this.#token) throw new ProtocolError(this.#disposed ? "DISPOSED" : "AUTHENTICATION_REQUIRED");
    if (!["server_info", "capabilities_describe", "capability_read", "capability_call"].includes(method))
      throw new ProtocolError("INVALID_METHOD");
    const serialized = JSON.stringify(body);
    if (new TextEncoder().encode(serialized).length > 131072) throw new ProtocolError("REQUEST_TOO_LARGE");
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) controller.abort();
    this.#pending.add(controller);
    const timer = setTimeout(abort, this.timeoutMs);
    try {
      const response = await this.fetch(`${this.origin}/v1/${method}`, {
        method: "POST", redirect: "error", credentials: "same-origin", cache: "no-store",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.#token}` },
        body: serialized, signal: controller.signal,
      });
      if (!response.headers.get("content-type")?.startsWith("application/json")) throw new ProtocolError("INVALID_RESPONSE", mutation ? "unknown" : undefined);
      const text = await response.text();
      if (text.length > 1048576) throw new ProtocolError("RESPONSE_TOO_LARGE", mutation ? "unknown" : undefined);
      /** @type {Envelope} */
      const envelope = JSON.parse(text);
      if (envelope.schema !== "pkm.next-result/v1" || typeof envelope.requestId !== "string" ||
          Boolean(envelope.error) === Boolean(envelope.result)) throw new ProtocolError("INVALID_RESPONSE", mutation ? "unknown" : undefined);
      if (envelope.error) {
        const code = /^[A-Z_]{1,64}$/.test(envelope.error.code) ? envelope.error.code : "SERVER_ERROR";
        throw new ProtocolError(code, envelope.error.effect);
      }
      if (!response.ok || !envelope.result || typeof envelope.result !== "object" || Array.isArray(envelope.result))
        throw new ProtocolError("INVALID_RESPONSE", mutation ? "unknown" : undefined);
      return envelope.result;
    } catch (error) {
      if (error instanceof ProtocolError) throw error;
      throw new ProtocolError(controller.signal.aborted ? "REQUEST_ABORTED" : "TRANSPORT_ERROR", mutation ? "unknown" : undefined);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      this.#pending.delete(controller);
    }
  }
}

/**
 * Cursor is exclusive; duplicates do not produce duplicate UI results. Read failures back off and
 * stop visibly after a bounded retry budget. Writes are never retried by this loop.
 */
export class LiveFeed {
  #controller = new AbortController();
  #timer = 0;
  #running = false;
  #failures = 0;
  #seen = new Set();
  #gap = false;
  cursor = 0;
  /**
   * @param {{read:(cursor:number,signal:AbortSignal)=>Promise<{events:LiveEvent[],next:number,terminal?:boolean,more?:boolean,gap?:boolean}>,event:(event:LiveEvent)=>void,status:(status:string)=>void,intervalMs?:number,maxFailures?:number}} options
   */
  constructor(options) { this.options = options; }
  start() {
    if (this.#running || this.#controller.signal.aborted) return;
    this.#running = true;
    this.options.status("Connecting live updates");
    void this.#poll();
  }
  async #poll() {
    try {
      const page = await this.options.read(this.cursor, this.#controller.signal);
      if (this.#controller.signal.aborted) return;
      if (!Array.isArray(page.events) || !Number.isSafeInteger(page.next) || page.next < this.cursor)
        throw new ProtocolError("INVALID_CURSOR");
      if (page.gap) this.#gap = true;
      for (const event of page.events) {
        const seq = event.seq ?? event.sequence;
        if (!Number.isSafeInteger(seq) || Number(seq) <= 0 || Number(seq) > page.next || typeof event.type !== "string")
          throw new ProtocolError("INVALID_EVENT");
        const key = event.eventId ?? String(seq);
        if (Number(seq) <= this.cursor || this.#seen.has(key)) continue;
        if (Number(seq) !== this.cursor + 1) this.#gap = true;
        this.#seen.add(key);
        if (this.#seen.size > 2048) this.#seen.delete(this.#seen.values().next().value);
        this.options.event(event);
        this.cursor = Number(seq);
      }
      this.cursor = page.next;
      this.#failures = 0;
      this.options.status((page.terminal ? "Live updates complete" : "Live · cursor " + this.cursor) +
        (this.#gap ? " · event gap detected; snapshot refreshed, some results may be missing" : ""));
      if (page.terminal) { this.dispose(); return; }
      this.#schedule(page.more ? 0 : (this.options.intervalMs ?? 1500));
    } catch {
      if (this.#controller.signal.aborted) return;
      this.#failures++;
      const exhausted = this.#failures >= (this.options.maxFailures ?? 5);
      this.options.status(exhausted ? "Live updates stopped · reconnect to resume from cursor " + this.cursor :
        `Live update error · retry ${this.#failures} from cursor ${this.cursor}`);
      if (exhausted) { this.#running = false; return; }
      this.#schedule(Math.min(15000, (this.options.intervalMs ?? 1500) * 2 ** this.#failures));
    }
  }
  /** @param {number} delay */
  #schedule(delay) { this.#timer = Number(setTimeout(() => void this.#poll(), delay)); }
  reconnect() {
    if (this.#controller.signal.aborted) return;
    if (this.#running) return;
    this.#failures = 0;
    this.start();
  }
  dispose() { this.#controller.abort(); clearTimeout(this.#timer); this.#running = false; }
}
