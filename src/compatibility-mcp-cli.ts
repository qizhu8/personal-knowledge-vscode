import { closeSync, constants, fstatSync, openSync, readFileSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { compatibilityMcpConfiguration, startCompatibilityMcp } from "./compatibility-mcp.js";
import { acquireColdCompatibilityGatewayCustody } from "./compatibility-gateway-custody.js";

const [path, pin, ...extra] = process.argv.slice(2);
let server: Awaited<ReturnType<typeof startCompatibilityMcp>> | undefined, stopping: Promise<void> | undefined;
let custody: Awaited<ReturnType<typeof acquireColdCompatibilityGatewayCustody>> | undefined;
let shutdownRequested = false;
const stop = () => {
  shutdownRequested = true;
  if (server) void (stopping ??= (async () => {
    let clean = false;
    try { await server!.close(); clean = true; }
    finally { await custody?.release(clean); }
  })()).catch(error => { console.error(error); process.exitCode = 1; });
};
process.stdin.once("end", stop);
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
try {
  if (!path || !pin || extra.length || !/^[a-f0-9]{64}$/.test(pin) || realpathSync(path) !== path)
    throw new Error("Usage: compatibility-mcp-cli.js PRIVATE_CONFIGURATION SHA256");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let bytes: Buffer;
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 16384 || stat.uid !== process.getuid?.() || stat.mode & 0o077)
      throw new Error("COMPATIBILITY_CONFIGURATION_UNSAFE");
    bytes = readFileSync(fd);
  } finally { closeSync(fd); }
  if (createHash("sha256").update(bytes).digest("hex") !== pin) throw new Error("COMPATIBILITY_CONFIGURATION_CHANGED");
  const config = compatibilityMcpConfiguration.parse(JSON.parse(bytes.toString("utf8")));
  if (process.platform === "linux") custody = await acquireColdCompatibilityGatewayCustody(config.knowledgeRoot);
  server = await startCompatibilityMcp(config);
  if (shutdownRequested || process.stdin.readableEnded) stop();
} catch (error) {
  await custody?.release(false).catch(cleanup => console.error(cleanup));
  console.error(error);
  process.exitCode = 1;
}
