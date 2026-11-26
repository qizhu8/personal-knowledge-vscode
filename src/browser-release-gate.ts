import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { CoreError } from "./contracts.js";
import type { Core } from "./core.js";
import { documentPath } from "./document-path.js";
import type { NoteRecord } from "./note-contracts.js";
import { chatTurnCancelInput } from "./chat-turn-contracts.js";

const base = "/webview/";
const csp = "default-src 'none'; script-src 'self'; script-src-attr 'none'; style-src 'self'; style-src-attr 'unsafe-inline'; font-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const files = {
  PANEL_JS: "panel.js", PANEL_CSS: "panel.css", CODICON_CSS: "codicon.css",
  AGENT_HARNESS_CSS: "agent-harness.css", HOST_HEALTH_JS: "host-health.js", HOST_HEALTH_CSS: "host-health.css",
  MARKED_SRC: "marked.umd.js", HLJS_SRC: "hljs.js", HLJS_CSS: "hljs.css", KATEX_SRC: "katex.js",
  KATEX_CSS: "katex.css", CYTOSCAPE_SRC: "cytoscape.js", MERMAID_SRC: "mermaid.js", FORCEGRAPH3D_SRC: "forcegraph3d.js",
};
export const webviewBundleFiles = ["panel.html", ...Object.values(files), "codicon.ttf"];
export const webviewFont = /^KaTeX_[\w-]+\.woff2$/;
const adapterFiles = ["webview-sign-in.html", "webview-chat.html", "webview-sign-in.js", "webview-adapter.js",
  "webview-theme.css", "webview-chat.js"] as const;
const hash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const packageReceipt = z.object({ schema: z.literal("pkm.next-payload/v1"), extensionVersion: z.string(),
  files: z.record(z.string(), z.string()), buildId: z.string() });
const releaseMarker = "server/browser/webview/release.json";

