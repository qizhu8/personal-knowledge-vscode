import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { createHash, randomUUID } from "crypto";
import { isDeepStrictEqual } from "util";
import { NextManagedClient, NextWriteCredential } from "../runtime/next-managed-client";
import { registerNextPythonEnvironment } from "./next-python-environment";
import { MemoryMigrationAuthority, NEXT_TRIAL_MEMORY_ACTOR_ID, parseMemoryHostPin,
  type MemoryScopeApprovalRequest } from "../runtime/memory-migration-authority";
import { ChatClient } from "../chatroom/chatroom-client";
import { ChatRoomCredentialStore } from "../chatroom/chat-room-credentials";
import { createChatMagicLink } from "../chatroom/chat-magic-link";
import type { NextRoomParticipantApproval } from "../chatroom/next-room-host-bridge";
import { loadRoomRecoveryPins, verifyRoomRecoveryCredential } from "../chatroom/next-room-recovery";
import { openManagedRecipeWorkbench } from "./next-recipe-workbench";
import type { NextRecipeWorkspacePin } from "../runtime/next-recipe-workspace";
import { createNextChatProfileAuthority } from "../runtime/next-chat-profile-authority";
import { resetSelectedChatPermissions } from "../runtime/next-chat-permission-reset";
import { selectedChatModel } from "../runtime/next-chat-model-selection";
import { registerSelectedOwnerChatUi } from "../chat/selected-owner-chat-ui";
import type { NextSelectedChatOwner } from "../runtime/next-managed-client";
import { loadSelectedChatRecoveryPins, saveSelectedChatRecoveryPin } from "../runtime/next-selected-chat-recovery";

let client: NextManagedClient | undefined;
let importedReadOnly = false;
let experimentEnabled = false;
const isolatedRoomClients = new Set<ChatClient>();
let roomMenuActive = false;
let selectedChat: { owner: NextSelectedChatOwner; profile: ReturnType<typeof createNextChatProfileAuthority>;
  ui?: vscode.Disposable; ownerDrained?: boolean } | undefined;
let selectedChatOpening = false;
type ChatroomHostIntent = { kind: "chatroom-host"; room: string; user: string; key: string; port: number };
type TrialDraft = {
  owner: NextManagedClient; area: string; id: string; path: string; title: string;
  base?: { revision: number; sha256: string };
  body?: vscode.TextDocument; fields?: vscode.TextDocument; scanRevision: string; category?: string;
  knowledgeId?: string | null;
  operationId?: string; blocked?: boolean;
};
const drafts = new Map<vscode.TextDocument, TrialDraft>();
const writeCredentialKey = "pkm.nextTrial.isolatedExperiment.v1";
const recipeWorkspaceKey = "pkm.nextRecipe.independentWorkspace.v1";
const memoryHostPinKey = (workspaceId: string) => `pkm.nextTrial.memoryHostPin.v1:${workspaceId}`;
const experimentWarning = "Only synthetic data or a dedicated isolated copy. External writers: UNKNOWN. In-process calls are tracked; cooperating hosts use a native lease and writes use CAS. This is not a fence, human identity proof, or production cutover.";

export async function closeNextManagedTrial(): Promise<void> {
  const current = client;
  if (!current) return;
  if (selectedChatOpening) throw new Error("Finish or cancel the pending Next Chat selection before closing.");
  await closeNextSelectedChat();
  for (const room of isolatedRoomClients) room.disconnect();
  isolatedRoomClients.clear();
  try { await current.close(); }
  finally { if (client === current && current.isStopped()) { client = undefined; importedReadOnly = false; experimentEnabled = false; } }
}

async function closeNextSelectedChat(): Promise<void> {
  if (selectedChatOpening) throw new Error("Finish or cancel the pending Next Chat selection before closing.");
  const current = selectedChat;
  if (!current) { await client?.revokeSelectedChatOwner(); return; }
  current.profile.dispose();
  current.ui?.dispose();
  await current.owner.revoke();
  if (selectedChat === current) selectedChat = undefined;
}

async function resetNextSelectedChatPermissions(): Promise<void> {
  const current = selectedChat;
  if (!current || selectedChatOpening) throw new Error("The selected Chat is unavailable.");
  const reset = await resetSelectedChatPermissions({
    state: current,
    assertSelection() { if (selectedChat !== current) throw new Error("The selected Chat changed."); },
    async confirm() {
      const answer = await vscode.window.showWarningMessage("Reset remembered process approvals for this Chat?",
      { modal: true, detail: "The current Next Chat will close and its active managed work will be stopped and drained first. "
        + "Reopen the Chat to continue. Only new Next approvals in this VS Code profile are reset; original history and permissions are unchanged." },
      "Reset and close Chat");
      return answer === "Reset and close Chat";
    },
  });
  if (!reset) return;
  current.ui?.dispose();
  current.profile.dispose();
  if (selectedChat === current) selectedChat = undefined;
  void vscode.window.showInformationMessage("Next Chat remembered process approvals were reset. Reopen the Chat to continue.");
}

