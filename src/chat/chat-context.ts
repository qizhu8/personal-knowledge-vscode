import type { ApiChatMessage } from "./api-chat-client";
import { estimateInputTokens } from "./api-chat-models";

export interface AutomaticChatContext {
  ids: string[];
  priority: number;
}

// Only automatic references are disposable. Current input, pinned context and live
// tool call/result pairs must either fit intact or fail explicitly.
export function fitChatContext(
  messages: ApiChatMessage[],
  automatic: Map<ApiChatMessage, AutomaticChatContext>,
  inputBudget: number,
  toolSchema: ApiChatMessage[] = [],
): Set<string> {
  const mandatory = messages.filter(message => !automatic.has(message));
  if (estimateInputTokens([...mandatory, ...toolSchema]) > inputBudget) {
    throw new Error("Context budget exceeded by required input, pinned context or active tool results. Reduce required context or increase the model budget.");
  }
  const selected = new Set(mandatory);
  let tokens = estimateInputTokens([...mandatory, ...toolSchema]);
  for (const message of messages.filter(message => automatic.has(message)).sort((a, b) => automatic.get(b)!.priority - automatic.get(a)!.priority)) {
    const cost = estimateInputTokens([message]) - 32;
    if (tokens + cost <= inputBudget) { selected.add(message); tokens += cost; }
  }
  messages.splice(0, messages.length, ...messages.filter(message => selected.has(message)));
  return new Set(messages.flatMap(message => automatic.get(message)?.ids || []));
}
