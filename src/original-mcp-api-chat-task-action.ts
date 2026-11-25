import type { DatabaseSync } from "node:sqlite";
import { CoreError } from "./host-composition-legacy-batch15-errors.js";
import { originalNativeChatDigest } from "./original-mcp-api-chat-contracts.js";
import { originalManagedTaskActionStartedInput } from "./original-mcp-api-chat-task-execution-contracts.js";
import { recordWorkGoalTransition, validWorkGoal } from "./managed-chat-task-original.js";

const semantic = new Set(["session_info", "report_work", "record_harness", "finish_debug"]);

/** Called only inside the existing, admission-guarded Task worker transaction; owns no connection or receipt. */
export function applyOriginalManagedTaskActionStarted(db: DatabaseSync, guard: {
  taskId: string; actorId: string; attemptId: string; requestId: string;
}, input: unknown) {
  if (!db.isTransaction) throw new CoreError("TRANSACTION_REQUIRED", "Task action transition requires the owning worker transaction.");
  const args = originalManagedTaskActionStartedInput.parse(input);
  const row = db.prepare(`SELECT t.goal,t.status,t.current_attempt_id,a.status AS attempt_status,a.plan_sha256,
    n.status AS native_status,n.plan,n.current_inference,n.round FROM managed_chat_tasks t
    JOIN managed_chat_task_attempts a ON a.task_id=t.task_id JOIN original_native_chat_executions n ON n.request_id=a.request_id
    WHERE t.task_id=? AND t.actor_id=? AND a.attempt_id=? AND a.request_id=?`)
    .get(guard.taskId, guard.actorId, guard.attemptId, guard.requestId);
  const events = db.prepare(`SELECT payload FROM original_native_chat_events WHERE request_id=? AND type='tool-intent'
    AND json_extract(payload,'$.callId')=?`).all(guard.requestId, args.callId);
  if (!row || row.status !== "active" || row.current_attempt_id !== guard.attemptId || row.attempt_status !== "bound"
    || row.native_status !== "running" || events.length !== 1)
    throw new CoreError("NATIVE_AUTHORITY_REQUIRED", "A current bound Task and one actual native business-tool intent are required.");
  const plan = JSON.parse(String(row.plan)), intent = JSON.parse(String(events[0].payload));
  const inference = db.prepare(`SELECT authorized FROM original_native_chat_inferences WHERE request_id=? AND inference_id=?`)
    .get(guard.requestId, intent.inferenceId);
  const terminal = db.prepare(`SELECT 1 FROM original_native_chat_events WHERE request_id=? AND type IN ('tool-result','tool-failed')
    AND json_extract(payload,'$.callId')=?`).get(guard.requestId, args.callId);
  if (originalNativeChatDigest(plan) !== row.plan_sha256 || plan.requestId !== guard.requestId
    || !plan.managedTask || plan.managedTask.taskId !== guard.taskId || plan.managedTask.attemptId !== guard.attemptId
    || intent.inferenceId !== row.current_inference || intent.round !== row.round || inference?.authorized !== 1 || terminal
    || semantic.has(intent.name) || !plan.tools.some((tool: { name: string }) => tool.name === intent.name)
    || originalNativeChatDigest(intent.arguments) !== intent.argumentsSha256)
    throw new CoreError("NATIVE_AUTHORITY_REQUIRED", "The action-start transition must precede its exact current native business tool.");
  const goal = JSON.parse(String(row.goal));
  if (!validWorkGoal(goal)) throw new CoreError("STATE_CORRUPT", "The actual Task work goal is corrupt.");
  if (goal.status === "paused" || goal.status === "interrupted")
    throw new CoreError("NATIVE_AUTHORITY_REQUIRED", "An interrupted Task cannot be rearmed by a model proposal.");
  if (goal.status !== "active") {
    const next = recordWorkGoalTransition({ ...goal, reason: undefined,
      acceptance: goal.acceptance.map(item => ({ ...item, verified: false, evidenceCallIds: [] })) }, "active", "agent_started_action");
    db.prepare("UPDATE managed_chat_tasks SET goal=? WHERE task_id=? AND actor_id=?")
      .run(JSON.stringify(next), guard.taskId, guard.actorId);
  }
}