export function registerNextManagedTrial(context: vscode.ExtensionContext, legacyRoot: () => string): void {
  registerNextPythonEnvironment(context, () => client);
  context.subscriptions.push(
    { dispose: () => { void closeNextSelectedChat().catch(() => {}); } },
    vscode.commands.registerCommand("personalKnowledge.closeNextSelectedChat", async () => {
      try { await closeNextSelectedChat(); }
      catch { void vscode.window.showErrorMessage("Next Chat drain is unconfirmed. Keep the workspace open and retry Close Next Chat."); }
    }),
    vscode.commands.registerCommand("personalKnowledge.openNextSelectedChat", async () => {
      if (selectedChatOpening || selectedChat) {
        void vscode.window.showErrorMessage("Close the current Next Chat before selecting another.");
        return;
      }
      selectedChatOpening = true;
      let profile: ReturnType<typeof createNextChatProfileAuthority> | undefined;
      let owner: NextSelectedChatOwner | undefined;
      let ui: vscode.Disposable | undefined;
      try {
        const current = client;
        if (!current) throw new Error("Start an independent Next workspace first.");
        const workspaceId = current.pythonWorkspaceId(), workspace = current.pythonWorkspaceDirectory();
        const root = fs.realpathSync(legacyRoot());
        profile = createNextChatProfileAuthority({ root, workspaceId, currentRoot: () => fs.realpathSync(legacyRoot()),
          clientCurrent: () => client === current && current.ownsWorkspace(workspaceId), secrets: context.secrets });
        owner = await current.selectChatOwner(profile, () => {
          void vscode.window.showErrorMessage("Next Chat revocation is unconfirmed. Keep the workspace open and retry Close Next Chat.");
        });
        const choices = await current.listSelectedChats(owner);
        const choice = await vscode.window.showQuickPick(choices.map(chat => ({ label: chat.title || "Untitled Chat", chat })),
          { title: "Choose an original Chat for the independent Next workspace", ignoreFocusOut: true });
        if (!choice) return;
        owner.assertCurrent();
        const approved = await vscode.window.showWarningMessage("Open this Chat in the independent Next workspace?",
          { modal: true, detail: `Original root: ${root}\nNext workspace: ${workspace}\nThe archive is copied to the private Next workspace. Changes to the original cause a conflict; this is not an atomic snapshot, writer fence or root migration. Next creates its own Chat and process records. A recovery binding is stored in this VS Code profile; reopening requires fresh model and program selection. Remembered Next process approvals apply only to the same Chat and exact selected program identity; they can be reset from Chat permissions. Original Chat history and permissions are not modified or inherited. Model requests use the provider selected for this independent session.` },
          "Open Independent Chat");
        if (approved !== "Open Independent Chat") return;
        owner.assertCurrent();
        const commandChoice = await vscode.window.showQuickPick([
          { label: "No programs", value: false },
          { label: "Allow one exact program and argument list", value: true },
        ], { title: "Choose the independent Chat process scope", ignoreFocusOut: true });
        if (!commandChoice) return;
        const commands: Array<{ id: string; program: string; cwd: string; arguments: string[][] }> = [];
        if (commandChoice.value) {
          const executable = (await vscode.window.showOpenDialog({ canSelectFiles: true, canSelectFolders: false,
            canSelectMany: false, openLabel: "Select one exact program" }))?.[0]?.fsPath;
          if (!executable) return;
          const cwd = (await vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true,
            canSelectMany: false, openLabel: "Select its exact working directory" }))?.[0]?.fsPath;
          if (!cwd) return;
          const raw = await vscode.window.showInputBox({ title: "Exact program arguments as a JSON string array",
            value: "[]", ignoreFocusOut: true });
          if (raw === undefined) return;
          const args: unknown = JSON.parse(raw);
          if (!Array.isArray(args) || args.length > 32 || args.some(item => typeof item !== "string" || item.includes("\0")))
            throw new Error("Provide an array of at most 32 string arguments.");
          commands.push({ id: "selected-program", program: fs.realpathSync(executable), cwd: fs.realpathSync(cwd), arguments: [args] });
        }
        owner.assertCurrent();
        const model = await selectedChatModel(context, choice.chat, profile.signal, () => current.privateCopilotSdk(owner!));
        owner.assertCurrent();
        if (model.vscodeModel?.vendor === "copilot-sdk" && vscode.authentication?.onDidChangeSessions)
          profile.watchGithubSessions(vscode.authentication.onDidChangeSessions);
        if (model.configuration.provider === "vscode" && model.vscodeModel?.vendor !== "copilot-sdk" && vscode.lm?.onDidChangeChatModels)
          profile.watchModelChanges(vscode.lm.onDidChangeChatModels);
        if (commands.length && model.configuration.provider === "vscode" && !model.configuration.vscodeTools)
          throw new Error("The selected VS Code model cannot call the configured process tools.");
        const permissionKey = await profile.preparePermissions(choice.chat.namespace, choice.chat.chatId);
        owner.assertCurrent();
        const binding = await current.startSelectedChat(owner, {
          chats: [{ namespace: choice.chat.namespace, chatId: choice.chat.chatId }], commands, model: model.configuration,
        }, model.vscodeModel, permissionKey);
        owner.assertCurrent();
        await saveSelectedChatRecoveryPin(context.secrets, { workspace, legacyRoot: root, workspaceId,
          namespace: choice.chat.namespace, chatId: choice.chat.chatId, snapshotRoot: binding.root,
          sourceFingerprint: binding.sourceFingerprint });
        owner.assertCurrent();
        ui = await registerSelectedOwnerChatUi(context, { binding, connection: profile.signal, assertCurrent: owner.assertCurrent,
          ...(permissionKey ? { resetPermissions: async () => {
            try { await resetNextSelectedChatPermissions(); }
            catch (error) {
              void vscode.window.showErrorMessage("Next Chat permission reset is unconfirmed. Keep the workspace open and retry closing or reopening the Chat.");
              throw error;
            }
          } } : {}) });
        selectedChat = { owner, profile, ui };
        owner = undefined; profile = undefined; ui = undefined;
        await vscode.commands.executeCommand("personalKnowledge.focusNextSelectedChat");
      } catch (error) {
        void vscode.window.showErrorMessage(`Next Chat: ${error instanceof Error ? error.message : "Unable to open."}`);
      } finally {
        ui?.dispose(); profile?.dispose();
        if (owner) try { await owner.revoke(); }
        catch {
          if (profile) selectedChat = { owner, profile };
          void vscode.window.showErrorMessage("Next Chat drain is unconfirmed. Keep the workspace open and retry closing it.");
        }
        selectedChatOpening = false;
      }
    }),
    vscode.commands.registerCommand("personalKnowledge.nextTrialMemoryReadopt", async () => {
      try {
        if (!vscode.workspace.isTrusted) throw new Error("Trusted workspace approval is required for Memory re-adoption.");
        if (!client) {
          const selected = await vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true,
            canSelectMany: false, openLabel: "Select an isolated imported/restored Memory workspace (not the live root)" });
          if (!selected?.[0]) return;
          const node = await vscode.window.showOpenDialog({ canSelectFiles: true, canSelectFolders: false,
            canSelectMany: false, openLabel: "Select local Node 22.18 or newer" });
          if (!node?.[0]) return;
          const candidate = new NextManagedClient();
          client = candidate;
          await candidate.openMemoryWorkspace(context.extensionPath, selected[0].fsPath, node[0].fsPath, legacyRoot());
          importedReadOnly = true; experimentEnabled = false;
        }
        const current = client;
        const evidence = await current.prepareMemoryReadoption();
        const saved = await context.secrets.get(memoryHostPinKey(evidence.pin.workspaceId));
        const pin = saved && parseMemoryHostPin(JSON.parse(saved));
        if (!pin || !isDeepStrictEqual(pin, evidence.pin))
          throw new Error("Independent host pin from a previously approved fresh import is missing or differs. Backup contents cannot supply this authority.");
        const authority = new MemoryMigrationAuthority(() => vscode.workspace.isTrusted && client === current);
        await current.readoptMemory(pin, envelope => authority.authorize(envelope, {
          ...pin, target: evidence.target,
        }, async request => (await vscode.window.showWarningMessage(
          "Re-adopt this exact imported Memory scope for a NEW host session?",
          { modal: true, detail: `Independent host pin matched. This is explicit adoption, NOT original-owner proof; no old grant is inherited or extended.\nTarget: ${evidence.target}\nWorkspace: ${request.workspaceId}\nActor: ${request.actorId}\nScope: ${request.scope}\nSource SHA: ${request.sourceDatabaseSha256}\nPlan SHA: ${request.importPlanSha256}\nReceipt SHA: ${request.importReceiptSha256}\nSealed receipt state SHA: ${pin.receiptStateSha256}` },
          "Approve New Memory Session")) === "Approve New Memory Session"));
        await vscode.window.showInformationMessage("Exact imported Memory scope approved for this session only. Restart and restore still default deny.");
        const query = await vscode.window.showInputBox({ prompt: "Search the explicitly re-adopted Memory scope (optional)" });
        if (query) {
          const result = await current.invoke("memory-search", { query });
          const document = await vscode.workspace.openTextDocument({ content: JSON.stringify(result, null, 2), language: "json" });
          await vscode.window.showTextDocument(document, { preview: true });
        }
      } catch (error) {
        void vscode.window.showErrorMessage(`PKM Next Memory: ${error instanceof Error ? error.message : "Re-adoption unavailable."} No implicit grant or automatic retry.`);
      }
    }),
    vscode.commands.registerCommand("personalKnowledge.nextTrialCodeArchive", async () => {
      if (!client) { void vscode.window.showErrorMessage("Start an isolated PKM Next trial first."); return; }
      const selected = await vscode.window.showQuickPick([
        { label: "Packages", area: "packages" as const }, { label: "Actions", area: "actions" as const },
        { label: "Components", area: "components" as const }, { label: "Action module sets", area: "action-module-sets" as const },
        { label: "Action state history (archive_only; not current runtime state)", area: "action-state" as const },
      ], { placeHolder: "Preserved code archive only — NOT installed, execution NOT authorized, runtime NOT verified" });
      if (!selected || !client) return;
      try { await trialLibrary(client, selected.area); }
      catch (error) {
        void vscode.window.showErrorMessage(`PKM Next inert archive: ${error instanceof Error ? error.message : "Read failed."} Nothing was installed, registered, authorized or executed; no automatic retry.`);
      }
    }),
    vscode.commands.registerCommand("personalKnowledge.nextTrialEditDocument", async () => {
      const current = client;
      if (!current) { void vscode.window.showErrorMessage("Start an isolated PKM Next trial first."); return; }
      try { await openTrialDraft(current, !experimentEnabled); }
      catch (error) { void vscode.window.showErrorMessage(`PKM Next editor: ${error instanceof Error ? error.message : "Open failed."}`); }
    }),
    vscode.commands.registerCommand("personalKnowledge.nextTrialDocumentFields", async () => {
      try {
        const document = vscode.window.activeTextEditor?.document, draft = document && drafts.get(document);
        if (!draft || draft.owner !== client || !experimentEnabled || draft.blocked)
          throw new Error("Focus an authorized isolated draft. Reopen blocked drafts rather than retrying.");
        if (!draft.fields || draft.fields.isClosed) {
          draft.fields = await vscode.workspace.openTextDocument({ language: "json", content: "{}\n" });
          drafts.set(draft.fields, draft);
        }
        await vscode.window.showTextDocument(draft.fields, { preview: false });
        await vscode.window.showInformationMessage(`Optional metadata changes only; omitted fields stay unchanged. Allowed: ${trialFields(draft.area).join(", ")}. No identity, rename, move or execution fields. Focus either draft buffer and Publish when ready.`);
      } catch (error) { void vscode.window.showErrorMessage(`PKM Next fields: ${error instanceof Error ? error.message : "Open failed."}`); }
    }),
    vscode.commands.registerCommand("personalKnowledge.nextTrialPublishDocument", async () => {
      try {
        const document = vscode.window.activeTextEditor?.document, draft = document && drafts.get(document);
        if (!document || !draft) throw new Error("Focus an isolated trial draft opened with PKM: Edit Isolated Notes, Skills or Research.");
        if (draft.owner !== client || !experimentEnabled) throw new Error("This draft is not authorized by the current isolated experiment. Copy your text to a new authorized draft; no write performed.");
        if (draft.blocked) throw new Error(`Draft publication is blocked. Preserve operation ID ${draft.operationId}; reconcile the prior result before any new attempt.`);
        const fieldsText = draft.fields?.getText() ?? "{}";
        const fields: unknown = JSON.parse(fieldsText);
        if (!fields || typeof fields !== "object" || Array.isArray(fields) ||
          Object.keys(fields).some(key => !trialFields(draft.area).includes(key)))
          throw new Error("Metadata must be a JSON object containing only the displayed fields; identity/move/rename are not editable here.");
        const content = (draft.body ?? document).getText(), operationId = randomUUID();
        const decision = await vscode.window.showWarningMessage("Publish this draft to the isolated trial?",
          { modal: true, detail: `${experimentWarning}\nArea: ${draft.area}\nPath: ${draft.path}\nID: ${draft.id}\nBase revision: ${draft.base?.revision ?? "new document"}\nNative Knowledge semantics and CAS apply. Existing identity is preserved; missing canonical identity may be added by native preserveIdentity. Omitted metadata stays unchanged; no rename/move. Fields: ${Object.keys(fields).join(", ") || "body only"}.\nOrdinary editor Save does not publish to Next.` }, "Publish Isolated Draft");
        if (decision !== "Publish Isolated Draft") return;
        if (draft.owner !== client || !experimentEnabled || (draft.body ?? document).getText() !== content ||
          (draft.fields?.getText() ?? "{}") !== fieldsText)
          throw new Error("Draft or trial changed during approval; no write performed.");
        draft.operationId = operationId; draft.blocked = true;
        const operation = `${draft.area === "notes" ? "note" : draft.area === "skills" ? "skill" : "research"}-${draft.base ? "update" : "create"}` as Parameters<NextManagedClient["invoke"]>[0];
        const response = await invokeWrite(draft.owner, operation, {
          ...fields, operationId, content, expectedScanRevision: draft.scanRevision,
          ...(draft.base ? { id: draft.id, expectedRevision: draft.base.revision, expectedSha256: draft.base.sha256, preserveIdentity: true } :
            { [draft.area === "skills" ? "name" : "title"]: draft.title, category: draft.category }),
        }, operationId);
        if (response?.error) {
          if (response.error.effect !== "not-committed") throw new Error(`Write outcome is unconfirmed. Preserve operation ID ${operationId}; reconcile before retry.`);
          throw new Error(`${response.error.code}: ${response.error.message ?? "Publication rejected"}. Draft retained without retry or overwrite. Reopen current server content and merge manually before publishing a new draft.`);
        }
        const saved = response?.result;
        if (saved?.operationId !== operationId || saved.action !== (draft.base ? "update" : "create") || saved.area !== draft.area ||
          (draft.base && (saved.id !== draft.id || saved.path !== draft.path)) ||
          (draft.knowledgeId && saved.knowledgeId !== draft.knowledgeId) ||
          !/^knowledge_[a-f0-9]{24}$/.test(saved.knowledgeId) || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(saved.id) ||
          typeof saved.path !== "string" || saved.path.split("/").some((part: string) => !part || part === "." || part === "..") ||
          /[\\\0\r\n]/.test(saved.path) || !draft.base && saved.name !== draft.title ||
          !Number.isSafeInteger(saved.revision) || saved.revision !== (draft.base?.revision ?? 0) + 1 ||
          !/^[a-f0-9]{64}$/.test(saved.sha256))
          throw new Error(`Publication response is not bound to this draft. Preserve operation ID ${operationId}; reconcile before retry.`);
        drafts.delete(draft.body ?? document);
        if (draft.fields) drafts.delete(draft.fields);
        await vscode.window.showInformationMessage(`Isolated ${draft.area} document published at revision ${saved.revision}. Operation ${operationId}.`);
        await vscode.window.showInformationMessage("Draft retained locally. Reopen the current server document before the next edit; this published draft cannot be replayed.");
      } catch (error) {
        void vscode.window.showErrorMessage(`PKM Next publish: ${error instanceof Error ? error.message : "Publication failed."}`);
      }
    }),
    ...(vscode.workspace?.onDidCloseTextDocument ? [vscode.workspace.onDidCloseTextDocument(document => {
      const draft = drafts.get(document);
      if (draft?.body === document) {
        drafts.delete(document);
        if (draft.fields) drafts.delete(draft.fields);
      } else if (draft) {
        draft.blocked = true;
        drafts.delete(document);
      }
    })] : []),
    ...(["Prompts", "Scripts"] as const).map(kind => vscode.commands.registerCommand(
      `personalKnowledge.nextTrial${kind}`, async () => {
        if (!client) { void vscode.window.showErrorMessage("Start an isolated PKM Next trial first."); return; }
        try { await trialLibrary(client, kind === "Prompts" ? "prompts" : "scripts"); }
        catch (error) {
          void vscode.window.showErrorMessage(`PKM Next ${kind}: ${error instanceof Error ? error.message : "Read failed."} No execution, sidecar initialization, history restoration or automatic retry was performed.`);
        }
      })),
    vscode.commands.registerCommand("personalKnowledge.nextTrialRecipes", async () => {
      try {
        if (client && importedReadOnly) { await trialRecipes(client); return; }
        if (!vscode.workspace.isTrusted) throw new Error("Trusted workspace required for Recipe review.");
        if (!client) {
          const saved = await context.secrets.get(recipeWorkspaceKey);
          if (!saved) throw new Error("Start an independent isolated Next workspace first. Original Root takeover is not authorized.");
          const pin = JSON.parse(saved) as NextRecipeWorkspacePin;
          if (await vscode.window.showWarningMessage("Reopen the independently pinned Recipe workspace?",
            { modal: true, detail: `${pin.parent}\nWorkspace: ${pin.workspaceId}\nNo old approvals or execution authority are restored. This is not original Root adoption.` },
            "Reopen Recipe Workspace") !== "Reopen Recipe Workspace") return;
          const node = await vscode.window.showOpenDialog({ canSelectFiles: true, canSelectFolders: false,
            canSelectMany: false, openLabel: "Select local Node 22.18 or newer" });
          if (!node?.[0]) return;
          const candidate = new NextManagedClient();
          client = candidate;
          await candidate.resumeRecipes(context.extensionPath, pin, node[0].fsPath, legacyRoot());
          importedReadOnly = false; experimentEnabled = false;
        }
        const current = client;
        let pin: NextRecipeWorkspacePin;
        try { pin = current.recipeWorkspacePin(); }
        catch { await trialRecipes(current); return; }
        await context.secrets.store(recipeWorkspaceKey, JSON.stringify(pin));
        const available = await current.recipeCommand({ operation: "state" });
        const choices = [{ label: "New controlled Recipe", recipeId: undefined as string | undefined },
          ...available.catalog.recipes.map((recipe: any) => ({ label: recipe.name,
            description: `${recipe.recipeId} · revision ${recipe.revision}`, recipeId: recipe.recipeId as string }))];
        const selected = await vscode.window.showQuickPick(choices, {
          placeHolder: "Native Recipe Workbench — exact approvals; caller-reported work only; unsupported adapters remain blocked" });
        if (!selected) return;
        await openManagedRecipeWorkbench(context, current, () => client === current && vscode.workspace.isTrusted, selected.recipeId);
      }
      catch (error) {
        void vscode.window.showErrorMessage(`PKM Next Recipes: ${error instanceof Error ? error.message : "Operation unavailable."} Preserve uncertain operation IDs; no automatic retry or original Root takeover.`);
      }
    }),
    ...(["Research", "Skills"] as const).map(kind => vscode.commands.registerCommand(
      kind === "Research" ? "personalKnowledge.nextTrialResearch" : "personalKnowledge.nextTrialSkills", async () => {
        if (!client) { void vscode.window.showErrorMessage("Start an isolated PKM Next trial first."); return; }
        try { await structuredTrialView(client, kind); }
        catch (error) {
          void vscode.window.showErrorMessage(`PKM Next ${kind}: ${error instanceof Error ? error.message : "Read failed."} No structured data was changed or automatically retried.`);
        }
      })),
    vscode.commands.registerCommand("personalKnowledge.nextTrialBoards", async () => {
      if (!client) { void vscode.window.showErrorMessage("Start an isolated PKM Next trial first."); return; }
      try { await trialBoards(client); }
      catch (error) {
        void vscode.window.showErrorMessage(`PKM Next Boards: ${error instanceof Error ? error.message : "Read failed."} Board access remains read-only; no retry or repair was performed.`);
      }
    }),
    vscode.commands.registerCommand("personalKnowledge.nextTrialResources", async () => {
      if (!client) { void vscode.window.showErrorMessage("Start an isolated PKM Next trial first."); return; }
      try { await trialResources(client); }
      catch (error) {
        void vscode.window.showErrorMessage(`PKM Next resources: ${error instanceof Error ? error.message : "Read failed."} No resource was executed or saved.`);
      }
    }),
    vscode.commands.registerCommand("personalKnowledge.nextTrialEnableWrite", async () => {
      const current = client;
      try {
        if (!current || !importedReadOnly) throw new Error("Attach an imported copy read-only first.");
        const plan = await current.prepareImportWrite();
        const detail = `${experimentWarning}\nTarget: ${plan.target}\nWorkspace: ${plan.workspaceId}\nPlan: ${plan.planSha256}\nAuthorization: ${plan.authorizationDigest}\nBlockers: ${plan.blockers.join("\n") || "None"}\nThe saved resume credential for this extension profile will be replaced.`;
        if (plan.blockers.length) { await vscode.window.showWarningMessage("Experimental writing is blocked.", { modal: true, detail }); return; }
        const approved = await vscode.window.showWarningMessage("Enable isolated_experiment writing for this copy?",
          { modal: true, detail }, "Enable Isolated Experiment");
        if (approved !== "Enable Isolated Experiment") return;
        const target = await vscode.window.showInputBox({ prompt: "Type the exact target path to authorize this isolated experiment" });
        if (target !== plan.target) throw new Error("Target confirmation did not match; writing remains disabled.");
        const credential = await current.enableImportWrite(plan.authorizationDigest, target);
        try { await context.secrets.store(writeCredentialKey, JSON.stringify(credential)); }
        catch {
          await closeNextManagedTrial();
          throw new Error("Credential storage failed; experiment closed. Resume is unavailable; do not retry enable automatically.");
        }
        importedReadOnly = false;
        experimentEnabled = true;
        await vscode.window.showInformationMessage(`Isolated experiment writing enabled. ${experimentWarning}`);
      } catch (error) {
        void vscode.window.showErrorMessage(`PKM Next experiment: ${error instanceof Error ? error.message : "Outcome unknown. Do not retry automatically."}`);
      }
    }),
    vscode.commands.registerCommand("personalKnowledge.nextTrialResumeWrite", async () => {
      let candidate: NextManagedClient | undefined;
      try {
        if (client) throw new Error("Close the current trial before resuming.");
        const raw = await context.secrets.get(writeCredentialKey);
        if (!raw) throw new Error("No saved isolated experiment credential.");
        let credential: NextWriteCredential;
        try { credential = JSON.parse(raw) as NextWriteCredential; }
        catch { throw new Error("Saved experimental credential cannot be decoded."); }
        if (typeof credential.parent !== "string" || typeof credential.workspaceId !== "string" ||
          typeof credential.capability !== "string" || !/^[a-f0-9]{64}$/.test(credential.capability))
          throw new Error("Saved experimental credential is invalid.");
        const approved = await vscode.window.showWarningMessage("Resume the saved isolated_experiment?",
          { modal: true, detail: `${experimentWarning}\nParent: ${credential.parent}\nWorkspace: ${credential.workspaceId}\nOnly a cleanly closed, unchanged experiment can resume.` }, "Resume Isolated Experiment");
        if (approved !== "Resume Isolated Experiment") return;
        const node = (await vscode.window.showOpenDialog({ canSelectFiles: true, canSelectFolders: false,
          canSelectMany: false, openLabel: "Select local Node 22.18 or newer" }))?.[0]?.fsPath;
        if (!node) return;
        if (client) throw new Error("Close the current trial before resuming.");
        candidate = new NextManagedClient(); client = candidate;
        await candidate.resumeImport(context.extensionPath, credential, node, legacyRoot());
        importedReadOnly = false;
        experimentEnabled = true;
        await vscode.window.showInformationMessage(`Saved isolated experiment resumed. ${experimentWarning}`);
      } catch (error) {
        if (candidate) {
          try { await closeNextManagedTrial(); } catch { /* Retain pending child until actual exit. */ }
        }
        void vscode.window.showErrorMessage(`PKM Next experiment: ${error instanceof Error ? error.message : "Resume outcome unknown."} No automatic repair or replay.`);
      }
    }),
    vscode.commands.registerCommand("personalKnowledge.nextTrialImport", async () => {
      let candidate: NextManagedClient | undefined;
      try {
        if (client) throw new Error("Close the current trial before starting another.");
        const choose = async (label: string, folder: boolean) => (await vscode.window.showOpenDialog({
          canSelectFiles: !folder, canSelectFolders: folder, canSelectMany: false, openLabel: label,
        }))?.[0]?.fsPath;
        const source = await choose("Select a private static legacy COPY (not the live root)", true);
        if (!source) return;
        const parent = await choose("Select an empty private import parent", true);
        if (!parent) return;
        const node = await choose("Select local Node 22.18 or newer", false);
        if (!node) return;
        const python = await choose("Select local Python for legacy import", false);
        if (!python) return;
        const memoryChoice = await vscode.window.showQuickPick(["No Memory Engine", "Select closed original Memory Engine COPY"],
          { placeHolder: "Optional original Memory SQLite; never select the live database" });
        if (!memoryChoice) return;
        const memoryEngine = memoryChoice === "No Memory Engine" ? undefined
          : await choose("Select dedicated quiescent original Memory SQLite COPY", false);
        if (memoryChoice !== "No Memory Engine" && !memoryEngine) return;
        const asserted = await vscode.window.showWarningMessage(
          "Assert this is a static legacy COPY and no writer will modify it during import.",
          { modal: true, detail: `Source: ${source}\nParent: ${parent}\nThis is your assertion, not a writer fence or authentication. No production cutover will occur. The target workspace must not exist.` },
          "I Assert Static Copy");
        if (asserted !== "I Assert Static Copy") return;
        if (client) throw new Error("Close the current trial before starting another.");
        candidate = new NextManagedClient();
        client = candidate;
        let plan = await candidate.planImport(context.extensionPath, parent, node, legacyRoot(), source, python, memoryEngine);
        let freshMemoryIdentity: MemoryScopeApprovalRequest | undefined;
        if (plan.ready && plan.memoryPlan) {
          const scope = await vscode.window.showQuickPick(plan.memoryPlan.scopes,
            { placeHolder: "Explicitly adopt ONE original scope (not proof of original owner identity)" });
          if (!scope) { await closeNextManagedTrial(); return; }
          plan = await candidate.selectMemoryScope(createHash("sha256").update(scope).digest("hex"));
          const authority = new MemoryMigrationAuthority(() => vscode.workspace.isTrusted && client === candidate);
          const pinned = plan;
          candidate.setMemoryScopeApprovalHandler(envelope => authority.authorize(envelope, {
            target: pinned.target, actorId: NEXT_TRIAL_MEMORY_ACTOR_ID, scope,
            sourceDatabaseSha256: pinned.memoryPlan!.sourceSha256, importPlanSha256: pinned.planSha256,
          }, async request => {
            const accepted = (await vscode.window.showWarningMessage(
            "Adopt this exact original Memory scope for this isolated host session?",
            { modal: true, detail: `This is explicit one-scope adoption, NOT original-owner proof. Historical grants are not imported.\nTarget: ${pinned.target}\nWorkspace: ${request.workspaceId}\nActor: ${request.actorId}\nScope: ${request.scope}\nSource SHA: ${request.sourceDatabaseSha256}\nPlan SHA: ${request.importPlanSha256}\nReceipt SHA: ${request.importReceiptSha256}\nApproval expires and is not activated after restart or restore.` },
              "Adopt Exact Memory Scope")) === "Adopt Exact Memory Scope";
            if (accepted) freshMemoryIdentity = request;
            return accepted;
          }));
        }
        const detail = `Target: ${plan.target}\nPlan digest: ${plan.planSha256}\nBlockers:\n${plan.blockers.length
          ? plan.blockers.map(item => `${item.code}: ${item.path}: ${item.message}${item.relatedPath ? ` (${item.relatedPath})` : ""}`).join("\n")
          : "None"}\nPublished status and markers are not a complete file integrity proof.`;
        if (!plan.ready || plan.blockers.length) {
          await vscode.window.showWarningMessage("Legacy copy import is blocked.", { modal: true, detail });
          await closeNextManagedTrial(); return;
        }
        const approval = await vscode.window.showWarningMessage("Import this static copy using the exact displayed plan digest?",
          { modal: true, detail }, "Import Exact Plan");
        if (approval !== "Import Exact Plan") { await closeNextManagedTrial(); return; }
        const imported = await candidate.confirmImport(plan.planSha256);
        const status = await candidate.importStatus();
        if (imported?.outcome?.status !== "published" || status?.outcome?.status !== "published")
          throw new Error("Import publication could not be verified; outcome unknown.");
        await candidate.attachImport();
        importedReadOnly = true;
        if (plan.memoryPlan?.continuityScopeSha256) {
          const evidence = await candidate.prepareMemoryReadoption();
          const identity = freshMemoryIdentity;
          if (!identity || evidence.pin.workspaceId !== identity.workspaceId || evidence.pin.actorId !== identity.actorId
            || evidence.pin.scope !== identity.scope || evidence.pin.sourceScopeSha256 !== identity.sourceScopeSha256
            || evidence.pin.sourceDatabaseSha256 !== identity.sourceDatabaseSha256
            || evidence.pin.importPlanSha256 !== identity.importPlanSha256
            || evidence.pin.importReceiptSha256 !== identity.importReceiptSha256)
            throw new Error("Published Memory evidence differs from the exact approved host import.");
          await context.secrets.store(memoryHostPinKey(evidence.pin.workspaceId), JSON.stringify(evidence.pin));
          const query = await vscode.window.showInputBox({ prompt: "Search the explicitly adopted original Memory scope (optional)" });
          if (query) {
            const result = await candidate.invoke("memory-search", { query });
            await vscode.workspace.openTextDocument({ content: JSON.stringify(result, null, 2), language: "json" })
              .then(document => vscode.window.showTextDocument(document, { preview: true }));
          }
        }
        await vscode.window.showInformationMessage("Static copy imported and attached read-only. Browse via PKM: Browse Isolated Prompts / Scripts / Recipes / Research / Skills Read-Only, PKM: View Isolated Trial Boards Read-Only, or PKM: Preview Isolated Trial Resources Safely. This is not a production cutover or integrity certification.");
        await trialMenu(candidate, true);
      } catch (error) {
        const detail = error instanceof Error ? error.message : "Import outcome unknown.";
        if (candidate) {
          try { await closeNextManagedTrial(); }
          catch { /* Keep the same child tracked until it actually exits. */ }
        }
        void vscode.window.showErrorMessage(`PKM Next import: ${detail} Preserve the selected directories; do not retry automatically. If shutdown is pending, use Close Trial to wait.`);
      }
    }),
    vscode.commands.registerCommand("personalKnowledge.nextTrialStart", async (intent?: ChatroomHostIntent) => {
      try {
        if (intent && (intent.kind !== "chatroom-host" || typeof intent.room !== "string"
          || typeof intent.user !== "string" || typeof intent.key !== "string"
          || intent.room.length > 200 || intent.user.length > 60 || Buffer.byteLength(intent.key) > 4096
          || !Number.isInteger(intent.port) || intent.port < 0 || intent.port > 65535))
          throw new Error("Invalid isolated Room form values.");
        if (intent && !vscode.workspace.isTrusted) throw new Error("Trusted workspace approval is required for Room hosting.");
        if (intent && client && !importedReadOnly && !experimentEnabled) {
          if (roomMenuActive) throw new Error("Use Host another Room in the active isolated Room menu.");
          await hostIsolatedRoom(context, client, undefined, intent);
          return;
        }
        if (client) throw new Error("Close the current trial before starting another.");
        const selected = await vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true,
          canSelectMany: false, openLabel: "Select an empty trial directory or a previously hosted isolated Room trial" });
        if (!selected?.[0]) return;
        const node = await vscode.window.showOpenDialog({ canSelectFiles: true, canSelectFolders: false,
          canSelectMany: false, openLabel: "Select local Node 22.18 or newer" });
        if (!node?.[0]) return;
        const recoveries = await loadRoomRecoveryPins(context.secrets, selected[0].fsPath, legacyRoot());
        const chatRecoveries = intent ? [] : await loadSelectedChatRecoveryPins(context.secrets, selected[0].fsPath, fs.realpathSync(legacyRoot()));
        if (recoveries.length && !vscode.workspace.isTrusted) throw new Error("Trusted workspace approval is required for Room recovery.");
        if (chatRecoveries.length && !vscode.workspace.isTrusted) throw new Error("Trusted workspace approval is required for Chat recovery.");
        let recovery: typeof recoveries[number] | undefined = recoveries[0];
        let chatRecovery: typeof chatRecoveries[number] | undefined = chatRecoveries[0];
        if (recovery && chatRecovery) {
          const choice = await vscode.window.showQuickPick([
            { label: "Reopen a saved isolated Room", type: "room" },
            { label: "Reopen a saved selected Chat", type: "chat" },
          ], { title: "Choose an isolated trial recovery" });
          if (!choice) return;
          if (choice.type === "room") chatRecovery = undefined;
          else recovery = undefined;
        }
        if (recovery && recoveries.length > 1) {
          const choice = await vscode.window.showQuickPick(recoveries.map(pin => ({
            label: pin.nativeName ?? pin.roomName ?? pin.roomId, description: pin.roomId, pin,
          })),
            { placeHolder: "Choose one independently pinned Room to rehost; the others remain inactive" });
          if (!choice) return;
          recovery = choice.pin;
        }
        if (chatRecovery && chatRecoveries.length > 1) {
          const choice = await vscode.window.showQuickPick(chatRecoveries.map(pin => ({
            label: pin.chatId, description: pin.namespace, pin,
          })), { title: "Choose one independently pinned selected Chat" });
          if (!choice) return;
          chatRecovery = choice.pin;
        }
        if (recovery) await verifyRoomRecoveryCredential(context.secrets, recovery);
        const confirm = chatRecovery ? await vscode.window.showWarningMessage(
          "Reopen this isolated selected Chat trial?",
          { modal: true, detail: `Trial: ${chatRecovery.parent}\nOnly the pinned Chat can be reopened. Original history is not modified. Pending inputs need explicit review, and model and program authority must be selected again.` }, "Reopen Chat")
          : recovery ? await vscode.window.showWarningMessage(
          intent ? "Open the saved isolated Room trial to create another Room?" : "Reopen the saved isolated Room after checking this profile's Host credential?",
          { modal: true, detail: `Trial: ${recovery.parent}\nCredential checked for Room: ${recovery.roomId}\nOnly independently pinned Rooms can be hosted; other trial workflows remain unavailable. Other Rooms remain inactive until separately selected. WebSocket traffic is not encrypted. This does not change the existing Knowledge Root.` }, intent ? "Open Trial" : "Reopen Room")
          : await vscode.window.showWarningMessage(
            "Create a disposable PKM Next trial in the selected empty directory? This does not migrate or replace your existing Knowledge Root.",
            { modal: true, detail: selected[0].fsPath }, "Create Trial");
        if (confirm !== (chatRecovery ? "Reopen Chat" : recovery ? intent ? "Open Trial" : "Reopen Room" : "Create Trial")) return;
        if (client) throw new Error("Close the current trial before starting another.");
        const candidate = new NextManagedClient();
        client = candidate;
        importedReadOnly = false;
        try {
          if (chatRecovery) await candidate.resumeSelectedChat(context.extensionPath, chatRecovery, node[0].fsPath, fs.realpathSync(legacyRoot()));
          else if (recovery) await candidate.resumeIsolatedRoom(context.extensionPath, recovery, node[0].fsPath, legacyRoot(), recoveries);
          else await candidate.start(context.extensionPath, selected[0].fsPath, node[0].fsPath, legacyRoot());
        }
        catch (error) {
          if (client === candidate && candidate.isStopped()) client = undefined;
          else if (client === candidate) {
            const detail = error instanceof Error ? error.message : "Startup failed; outcome unknown.";
            throw new Error(`${detail} The child remains tracked. Use Close Trial to wait for drain; do not retry automatically.`);
          }
          throw error;
        }
        if (chatRecovery) await vscode.commands.executeCommand("personalKnowledge.openNextSelectedChat");
        else if (intent) await hostIsolatedRoom(context, candidate, undefined, intent);
        else if (recovery) await hostIsolatedRoom(context, candidate, recovery.roomId);
        else {
          await vscode.window.showInformationMessage("Isolated PKM Next trial started. External writers remain unknown; no cutover was performed.");
          await trialMenu(candidate, false, () => hostIsolatedRoom(context, candidate));
        }
      } catch (error) {
        void vscode.window.showErrorMessage(`PKM Next trial: ${error instanceof Error ? error.message : "Operation failed."}`);
      }
    }),
    vscode.commands.registerCommand("personalKnowledge.nextTrialClose", async () => {
      try { await closeNextManagedTrial(); }
      catch { void vscode.window.showErrorMessage("PKM Next trial did not drain; reconcile uncertain writes before continuing."); }
    }),
    vscode.commands.registerCommand("personalKnowledge.nextTrialDocuments", async () => {
      if (!client) { void vscode.window.showErrorMessage("Start an isolated PKM Next trial first."); return; }
      try {
        const recoveredRoom = client.recoveredRoomId();
        if (recoveredRoom) await hostIsolatedRoom(context, client, recoveredRoom);
        else await trialMenu(client, importedReadOnly, () => hostIsolatedRoom(context, client!));
      }
      catch (error) { void vscode.window.showErrorMessage(`PKM Next trial: ${error instanceof Error ? error.message : "Operation failed."}`); }
    }),
  );
}

