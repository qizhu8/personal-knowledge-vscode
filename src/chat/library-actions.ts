import type * as vscode from "vscode";
import type { ApiChatStore } from "./api-chat-store";

async function chooseChatGroup(store: ApiChatStore, host: Pick<typeof vscode, "window">): Promise<string | undefined> {
  const picker = host.window.createQuickPick<vscode.QuickPickItem & { groupId?: string; newName?: string }>();
  picker.title = "Move Chat to group";
  picker.placeholder = "Select a group or type a new group name";
  picker.ignoreFocusOut = true;
  const groups = store.library.read().groups;
  const update = () => {
    const name = picker.value.trim();
    const existing = [{ label: "Ungroup", groupId: "ungroup" }, ...groups.map(group => ({ label: group.name, groupId: group.id }))];
    picker.items = name && !["ungroup", "trash"].includes(name.toLowerCase()) && !groups.some(group => group.name.toLowerCase() === name.toLowerCase())
      ? [{ label: name, description: "Create new group", newName: name }, ...existing] : existing;
  };
  update();
  try {
    const choice = await new Promise<{ groupId?: string; newName?: string } | undefined>(resolve => {
      picker.onDidChangeValue(update);
      picker.onDidAccept(() => resolve(picker.selectedItems[0]));
      picker.onDidHide(() => resolve(undefined));
      picker.show();
    });
    return choice?.newName ? store.library.createGroup(choice.newName) : choice?.groupId;
  } finally { picker.dispose(); }
}

export async function handleChatLibraryAction(message: { type?: string; id?: string; value?: string | boolean }, store: ApiChatStore,
  host: Pick<typeof vscode, "window">, isRunning: (id: string) => boolean, forget: (id: string) => void, deleted?: (id: string, namespace: string) => void | Promise<void>,
  removed?: (id: string) => void | Promise<void>): Promise<void> {
  const id = String(message.id);
  const deleteOne = (chatId: string) => store.withDeletionLock(chatId, async () => {
    if (isRunning(chatId)) throw new Error("Stop the running Chat before permanently deleting it.");
    const intent = await store.prepareLibraryDeletion(chatId);
    if (intent.chatPresent) await store.libraryMutation("delete-prepared", chatId);
    // The intent survives until every cleanup step succeeds. Never purge Memory while a Chat is recoverable.
    await deleted?.(chatId, intent.namespace);
    await removed?.(chatId);
    forget(chatId);
    await store.libraryMutation("finish-delete", chatId);
  });
  switch (message.type) {
    case "groupCreate": {
      const name = await host.window.showInputBox({ title: "New Chat group", ignoreFocusOut: true });
      if (name !== undefined) store.library.createGroup(name); return;
    }
    case "groupRename": {
      const group = store.library.read().groups.find(item => item.id === id);
      if (!group) throw new Error("Choose an existing Chat group.");
      const name = await host.window.showInputBox({ title: "Rename Chat group", value: group.name, ignoreFocusOut: true });
      if (name !== undefined) store.library.renameGroup(id, name); return;
    }
    case "groupDelete": {
      const choice = await host.window.showWarningMessage("Delete Chat group? Chats will move to Ungroup.", { modal: true }, "Delete group");
      if (choice === "Delete group") store.library.deleteGroup(id); return;
    }
    case "moveChat": {
      store.load(id, false);
      let groupId = typeof message.value === "string" ? message.value : undefined;
      if (!groupId) {
        groupId = await chooseChatGroup(store, host);
      }
      if (groupId) store.library.move(id, groupId); return;
    }
    case "trashChat": {
      if (isRunning(id)) throw new Error("Stop the running Chat before moving it to Trash.");
      const choice = await host.window.showWarningMessage("Move Chat to Trash? Task Session evidence is preserved.", { modal: true }, "Move to Trash");
      if (choice === "Move to Trash") { await store.libraryMutation("trash", id); await removed?.(id); forget(id); } return;
    }
    case "restoreChat": await store.libraryMutation("restore", id); return;
    case "deleteChat": {
      const pending = store.pendingDeletionCleanups().some(item => item.id === id);
      const label = pending ? "Retry deletion cleanup" : "Delete permanently";
      const choice = await host.window.showWarningMessage(pending
        ? "This Chat is permanently deleted and cannot be restored. Retry its pending Memory and endpoint cleanup?"
        : "Permanently delete this Chat? Task Session evidence is preserved. If later cleanup fails, the Chat cannot be restored; cleanup remains available in Trash.",
      { modal: true }, label);
      if (choice === label) {
        try { await deleteOne(id); }
        catch (error) {
          throw new Error(`Chat deletion did not finish. Inspect Trash and pending deletion cleanup before explicitly retrying: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      return;
    }
    case "emptyTrash": {
      const choice = await host.window.showWarningMessage("Permanently delete all Chats in Trash and retry pending cleanup? Task Session evidence is preserved. Chats already deleted cannot be restored.", { modal: true }, "Empty Trash");
      if (choice === "Empty Trash") {
        const failures: string[] = [];
        for (const item of await store.trashList()) {
          try {
            await deleteOne(item.id);
          } catch (error) { failures.push(`${item.title} (${item.id}): ${error instanceof Error ? error.message : String(error)}`); }
        }
        if (failures.length) throw new Error(`Some deletions did not finish. Chats not deleted remain in Trash; already deleted Chats have pending cleanup and cannot be restored:\n${failures.join("\n")}`);
      }
      return;
    }
    default: throw new Error("Unknown Chat library action.");
  }
}