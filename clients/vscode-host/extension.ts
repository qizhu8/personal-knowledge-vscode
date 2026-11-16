import * as vscode from "vscode";
import { randomBytes } from "node:crypto";
import { publicName } from "../../src/public-identity";
import { bindWebview, registerCommands, VscodeClient } from "../vscode/index.ts";
import { IsolatedManagedMigration } from "./managed-migration";
import { registerFirstRunImport } from "./first-run-import";
import { productionCoordinatorConfiguration, registerProductionCoordinator } from "./production-coordinator";
import { McpApiUnavailableError, registerIsolatedMcp } from "./mcp-provider";

const secretKey = "pkm.next-host.bearer";
type Disposable = { dispose(): void };
let migration: IsolatedManagedMigration | undefined;
let production: ReturnType<typeof registerProductionCoordinator> | undefined;

function configuration() {
  const config = vscode.workspace.getConfiguration("pkm.nextHost");
  const get = (name: string): string => {
    // Workspace settings are not an authority for bearer-token destinations.
    const value = config.inspect<string>(name)?.globalValue;
    if (typeof value !== "string" || !value.trim() || value !== value.trim() || value.length > 256)
      throw new Error("INVALID_HOST_CONFIGURATION");
    return value;
  };
  return { origin: get("origin"), workspaceId: get("workspaceId"), actorId: get("actorId") };
}

