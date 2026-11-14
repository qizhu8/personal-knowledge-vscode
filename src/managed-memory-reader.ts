import { CoreError } from "./contracts.js";
import { scanMarkdown } from "./markdown.js";
import { assertMemoryReceiptScope, planMemory } from "./memory.js";
import { sha256 } from "./file-write.js";
import { memoryDefinitions } from "./memory-contracts.js";
import { continuityScope, openMemoryContinuitySnapshot } from "./memory-scope-continuity.js";

/** Uses the native Markdown planner and exact native receipts; never creates a second store or new write. */
export async function readManagedMemory(root: string, operation: string, input: Record<string, unknown>) {
  if (!continuityScope(root)) throw new CoreError("NOT_AVAILABLE", "This process has no active exact Memory host admission.");
  const replay = operation === "memory-replay";
  const action = replay ? input.operation : `memory.record.${operation.slice("memory-".length)}`;
  const definition = memoryDefinitions.find(item => item.id === action);
  if (!definition || replay === definition.readOnly) throw new CoreError("NOT_AVAILABLE", "Only native Memory reads and existing receipt replay are available.");
  const parsed = definition.input.parse(replay ? input.arguments : input);
  const actorId = "local:owner";
  if (replay) {
    const database = openMemoryContinuitySnapshot(root);
    try {
      const row = database.prepare("SELECT fingerprint,result FROM receipts WHERE operation_id=?").get(String("operation_id" in parsed ? parsed.operation_id : ""));
      const fingerprint = sha256(JSON.stringify({ operation: action, actorId, args: parsed }));
      if (!row) throw new CoreError("NOT_AVAILABLE", "No imported receipt exists; a new write is not permitted.");
      if (row.fingerprint !== fingerprint) throw new CoreError("CONFLICT", "Memory operation digest or actor differs.");
      const result: unknown = JSON.parse(String(row.result));
      assertMemoryReceiptScope(root, actorId, result);
      return definition.output.parse(result);
    } finally { database.close(); }
  }
  const plan = planMemory(root, await scanMarkdown(root), { operation: String(action), args: parsed, actorId });
  if ("write" in plan) throw new CoreError("NOT_AVAILABLE", "Memory migration attachment is read-only.");
  return definition.output.parse(plan.result);
}
