import type * as vscode from "vscode";
import type { ApiChatStore } from "./api-chat-store";

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
        const choice = await host.window.showQuickPick([{ label: "Ungroup", id: "ungroup" }, ...store.library.read().groups.map(group => ({ label: group.name, id: group.id }))], { title: "Move Chat to group", ignoreFocusOut: true });
        groupId = choice?.id;
      }
      if (groupId) store.library.move(id, groupId); return;
    }
    case "trashChat": {
      if (isRunning(id)) throw new Error("Stop the running Chat before moving it to Trash.");
      const choice = await host.window.showWarningMessage("Move Chat to Trash? Task Session evidence is preserved.", { modal: true }, "Move to Trash");
      if (choice === "Move to Trash") { store.trashChat(id); forget(id); } return;
    }
    case "restoreChat": store.restoreChat(id); return;
    case "deleteChat": {
      const choice = await host.window.showWarningMessage("Permanently delete this Chat? Task Session evidence is preserved.", { modal: true }, "Delete permanently");
      if (choice === "Delete permanently") { store.deleteChat(id); forget(id); await deleted?.(id); } return;
    }
    case "emptyTrash": {
      const choice = await host.window.showWarningMessage("Permanently delete all Chats in Trash? Task Session evidence is preserved.", { modal: true }, "Empty Trash");
      if (choice === "Empty Trash") for (const item of store.list(true).filter(item => item.trashedAt)) { store.deleteChat(item.id); forget(item.id); await deleted?.(item.id); }
      return;
    }
    default: throw new Error("Unknown Chat library action.");
  }
}