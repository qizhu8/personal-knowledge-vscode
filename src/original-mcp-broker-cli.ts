import { closeSync, fstatSync, writeSync } from "node:fs";
import { createHash } from "node:crypto";
import { parseArgs } from "node:util";
import { z } from "zod";
import { startOriginalMcpBroker, originalMcpBrokerAuthorizationSchema } from "./original-mcp-broker.js";
import { acquireOriginalMcpRootFence } from "./original-mcp-root.js";
import { originalMcpPlanSchema, originalMcpPrivateBytes } from "./original-mcp-root-custody.js";

async function main() {
  const [command, ...args] = process.argv.slice(2);
  const { values, tokens } = parseArgs({ args, strict: true, allowPositionals: false, tokens: true,
    options: { request: { type: "string" }, pin: { type: "string" } } });
  if (command !== "serve" || tokens.length !== 2 || !values.request || !/^[a-f0-9]{64}$/.test(values.pin ?? ""))
    throw new Error("Invalid private broker startup request.");
  const readiness = fstatSync(3);
  if (!readiness.isFIFO() && !readiness.isSocket()) throw new Error("An inherited private readiness pipe is required.");
  const bytes = originalMcpPrivateBytes(values.request, 1_048_576);
  if (createHash("sha256").update(bytes).digest("hex") !== values.pin) throw new Error("Startup request changed.");
  const file = z.strictObject({
    schema: z.literal("pkm.original-mcp-broker-request/v1"), plan: originalMcpPlanSchema,
    directory: z.string(), runtime: z.strictObject({
      node: z.strictObject({ path: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/) }),
      relay: z.strictObject({ path: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/) }),
      buildSha256: z.string().regex(/^[a-f0-9]{64}$/),
    }), manifest: z.record(z.string(), z.unknown()), authorization: originalMcpBrokerAuthorizationSchema,
  }).parse(JSON.parse(bytes.toString("utf8")));
  const writerFence = await acquireOriginalMcpRootFence(file.plan.root);
  let broker: Awaited<ReturnType<typeof startOriginalMcpBroker>> | undefined;
  try {
    broker = await startOriginalMcpBroker({ ...file, writerFence });
    writeSync(3, JSON.stringify({ schema: "pkm.original-mcp-broker-ready/v1",
      descriptorPath: broker.descriptorPath, descriptorSha256: broker.descriptorSha256 }) + "\n");
    closeSync(3);
    await new Promise<void>((ready, reject) => {
      let closing = false;
      const shutdown = () => {
        if (closing) return; closing = true;
        process.removeListener("SIGTERM", shutdown); process.removeListener("SIGINT", shutdown);
        void broker!.stop().then(ready, reject);
      };
      process.once("SIGTERM", shutdown); process.once("SIGINT", shutdown);
      void broker!.closed.then(status => {
        process.removeListener("SIGTERM", shutdown); process.removeListener("SIGINT", shutdown);
        if (status.reason === "critical-failure") reject(new Error("Broker binding was revoked."));
        else ready();
      }, reject);
    });
  } finally { if (broker) await broker.stop(); else await writerFence.release(); }
}
void main().catch(() => {
  process.stderr.write("Original MCP broker startup/shutdown refused; preserve state for operator inspection.\n");
  process.exitCode = 1;
});
