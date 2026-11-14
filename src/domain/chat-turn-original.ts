// Exact original pure inference-round reducers; regenerate with capture-chat-turn.mjs.
export function chatToolRoundLimit(value = 30): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 1000) throw new Error("Choose a tool round limit of 1-1000.");
  return value;
}

export function chatToolRoundBudgetNotice(completedRounds: number, hardLimit?: number): string | undefined {
  if (hardLimit === undefined) return undefined;
  const limit = chatToolRoundLimit(hardLimit);
  if (!Number.isSafeInteger(completedRounds) || completedRounds < 0 || completedRounds > limit) {
    throw new Error("Completed inference rounds must be a safe integer from 0 to the hard limit.");
  }
  const remaining = limit - completedRounds;
  const budget = `Inference rounds: total=${limit}, completed=${completedRounds}, remaining=${remaining}. Remaining includes the coming inference, not calls/tools. No extra reporting allowance after the boundary.`;
  const advice = remaining === 0
    ? " Tools stopped; only summary allowed."
    : remaining <= 3
      ? " Close the current slice: explicitly save applied edits, verify saved files with focused tests, then report_work with actual evidence. Stop new edits and rereading; if checks cannot fit, report blocked with saved versus unsaved paths and unrun checks. Unverified criteria stay unverified."
      : "";
  return `${budget}${advice} Plan small saved-and-tested slices; a final model summary may not fit the input budget. Advisory only; does not change caps/guards or authorize tools, permissions or acceptance.`;
}
