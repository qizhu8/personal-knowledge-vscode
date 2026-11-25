import { createHash } from "node:crypto";
import { parseArgs } from "node:util";
import { z } from "zod";
import { captureOriginalMcpCustody } from "./original-mcp-root.js";
import { originalMcpLimits, originalMcpPrivateBytes } from "./original-mcp-root-custody.js";

const requestSchema = z.strictObject({
  schema: z.literal("pkm.original-mcp-custody-capture/v1"),
  root: z.string(), backup: z.string(), operatorId: z.string().min(1).max(128),
  profileSha256: z.string().regex(/^[a-f0-9]{64}$/), limits: originalMcpLimits,
  preserveOpaquePrompts: z.literal(true).optional(),
});
async function main() {
  const [command, ...args] = process.argv.slice(2);
  const { values, tokens } = parseArgs({ args, strict: true, allowPositionals: false, tokens: true,
    options: { request: { type: "string" }, pin: { type: "string" } } });
  if (command !== "capture" || tokens.length !== 2 || !values.request || !/^[a-f0-9]{64}$/.test(values.pin ?? ""))
    throw new Error("Use capture --request <private-reviewed-request> --pin <sha256>.");
  const bytes = originalMcpPrivateBytes(values.request, 65_536);
  if (createHash("sha256").update(bytes).digest("hex") !== values.pin) throw new Error("Reviewed custody capture request changed.");
  const { schema: _schema, ...request } = requestSchema.parse(JSON.parse(bytes.toString("utf8")));
  const plan = await captureOriginalMcpCustody(request);
  process.stdout.write(JSON.stringify(plan) + "\n");
}
void main().catch(error => {
  process.stderr.write(`Original custody capture refused: ${error instanceof Error ? error.message : "invalid request"}\n`);
  process.exitCode = 1;
});
