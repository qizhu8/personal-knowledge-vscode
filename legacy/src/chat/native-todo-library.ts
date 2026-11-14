import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { randomUUID } from "crypto";
import { loadLocaleCatalogs, loadLocaleManifest, resolveUiLanguage, uiLanguageSetting } from "../ui/localization";

interface LibraryCallbacks {
  root: string;
  boards(): readonly string[];
  refreshBoards(): Promise<readonly string[]>;
  read(slug: string): Promise<any>;
  create(input: { title: string; category: string; operationId: string }): Promise<any>;
  open(slug: string): Promise<void>;
  lifecycle?(input: Record<string, unknown>): Promise<any>;
  trash?(): Promise<any[]>;
}

export function registerNativeTodoLibrary(context: vscode.ExtensionContext, callbacks: LibraryCallbacks): vscode.Disposable {
  let panel: vscode.WebviewPanel | undefined;
  const locations = new Map<string, string>();
  const snapshots = new Map<string, any>();
  const safeName = (value: string) => value.replace(/[/\\:*?"<>|\u0000-\u001f]/g, "").trim() || "untitled";
  const categoryOf = (slug: string) => slug.includes("/") ? slug.slice(0, slug.lastIndexOf("/")) : "";
  const rows = async () => {
    const slugs = await callbacks.refreshBoards();
    return Promise.all(slugs.map(async boardSlug => {
      const data = await callbacks.read(boardSlug), slug = String(data.note.slug);
      locations.set(slug, boardSlug); locations.set(boardSlug, boardSlug); snapshots.set(boardSlug, data);
      return { ...data.note, slug, title: data.note.title, documentKind: "todo-board", category: categoryOf(slug) };
    }));
  };
  const boardAt = async (location: string) => {
    const boardSlug = locations.get(location) ?? (callbacks.boards().includes(location) ? location : undefined);
    if (!boardSlug) throw new Error("Choose a Board in this exact private Library.");
    const data = snapshots.get(boardSlug) ?? await callbacks.read(boardSlug);
    return { boardSlug, data };
  };
  const perform = async (source: { boardSlug: string; data: any }, kind: string, extra: Record<string, unknown> = {}) => {
    if (!callbacks.lifecycle) throw new Error("Board file lifecycle is unavailable in this private host.");
    const result = await callbacks.lifecycle({ kind, ...extra, boardSlug: source.boardSlug, operationId: randomUUID(),
      expectedDigest: source.data.snapshot.digest, expectedDocumentDigest: source.data.note.documentSha256 });
    await callbacks.refreshBoards();
    if (kind !== "trash") {
      const data = await callbacks.read(source.boardSlug);
      snapshots.set(source.boardSlug, data); locations.set(data.note.slug, source.boardSlug);
    }
    return result;
  };
  let queue = Promise.resolve();
  const enqueue = (work: () => Promise<void>) => {
    const result = queue.then(work);
    queue = result.catch(() => {});
    return result;
  };
  const chooseFolder = async (initial: string) => {
    let current = initial;
    for (;;) {
      const prefix = current ? current + "/" : "";
      const paths = await Promise.all(callbacks.boards().map(async key => String((await callbacks.read(key)).note.slug)));
      const children = [...new Set(paths.filter(slug => slug.startsWith(prefix))
        .map(slug => slug.slice(prefix.length).split("/")).filter(parts => parts.length > 1).map(parts => parts[0]))].sort();
      const choices = [
        { label: "$(check) Select this folder", description: current || "Root", action: "select", name: "" },
        ...(current ? [{ label: "$(arrow-left) Parent folder", description: "Parent", action: "parent", name: "" }] : []),
        ...children.map(name => ({ label: `$(folder) ${name}`, description: prefix + name, action: "child", name })),
        { label: "$(keyboard) Type a path...", description: "Enter a slash-separated path", action: "type", name: "" },
      ];
      const picked = await vscode.window.showQuickPick(choices, { title: "Choose Notes folder", placeHolder: current ? `Current: ${current}` : "Current: Root" });
      if (!picked) return;
      if (picked.action === "select") return current;
      if (picked.action === "child") current = prefix + picked.name;
      else if (picked.action === "parent") current = current.includes("/") ? current.slice(0, current.lastIndexOf("/")) : "";
      else {
        const typed = await vscode.window.showInputBox({ prompt: "Enter a slash-separated path", value: current });
        if (typed === undefined) return;
        current = typed;
      }
    }
  };
  const create = async (initial = "") => {
    await callbacks.refreshBoards();
    const category = await chooseFolder(initial);
    if (category === undefined) return;
    const title = await vscode.window.showInputBox({ prompt: "New note title" });
    if (!title?.trim()) return;
    const kind = await vscode.window.showQuickPick([
      { label: "Markdown", description: "Free-form Note; checkboxes are not managed tasks", value: "markdown" },
      { label: "Todo Board", description: "Structured Stories and tasks; managed through UI / MCP commands", value: "todo-board" },
    ], { placeHolder: "Choose document type" });
    if (!kind) return;
    if (kind.value !== "todo-board") throw new Error("This private native Library currently admits Todo Board creation only.");
    const result = await callbacks.create({ title: title.trim(), category, operationId: randomUUID() });
    await panel?.webview.postMessage({ command: "saved" });
    await callbacks.open(result.slug);
  };
  const open = async () => {
    if (panel) { panel.reveal(); return; }
    await callbacks.refreshBoards();
    panel = vscode.window.createWebviewPanel("pkm.privateNativeTodoLibrary", "Original Library · native Todo",
      vscode.ViewColumn.One, { enableScripts: true, retainContextWhenHidden: true,
        localResourceRoots: [context.extensionUri, vscode.Uri.file(callbacks.root)] });
    const current = panel;
    const directory = fs.existsSync(path.join(context.extensionPath, "dist/webview/panel.html")) ? "dist/webview" : "src/webview";
    const uri = (name: string) => current.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, directory, name)).toString();
    const assets: Record<string, string> = {
      PANEL_JS: "panel.js", PANEL_CSS: "panel.css", CODICON_CSS: "codicon.css", HOST_HEALTH_JS: "host-health.js",
      HOST_HEALTH_CSS: "host-health.css", AGENT_HARNESS_CSS: "agent-harness.css", MARKED_SRC: "marked.umd.js",
      HLJS_SRC: "hljs.js", HLJS_CSS: "hljs.css", KATEX_SRC: "katex.js", KATEX_CSS: "katex.css",
      CYTOSCAPE_SRC: "cytoscape.js", MERMAID_SRC: "mermaid.js", FORCEGRAPH3D_SRC: "forcegraph3d.js",
    };
    const setting = uiLanguageSetting();
    const replacements: Record<string, string> = {
      ...Object.fromEntries(Object.entries(assets).map(([key, name]) => [key, uri(name)])),
      CSP_SOURCE: current.webview.cspSource, PKM_VERSION: context.extension?.packageJSON?.version ?? "?",
      I18N_PAYLOAD_B64: Buffer.from(JSON.stringify({ setting, resolved: resolveUiLanguage(setting, vscode.env.language, context.extensionPath),
        locales: loadLocaleManifest(context.extensionPath).locales, catalogs: loadLocaleCatalogs(context.extensionPath) })).toString("base64"),
      ...Object.fromEntries(["skills", "notes", "papers"].map(area => [`${area.toUpperCase()}_BASE`,
        current.webview.asWebviewUri(vscode.Uri.file(path.join(callbacks.root, area))).toString()])),
      SUBSCRIPTIONS_BASE: "",
    };
    const receive = async (message: any) => {
      try {
        if (message.command === "ready") {
          await current.webview.postMessage({ command: "openTab", tab: "notes" });
        } else if (message.command === "list" && message.tab === "notes") {
          const items = await rows();
          const q = String(message.q || "").toLowerCase();
          await current.webview.postMessage({ command: "list", tab: "notes", data: items.filter(row => `${row.slug} ${row.title}`.toLowerCase().includes(q)),
            folders: [...new Set(items.map(row => row.category).filter(Boolean))], knowledgeTrash: await callbacks.trash?.() ?? [] });
          await current.webview.postMessage({ command: "loadingProgress", data: { stage: "ready", percent: 100 } });
        } else if (message.command === "createKnowledgeItem" && message.area === "notes") await create(String(message.category || ""));
        else if (message.command === "detail" && message.type === "note") await callbacks.open((await boardAt(String(message.key))).boardSlug);
        else if (message.command === "noteMove") {
          const source = await boardAt(String(message.slug));
          const category = String(message.category || "").split(/[\\/]/).map(part => part.trim()).filter(Boolean).map(safeName).join("/");
          const name = safeName(String(source.data.note.title));
          const destinationPath = `${category ? category + "/" : ""}${name}.md`;
          if (destinationPath !== source.data.note.path) await perform(source, "move", { destinationPath });
          await current.webview.postMessage({ command: "saved" });
        } else if (message.command === "editKnowledgeMetadata" && message.area === "notes") {
          const source = await boardAt(String(message.key)), note = source.data.note;
          const title = await vscode.window.showInputBox({ title: "Edit Knowledge Metadata (1/4)", prompt: "Title", value: note.title,
            validateInput: value => !value.trim() ? "Title is required" : /[\\/]/.test(value) ? "Title cannot contain slashes" : null });
          if (title === undefined) return;
          const description = await vscode.window.showInputBox({ title: "Edit Knowledge Metadata (2/4)", prompt: "Description", value: note.description || "" });
          if (description === undefined) return;
          const tags = Array.isArray(note.tags) ? note.tags : JSON.parse(note.tags || "[]");
          const tagsText = await vscode.window.showInputBox({ title: "Edit Knowledge Metadata (3/4)", prompt: "Tags (comma-separated)", value: tags.join(", ") });
          if (tagsText === undefined) return;
          const category = await chooseFolder(categoryOf(note.slug));
          if (category === undefined) return;
          await perform(source, "move", { title: title.trim(), description,
            tags: tagsText.split(",").map(tag => tag.trim()).filter(Boolean),
            destinationPath: `${category ? category + "/" : ""}${safeName(title.trim())}.md` });
          await current.webview.postMessage({ command: "saved" });
        } else if (message.command === "updateKnowledgeMetadataField" && message.area === "notes") {
          const source = await boardAt(String(message.key)), value = String(message.value ?? "").trim(), field = String(message.field);
          if (!["title", "description", "tags"].includes(field) || field === "title" && (!value || /[\\/]/.test(value)))
            throw new Error("Invalid Board metadata field or title.");
          const category = categoryOf(source.data.note.slug);
          await perform(source, "move", { destinationPath: field === "title"
            ? `${category ? category + "/" : ""}${safeName(value)}.md` : source.data.note.path,
            [field]: field === "tags" ? value.split(",").map(tag => tag.trim()).filter(Boolean) : value });
          await current.webview.postMessage({ command: "metadataUpdateResult", data: { ok: true, field } });
          await current.webview.postMessage({ command: "saved" });
        } else if ((message.command === "knowledgeTrashMove" && message.area === "notes" && message.kind === "item")
          || message.command === "deleteNote") {
          const location = message.command === "deleteNote" ? String(message.slug) : String(message.path).replace(/\.md$/i, "");
          const source = await boardAt(location);
          await perform(source, "trash");
          const entry = (await callbacks.trash?.())?.find(item => item.boardSlug === source.boardSlug);
          if (!entry) throw new Error("Committed Board Trash receipt is unavailable; refresh before retrying.");
          await current.webview.postMessage({ command: "knowledgeTrashResult", data: {
            ok: true, action: "moved", area: "notes", path: source.data.note.path, entry } });
        } else if (message.command === "knowledgeTrashRestore" && message.area === "notes") {
          const entry = (await callbacks.trash?.())?.find(item => item.id === message.id);
          if (!entry || !callbacks.lifecycle) throw new Error("Choose an exact retained Board Trash entry.");
          await callbacks.lifecycle({ kind: "restore", boardSlug: entry.boardSlug, operationId: randomUUID(),
            expectedDigest: entry.digest, expectedDocumentDigest: entry.documentDigest });
          await callbacks.refreshBoards();
          await current.webview.postMessage({ command: "knowledgeTrashResult", data: {
            ok: true, action: "restored", area: "notes", path: entry.originalPath, id: entry.id } });
        }
        else if (message.command === "copyText") await vscode.env.clipboard.writeText(String(message.text || ""));
        else if (/^(delete|save|move|rename|markDone|editMarkdown|openMarkdown|note(?:Set|Move|Save|Delete|Rename)|folder|create|knowledge(?:Trash(?:Move|Restore|Delete|Empty)|Group(?:Create|Rename|SetColor|Delete|Assign)))/.test(String(message.command)))
          throw new Error("This Library mutation is not admitted by the private native Todo host.");
      } catch (error) {
        if (/^(knowledgeTrash|deleteNote)/.test(String(message.command)))
          await current.webview.postMessage({ command: "knowledgeTrashResult", data: {
            ok: false, area: "notes", error: error instanceof Error ? error.message : String(error) } });
        if (message.command === "updateKnowledgeMetadataField")
          await current.webview.postMessage({ command: "metadataUpdateResult", data: {
            ok: false, error: error instanceof Error ? error.message : String(error) } });
        void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
      }
    };
    const listener = current.webview.onDidReceiveMessage(message => enqueue(async () => {
      if (panel === current) await receive(message);
    }));
    current.onDidDispose(() => { listener.dispose(); if (panel === current) panel = undefined; });
    current.webview.html = fs.readFileSync(path.join(context.extensionPath, directory, "panel.html"), "utf8")
      .replace(/%%([A-Z0-9_]+)%%/g, (original, key) => replacements[key] ?? original);
  };
  const commands = [
    vscode.commands.registerCommand("personalKnowledge.open", () => enqueue(open)),
    vscode.commands.registerCommand("personalKnowledge.addNote", () => enqueue(() => create())),
  ];
  return { dispose() { for (const command of commands) command.dispose(); panel?.dispose(); } };
}