function trialFields(area: string): string[] {
  const common = ["description", "tags", "links", "pinned"];
  return [...common, ...(area === "notes" ? ["type"] : area === "skills" ?
    ["source_project", "recipe_required", "recipe_hint", "related_skills", "priority"] :
    ["authors", "year", "topic", "publisher", "url", "file", "conclusions", "implementation", "assumptions", "cites", "kind", "group"])];
}

async function openTrialDraft(current: NextManagedClient, readOnly: boolean): Promise<void> {
  const choice = await vscode.window.showQuickPick([
    { label: "Notes", area: "notes" }, { label: "Skills", area: "skills" }, { label: "Research", area: "papers" },
  ], { placeHolder: "Isolated document editor — choose a knowledge area" });
  if (!choice) return;
  const unwrap = (response: any) => {
    if (response?.error) throw new Error(response.error.code);
    if (!response?.result) throw new Error("Invalid document response.");
    return response.result;
  };
  const scan = readOnly ? undefined : unwrap(await current.invoke("mutation-scan", {}));
  if (!readOnly && (!/^[a-f0-9]{64}$/.test(scan.scanRevision) || !Array.isArray(scan.documents)))
    throw new Error("Invalid native mutation scan.");
  let offset = 0, workspaceRevision: string | undefined, selected: any;
  for (;;) {
    const listing = unwrap(await current.invoke("list", { area: choice.area, offset, limit: 50,
      ...(workspaceRevision ? { workspaceRevision } : {}) }));
    if (!Array.isArray(listing.items) || listing.items.length > 50 || !/^[a-f0-9]{64}$/.test(listing.workspaceRevision) ||
      workspaceRevision && listing.workspaceRevision !== workspaceRevision ||
      !Number.isSafeInteger(listing.total) || listing.total < offset + listing.items.length ||
      listing.items.some((item: any) => item.area !== choice.area || item.deleted ||
        typeof item.id !== "string" || typeof item.path !== "string" || !Number.isSafeInteger(item.revision) ||
        !/^[a-f0-9]{64}$/.test(item.sha256)) ||
      (listing.nextOffset === null ? offset + listing.items.length !== listing.total :
        listing.nextOffset !== offset + listing.items.length || listing.nextOffset <= offset || listing.nextOffset >= listing.total))
      throw new Error("Document inventory identity or pagination changed.");
    workspaceRevision = listing.workspaceRevision;
    const items = listing.items.map((item: any) => ({
      label: item.title, description: `${item.path} · ${item.id} · revision ${item.revision}`, item, action: "open",
    }));
    if (!readOnly) items.unshift({ label: "Create a new document", description: choice.area, item: undefined, action: "create" });
    if (listing.nextOffset !== null) items.push({ label: "Next document page", description: "", item: undefined, action: "more" });
    if (!items.length) { await vscode.window.showInformationMessage("No documents in this read-only area."); return; }
    const pick = await vscode.window.showQuickPick(items as { label: string; item: any; action: string }[],
      { placeHolder: readOnly ? "Read-only imported copy — enable isolated experiment separately to edit" : "Open a draft; explicit Publish uses identity and revision CAS" });
    if (!pick) return;
    if (pick.action === "more") { offset = listing.nextOffset; continue; }
    selected = pick; break;
  }
  let draft: TrialDraft, content = "";
  if (selected.action === "create") {
    const title = await vscode.window.showInputBox({ prompt: "New basic isolated document title (not a full structured Skill/Research form)" });
    if (title === undefined) return;
    if (!title.trim() || title.trim().length > 500) throw new Error("Title must contain 1–500 characters.");
    const category = await vscode.window.showInputBox({ prompt: "Native category (empty for root; no absolute or traversal paths)", value: "" });
    if (category === undefined) return;
    draft = { owner: current, area: choice.area, id: "(assigned by native create)", path: "(assigned by native create)",
      title: title.trim(), category, scanRevision: scan.scanRevision };
  } else {
    const row = selected.item, record = unwrap(await current.invoke("get", { id: row.id }));
    if (record.id !== row.id || record.area !== choice.area || record.path !== row.path ||
      record.revision !== row.revision || record.sha256 !== row.sha256 || record.deleted || typeof record.content !== "string")
      throw new Error("Document changed since listing. Reopen before editing.");
    content = record.content;
    if (!readOnly && !scan.documents.some((item: any) => item.id === record.id && item.area === record.area &&
      item.path === record.path && item.revision === record.revision && item.sha256 === record.sha256))
      throw new Error("Document does not match the native mutation scan. Reopen before editing.");
    draft = { owner: current, area: choice.area, id: record.id, path: record.path, title: record.title,
      knowledgeId: scan?.documents.find((item: any) => item.id === record.id)?.knowledgeId,
      scanRevision: scan?.scanRevision ?? "", base: { revision: record.revision, sha256: record.sha256 } };
  }
  const document = await vscode.workspace.openTextDocument({ language: "plaintext", content });
  draft.body = document;
  if (!readOnly && current === client && experimentEnabled) drafts.set(document, draft);
  await vscode.window.showTextDocument(document, { preview: false });
  await vscode.window.showInformationMessage(readOnly ? "Read-only isolated preview. Editing this untitled buffer cannot publish." :
    `Isolated ${choice.area} draft: ${draft.path}. Edit multiple lines, then use PKM: Publish Isolated Document Draft. Ordinary Save only saves a local copy. Frontmatter identity and structured metadata are preserved by Next.`);
}

