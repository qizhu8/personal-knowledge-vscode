export function estimateChatPromptTokens(
  messages: readonly { content: string; tool_calls?: unknown }[],
  tools: readonly unknown[] = [],
): number {
  let total = 32;
  for (const message of messages)
    total += Buffer.byteLength(message.content + (message.tool_calls ? JSON.stringify(message.tool_calls) : ""), "utf8") + 32;
  if (tools.length) total += Buffer.byteLength(JSON.stringify(tools), "utf8") + 32;
  return total;
}
