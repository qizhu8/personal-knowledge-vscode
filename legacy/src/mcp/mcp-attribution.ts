export const MCP_ATTRIBUTION_SCHEMA = "pkm.mcp.attribution/v1";
export const MCP_ATTRIBUTION_ENV = "PKM_MCP_LAUNCH_ATTRIBUTION";

export interface ManagedMcpHostContext {
  hostId: string;
  editorSessionId: string;
  hostSlotId: string;
  extensionHostPid: number;
  workspace?: string;
  machine?: string;
  remoteName?: string;
  extensionHostLogUri?: string;
}

export interface ManagedMcpAttribution extends Partial<ManagedMcpHostContext> {
  schema: typeof MCP_ATTRIBUTION_SCHEMA;
  source: "vscode-provider" | "pkm-chat" | "standalone";
  scope: "shared-host" | "chat" | "unknown";
  chatId?: string;
}

const text = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 2048 && !/[\u0000-\u001f\u007f]/.test(value);

/** Launch metadata is caller-reported evidence, not a same-client identity handshake. */
export function normalizeManagedMcpAttribution(value: unknown): ManagedMcpAttribution | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  if (raw.schema !== MCP_ATTRIBUTION_SCHEMA
    || !["vscode-provider", "pkm-chat", "standalone"].includes(String(raw.source))
    || !["shared-host", "chat", "unknown"].includes(String(raw.scope))) return undefined;
  const result: ManagedMcpAttribution = {
    schema: MCP_ATTRIBUTION_SCHEMA, source: raw.source as ManagedMcpAttribution["source"],
    scope: raw.scope as ManagedMcpAttribution["scope"],
  };
  for (const key of ["hostId", "editorSessionId", "hostSlotId", "workspace", "machine", "remoteName", "extensionHostLogUri", "chatId"] as const) {
    if (raw[key] === undefined) continue;
    if (!text(raw[key])) return undefined;
    result[key] = raw[key];
  }
  if (result.extensionHostLogUri
    && (!/^[a-z][a-z0-9+.-]*:\//i.test(result.extensionHostLogUri) || /\s/.test(result.extensionHostLogUri))) return undefined;
  if (raw.extensionHostPid !== undefined) {
    if (!Number.isSafeInteger(raw.extensionHostPid) || (raw.extensionHostPid as number) <= 0) return undefined;
    result.extensionHostPid = raw.extensionHostPid as number;
  }
  if (result.scope === "chat" && (result.source !== "pkm-chat" || !result.chatId)
    || result.scope !== "chat" && result.chatId !== undefined
    || result.source === "standalone" && (result.scope !== "unknown" || result.hostId || result.editorSessionId || result.extensionHostPid)
    || result.scope === "shared-host" && (!result.hostId || !result.editorSessionId || !result.extensionHostPid)) return undefined;
  return result;
}

let hostContext: ManagedMcpHostContext | undefined;

/** Use the existing extension-host registry identity; never manufacture one from a child PID. */
export function configureManagedMcpAttribution(context: ManagedMcpHostContext | undefined): void {
  const normalized = context && normalizeManagedMcpAttribution({
    ...context, schema: MCP_ATTRIBUTION_SCHEMA, source: "vscode-provider", scope: "shared-host",
  });
  hostContext = normalized ? { ...context! } : undefined;
}

export function managedMcpAttributionEnv(
  env: Record<string, string> = {}, source: "vscode-provider" | "pkm-chat" = "vscode-provider", chatId?: string,
): Record<string, string> {
  const context = normalizeManagedMcpAttribution({
    ...(hostContext || {}), schema: MCP_ATTRIBUTION_SCHEMA,
    source, scope: chatId !== undefined ? "chat" : hostContext ? "shared-host" : "unknown",
    ...(chatId !== undefined ? { chatId } : {}),
  });
  // Always overwrite inherited attribution; a descendant is not its parent's Chat.
  return { ...env, [MCP_ATTRIBUTION_ENV]: context ? JSON.stringify(context) : "" };
}
