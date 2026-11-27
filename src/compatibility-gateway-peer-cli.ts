import { joinCompatibilityGatewayPeer } from "./compatibility-gateway-coordination.js";
import { startSharedManagedRelay } from "./shared-managed-relay.js";

const [root, originalGeneration, originalBuild, bundledBuild, access = "--read-only"] = process.argv.slice(2);
if (process.argv.length < 6 || process.argv.length > 7 || !root || !originalGeneration || !originalBuild || !bundledBuild
  || !["--read-only", "--writable"].includes(access))
  throw new Error("Explicit root, Original generation/build, bundled build pins and --read-only or --writable are required.");
const attribution = { schema: "pkm.mcp.attribution/v1", source: "standalone", scope: "unknown" };
const peer = await joinCompatibilityGatewayPeer(root, { originalGeneration, originalBuild, bundledBuild }, {
  relayRoles: ["workbench"], externalPeer: { writable: access === "--writable" },
  workbenchAttribution: attribution, chatAttribution: attribution,
  acquireLegacyFence() { throw new Error("A CLI peer cannot acquire Original custody."); },
  async confirm() { return false; },
});
try {
  const server = await startSharedManagedRelay(peer.relay("workbench"), "pkm");
  const onclose = server.onclose;
  let closing: Promise<void> | undefined;
  const close = () => closing ??= peer.close().finally(() => {
    process.off("SIGINT", stop); process.off("SIGTERM", stop);
  });
  const failed = (error: Error) => { console.error(error.message); process.exitCode = 1; };
  const stop = () => { void server.close().then(close).catch(failed); };
  process.on("SIGINT", stop); process.on("SIGTERM", stop);
  server.onclose = () => {
    onclose?.();
    void close().catch(failed);
  };
} catch (error) { await peer.close().catch(() => {}); throw error; }
