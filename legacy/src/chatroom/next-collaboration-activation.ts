import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import * as vscode from "vscode";
import { ChatRoomCredentialStore } from "./chat-room-credentials";
import { NextCollaborationClient } from "./next-collaboration-client";
import { markSelectedRoomHostUnavailable, registerAdoptedRoomHostOwner } from "./room-host-owner";
import { verifyNextPayload } from "../runtime/next-payload-verifier";
import { ProjectStore } from "../workflows/project-store";
import { executePortalCommand } from "./portal-command";

type Selection = { schema: "pkm.next-collaboration/v1"; sourceRoot: string; sourceIdentity: string;
  root: string; rootIdentity: string; workspaceId: string };
const identity = (root: string) => {
  const stat = fs.lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(root) !== root)
    throw new Error("Configured Collaboration root identity is unavailable.");
  return `${stat.dev}:${stat.ino}`;
};

/** Separate, explicitly selected Collaboration storage; does not grant general legacy-root adoption. */
export async function registerNextCollaboration(context: vscode.ExtensionContext, getRoot: () => string,
  stopLegacyHub: () => Promise<void>): Promise<void> {
  if (process.platform !== "linux") return;
  const configuredRoot = getRoot();
  if (!configuredRoot || !fs.existsSync(configuredRoot)) return;
  const sourceRoot = fs.realpathSync(configuredRoot), sourceIdentity = identity(sourceRoot);
  const hash = createHash("sha256").update(sourceRoot).digest("hex");
  const profileHash = createHash("sha256").update(context.globalStorageUri.fsPath).digest("hex");
  const key = `personalKnowledge.nextCollaboration.v1.${hash}.${profileHash}`;
  let client: NextCollaborationClient | undefined, selected: Selection | undefined, error: string | undefined;
  let bootstrapping = false, disposed = false, selectionPresent = false;
  const assertCurrent = () => {
    if (disposed || !vscode.workspace.isTrusted || getRoot() !== configuredRoot
      || identity(sourceRoot) !== sourceIdentity) throw new Error("Configured Collaboration root or workspace trust changed.");
    if (selected && (identity(selected.root) !== selected.rootIdentity || selected.sourceRoot !== sourceRoot
      || selected.sourceIdentity !== sourceIdentity)) throw new Error("Selected Collaboration workspace identity changed.");
  };
  const start = async (root: string, bootstrap: boolean, workspaceId?: string) => {
    const payload = verifyNextPayload(context.extensionPath);
    const strict = vscode.workspace.getConfiguration("personalKnowledge").get<boolean>("nextCollaborationStrict", false);
    const active = new NextCollaborationClient({
      entry: path.join(payload.root, "server/dist/next-collaboration-child.js"), root, sourceRoot, workspaceId, bootstrap,
      remoteUrl: vscode.workspace.getConfiguration("personalKnowledge").get<string>("chatHubUrl", "").trim() || undefined,
      assertCurrent, credentials: new ChatRoomCredentialStore(context.secrets), profile: context.secrets,
      strict,
      project(value) {
        assertCurrent();
        if (!strict && value.purpose === "host") return true;
        return new ProjectStore(path.join(sourceRoot, ".pkm", "state"))
          .inspectCollaborationOwnership(value.projectId, value.threadId, value.roomId);
      },
      portal: {
        async authorize(value) {
          assertCurrent();
          if (value.root !== sourceRoot) return false;
          if (!strict || value.operation === "connect" || value.operation === "restore") return true;
          const answer = await vscode.window.showWarningMessage("Strict Collaboration: approve this Portal operation?",
            { modal: true, detail: `${value.operation}\n${JSON.stringify(value.detail)}\n\nAdditional workspace-owner approval, separate from the original endpoint/Chat/file-batch permissions. Not a sandbox; traffic remains plaintext ws/HTTP.` },
            "Approve once");
          assertCurrent();
          return answer === "Approve once";
        },
        async executeCommand(value) {
          assertCurrent();
          if (value.root !== sourceRoot || !/^[a-f0-9-]{36}$/.test(value.contextId)
            || !value.pairId || !value.requestId) throw new Error("Portal execution identity is invalid.");
          return executePortalCommand(path.join(context.globalStorageUri.fsPath, "portal-processes", value.contextId),
            `${value.pairId}:${value.requestId}`, value.command as any, value.defaultCwd, value.signal);
        },
      },
      authorize(binding) {
        assertCurrent();
        return (bootstrapping || !!selected) && binding.root === root && binding.sourceRoot === sourceRoot
          && (!workspaceId || binding.workspaceId === workspaceId);
      },
    });
    try { await active.start(); return active; }
    catch (failure) { await active.close(); throw failure; }
  };
  const status = () => ({ route: client ? "next-collaboration" : selected || selectionPresent ? "blocked-next-selection" : "legacy",
    policy: vscode.workspace.getConfiguration("personalKnowledge").get<boolean>("nextCollaborationStrict", false) ? "strict (reload required after changes)" : "legacy interactions",
    sameRootAdoption: false, sourceRoot, ...(client ? client.status() : {}), error });
  context.subscriptions.push(
    vscode.commands.registerCommand("_personalKnowledge.nextCollaborationStatus", status),
    vscode.commands.registerCommand("personalKnowledge.nextCollaborationStatus", async () => {
      const state = status();
      await vscode.window.showInformationMessage(`Collaboration: ${state.route}${error ? ` — ${error}` : ""}. Original Knowledge Root routing is unchanged.`);
      return state;
    }),
    vscode.commands.registerCommand("personalKnowledge.upgradeCollaboration", async () => {
      if (client || selected || selectionPresent || bootstrapping) {
        await vscode.window.showInformationMessage("This profile already selected Next Collaboration. Reopen its current workspace; do not recopy or overwrite its original archive.");
        return status();
      }
      assertCurrent();
      const choice = await vscode.window.showWarningMessage("Use Next for this profile's Collaboration?",
        { modal: true, detail: `Original Knowledge Root: ${sourceRoot}\n\nStop this window's old Hub normally, preserve its original Room/Meeting/Note bytes, and recover this profile's hosted Rooms into a separate private Next Collaboration workspace. Existing Host secrets come only from this profile's SecretStorage; a join secret does not grant hosting. After a confirmed window reload, ordinary Host/Stored Room actions use that workspace. Other PKM workflows and users who do not choose this remain on their existing route. No same-root/global migration is claimed.\n\nDefault compatibility keeps original Host authority, the old shared-secret/client-ID reconnect interaction and its impersonation risk. The separate nextCollaborationStrict setting additionally verifies existing Project/thread bindings before hosting, requires Host approval on every unmodified old client's identity recovery, including retries, and adds one-operation Portal owner approval. Reload after changing it. Original Portal pairing, receiving permissions, Chat policy and file-batch approval still apply; those tools and Project state remain in the original PKM context. New Project-bound Room creation always verifies the original Project/thread. Retained archive deletion is unavailable. Traffic remains plaintext ws/HTTP, not TLS. Source changes or incomplete credentials stop recovery rather than overwrite either version.` },
        "Upgrade Collaboration");
      if (choice !== "Upgrade Collaboration") return { cancelled: true };
      bootstrapping = true;
      let candidate: NextCollaborationClient | undefined;
      let selectionSaveAttempted = false;
      try {
        assertCurrent();
        await stopLegacyHub();
        assertCurrent();
        const parent = path.join(context.globalStorageUri.fsPath, "next-collaboration", hash);
        fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
        const root = path.join(parent, "workspace");
        candidate = await start(root, true);
        const state = candidate.status();
        if (state.root !== root || !/^[a-f0-9-]{36}$/.test(state.workspaceId ?? "")) throw new Error("Collaboration workspace binding is invalid.");
        assertCurrent();
        const record: Selection = { schema: "pkm.next-collaboration/v1", sourceRoot, sourceIdentity,
          root, rootIdentity: identity(root), workspaceId: state.workspaceId! };
        await candidate.close(); candidate = undefined;
        selectionSaveAttempted = true;
        selectionPresent = true;
        const serialized = JSON.stringify(record), deadline = Date.now() + 5000;
        await context.secrets.store(key, serialized);
        while (await context.secrets.get(key) !== serialized) {
          if (Date.now() >= deadline) throw new Error("Profile selection save outcome is unknown; preserve both workspaces.");
          await new Promise(resolve => setTimeout(resolve, 25));
        }
        selected = record;
        markSelectedRoomHostUnavailable(configuredRoot);
        const reload = await vscode.window.showInformationMessage("Original Room/Meeting/Note recovery is ready.",
          { modal: true, detail: "Reload to select Next Collaboration. The original archive has not been rewritten; other PKM workflows remain on their existing route." },
          "Reload Window", "Later");
        if (reload === "Reload Window") await vscode.commands.executeCommand("workbench.action.reloadWindow");
        return { prepared: true, workspaceId: record.workspaceId, sameRootAdoption: false };
      } catch (failure) {
        error = failure instanceof Error ? failure.message : "Collaboration recovery failed.";
        if (selectionSaveAttempted) markSelectedRoomHostUnavailable(configuredRoot);
        await vscode.window.showErrorMessage(`${error} ${selectionSaveAttempted
          ? "Profile selection may have been saved; reload for recovery, without reopening the old writer."
          : "Original routing is unchanged."} Preserve any partial private workspace for recovery.`);
        return { prepared: false, error };
      } finally { bootstrapping = false; await candidate?.close(); }
    }),
    { dispose() { disposed = true; void client?.close(); } },
  );
  const saved = await context.secrets.get(key);
  if (!saved) return;
  selectionPresent = true;
  try {
    selected = JSON.parse(saved);
    if (selected?.schema !== "pkm.next-collaboration/v1" || selected.sourceRoot !== sourceRoot
      || selected.sourceIdentity !== sourceIdentity || !path.isAbsolute(selected.root)
      || !/^[a-f0-9-]{36}$/.test(selected.workspaceId) || identity(selected.root) !== selected.rootIdentity)
      throw new Error("Saved Collaboration selection is invalid; preserve its workspace and profile record.");
    assertCurrent();
    client = await start(selected.root, false, selected.workspaceId);
    const registration = registerAdoptedRoomHostOwner({
      root: configuredRoot, workspaceId: selected.workspaceId, qualification: "new-next-workspace",
      assertAuthority: assertCurrent,
      createHub: (ui, guard) => client!.hub(ui, guard),
    });
    context.subscriptions.push({ dispose() { void registration.dispose().catch(() => {}).finally(() => client?.close()); } });
  } catch (failure) {
    await client?.close(); client = undefined;
    error = failure instanceof Error ? failure.message : "Selected Collaboration recovery failed.";
    markSelectedRoomHostUnavailable(configuredRoot);
    void vscode.window.showErrorMessage(`${error} The selected Next route is blocked; no legacy Room writer was started.`);
  }
}
