import { ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { Duplex } from "node:stream";

type State = "accepting" | "draining" | "stopped" | "unknown";
type Message = Record<string, unknown>;
const maxLine = 8 * 1024 * 1024;
const key = (id: unknown): string | undefined =>
  typeof id === "string" ? `s:${id}` : typeof id === "number" && Number.isSafeInteger(id) ? `n:${id}` : undefined;

/** Tracks one exact child and one admitted transport; this does not fence another launcher. */
export function ownNextMcpStdio(child: ChildProcess, verifyOwnedDescendantsExited: () => Promise<void>,
  assertAdmission: () => void = () => {}) {
  if (!child.stdin || !child.stdout || !child.pid || child.exitCode !== null || child.signalCode !== null
    || typeof verifyOwnedDescendantsExited !== "function" || typeof assertAdmission !== "function")
    throw new Error("A live owned stdio child is required.");
  const stdin = child.stdin, stdout = child.stdout;
  let state: State = "accepting", connection: Duplex | undefined, claimed = false;
  let incoming: Buffer = Buffer.alloc(0), outgoing: Buffer = Buffer.alloc(0);
  let closing = false, closeRequested = false, delivered = 0;
  const pending = new Set<string>(), serverRequests = new Set<string>();
  const controls = new Map<string, { resolve(value: unknown): void; reject(error: Error): void }>();
  type Retired = { state: "stopped"; pid: number; cutoverAuthorized: false };
  let finish: ((result: Retired) => void) | undefined;
  let rejectDrain: ((error: Error) => void) | undefined;
  let draining: Promise<Retired> | undefined;
  let deadline: NodeJS.Timeout | undefined;
  const pid = child.pid;
  const fail = (message: string) => {
    if (state === "stopped" || state === "unknown") return;
    state = "unknown";
    if (deadline) clearTimeout(deadline);
    for (const control of controls.values()) control.reject(new Error(message));
    controls.clear();
    rejectDrain?.(new Error(message));
  };
  const closeWhenDrained = () => {
    if (state === "draining" && closeRequested && pending.size === 0 && serverRequests.size === 0 && delivered === 0 && !closing) {
      closing = true;
      stdin.end();
    }
  };
  const lines = (previous: Buffer, chunk: Buffer, process: (line: Buffer) => void): Buffer => {
    let data = Buffer.concat([previous, chunk]);
    while (true) {
      const end = data.indexOf(10);
      if (end < 0) break;
      if (end > maxLine) throw new Error("MCP message exceeds limit.");
      const line = data.subarray(0, end);
      data = data.subarray(end + 1);
      if (line.length) process(line);
    }
    if (data.length > maxLine) throw new Error("MCP message exceeds limit.");
    return data;
  };
  const decode = (line: Buffer): Message => {
    const value: unknown = JSON.parse(line.toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value) || (value as Message).jsonrpc !== "2.0")
      throw new Error("Invalid MCP message.");
    return value as Message;
  };
  const send = (stream: NodeJS.WritableStream, bytes: Buffer, callback?: (error?: Error | null) => void) => {
    stream.write(Buffer.concat([bytes, Buffer.from("\n")]), callback);
  };
  stdout.on("data", (chunk: Buffer) => {
    try {
      outgoing = lines(outgoing, chunk, line => {
        const message = decode(line);
        const id = key(message.id);
        const hasMethod = "method" in message;
        if (hasMethod && typeof message.method !== "string") throw new Error("Invalid MCP server method.");
        if (hasMethod && "id" in message) {
          if (!id || serverRequests.has(id) || serverRequests.size >= 512) throw new Error("Invalid MCP server request.");
          serverRequests.add(id);
        }
        const result = !hasMethod;
        if (result && (!id || !pending.has(id) || ("result" in message) === ("error" in message)))
          throw new Error("Unexpected MCP response.");
        const control = result && id ? controls.get(id) : undefined;
        if (control && id) {
          controls.delete(id);
          pending.delete(id);
          if ("error" in message) control.reject(new Error("Owned MCP control request failed."));
          else control.resolve(message.result);
          closeWhenDrained();
          return;
        }
        if (delivered >= 512) throw new Error("Too many outstanding MCP responses.");
        if (!connection || connection.destroyed) throw new Error("Owned MCP transport disconnected.");
        delivered++;
        send(connection, line, error => {
          delivered--;
          if (error) return fail("MCP response delivery failed.");
          if (result && id) pending.delete(id);
          closeWhenDrained();
        });
      });
    } catch { fail("Invalid or unbound MCP response."); }
  });
  stdout.on("error", () => fail("MCP child stdout failed."));
  stdin.on("error", () => fail("MCP child stdin failed."));
  child.on("error", () => fail("MCP child failed."));
  child.once("exit", (code, signal) => {
    if (code !== 0 || signal !== null) {
      fail("MCP child exit was not a verified drained exit.");
      connection?.destroy();
    }
  });
  child.once("close", (code, signal) => {
    if (state !== "draining" || !closing || code !== 0 || signal !== null || pending.size || serverRequests.size
      || delivered || incoming.length || outgoing.length) {
      fail("MCP child exit was not a verified drained exit.");
      connection?.destroy();
      return;
    }
    void Promise.resolve().then(verifyOwnedDescendantsExited).then(() => {
      if (state !== "draining") return;
      state = "stopped";
      if (deadline) clearTimeout(deadline);
      connection?.end();
      finish?.({ state: "stopped", pid, cutoverAuthorized: false });
    }, () => {
      fail("MCP descendant exit could not be verified.");
      connection?.destroy();
    });
  });
  return {
    attach(client: Duplex): void {
      if (state !== "accepting" || claimed || client.destroyed) throw new Error("MCP transport admission is closed.");
      claimed = true;
      connection = client;
      client.on("data", (chunk: Buffer) => {
        try {
          incoming = lines(incoming, chunk, line => {
            const message = decode(line), id = key(message.id);
            if ("method" in message && typeof message.method !== "string") throw new Error("Invalid MCP method.");
            if ("method" in message && "id" in message) {
              if (!id || pending.has(id) || pending.size >= 512) throw new Error("Invalid or duplicate MCP request ID.");
              if (state !== "accepting") {
                send(client, Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: message.id,
                  error: { code: -32000, message: "PKM MCP admission is draining; reconnect after handoff." } })));
                return;
              }
              try { assertAdmission(); }
              catch {
                send(client, Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: message.id,
                  error: { code: -32000, message: "PKM MCP authority is unavailable." } })));
                fail("MCP admission authority changed.");
                return;
              }
              pending.add(id);
            } else if ("method" in message) {
              if (!["notifications/initialized", "notifications/cancelled"].includes(message.method as string))
                throw new Error("Unsupported MCP notification has no completion receipt.");
              if (state !== "accepting" && message.method !== "notifications/cancelled") return;
            } else {
              if (!id || !serverRequests.has(id) || ("result" in message) === ("error" in message))
                throw new Error("Unexpected MCP client response.");
              if (state === "unknown" || state === "stopped") throw new Error("MCP owner is unavailable.");
              send(stdin, line, error => {
                if (error) return fail("MCP client response delivery failed.");
                serverRequests.delete(id);
                closeWhenDrained();
              });
              return;
            }
            if (state === "unknown" || state === "stopped") throw new Error("MCP owner is unavailable.");
            send(stdin, line, error => { if (error) fail("MCP request delivery failed."); });
          });
        } catch { fail("Invalid MCP client message."); }
      });
      client.on("error", () => fail("MCP transport failed."));
      client.once("close", () => { if (state !== "stopped") fail("MCP transport disconnected before retirement."); });
    },
    status() { return { state, pid, inFlight: pending.size, serverRequests: serverRequests.size,
      responseDeliveries: delivered, admitted: claimed }; },
    beginDrain(): void {
      if (state !== "accepting" || !claimed || incoming.length || outgoing.length)
        throw new Error("MCP owner or transport is not ready to drain.");
      state = "draining";
    },
    abandonDrain(): void {
      fail("MCP drain was cancelled; child exit is unknown.");
      connection?.destroy();
    },
    callLegacyLifecycleTool(name: "mcp_lifecycle_status" | "mcp_lifecycle_quiesce", signal: AbortSignal): Promise<unknown> {
      if (!["mcp_lifecycle_status", "mcp_lifecycle_quiesce"].includes(name) || !claimed
        || (state !== "accepting" && state !== "draining") || closeRequested || signal.aborted || pending.size >= 512)
        return Promise.reject(new Error("Owned MCP lifecycle control is unavailable."));
      try { assertAdmission(); } catch { fail("MCP admission authority changed."); return Promise.reject(new Error("MCP admission authority changed.")); }
      const requestId = `pkm-owned-${randomBytes(24).toString("hex")}`, id = key(requestId)!;
      pending.add(id);
      return new Promise((resolve, reject) => {
        const onAbort = () => fail("Owned MCP lifecycle outcome is unknown.");
        const done = (callback: (value: any) => void, value: unknown) => {
          signal.removeEventListener("abort", onAbort);
          callback(value);
        };
        controls.set(id, { resolve: value => done(resolve, value), reject: error => done(reject, error) });
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) { onAbort(); return; }
        send(stdin, Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: requestId,
          method: "tools/call", params: { name, arguments: {} } })), error => {
          if (error) fail("Owned MCP lifecycle request delivery failed.");
        });
      });
    },
    drainAndClose(timeoutMs = 30_000): Promise<Retired> {
      if (draining) return draining;
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000)
        return Promise.reject(new Error("Invalid MCP drain timeout."));
      if ((state !== "accepting" && state !== "draining") || !claimed || incoming.length || outgoing.length)
        return Promise.reject(new Error("MCP owner or transport is not ready to drain."));
      state = "draining";
      closeRequested = true;
      draining = new Promise((resolve, reject) => { finish = resolve; rejectDrain = reject; });
      deadline = setTimeout(() => {
        fail("MCP drain timed out; child exit is unknown.");
        connection?.destroy();
      }, timeoutMs);
      deadline.unref();
      closeWhenDrained();
      return draining;
    },
  };
}
