import { CoreError } from "../contracts.js";
import type { WorkflowCronTriggerV1 } from "./project-recipes-workflow-contracts.js";

/** Check an explicitly consented UTC minute against the definition's five local-time fields.
 * No next-run generation, calendar scanning, persistent daemon or implicit missed-slot replay.
 */
export function assertWorkflowCronSlot(trigger: WorkflowCronTriggerV1, dueAt: number): void {
  const invalid = (): never => { throw new CoreError("INVALID_ARGUMENT", "Invalid cron expression, timezone or due slot."); };
  if (dueAt % 60_000 !== 0) invalid();
  const ranges = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]] as const;
  const fields = trigger.expression.trim().split(/\s+/);
  if (fields.length !== 5 || trigger.expression.length > 256) invalid();
  const sets = fields.map((field, index) => {
    const [min, max] = ranges[index]!;
    const values = new Set<number>();
    for (const part of field.split(",")) {
      const match = /^(\*|[0-9]+(?:-[0-9]+)?)(?:\/([0-9]+))?$/.exec(part);
      if (!match) invalid();
      const stride = match![2] === undefined ? 1 : Number(match![2]);
      const span = match![1] === "*" ? [min, max] : match![1]!.split("-").map(Number);
      const start = span[0]!, end = span[1] ?? (match![2] ? max : start);
      if (!Number.isSafeInteger(stride) || stride < 1 || stride > max - min + 1
        || start < min || end > max || start > end) invalid();
      for (let value = start; value <= end; value += stride) values.add(index === 4 && value === 7 ? 0 : value);
    }
    return values;
  });
  let parts: Record<string, string>;
  try { parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: trigger.timezone,
    hourCycle: "h23", minute: "2-digit", hour: "2-digit", day: "2-digit", month: "2-digit", weekday: "short" })
    .formatToParts(dueAt).map(part => [part.type, part.value])); } catch { return invalid(); }
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.weekday!);
  const day = sets[2]!.has(Number(parts.day)), week = sets[4]!.has(weekday);
  const dayMatch = fields[2]!.startsWith("*") ? week : fields[4]!.startsWith("*") ? day : day || week;
  if (!sets[0]!.has(Number(parts.minute)) || !sets[1]!.has(Number(parts.hour))
    || !sets[3]!.has(Number(parts.month)) || !dayMatch) invalid();
}
