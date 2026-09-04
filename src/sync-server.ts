import { createServer, Server, IncomingMessage, ServerResponse } from "http";
import { networkInterfaces } from "os";
import { randomBytes } from "crypto";
import { skillList, skillGet, noteExport, paperList, paperGet } from "./filestore";
import { promptExport, scriptExport, packageExport } from "./storage";
import { serverExport } from "./servers";

export interface SyncSelection {
  [contentType: string]: string[];
  skills: string[];
  notes: string[];
  papers: string[];
  prompts: string[];
  scripts: string[];
  packages: string[];
  servers: string[];
}

export interface SyncSession {
  id:           string;
  username:     string;
  password:     string;
  url:          string;
  expires:      Date;
  enabled:      boolean;
  contentTypes: string[];
  selected: SyncSelection;
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
    setInterval(() => this.sweep(), 2 * 60_000).unref();
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

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
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
      const bundle = buildSyncBundle(session.selected, session.contentTypes);

      const payload = JSON.stringify(bundle);
      res.writeHead(200, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) });
      res.end(payload);

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

export function emptySyncSelection(): SyncSelection {
  return { skills: [], notes: [], papers: [], prompts: [], scripts: [], packages: [], servers: [] };
}

export function buildSyncBundle(selection: SyncSelection, contentTypes: string[], from = process.env.USER ?? "uone"): any {
  const types = contentTypes.length ? contentTypes : ["skills"];
  const selected = { ...emptySyncSelection(), ...selection };
  const bundle: any = { from, created_at: new Date().toISOString(), version: "3" };
  if (types.includes("skills")) {
    const rows = selected.skills.length
      ? selected.skills.map(name => skillGet(name)).filter(Boolean)
      : (skillList() as any[]).map((row: any) => skillGet(row.name)).filter(Boolean);
    bundle.skills = (rows as any[]).map(row => ({
      name: row.name, content: row.content,
      metadata: { description: row.description, category: row.category, tags: JSON.parse(row.tags ?? "[]"), source_project: row.source_project, created_at: row.created_at },
    }));
  }
  if (types.includes("notes")) {
    const all = noteExport() as any[];
    bundle.notes = selected.notes.length ? all.filter(note => selected.notes.includes(note.slug)) : all;
  }
  if (types.includes("papers")) {
    bundle.papers = selected.papers.length
      ? selected.papers.map(slug => paperGet(slug)).filter(Boolean)
      : (paperList() as any[]).map((row: any) => paperGet(row.slug)).filter(Boolean);
  }
  if (types.includes("prompts")) {
    const all = promptExport();
    bundle.prompts = selected.prompts.length ? all.filter(prompt => selected.prompts.includes(`${prompt.project}/${prompt.task}`)) : all;
  }
  if (types.includes("scripts")) {
    const all = scriptExport();
    bundle.scripts = selected.scripts.length ? all.filter(script => selected.scripts.includes(`${script.category}/${script.file}`)) : all;
  }
  if (types.includes("packages")) {
    const all = packageExport();
    bundle.packages = selected.packages.length ? all.filter(pkg => selected.packages.includes(pkg.name)) : all;
  }
  if (types.includes("servers")) bundle.servers = serverExport(selected.servers);
  return bundle;
}
