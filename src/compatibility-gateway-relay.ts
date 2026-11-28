import { startSharedManagedRelay } from "./shared-managed-relay.js";

const { PKM_SHARED_ORIGIN: origin, PKM_SHARED_SERVICE_ID: serviceId, PKM_SHARED_TOKEN: token } = process.env;
delete process.env.PKM_SHARED_TOKEN;
if (!origin || !serviceId || !token) throw new Error("Verified host relay launch required.");
await startSharedManagedRelay({ origin, serviceId, token }, "pkm");
