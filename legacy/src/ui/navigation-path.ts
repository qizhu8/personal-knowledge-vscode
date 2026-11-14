export interface NavigationPathItem {
  nodeType: string;
  nodeData?: any;
  label?: unknown;
}

function contentPath(area: string, relativePath = "", folder = false): string {
  const normalized = String(relativePath || "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  const suffix = normalized ? `/${normalized.split("/").map(encodeURIComponent).join("/")}` : "";
  return `pkm://${area}${suffix}${folder ? "/" : ""}`;
}

/** Return an Agent-readable PKM locator for every Navigation tree node. */
export function navigationItemPath(item: NavigationPathItem): string {
  const data = item.nodeData || {};
  const folderPath = (area: string): string => {
    const rel = String(data.relPath || "");
    return contentPath(area, rel && rel !== "(uncategorized)" ? rel : "", true);
  };
  switch (item.nodeType) {
    case "page-recipes": return contentPath("recipes", "", true);
    case "recipe-folder": return folderPath("recipes");
    case "recipe": return contentPath("recipes", data.relPath);
    case "root-skills": return contentPath("skills", "", true);
    case "skill-folder": return folderPath("skills");
    case "skill": return contentPath("skills", data.relPath);
    case "root-notes": return contentPath("notes", "", true);
    case "note-folder": return folderPath("notes");
    case "note": return contentPath("notes", data.relPath);
    case "root-papers": return contentPath("papers", "", true);
    case "paper-folder": return folderPath("papers");
    case "paper": return contentPath("papers", data.relPath);
    case "root-prompts": return contentPath("prompts", "", true);
    case "prompt-project": return contentPath("prompts", data.project, true);
    case "prompt-task": return contentPath("prompts", `${data.project}/${data.task}`, true);
    case "prompt-version": return contentPath("prompts", `${data.project}/${data.task}/${data.version}`, true);
    case "prompt-file": return contentPath("prompts", `${data.project}/${data.task}/${data.version}/${data.file}`);
    case "root-packages": return contentPath("packages", "", true);
    case "package": return contentPath("packages", data.key, true);
    case "root-scripts": return contentPath("scripts", "", true);
    case "script-folder": return folderPath("scripts");
    case "script-file": return contentPath("scripts", data.key);
    case "root-servers": return "pkm://servers/";
    case "server-group": return `pkm://servers/subgroups/${encodeURIComponent((data.path || []).join("/"))}`;
    case "server-ungrouped-group": return "pkm://servers/subgroups/ungrouped";
    case "server-item": return `pkm://servers/${encodeURIComponent(data.slug || "")}`;
    case "server-subscriber-group": return `pkm://subscriptions/${encodeURIComponent(data.subscriptionId || "")}/servers`;
    case "server-subscriber-item": return `pkm://subscriptions/servers/${encodeURIComponent(data.key || "")}`;
    case "subscribed-content-root": return `pkm://subscriptions/${encodeURIComponent(data.model?.contentType || "")}`;
    case "subscribed-content-broker":
    case "subscribed-content-folder":
    case "subscribed-content-item": return String(data.pkmPath || data.model?.pkmPath || "pkm://subscriptions");
    case "root-environments": return "pkm://environments";
    case "environment-group": return `pkm://environments/groups/${encodeURIComponent((data.path || []).join("/"))}`;
    case "environment-item": return `pkm://environments/${encodeURIComponent(data.id || "")}`;
    case "root-chatroom": return "pkm://chatroom";
    case "chat-hosted-group": return "pkm://chatroom/hosted";
    case "chat-joined-group": return "pkm://chatroom/joined";
    case "chat-hosted-room": return `pkm://chatroom/rooms/${encodeURIComponent(data.roomId || data.roomName || "")}`;
    case "chat-room": return `pkm://chatroom/rooms/${encodeURIComponent(data.id || "")}`;
    case "root-subscriptions": return "pkm://subscriptions";
    case "subscription-brokers-group": return "pkm://subscriptions/brokers";
    case "subscription-subscribers-group": return "pkm://subscriptions/subscribers";
    case "subscription-broker": return `pkm://subscriptions/brokers/${encodeURIComponent(data.shareId || "")}`;
    case "subscription-subscriber": return `pkm://subscriptions/subscribers/${encodeURIComponent(data.subscriptionId || "")}`;
    case "root-mcp": return "pkm://config";
    default: return `pkm://navigation/${encodeURIComponent(item.nodeType)}/${encodeURIComponent(String(item.label || ""))}`;
  }
}
