import { Core } from "../dist/core.js";
import { Storage } from "../dist/storage.js";
import { startHttp } from "../dist/http.js";
import { startMcp } from "../dist/mcp.js";

const transport = process.env.PKM_BATCH04_TRANSPORT;
const data = process.env.PKM_BATCH04_DATA;
const actor = {
  id: process.env.PKM_BATCH04_ACTOR_ID,
  canWrite: process.env.PKM_BATCH04_CAN_WRITE === "true",
  collaborationKind: process.env.PKM_BATCH04_COLLABORATION_KIND,
};
if (!data || !actor.id || !["http", "mcp"].includes(transport)) throw new Error("Invalid Batch 04 adapter fixture configuration.");

const storage = await Storage.open(data);
const core = new Core(storage);
let stopTransport;
try {
  if (transport === "http") {
    const { server, url } = await startHttp(core, process.env.PKM_NEXT_TOKEN, actor, 0);
    stopTransport = () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    console.log(JSON.stringify({ ready: true, transport, url }));
  } else {
    const server = await startMcp(core, actor);
    stopTransport = () => server.close();
    process.stdin.once("end", () => { void stop(); });
  }
} catch (error) {
  await storage.close();
  throw error;
}

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  try { await stopTransport(); }
  finally { await storage.close(); }
}
process.once("SIGTERM", () => { void stop(); });
process.once("SIGINT", () => { void stop(); });
