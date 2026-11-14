import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { RuntimeProcessService, RuntimeProcessStore } from "../dist/runtime-process.js";

const [cwd, script] = process.argv.slice(2);
const database = new DatabaseSync(`${cwd}/crash.sqlite`);
const runtime = new RuntimeProcessService({
  repositoryFactory: (owner, capacity) => new RuntimeProcessStore(database, owner, capacity),
  adapters: [{ id: "tree", executable: process.execPath, cwd, processScope: "linux-process-group",
    arguments: () => [script, cwd] }],
  authorizeLaunch: async () => true,
  limits: { graceMs: 100, deadlineMs: 10_000 },
});
const job = await runtime.launch({ actorId: "alice", operationId: randomUUID(), adapterId: "tree", input: {} });
console.log(`ready ${job.jobId} ${runtime.ownerId}`);
process.stdin.on("data", () => {
  void runtime.pause("alice", job.jobId).then(() => console.log("paused"));
});
setInterval(() => {}, 1000);
