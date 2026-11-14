import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { attachReadOnlyMcpToAdoptedOwner } from "./adopted-root-owner-attachment.js";
import { startLegacyNoteMcp } from "./legacy-note-mcp.js";
import type { StandaloneHost } from "./standalone-host.js";

/**
 * One externally authenticated transport with a bounded original read-only MCP slice.
 * The embedding must independently revoke its MCP authority on disconnect.
 * This is not a listener, a production activation, or a writable MCP grant.
 */
export async function attachAdoptedRootReadOnlyMcp(options: {
  owner: ReturnType<StandaloneHost["ownerResourceContext"]>;
  transport: Transport;
  connection: AbortSignal;
  assertMcpAuthority(): void;
  closeConnection(): Promise<void>;
  onCloseError(error: unknown): void;
}) {
  const transportLost = new AbortController();
  const signal = AbortSignal.any([options.connection, transportLost.signal]);
  const pending = new Set<Promise<unknown>>();
  let accepting = true;
  let workerClose: Promise<void> | undefined;
  const attachment = await attachReadOnlyMcpToAdoptedOwner({
    owner: options.owner, connection: signal, assertMcpAuthority: options.assertMcpAuthority,
    onCloseError: options.onCloseError,
    async start(context) {
      const guarded: Transport = {
        get sessionId() { return options.transport.sessionId; },
        async start() {
          if (options.transport.onmessage) throw new Error("MCP transport already has a message consumer.");
          const priorClose = options.transport.onclose, priorError = options.transport.onerror;
          options.transport.onmessage = (message, extra) => {
            try { context.assertCurrent(); }
            catch { transportLost.abort(); return; }
            guarded.onmessage?.(message, extra);
          };
          options.transport.onclose = () => { try { priorClose?.(); } finally { guarded.onclose?.(); } };
          options.transport.onerror = error => { try { priorError?.(error); } finally { guarded.onerror?.(error); } };
          await options.transport.start();
        },
        send(message, sendOptions) { return options.transport.send(message, sendOptions); },
        close() { return options.transport.close(); },
        setProtocolVersion(version) { options.transport.setProtocolVersion?.(version); },
      };
      const server = await startLegacyNoteMcp(context.storage, guarded,
        { core: context.core, actor: context.actor }, {
        allowTool(name) { return name === "list_notes" || name === "legacy_knowledge_read"; },
        async invoke(_name, invoke) {
          if (!accepting || pending.size >= 16) throw new Error("MCP admission is closed or busy.");
          context.assertCurrent();
          const work = Promise.resolve().then(() => { context.assertCurrent(); return invoke(); });
          pending.add(work);
          try {
            const result = await work;
            context.assertCurrent();
            return result;
          } finally { pending.delete(work); }
        },
        trackWorkerClose(close) { workerClose = close; void close.catch(() => {}); },
      });
      const previousClose = server.server.onclose;
      server.server.onclose = () => {
        try { previousClose?.(); } finally { transportLost.abort(); }
      };
      return {
        async close() {
          accepting = false;
          await Promise.allSettled([...pending]);
          await server.close();
          await workerClose;
          await options.closeConnection();
        },
      };
    },
  });
  return Object.freeze({ close: attachment.close, get disconnectTask() { return attachment.disconnectTask; },
    get inFlight() { return pending.size; } });
}
