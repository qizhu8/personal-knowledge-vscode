import * as vscode from "vscode";
import { hostname } from "os";
import * as fs from "fs";
import * as path from "path";
import { PersonaProfileStore, PersonaProfile, PersonaFields } from "./persona-profiles";
import type { ApiConversation } from "./api-chat-store";

export async function configurePersonaProfiles(store: PersonaProfileStore, chat: ApiConversation,
  persistAssignment: (id: string | undefined) => void): Promise<void> {
  const selection = await vscode.window.showQuickPick([
    { label: "User Profile", description: store.syncEnabled ? "Knowledge Root Profile · GitHub Sync requires separate target approval" : "Private to this OS user / VS Code profile / Host; not synced", action: "user" },
    { label: "Agent Profile", description: chat.agentProfileId ? `Explicit assignment: ${chat.agentProfileId}` : "Not assigned", action: "agent" },
    { label: "Assign Agent Profile", description: "Only this Chat; applies next attempt / retry", action: "assign" },
    { label: "Create Agent Profile", description: store.syncEnabled ? "Stored in this Knowledge Root's profiles directory" : "Private to this Knowledge Root on this Host", action: "create" },
    { label: "Profile storage / GitHub Sync", description: store.syncEnabled ? "Repository cards enabled on this Host; review scope or return to private cards" : "Off by default · preview and authorize repository cards", action: "sync" },
    { label: "Historical attempt Profiles", description: "Immutable snapshots; retained after Profile deletion", action: "history" },
  ], { title: "User / Agent Profiles · current cards and historical evidence", ignoreFocusOut: true });
  if (!selection) return;
  if (selection.action === "sync") {
    if (store.syncEnabled) {
      const choice = await vscode.window.showWarningMessage("Use private Host Profiles again?", {modal:true,
        detail:`Repository cards remain at ${store.knowledgeRoot}/profiles. This stops using/editing them here; it does NOT remove published copies, Git history or another device's cards. To stop transfer, deselect Profiles in every GitHub Sync target. Existing Chat Agent assignments are not changed and may require explicit reassignment.`,
      }, "Use private Profiles");
      if (choice === "Use private Profiles") store.setSyncEnabled(false);
      return;
    }
    const preview = store.syncPreview();
    const existing = fs.existsSync(path.join(store.knowledgeRoot, "profiles"));
    const choice = await vscode.window.showWarningMessage("Enable repository User / Agent Profiles for this Knowledge Root?", {modal:true,
      detail:`Root: ${store.knowledgeRoot}\n\n${existing ? "Existing repository cards will be used; private cards will NOT overwrite or merge into them." : "Current private cards will be copied with their original identities and revisions. Original private copies remain unchanged."}\n\nPrivate cards:\n${JSON.stringify(preview.privateCards, null, 2)}\n\nRepository cards:\n${JSON.stringify(preview.repositoryCards, null, 2)}\n\nCards may contain personal preferences and boundaries. Only Profiles are included, not Chat history, credentials or long-term Memory. Repository User Profiles are root-scoped, not Host-global. No model inference or upload occurs now. Next, select Profiles in the private section of a GitHub Sync target and approve that repository/branch separately. New devices must also approve local use. Deletion cannot erase Git history.`,
    }, "Enable repository Profiles");
    if (choice === "Enable repository Profiles") {
      store.setSyncEnabled(true, preview.digest);
      await vscode.window.showInformationMessage("Repository Profiles enabled locally. In GitHub Sync, explicitly select Profiles under Private and approve the destination before transfer. Existing Agent assignments are not silently changed.");
    }
    return;
  }
  if (selection.action === "assign") {
    const choice = await vscode.window.showQuickPick([
      { label: "Not assigned", id: undefined as string | undefined },
      ...store.list("agent").map(p => ({ label: p.name, description: `${p.role} · revision ${p.revision}`, id: p.id })),
    ], { title: "Explicit Agent assignment · next attempt", ignoreFocusOut: true });
    if (choice) { if (choice.id) store.get("agent", choice.id); persistAssignment(choice.id); }
    return;
  }
  if (selection.action === "history") {
    const choice = await vscode.window.showQuickPick(chat.messages.filter(m => m.role === "assistant").map(m => ({
      label: m.progress?.attemptId || m.id, description: `${m.status} · ${m.recordedAt || "time unavailable"}`, message: m,
    })).reverse(), { title: "Select an attempt (never substituted with current cards)", ignoreFocusOut: true });
    if (!choice) return;
    const snapshot = choice.message.profileContext;
    const rounds = choice.message.budgetReceipts || [];
    await vscode.window.showInformationMessage(snapshot ? "Historical Profile snapshot" : "Historical Profile unavailable / not configured", {
      modal: true, detail: snapshot ? `${JSON.stringify(snapshot, null, 2)}\n\nBudget / transport evidence:\n${JSON.stringify(rounds.map(r => ({
        round: r.round, status: r.status, messageInPlan: r.contextPlan?.manifest.some(m => m.hash === snapshot.messageHash),
        countingMethod: r.countingMethod, estimatedInputTokens: r.consumed.estimatedInputTokens,
        transport: r.transport,
      })), null, 2)}` : "This attempt recorded no Profile snapshot. The current Profile was not substituted.",
    });
    return;
  }
  let record: PersonaProfile | undefined;
  const kind = selection.action === "user" ? "user" : "agent";
  if (selection.action === "user") record = store.user();
  else if (selection.action === "agent") {
    if (!chat.agentProfileId) {
      await vscode.window.showInformationMessage("Agent Profile: not assigned. Use Assign Agent Profile to select one explicitly.");
      return;
    }
    record = store.get("agent", chat.agentProfileId);
  }
  const action = await vscode.window.showInformationMessage(record ? `${record.name} · revision ${record.revision}` : `No ${kind} Profile configured`, {
    modal: true,
    detail: `Host: ${hostname()}\nScope: ${store.syncEnabled ? `Repository cards: ${store.knowledgeRoot}/profiles` : kind === "user" ? `OS user / VS Code profile (${store.privateDirectory})` : `Knowledge Root ${store.knowledgeRoot}`}\n\n${record ? `ID: ${record.id}\nUpdated: ${record.updatedAt}\n\nRole: ${record.role}\nFocus: ${record.focus}\nWorking preferences: ${record.preferences}\nResponsibility boundaries: ${record.boundaries}` : "No preference context is applied."}\n\nConfigured focus is not verified competence or permission. Changes apply next attempt / retry; running attempts do not change. ${store.syncEnabled ? "Repository cards: transfer requires separately authorized GitHub Sync targets. Deletion may synchronize a tombstone; Git history and other copies remain." : "Private Host storage, no automatic cross-device sync."} Deletion stops future use; historical Chat snapshots remain until that history is deleted.`,
  }, record ? "Edit" : "Create", ...(record ? ["Delete"] : []));
  if (!action) return;
  if (action === "Delete" && record) {
    const confirmed = await vscode.window.showWarningMessage("Delete this Profile? Historical attempt snapshots will remain.", {
      modal: true, detail: "Deletion stops future use. Other Chats referencing this Agent must explicitly unassign it before sending; no fallback will be used.",
    }, "Delete Profile");
    if (confirmed === "Delete Profile") {
      store.delete(record);
      if (chat.agentProfileId === record.id) persistAssignment(undefined);
    }
    return;
  }
  const content: PersonaFields = { name: record?.name || (kind === "user" ? "User" : ""), role: record?.role || "",
    focus: record?.focus || "", preferences: record?.preferences || "", boundaries: record?.boundaries || "" };
  for (const key of ["name", "role", "focus", "preferences", "boundaries"] as const) {
    const value = await vscode.window.showInputBox({ title: `${kind === "user" ? "User" : "Agent"} Profile · ${key}`,
      prompt: `Explicit preferences only; no secrets or inferred sensitive traits. Total card limit: ${kind === "user" ? 2000 : 4000} characters. Cancel discards all edits.`,
      value: content[key], ignoreFocusOut: true,
      validateInput: value => key === "name" && !value.trim() ? "Name is required." : undefined });
    if (value === undefined) return;
    content[key] = value;
  }
  const saved = store.save(kind, content, record);
  await vscode.window.showInformationMessage(`${saved.name} saved at revision ${saved.revision}. ${kind === "agent" && selection.action === "create" ? "Use Assign Agent Profile to apply it explicitly." : "Applies next attempt / retry."}`);
}
