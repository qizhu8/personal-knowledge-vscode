import * as vscode from "vscode";
import { hostname } from "node:os";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import Module from "node:module";
import { dirname, join } from "node:path";
import { createOriginalMcpNativePortalSource, type OriginalPortalEndpointStorePort } from "../../src/original-mcp-portal-source.js";
import { originalPortalNativeMethod, originalPortalNativePayload, originalPortalRequestDigest,
  parseOriginalPortalNativePayload } from "../../src/original-mcp-portal-contracts.js";
import type { OriginalMcpNativeRequestFrame } from "../../src/original-mcp-native-request.js";

/** Local decisions only. Original peer, receipts, transport and process ownership remain in the server. */
export function createOriginalMcpNativePortalConsent(options: {
  assertCurrent(): void; activationId: string; context: vscode.ExtensionContext;
}) {
  const stores = new Map<string, OriginalPortalEndpointStorePort>();
  const commands: vscode.Disposable[] = [];
  let disposed = false;
  const assertCurrent = () => {
    options.assertCurrent();
    if (disposed) throw new Error("PORTAL_NATIVE_SOURCE_DISPOSED");
  };
  const decisions = Object.freeze({
    methods: [originalPortalNativeMethod],
    async handle(frame: OriginalMcpNativeRequestFrame, signal: AbortSignal) {
      if (frame.method !== originalPortalNativeMethod) throw new Error("MISSING_NATIVE_METHOD");
      assertCurrent();
      const payload = parseOriginalPortalNativePayload(frame.payload, frame.session);
      const current = () => {
        assertCurrent();
        if (signal.aborted || !vscode.workspace.isTrusted || frame.session.activationId !== options.activationId)
          throw new Error("NATIVE_REQUEST_CANCELLED");
      };
      current();
      const request = payload.request;
      let approved = false, role: "controller" | "controlled" | undefined, privateLink: string | undefined;
      let paths: string[] | undefined, chatId: string | undefined, name: string | undefined;
      let grant: { mode: "once" | "scoped" | "all"; permissions?: string[]; durationMs: number | null } | undefined;
      if (request.phase === "manual-result") {
        await vscode.window.showInformationMessage(`Portal manual attempt ${request.detail.commandId}: ${request.detail.status}. ${request.detail.error} Never automatically replay.`);
        current(); approved = true;
      } else if (request.phase === "open") {
        const answer = await vscode.window.showQuickPick(["Controller", "Controlled", "Saved Controller", "Saved Controlled"], {
          title: "Open a Portal", placeHolder: "Saved endpoints use this native workspace's SecretStorage, never archived Portal credentials.",
        });
        current();
        if (answer?.startsWith("Saved")) {
          name = await vscode.window.showInputBox({ title: "Create a named native Portal endpoint", ignoreFocusOut: true,
            validateInput: value => value.trim() === value && value.length > 0 && value.length <= 128 ? undefined : "Use 1–128 characters." });
          current();
          if (!name) return { decision: "deny", requestSha256: payload.requestSha256, epoch: options.activationId, expiresAtMs: Date.now() + 120000 };
        }
        if (answer === "Controller" || answer === "Saved Controller") { role = "controller"; approved = true; }
        if (answer === "Controlled" || answer === "Saved Controlled") {
          privateLink = await vscode.window.showInputBox({ title: "Paste the private Portal code locally", password: true,
            ignoreFocusOut: true, prompt: "Never put this code in MCP arguments or a Chat." });
          current(); if (privateLink) { role = "controlled"; approved = true; }
        }
      } else if (request.phase === "pair-code") {
        const link = request.detail.privateLink;
        if (typeof link !== "string") throw new Error("NATIVE_REQUEST_INVALID");
        const answer = await vscode.window.showWarningMessage("Copy this temporary Portal pairing code?", {
          modal: true, detail: "Share privately with the controlled user. This does not approve tasks, commands or files.",
        }, "Copy private code", "Deny");
        current();
        if (answer === "Copy private code") { await vscode.env.clipboard.writeText(link); current(); approved = true; }
      } else if (request.phase === "permissions") {
        const mode = await vscode.window.showQuickPick(["once", "scoped", "all"], {
          title: "Portal permissions for this exact connection", placeHolder: "File transfer always requires separate batch consent.",
        });
        current();
        const permissions = mode && mode !== "all" ? await vscode.window.showQuickPick([
          "chat-read", "progress-read", "files-read", "files-write", "code-execute",
          "pkm-read", "pkm-write", "git-read", "git-write", "environment-manage",
        ], { canPickMany: true, title: "Choose local Portal permission dimensions" }) : undefined;
        current();
        if (mode === "all" || permissions?.length) {
          const duration = await vscode.window.showInputBox({ title: "Fixed permission deadline in minutes",
            value: "15", prompt: "1–1440 minutes, or 0 until disconnect. Use never renews the grant.",
            validateInput: value => /^\d+$/.test(value) && Number(value) <= 1440 ? undefined : "Choose 0–1440." });
          current();
          if (duration !== undefined) {
            const confirmation = await vscode.window.showWarningMessage("Grant these permissions on this connection?", {
              modal: true, detail: "Code execution can access files, credentials and networks. Every native command still needs exact executing-side approval; file batches are never covered by Allow All.",
            }, "Grant", "Deny");
            current();
            if (confirmation === "Grant") {
              grant = { mode: mode as "once" | "scoped" | "all", ...(permissions ? { permissions } : {}),
                durationMs: Number(duration) === 0 ? null : Number(duration) * 60000 };
              approved = true;
            }
          }
        }
      } else if (request.phase === "files" && request.detail.picker) {
        const picked = await vscode.window.showOpenDialog({ canSelectMany: true, canSelectFiles: true,
          canSelectFolders: false, title: "Select one explicitly offered Portal file batch" });
        current(); if (picked?.length) { paths = picked.map(uri => uri.fsPath); approved = true; }
      } else {
        const warning = request.phase === "manual-attempt"
          ? "Start an independently authorized manual retry of this exact original reply, and link its answer for later separately approved sharing? This is a NEW attempt, not a replay. Current Task/model/tool approvals are still required; UNKNOWN effects block execution."
          : request.phase === "task-transition"
              ? "Retire this exact reconciled Task binding and start a NEW independent Task? Old goals, inputs, Harness and receipts are preserved. UNKNOWN effects cannot be replaced."
              : request.phase === "save-pair"
          ? "Save this exact native pairing and permit incoming requests? Credentials stay in SecretStorage. Every task, command and file batch still needs independent approval."
          : request.phase === "endpoint"
            ? "Reconnect this exact named endpoint using its current native SecretStorage credential? No command or task is replayed."
            : request.phase === "command"
          ? "Approve this exact direct command? Code execution can access files and credentials on this Host; no model is used."
          : request.phase === "files"
            ? "Approve this exact Portal file batch? Allow All never approves file transfer."
            : request.phase === "attempts"
              ? "Share linked manual rerun results? This does not replay the original task."
              : `Approve one local Portal ${request.phase} operation?`;
        const answer = await vscode.window.showWarningMessage(warning, {
          modal: true, detail: JSON.stringify({ root: payload.binding.root, contextId: request.contextId,
            pairId: request.pairId, revision: request.revision, ...Object.fromEntries(Object.entries(request.detail)
              .filter(([key]) => !/credential|secret|privateLink/i.test(key))) }, null, 2),
        }, "Approve this request", "Deny");
        current(); approved = answer === "Approve this request";
        if (approved && request.phase === "task") {
          chatId = await vscode.window.showInputBox({ title: "Select an existing local PKM Chat UUID",
            prompt: "No Chat is created. The server verifies this Chat against current source custody.",
            validateInput: value => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)
              ? undefined : "Use an exact existing Chat UUID." });
          current(); approved = !!chatId;
        }
      }
      return { decision: approved ? "approve" : "deny", requestSha256: payload.requestSha256,
        epoch: options.activationId, expiresAtMs: Date.now() + 120000,
        ...(role ? { role } : {}), ...(privateLink ? { privateLink } : {}),
        ...(paths ? { paths } : {}), ...(chatId ? { chatId } : {}), ...(grant ? { grant } : {}),
        ...(name ? { name, localMachine: hostname() } : {}) };
    },
  });
  const source = createOriginalMcpNativePortalSource({
    assertCurrent,
    store(frame) {
      const id = frame.session.binding.workspaceId;
      let store = stores.get(id);
      if (!store) {
        options.assertCurrent();
        const file = join(options.context.extensionPath, "next-runtime/server/dist/legacy-chatroom-retained.cjs");
        const bytes = readFileSync(file), manifest = JSON.parse(readFileSync(
          join(options.context.extensionPath, "next-runtime/manifest.json"), "utf8"));
        if (manifest.files["server/dist/legacy-chatroom-retained.cjs"] !== createHash("sha256").update(bytes).digest("hex"))
          throw new Error("PORTAL_NATIVE_RETAINED_PAYLOAD_CHANGED");
        const Loader = Module as typeof Module & { _nodeModulePaths(path: string): string[] };
        const loaded = new Loader(file) as Module & { _compile(source: string, path: string): void };
        loaded.filename = file; loaded.paths = Loader._nodeModulePaths(dirname(file)); loaded._compile(bytes.toString("utf8"), file);
        const Store = loaded.exports.PortalEndpointStore as new (state: unknown, secrets: unknown) => OriginalPortalEndpointStorePort;
        const prefix = `pkm.native.portal.${id}.`;
        store = new Store({
          get: <T>(key: string) => options.context.workspaceState.get<T>(prefix + key),
          update: (key: string, value: unknown) => options.context.workspaceState.update(prefix + key, value),
        }, {
          get: (key: string) => options.context.secrets.get(prefix + key),
          store: (key: string, value: string) => options.context.secrets.store(prefix + key, value),
          delete: (key: string) => options.context.secrets.delete(prefix + key),
        });
        if (commands.length === 0) {
        commands.push(vscode.commands.registerCommand("personalKnowledge.originalPortalTaskRerun", async () => {
          assertCurrent();
          const choices = source.references().filter(reference => reference.status !== "complete").map(reference => ({ label: `Task ${reference.taskId}`,
            description: `Original reply ${reference.replyId}`, key: reference.key }));
          const selected = await vscode.window.showQuickPick(choices, { title: "Select an exact current native Portal task reply" });
          if (!selected) return;
          assertCurrent();
          const intent = await source.requestManual(selected.key, new AbortController().signal);
          await vscode.window.showInformationMessage(`New manual attempt ${intent.commandId} queued. Inspect the original Portal attempts; no automatic replay.`);
        }));
        commands.push(vscode.commands.registerCommand("personalKnowledge.originalPortalEndpointSettings", async () => {
          assertCurrent();
          const choices = [...stores.values()].flatMap(store => store.list().map(endpoint => ({
            label: endpoint.name, description: endpoint.root, store, endpoint,
          })));
          const selected = await vscode.window.showQuickPick(choices, { title: "Configure a current native named Portal endpoint" });
          if (!selected) return;
          const action = await vscode.window.showQuickPick(["Bind existing Chat", "Unbind Chat", "Delete endpoint", "Enable incoming", "Disable incoming"]);
          if (!action) return;
          let changes: Record<string, unknown>;
          if (action === "Bind existing Chat") {
            const chatId = await vscode.window.showInputBox({ title: "Exact existing Chat UUID",
              validateInput: value => /^[a-f0-9-]{36}$/.test(value) ? undefined : "Use the existing Chat UUID." });
            if (!chatId) return;
            changes = { chatId };
          } else changes = action === "Unbind Chat" ? { chatId: undefined }
            : action === "Delete endpoint" ? { deleted: true }
              : { acceptsIncoming: action === "Enable incoming" };
          const accepted = await vscode.window.showWarningMessage("Apply this exact named endpoint change?", {
            modal: true, detail: JSON.stringify({ endpoint: selected.endpoint, changes,
              warning: "Chat changes/deletion clear grants and stop old execution. Existing pairing credentials are not exported; reconnect never replays tasks." }, null, 2),
          }, "Apply", "Deny");
          assertCurrent();
          if (accepted === "Apply") await selected.store.update(selected.endpoint.id, changes, selected.endpoint.revision);
        }));
        options.context.subscriptions.push(...commands);
        }
        stores.set(id, store);
      }
      return store;
    },
    decide: (request, frame, signal) => decisions.handle({ ...frame, payload: originalPortalNativePayload.parse({
      ...frame.payload, request, requestSha256: originalPortalRequestDigest(request),
    }) } as OriginalMcpNativeRequestFrame, signal),
  });
  return Object.freeze({ methods: decisions.methods, handle: source.handle,
    dispose() { if (disposed) return; disposed = true; commands.splice(0).forEach(command => command.dispose()); source.dispose(); stores.clear(); } });
}