async function trialLibrary(current: NextManagedClient, area: "prompts" | "scripts" | "packages" | "actions" | "components" | "action-module-sets" | "action-state"): Promise<void> {
  const archived = !["prompts", "scripts"].includes(area);
  const unwrap = (response: any) => {
    if (response?.error) throw new Error(String(response.error.code));
    if (!response?.result) throw new Error("Invalid library response.");
    return response.result;
  };
  const digest = (value: unknown) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
  const validEntry = (entry: any) => {
    if (!entry || entry.area !== area || typeof entry.path !== "string" || !entry.path.startsWith(`${area}/`) ||
      entry.path.split("/").some((part: string) => !part || part === "." || part === "..") ||
      /[\\\u0000-\u001f\u007f]/.test(entry.path) || !["file", "directory"].includes(entry.kind) ||
      !["resource", "script", "script-identity", "placeholder", "directory"].includes(entry.role) ||
      !Number.isSafeInteger(entry.mode) || entry.mode < 0 || entry.mode > 0o777 ||
      !Number.isSafeInteger(entry.size) || entry.size < 0 ||
      !["preserved", "unassigned", "not-applicable"].includes(entry.identityStatus) ||
      !(entry.scriptIdentity === null || typeof entry.scriptIdentity === "object" && !Array.isArray(entry.scriptIdentity)) ||
      !(entry.prompt === null || typeof entry.prompt === "object" &&
        ["project", "task", "version", "file"].every(key => typeof entry.prompt[key] === "string") &&
        entry.path === `prompts/${entry.prompt.project}/${entry.prompt.task}/${entry.prompt.version}/${entry.prompt.file}`))
      throw new Error("Invalid original library entry.");
    if (archived && (entry.prompt !== null || entry.scriptIdentity !== null || entry.identityStatus !== "not-applicable" ||
      !["resource", "placeholder", "directory"].includes(entry.role)))
      throw new Error("Archived code must remain inert data without inferred runtime identity.");
    if (entry.kind === "directory" ? entry.role !== "directory" || entry.sha256 !== null || entry.size !== 0 :
      entry.role === "directory" || !digest(entry.sha256)) throw new Error("Invalid library file binding.");
    if (entry.identityStatus === "preserved" && (area !== "scripts" ||
      !["script", "script-identity"].includes(entry.role) || entry.scriptIdentity?.schema !== "pkm.script/v1" ||
      !/^script_[a-f0-9]{24}$/.test(entry.scriptIdentity.knowledgeId) || !Array.isArray(entry.scriptIdentity.aliases) ||
      !entry.scriptIdentity.aliases.every((alias: unknown) => typeof alias === "string")) ||
      entry.identityStatus !== "preserved" && entry.scriptIdentity !== null ||
      entry.identityStatus === "unassigned" && (area !== "scripts" || entry.role !== "script"))
      throw new Error("Invalid original Script identity.");
  };
  let offset = 0, snapshotRevision: string | undefined, selected: any, total: number | undefined;
  const seen = new Set<string>();
  for (;;) {
    const listing = unwrap(await current.invoke("library-list", { area, offset, limit: 50, ...(snapshotRevision ? { snapshotRevision } : {}) }));
    if (!digest(listing.snapshotRevision) || snapshotRevision && listing.snapshotRevision !== snapshotRevision ||
      !Array.isArray(listing.items) || listing.items.length > 50 || !Number.isSafeInteger(listing.total) ||
      listing.total < offset + listing.items.length || total !== undefined && listing.total !== total ||
      (listing.nextOffset === null ? listing.total !== offset + listing.items.length :
        !Number.isSafeInteger(listing.nextOffset) || listing.nextOffset !== offset + listing.items.length ||
        listing.nextOffset <= offset || listing.nextOffset >= listing.total))
      throw new Error("Library snapshot or pagination binding invalid.");
    snapshotRevision = listing.snapshotRevision; total = listing.total;
    for (const entry of listing.items) {
      validEntry(entry);
      if (seen.has(entry.path)) throw new Error("Duplicate library inventory identity.");
      seen.add(entry.path);
    }
    const choices = listing.items.map((entry: any) => ({
      label: entry.path, description: `${entry.kind} · ${entry.role} · ${entry.identityStatus} · ${entry.size} bytes`,
      detail: entry.prompt ? `Prompt version: ${entry.prompt.version} · ${entry.prompt.project} / ${entry.prompt.task}` :
        entry.scriptIdentity ? JSON.stringify(entry.scriptIdentity) : "No inferred canonical identity",
      entry, more: false,
    }));
    if (listing.nextOffset !== null) choices.push({ label: "Next library page", description: "", detail: "", entry: undefined, more: true });
    if (!choices.length) { await vscode.window.showInformationMessage(`No ${area} in this isolated trial.`); return; }
    const choice = await vscode.window.showQuickPick(choices as { label: string; entry: any; more: boolean }[],
      { placeHolder: archived ? `Isolated ${area} archive — NOT installed / execution NOT authorized / runtime NOT verified` :
        `Isolated ${area} read-only — all preserved paths; versions and aliases are not an event log` });
    if (!choice) return;
    if (!choice.more) { selected = choice.entry; break; }
    offset = listing.nextOffset;
  }
  const warning = archived ?
    "INERT DATA ONLY — NOT installed; execution NOT authorized; runtime NOT verified.\nProtected storage: legacy-code-archive/<logical path>, not native runtime roots.\nNo code loading, catalog registration, installation, grants, execution or writes. Trusted workspace automatic Action trust policy is unchanged and does not grant effects or activate this archive.\n" :
    "No execution, template rendering, writes, sidecar initialization or history restoration.\nPrompt versions are original path coordinates; Script aliases are not an event log. Unassigned identity is not a generated canonical ID.\n";
  let payload: any = { snapshotRevision, item: selected,
    ...(archived ? { preservedStoragePath: `legacy-code-archive/${selected.path}`, runtimeStatus: "not-installed-not-execution-authorized-not-runtime-verified" } : {}),
    ...(area === "action-state" ? { archivePolicy: "archive_only", authorizationStatus: "not-inherited",
      originalSourcePath: `.pkm/state/actions/${selected.path.slice("action-state/".length)}` } : {}) };
  if (selected.kind === "file") {
    if (selected.size > 1024 * 1024) throw new Error("Safe preview is limited to 1 MiB; this library file was not read.");
    const chunks: Buffer[] = [];
    let legacy: any, textStatus: string | undefined;
    offset = 0;
    do {
      const chunk = unwrap(await current.invoke("library-get", { area, path: selected.path, expectedDigest: selected.sha256,
        snapshotRevision, offset, length: 65536 }));
      if (!isDeepStrictEqual(chunk.item, selected) || chunk.snapshotRevision !== snapshotRevision || chunk.encoding !== "base64" ||
        chunk.offset !== offset || typeof chunk.data !== "string" || chunk.data.length > 87384 ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(chunk.data) ||
        !["complete-utf8", "binary", "chunked"].includes(chunk.textStatus) ||
        !(chunk.legacy === null || typeof chunk.legacy === "object" && !Array.isArray(chunk.legacy)))
        throw new Error("Library chunk identity or encoding invalid.");
      const bytes = Buffer.from(chunk.data, "base64");
      if (bytes.length !== Math.min(65536, selected.size - offset) || bytes.toString("base64") !== chunk.data ||
        chunk.nextOffset !== (offset + bytes.length < selected.size ? offset + bytes.length : null) ||
        textStatus !== undefined && (textStatus !== chunk.textStatus || !isDeepStrictEqual(legacy, chunk.legacy)))
        throw new Error("Library chunk length or continuation invalid.");
      legacy = chunk.legacy; textStatus = chunk.textStatus;
      chunks.push(bytes); offset += bytes.length;
    } while (offset < selected.size);
    const bytes = Buffer.concat(chunks), text = bytes.toString("utf8"), utf8 = Buffer.from(text).equals(bytes);
    if (createHash("sha256").update(bytes).digest("hex") !== selected.sha256 ||
      textStatus !== (selected.size > 65536 ? "chunked" : utf8 ? "complete-utf8" : "binary"))
      throw new Error("Library raw digest or text status verification failed.");
    if (textStatus !== "complete-utf8" ? legacy !== null : selected.prompt ? !legacy || legacy.raw !== text ||
      !["project", "task", "version", "file"].every(key => legacy[key] === selected.prompt[key]) :
      selected.role === "script" ? !legacy || legacy.content !== text || legacy.path !== selected.path.slice(8) ||
        legacy.knowledgeId !== (selected.scriptIdentity?.knowledgeId ?? null) ||
        !isDeepStrictEqual(legacy.aliases, selected.scriptIdentity?.aliases ?? []) : legacy !== null)
      throw new Error("Library original text model binding invalid.");
    payload = { ...payload, textStatus, legacy, encoding: utf8 ? "utf8" : "hex",
      raw: utf8 ? text : bytes.toString("hex") };
  }
  const document = await vscode.workspace.openTextDocument({ language: "plaintext",
    content: `Isolated ${area} read-only snapshot\n${warning}${area === "action-state" ?
      "HISTORICAL BYTES ONLY — archive_only. Original grants, authority, approvals and run records are NOT inherited and do NOT describe current runtime state. No authorization is restored.\n" : ""}${JSON.stringify(payload, null, 2)}\n` });
  await vscode.window.showTextDocument(document, { preview: true });
}

