export interface PortalObservation {
  requestId: string;
  chatId: string;
  at: number;
  receivedAt?: number;
  sequence: number;
  state: "running" | "waiting-approval" | "waiting-input" | "completed" | "failed" | "cancelled" | "restricted";
  stage?: string;
  answer?: string;
  tools?: Array<{ name: string; status: string; output?: string; outputWithheld?: boolean }>;
  approvals?: Array<{ title: string }>;
  error?: string;
  visibility: "task-only" | "restricted";
}

export const PORTAL_TOOL_OUTPUT_LIMIT = 1500;
export const PORTAL_TOOL_OUTPUT_TOTAL = 12000;

/** Keep the most recent tool outputs within per-tool and total budgets so observations stay well under the peer frame limit. */
export function boundPortalToolOutputs<T extends { output?: string }>(tools: T[]): T[] {
  let budget = PORTAL_TOOL_OUTPUT_TOTAL;
  const bounded = tools.map(tool => ({ ...tool }));
  for (let index = bounded.length - 1; index >= 0; index--) {
    const output = bounded[index].output;
    if (output === undefined) continue;
    const limit = Math.min(PORTAL_TOOL_OUTPUT_LIMIT, budget);
    if (limit < 80) { delete bounded[index].output; continue; }
    const text = output.length > limit ? `${output.slice(0, limit - 20)}\n… [truncated]` : output;
    bounded[index].output = text;
    budget -= text.length;
  }
  return bounded;
}

export function parsePortalObservation(value: unknown): PortalObservation {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Portal observation.");
  const item = value as Record<string, unknown>;
  if (typeof item.requestId !== "string" || !/^[a-f0-9-]{36}$/.test(item.requestId)
    || typeof item.chatId !== "string" || !/^[a-f0-9-]{36}$/.test(item.chatId)
    || !Number.isSafeInteger(item.sequence) || Number(item.sequence) < 0
    || typeof item.at !== "number" || !Number.isFinite(item.at) || item.at < 0
    || !["running", "waiting-approval", "waiting-input", "completed", "failed", "cancelled", "restricted"].includes(String(item.state))
    || !["task-only", "restricted"].includes(String(item.visibility))) throw new Error("Invalid Portal observation identity/state.");
  for (const field of ["stage", "answer", "error"]) {
    if (item[field] !== undefined && (typeof item[field] !== "string" || String(item[field]).length > 12000)) throw new Error("Invalid Portal observation text.");
  }
  if (item.tools !== undefined && (!Array.isArray(item.tools) || item.tools.length > 100 || item.tools.some(tool =>
    !tool || typeof tool !== "object" || typeof tool.name !== "string" || tool.name.length > 512 || typeof tool.status !== "string" || tool.status.length > 100
    || tool.output !== undefined && (typeof tool.output !== "string" || tool.output.length > PORTAL_TOOL_OUTPUT_LIMIT)
    || tool.outputWithheld !== undefined && typeof tool.outputWithheld !== "boolean"))) throw new Error("Invalid Portal tool observation.");
  if (Array.isArray(item.tools) && item.tools.reduce((total: number, tool: { output?: string }) => total + (tool.output?.length || 0), 0) > PORTAL_TOOL_OUTPUT_TOTAL) throw new Error("Portal tool output exceeds the mirror budget.");
  if (item.approvals !== undefined && (!Array.isArray(item.approvals) || item.approvals.length > 32 || item.approvals.some(approval =>
    !approval || typeof approval !== "object" || typeof approval.title !== "string" || approval.title.length > 1000))) throw new Error("Invalid Portal approval observation.");
  if (item.visibility === "restricted") return { requestId: item.requestId, chatId: item.chatId,
    sequence: Number(item.sequence), at: item.at, state: "restricted", visibility: "restricted" };
  return {
    requestId: item.requestId, chatId: item.chatId, sequence: Number(item.sequence), at: item.at,
    state: item.state as PortalObservation["state"], visibility: item.visibility as PortalObservation["visibility"],
    ...(typeof item.stage === "string" ? { stage: item.stage } : {}),
    ...(typeof item.answer === "string" ? { answer: item.answer } : {}),
    ...(typeof item.error === "string" ? { error: item.error } : {}),
    ...(Array.isArray(item.tools) ? { tools: item.tools.map(tool => ({ name: String(tool.name), status: String(tool.status),
      ...(typeof tool.output === "string" ? { output: tool.output } : {}), ...(tool.outputWithheld === true ? { outputWithheld: true } : {}) })) } : {}),
    ...(Array.isArray(item.approvals) ? { approvals: item.approvals.map(approval => ({ title: String(approval.title) })) } : {}),
  };
}
