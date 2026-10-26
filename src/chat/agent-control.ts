import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { randomUUID } from "crypto";

export const API_CHAT_CONTROL_OPERATIONS = ["models", "tools", "list", "create", "get", "send", "cancel", "fixture-e2e", "portal"] as const;

export class ApiChatAgentControl {
  readonly hostId = randomUUID();
  private readonly root: string;
  private readonly requests: string;
  private readonly portalRequests: string;
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
    this.portalRequests = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-portal-ipc-"));
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
      portalRequestDirectory: this.portalRequests,
    });
    this.heartbeatAt = Date.now();
  }

  poll(): void {
    if (this.disposed) return;
    try {
      this.heartbeat();
      for (const directory of [this.requests, this.portalRequests]) {
      for (const name of fs.readdirSync(directory).filter(name => /^[a-f0-9]{64}\.json$/.test(name))) {
        const destination = path.join(directory, name);
        if (this.active.has(destination) || this.settled.has(destination)) continue;
        try {
          if (fs.statSync(destination).size > 256 * 1024) continue;
          const request = JSON.parse(fs.readFileSync(destination, "utf8"));
          if (request.status !== "queued") { this.settled.add(destination); continue; }
          if (request.schema !== "pkm.api-chat.request/v1" || request.hostId !== this.hostId || request.requestId + ".json" !== name
            || !request.arguments || typeof request.arguments !== "object" || Array.isArray(request.arguments)
            || !Number.isFinite(request.expiresAt) || request.expiresAt < Date.now()) {
            this.write(destination, { ...request, status: "failed", error: "Invalid or expired request; no action was executed." });
            this.settled.add(destination);
            continue;
          }
          if ((request.operation === "portal") !== (directory === this.portalRequests)) {
            this.write(destination, { ...request, status: "failed", error: "Portal requires the live Host's temporary IPC directory. Upgrade the MCP server; no action was executed." });
            this.settled.add(destination);
            continue;
          }
          if (this.active.size >= 16 && !["get", "cancel", "list"].includes(request.operation)) continue;
          this.active.add(destination); request.status = "running"; request.startedAt = Date.now();
          this.write(destination, request);
          void Promise.resolve().then(() => this.handle(request.operation, request.arguments)).then(result => {
            if (directory === this.portalRequests && this.disposed) return;
            this.write(destination, { ...request, status: "succeeded", completedAt: Date.now(), result });
          }, error => {
            if (directory === this.portalRequests && this.disposed) return;
            this.write(destination, { ...request, status: "failed", completedAt: Date.now(), error: error instanceof Error ? error.message.slice(0, 1000) : "PKM Chat request failed." });
          }).catch(error => { console.error("PKM Chat control receipt failed:", error); }).finally(() => { this.active.delete(destination); this.settled.add(destination); });
        } catch (error) { this.active.delete(destination); console.error("PKM Chat control request failed:", error); }
      }
      }
    } catch { }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true; clearInterval(this.timer);
    try { fs.unlinkSync(path.join(this.root, "hosts", this.hostId + ".json")); } catch { }
    try {
      for (const name of fs.readdirSync(this.portalRequests)) {
        if (!/^[a-f0-9]{64}\.(json|submit\.lock)$/.test(name)) throw new Error("Unexpected temporary Portal IPC member; cleanup stopped.");
        fs.unlinkSync(path.join(this.portalRequests, name));
      }
      fs.rmdirSync(this.portalRequests);
    } catch (error) { console.error("Temporary Portal IPC cleanup failed:", error); }
  }
}