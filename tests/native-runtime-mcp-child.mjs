import { writeFile } from "node:fs/promises";
import { Storage } from "../dist/storage.js";
import { startMcp } from "../dist/mcp.js";
import { nativeActor, openNativeRuntime } from "./native-runtime-fixtures.mjs";

const [root, actorId, counterPath] = process.argv.slice(2);
if (!root || !actorId || !counterPath) throw new Error("Usage: native-runtime-mcp-child.mjs <workspace> <actor> <counter-file>");

const storage = await Storage.open(root);
const configured = await openNativeRuntime(storage, {
  onOpen: async (_request, count) => writeFile(counterPath, String(count), { mode: 0o600 }),
});
const server = await startMcp(configured.core, { ...nativeActor, id: actorId });
let closing;
async function close() {
  if (closing) return closing;
  closing = (async () => {
    await server.close();
    await configured.runtime.close();
    await storage.close();
  })();
  return closing;
}
process.stdin.once("end", () => { void close().catch(error => { console.error(error); process.exitCode = 1; }); });
process.once("SIGTERM", () => { void close().catch(error => { console.error(error); process.exitCode = 1; }); });
