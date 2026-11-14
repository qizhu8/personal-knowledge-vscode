import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { createHash } from "crypto";
import { PluginHostAuthority } from "../runtime/plugin-host-authority";

/** No Teams implementation is packaged/admitted: do not infer one from legacy configuration. */
export function registerNativePluginWorkspace(context: vscode.ExtensionContext, legacyRoot: () => string): void {
  let authority: PluginHostAuthority | undefined;
  let configuring = false;
  const stop = async () => { const previous = authority; authority = undefined; await previous?.dispose(); };
  const configure = async () => {
    if (configuring) throw new Error("A plugin configuration is already in progress.");
    configuring = true;
    let candidate: PluginHostAuthority | undefined;
    try {
      if (!vscode.workspace.isTrusted) throw new Error("Plugins require VS Code workspace trust.");
      const selected = await vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true,
        canSelectMany: false, openLabel: "Select isolated next Plugin workspace" });
      if (!selected?.[0] || selected[0].scheme !== "file") return;
      const root = path.resolve(selected[0].fsPath);
      if (fs.realpathSync(root) !== root || !vscode.workspace.getWorkspaceFolder(vscode.Uri.file(root)))
        throw new Error("Select a canonical isolated directory inside the trusted VS Code workspace.");
      const stat = fs.lstatSync(root);
      if (!stat.isDirectory() || stat.isSymbolicLink() || process.platform !== "win32"
        && ((stat.mode & 0o077) !== 0 || process.getuid && stat.uid !== process.getuid()))
        throw new Error("The isolated workspace must be private to this account.");
      const previousRoot = legacyRoot();
      const overlaps = (parent: string, child: string) => {
        const relative = path.relative(parent, child);
        return relative === "" || relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
      };
      if (previousRoot && (overlaps(path.resolve(previousRoot), root) || overlaps(root, path.resolve(previousRoot))))
        throw new Error("Plugin configuration must not target or contain the current Knowledge Root.");
      const markerPath = path.join(root, ".pkm-next-workspace");
      const markerStat = fs.lstatSync(markerPath);
      if (!markerStat.isFile() || markerStat.isSymbolicLink() || markerStat.nlink !== 1 || markerStat.size > 8192)
        throw new Error("Unsafe next workspace identity.");
      const marker = JSON.parse(fs.readFileSync(markerPath, "utf8")) as { schema?: string; id?: string };
      if (marker.schema !== "pkm.next-workspace/v2" || typeof marker.id !== "string"
        || !/^[a-f0-9-]{36}$/i.test(marker.id)) throw new Error("Select an initialized isolated next workspace.");
      const actorId = await vscode.window.showQuickPick(["mcp:external", "local:owner"], {
        title: "Plugin actor (must match the native server's authenticated actor)",
      });
      if (!actorId) return;
      const key = `pkm.native-plugin.v1.${createHash("sha256").update(JSON.stringify([root, marker.id, actorId])).digest("hex")}`;
      candidate = new PluginHostAuthority({
        workspaceRoot: root, workspaceId: marker.id, actorId,
        isTrusted: () => vscode.workspace.isTrusted && !!vscode.workspace.getWorkspaceFolder(vscode.Uri.file(root)),
        load: () => context.globalState.get(key),
        save: async grant => { await context.globalState.update(key, grant); },
        confirmInvocation: async request => {
          const label = "Allow this invocation";
          return await vscode.window.showWarningMessage(`Allow Plugin ${request.action === "enable" ? "initialization" : "notification read"}?`, { modal: true,
            detail: `Workspace: ${root}\nWorkspace ID: ${request.workspaceId}\nActor: ${request.actorId}\nAction: ${request.action}\nCapability: ${request.capability}\nImplementation SHA-256: ${request.implementationSha256}\nConfiguration SHA-256: ${request.configurationSha256}\nRevision: ${request.revision}\nInput SHA-256: ${request.inputDigest}\n\nConsent applies only to this initialization/invocation. This does not authorize outbound messages or access to arbitrary credentials.`,
          }, label) === label;
        },
      });
      const previous = candidate.snapshot()?.configuration;
      const configuration: Record<string, string> = {};
      for (const field of ["tenantId", "clientId", "credentialRef"] as const) {
        const value = await vscode.window.showInputBox({
          title: `Teams ${field} (non-secret opaque identifier only)`,
          prompt: field === "credentialRef" ? "Reference only. Do NOT enter a token, password or client secret." : "Do NOT enter a credential.",
          value: previous?.[field],
          validateInput: input => /^[A-Za-z0-9._:-]{1,256}$/.test(input) ? undefined : "Use 1–256 opaque identifier characters.",
        });
        if (value === undefined) return;
        configuration[field] = value;
      }
      const label = "Save disabled configuration";
      if (await vscode.window.showWarningMessage("Teams implementation is not admitted", { modal: true,
        detail: `${root}\nActor: ${actorId}\n\nThe original Teams source/API is not available in this package. This saves only a disabled configuration draft; it does not enable Teams, resolve credentials, import an archived grant, load code, or contact a provider. Native enable/invoke will report NOT_AVAILABLE until an exact packaged implementation is admitted. Every later effectful invocation still needs host consent.`,
      }, label) !== label) return;
      await stop();
      await candidate.configure(configuration);
      await candidate.start();
      authority = candidate;
      candidate = undefined;
      await vscode.window.showInformationMessage("Plugin configuration saved disabled. Teams implementation_not_injected; no credentials or provider were accessed.");
    } finally { configuring = false; await candidate?.dispose(); }
  };
  context.subscriptions.push(
    vscode.commands.registerCommand("personalKnowledge.plugins.configureNativeWorkspace", configure),
    vscode.commands.registerCommand("personalKnowledge.plugins.revokeNativeWorkspace", async () => {
      if (!authority) { await vscode.window.showInformationMessage("No active native Plugin authority."); return; }
      await authority.revoke();
      await stop();
      await vscode.window.showInformationMessage("Plugin authorization revoked. Reconfiguration creates a new revision; archived grants are never inherited.");
    }),
    vscode.commands.registerCommand("personalKnowledge.plugins.nativeWorkspaceStatus", async () => {
      const grant = authority?.snapshot();
      const status = { active: !!authority && vscode.workspace.isTrusted, implementation: "not-admitted",
        ...(grant ? { workspaceId: grant.workspaceId, actorId: grant.actorId, revision: grant.revision, enabled: grant.enabled } : {}) };
      await vscode.window.showInformationMessage(`Native Plugin: ${status.active ? "configured, disabled" : "inactive"}; Teams implementation not admitted.`);
      return status;
    }),
    { dispose() { void stop(); } },
  );
}