export function activate(context: vscode.ExtensionContext): Readonly<{ assertActiveMigrationContext(candidate: unknown): void }> {
  migration = new IsolatedManagedMigration();
  let client: VscodeClient | undefined;
  let disposed = false;
  const panels = new Set<vscode.WebviewPanel>();
  const bindings = new Map<vscode.WebviewPanel, Disposable>();
  const diagnostics = vscode.window.createOutputChannel("pkm-v5 Experimental");
  production = registerProductionCoordinator(context, diagnostics);
  const mcpRoot = () => {
    if (productionCoordinatorConfiguration()) return undefined;
    const root = vscode.workspace.getConfiguration("pkm.nextHost").inspect<unknown>("managedRoot")?.globalValue;
    if (root === undefined || root === "") return undefined;
    if (typeof root !== "string" || root !== root.trim()) throw new Error("INVALID_ISOLATED_MANAGED_ROOT");
    return root;
  };
  let mcp: ReturnType<typeof registerIsolatedMcp> | undefined;
  try { mcp = registerIsolatedMcp(vscode, mcpRoot); }
  catch (error) {
    if (!(error instanceof McpApiUnavailableError)) throw error;
    diagnostics.appendLine(`${error.code}: ${error.message}`);
    void vscode.window.showErrorMessage(error.message);
  }
  const mcpConfiguration = vscode.workspace.onDidChangeConfiguration(event => {
    if (event.affectsConfiguration("pkm.nextHost.managedRoot")
      || event.affectsConfiguration("pkm.nextHost.productionCoordinator")) mcp?.refresh();
  });

  const reset = () => {
    const pending = client?.state().pending ?? [];
    if (pending.length) {
      diagnostics.appendLine("Connection closed with in-flight or uncertain writes. Their exact retry bodies are no longer available.");
      diagnostics.appendLine(`Operation IDs: ${pending.join(", ")}`);
      diagnostics.appendLine("Reconcile server receipts before submitting replacement requests. No automatic replay was performed.");
      void vscode.window.showWarningMessage("pkm-v5: in-flight or uncertain writes need reconciliation. See the pkm-v5 Experimental output for operation IDs.");
    }
    for (const panel of [...panels]) panel.dispose();
    for (const binding of bindings.values()) binding.dispose();
    bindings.clear();
    panels.clear();
    client?.dispose();
    client = undefined;
  };
  const connect = async () => {
    if (productionCoordinatorConfiguration()) throw new Error("The active same-root coordinator excludes the unrelated HTTP client.");
    reset();
    const trusted = configuration();
    const candidate = new VscodeClient({
      secrets: { get: async key => context.secrets.get(key) },
      // These values come from user-level host provisioning, not server_info.
      attestServer: async origin => {
        if (origin !== trusted.origin) throw new Error("UNTRUSTED_ORIGIN");
        return { serverId: publicName, workspaceId: trusted.workspaceId, actorId: trusted.actorId, protocolVersion: "v1" };
      },
    }, { origin: trusted.origin, secretKey, expectedWorkspaceId: trusted.workspaceId });
    client = candidate;
    try {
      await candidate.connect();
      if (disposed || client !== candidate) throw new Error("CONNECTION_CANCELLED");
    } catch (error) {
      if (client === candidate) { candidate.dispose(); client = undefined; }
      throw error;
    }
  };
  const safe = (operation: () => Promise<unknown> | unknown) => async () => {
    try { return await operation(); }
    catch {
      void vscode.window.showErrorMessage("pkm-v5 host operation failed. Check trusted host configuration and server availability.");
      return undefined;
    }
  };
  // Use the shared command adapter but deliberately omit human-review registration.
  const commandHost = {
    registerCommand(id: string, handler: () => Promise<unknown> | unknown): Disposable {
      if (id === "pkm.next.openHumanReview") return { dispose() {} };
      return vscode.commands.registerCommand(id, safe(handler));
    },
  };
  // A forwarding client allows registrations to survive replacement on reconnect.
  const forwarding = {
    connect,
    disconnect: reset,
    openHumanReview: async () => { throw new Error("UNAVAILABLE"); },
  } as unknown as VscodeClient;
  const persistentRegistrations = registerCommands(commandHost, forwarding);

  const open = vscode.commands.registerCommand("pkm.nextHost.open", safe(() => {
    if (!client || client.state().status !== "connected") throw new Error("NOT_CONNECTED");
    const panel = vscode.window.createWebviewPanel("pkmNextHost", "pkm-v5 (Experimental)", vscode.ViewColumn.One, {
      enableScripts: true, retainContextWhenHidden: false,
    });
    panels.add(panel);
    const channel = {};
    const binding = bindWebview(client, {
      onMessage: listener => panel.webview.onDidReceiveMessage(message => listener({ source: channel, message })),
      postMessage: message => Promise.resolve(panel.webview.postMessage(message)),
    }, channel);
    bindings.set(panel, binding);
    panel.onDidDispose(() => { binding.dispose(); bindings.delete(panel); panels.delete(panel); });
    panel.webview.html = html();
  }));
  const token = vscode.commands.registerCommand("pkm.nextHost.setToken", safe(async () => {
    const value = await vscode.window.showInputBox({ password: true, ignoreFocusOut: true, prompt: "Token for the externally started pkm-v5 server" });
    if (value === undefined) return;
    if (value.length < 32 || /[\r\n]/.test(value)) throw new Error("INVALID_TOKEN");
    reset();
    await context.secrets.store(secretKey, value);
  }));
  const migrationCommands = [
    vscode.commands.registerCommand("pkm.nextHost.migrationConnect", safe(async () => {
      if (productionCoordinatorConfiguration()) throw new Error("The active same-root coordinator excludes isolated-generation clients.");
      const root = vscode.workspace.getConfiguration("pkm.nextHost").inspect<string>("managedRoot")?.globalValue;
      if (typeof root !== "string" || !root.trim()) throw new Error("MISSING_ISOLATED_MANAGED_ROOT");
      return migration!.connect(root);
    })),
    vscode.commands.registerCommand("pkm.nextHost.migrationDisconnect", safe(() => migration!.close())),
    vscode.commands.registerCommand("pkm.nextHost.migrationState", () => migration!.state()),
    vscode.commands.registerCommand("pkm.nextHost.migrationInvoke", async (request: unknown) => {
      if (!request || typeof request !== "object" || Array.isArray(request)) throw new Error("INVALID_MIGRATION_CALL");
      const { name, input } = request as { name: unknown; input: unknown };
      if (typeof name !== "string" || !input || typeof input !== "object" || Array.isArray(input)) throw new Error("INVALID_MIGRATION_CALL");
      return migration!.invoke(name, input as Record<string, unknown>);
    }),
  ];
  context.subscriptions.push(open, token, ...(mcp ? [mcp] : []), mcpConfiguration,
    ...migrationCommands, ...registerFirstRunImport(context, diagnostics),
    ...production.subscriptions, persistentRegistrations, {
    dispose() {
      if (disposed) return; disposed = true; reset();
      void migration?.close().catch(() => console.error("Isolated migration drain requires action; no call replayed or process forcibly terminated."));
    },
  }, diagnostics);
  return Object.freeze({
    assertActiveMigrationContext(candidate: unknown) {
      if (disposed || candidate !== context) throw new Error("The migration context is not this live extension activation.");
    },
  });
}

export async function deactivate(): Promise<void> { await production?.close(); await migration?.close(); }

function html(): string {
  // The page has no user-controlled HTML, network access, or dynamic code.
  const nonce = randomBytes(16).toString("base64");
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'">
<meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body><h1>pkm-v5 (Experimental)</h1><p>Uncertain writes are kept only in memory. Reconcile server receipts before replacing a request.</p>
<button id="state">State</button><button id="list">List documents</button><pre id="result"></pre>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
let sequence = 0;
const send = action => vscode.postMessage({ requestId: String(++sequence), action, input: {} });
document.getElementById('state').addEventListener('click', () => send('state'));
document.getElementById('list').addEventListener('click', () => send('knowledgeList'));
window.addEventListener('message', event => { document.getElementById('result').textContent = JSON.stringify(event.data, null, 2); });
</script></body></html>`;
}
