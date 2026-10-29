/** Visible, model-free trace of Portal direct commands in the bound Chat. Never sent to a model. */
export type PortalCommandState = "awaiting-approval" | "running" | "completed" | "failed" | "denied" | "cancelled" | "unknown";
export interface PortalCommandActivity {
  requestId: string;
  role: "controller" | "controlled";
  peerName: string;
  command: { program: string; arguments: string[]; cwd?: string; timeoutSeconds: number };
  state: PortalCommandState;
  result?: unknown;
  error?: string;
}
export interface PortalCommandRecord {
  requestId: string;
  role: "controller" | "controlled";
  peerName: string;
  program: string;
  arguments: string[];
  cwd?: string;
  timeoutSeconds: number;
  state: PortalCommandState;
  startedAt: string;
  updatedAt: string;
  exitCode?: number | null;
  stdout?: string;
  stderr?: string;
  detail?: string;
  truncated?: boolean;
}

export const PORTAL_COMMAND_RECORD_LIMIT = 50;
const OUTPUT_TAIL = 2000;
const STATES: PortalCommandState[] = ["awaiting-approval", "running", "completed", "failed", "denied", "cancelled", "unknown"];
const TERMINAL = new Set<PortalCommandState>(["completed", "failed", "denied", "cancelled"]);

function tail(value: unknown, limit = OUTPUT_TAIL): { text?: string; cut: boolean } {
  if (typeof value !== "string" || !value) return { cut: false };
  return value.length > limit ? { text: `…${value.slice(-limit)}`, cut: true } : { text: value, cut: false };
}

/** Upsert by requestId; terminal states are never downgraded by late or duplicate updates. */
export function recordPortalCommand(records: PortalCommandRecord[] | undefined, activity: PortalCommandActivity, now = new Date()): PortalCommandRecord[] {
  const list = (records || []).slice();
  const index = list.findIndex(item => item.requestId === activity.requestId);
  const prior = index >= 0 ? list[index] : undefined;
  if (prior && TERMINAL.has(prior.state) && !TERMINAL.has(activity.state)) return list;
  const result = activity.result && typeof activity.result === "object" ? activity.result as Record<string, unknown> : {};
  const stdout = tail(result.stdout), stderr = tail(result.stderr);
  const detail = [activity.error, typeof result.detail === "string" ? result.detail : undefined].filter(Boolean).join("\n").slice(0, 1000);
  const record: PortalCommandRecord = {
    requestId: activity.requestId,
    role: activity.role,
    peerName: activity.peerName.slice(0, 200),
    program: activity.command.program.slice(0, 1024),
    arguments: activity.command.arguments.slice(0, 32).map(arg => arg.slice(0, 4000)),
    ...(activity.command.cwd ? { cwd: activity.command.cwd.slice(0, 1024) } : {}),
    timeoutSeconds: activity.command.timeoutSeconds,
    state: activity.state,
    startedAt: prior?.startedAt || now.toISOString(),
    updatedAt: now.toISOString(),
    ...(typeof result.exitCode === "number" || result.exitCode === null ? { exitCode: result.exitCode as number | null } : prior?.exitCode !== undefined ? { exitCode: prior.exitCode } : {}),
    ...(stdout.text !== undefined ? { stdout: stdout.text } : prior?.stdout !== undefined ? { stdout: prior.stdout } : {}),
    ...(stderr.text !== undefined ? { stderr: stderr.text } : prior?.stderr !== undefined ? { stderr: prior.stderr } : {}),
    ...(detail ? { detail } : {}),
    ...(stdout.cut || stderr.cut || result.truncated === true ? { truncated: true } : {}),
  };
  if (index >= 0) list[index] = record; else list.push(record);
  return list.slice(-PORTAL_COMMAND_RECORD_LIMIT);
}

export function validPortalCommandRecords(value: unknown): value is PortalCommandRecord[] {
  return Array.isArray(value) && value.length <= PORTAL_COMMAND_RECORD_LIMIT && value.every(item => !!item && typeof item === "object"
    && /^[a-f0-9-]{36}$/.test(item.requestId) && ["controller", "controlled"].includes(item.role)
    && typeof item.peerName === "string" && item.peerName.length <= 200
    && typeof item.program === "string" && item.program.length <= 1024
    && Array.isArray(item.arguments) && item.arguments.length <= 32 && item.arguments.every((arg: unknown) => typeof arg === "string" && arg.length <= 4000)
    && (item.cwd === undefined || typeof item.cwd === "string" && item.cwd.length <= 1024)
    && Number.isSafeInteger(item.timeoutSeconds) && STATES.includes(item.state)
    && Number.isFinite(Date.parse(item.startedAt)) && Number.isFinite(Date.parse(item.updatedAt))
    && (item.exitCode === undefined || item.exitCode === null || Number.isSafeInteger(item.exitCode))
    && [item.stdout, item.stderr].every(text => text === undefined || typeof text === "string" && text.length <= OUTPUT_TAIL + 1)
    && (item.detail === undefined || typeof item.detail === "string" && item.detail.length <= 1000)
    && (item.truncated === undefined || typeof item.truncated === "boolean"))
    && new Set(value.map(item => item.requestId)).size === value.length;
}