async function browserAssets(allowDevelopment: boolean) {
  const browser = fileURLToPath(new URL("../browser", import.meta.url));
  const runtime = fileURLToPath(new URL("../", import.meta.url));
  const payload = join(runtime, "..");
  let markerPresent = true;
  try { await lstat(join(payload, releaseMarker)); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    markerPresent = false;
  }
  if (markerPresent) {
    const receipt = packageReceipt.parse(JSON.parse(await readFile(join(payload, "manifest.json"), "utf8")));
    if (receipt.buildId !== hash(JSON.stringify(receipt.files))) throw new Error("Packaged browser inventory digest mismatch.");
    const readPinned = async (name: string) => {
      const file = join(payload, name);
      const stat = await lstat(file);
      if (!stat.isFile() || await realpath(file) !== file || stat.size > 32 * 1024 * 1024)
        throw new Error("Packaged browser asset must be a bounded regular file.");
      const bytes = await readFile(file);
      if (!Object.hasOwn(receipt.files, name) || hash(bytes) !== receipt.files[name])
        throw new Error("Packaged browser asset digest mismatch.");
      return bytes;
    };
    const marker = z.strictObject({ schema: z.literal("pkm.packaged-webview/v1"), version: z.string() })
      .parse(JSON.parse((await readPinned(releaseMarker)).toString("utf8")));
    const extension = JSON.parse(await readFile(join(payload, "..", "package.json"), "utf8"));
    if (marker.version !== receipt.extensionVersion || marker.version !== extension.version)
      throw new Error("Packaged browser version mismatch.");
    const prefix = "server/browser/webview/bundle/";
    const names = Object.keys(receipt.files).filter(name => name.startsWith(`${prefix}fonts/`))
      .map(name => name.slice(prefix.length)).filter(name => webviewFont.test(name.slice(6)));
    if (!names.length) throw new Error("Packaged browser font inventory is missing.");
    return { version: marker.version, names, bundle: (name: string) => readPinned(`${prefix}${name}`),
      adapter: (name: string) => readPinned(`server/browser/${name}`) };
  }
  // An installed payload must not fall through to a development directory.
  if (payload.endsWith("/next-runtime")) return undefined;
  const path = allowDevelopment ? process.env.PKM_BROWSER_WEBVIEW_DIR : undefined;
  if (!path) return undefined;
  if (!isAbsolute(path)) throw new Error("PKM_BROWSER_WEBVIEW_DIR must be an absolute path to the built Webview.");
  return { version: JSON.parse(await readFile(join(path, "..", "..", "package.json"), "utf8")).version,
    names: (await readdir(join(path, "fonts"))).filter(name => webviewFont.test(name)).map(name => `fonts/${name}`),
    bundle: (name: string) => readFile(join(path, name)), adapter: (name: string) => readFile(join(browser, name)) };
}
const json = "application/json";
const signIn = z.strictObject({ token: z.string().max(4096), remember: z.boolean() });
const uuid = z.string().uuid();
const chatId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const revision = z.number().int().safe().positive();
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const noteBody = z.string().min(1).max(400_000);
const command = z.discriminatedUnion("command", [
  z.strictObject({ command: z.literal("list"), q: z.string().max(500), caseSensitive: z.boolean() }),
  z.strictObject({ command: z.literal("detail"), path: documentPath }),
  z.strictObject({ command: z.literal("saveNote"), operationId: z.string().uuid(), title: z.string().min(1).max(500),
    content: noteBody, type: z.enum(["general", "todo", "done", "data-path", "observation"]),
    category: z.string().max(2048), tags: z.array(z.string().max(500)).max(500) }),
  z.strictObject({ command: z.literal("updateNote"), operationId: uuid, id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/),
    expectedRevision: revision, expectedSha256: sha, content: noteBody }),
  z.strictObject({ command: z.literal("chatCapabilities") }),
  z.strictObject({ command: z.literal("chatList"), cursor: z.string().max(4096).optional() }),
  z.strictObject({ command: z.literal("chatGet"), id: chatId }),
  z.strictObject({ command: z.literal("chatMessages"), id: chatId, cursor: z.string().max(4096).optional() }),
  z.strictObject({ command: z.literal("chatTurns"), sessionId: chatId, after: chatId.optional() }),
  z.strictObject({ command: z.literal("originalChatTarget"), chatId: uuid }),
  z.strictObject({ command: z.literal("originalChatSend"), chatId: uuid, turnId: uuid, revision: uuid, text: z.string().min(1).max(2000) }),
  z.strictObject({ command: z.enum(["originalChatStatus", "originalChatStop"]), chatId: uuid, turnId: uuid }),
  z.strictObject({ command: z.literal("chatCreate"), id: uuid, operationId: uuid }),
  z.strictObject({ command: z.literal("chatStart"), id: uuid, sessionId: chatId, operationId: uuid,
    expectedSessionRevision: revision, content: z.string().trim().min(1).max(100_000) }),
  chatTurnCancelInput.extend({ command: z.literal("chatStop") }),
]);

async function requestJson(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > 524288) throw new CoreError("INVALID_ARGUMENT", "Browser request exceeds the size limit.");
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new CoreError("INVALID_ARGUMENT", "Expected JSON."); }
}

type PanelNote = Omit<NoteRecord, "content"> & { documentId: string; path: string; documentSha256: string; content?: string };
const unsafeCategory = (category: string) => category.split("/").some(part => Object.hasOwn(Object.prototype, part.trim()));
function panelNote(note: PanelNote) {
  // The legacy tree uses plain objects for folders and interpolates its type into a CSS class.
  return { ...note, slug: note.path.replace(/\.md$/i, ""), category: unsafeCategory(note.category) ? "" : note.category,
    type: /^[a-z0-9-]+$/.test(note.type) ? note.type : "general" };
}

