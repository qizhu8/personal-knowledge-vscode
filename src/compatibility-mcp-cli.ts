import { closeSync, constants, fstatSync, openSync, readFileSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { startCompatibilityMcp } from "./compatibility-mcp.js";

const [path, pin, ...extra] = process.argv.slice(2);
let server: Awaited<ReturnType<typeof startCompatibilityMcp>> | undefined, stopping: Promise<void> | undefined;
let shutdownRequested = false;
const stop = () => {
  shutdownRequested = true;
  if (server) void (stopping ??= server.close()).catch(error => { console.error(error); process.exitCode = 1; });
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
  server = await startCompatibilityMcp(JSON.parse(bytes.toString("utf8")));
  if (shutdownRequested || process.stdin.readableEnded) stop();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
