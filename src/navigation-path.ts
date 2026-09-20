export interface NavigationPathItem {
  nodeType: string;
  nodeData?: any;
  label?: unknown;
}

/** Return an Agent-readable PKM locator for every Navigation tree node. */
export function navigationItemPath(item: NavigationPathItem): string {
  const data = item.nodeData || {};
  const folderPath = (area: string): string => {
    const rel = String(data.relPath || "");
    return rel && rel !== "(uncategorized)" ? `${area}/${rel}/` : `${area}/`;
  };
  switch (item.nodeType) {
    case "root-skills": return "skills/";
    case "skill-folder": return folderPath("skills");
    case "skill": return `skills/${data.relPath}`;
    case "root-notes": return "notes/";
    case "note-folder": return folderPath("notes");
    case "note": return `notes/${data.relPath}`;
    case "root-papers": return "papers/";
    case "paper-folder": return folderPath("papers");
    case "paper": return `papers/${data.relPath}`;
    case "root-prompts": return "prompts/";
    case "prompt-project": return `prompts/${data.project}/`;
    case "prompt-task": return `prompts/${data.project}/${data.task}/`;
    case "prompt-version": return `prompts/${data.project}/${data.task}/${data.version}/`;
    case "prompt-file": return `prompts/${data.project}/${data.task}/${data.version}/${data.file}`;
    case "root-packages": return "packages/";
    case "package": return `packages/${data.key}/`;
    case "root-scripts": return "scripts/";
    case "script-folder": return folderPath("scripts");
    case "script-file": return `scripts/${data.key}`;
    case "root-servers": return "servers/";
    case "server-group": return `pkm://servers/subgroups/${encodeURIComponent((data.path || []).join("/"))}`;
    case "server-ungrouped-group": return "pkm://servers/subgroups/ungrouped";
    case "server-item": return `servers/${data.slug}/server.json`;
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
