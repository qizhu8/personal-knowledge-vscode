import { createHash, randomUUID } from "crypto";
import type { ApiConversation } from "./api-chat-store";
import { validExecutionContext, type ChatExecutionContext } from "./execution-context";
import type { ApiChatTool } from "./api-chat-client";
import { todoReadApiNames } from "../knowledge/todo-api-contract";

export type ChatWorkflowMode = "chat" | "plan" | "execute";
export interface ChatPlanStep { id: string; title: string; dependsOn: string[]; verification: string; }
export interface ChatPlanBody {
  objective: string;
  scope: string[];
  nonGoals: string[];
  facts: string[];
  openQuestions: string[];
  risks: string[];
  steps: ChatPlanStep[];
}
export interface ChatPlan extends ChatPlanBody {
  schema: "pkm.chat.plan/v1";
  id: string;
  chatId: string;
  revision: number;
  createdAt: string;
  context: ChatExecutionContext;
  sourceDigest: string;
  contentHash: string;
  changeReason: string;
  approval?: { at: string; executionDigest: string };
}

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const text = (value: unknown, limit: number): value is string => typeof value === "string" && !!value.trim() && value.length <= limit;
const list = (value: unknown, limit = 12): value is string[] => Array.isArray(value) && value.length <= limit && value.every(item => text(item, 600));
const environment = ({ hostId, permissionMode, contextId, digest, ...context }: ChatExecutionContext) => context;
export const planReadTools = new Set([
  ...todoReadApiNames,
  "read_file", "find_files", "search_text", "list_directory", "diagnostic_logs", "session_info", "list_chats",
  "pkm_search", "pkm_read", "note_todo_read", "memory_read", "memory_record_get", "memory_record_search", "memory_record_audit", "find_actions", "process_get", "process_output", "ask_user", "get_plan", "submit_plan",
]);
const planDelegationTools = new Set(["delegate_chat", "ask_chat", "ask_session", "spawn_workers", "send_worker_message", "control_chat", "create_chat", "send_chat_message", "portal_send_task", "portal_send_command", "portal_send_files"]);
const delegatesPlanExecution = (name: string) => planDelegationTools.has(name)
  || /(?:^|_)(?:api_chat_(?:send|create|cancel)|portal_control)$/.test(name);

export function validChatPlanBody(value: unknown): value is ChatPlanBody {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const body = value as ChatPlanBody;
  if (!text(body.objective, 2000) || !list(body.scope) || !body.scope.length || !list(body.nonGoals) || !list(body.facts)
    || !list(body.openQuestions) || !list(body.risks) || !Array.isArray(body.steps) || !body.steps.length || body.steps.length > 16
    || body.steps.some(step => !step || typeof step.id !== "string" || !/^[a-z][a-z0-9-]{0,39}$/.test(step.id)
      || !text(step.title, 200) || !text(step.verification, 600) || !Array.isArray(step.dependsOn) || step.dependsOn.length > 16
      || step.dependsOn.some(id => typeof id !== "string") || new Set(step.dependsOn).size !== step.dependsOn.length)
    || new Set(body.steps.map(step => step.id)).size !== body.steps.length) return false;
  const visited = new Set<string>(), visiting = new Set<string>();
  const visit = (id: string): boolean => {
    if (visiting.has(id)) return false;
    if (visited.has(id)) return true;
    const step = body.steps.find(item => item.id === id);
    if (!step) return false;
    visiting.add(id);
    if (!step.dependsOn.every(visit)) return false;
    visiting.delete(id); visited.add(id); return true;
  };
  return body.steps.every(step => visit(step.id)) && JSON.stringify(planBody(body)).length <= 12_000;
}