async function trialRecipes(current: NextManagedClient): Promise<void> {
  const unwrap = (response: any) => {
    if (response?.error) throw new Error(String(response.error.code));
    if (!response?.result) throw new Error("Invalid Recipe response.");
    return response.result;
  };
  let offset = 0, snapshotRevision: string | undefined, selected: any;
  for (;;) {
    const listing = unwrap(await current.invoke("recipe-list", { offset, limit: 50, ...(snapshotRevision ? { snapshotRevision } : {}) }));
    if (!/^[a-f0-9]{64}$/.test(listing.snapshotRevision) || !Array.isArray(listing.items) ||
      listing.items.length > 50 || !Number.isSafeInteger(listing.total) || listing.total < offset + listing.items.length ||
      (listing.nextOffset !== null && (!Number.isSafeInteger(listing.nextOffset) || listing.nextOffset <= offset ||
        listing.nextOffset !== offset + listing.items.length || listing.nextOffset >= listing.total)) ||
      (snapshotRevision && listing.snapshotRevision !== snapshotRevision)) throw new Error("Recipe snapshot binding invalid.");
    for (const row of listing.items) {
      if (!row || !/^[A-Za-z][A-Za-z0-9._-]{0,127}$/.test(row.recipeId) ||
        !/^knowledge_[a-f0-9]{24}$/.test(row.knowledgeId) || !Number.isSafeInteger(row.revision) || row.revision < 1 ||
        !/^[a-f0-9]{64}$/.test(row.executableDigest) || typeof row.name !== "string" || !row.name.trim() ||
        typeof row.description !== "string" || typeof row.category !== "string")
        throw new Error("Recipe summary binding invalid.");
    }
    snapshotRevision = listing.snapshotRevision;
    const choices = listing.items.map((row: any) => ({
      label: row.name, description: `${row.category} · ${row.recipeId} · ${row.knowledgeId} · revision ${row.revision}`, item: row, more: false,
    }));
    if (listing.nextOffset !== null) choices.push({ label: "Next Recipe page", description: "", item: undefined, more: true });
    if (!choices.length) { await vscode.window.showInformationMessage("No Recipes in this isolated trial."); return; }
    const choice = await vscode.window.showQuickPick(choices as { label: string; item: any; more: boolean }[],
      { placeHolder: "Isolated Recipes read-only — project recipes appear under Project/<name>/; no execution" });
    if (!choice) return;
    if (!choice.more) { selected = choice.item; break; }
    if (!Number.isSafeInteger(listing.nextOffset) || listing.nextOffset <= offset) throw new Error("Invalid Recipe page.");
    offset = listing.nextOffset;
  }
  const detail = unwrap(await current.invoke("recipe-get", { id: selected.recipeId, expectedRevision: selected.revision,
    expectedExecutableDigest: selected.executableDigest, snapshotRevision }));
  const item = detail.item;
  if (detail.snapshotRevision !== snapshotRevision || item?.recipeId !== selected.recipeId ||
    item.knowledgeId !== selected.knowledgeId || item.revision !== selected.revision ||
    item.executableDigest !== selected.executableDigest || item.category !== selected.category ||
    item.name !== selected.name || item.description !== selected.description)
    throw new Error("Recipe identity or revision changed; reconcile first.");
  const document = await vscode.workspace.openTextDocument({ language: "plaintext",
    content: `Isolated Recipe read-only snapshot\nNo execution, edits, bundle export or production cutover.\nLegacy project-scoped Recipes are projected as global Recipes under Project/<name>/category by the original migration. This does not grant project ownership or reconstruct opaque ProjectStore state.\n${JSON.stringify({
      snapshotRevision, summary: selected, item,
    }, null, 2)}\n` });
  await vscode.window.showTextDocument(document, { preview: true });
}

