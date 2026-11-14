import { Storage } from "../dist/storage.js";
import { createNativeRuntime } from "../dist/native-runtime.js";
import { startMcp } from "../dist/mcp.js";
import { managerActor, syntheticManager } from "./batch06-manager-fixtures.mjs";

const [root] = process.argv.slice(2);
if (!root) throw new Error("A disposable fixture root is required.");
const storage = await Storage.open(root, { deferRecovery: true });
const managers = new Map(["feature", "research", "cleanup", "small"].map(kind => [kind, syntheticManager(kind, kind === "small" ? 1 : 3)]));
const base = managers.get("feature");
const runtime = await createNativeRuntime({
  storage, manager: { ...base.config, host: {
    ...base.host,
    plan: input => managers.get(input.runId.replace("matrix-", "")).host.plan(input),
  } },
});
const server = await startMcp(runtime.core, managerActor);
let closing;
const close = () => closing ??= (async () => { await server.close(); await runtime.close(); await storage.close(); })();
process.stdin.once("end", () => { void close(); });
process.once("SIGTERM", () => { void close(); });