function planBody(plan: ChatPlanBody): ChatPlanBody {
  return { objective: plan.objective, scope: plan.scope, nonGoals: plan.nonGoals, facts: plan.facts,
    openQuestions: plan.openQuestions, risks: plan.risks, steps: plan.steps };
}
function planHash(plan: ChatPlan): string {
  return hash({ ...planBody(plan), id: plan.id, chatId: plan.chatId, revision: plan.revision, createdAt: plan.createdAt,
    context: plan.context, sourceDigest: plan.sourceDigest, changeReason: plan.changeReason });
}
export function validChatPlans(value: unknown, chatId: string): value is ChatPlan[] {
  return Array.isArray(value) && value.length <= 32 && value.every((plan: ChatPlan, index) => plan && validChatPlanBody(plan)
    && plan.schema === "pkm.chat.plan/v1" && plan.chatId === chatId && /^[a-f0-9-]{36}$/.test(plan.id)
    && Number.isSafeInteger(plan.revision) && plan.revision > 0 && (!index || value[index - 1].revision < plan.revision)
    && typeof plan.createdAt === "string" && Number.isFinite(Date.parse(plan.createdAt)) && text(plan.changeReason, 1000)
    && validExecutionContext(plan.context) && /^[a-f0-9]{64}$/.test(plan.sourceDigest) && plan.contentHash === planHash(plan)
    && (plan.approval === undefined || plan.approval && typeof plan.approval === "object" && plan.openQuestions.length === 0 && typeof plan.approval.at === "string"
      && Number.isFinite(Date.parse(plan.approval.at)) && /^[a-f0-9]{64}$/.test(plan.approval.executionDigest)))
    && new Set(value.map(plan => plan.id)).size === value.length;
}
export function currentChatPlan(chat: ApiConversation): ChatPlan | undefined { return chat.plans?.[chat.plans.length - 1]; }
export function planSourceDigest(chat: ApiConversation): string {
  return hash({ inputs: chat.messages.filter(message => message.role === "user" && !message.planExecution && !message.workerEventIds?.length
    && !message.portalReview).slice(-32).map(message => [message.id, message.content, message.images || []]),
    context: chat.context || [], agentContext: chat.agentContext || {}, images: chat.images || [] });
}
export function assertPlanResearchSource(chat: ApiConversation, sourceDigest: string): void {
  if (planSourceDigest(chat) !== sourceDigest) throw new Error("Requirements changed during planning. Send again in Plan mode.");
}
export function submitChatPlan(chat: ApiConversation, body: unknown, context: ChatExecutionContext, changeReason: unknown): ChatPlan {
  if (!validChatPlanBody(body) || !text(changeReason, 1000) || !validExecutionContext(context)) {
    throw new Error("Provide a bounded plan with scope, facts, open questions, risks, unique acyclic steps and concrete verification for every step.");
  }
  const plan: ChatPlan = { ...structuredClone(planBody(body)), schema: "pkm.chat.plan/v1", id: randomUUID(), chatId: chat.id,
    revision: (currentChatPlan(chat)?.revision || 0) + 1, createdAt: new Date().toISOString(), context,
    sourceDigest: planSourceDigest(chat), contentHash: "", changeReason };
  plan.contentHash = planHash(plan);
  chat.plans = [...(chat.plans || []), plan].slice(-32);
  chat.workflowMode = "plan";
  return plan;
}
export function approveChatPlan(chat: ApiConversation, id: string, contentHash: string, context: ChatExecutionContext): ChatPlan {
  if (!validExecutionContext(context)) throw new Error("The execution environment is invalid.");
  if (chat.workflowMode !== "plan" && chat.workflowMode !== "execute") throw new Error("Return to Plan and review the current proposal before approving.");
  const plan = currentChatPlan(chat);
  if (!plan || plan.id !== id || plan.contentHash !== contentHash || !validChatPlans(chat.plans, chat.id)) throw new Error("The reviewed plan changed. Review its latest version before approving.");
  if (plan.openQuestions.length) throw new Error("Resolve the plan's open questions before approving implementation.");
  if (plan.sourceDigest !== planSourceDigest(chat)) throw new Error("Requirements changed after this plan was submitted. Revise the plan first.");
  if (hash(environment(plan.context)) !== hash(environment(context))) throw new Error("The plan belongs to another execution environment. Revise it in the intended environment.");
  plan.approval = { at: new Date().toISOString(), executionDigest: context.digest };
  chat.workflowMode = "execute";
  return plan;
}
export function chatPlanExecutionError(chat: ApiConversation, context: ChatExecutionContext): string | undefined {
  const plan = currentChatPlan(chat);
  if (!validExecutionContext(context) || chat.workflowMode !== "execute" || !plan?.approval || !validChatPlans(chat.plans, chat.id)
    || plan.approval.executionDigest !== context.digest || plan.sourceDigest !== planSourceDigest(chat)) {
    return "Plan execution requires local approval of the current plan and execution context. Review and approve it again.";
  }
}
export function assertChatPlanExecution(chat: ApiConversation, context: ChatExecutionContext): void {
  const error = chatPlanExecutionError(chat, context);
  if (error) throw new Error(error);
}
export function assertPlanTool(chat: ApiConversation, mode: ChatWorkflowMode, context: ChatExecutionContext, name: string): void {
  if (mode === "chat") {
    if (chat.workflowMode && chat.workflowMode !== "chat") throw new Error("Workflow changed during execution. Send again in its current mode.");
    return;
  }
  if (mode === "plan" && chat.workflowMode !== "plan") throw new Error("Plan mode changed during this response.");
  if (mode === "execute") {
    if (chat.workflowMode === "plan" && planReadTools.has(name)) return;
    assertChatPlanExecution(chat, context);
    if (delegatesPlanExecution(name)) throw new Error("A Plan approval cannot authorize another Chat or execution environment. Implement locally or revise the plan.");
  }
  if (chat.workflowMode === "plan" && !planReadTools.has(name)) throw new Error(`Plan mode cannot execute ${name}. Review and approve a plan before implementation.`);
}
export function gatePlanTools(chat: ApiConversation, mode: ChatWorkflowMode, context: ChatExecutionContext, tools: ApiChatTool[], sourceDigest?: string): ApiChatTool[] {
  const planId = currentChatPlan(chat)?.id;
  const researchSource = mode === "plan" ? sourceDigest || planSourceDigest(chat) : undefined;
  return tools.filter(tool => (mode !== "plan" || planReadTools.has(tool.name)) && (mode !== "execute" || !delegatesPlanExecution(tool.name))).map(tool => ({
    ...tool, execute: async (args, signal) => {
      if (mode !== "chat" && currentChatPlan(chat)?.id !== planId) throw new Error("A Plan was submitted. Review its current version for local approval before sending again.");
      if (researchSource) assertPlanResearchSource(chat, researchSource);
      assertPlanTool(chat, mode, context, tool.name); return tool.execute(args, signal);
    },
  }));
}
export function chatPlanPrompt(chat: ApiConversation): string {
  const mode = chat.workflowMode || "chat";
  if (mode === "chat") return "";
  const plan = currentChatPlan(chat);
  return `\nWorkflow mode: ${mode}. Plan review is separate from permissions and task completion.
${mode === "plan" ? "Research existing capabilities and prior art. Clarify scope-changing assumptions with ask_user. Do not implement, run programs, invoke Actions or delegate execution. Submit a structured plan using submit_plan; include scope/non-goals, evidence-backed facts, unresolved questions, risks, dependency-aware steps and concrete verification. Do not claim unresolved assumptions are facts. The user must review and explicitly approve before implementation."
    : "Implement only the approved plan, reuse existing capabilities and verify each step. If new evidence changes the objective, scope or approach, call submit_plan with the revised plan and changeReason BEFORE any further implementation. That revokes execution approval and returns to read-only planning. Report blockers instead of silently widening scope. Completed effects cannot be undone by a plan revision."}
${plan ? `Current plan (public reviewed artifact, not a permission grant): ${JSON.stringify(planBody(plan))}\nPlan id: ${plan.id}; revision: ${plan.revision}; hash: ${plan.contentHash}.` : "No plan has been submitted yet."}`;
}