async function structuredTrialView(current: NextManagedClient, kind: "Research" | "Skills"): Promise<void> {
  const unwrap = (response: any) => {
    if (response?.error) throw new Error(String(response.error.code));
    if (!response?.result) throw new Error("Invalid structured response.");
    return response.result;
  };
  const operation = kind === "Research" ? "research-list" : "skill-list";
  let offset = 0, pin: string | undefined, item: any, selectedPage: any;
  for (;;) {
    const listing = unwrap(await current.invoke(operation, { offset, limit: 50,
      ...(pin ? kind === "Research" ? { revision: pin } : { snapshotRevision: pin } : {}) }));
    const revision = kind === "Research" ? listing.revision : listing.snapshotRevision;
    if (!/^[a-f0-9]{64}$/.test(revision) || !Array.isArray(listing.items) || pin && revision !== pin)
      throw new Error("Invalid structured snapshot binding.");
    pin = revision;
    const choices = listing.items.map((row: any) => ({
      label: String(kind === "Research" ? row.title : row.name),
      description: `${String(row.knowledgeId || row.documentId || row.slug)} · ${String(row.category || "")}`,
      item: row, more: false,
    }));
    if (listing.nextOffset !== null) choices.push({ label: `Next ${kind} page`, description: "", item: undefined, more: true });
    if (!choices.length) { await vscode.window.showInformationMessage(`No structured ${kind} in this isolated trial.`); return; }
    const choice = await vscode.window.showQuickPick(choices as { label: string; item: any; more: boolean }[],
      { placeHolder: `Isolated ${kind}: select original metadata and body (read-only)` });
    if (!choice) return;
    if (!choice.more) { item = choice.item; selectedPage = listing; break; }
    if (!Number.isSafeInteger(listing.nextOffset) || listing.nextOffset <= offset) throw new Error("Invalid structured page.");
    offset = listing.nextOffset;
  }
  let projection: any, documentId: string;
  if (kind === "Skills") {
    const detail = unwrap(await current.invoke("skill-get", { id: item.documentId, snapshotRevision: pin }));
    if (detail.snapshotRevision !== pin || detail.item.documentId !== item.documentId ||
      detail.item.documentSha256 !== item.documentSha256 || detail.item.knowledgeId !== item.knowledgeId)
      throw new Error("Skill identity changed; reconcile first.");
    projection = detail.item; documentId = item.documentId;
  } else {
    const rechecked = unwrap(await current.invoke("research-list", { offset, limit: 50, revision: pin }));
    if (JSON.stringify(rechecked) !== JSON.stringify(selectedPage)) throw new Error("Research snapshot changed.");
    let documentOffset = 0, workspaceRevision: string | undefined, found: any;
    for (;;) {
      const documents = unwrap(await current.invoke("list", { area: "papers", offset: documentOffset, limit: 100,
        ...(workspaceRevision ? { workspaceRevision } : {}) }));
      workspaceRevision = documents.workspaceRevision;
      const matches = documents.items.filter((row: any) => row.path === `${item.slug}.md`);
      if (matches.length > 1 || found && matches.length) throw new Error("Research document identity is ambiguous.");
      if (matches.length) found = matches[0];
      if (documents.nextOffset === null) break;
      if (!Number.isSafeInteger(documents.nextOffset) || documents.nextOffset <= documentOffset) throw new Error("Invalid document page.");
      documentOffset = documents.nextOffset;
    }
    if (!found) throw new Error("Research document address could not be resolved.");
    documentId = found.id; projection = item;
  }
  const metadata = unwrap(await current.invoke("metadata-get", { id: documentId }));
  const document = unwrap(await current.invoke("get", { id: documentId }));
  unwrap(await current.invoke(operation, { offset: 0, limit: 1,
    ...(kind === "Research" ? { revision: pin } : { snapshotRevision: pin }) }));
  if (metadata.id !== document.id || metadata.sha256 !== document.sha256 ||
    document.area !== (kind === "Research" ? "papers" : "skills") ||
    projection.knowledgeId && metadata.metadata?.knowledgeId !== projection.knowledgeId ||
    kind === "Skills" && document.sha256 !== item.documentSha256 ||
    kind === "Research" && document.path !== `${item.slug}.md`)
    throw new Error("Structured metadata/body identity mismatch.");
  const preview = await vscode.workspace.openTextDocument({ language: "plaintext",
    content: `Isolated ${kind} read-only snapshot\nOriginal identities, metadata and related fields; not production cutover.\n${JSON.stringify({
      snapshotRevision: pin, projection, document, originalMetadata: metadata,
    }, null, 2)}\n` });
  await vscode.window.showTextDocument(preview, { preview: true });
}

async function trialBoards(current: NextManagedClient): Promise<void> {
  const unwrap = (response: any) => {
    if (response?.error) throw new Error(String(response.error.code));
    if (!response?.result) throw new Error("Invalid Board read response.");
    return response.result;
  };
  let offset = 0, board: { slug: string; digest: string } | undefined;
  for (;;) {
    const listing = unwrap(await current.invoke("board-list", { offset, limit: 100 }));
    if (!Array.isArray(listing.items)) throw new Error("Invalid Board inventory.");
    const choices = listing.items.map((row: any) => ({
      label: String(row.title), description: String(row.slug), slug: String(row.slug), digest: String(row.digest), more: false,
    }));
    if (listing.next_offset !== null) choices.push({ label: "Next Board page", description: "", slug: "", digest: "", more: true });
    if (!choices.length) { await vscode.window.showInformationMessage("No dedicated Boards in this isolated trial. Legacy Markdown is not a Board management API."); return; }
    const choice = await vscode.window.showQuickPick(choices as { label: string; slug: string; digest: string; more: boolean }[],
      { placeHolder: "Isolated migration rehearsal — Boards read-only (no claiming or state changes)" });
    if (!choice) return;
    if (!choice.more) { board = choice; break; }
    if (!Number.isSafeInteger(listing.next_offset) || listing.next_offset <= offset) throw new Error("Invalid Board page.");
    offset = listing.next_offset;
  }
  if (!/^[a-f0-9]{64}$/.test(board.digest)) throw new Error("Invalid Board digest.");
  const summary = unwrap(await current.invoke("board-get", { board_slug: board.slug }));
  if (summary.board_slug !== board.slug || summary.digest !== board.digest) throw new Error("Board changed; reconcile before opening.");
  const section = await vscode.window.showQuickPick(["Board summary", "Tasks (read-only)", "User Stories (read-only)"],
    { placeHolder: "Read original migrated Board — writes deferred (read_only_defer)" });
  if (!section) return;
  if (section === "Board summary") {
    const document = await vscode.workspace.openTextDocument({ language: "plaintext",
      content: `Isolated Board read-only snapshot — read_only_defer\nNo Board edits, task claims or state changes.\n${JSON.stringify(summary, null, 2)}\n` });
    await vscode.window.showTextDocument(document, { preview: true }); return;
  }
  offset = 0;
  for (;;) {
    const page = unwrap(await current.invoke(section === "Tasks (read-only)" ? "board-tasks" : "board-stories",
      { board_slug: board.slug, expected_digest: board.digest, offset, limit: 50 }));
    if (page.board_slug !== board.slug || page.digest !== board.digest || !Array.isArray(page.items))
      throw new Error("Board page binding invalid.");
    const document = await vscode.workspace.openTextDocument({ language: "plaintext",
      content: `Isolated Board read-only snapshot — read_only_defer\nBoard: ${board.slug}\nDigest: ${board.digest}\n${section}\nNo Board edits, task claims or state changes.\n${JSON.stringify(page, null, 2)}\n` });
    await vscode.window.showTextDocument(document, { preview: true });
    if (page.next_offset === null) return;
    if (!Number.isSafeInteger(page.next_offset) || page.next_offset <= offset) throw new Error("Invalid Board item page.");
    if (await vscode.window.showQuickPick(["Next Board item page", "Stop reading"], { placeHolder: "Continue the same digest-pinned Board snapshot?" }) !== "Next Board item page") return;
    offset = page.next_offset;
  }
}

