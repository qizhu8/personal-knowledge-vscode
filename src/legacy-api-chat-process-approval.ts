import { createHash } from "node:crypto";
import { z } from "zod";
import type { LegacyChatProcessAction, LegacyChatProcessScope } from "./legacy-api-chat-process.js";

export type LegacyChatProcessPolicy = {
  available: boolean;
  trusted: boolean;
  permissionMode?: "protective" | "ask" | "read-only" | "allow-all";
  permissionGrants?: readonly string[];
  /** True only for the owning local Chat, never a remote/agent-controlled request. */
  localControls: boolean;
};
export type LegacyChatProcessPrompt = {
  binding: LegacyChatProcessScope; scope: string; title: string; detail: string; once: boolean;
  signal?: AbortSignal;
};
const specSchema = z.strictObject({
  program: z.string().min(1).max(1024), arguments: z.array(z.string()).max(32), cwd: z.string(),
  timeoutSeconds: z.number().int().min(1).max(86400), background: z.boolean(),
});
const toolScope = (name: string) => `tool:${createHash("sha256").update(JSON.stringify(["builtin", name])).digest("hex")}`;
const outsideScope = `tool:${createHash("sha256").update(JSON.stringify(["boundary", "outside-workspace"])).digest("hex")}`;

async function cancellable<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return operation;
  if (signal.aborted) throw new Error("Chat process approval cancelled.");
  let cancel!: () => void;
  const aborted = new Promise<never>((_, reject) => {
    cancel = () => reject(new Error("Chat process approval cancelled."));
    signal.addEventListener("abort", cancel, { once: true });
  });
  try { return await Promise.race([operation, aborted]); }
  finally { signal.removeEventListener("abort", cancel); }
}

/**
 * Composable native authority boundary, not a production host or approval UI.
 * The owner supplies a live Chat policy and a user-facing permission port.
 */
export function createLegacyChatProcessApprovalBridge(options: {
  assertOwner(scope: LegacyChatProcessScope): void;
  policy(scope: LegacyChatProcessScope): Promise<LegacyChatProcessPolicy>;
  requestPermission(prompt: LegacyChatProcessPrompt): Promise<boolean>;
  confirmLocalStop(request: { binding: LegacyChatProcessScope; handle: string; record: unknown; signal?: AbortSignal }): Promise<boolean>;
}) {
  const read = async (binding: LegacyChatProcessScope, signal?: AbortSignal) => {
    if (signal?.aborted) throw new Error("Chat process approval cancelled.");
    options.assertOwner(binding);
    const policy = await cancellable(options.policy(structuredClone(binding)), signal);
    options.assertOwner(binding);
    if (!policy.available || !policy.trusted || signal?.aborted) throw new Error("Chat or trusted workspace authority is unavailable.");
    if (policy.permissionMode !== undefined && !["protective", "ask", "read-only", "allow-all"].includes(policy.permissionMode))
      throw new Error("Invalid Chat permission mode.");
    return policy;
  };
  return async (binding: LegacyChatProcessScope, action: LegacyChatProcessAction, detail: unknown, signal?: AbortSignal) => {
    let policy = await read(binding, signal);
    if (action === "process_get" || action === "process_output") return true;
    if (["pause", "resume", "chat-stop"].includes(action)) return policy.localControls;
    if (action === "stop-ui") {
      if (!policy.localControls) return false;
      const { handle, record } = z.strictObject({ handle: z.string().regex(/^process_[a-f0-9]{64}$/), record: z.unknown() }).parse(detail);
      const accepted = await cancellable(options.confirmLocalStop({ binding: structuredClone(binding), handle,
        record: structuredClone(record), signal }), signal);
      policy = await read(binding, signal);
      return accepted && policy.localControls;
    }
    if (policy.permissionMode === "read-only") return false;
    let name: string, title: string, description: string, once = false;
    if (action === "run_process") {
      const spec = specSchema.parse(detail);
      name = spec.background ? "run_process_background" : "run_process";
      once = spec.background;
      title = `Run program ${spec.program}?`;
      description = "Approval covers the command and arguments, not a content digest. Executable files, interpreters, scripts and dependencies can change.\n\n"
        + `Working directory: ${spec.cwd}\nArguments: ${JSON.stringify(spec.arguments)}\nTimeout: ${spec.timeoutSeconds}s\n`
        + (spec.background ? "\nDURABLE BACKGROUND: Chat Stop or process_cancel with the original handle cancels it. Reusing the key only recovers this execution; unknown outcomes are not retried.\n" : "")
        + "\nThis program can modify files outside this workspace and access the network. Output is sent to the model. Stdin is closed.";
    } else if (action === "process_cancel") {
      const { handle, record } = z.strictObject({ handle: z.string().regex(/^process_[a-f0-9]{64}$/), record: z.unknown() }).parse(detail);
      name = "process_cancel"; title = "Cancel this durable background process?";
      description = `Process handle: ${handle}\n${JSON.stringify(record)}\nTermination is requested; already produced effects cannot be undone.`;
    } else throw new Error("Unsupported Chat process approval action.");
    let scope = toolScope(name);
    if (!once && (!policy.permissionMode || policy.permissionMode === "protective")) {
      scope = outsideScope;
      title = "Allow tools to access resources outside this workspace?";
      description = "This grant permits the selected program to access files outside the workspace and the network. Remembered Next approvals apply only to this Chat and the exact selected program context; they do not authorize other tools or programs. Native VS Code confirmations remain independent.\n\n" + description;
    }
    if (!once && (policy.permissionMode === "allow-all" || policy.permissionGrants?.includes(scope))) return true;
    const accepted = await cancellable(options.requestPermission({ binding: structuredClone(binding), scope, title,
      detail: description.slice(0, 8000), once, signal }), signal);
    policy = await read(binding, signal);
    return accepted && policy.permissionMode !== "read-only";
  };
}
