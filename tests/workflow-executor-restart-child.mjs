import { DatabaseSync } from "node:sqlite";
import { WorkflowExecutor } from "../dist/workflow-executor.js";
import { workflowExecutorAdapterKey, workflowExecutorSyntheticAdapter } from "./workflow-executor-fixtures.mjs";

const [file, root] = process.argv.slice(2);
const database = new DatabaseSync(file);
database.exec("PRAGMA busy_timeout=1000");
const host = new WorkflowExecutor(database, {
  workspaceRoot: root, ownerId: "crash-host", clock: () => 1000, leaseMs: 100,
  adapters: { [workflowExecutorAdapterKey]: workflowExecutorSyntheticAdapter(async () => {
    database.prepare("INSERT INTO synthetic_effects VALUES('one-effect')").run();
    process.send?.({ started: true });
    await new Promise(() => {});
  }) },
});
await host.tick("actor", "restart-run");