async function trialResources(current: NextManagedClient): Promise<void> {
  const unwrap = (response: any) => {
    if (response?.error) throw new Error(String(response.error.code));
    if (!response?.result) throw new Error("Invalid resource response.");
    return response.result;
  };
  let offset = 0;
  let selected: { id: string; label: string } | undefined;
  for (;;) {
    const listing = unwrap(await current.invoke("list", { limit: 100, offset }));
    const choices = listing.items.map((row: any) => ({
      label: String(row.title), description: `${String(row.area || "")} · ${String(row.id)}`, id: String(row.id), more: false,
    }));
    if (listing.nextOffset !== null && listing.nextOffset !== undefined)
      choices.push({ label: "Next document page", description: "", id: "", more: true });
    const choice = await vscode.window.showQuickPick(choices as { label: string; id: string; more: boolean }[],
      { placeHolder: "Isolated trial: select notes / skills / papers document resources" });
    if (!choice) return;
    if (!choice.more) { selected = choice; break; }
    if (!Number.isSafeInteger(listing.nextOffset) || listing.nextOffset <= offset) throw new Error("Invalid document page.");
    offset = listing.nextOffset;
  }
  offset = 0;
  let revision: string | undefined;
  let asset: any, documentSha256: string;
  for (;;) {
    const listing = unwrap(await current.invoke("asset-list", { id: selected.id, offset, limit: 100, ...(revision ? { revision } : {}) }));
    if (listing.id !== selected.id || !/^[a-f0-9]{64}$/.test(listing.documentSha256) || !Array.isArray(listing.items))
      throw new Error("Invalid resource inventory binding.");
    if (listing.diagnostics?.length) await vscode.window.showWarningMessage(
      "Isolated resource inventory has diagnostics.", { modal: true, detail: JSON.stringify(listing.diagnostics) });
    const choices = listing.items.map((row: any) => ({
      label: String(row.path), description: `${String(row.area)} · ${String(row.size)} bytes · ${String(row.digest)}`, asset: row, more: false,
    }));
    if (listing.nextOffset !== null && listing.nextOffset !== undefined)
      choices.push({ label: "Next resource page", description: "", asset: undefined, more: true });
    if (!choices.length) { await vscode.window.showInformationMessage("No readable resources for this isolated document."); return; }
    const choice = await vscode.window.showQuickPick(choices as { label: string; asset: any; more: boolean }[],
      { placeHolder: "Select an imported resource; safe hex preview only (no execution or file writes)" });
    if (!choice) return;
    if (!choice.more) { asset = choice.asset; documentSha256 = listing.documentSha256; break; }
    if (!Number.isSafeInteger(listing.nextOffset) || listing.nextOffset <= offset || typeof listing.revision !== "string")
      throw new Error("Invalid resource page.");
    offset = listing.nextOffset; revision = listing.revision;
  }
  if (!asset || !["notes", "skills", "papers"].includes(asset.area) || typeof asset.path !== "string" ||
    !/^sha256:[a-f0-9]{64}$/.test(asset.digest) || !Number.isSafeInteger(asset.size) || asset.size < 0)
    throw new Error("Invalid selected resource.");
  if (asset.size > 1024 * 1024) throw new Error("Safe preview is limited to 1 MiB; this resource was not read.");
  const chunks: Buffer[] = [];
  offset = 0;
  do {
    const chunk = unwrap(await current.invoke("asset-get", { id: selected.id, path: asset.path,
      expectedDocumentSha256: documentSha256!, expectedDigest: asset.digest, offset, length: 65536 }));
    if (chunk.id !== selected.id || chunk.area !== asset.area || chunk.path !== asset.path || chunk.digest !== asset.digest ||
      chunk.size !== asset.size || chunk.documentSha256 !== documentSha256! || chunk.offset !== offset ||
      typeof chunk.data !== "string" || chunk.data.length > 87384 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(chunk.data))
      throw new Error("Resource chunk binding invalid.");
    const bytes = Buffer.from(chunk.data, "base64");
    const expectedLength = Math.min(65536, asset.size - offset);
    if (bytes.length !== expectedLength || bytes.toString("base64") !== chunk.data ||
      chunk.nextOffset !== (offset + bytes.length < asset.size ? offset + bytes.length : null))
      throw new Error("Resource chunk length or continuation invalid.");
    chunks.push(bytes); offset += bytes.length;
  } while (offset < asset.size);
  const bytes = Buffer.concat(chunks);
  if (`sha256:${createHash("sha256").update(bytes).digest("hex")}` !== asset.digest) throw new Error("Resource digest verification failed.");
  const hex: string[] = [];
  for (let index = 0; index < bytes.length; index += 16) hex.push(
    `${index.toString(16).padStart(8, "0")}  ${bytes.subarray(index, index + 16).toString("hex").match(/.{2}/g)!.join(" ")}`);
  const document = await vscode.workspace.openTextDocument({ language: "plaintext",
    content: `Isolated migration rehearsal — verified resource hex preview\nNo resource execution or original-library writes.\nArea: ${asset.area}\nPath: ${asset.path}\nSize: ${asset.size}\nDigest: ${asset.digest}\nDocument SHA256: ${documentSha256!}\n\n${hex.join("\n")}\n` });
  await vscode.window.showTextDocument(document, { preview: true });
}

async function trialMenu(current: NextManagedClient, readOnly = false, hostRoom?: () => Promise<void>): Promise<void> {
  if (readOnly) {
    const listing = await current.invoke("list", { limit: 100 });
    if (listing.error) throw new Error(listing.error.code);
    const item = await vscode.window.showQuickPick((listing.result.items as any[]).map(row => ({
      label: String(row.title), description: String(row.id), id: String(row.id),
    })), { placeHolder: "Imported static copy (read-only)" });
    if (!item) return;
    const response = await current.invoke("get", { id: item.id });
    if (response.error) throw new Error(response.error.code);
    const document = await vscode.workspace.openTextDocument({ language: "markdown", content: String(response.result.content) });
    await vscode.window.showTextDocument(document, { preview: true });
    return;
  }
  const choice = await vscode.window.showQuickPick([
    "Create document", "List and edit documents", ...(hostRoom && !experimentEnabled ? ["Host an isolated legacy Room"] : []),
  ], { placeHolder: "Isolated PKM Next trial" });
  if (!choice) return;
  if (choice === "Host an isolated legacy Room") { await hostRoom?.(); return; }
  if (choice === "Create document") {
    const title = await vscode.window.showInputBox({ prompt: "Trial document title" });
    if (!title) return;
    const content = await vscode.window.showInputBox({ prompt: "Trial document content" });
    if (content === undefined) return;
    const operationId = randomUUID();
    const result = await invokeWrite(current, "create", { id: randomUUID(), operationId, title, content }, operationId);
    if (result.error) throw new Error(result.error.code);
    void vscode.window.showInformationMessage("Trial document created.");
    return;
  }
  const listing = await current.invoke("list", { limit: 100 });
  if (listing.error) throw new Error(listing.error.code);
  const item = await vscode.window.showQuickPick((listing.result.items as any[]).map(row => ({
    label: String(row.title), description: String(row.id), id: String(row.id),
  })), { placeHolder: "Select a trial document" });
  if (!item) return;
  const response = await current.invoke("get", { id: item.id });
  if (response.error) throw new Error(response.error.code);
  const document = response.result;
  const content = await vscode.window.showInputBox({ prompt: "Edit trial document content", value: document.content });
  if (content === undefined) return;
  const operationId = randomUUID();
  const result = await invokeWrite(current, "update", { id: document.id, operationId, title: document.title,
    content, expectedRevision: document.revision, expectedSha256: document.sha256 }, operationId);
  if (result.error) throw new Error(result.error.code);
  void vscode.window.showInformationMessage("Trial document updated.");
}

