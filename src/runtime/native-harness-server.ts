import { createActionWorkbenchServer, ActionWorkbenchServer } from "./action-workbench-server";

export class HarnessChangeFeed {
  revision = 1;
  private disposed = false;
  private waiters = new Set<() => void>();

  changed(): void {
    this.revision++;
    for (const finish of [...this.waiters]) finish();
  }

  wait(since: unknown, timeout = 25_000): Promise<number> {
    if (this.disposed) return Promise.reject(new Error("Harness browser host is closed."));
    if (since !== this.revision) return Promise.resolve(this.revision);
    if (this.waiters.size >= 32) return Promise.reject(new Error("Too many pending Harness subscriptions."));
    return new Promise(resolve => {
      const finish = () => { clearTimeout(timer); this.waiters.delete(finish); resolve(this.revision); };
      const timer = setTimeout(finish, timeout);
      timer.unref?.();
      this.waiters.add(finish);
    });
  }

  dispose(): void { this.disposed = true; this.changed(); }
}

export async function createNativeHarnessServer(options: {
  extensionPath: string;
  sessionId: string;
  access(): void;
  request(method: "snapshot" | "result" | "memoryOverview" | "memoryPiece", params: Record<string, unknown>): Promise<unknown>;
}): Promise<ActionWorkbenchServer & { changed(): void }> {
  const feed = new HarnessChangeFeed();
  const server = await createActionWorkbenchServer({
    extensionPath: options.extensionPath,
    assets: [
      ["/", ["dist/webview/agent-harness-browser.html", "text/html; charset=utf-8"]],
      ["/agent-harness.js", ["dist/webview/agent-harness.js", "text/javascript; charset=utf-8"]],
      ["/agent-harness-browser.js", ["dist/webview/agent-harness-browser.js", "text/javascript; charset=utf-8"]],
      ["/agent-harness.css", ["dist/webview/agent-harness.css", "text/css; charset=utf-8"]],
      ["/codicon.css", ["dist/webview/codicon.css", "text/css; charset=utf-8"]],
    ],
    async request(method, params) {
      options.access();
      if (params.sessionId !== undefined && params.sessionId !== options.sessionId) throw new Error("This browser is bound to a different Session.");
      if (method === "access") return { ok: true };
      if (method === "watch") {
        const revision = await feed.wait(params.revision);
        options.access();
        return { ok: true, data: { revision } };
      }
      if (method !== "snapshot" && method !== "result" && method !== "memoryOverview" && method !== "memoryPiece") throw new Error("Unsupported read-only Harness operation.");
      return { ok: true, data: await options.request(method, { ...params, sessionId:options.sessionId }) };
    },
  });
  return { ...server, changed:() => feed.changed(), dispose() { feed.dispose(); server.dispose(); } };
}
