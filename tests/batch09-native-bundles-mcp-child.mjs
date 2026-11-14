import { Storage } from "../dist/storage.js";
import { createNativeRuntime } from "../dist/native-runtime.js";
import { startMcp } from "../dist/mcp.js";

const [root, serialized] = process.argv.slice(2);
const fixture = JSON.parse(serialized);
const storage = await Storage.open(root, { deferRecovery: true });
const runtime = await createNativeRuntime({
  storage,
  subscriptionBundle: {
    endpoint: fixture.endpoint, stagingRoot: fixture.stagingRoot, codecStagingRoot: fixture.codecStagingRoot,
    secrets: { async resolve() { throw new Error("MCP receipt replay must not request proof"); } },
    nativeHost: {
      async authorize() { return fixture.authority; },
      async resolveKeys() { throw new Error("MCP receipt replay must not request keys"); },
    },
    nativePolicy: {
      async authorize(binding) {
        if (binding.actorId !== fixture.actor.id || JSON.stringify(binding.source) !== JSON.stringify(fixture.source)
          || binding.ciphertextSha256 !== fixture.ciphertextSha256 || binding.plaintextSha256 !== fixture.plaintextSha256)
          throw new Error("Synthetic native MCP authority denied");
        return fixture.authority;
      },
    },
    async authorizeTransfer() { return fixture.transfer; },
  },
});
const server = await startMcp(runtime.core, fixture.actor);
let closing;
const close = () => closing ??= (async () => { await server.close(); await runtime.close(); await storage.close(); })();
process.stdin.once("end", () => { void close(); });
process.once("SIGTERM", () => { void close(); });