async function hostIsolatedRoom(context: vscode.ExtensionContext, current: NextManagedClient, recoveredRoomId?: string,
  initial?: ChatroomHostIntent): Promise<void> {
  if (!vscode.workspace.isTrusted || current !== client || roomMenuActive)
    throw new Error("A trusted, fresh isolated trial and no active Room are required.");
  type HostedRoom = {
    roomId: string; opened: { roomId: string; room: string; url: string; secret: string; hostToken: string };
    room: ChatClient; output: vscode.OutputChannel; files: Map<string, { name: string; data: Uint8Array }>;
    requests: { candidate: NextRoomParticipantApproval; resolve(value: boolean): void }[];
  };
  const hosted = new Map<string, HostedRoom>();
  let policy: { legacyReconnect: "proof-required" | "new-identity" | "host-approval"; port: number } | undefined;
  const authorized = () => vscode.workspace.isTrusted && client === current;
  const addRoom = async (recovered?: string): Promise<HostedRoom | undefined> => {
  const preset = initial;
  initial = undefined;
  const savedRooms = current.savedRoomChoices();
  let action: string | undefined = preset ? "Create a new isolated Room" : undefined;
  if (!preset && !recovered && savedRooms.length && (current.recoveredRoomId() || hosted.size === 0)) {
    const available = savedRooms.filter(item => !hosted.has(item.roomId));
    const selection = await vscode.window.showQuickPick([
      { label: "Create a new isolated Room", action: "Create a new isolated Room", roomId: "" },
      ...(!current.recoveredRoomId() ? [{ label: "Copy and host a private Room", action: "Copy and host a private Room", roomId: "" }] : []),
      ...available.map(item => ({ label: item.name, description: item.roomId, action: "", roomId: item.roomId })),
    ],
      { placeHolder: "Choose an inactive independently pinned Room or create a new Room" });
    if (!selection) return;
    if (selection.action) action = selection.action;
    else recovered = selection.roomId;
  }
  action ??= recovered ? "Rehost a Room already copied into this trial" : await vscode.window.showQuickPick([
    "Create a new isolated Room", "Copy and host a private Room", "Rehost a Room already copied into this trial"],
    { placeHolder: "Isolated Room source" });
  if (!action) return;
  const source = action === "Copy and host a private Room"
    ? (await vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true,
      canSelectMany: false, openLabel: "Select a private, closed legacy Room copy (not your live Knowledge Root)" }))?.[0]?.fsPath
    : undefined;
  if (action === "Copy and host a private Room" && !source) return;
  const creating = action === "Create a new isolated Room";
  const newName = creating ? await vscode.window.showInputBox({ prompt: "Name of the new isolated Room", value: preset?.room }) : undefined;
  if (creating && !newName?.trim()) return;
  const newHostName = creating ? await vscode.window.showInputBox({ prompt: "Your display name in the new Room", value: preset?.user || "Host",
    validateInput: value => value.trim() && value.trim().length <= 60 ? undefined : "Enter a name of at most 60 characters." }) : undefined;
  if (creating && !newHostName?.trim()) return;
  const secretInput = creating ? await vscode.window.showInputBox({ prompt: "Room secret (leave blank to generate one)", value: preset?.key, password: true }) : undefined;
  if (creating && secretInput === undefined) return;
  let roomId = creating ? "" : recovered ?? await vscode.window.showInputBox({ prompt: "Room UUID in the private copy" }) ?? "";
  if (!creating && !roomId) return;
  if (hosted.has(roomId)) throw new Error("This Room is already active.");
  if (!creating && !await new ChatRoomCredentialStore(context.secrets).load(roomId))
    throw new Error("This VS Code profile does not have the original Room Host credentials.");
  const reconnect = policy ? undefined : await vscode.window.showQuickPick([
    "Require participant credential to restore an identity",
    "Approve legacy participant identity recovery",
    "Allow legacy clients as a new identity on each reconnect",
  ], { placeHolder: "Choose how clients without a private participant credential join" });
  if (!policy && !reconnect) return;
  const legacyReconnect = policy?.legacyReconnect ?? (reconnect === "Allow legacy clients as a new identity on each reconnect" ? "new-identity"
    : reconnect === "Approve legacy participant identity recovery" ? "host-approval" : "proof-required");
  const portInput = policy ? String(policy.port) : await vscode.window.showInputBox({
    prompt: "Loopback port for this Room; reuse the same port when rehosting to retain participant credentials (0 chooses a temporary port)",
    value: preset ? String(preset.port) : "7345", validateInput: value => /^\d+$/.test(value) && (Number(value) === 0
      || Number(value) >= 1024 && Number(value) <= 65535)
      ? undefined : "Choose 0 or a port from 1024 to 65535.",
  });
  if (portInput === undefined || !/^\d+$/.test(portInput)
    || Number(portInput) !== 0 && (Number(portInput) < 1024 || Number(portInput) > 65535)) return;
  const approved = await vscode.window.showWarningMessage("Copy and host this Room only inside the disposable Next trial?",
    { modal: true, detail: `${creating ? "Create a new native Room in this trial.\n" : source ? `Source: ${source}\n` : "Use the Room already copied into this trial.\n"}Room: ${creating ? newName : roomId}\n${source ? "The source must be a closed private copy outside the live Knowledge Root. " : ""}This host listens on loopback only; WebSocket traffic is not encrypted. ${legacyReconnect === "new-identity" ? "Old clients without credentials join as new participants; each reconnect gets another identity and historic authorship stays separate." : legacyReconnect === "host-approval" ? "Recovering an old participant without a credential requires your explicit approval and out-of-band identity verification. Unmodified old clients need approval on every reconnect." : "Historic non-Host clients cannot reclaim an identity without a new credential."} This is not a production cutover.` }, "Host Isolated Room");
  if (approved !== "Host Isolated Room") return;
  if (!authorized()) throw new Error("Room authority changed.");
  if (source) await current.copyIsolatedRoom(source, roomId);
  const requests: { candidate: NextRoomParticipantApproval; resolve(value: boolean): void }[] = [];
  const approveParticipant = (candidate: NextRoomParticipantApproval) => {
    while (requests.length && requests[0].candidate.expiresAt <= Date.now()) requests.shift()!.resolve(false);
    if (requests.length >= 16) return Promise.resolve(false);
    return new Promise<boolean>(resolve => {
      requests.push({ candidate, resolve });
      void vscode.window.showInformationMessage(`A legacy participant requests identity recovery in Room ${roomId}. Switch to that Room and review it in the Host menu.`);
    });
  };
  const opened = creating
    ? await current.createIsolatedRoom(newName!, newHostName!.trim(), secretInput?.trim() || undefined,
      context.secrets, authorized, legacyReconnect, approveParticipant, Number(portInput))
    : await current.openIsolatedRoom(roomId, context.secrets, authorized, legacyReconnect, approveParticipant, Number(portInput));
  roomId = opened.roomId;
  const output = vscode.window.createOutputChannel("PKM Next isolated Room");
  const files = new Map<string, { name: string; data: Uint8Array }>();
  let resolveConnected!: () => void;
  const connected = new Promise<void>(resolve => { resolveConnected = resolve; });
  const room = new ChatClient({
    onStatus(status) { if (status === "connected") resolveConnected(); },
    onMessage(message) { output.appendLine(`${message.from || "Room"}: ${message.text}`); },
    onHistory(messages) { for (const message of messages) output.appendLine(`${message.from || "Room"}: ${message.text}`); },
    onPresence() {},
    onFileComplete(meta, _from, data) { files.set(meta.fileId, { name: meta.name, data }); output.appendLine(`Received attachment: ${meta.name}`); },
    onRejected(code, message) { output.appendLine(`Room rejected ${code}: ${message}`); },
  });
  isolatedRoomClients.add(room);
  let connectionTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    room.connect({ ...opened, user: current.nativeRoomHostName(roomId) ?? "Host", cid: `next-host-${randomUUID()}`, token: opened.secret });
    await Promise.race([connected, new Promise<never>((_, reject) => {
      connectionTimer = setTimeout(() => reject(new Error("Room Host connection timed out.")), 15000);
    })]);
    if (connectionTimer) clearTimeout(connectionTimer);
    policy ??= { legacyReconnect, port: Number(new URL(opened.url).port) };
    const entry = { roomId, opened, room, output, files, requests };
    hosted.set(roomId, entry);
    output.show(true);
    return entry;
  } catch (error) {
    for (const request of requests) request.resolve(false);
    if (connectionTimer) clearTimeout(connectionTimer);
    room.disconnect(); isolatedRoomClients.delete(room); output.dispose();
    await current.closeIsolatedRoom(roomId);
    throw error;
  }
  };
  const closeRoom = async (entry: HostedRoom) => {
    for (const request of entry.requests) request.resolve(false);
    entry.room.disconnect(); isolatedRoomClients.delete(entry.room); entry.output.dispose();
    hosted.delete(entry.roomId);
    await current.closeIsolatedRoom(entry.roomId);
  };
  roomMenuActive = true;
  try {
    let active = await addRoom(recoveredRoomId);
    while (authorized() && active && hosted.has(active.roomId)) {
      const { room, opened, files, requests } = active;
      if (!room.isConnected) { await closeRoom(active); active = hosted.values().next().value; continue; }
      const action = await vscode.window.showQuickPick(["Send message", "Send attachment", "Save received attachment",
        "Copy local Magic Link", "Review participant approvals", "Host another Room", "Switch Room", "Close this Room", "Stop Host"],
        { placeHolder: `Isolated Room ${opened.room} — shared loopback Hub (ws is unencrypted)` });
      if (!action || action === "Stop Host") break;
      if (action === "Host another Room") {
        try {
          const added = await addRoom();
          if (added) active = added;
        } catch (error) {
          void vscode.window.showErrorMessage(`Room was not added: ${error instanceof Error ? error.message : "Operation failed."}`);
        }
      } else if (action === "Switch Room") {
        const selected = await vscode.window.showQuickPick([...hosted.values()].map(entry => ({
          label: entry.opened.room, description: entry.roomId, entry,
        })), { placeHolder: "Select an active Room" });
        if (selected) { active = selected.entry; active.output.show(true); }
      } else if (action === "Close this Room") {
        await closeRoom(active);
        active = hosted.values().next().value;
        if (active) active.output.show(true);
      } else if (action === "Send message") {
        const text = await vscode.window.showInputBox({ prompt: "Address @all or a participant" });
        if (text && !room.sendText(text)) throw new Error("Room is not connected.");
      } else if (action === "Send attachment") {
        const file = (await vscode.window.showOpenDialog({ canSelectMany: false, canSelectFiles: true,
          canSelectFolders: false, openLabel: "Select an attachment up to 25 MiB" }))?.[0];
        if (file) {
          const stat = await vscode.workspace.fs.stat(file);
          if (stat.size > 25 * 1024 * 1024) throw new Error("Attachment exceeds the 25 MiB limit.");
          const sent = await room.sendFile(file.path.split("/").pop() || "attachment", "application/octet-stream",
            Buffer.from(await vscode.workspace.fs.readFile(file)));
          if (!sent.ok) throw new Error(sent.error || "Attachment could not be sent.");
        }
      } else if (action === "Save received attachment") {
        const selected = await vscode.window.showQuickPick([...files].map(([id, file]) => ({ label: file.name, id })));
        const file = selected && files.get(selected.id);
        if (file) {
          const destination = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(file.name) });
          if (destination) await vscode.workspace.fs.writeFile(destination, file.data);
        }
      } else if (action === "Review participant approvals") {
        while (requests.length && requests[0].candidate.expiresAt <= Date.now()) requests.shift()!.resolve(false);
        const request = requests.shift();
        if (!request) { void vscode.window.showInformationMessage("No pending participant identity recovery."); continue; }
        const c = request.candidate;
        let decision: string | undefined;
        try {
          decision = await vscode.window.showWarningMessage("Restore this historical participant identity?",
            { modal: true, detail: `Room: ${JSON.stringify(c.roomId)}\nHistorical participant: ${JSON.stringify(c.participantId)}\nPrevious alias: ${JSON.stringify(c.previousAlias)}\nRequested alias: ${JSON.stringify(c.requestedAlias)}\nClient ID: ${JSON.stringify(c.clientId)}\nKind: ${c.kind}\n\nThe shared Room secret and client ID do NOT prove identity. Verify this person or agent out of band before approving. This grants the historical participant's authority.` }, "Approve Identity Recovery");
        } finally {
          request.resolve(decision === "Approve Identity Recovery" && authorized() && Date.now() < c.expiresAt);
        }
      } else {
        await vscode.env.clipboard.writeText(createChatMagicLink(`${opened.url}/${encodeURIComponent(opened.room)}`, opened.secret, opened.roomId));
        void vscode.window.showInformationMessage("Local-only Room Magic Link copied; it contains the shared secret.");
      }
    }
  } finally {
    for (const entry of hosted.values()) {
      for (const request of entry.requests) request.resolve(false);
      entry.room.disconnect(); isolatedRoomClients.delete(entry.room); entry.output.dispose();
    }
    hosted.clear();
    try { if (!current.isStopped()) await current.closeIsolatedRoom(); }
    finally { roomMenuActive = false; }
  }
}

async function invokeWrite(current: NextManagedClient, operation: Parameters<NextManagedClient["invoke"]>[0], args: Record<string, unknown>, id: string): Promise<any> {
  try {
    const result = await current.invoke(operation, args);
    if (result?.error?.effect === "unknown") throw new Error("UNKNOWN");
    return result;
  }
  catch { throw new Error(`Write outcome may be unknown. Preserve operation ID ${id}; reconcile before any retry.`); }
}
