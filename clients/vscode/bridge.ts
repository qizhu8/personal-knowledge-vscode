import { z } from "zod";
import { ClientError, type VscodeClient } from "./client.ts";
import { operations, type OperationKey } from "./contracts.ts";

export interface WebviewHost {
  // source is supplied by the host, never by the message body.
  onMessage(listener: (event: { source: object; message: unknown }) => void): { dispose(): void };
  postMessage(message: unknown): Promise<unknown>;
}
const request = z.strictObject({
  requestId: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/),
  action: z.string().max(40),
  input: z.unknown(),
});

// The channel identity is captured from the trusted host at binding time.
export function bindWebview(client: VscodeClient, host: WebviewHost, channel: object): { dispose(): void } {
  let disposed = false;
  const listener = host.onMessage(event => {
    if (disposed || event.source !== channel) return;
    const parsed = request.safeParse(event.message);
    if (!parsed.success) return;
    const { requestId, action, input } = parsed.data;
    void (async () => {
      try {
        let result: unknown;
        if (action === "state") {
          if (!z.strictObject({}).safeParse(input).success) throw new ClientError("INVALID_ARGUMENT");
          result = client.state();
        } else if (action === "retryMutation") {
          const args = z.strictObject({ operationId: z.string().uuid() }).safeParse(input);
          if (!args.success) throw new ClientError("INVALID_ARGUMENT");
          result = await client.retryMutation(args.data.operationId);
        } else {
          if (!Object.hasOwn(operations, action)) throw new ClientError("INVALID_ACTION");
          const key = action as OperationKey;
          if (!operations[key].input.safeParse(input).success) throw new ClientError("INVALID_ARGUMENT");
          const fn = client[key] as (input: never) => Promise<unknown>;
          result = await fn.call(client, input as never);
        }
        if (!disposed) await host.postMessage({ requestId, result });
      } catch (error) {
        if (!disposed) await host.postMessage({ requestId, error: {
          code: error instanceof ClientError ? error.code : "CLIENT_ERROR",
          effect: error instanceof ClientError ? error.effect : "not-committed",
        } });
      }
    })();
  });
  return { dispose() { if (!disposed) { disposed = true; listener.dispose(); } } };
}
