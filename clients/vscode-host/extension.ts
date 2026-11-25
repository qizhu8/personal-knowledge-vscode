import * as vscode from "vscode";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { publicName } from "../../src/public-identity";
import { bindWebview, registerCommands, VscodeClient } from "../vscode/index.ts";
import { IsolatedManagedMigration } from "./managed-migration";
import { registerFirstRunImport } from "./first-run-import";
import { productionCoordinatorConfiguration, registerProductionCoordinator } from "./production-coordinator";
import { McpApiUnavailableError, registerIsolatedMcp } from "./mcp-provider";
import { bindOriginalMcpEnrollment } from "./original-mcp-enrollment.js";
import { registerOriginalMcpNativeIdentity } from "./original-mcp-native-identity.js";
import { registerOriginalMcpNativeAttachment } from "./original-mcp-native-attachment.js";
import { registerOriginalMcpNativeCredentials } from "./original-mcp-native-credentials.js";
import { sharedManagedRequest, type SharedManagedBinding } from "../../src/shared-managed-client.js";
import { experimentalPanelHtml } from "./chat-panel.js";

const secretKey = "pkm.next-host.bearer";
const sharedTokenKey = "pkm.next-host.shared-bearer";
const sharedManagementKey = "pkm.next-host.shared-management";
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
  const originalEnrollment = bindOriginalMcpEnrollment(context.globalStorageUri.fsPath);
  production = registerProductionCoordinator(context, diagnostics);
  const mcpRoot = () => {
    if (productionCoordinatorConfiguration()) return undefined;
    const root = vscode.workspace.getConfiguration("pkm.nextHost").inspect<unknown>("managedRoot")?.globalValue;
    if (root === undefined || root === "") return undefined;
    if (typeof root !== "string" || root !== root.trim()) throw new Error("INVALID_ISOLATED_MANAGED_ROOT");
    return root;
  };
  const originalMcp = () => {
    const enrolled = originalEnrollment.current();
    if (enrolled && productionCoordinatorConfiguration())
      throw new Error("ORIGINAL_MCP_CONFIGURATION_CONFLICT");
    return enrolled;
  };
  const sharedConfiguration = () => {
    const value = vscode.workspace.getConfiguration("pkm.nextHost").inspect<unknown>("sharedServer")?.globalValue;
    if (value === undefined || value && typeof value === "object" && (value as { enabled?: unknown }).enabled === false)
      return undefined;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("INVALID_SHARED_SERVER");
    const config = value as Record<string, unknown>;
    if (config.enabled !== true || typeof config.origin !== "string" || typeof config.serviceId !== "string"
      || config.backendKind !== undefined && !["native-public-mcp", "standalone-core"].includes(String(config.backendKind))
      || config.generation !== undefined && (typeof config.generation !== "string" || !/^[a-f0-9-]{36}$/.test(config.generation))
      || productionCoordinatorConfiguration()) throw new Error("INVALID_SHARED_SERVER");
    return { origin: config.origin, serviceId: config.serviceId, generation: config.generation as string | undefined,
      backendKind: (config.backendKind ?? "native-public-mcp") as "native-public-mcp" | "standalone-core" };
  };
  const sharedBinding = async (management = false): Promise<SharedManagedBinding> => {
    const config = sharedConfiguration();
    const token = await context.secrets.get(management ? sharedManagementKey : sharedTokenKey);
    if (!config || !token) throw new Error("SHARED_SERVER_PROVISIONING_REQUIRED");
    return { origin: config.origin, serviceId: config.serviceId, token };
  };
  let mcp: ReturnType<typeof registerIsolatedMcp> | undefined;
  try { mcp = registerIsolatedMcp(vscode, mcpRoot, originalMcp, async () => sharedConfiguration()
    ? { ...await sharedBinding(), backendKind: sharedConfiguration()!.backendKind,
      relayPath: join(context.extensionPath, "next-runtime", "server", "dist", "shared-managed-relay.js") }
    : undefined); }
  catch (error) {
    if (!(error instanceof McpApiUnavailableError)) throw error;
    diagnostics.appendLine(`${error.code}: ${error.message}`);
    void vscode.window.showErrorMessage(error.message);
  }
  const mcpConfiguration = vscode.workspace.onDidChangeConfiguration(event => {
    if (event.affectsConfiguration("pkm.nextHost.managedRoot")
      || event.affectsConfiguration("pkm.nextHost.productionCoordinator")) mcp?.refresh();
    if (event.affectsConfiguration("pkm.nextHost.sharedServer")) {
      // The relay definition stays stable across generation changes; only its backend is handed off.
      void applySharedSelection().catch(error => diagnostics.appendLine(`Shared server selection refused: ${String(error)}. No request was replayed.`));
    }
  });
  const originalInventory = originalMcp() ? vscode.extensions.onDidChange(() => mcp?.refresh()) : undefined;

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
  let sharedTransition: Promise<unknown> | undefined;
  const sharedManage = async (action: string, generation?: string, fields?: { receiptId?: string; acknowledge: string }) => {
    if (sharedTransition) throw new Error("SHARED_TRANSITION_RUNNING");
    const selected = sharedConfiguration();
    const binding = await sharedBinding(true);
    const confirmation = await vscode.window.showWarningMessage(
      `pkm-v5 shared isolated server ${binding.serviceId}: ${action}${generation ? ` to ${generation}` : ""}${fields?.receiptId ? ` reviewed receipt ${fields.receiptId}` : ""}? All enrolled clients share this backend. No uncertain write will be replayed.${action === "revoke-access" ? " This revokes the current business credential for EVERY HTTP/MCP client, including connected clients. Already-admitted work is not cancelled. A new independently provisioned environment credential and manager restart are required to restore business access." : ""}`,
      { modal: true }, "Approve");
    if (confirmation !== "Approve") return;
    if (sharedTransition) throw new Error("SHARED_TRANSITION_RUNNING");
    if (JSON.stringify(sharedConfiguration()) !== JSON.stringify(selected)) throw new Error("SHARED_SELECTION_CHANGED");
    sharedTransition = (async () => {
      const approval = await sharedManagedRequest(binding, "/manage/approve", { action,
        ...(generation ? { generation } : {}), ...fields });
      return sharedManagedRequest(binding, `/manage/${action}`, {
        approvalId: approval.approvalId, ...(generation ? { generation } : {}), ...fields,
      });
    })();
    try { return await sharedTransition; } finally { sharedTransition = undefined; }
  };
  const applySharedSelection = async () => {
    const config = sharedConfiguration();
    if (!config) { mcp?.refresh(); return; }
    const status = await sharedManagedRequest(await sharedBinding(), "/shared/status");
    if (config.generation && status.generation !== config.generation) await sharedManage("switch", config.generation);
    // Refresh only an origin/identity change, not the live generation selection.
    const identity = JSON.stringify([config.origin, config.serviceId, config.backendKind]);
    if (sharedIdentity !== identity) { sharedIdentity = identity; mcp?.refresh(); }
  };
  let sharedIdentity = (() => {
    try {
      const config = sharedConfiguration();
      return config ? JSON.stringify([config.origin, config.serviceId, config.backendKind]) : undefined;
    } catch { diagnostics.appendLine("Invalid shared server machine settings; provisioning is refused."); return undefined; }
  })();
  const sharedCommands = [
    vscode.commands.registerCommand("pkm.nextHost.sharedStatus", safe(async () => {
      const status = await sharedManagedRequest(await sharedBinding(), "/shared/status")
        .catch(async () => sharedManagedRequest(await sharedBinding(true), "/manage/status"));
      diagnostics.appendLine(JSON.stringify(status)); diagnostics.show(); return status;
    })),
    vscode.commands.registerCommand("pkm.nextHost.sharedSwitch", safe(() => applySharedSelection())),
    vscode.commands.registerCommand("pkm.nextHost.sharedRecover", safe(() => sharedManage("recover"))),
    vscode.commands.registerCommand("pkm.nextHost.sharedCleanupRuntime", safe(() => sharedManage("cleanup-runtime"))),
    vscode.commands.registerCommand("pkm.nextHost.sharedResetIndex", safe(() => sharedManage("reset-index"))),
    vscode.commands.registerCommand("pkm.nextHost.sharedRevokeAccess", safe(() => sharedManage("revoke-access",
      undefined, { acknowledge: "revoke-current-business-credential" }))),
    vscode.commands.registerCommand("pkm.nextHost.sharedHumanReview", safe(async () => {
      const enrollment = await sharedManage("human-review-enrollment");
      if (!enrollment) return;
      if (typeof enrollment !== "object" || !("code" in enrollment)
        || typeof enrollment.code !== "string" || !/^[a-f0-9]{64}$/.test(enrollment.code))
        throw new Error("INVALID_HUMAN_ENROLLMENT");
      await vscode.window.showInputBox({ password: true, ignoreFocusOut: true, value: enrollment.code,
        prompt: "Copy this one-use native HUMAN APPROVAL enrollment code. Valid 120 seconds; paste into the separate review desk. Never send it to a model or ordinary client." });
      await vscode.env.openExternal(vscode.Uri.parse(`${(await sharedBinding(true)).origin}/human-review`));
    })),
    vscode.commands.registerCommand("pkm.nextHost.sharedReconcile", safe(async () => {
      const receiptId = await vscode.window.showInputBox({ ignoreFocusOut: true,
        prompt: "Exact unknown receipt UUID, only AFTER independently reviewing its actual outcome. This acknowledges review; it never retries." });
      if (receiptId === undefined) return;
      if (!/^[a-f0-9-]{36}$/.test(receiptId)) throw new Error("INVALID_RECEIPT");
      return sharedManage("reconcile", undefined, { receiptId, acknowledge: "reviewed-outcome-no-replay" });
    })),
    ...[[sharedTokenKey, "pkm.nextHost.setSharedToken", "business"],
      [sharedManagementKey, "pkm.nextHost.setSharedManagementToken", "management"]].map(([key, command, authority]) =>
      vscode.commands.registerCommand(command, safe(async () => {
        const value = await vscode.window.showInputBox({ password: true, ignoreFocusOut: true,
          prompt: `Independently provisioned shared server ${authority} token` });
        if (value === undefined) return;
        if (value.length < 32 || /[\r\n]/.test(value)) throw new Error("INVALID_TOKEN");
        await context.secrets.store(key, value);
        if (key === sharedTokenKey) mcp?.refresh();
      }))),
  ];
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
  context.subscriptions.push(open, token, ...(mcp ? [mcp] : []), mcpConfiguration, ...(originalInventory ? [originalInventory] : []),
    ...migrationCommands, ...sharedCommands, ...registerFirstRunImport(context, diagnostics),
    registerOriginalMcpNativeIdentity(context, diagnostics),
    registerOriginalMcpNativeAttachment(context, diagnostics),
    registerOriginalMcpNativeCredentials(context, diagnostics),
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
  const nonce = randomBytes(16).toString("base64");
  return experimentalPanelHtml(nonce);
}
