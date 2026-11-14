import { connectManagedChatMcp, type ManagedChatMcp } from "../../legacy/src/chat/api-chat-mcp";
import { isolatedManagedLaunch } from "../../experimental/managed-launch-client.mjs";

/** Separate host-only connection; never registers or switches the production PKM service. */
export class IsolatedManagedMigration {
  private connection?: ManagedChatMcp;
  private transitioning = false;
  private transitionDone = Promise.resolve();
  private stateValue: "disconnected" | "connected" | "action-required" = "disconnected";
  private readonly controller = new AbortController();

  state() {
    return { status: this.stateValue, generation: this.connection?.generation,
      catalog: this.connection?.catalog ?? [], automaticReplay: false };
  }

  async connect(root: string): Promise<ReturnType<IsolatedManagedMigration["state"]>> {
    if (this.transitioning) throw new Error("Migration lifecycle transition is already running");
    this.transitioning = true;
    let finish!: () => void;
    this.transitionDone = new Promise<void>(resolve => { finish = resolve; });
    try {
      await this.closeOwned();
      const launch = await isolatedManagedLaunch(root);
      this.connection = await connectManagedChatMcp(launch, this.controller.signal, root);
      this.stateValue = "connected";
      return this.state();
    } finally { this.transitioning = false; finish(); }
  }

  async invoke(name: string, input: Record<string, unknown>, signal = new AbortController().signal) {
    if (this.transitioning || !this.connection || this.stateValue !== "connected") throw new Error("Migration client is not accepting calls");
    return this.connection.invoke(name, input, signal);
  }

  async close() {
    while (this.transitioning) await this.transitionDone;
    this.transitioning = true;
    let finish!: () => void;
    this.transitionDone = new Promise<void>(resolve => { finish = resolve; });
    try { await this.closeOwned(); } finally { this.transitioning = false; finish(); }
  }

  private async closeOwned() {
    if (!this.connection) { this.stateValue = "disconnected"; return; }
    try { await this.connection.close(); }
    catch (error) { this.stateValue = "action-required"; throw error; }
    this.connection = undefined;
    this.stateValue = "disconnected";
  }
}
