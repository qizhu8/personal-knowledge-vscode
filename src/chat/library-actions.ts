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
  host: Pick<typeof vscode, "window">, isRunning: (id: string) => boolean, forget: (id: string) => void, deleted?: (id: string) => void | Promise<void>): Promise<void> {
  const id = String(message.id);
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
      if (choice === "Move to Trash") { await store.libraryMutation("trash", id); forget(id); } return;
    }
    case "restoreChat": await store.libraryMutation("restore", id); return;
    case "deleteChat": {
      const choice = await host.window.showWarningMessage("Permanently delete this Chat? Task Session evidence is preserved.", { modal: true }, "Delete permanently");
      if (choice === "Delete permanently") {
        if (!store.library.read().placements[id]?.trashedAt) throw new Error("Move this Chat to Trash before permanently deleting it.");
        if (isRunning(id)) throw new Error("Stop the running Chat before permanently deleting it.");
        await deleted?.(id); await store.libraryMutation("delete", id); forget(id);
      } return;
    }
    case "emptyTrash": {
      const choice = await host.window.showWarningMessage("Permanently delete all Chats in Trash? Task Session evidence is preserved.", { modal: true }, "Empty Trash");
      if (choice === "Empty Trash") {
        const failures: string[] = [];
        for (const item of await store.trashList()) {
          try {
            if (isRunning(item.id)) throw new Error("Stop the running Chat before permanently deleting it.");
            await deleted?.(item.id); await store.libraryMutation("delete", item.id); forget(item.id);
          } catch (error) { failures.push(`${item.title} (${item.id}): ${error instanceof Error ? error.message : String(error)}`); }
        }
        if (failures.length) throw new Error(`Some Chats could not be deleted and remain in Trash:\n${failures.join("\n")}`);
      }
      return;
    }
    default: throw new Error("Unknown Chat library action.");
  }
}