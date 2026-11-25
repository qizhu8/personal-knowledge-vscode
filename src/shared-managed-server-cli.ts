import { parseArgs } from "node:util";
import { startSharedManagedServer } from "./shared-managed-server.js";

const { values } = parseArgs({ options: {
  directory: { type: "string" }, root: { type: "string" }, port: { type: "string" },
  "backend-kind": { type: "string" },
}, strict: true, allowPositionals: false });
const token = process.env.PKM_SHARED_TOKEN, managementToken = process.env.PKM_SHARED_MANAGEMENT_TOKEN;
delete process.env.PKM_SHARED_TOKEN;
delete process.env.PKM_SHARED_MANAGEMENT_TOKEN;
if (!values.directory || !values.root || !token || !managementToken
  || values["backend-kind"] !== undefined && !["native-public-mcp", "standalone-core"].includes(values["backend-kind"])
  || values.port !== undefined && (!/^\d+$/.test(values.port) || Number(values.port) > 65535))
  throw new Error("Usage: shared-managed-server-cli --directory <workspace>/server-data/runtime-control/shared-manager --root <isolated-managed-root> [--port N]; provision separate PKM_SHARED_TOKEN and PKM_SHARED_MANAGEMENT_TOKEN. Separated storage is required.");
const service = await startSharedManagedServer({ directory: values.directory, managedRoot: values.root,
  token, managementToken, port: values.port === undefined ? 0 : Number(values.port),
  backendKind: values["backend-kind"] as "native-public-mcp" | "standalone-core" | undefined });
console.log(JSON.stringify({ origin: service.url, ...service.status() }));
const stop = () => { void service.close().catch(error => { console.error(error); process.exitCode = 1; }); };
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
