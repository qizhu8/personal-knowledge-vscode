/** Original explicit-new-goal syntax only. Recognition is not Task creation or execution authority. */
export function originalMcpApiChatRequestsNewTask(prompt: string): boolean {
  return /^\s*(?:开始新任务|start a new task)\s*[:：]/i.test(prompt);
}
