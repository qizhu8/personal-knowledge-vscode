import { randomUUID } from "node:crypto";
import type { LegacyChatProcessScope } from "./legacy-api-chat-process.js";
import type { LegacyChatProcessPolicy, LegacyChatProcessPrompt } from "./legacy-api-chat-process-approval.js";

type Choice = "approve" | "approve-once" | "deny" | "allow-all";
type Pending = {
  id: string; binding: LegacyChatProcessScope; title: string; detail: string; scope: string;
  once: boolean; kind: "permission" | "stop"; signal?: AbortSignal;
  deciding?: boolean;
  resolve(value: boolean): void;
};
const sameBinding = (a: LegacyChatProcessScope, b: LegacyChatProcessScope) =>
  a.root === b.root && a.workspaceId === b.workspaceId && a.actorId === b.actorId
  && a.sourceFingerprint === b.sourceFingerprint && a.namespace === b.namespace && a.chatId === b.chatId;

/** In-memory user decisions for an explicitly composed, live owner; never an ownership grant. */
export class LegacyChatProcessApprovalUi {
  private readonly pending = new Map<string, Pending>();
  private closed = false;
  constructor(private readonly owner: {
    assertOwner(binding: LegacyChatProcessScope): void;
    policy(binding: LegacyChatProcessScope): Promise<LegacyChatProcessPolicy>;
    remember(binding: LegacyChatProcessScope, scope: string, choice: "approve" | "allow-all"): Promise<void>;
  }) {}
  private async check(binding: LegacyChatProcessScope) {
    if (this.closed) throw new Error("Chat approval UI is closed.");
    this.owner.assertOwner(binding);
    const policy = await this.owner.policy(structuredClone(binding));
    this.owner.assertOwner(binding);
    if (this.closed || !policy.available || !policy.trusted) throw new Error("Chat approval authority is unavailable.");
    return policy;
  }
  private async request(item: Omit<Pending, "id" | "resolve">): Promise<boolean> {
    const policy = await this.check(item.binding);
    if (item.signal?.aborted || (item.kind === "stop" && !policy.localControls)
      || (item.kind === "permission" && policy.permissionMode === "read-only"))
      return false;
    if (this.pending.size >= 32) throw new Error("Too many pending Chat approvals.");
    const id = randomUUID();
    return new Promise<boolean>(resolve => {
      const finish = (answer: boolean) => {
        if (!this.pending.delete(id)) return;
        item.signal?.removeEventListener("abort", cancel);
        resolve(answer);
      };
      const cancel = () => finish(false);
      this.pending.set(id, { ...item, id, resolve: finish });
      item.signal?.addEventListener("abort", cancel, { once: true });
      if (item.signal?.aborted) cancel();
    });
  }
  readonly requestPermission = (prompt: LegacyChatProcessPrompt) => this.request({
    ...prompt, kind: "permission",
  });
  readonly confirmLocalStop = (request: {
    binding: LegacyChatProcessScope; handle: string; record: unknown; signal?: AbortSignal;
  }) => this.request({
    binding: request.binding, signal: request.signal, scope: "stop-ui", once: true, kind: "stop",
    title: "Stop this background process?",
    detail: `Process handle: ${request.handle}\n${JSON.stringify(request.record).slice(0, 8000)}\n`
      + "Control covers the managed process group; detached descendants may continue. Effects cannot be undone.",
  });
  async list(binding: LegacyChatProcessScope) {
    await this.check(binding);
    return [...this.pending.values()].filter(item => sameBinding(item.binding, binding))
      .map(({ id, title, detail, scope, once, kind }) => ({ id, title, detail, scope, once, kind }));
  }
  async decide(binding: LegacyChatProcessScope, id: string, choice: Choice) {
    let policy = await this.check(binding);
    const item = this.pending.get(id);
    if (!item || item.deciding || !sameBinding(item.binding, binding) || item.signal?.aborted)
      throw new Error("This Chat approval is no longer pending.");
    if (!["approve", "approve-once", "deny", "allow-all"].includes(choice)
      || item.once && choice === "allow-all" || item.kind === "stop" && !["approve", "deny"].includes(choice))
      throw new Error("Invalid Chat approval decision.");
    item.deciding = true;
    try { if (choice !== "deny") {
      if (item.kind === "stop" && !policy.localControls || item.kind === "permission" && policy.permissionMode === "read-only")
        throw new Error("Chat approval authority changed.");
      if (!item.once && (choice === "approve" || choice === "allow-all")) {
        await this.owner.remember(structuredClone(binding), item.scope, choice);
        policy = await this.check(binding);
      }
      if (item.signal?.aborted || this.pending.get(id) !== item
        || item.kind === "stop" && !policy.localControls || item.kind === "permission" && policy.permissionMode === "read-only")
        throw new Error("Chat approval authority changed.");
    }
    item.resolve(choice !== "deny");
    } finally { item.deciding = false; }
  }
  close() {
    this.closed = true;
    for (const item of this.pending.values()) item.resolve(false);
  }
}
