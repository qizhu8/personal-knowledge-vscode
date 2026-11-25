import { parseArgs } from "node:util";
import { originalMcpBrokerError, readOriginalMcpServerStatus, runOriginalMcpRelay } from "./original-mcp-relay.js";

async function main() {
  const [command, ...args] = process.argv.slice(2);
  const { values, tokens } = parseArgs({ args, options: {
    descriptor: { type: "string" }, pin: { type: "string" },
  }, strict: true, allowPositionals: false, tokens: true });
  if (!["relay", "status"].includes(command ?? "") || tokens.length !== 2 || !values.descriptor || !values.pin) originalMcpBrokerError();
  if (command === "status") process.stdout.write(JSON.stringify(await readOriginalMcpServerStatus(values.descriptor, values.pin)) + "\n");
  else await runOriginalMcpRelay(values.descriptor, values.pin);
}
void main().catch(() => {
  process.stderr.write("Original MCP broker unavailable; no call was replayed.\n");
  process.exitCode = 1;
});
