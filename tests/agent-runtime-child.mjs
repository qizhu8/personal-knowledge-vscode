import { database, tasks, owner, spawnArgs, transaction } from "./agent-runtime-fixtures.mjs";
import { createAgentRuntimeStore } from "../dist/agent-runtime-store.js";

const db = database(process.argv[2]);
const store = createAgentRuntimeStore(db, { tasks });
const input = spawnArgs();
const receipt = transaction(db, () => store.execute(owner, "spawn", input));
transaction(db, () => store.claimSpawn(owner, receipt.rootId));
const pending = transaction(db, () => store.execute(owner, "spawn", spawnArgs()));
console.log(JSON.stringify({ claimedId: receipt.rootId, pendingId: pending.rootId, input, receipt }));
// Abrupt process termination after commit: no shutdown handler, host execution or recovery replay.
process.exit(0);
