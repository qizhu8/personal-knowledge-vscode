import { createServer, Server, IncomingMessage, ServerResponse } from "http";
import { networkInterfaces } from "os";
import { randomBytes } from "crypto";
import { skillList, skillGet, noteExport } from "./filestore";
import { promptExport, scriptExport, packageExport } from "./storage";

export interface SyncSession {
  id:           string;
  username:     string;
  password:     string;
  url:          string;
  expires:      Date;
  enabled:      boolean;
  contentTypes: string[];
  selected: {
    skills:   string[];   // names,          empty = all
    notes:    string[];   // slugs,          empty = all
    prompts:  string[];   // "project/task", empty = all
    scripts:  string[];   // "cat/file",     empty = all
    packages: string[];   // names,          empty = all
  };
  created:      Date;
}

class SyncServer {
  private server:   Server | null = null;
  private sessions: Map<string, SyncSession> = new Map(); // keyed by username
  private _port     = 0;

  get port(): number { return this._port; }
  get isRunning(): boolean { return !!this.server; }

  activeSessions(): SyncSession[] {
    const now = new Date();
    return [...this.sessions.values()].filter(s => s.enabled && s.expires > now);
  }

  allSessions(): SyncSession[] {
    return [...this.sessions.values()];
  }

  async ensureStarted(port: number): Promise<void> {
    if (this.server) return;
    await new Promise<void>((resolve, reject) => {
      this.server = createServer((req, res) => this.handle(req, res));
      this.server.listen(port, "0.0.0.0", () => {
        this._port = (this.server!.address() as any).port;
        resolve();
      });
      this.server.on("error", reject);
    });
    // Sweep expired sessions every minute
    setInterval(() => this.sweep(), 60_000).unref();
  }

  createSession(selected: SyncSession["selected"], contentTypes: string[], expiresMinutes: number): SyncSession {
    const username = randomBytes(4).toString("hex");
    const password = randomBytes(10).toString("hex");
    const now      = new Date();
    const expires  = new Date(Date.now() + expiresMinutes * 60_000);
    const ip       = SyncServer.localIp();
    const session: SyncSession = {
      id: randomBytes(4).toString("hex"),
      username, password,
      url: `http://${ip}:${this._port}`,
      expires, enabled: true,
      contentTypes,
      selected,
      created: now,
    };
    this.sessions.set(username, session);
    // Auto-disable on expiry
    setTimeout(() => {
      const s = this.sessions.get(username);
      if (s) s.enabled = false;
    }, expiresMinutes * 60_000).unref();
    return session;
  }

  revokeSession(id: string): boolean {
    for (const [, s] of this.sessions) {
      if (s.id === id) { s.enabled = false; return true; }
    }
    return false;
  }

  private sweep(): void {
    const now = new Date();
    for (const [key, s] of this.sessions) {
      if (!s.enabled || s.expires < now) this.sessions.delete(key);
    }
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    res.setHeader("Access-Control-Allow-Origin", "*");

    if (req.method === "GET" && req.url === "/sync/ping") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, active: this.activeSessions().length }));
      return;
    }

    // All other routes require Basic Auth
    const auth = req.headers["authorization"] ?? "";
    if (!auth.startsWith("Basic ")) {
      res.writeHead(401, { "WWW-Authenticate": 'Basic realm="PKM Sync"' });
      res.end("Authentication required"); return;
    }

    const decoded = Buffer.from(auth.slice(6), "base64").toString("utf-8");
    const colon   = decoded.indexOf(":");
    const user    = decoded.slice(0, colon);
    const pass    = decoded.slice(colon + 1);
    const session = this.sessions.get(user);

    if (!session || !session.enabled || session.expires < new Date() || pass !== session.password) {
      res.writeHead(401, { "WWW-Authenticate": 'Basic realm="PKM Sync"' });
      res.end("Invalid or expired credentials"); return;
    }

    if (req.method === "GET" && (req.url === "/sync/skills" || req.url === "/sync/bundle")) {
      const types    = session.contentTypes.length ? session.contentTypes : ["skills"];
      const sel      = session.selected;
      const bundle: any = { from: process.env.USER ?? "uone", created_at: new Date().toISOString(), version: "2" };

      if (types.includes("skills")) {
        const rows = sel.skills.length
          ? sel.skills.map(n => skillGet(n)).filter(Boolean)
          : (skillList() as any[]).map((r: any) => skillGet(r.name)).filter(Boolean);
        bundle.skills = (rows as any[]).map(r => ({
          name: r.name, content: r.content,
          metadata: { description: r.description, category: r.category,
                      tags: JSON.parse(r.tags ?? "[]"), source_project: r.source_project, created_at: r.created_at }
        }));
      }
      if (types.includes("notes")) {
        const all = noteExport() as any[];
        bundle.notes = sel.notes.length ? all.filter(n => sel.notes.includes(n.slug)) : all;
      }
      if (types.includes("prompts")) {
        const all = promptExport();
        bundle.prompts = sel.prompts.length
          ? all.filter(p => sel.prompts.includes(`${p.project}/${p.task}`))
          : all;
      }
      if (types.includes("scripts")) {
        const all = scriptExport();
        bundle.scripts = sel.scripts.length
          ? all.filter(s => sel.scripts.includes(`${s.category}/${s.file}`))
          : all;
      }
      if (types.includes("packages")) {
        const all = packageExport();
        bundle.packages = sel.packages.length ? all.filter(p => sel.packages.includes(p.name)) : all;
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(bundle));

    } else if (req.method === "GET" && req.url === "/sync/session") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, expires: session.expires, skillCount: session.selected.skills.length || "all" }));
    } else {
      res.writeHead(404); res.end("Not found");
    }
  }

  static localIp(): string {
    for (const ifaces of Object.values(networkInterfaces())) {
      for (const iface of ifaces ?? []) {
        if (!iface.internal && iface.family === "IPv4") return iface.address;
      }
    }
    return "127.0.0.1";
  }
}

export const syncServer = new SyncServer();
