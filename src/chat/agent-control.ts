import * as fs from "fs";
import * as path from "path";
import { randomUUID } from "crypto";

export const API_CHAT_CONTROL_OPERATIONS = ["models", "tools", "list", "create", "get", "send", "cancel", "fixture-e2e", "portal"] as const;

export class ApiChatAgentControl {
  readonly hostId = randomUUID();
  private readonly root: string;
  private readonly requests: string;
  private readonly active = new Set<string>();
  private readonly settled = new Set<string>();
  private readonly timer: ReturnType<typeof setInterval>;
  private heartbeatAt = 0;
  private disposed = false;

  constructor(stateDirectory: string, private readonly metadata: Record<string, unknown>,
    private readonly handle: (operation: string, args: Record<string, unknown>) => Promise<unknown>) {
    this.root = path.join(stateDirectory, "api-chat-control");
    this.requests = path.join(this.root, "requests", this.hostId);
    fs.mkdirSync(this.requests, { recursive: true, mode: 0o700 });
    fs.mkdirSync(path.join(this.root, "hosts"), { recursive: true, mode: 0o700 });
    this.heartbeat();
    this.timer = setInterval(() => this.poll(), 300); this.timer.unref();
  }

  private write(destination: string, data: unknown): void {
    const temporary = destination + "." + randomUUID() + ".tmp";
    fs.writeFileSync(temporary, JSON.stringify(data), { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temporary, destination);
  }

  private heartbeat(): void {
    if (Date.now() - this.heartbeatAt < 3000) return;
    this.write(path.join(this.root, "hosts", this.hostId + ".json"), {
      ...this.metadata, schema: "pkm.api-chat.host/v1", hostId: this.hostId,
      pid: process.pid, updatedAt: Date.now(), operations: API_CHAT_CONTROL_OPERATIONS,
    });
    this.heartbeatAt = Date.now();
  }

  poll(): void {
    if (this.disposed) return;
    try {
      this.heartbeat();
      for (const name of fs.readdirSync(this.requests).filter(name => /^[a-f0-9]{64}\.json$/.test(name))) {
        if (this.active.has(name) || this.settled.has(name)) continue;
        try {
          const destination = path.join(this.requests, name);
          if (fs.statSync(destination).size > 256 * 1024) continue;
          const request = JSON.parse(fs.readFileSync(destination, "utf8"));
          if (request.status !== "queued") { this.settled.add(name); continue; }
          if (request.schema !== "pkm.api-chat.request/v1" || request.hostId !== this.hostId || request.requestId + ".json" !== name
            || !request.arguments || typeof request.arguments !== "object" || Array.isArray(request.arguments)
            || !Number.isFinite(request.expiresAt) || request.expiresAt < Date.now()) {
            this.write(destination, { ...request, status: "failed", error: "Invalid or expired request; no action was executed." });
            this.settled.add(name);
            continue;
          }
          if (this.active.size >= 16 && !["get", "cancel", "list"].includes(request.operation)) continue;
          this.active.add(name); request.status = "running"; request.startedAt = Date.now();
          this.write(destination, request);
          void Promise.resolve().then(() => this.handle(request.operation, request.arguments)).then(result => {
            this.write(destination, { ...request, status: "succeeded", completedAt: Date.now(), result });
          }, error => {
            this.write(destination, { ...request, status: "failed", completedAt: Date.now(), error: error instanceof Error ? error.message.slice(0, 1000) : "PKM Chat request failed." });
          }).catch(() => {}).finally(() => { this.active.delete(name); this.settled.add(name); });
        } catch { this.active.delete(name); }
      }
    } catch { }
  }

  dispose(): void {
    this.disposed = true; clearInterval(this.timer);
    try { fs.unlinkSync(path.join(this.root, "hosts", this.hostId + ".json")); } catch { }
  }
}