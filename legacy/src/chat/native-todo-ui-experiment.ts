import * as vscode from "vscode";
import { createHash, randomBytes, randomUUID } from "crypto";
import { browserNoteTodo } from "../ui/note-todo-browser";
import { registerNativeTodoLibrary } from "./native-todo-library";

interface NativeTodoCallbacks {
  boards(): readonly string[];
  rpc(input: Record<string, unknown>): Promise<any>;
  openChat(url: string): Promise<void>;
  workspaceId: string;
  root?: string;
  refreshBoards?(): Promise<readonly string[]>;
  createBoard?(input: { title: string; category: string; operationId: string }): Promise<any>;
  lifecycle?(input: Record<string, unknown>): Promise<any>;
  trash?(): Promise<any[]>;
}
/** Transport-only adaptation of the shipped Todo renderer; no FileStore or legacy writer is started. */
export function registerNativeTodoUiExperiment(context: vscode.ExtensionContext, callbacks: NativeTodoCallbacks): vscode.Disposable {
  const panels = new Set<vscode.WebviewPanel>();
  const legacyPendingKey = `pkm.privateNativeTodo.workerPending:${callbacks.workspaceId}`;
  const workerKey = (slug: string, actor: string) => `pkm.native-todo-worker:${callbacks.workspaceId}:${slug}:${actor}`;
  const activeWorkerKey = (slug: string, actor: string, hash: string) => `${workerKey(slug, actor)}:grant:${hash}`;
  // The committed Core hash locates a pending secret without relying on Memento event ordering.
  const pendingWorkerKey = (slug: string, actor: string, hash: string) => `${workerKey(slug, actor)}:pending:${hash}`;
  const withWorkerStatus = async (slug: string, result: any) => {
    await recovery;
    const workerSecretStatus: Record<string, string> = {};
    for (const [actor, hash] of Object.entries(result.workerGrants ?? {})) {
      try {
        const pending = await context.secrets.get(pendingWorkerKey(slug, actor, String(hash)));
        if (pending && createHash("sha256").update(pending).digest("hex") === hash) {
          await finishWorker({ boardSlug: slug, actorId: actor, tokenHash: String(hash) }, pending);
          workerSecretStatus[actor] = "ready";
          continue;
        }
        const token = await context.secrets.get(activeWorkerKey(slug, actor, String(hash)))
          ?? await context.secrets.get(workerKey(slug, actor));
        const unresolved = await context.secrets.get(pendingWorkerKey(slug, actor, String(hash)));
        workerSecretStatus[actor] = unresolved ? "pending" : !token ? "missing"
          : createHash("sha256").update(token).digest("hex") === hash ? "ready" : "mismatch";
      } catch { workerSecretStatus[actor] = "unavailable"; }
    }
    return { ...result, workerSecretStatus };
  };
  const finishWorker = async (input: Record<string, any>, token: string) => {
    await context.secrets.store(activeWorkerKey(input.boardSlug, input.actorId, input.tokenHash), token);
    await context.secrets.delete(pendingWorkerKey(input.boardSlug, input.actorId, input.tokenHash));
  };
  const recovery = (async () => {
    const legacy = { ...context.globalState.get<Record<string, Record<string, any>>>(legacyPendingKey, {}) };
    const hadLegacy = Object.keys(legacy).length > 0;
    for (const boardSlug of callbacks.boards()) {
      const result = await callbacks.rpc({ method: "todo", input: { kind: "read", boardSlug } });
      for (const [actorId, tokenHash] of Object.entries(result.workerGrants ?? {})) {
        const token = await context.secrets.get(pendingWorkerKey(boardSlug, actorId, String(tokenHash)));
        if (token && createHash("sha256").update(token).digest("hex") === tokenHash)
          await finishWorker({ boardSlug, actorId, tokenHash }, token);
      }
      for (const [operationId, input] of Object.entries(legacy)) {
        if (input.boardSlug !== boardSlug) continue;
        const token = await context.secrets.get(`${legacyPendingKey}:${operationId}`)
          ?? await context.secrets.get(workerKey(boardSlug, input.actorId));
        if (token && result.workerGrants?.[input.actorId] === input.tokenHash
          && createHash("sha256").update(token).digest("hex") === input.tokenHash) {
          await finishWorker(input, token);
          await context.secrets.delete(`${legacyPendingKey}:${operationId}`);
          delete legacy[operationId];
        }
      }
    }
    if (hadLegacy) await context.globalState.update(legacyPendingKey, Object.keys(legacy).length ? legacy : undefined);
  })().catch(error => void vscode.window.showErrorMessage(`Private Todo worker secret recovery refused: ${error.message}`));
  const open = async (requested?: string) => {
    await callbacks.refreshBoards?.();
    const allowed = callbacks.boards();
    let slug = requested;
    if (!slug) {
      const choices = await Promise.all(allowed.map(async boardSlug => {
        const data = await callbacks.rpc({ method: "todo", input: { kind: "read", boardSlug } });
        return { label: String(data.note.title), description: `notes/${data.note.slug}.md`,
          detail: `Board key: ${boardSlug}`, boardSlug };
      }));
      const selected = await vscode.window.showQuickPick(choices, { title: "Original Todo Boards · private native upgrade",
        matchOnDescription: true, matchOnDetail: true });
      slug = selected?.boardSlug;
    }
    if (!slug || !allowed.includes(slug)) throw new Error("Choose an exact original Board admitted by this private host.");
    const data = await callbacks.rpc({ method: "todo", input: { kind: "read", boardSlug: slug } });
    const panel = vscode.window.createWebviewPanel("pkm.privateNativeTodo", `Native Todo · ${data.note.title}`,
      vscode.ViewColumn.One, { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [] });
    panels.add(panel);
    const nonce = randomBytes(24).toString("base64");
    const html = browserNoteTodo("", data.content, slug, data.note.title, context.extensionPath,
      data.snapshot, true, true, true, data.note);
    panel.webview.html = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; img-src data:;">
      <title>Original Todo Board</title></head><body>${html.replace(/<script>/g, `<script nonce="${nonce}">`)}</body></html>`;
    const listener = panel.webview.onDidReceiveMessage(async message => {
      if (!message || typeof message !== "object") return;
      const requestId = message.requestId;
      try {
        if (!callbacks.boards().includes(slug)) throw new Error("Original Todo host grant changed.");
        if (message.command === "nativeTodoOpenChat") { await callbacks.openChat(String(message.chatUrl)); return; }
        if (message.command === "nativeTodoOpenKnowledge") {
          const target = await callbacks.rpc({ method: "todo-link", boardSlug: slug, uri: String(message.uri) });
          if (target.kind === "board") await open(target.boardSlug);
          else {
            const notePanel = vscode.window.createWebviewPanel("pkm.privateNativeLinkedNote", `Native Note · ${target.note.title}`,
              vscode.ViewColumn.One, { enableScripts: false, localResourceRoots: [] });
            panels.add(notePanel); notePanel.onDidDispose(() => panels.delete(notePanel));
            const escape = (value: unknown) => String(value ?? "").replace(/[&<>"']/g, character =>
              ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character]!));
            notePanel.webview.html = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy"
              content="default-src 'none'; style-src 'unsafe-inline';"><style>body{padding:24px;color:var(--vscode-editor-foreground);
              font-family:var(--vscode-font-family)}pre{white-space:pre-wrap;line-height:1.6}small{opacity:.7}</style></head>
              <body data-knowledge-id="${escape(target.note.knowledgeId)}"><h1>${escape(target.note.title)}</h1>
              <small>${escape(target.note.path)}</small><pre>${escape(target.note.content)}</pre></body></html>`;
          }
          return;
        }
        if (message.command === "copyText") {
          const value = String(message.text);
          if (!data.chats.some((chat: any) => chat.chatUrl === value)) throw new Error("Copy only an admitted original Chat link.");
          await vscode.env.clipboard.writeText(value); return;
        }
        if (message.slug !== slug) throw new Error("Todo request changed its exact original Note identity.");
        let input: Record<string, unknown>;
        if (message.command === "noteTodoRead") input = { kind: "read", boardSlug: slug };
        else if (message.command === "noteTodoCommand" || message.command === "todoBoardGrantWorker") {
          const operation = structuredClone(message.operation);
          if (operation?.action === "edit" && operation.item && typeof operation.item === "object") {
            for (const field of ["history", "comments", "acceptanceDecision", "deletedAt", "deletedBy"]) delete operation.item[field];
          }
          input = { kind: "command", boardSlug: slug, expectedDigest: message.expectedDigest, command: operation };
          let token: string | undefined;
          if (message.command === "todoBoardGrantWorker") {
            if (typeof message.actorId !== "string" || !/^external:(copilot|claude|other):[A-Za-z0-9._-]{1,128}$/.test(message.actorId))
              throw new Error("Provide an exact external Board worker identity.");
            token = randomBytes(32).toString("hex");
            input = { kind: "worker-grant", boardSlug: slug, expectedDigest: message.expectedDigest,
              actorId: message.actorId, tokenHash: createHash("sha256").update(token).digest("hex") };
          }
          const fingerprint = createHash("sha256").update(JSON.stringify(input)).digest("hex");
          const key = `pkm.privateNativeTodo.operations:${callbacks.workspaceId}`;
          const cache = context.globalState.get<Record<string, string>>(key, {});
          const operationId = cache[fingerprint] ?? randomUUID();
          cache[fingerprint] = operationId;
          const entries = Object.entries(cache).slice(-256);
          await context.globalState.update(key, Object.fromEntries(entries));
          input.operationId = operationId;
          if (token) {
            await context.secrets.store(pendingWorkerKey(slug, String(input.actorId), String(input.tokenHash)), token);
          }
          const result = await callbacks.rpc({ method: "todo", input });
          if (token) {
            if (result.workerGrants?.[message.actorId] !== input.tokenHash)
              throw new Error("Worker grant changed before its profile secret could be finalized; old secret was not replaced.");
            await finishWorker(input, token);
          }
          await panel.webview.postMessage({ command: "noteTodoResult", data: { ...await withWorkerStatus(slug, result), slug, requestId } });
          if (token) {
            const choice = await vscode.window.showInformationMessage("Native Board worker grant saved in this private profile SecretStorage.", "Copy worker token");
            if (choice) await vscode.env.clipboard.writeText(token);
          }
          return;
        } else throw new Error("Unknown original Todo UI command; no fallback to a legacy writer.");
        const result = await callbacks.rpc({ method: "todo", input });
        await panel.webview.postMessage({ command: "noteTodoResult", data: { ...await withWorkerStatus(slug, result), slug, requestId } });
      } catch (error) {
        await panel.webview.postMessage({ command: "noteTodoResult", data: { slug, requestId,
          error: error instanceof Error ? error.message : "Native Todo UI refused." } });
      }
    });
    panel.onDidDispose(() => { listener.dispose(); panels.delete(panel); });
  };
  const command = vscode.commands.registerCommand("personalKnowledge.nextPrivateTodoBoard", open);
  const library = callbacks.root && callbacks.refreshBoards && callbacks.createBoard ? registerNativeTodoLibrary(context, {
    root: callbacks.root, boards: callbacks.boards, refreshBoards: callbacks.refreshBoards,
    create: callbacks.createBoard, read: boardSlug => callbacks.rpc({ method: "todo", input: { kind: "read", boardSlug } }), open,
    lifecycle: callbacks.lifecycle, trash: callbacks.trash,
  }) : undefined;
  void vscode.commands.executeCommand("setContext", "pkm.privateNativeTodo", callbacks.boards().length > 0);
  return { dispose() { command.dispose(); library?.dispose(); for (const panel of panels) panel.dispose();
    void vscode.commands.executeCommand("setContext", "pkm.privateNativeTodo", false); } };
}
