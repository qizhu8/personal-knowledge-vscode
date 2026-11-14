export interface ApiChatProgressStep {
  label: string; at: number; status?: "running" | "waiting" | "complete" | "cancelled" | "failed";
  kind?: "model" | "tool"; toolCallId?: string; finishedAt?: number;
  operation?: "inference" | "token-count" | "model-access" | "retrieval" | "preparation" | "command" | "display";
}

export function settleProgressSteps(steps: ApiChatProgressStep[], next: Pick<ApiChatProgressStep, "label" | "toolCallId" | "operation">, now = Date.now()): void {
  const previous = steps[steps.length - 1];
  if (previous && ["running", "waiting"].includes(previous.status || "") && !(previous.kind === "tool" && previous.toolCallId)
    && !(previous.operation === "inference" && next.operation === "token-count")) { previous.status = "complete"; previous.finishedAt = now; }
  const outcome = next.toolCallId && /^(Completed|Failed) tool:/.exec(next.label)?.[1];
  if (outcome) for (const step of steps) if (step.toolCallId === next.toolCallId && ["running", "waiting"].includes(step.status || "")) {
    step.status = outcome === "Failed" ? "failed" : "complete"; step.finishedAt = now;
  }
}
