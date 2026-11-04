import { join } from "path";
import { apiChatGroupSnapshots } from "../chat/api-chat-store";
import { getStorePath, noteGet, noteWorkItemCommand, noteWorkItemsRead } from "../knowledge/filestore";

export function manageBrowserTodo(documentPath: string, message: Record<string, unknown>, trusted: boolean, projects: Array<{ projectId: string; name: string }> = []) {
  if (!trusted) throw new Error("Work Items require a trusted workspace.");
  if (!documentPath.startsWith("/notes/") || !documentPath.endsWith(".html")) throw new Error("Choose an existing Todo Board.");
  const slug = documentPath.slice("/notes/".length, -".html".length);
  if (!slug || slug.split("/").some(part => !part || part === "." || part === "..") || /^system(?:\/|$)/i.test(slug)) {
    throw new Error("Choose an editable Todo Board.");
  }
  const note = noteGet(slug);
  if (note?.documentKind !== "todo-board") throw new Error("Browser management is limited to Todo Boards.");
  if (message.command === "noteTodoCommand") {
    if (typeof message.expectedDigest !== "string") throw new Error("Read the Board before modifying Work Items.");
    const operation = message.operation;
    const item = operation && typeof operation === "object" && "item" in operation ? operation.item : undefined;
    if (item && typeof item === "object" && "projectId" in item && item.projectId !== undefined
      && !projects.some(project=>project.projectId===item.projectId)) throw new Error("Choose an existing Project or clear the Project assignment.");
    noteWorkItemCommand(slug, message.expectedDigest, message.operation, { id: "user:local", role: "user" });
  } else if (message.command !== "noteTodoRead") throw new Error("Unsupported Todo Board command.");
  const chats = apiChatGroupSnapshots(join(getStorePath(), ".pkm", "state"))
    .filter(chat => !chat.deletedAt).map(chat => ({ id: chat.hostSessionId, title: chat.title || chat.hostSessionId, chatUrl: chat.chatUrl }));
  return { slug, requestId: message.requestId, snapshot: noteWorkItemsRead(slug), content: note.content, chats, projects, documentKind: "todo-board" };
}