export type BrowserCoreDispatch = (method: "capability_read" | "capability_call" | "capabilities_describe",
  args: object) => Promise<Awaited<ReturnType<Core["dispatch"]>>>;
export type BrowserCommand = z.infer<typeof command>;
type BrowserContext = { accepting: () => boolean; authorized?: () => boolean } &
  ({ dispatch: BrowserCoreDispatch } | { readOriginal: (input: BrowserCommand, current: () => boolean) => Promise<unknown> });
export async function createBrowserReleaseGate(token: string, reviewAvailable: boolean, allowDevelopment = true) {
  const source = await browserAssets(allowDevelopment);
  if (!source) return undefined;
  const { version, adapter, bundle, names } = source;
  const assets = new Map<string, Buffer>();
  for (const name of [...webviewBundleFiles, ...names]) assets.set(name, await bundle(name));
  for (const name of adapterFiles) assets.set(name, await adapter(name));
  const template = assets.get("panel.html")!.toString("utf8");
  const authPage = assets.get("webview-sign-in.html")!, chatPage = assets.get("webview-chat.html")!;
  for (const name of ["panel.html", "webview-sign-in.html", "webview-chat.html"]) assets.delete(name);
  if (typeof version !== "string" || !/^[\w.-]+$/.test(version)) throw new Error("Invalid Webview package version.");
  const values: Record<string, string> = {
    ...Object.fromEntries(Object.entries(files).map(([key, name]) => [key, `${base}${name}`])),
    PKM_VERSION: version, I18N_PAYLOAD_B64: "", SKILLS_BASE: "", NOTES_BASE: "", PAPERS_BASE: "", SUBSCRIPTIONS_BASE: "",
  };
  // HTTP CSP replaces the VS Code-only meta policy; the built markup and JS are not rebuilt for browsers.
  const panel = template.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, "")
    .replace(/%%([A-Z0-9_]+)%%/g, (_match, key: string) => {
      if (!Object.hasOwn(values, key)) throw new Error(`Unknown Webview template token: ${key}`);
      return values[key]!;
    }).replace("</head>", `<link rel="stylesheet" href="${base}webview-theme.css">
<script src="${base}marked.umd.js"></script><script src="${base}webview-adapter.js"></script></head>`);

  const cookieName = `pkm_webview_${randomBytes(8).toString("hex")}`;
  const sessions = new Map<string, number>();
  const expected = createHash("sha256").update(token).digest();
  const ttl = 8 * 60 * 60;
  const cookie = (value: string, age: string) => `${cookieName}=${value}; Path=${base}; HttpOnly; Secure; SameSite=Strict${age}`;
  async function mutationScan(invoke: <T>(method: "capability_read", operation: string, args: object) => Promise<T>) {
    const pins: Array<{ area: string; path: string; sha256: string }> = [];
    let offset: number | null = 0, workspaceRevision: string | undefined;
    do {
      const page: { items: typeof pins; nextOffset: number | null; workspaceRevision: string } =
        await invoke("capability_read", "knowledge.document.list", { offset, limit: 100, includeDeleted: true, workspaceRevision });
      workspaceRevision = page.workspaceRevision;
      pins.push(...page.items.map(({ area, path, sha256 }) => ({ area, path, sha256 })));
      offset = page.nextOffset;
    } while (offset !== null);
    pins.sort((a, b) => `${a.area}/${a.path}`.localeCompare(`${b.area}/${b.path}`));
    return createHash("sha256").update(JSON.stringify(pins)).digest("hex");
  }
  const originalPanel = panel.replace('<script src="/webview/webview-adapter.js">', '<script id="pkm-original-browser" src="/webview/webview-adapter.js">');
  return async (req: IncomingMessage, res: ServerResponse, context: BrowserContext) => {
    if (!req.url?.startsWith(base) && req.url !== "/webview") return false;
    const route = req.url.slice(base.length);
    const reply = (status: number, content: string | Buffer, type = json, headers = {}) => {
      res.writeHead(status, { "Content-Type": type, "Content-Security-Policy": csp,
        "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", ...headers });
      res.end(req.method === "HEAD" ? undefined : content);
    };
    const sid = (req.headers.cookie ?? "").split(/;\s*/).find(value => value.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
    const authorized = context.authorized ?? (() => true);
    const signedIn = () => authorized() && sid !== undefined && (sessions.get(sid) ?? 0) > Date.now();
    const invoke = async <T>(method: "capability_read" | "capability_call", operation: string, args: object) => {
      if (!signedIn()) throw new CoreError("ACCESS_DENIED", "Browser session revoked.");
      if (!("dispatch" in context)) throw new CoreError("ACCESS_DENIED", "Core dispatch unavailable.");
      const result = await context.dispatch(method, { operation, version: 1, arguments: args });
      if (result.error) throw new CoreError(result.error.code, result.error.message, result.error.effect);
      return result.result as T;
    };
    const available = async (operation: string) => {
      if (!("dispatch" in context)) return false;
      const result = await context.dispatch("capabilities_describe", { operation });
      if (result.error && result.error.code !== "NOT_FOUND")
        throw new CoreError(result.error.code, result.error.message, result.error.effect);
      return !!result.result;
    };
    try {
      if (req.method === "GET" || req.method === "HEAD") {
        if (req.url === "/webview") reply(303, "", json, { Location: base });
        else if (!route) reply(200, signedIn() ? ("readOriginal" in context ? originalPanel : panel) : authPage, "text/html; charset=utf-8");
        else if (route === "chat") {
          if (signedIn()) reply(200, chatPage, "text/html; charset=utf-8");
          else reply(303, "", json, { Location: base });
        }
        else {
          const asset = signedIn() || ["webview-sign-in.js", "webview-theme.css"].includes(route) ? assets.get(route) : undefined;
          if (!asset) reply(404, "{}");
          else reply(200, asset, route.endsWith(".js") ? "text/javascript; charset=utf-8" : route.endsWith(".css")
            ? "text/css; charset=utf-8" : route.endsWith(".ttf") ? "font/ttf" : "font/woff2");
        }
        return true;
      }
      if (req.method !== "POST" || !["session", "sign-out", "message"].includes(route)) reply(404, "{}");
      else if (req.headers.origin !== `http://${req.headers.host}` || req.headers["content-type"] !== json) reply(403, "{}");
      else if (route === "sign-out") {
        if (sid) sessions.delete(sid);
        reply(200, "{}", json, { "Set-Cookie": cookie("", "; Max-Age=0") });
      } else if (!context.accepting()) reply(503, JSON.stringify({ error: "The service is not accepting requests.", effect: "not-committed" }));
      else if (route === "session") {
        const input = signIn.parse(await requestJson(req));
        if (!authorized() || !timingSafeEqual(createHash("sha256").update(input.token).digest(), expected))
          reply(401, JSON.stringify({ error: "Token was not accepted." }));
        else {
          for (const [id, expires] of sessions) if (expires <= Date.now()) sessions.delete(id);
          if (sid) sessions.delete(sid);
          if (sessions.size >= 128) reply(429, JSON.stringify({ error: "Session limit reached." }));
          else {
            const id = randomBytes(32).toString("base64url");
            sessions.set(id, Date.now() + ttl * 1000);
            reply(200, "{}", json, { "Set-Cookie": cookie(id, input.remember ? `; Max-Age=${ttl}` : "") });
          }
        }
      } else if (!signedIn()) reply(401, JSON.stringify({ error: "Sign in again." }));
      else {
        const input = command.parse(await requestJson(req));
        if (!signedIn()) {
          reply(401, JSON.stringify({ error: "Sign in again." })); return true;
        }
        let value: unknown;
        if ("readOriginal" in context) {
          value = await context.readOriginal(input, () => signedIn() && context.accepting());
          if (!signedIn()) throw new CoreError("ACCESS_DENIED", "Browser session revoked.");
        } else if (input.command === "list") {
          const page = await invoke<{ items: PanelNote[]; total: number }>("capability_read",
            input.q ? "knowledge.note.search" : "knowledge.note.list",
            input.q ? { query: input.q, caseSensitive: input.caseSensitive, limit: 100 } : { limit: 100 });
          value = { items: page.items.map(panelNote), total: page.total };
        } else if (input.command === "detail") {
          const { item } = await invoke<{ item: PanelNote }>("capability_read", "knowledge.note.get", { path: input.path });
          const edit = item.documentKind === "markdown" && await available("knowledge.note.update");
          let currentRevision = item.revision;
          if (edit && currentRevision === undefined) {
            const canonical = await invoke<{ revision: number; sha256: string }>("capability_read", "knowledge.document.get", { id: item.documentId });
            if (canonical.sha256 === item.documentSha256) currentRevision = canonical.revision;
          }
          value = { ...panelNote(item), note_type: item.type, type: "note", editPin: edit && currentRevision ?
            { id: item.documentId, expectedRevision: currentRevision, expectedSha256: item.documentSha256 } : null };
        } else if (input.command === "saveNote" || input.command === "updateNote") {
          const { command: _name, ...draft } = input;
          if ("category" in draft && unsafeCategory(draft.category))
            throw new CoreError("INVALID_ARGUMENT", "This category is not supported by the Webview tree.");
          value = await invoke("capability_call", input.command === "updateNote" ? "knowledge.note.update" : "knowledge.note.create",
            { ...draft, ...(input.command === "updateNote" ? { preserveIdentity: true } : {}),
              expectedScanRevision: await mutationScan(invoke) });
        } else {
          const { command: name, ...args } = input;
          switch (name) {
            case "chatCapabilities": value = { history: await available("chat.session.messages"), create: await available("chat.session.create"),
              send: await available("chat.turn.start"), stop: await available("chat.turn.cancel"), review: reviewAvailable }; break;
            case "chatList": value = await invoke("capability_read", "chat.session.list", { ...args, includeArchived: true }); break;
            case "chatGet": value = await invoke("capability_read", "chat.session.get", args); break;
            case "chatMessages": value = await invoke("capability_read", "chat.session.messages", { ...args, limit: 100 }); break;
            case "chatTurns": {
              const page = await invoke<{ items: Array<Record<string, unknown>>; next: string | null }>("capability_read", "chat.turn.list", args);
              value = { next: page.next, items: page.items.map(({ id, revision, status, output }) => ({ id, revision, status, output })) };
              break;
            }
            case "chatCreate": value = await invoke("capability_call", "chat.session.create", { ...args, expectedRevision: 0 }); break;
            case "chatStart": {
              const { command: _command, content, ...start } = input;
              const { id, status } = await invoke<{ id: string; status: string }>("capability_call", "chat.turn.start",
                { ...start, expectedRevision: 0, messages: [{ role: "user", content }] });
              value = { id, status }; break;
            }
            case "chatStop": {
              const { id, status } = await invoke<{ id: string; status: string }>("capability_call", "chat.turn.cancel", args);
              value = { id, status }; break;
            }
            default: throw new CoreError("ACCESS_DENIED", "Private Original Chat controls are unavailable.", "not-committed");
          }
        }
        reply(200, JSON.stringify(value));
      }
    } catch (error) {
      const message = error instanceof CoreError ? error.message
        : error instanceof z.ZodError ? "Unsupported or invalid browser request." : "Browser request failed.";
      const effect = error instanceof CoreError ? error.effect : error instanceof z.ZodError ? "not-committed" : "unknown";
      reply(error instanceof z.ZodError ? 400 : effect === "not-committed" ? 409 : 500, JSON.stringify({ error: message, effect }));
    }
    return true;
  };
}
