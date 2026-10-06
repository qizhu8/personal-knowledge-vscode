import type { ApiConversation } from "./api-chat-store";

export interface ChatToolSelection { disabledTools: string[]; disabledSources: string[] }
export interface ChatToolGroup {
  id: string;
  label: string;
  description: string;
  tools: { id: string; name: string; label: string; description: string; enabled: boolean }[];
}

export function chatToolGroups(chat: ApiConversation,
  builtins: readonly { name: string; label: string; permission: string }[],
  native: readonly { name: string; description: string }[]): ChatToolGroup[] {
  const groups: ChatToolGroup[] = [{ id: "builtin", label: "Builtin", description: "PKM workspace and knowledge tools", tools: [] }];
  const enabled = (source: string, id: string, legacy: boolean) => chat.toolSelection
    ? !chat.toolSelection.disabledTools.includes(id) && !chat.toolSelection.disabledSources.includes(source)
      && !(source.startsWith("vscode:") && chat.toolSelection.disabledSources.includes("vscode"))
    : legacy;
  for (const tool of builtins) groups[0].tools.push({ id: `builtin:${tool.name}`, name: tool.name, label: tool.label,
    description: tool.permission, enabled: enabled("builtin", `builtin:${tool.name}`, chat.builtinTools === undefined || chat.builtinTools.includes(tool.name)) });
  const catalog = [...native];
  for (const name of chat.vscodeTools || []) if (!catalog.some(tool => tool.name === name)) catalog.push({ name, description: "Unavailable in this Host; no substitute will be used" });
  for (const tool of catalog) {
    const namespace = /^mcp_([^_]+)_/.exec(tool.name)?.[1];
    const source = namespace ? `vscode:mcp:${namespace}` : "vscode:unknown";
    let group = groups.find(item => item.id === source);
    if (!group) { group = { id: source, label: namespace ? `MCP namespace: ${namespace}` : "VS Code: unknown source",
      description: "Native registry names; server/extension identity is not exposed by the public API", tools: [] }; groups.push(group); }
    group.tools.push({ id: `vscode:${tool.name}`, name: tool.name, label: tool.name, description: tool.description,
      enabled: enabled(source, `vscode:${tool.name}`, chat.vscodeTools === undefined || chat.vscodeTools.includes(tool.name)) });
  }
  for (const server of chat.mcpServers || []) {
    const source = `mcp:${server.id}`;
    groups.push({ id: source, label: server.label, description: "Configured HTTP MCP connection", tools: server.tools.map(name => ({
      id: `${source}:${name}`, name, label: name, description: server.label,
      enabled: server.enabled && enabled(source, `${source}:${name}`, true),
    })) });
  }
  return groups;
}

export function selectChatTools(chat: ApiConversation, groups: ChatToolGroup[], id: string, value: boolean, only: boolean): void {
  const group = groups.find(item => item.id === id);
  const owner = group || groups.find(item => item.tools.some(tool => tool.id === id));
  if (!owner || only && !group) throw new Error("This tool selection is no longer available. Refresh Tools.");
  const selection = chat.toolSelection || {
    disabledTools: groups.flatMap(item => item.tools.filter(tool => !tool.enabled).map(tool => tool.id)),
    disabledSources: [ ...(chat.builtinTools?.length === 0 ? ["builtin"] : []), ...(chat.vscodeTools?.length === 0 ? ["vscode"] : []),
      ...groups.filter(item => item.id.startsWith("mcp:") && !chat.mcpServers?.find(server => `mcp:${server.id}` === item.id)?.enabled).map(item => item.id) ],
  };
  const disabledTools = new Set(selection.disabledTools);
  const disabledSources = new Set(selection.disabledSources);
  if (only) {
    for (const item of groups) if (item.id !== id) disabledSources.add(item.id);
    if (!id.startsWith("vscode:")) disabledSources.add("vscode");
  }
  if (value && owner.id.startsWith("vscode:") && disabledSources.delete("vscode")) {
    for (const item of groups) if (item.id.startsWith("vscode:") && item.id !== owner.id) disabledSources.add(item.id);
  }
  if (group) {
    if (value) { disabledSources.delete(group.id); for (const tool of group.tools) disabledTools.delete(tool.id); }
    else disabledSources.add(group.id);
  } else {
    if (value && disabledSources.delete(owner.id)) for (const tool of owner.tools) disabledTools.add(tool.id);
    if (value) disabledTools.delete(id); else disabledTools.add(id);
  }
  for (const server of chat.mcpServers || []) if (value && owner.id === `mcp:${server.id}`) server.enabled = true;
  chat.toolSelection = { disabledTools: [...disabledTools], disabledSources: [...disabledSources] };
}