import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer, type ServerOptions } from "node:https";
import { isIP, type AddressInfo } from "node:net";

type BrowserRoute = (request: IncomingMessage, response: ServerResponse) => Promise<boolean>;

/** Deliberately serves only the browser route, never the loopback MCP or management API. */
export async function startBrowserHttpsListener(options: {
  address: string;
  port: number;
  tls: Pick<ServerOptions, "cert" | "key">;
  route: BrowserRoute;
}) {
  if (!isIP(options.address) || !Number.isInteger(options.port) || options.port < 0 || options.port > 65535 ||
      !options.tls.cert || !options.tls.key) throw new Error("An explicit HTTPS address, port and TLS identity are required.");
  let accepting = true;
  let closeWork: Promise<void> | undefined;
  const server = createServer({
    cert: options.tls.cert, key: options.tls.key, minVersion: "TLSv1.2",
    handshakeTimeout: 10_000, headersTimeout: 10_000, requestTimeout: 30_000, keepAliveTimeout: 5_000,
  }, async (req, res) => {
    const reply = (status: number) => res.writeHead(status, { "Cache-Control": "no-store" }).end();
    if (!accepting) { reply(503); return; }
    if (req.url !== "/webview" && !req.url?.startsWith("/webview/")) { reply(404); return; }
    try {
      if (!await options.route(req, res)) reply(404);
    } catch {
      if (res.headersSent) res.destroy();
      else reply(503);
    }
  });
  server.maxHeadersCount = 50;
  server.maxConnections = 64;
  await new Promise<void>((resolve, reject) => {
    const failed = (error: Error) => reject(error);
    server.once("error", failed);
    server.listen(options.port, options.address, () => {
      server.off("error", failed);
      resolve();
    });
  });
  return {
    port: (server.address() as AddressInfo).port,
    close() {
      accepting = false;
      return closeWork ??= new Promise<void>((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
        server.closeIdleConnections();
      });
    },
  };
}
